const test = require("node:test");
const assert = require("node:assert/strict");
const {
  approveRecommendation,
  columnLetter,
  createDriverRecord,
  createVehicleRecord,
  completeAssignedRideSchedules,
  promoteNeedsReviewToFinalBid,
  createBidReviewEntry,
  updateBidAdminStatus,
  updateBidStatus,
  updateDispatchCriteria,
  resetFinalBidCalendarRetry,
  updateDriverStatus,
  updateVehicleStatus,
  updateFinalBidStatus,
  updateNeedsReviewRideFields
} = require("../../src/dashboard/actions");

function createSheetsClient(valuesBySheet) {
  const updates = [];
  const appends = [];
  return {
    updates,
    appends,
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          const match = String(range).match(/^'((?:[^']|'')+)'!/);
          const sheetName = match ? match[1].replace(/''/g, "'") : "";
          return {
            data: {
              values: valuesBySheet[sheetName] || []
            }
          };
        },
        update: async (request) => {
          updates.push(request);
          return { data: { updatedRange: request.range } };
        },
        append: async (request) => {
          appends.push(request);
          return { data: { updates: { updatedRange: `${request.range}!A2:Z2` } } };
        }
      }
    }
  };
}

test("columnLetter converts 1-based column numbers to A1 letters", () => {
  assert.equal(columnLetter(1), "A");
  assert.equal(columnLetter(26), "Z");
  assert.equal(columnLetter(27), "AA");
});

test("updateDriverStatus updates the matching Drivers status cell", async () => {
  const sheetsClient = createSheetsClient({
    Drivers: [
      ["Driver ID", "Driver Name", "Status"],
      ["D-001", "Ali", "Offline"]
    ]
  });

  const result = await updateDriverStatus({
    sheetsClient,
    spreadsheetId: "sheet-id",
    driversWorksheetName: "Drivers",
    driverId: "D-001",
    status: "Available"
  });

  assert.equal(result.range, "'Drivers'!C2");
  assert.equal(result.oldValue, "Offline");
  assert.equal(result.value, "Available");
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Available"]]);
});

test("updateDriverStatus rejects unsupported status values", async () => {
  const sheetsClient = createSheetsClient({
    Drivers: [["Driver ID", "Status"], ["D-001", "Available"]]
  });

  await assert.rejects(
    () =>
      updateDriverStatus({
        sheetsClient,
        spreadsheetId: "sheet-id",
        driverId: "D-001",
        status: "Sleeping"
      }),
    /Driver status must be one of/
  );
});

test("updateVehicleStatus updates matching Vehicles status cell", async () => {
  const sheetsClient = createSheetsClient({
    Vehicles: [
      ["Vehicle ID", "Vehicle Type", "Status"],
      ["V-001", "MPV", "Busy"]
    ]
  });

  const result = await updateVehicleStatus({
    sheetsClient,
    spreadsheetId: "sheet-id",
    vehiclesWorksheetName: "Vehicles",
    vehicleId: "V-001",
    status: "Available"
  });

  assert.equal(result.range, "'Vehicles'!C2");
  assert.equal(result.oldValue, "Busy");
  assert.equal(result.value, "Available");
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Available"]]);
});

test("completeAssignedRideSchedules closes schedules and restores fleet availability", async () => {
  const sheetsClient = createSheetsClient({
    "Driver Schedule": [
      ["Assignment ID", "Driver ID", "Ride ID", "Pickup", "Drop Off", "Start Time", "End Time", "Status", "Next Available Time", "Current Location"],
      ["ASG-1", "D-001", "RID-1", "Heathrow", "Chelsea", "2026-08-12T10:00:00.000Z", "2026-08-12T11:00:00.000Z", "Assigned", "2026-08-12T11:00:00.000Z", "Chelsea"]
    ],
    "Vehicle Schedule": [
      ["Vehicle ID", "Ride ID", "Driver ID", "Start Time", "End Time", "Status"],
      ["V-001", "RID-1", "D-001", "2026-08-12T10:00:00.000Z", "2026-08-12T11:00:00.000Z", "Assigned"]
    ],
    Drivers: [
      ["Driver ID", "Status", "Current Location"],
      ["D-001", "Busy", "Heathrow"]
    ],
    Vehicles: [
      ["Vehicle ID", "Status"],
      ["V-001", "Busy"]
    ]
  });

  const result = await completeAssignedRideSchedules({
    sheetsClient,
    spreadsheetId: "sheet-id",
    driverScheduleWorksheetName: "Driver Schedule",
    vehicleScheduleWorksheetName: "Vehicle Schedule",
    driversWorksheetName: "Drivers",
    vehiclesWorksheetName: "Vehicles",
    rideId: "RID-1"
  });

  assert.equal(result.completed, true);
  assert.equal(result.driverId, "D-001");
  assert.equal(result.vehicleId, "V-001");
  assert.equal(result.currentLocation, "Chelsea");
  assert.deepEqual(
    sheetsClient.updates.map((update) => update.range),
    [
      "'Driver Schedule'!H2",
      "'Vehicle Schedule'!F2",
      "'Drivers'!B2",
      "'Drivers'!C2",
      "'Vehicles'!B2"
    ]
  );
  assert.deepEqual(
    sheetsClient.updates.map((update) => update.requestBody.values[0][0]),
    ["Completed", "Completed", "Available", "Chelsea", "Available"]
  );
});

test("completeAssignedRideSchedules skips already closed schedule rows", async () => {
  const sheetsClient = createSheetsClient({
    "Driver Schedule": [
      ["Driver ID", "Ride ID", "Status"],
      ["D-001", "RID-1", "Completed"]
    ],
    "Vehicle Schedule": [
      ["Vehicle ID", "Ride ID", "Status"],
      ["V-001", "RID-1", "Completed"]
    ]
  });

  const result = await completeAssignedRideSchedules({
    sheetsClient,
    spreadsheetId: "sheet-id",
    driverScheduleWorksheetName: "Driver Schedule",
    vehicleScheduleWorksheetName: "Vehicle Schedule",
    rideId: "RID-1"
  });

  assert.equal(result.completed, false);
  assert.equal(result.reason, "no_active_schedule_rows");
  assert.equal(sheetsClient.updates.length, 0);
});

test("createDriverRecord appends a dashboard-created driver using Drivers schema", async () => {
  const sheetsClient = createSheetsClient({
    Drivers: [
      ["Driver ID", "Driver Name", "WhatsApp Number", "Status", "Current Location", "Working Hours", "Vehicle ID"],
      ["001", "Ali", "+4471", "Available", "Heathrow", "Any", ""]
    ]
  });

  const result = await createDriverRecord({
    sheetsClient,
    spreadsheetId: "sheet-id",
    driversWorksheetName: "Drivers",
    driverName: "Sara Khan",
    whatsappNumber: "+4472",
    currentLocation: "Chelsea"
  });

  assert.equal(result.key, "002");
  assert.equal(result.record.Status, "Available");
  assert.equal(sheetsClient.appends[0].range, "'Drivers'");
  assert.deepEqual(sheetsClient.appends[0].requestBody.values[0], [
    "002",
    "Sara Khan",
    "+4472",
    "Available",
    "Chelsea",
    "Any",
    ""
  ]);
});

test("createDriverRecord blocks duplicate driver ids", async () => {
  const sheetsClient = createSheetsClient({
    Drivers: [
      ["Driver ID", "Driver Name", "Status"],
      ["D-001", "Ali", "Available"]
    ]
  });

  await assert.rejects(
    () =>
      createDriverRecord({
        sheetsClient,
        spreadsheetId: "sheet-id",
        driversWorksheetName: "Drivers",
        driverId: "D-001",
        driverName: "Duplicate"
      }),
    /already has Driver ID/
  );
  assert.equal(sheetsClient.appends.length, 0);
});

test("createVehicleRecord appends an independent vehicle using Vehicles schema", async () => {
  const sheetsClient = createSheetsClient({
    Vehicles: [
      ["Vehicle ID", "Vehicle Type", "Seats", "Registration", "Driver ID", "Status"],
      ["V-001", "MPV", "8", "AB123CD", "", "Available"]
    ]
  });

  const result = await createVehicleRecord({
    sheetsClient,
    spreadsheetId: "sheet-id",
    vehiclesWorksheetName: "Vehicles",
    vehicleType: "Saloon",
    seats: "4",
    registration: "CD456EF"
  });

  assert.equal(result.key, "V-002");
  assert.equal(result.record["Driver ID"], "");
  assert.equal(sheetsClient.appends[0].range, "'Vehicles'");
  assert.deepEqual(sheetsClient.appends[0].requestBody.values[0], [
    "V-002",
    "Saloon",
    "4",
    "CD456EF",
    "",
    "Available"
  ]);
});

test("createVehicleRecord blocks duplicate vehicle registrations", async () => {
  const sheetsClient = createSheetsClient({
    Vehicles: [
      ["Vehicle ID", "Vehicle Type", "Registration", "Status"],
      ["V-001", "MPV", "AB123CD", "Available"]
    ]
  });

  await assert.rejects(
    () =>
      createVehicleRecord({
        sheetsClient,
        spreadsheetId: "sheet-id",
        vehiclesWorksheetName: "Vehicles",
        vehicleType: "MPV",
        registration: "AB123CD"
      }),
    /already has Registration/
  );
  assert.equal(sheetsClient.appends.length, 0);
});

test("approveRecommendation sets recommendation Status and Assignment Status", async () => {
  const sheetsClient = createSheetsClient({
    "Driver Recommendations": [
      ["Ride ID", "Recommended Driver", "Status", "Assignment Status"],
      ["RID-1", "D-001", "Pending", "Pending"]
    ]
  });

  const result = await approveRecommendation({
    sheetsClient,
    spreadsheetId: "sheet-id",
    recommendationsWorksheetName: "Driver Recommendations",
    rideId: "RID-1"
  });

  assert.equal(result.updates.length, 2);
  assert.equal(sheetsClient.updates[0].range, "'Driver Recommendations'!C2");
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Approved"]]);
  assert.equal(sheetsClient.updates[1].range, "'Driver Recommendations'!D2");
  assert.deepEqual(sheetsClient.updates[1].requestBody.values, [["Approved"]]);
});

test("updateFinalBidStatus updates Final Bid status for the ride", async () => {
  const sheetsClient = createSheetsClient({
    "Final Bid": [
      ["Refer", "Pickup", "Status"],
      ["RID-1", "Heathrow", "Pending"]
    ]
  });

  const result = await updateFinalBidStatus({
    sheetsClient,
    spreadsheetId: "sheet-id",
    finalBidWorksheetName: "Final Bid",
    rideId: "RID-1",
    status: "Approved"
  });

  assert.equal(result.range, "'Final Bid'!C2");
  assert.equal(result.value, "Approved");
});

test("updateFinalBidStatus can reject a pending Final Bid ride", async () => {
  const sheetsClient = createSheetsClient({
    "Final Bid": [
      ["Refer", "Pickup", "Status"],
      ["RID-1", "Heathrow", "Pending"]
    ]
  });

  const result = await updateFinalBidStatus({
    sheetsClient,
    spreadsheetId: "sheet-id",
    finalBidWorksheetName: "Final Bid",
    rideId: "RID-1",
    status: "Rejected"
  });

  assert.equal(result.range, "'Final Bid'!C2");
  assert.equal(result.oldValue, "Pending");
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Rejected"]]);
});

test("updateFinalBidStatus refuses to reopen closed Final Bid rows", async () => {
  const sheetsClient = createSheetsClient({
    "Final Bid": [
      ["Refer", "Pickup", "Status"],
      ["RID-1", "Heathrow", "Cancelled"]
    ]
  });

  await assert.rejects(
    () =>
      updateFinalBidStatus({
        sheetsClient,
        spreadsheetId: "sheet-id",
        finalBidWorksheetName: "Final Bid",
        rideId: "RID-1",
        status: "Approved"
      }),
    /closed and cannot be updated/
  );
  assert.equal(sheetsClient.updates.length, 0);
});

test("resetFinalBidCalendarRetry clears calendar failure fields but preserves event id", async () => {
  const sheetsClient = createSheetsClient({
    "Final Bid": [
      [
        "Refer",
        "Status",
        "Calendar Status",
        "Calendar Event ID",
        "Calendar Created Time",
        "Calendar Error"
      ],
      [
        "RID-1",
        "Approved",
        "Failed",
        "evt_existing",
        "2026-08-12T10:00:00.000Z",
        "Calendar API failed"
      ]
    ]
  });

  const result = await resetFinalBidCalendarRetry({
    sheetsClient,
    spreadsheetId: "sheet-id",
    finalBidWorksheetName: "Final Bid",
    rideId: "RID-1"
  });

  assert.equal(result.updates.length, 3);
  assert.deepEqual(
    result.updates.map((update) => update.header),
    ["Calendar Status", "Calendar Created Time", "Calendar Error"]
  );
  assert.deepEqual(
    sheetsClient.updates.map((update) => update.range),
    ["'Final Bid'!C2", "'Final Bid'!E2", "'Final Bid'!F2"]
  );
  assert.deepEqual(
    sheetsClient.updates.map((update) => update.requestBody.values),
    [[[""]], [[""]], [[""]]]
  );
  assert.equal(result.updates[0].oldValue, "Failed");
});

test("createBidReviewEntry appends a Bid Tracker row from Final Bid", async () => {
  const sheetsClient = createSheetsClient({
    "Final Bid": [
      ["Refer", "Group Name", "Pickup", "Drop Off", "Fare", "Required Vehicle", "Status"],
      ["RID-1", "OTS", "Heathrow", "Chelsea", "120", "MPV", "Pending"]
    ],
    "Bid Tracker": [
      ["Ride ID", "Source", "Pickup", "Drop Off", "Fare", "Required Vehicle", "Bid Type", "Bid Status", "Admin Status", "Bid Amount", "Reason", "Created Time", "Updated Time"]
    ]
  });
  const appended = [];

  const result = await createBidReviewEntry({
    sheetsClient,
    spreadsheetId: "sheet-id",
    finalBidWorksheetName: "Final Bid",
    bidTrackerWorksheetName: "Bid Tracker",
    appendBidTrackerRow: async (row) => appended.push(row),
    rideId: "RID-1",
    minFare: 80
  });

  assert.equal(result.appended, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]["Ride ID"], "RID-1");
  assert.equal(appended[0]["Bid Status"], "Suggested");
});

test("updateBidAdminStatus approves admin bid and moves bid status to Approved", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": [
      ["Ride ID", "Bid Status", "Admin Status", "Bid Amount", "Reason", "Updated Time"],
      ["RID-1", "Suggested", "Pending", "", "", ""]
    ]
  });

  const result = await updateBidAdminStatus({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker",
    rideId: "RID-1",
    adminStatus: "Approved",
    bidAmount: "115",
    reason: "operator amount"
  });

  assert.equal(result.updates.length, 5);
  assert.equal(sheetsClient.updates[0].range, "'Bid Tracker'!C2");
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Approved"]]);
  assert.equal(sheetsClient.updates[1].range, "'Bid Tracker'!B2");
  assert.deepEqual(sheetsClient.updates[1].requestBody.values, [["Approved"]]);
  assert.equal(sheetsClient.updates[2].range, "'Bid Tracker'!D2");
  assert.deepEqual(sheetsClient.updates[2].requestBody.values, [["115"]]);
  assert.equal(sheetsClient.updates[3].range, "'Bid Tracker'!E2");
  assert.deepEqual(sheetsClient.updates[3].requestBody.values, [["operator amount"]]);
});

test("updateBidAdminStatus can reject an admin bid from dashboard", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": [
      ["Ride ID", "Bid Status", "Admin Status", "Reason", "Updated Time"],
      ["RID-1", "Suggested", "Pending", "", ""]
    ]
  });

  const result = await updateBidAdminStatus({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker",
    rideId: "RID-1",
    adminStatus: "Rejected",
    reason: "not suitable"
  });

  assert.equal(result.updates.length, 3);
  assert.equal(sheetsClient.updates[0].range, "'Bid Tracker'!C2");
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Rejected"]]);
  assert.equal(sheetsClient.updates[1].range, "'Bid Tracker'!D2");
  assert.deepEqual(sheetsClient.updates[1].requestBody.values, [["not suitable"]]);
});

test("updateBidStatus can mark a bid done with amount and reason", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": [
      ["Ride ID", "Bid Status", "Bid Amount", "Reason", "Updated Time"],
      ["RID-1", "Approved", "", "", ""]
    ]
  });

  const result = await updateBidStatus({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker",
    rideId: "RID-1",
    bidStatus: "Bid Done",
    bidAmount: "110",
    reason: "submitted manually"
  });

  assert.equal(result.updates.length, 4);
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Bid Done"]]);
  assert.deepEqual(sheetsClient.updates[1].requestBody.values, [["110"]]);
  assert.deepEqual(sheetsClient.updates[2].requestBody.values, [["submitted manually"]]);
});

test("promoteNeedsReviewToFinalBid appends a complete review row through Final Bid pipeline", async () => {
  const sheetsClient = createSheetsClient({
    "Needs Review": [
      [
        "Refer",
        "Group Name",
        "Source Name",
        "Source Time",
        "Pickup Day & Date",
        "Starting Timing",
        "Pickup",
        "Drop Off",
        "Distance",
        "Fare",
        "Required Vehicle",
        "Payment Status"
      ],
      [
        "RID-REVIEW",
        "WhatsApp",
        "Ali",
        "2026-08-12T10:00:00Z",
        "12 Aug 2026",
        "10:00",
        "Heathrow",
        "Chelsea",
        "19",
        "120",
        "MPV",
        "Needs Review: fixed by operator"
      ]
    ],
    "Final Bid": [
      ["Refer", "Pickup", "Status"]
    ]
  });
  const appended = [];

  const result = await promoteNeedsReviewToFinalBid({
    sheetsClient,
    spreadsheetId: "sheet-id",
    needsReviewWorksheetName: "Needs Review",
    finalBidWorksheetName: "Final Bid",
    rideId: "RID-REVIEW",
    appendFinalBidIfEligible: async (ride) => {
      appended.push(ride);
      return { appended: true, payload: { Refer: ride.refer } };
    }
  });

  assert.equal(result.appended, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].pickup, "Heathrow");
  assert.equal(appended[0].drop_off, "Chelsea");
  assert.equal(appended[0].required_vehicle, "MPV");
  assert.equal(sheetsClient.updates[0].range, "'Needs Review'!L2");
  assert.match(sheetsClient.updates[0].requestBody.values[0][0], /Promoted to Final Bid/);
});

test("promoteNeedsReviewToFinalBid skips duplicate Final Bid entries", async () => {
  const sheetsClient = createSheetsClient({
    "Needs Review": [
      ["Refer", "Pickup", "Drop Off", "Pickup Day & Date", "Starting Timing", "Fare", "Required Vehicle", "Payment Status"],
      ["RID-REVIEW", "Heathrow", "Chelsea", "12 Aug 2026", "10:00", "120", "MPV", "Needs Review"]
    ],
    "Final Bid": [
      ["Refer", "Pickup", "Status"],
      ["RID-REVIEW", "Heathrow", "Pending"]
    ]
  });
  let appendCalled = false;

  const result = await promoteNeedsReviewToFinalBid({
    sheetsClient,
    spreadsheetId: "sheet-id",
    needsReviewWorksheetName: "Needs Review",
    finalBidWorksheetName: "Final Bid",
    rideId: "RID-REVIEW",
    appendFinalBidIfEligible: async () => {
      appendCalled = true;
      return { appended: true };
    }
  });

  assert.equal(result.appended, false);
  assert.equal(result.reason, "final_bid_entry_exists");
  assert.equal(appendCalled, false);
  assert.equal(sheetsClient.updates.length, 0);
});

test("promoteNeedsReviewToFinalBid rejects incomplete review rows", async () => {
  const sheetsClient = createSheetsClient({
    "Needs Review": [
      ["Refer", "Pickup", "Drop Off", "Pickup Day & Date", "Starting Timing", "Fare", "Required Vehicle"],
      ["RID-REVIEW", "Heathrow", "", "12 Aug 2026", "10:00", "120", "MPV"]
    ],
    "Final Bid": [
      ["Refer", "Pickup", "Status"]
    ]
  });

  await assert.rejects(
    () =>
      promoteNeedsReviewToFinalBid({
        sheetsClient,
        spreadsheetId: "sheet-id",
        needsReviewWorksheetName: "Needs Review",
        finalBidWorksheetName: "Final Bid",
        rideId: "RID-REVIEW",
        appendFinalBidIfEligible: async () => ({ appended: true })
      }),
    /incomplete/
  );
});

test("updateNeedsReviewRideFields updates only allowed review fields", async () => {
  const sheetsClient = createSheetsClient({
    "Needs Review": [
      [
        "Refer",
        "Pickup Day & Date",
        "Starting Timing",
        "Pickup",
        "Drop Off",
        "Fare",
        "Required Vehicle",
        "Payment Status"
      ],
      ["RID-REVIEW", "", "", "", "", "", "", "Needs Review"]
    ]
  });

  const result = await updateNeedsReviewRideFields({
    sheetsClient,
    spreadsheetId: "sheet-id",
    needsReviewWorksheetName: "Needs Review",
    rideId: "RID-REVIEW",
    fields: {
      pickupDayDate: "12 Aug 2026",
      startingTiming: "10:00",
      pickup: "Heathrow",
      dropOff: "Chelsea",
      fare: "120",
      requiredVehicle: "MPV",
      refer: "SHOULD-NOT-CHANGE"
    }
  });

  assert.equal(result.updates.length, 6);
  assert.deepEqual(
    sheetsClient.updates.map((update) => update.range),
    [
      "'Needs Review'!B2",
      "'Needs Review'!C2",
      "'Needs Review'!D2",
      "'Needs Review'!E2",
      "'Needs Review'!F2",
      "'Needs Review'!G2"
    ]
  );
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["12 Aug 2026"]]);
});

test("updateNeedsReviewRideFields rejects empty updates", async () => {
  const sheetsClient = createSheetsClient({
    "Needs Review": [["Refer", "Pickup"], ["RID-REVIEW", "Heathrow"]]
  });

  await assert.rejects(
    () =>
      updateNeedsReviewRideFields({
        sheetsClient,
        spreadsheetId: "sheet-id",
        needsReviewWorksheetName: "Needs Review",
        rideId: "RID-REVIEW",
        fields: { refer: "SHOULD-NOT-CHANGE" }
      }),
    /No editable Needs Review fields/
  );
});

test("updateDispatchCriteria updates allowed settings only", async () => {
  const sheetsClient = createSheetsClient({
    "Dispatch Criteria": [
      ["Setting", "Value", "Description", "Updated Time"],
      ["FINAL_BID_ALLOWED_AREA_CODES", "LHR", "Allowed areas", ""]
    ]
  });

  const result = await updateDispatchCriteria({
    sheetsClient,
    spreadsheetId: "sheet-id",
    dispatchCriteriaWorksheetName: "Dispatch Criteria",
    setting: "FINAL_BID_ALLOWED_AREA_CODES",
    value: "LHR,SW3"
  });

  assert.equal(result.setting, "FINAL_BID_ALLOWED_AREA_CODES");
  assert.equal(result.value, "LHR,SW3");
  assert.equal(sheetsClient.updates[0].range, "'Dispatch Criteria'!B2");
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["LHR,SW3"]]);

  await assert.rejects(
    () =>
      updateDispatchCriteria({
        sheetsClient,
        spreadsheetId: "sheet-id",
        setting: "UNKNOWN",
        value: "x"
      }),
    /Unsupported dispatch criteria/
  );
});
