const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RECOMMENDATION_HEADERS,
  DRIVER_SCHEDULE_HEADERS,
  LINKED_RIDES_HEADERS,
  VEHICLE_SCHEDULE_HEADERS,
  calculateVehicleMatchScore,
  calculateAvailabilityScore,
  calculateDistanceScore,
  calculateFinalScore,
  calculateRestFatigueScore,
  hasVehicleScheduleConflict,
  selectBestDriverRecommendation,
  generateRecommendation,
  buildRecommendationSheetRow,
  detectLinkedRideOpportunity,
  buildLinkedRideRowObject,
  buildLinkedRideSheetRow,
  processApprovedDriverRecommendations,
  recommendDriversForFinalBidRides
} = require("../../src/engine");

const RIDE = {
  Refer: "RID-20260721-001",
  Pickup: "Heathrow",
  "Drop Off": "Chelsea",
  "Required Vehicle": "MPV",
  "Start Time": "2026-07-21T10:00:00.000Z",
  Status: "Pending",
  "Assigned Driver": ""
};

const DRIVERS = [
  {
    "Driver ID": "001",
    "Driver Name": "Ali Khan",
    "WhatsApp Number": "+447xxxx",
    Status: "Available",
    "Current Location": "Heathrow",
    "Working Hours": "Any",
    "Vehicle ID": "V001"
  },
  {
    "Driver ID": "002",
    "Driver Name": "Sara Khan",
    "WhatsApp Number": "+447yyyy",
    Status: "Available",
    "Current Location": "London",
    "Working Hours": "Any",
    "Vehicle ID": "V002"
  }
];

const VEHICLES = [
  {
    "Vehicle ID": "V001",
    "Vehicle Type": "MPV",
    Seats: "8",
    Registration: "AB123CD",
    "Driver ID": "001"
  },
  {
    "Vehicle ID": "V002",
    "Vehicle Type": "Saloon",
    Seats: "4",
    Registration: "XY123ZZ",
    "Driver ID": "002"
  }
];

test("vehicle matching scores exact, compatible, and wrong vehicle types", () => {
  assert.equal(calculateVehicleMatchScore("MPV", { vehicle_type: "MPV", seats: "8" }), 100);
  assert.equal(calculateVehicleMatchScore("8 Seater", { vehicle_type: "MPV", seats: "8" }), 70);
  assert.equal(calculateVehicleMatchScore("MPV", { vehicle_type: "Saloon", seats: "4" }), 0);
});

test("availability scoring returns 100 for available and 0 for busy", () => {
  assert.equal(calculateAvailabilityScore({ current_status: "Available" }), 100);
  assert.equal(calculateAvailabilityScore({ current_status: "Busy" }), 0);
});

test("distance scoring gives closest driver highest score", () => {
  assert.equal(
    calculateDistanceScore(0, { minDistanceMeters: 0, maxDistanceMeters: 20000 }),
    100
  );
  assert.equal(
    calculateDistanceScore(20000, { minDistanceMeters: 0, maxDistanceMeters: 20000 }),
    0
  );
  assert.equal(
    calculateDistanceScore(10000, { minDistanceMeters: 0, maxDistanceMeters: 20000 }),
    50
  );
});

test("final score calculation uses required recommendation weights", () => {
  const score = calculateFinalScore({
    vehicle_compatibility: 100,
    availability: 100,
    pickup_distance: 100,
    linked_route: 75,
    rest_fatigue: 100
  });

  assert.equal(score, 94);
});

test("recommendation selection recommends driver 001 for Heathrow MPV ride", async () => {
  const best = await selectBestDriverRecommendation(RIDE, DRIVERS, VEHICLES, {
    distanceProvider: async (from) => (from === "Heathrow" ? 0 : 25000)
  });

  assert.ok(best);
  assert.equal(best.driver.driver_id, "001");
  assert.equal(best.vehicle.vehicle_id, "V001");
  assert.equal(best.scores.vehicle_compatibility, 100);
  assert.equal(best.scores.availability, 100);
  assert.equal(best.scores.pickup_distance, 100);
});

test("driver can be recommended with a different available vehicle", async () => {
  const best = await selectBestDriverRecommendation(
    {
      ...RIDE,
      Refer: "RID-SALOON",
      "Required Vehicle": "Saloon"
    },
    [
      {
        "Driver ID": "001",
        Status: "Available",
        "Current Location": "Heathrow",
        "Vehicle ID": "OLD-MPV"
      }
    ],
    [
      {
        "Vehicle ID": "V-SALOON",
        "Vehicle Type": "Saloon",
        Seats: "4",
        Status: "Available"
      }
    ],
    {
      distanceProvider: async () => 0
    }
  );

  assert.ok(best);
  assert.equal(best.driver.driver_id, "001");
  assert.equal(best.vehicle.vehicle_id, "V-SALOON");
});

test("wrong vehicle resource is rejected even when driver is available", async () => {
  const best = await selectBestDriverRecommendation(
    {
      ...RIDE,
      Refer: "RID-MPV-ONLY",
      "Required Vehicle": "MPV"
    },
    [
      {
        "Driver ID": "001",
        Status: "Available",
        "Current Location": "Heathrow"
      }
    ],
    [
      {
        "Vehicle ID": "V-SALOON",
        "Vehicle Type": "Saloon",
        Seats: "4",
        Status: "Available"
      }
    ],
    {
      distanceProvider: async () => 0
    }
  );

  assert.equal(best, null);
});

test("vehicle schedule prevents double booking during recommendation", async () => {
  assert.equal(
    hasVehicleScheduleConflict(
      "V001",
      RIDE,
      [
        {
          "Vehicle ID": "V001",
          "Ride ID": "RID-BOOKED",
          "Driver ID": "009",
          "Start Time": "2026-07-21T09:30:00.000Z",
          "End Time": "2026-07-21T10:45:00.000Z",
          Status: "Assigned"
        }
      ],
      { minGapMinutes: 15 }
    ),
    true
  );

  const best = await selectBestDriverRecommendation(
    RIDE,
    [
      { "Driver ID": "001", Status: "Available", "Current Location": "Heathrow" },
      { "Driver ID": "002", Status: "Available", "Current Location": "Heathrow" }
    ],
    [
      { "Vehicle ID": "V001", "Vehicle Type": "MPV", Seats: "8", Status: "Available" },
      { "Vehicle ID": "V003", "Vehicle Type": "MPV", Seats: "8", Status: "Available" }
    ],
    {
      vehicleScheduleRows: [
        {
          "Vehicle ID": "V001",
          "Ride ID": "RID-BOOKED",
          "Driver ID": "009",
          "Start Time": "2026-07-21T09:30:00.000Z",
          "End Time": "2026-07-21T10:45:00.000Z",
          Status: "Assigned"
        }
      ],
      distanceProvider: async () => 0,
      minGapMinutes: 15
    }
  );

  assert.ok(best);
  assert.equal(best.vehicle.vehicle_id, "V003");
});

test("overlapping scheduled ride rejects driver before recommendation scoring", async () => {
  const best = await selectBestDriverRecommendation(
    {
      ...RIDE,
      Refer: "RID-OVERLAP",
      "Start Time": "2026-07-21T10:00:00.000Z"
    },
    [
      ...DRIVERS,
      {
        "Driver ID": "003",
        "Driver Name": "Omar Khan",
        "WhatsApp Number": "+447zzzz",
        Status: "Available",
        "Current Location": "Heathrow",
        "Working Hours": "Any",
        "Vehicle ID": "V003"
      }
    ],
    [
      ...VEHICLES,
      {
        "Vehicle ID": "V003",
        "Vehicle Type": "MPV",
        Seats: "8",
        Registration: "CD123EF",
        "Driver ID": "003"
      }
    ],
    {
      scheduleRows: [
        {
          "Assignment ID": "ASG-OLD-001",
          "Driver ID": "001",
          "Ride ID": "RID-OLD",
          Pickup: "Reading",
          "Drop Off": "Heathrow",
          "Start Time": "2026-07-21T09:30:00.000Z",
          "End Time": "2026-07-21T10:45:00.000Z",
          Status: "Assigned",
          "Next Available Time": "2026-07-21T10:45:00.000Z",
          "Current Location": "Heathrow"
        }
      ],
      distanceProvider: async (from) => (from === "Heathrow" ? 0 : 20000),
      minGapMinutes: 15
    }
  );

  assert.ok(best);
  assert.equal(best.driver.driver_id, "003");
});

test("route chaining increases score when previous drop is close to new pickup", async () => {
  const baseBest = await selectBestDriverRecommendation(RIDE, [DRIVERS[0]], [VEHICLES[0]], {
    distanceProvider: async () => 20000
  });
  const chainedBest = await selectBestDriverRecommendation(RIDE, [DRIVERS[0]], [VEHICLES[0]], {
    scheduleRows: [
      {
        "Assignment ID": "ASG-PREV-001",
        "Driver ID": "001",
        "Ride ID": "RID-PREV",
        Pickup: "Chelsea",
        "Drop Off": "Heathrow Terminal 5",
        "Start Time": "2026-07-21T07:30:00.000Z",
        "End Time": "2026-07-21T08:30:00.000Z",
        Status: "Assigned",
        "Next Available Time": "2026-07-21T08:30:00.000Z",
        "Current Location": "Heathrow Terminal 5"
      }
    ],
    distanceProvider: async (from, to) => {
      if (from === "Heathrow Terminal 5" && to === "Heathrow") return 1000;
      return 20000;
    }
  });

  assert.ok(baseBest);
  assert.ok(chainedBest);
  assert.ok(chainedBest.scores.linked_route > baseBest.scores.linked_route);
  assert.ok(chainedBest.scores.total > baseBest.scores.total);
});

test("fatigue preference ranks better-rested driver higher", async () => {
  const tiredPreviousRide = {
    "Assignment ID": "ASG-TIRED",
    "Driver ID": "001",
    "Ride ID": "RID-TIRED",
    Pickup: "Chelsea",
    "Drop Off": "Heathrow",
    "Start Time": "2026-07-21T08:15:00.000Z",
    "End Time": "2026-07-21T09:30:00.000Z",
    Status: "Assigned",
    "Next Available Time": "2026-07-21T09:30:00.000Z",
    "Current Location": "Heathrow"
  };
  const restedPreviousRide = {
    ...tiredPreviousRide,
    "Driver ID": "002",
    "Ride ID": "RID-RESTED",
    "Start Time": "2026-07-21T06:00:00.000Z",
    "End Time": "2026-07-21T07:00:00.000Z",
    "Next Available Time": "2026-07-21T07:00:00.000Z"
  };

  assert.ok(calculateRestFatigueScore(tiredPreviousRide, RIDE) < 100);

  const best = await selectBestDriverRecommendation(
    RIDE,
    [
      { "Driver ID": "001", Status: "Available", "Current Location": "Heathrow" },
      { "Driver ID": "002", Status: "Available", "Current Location": "Heathrow" }
    ],
    [VEHICLES[0]],
    {
      scheduleRows: [tiredPreviousRide, restedPreviousRide],
      distanceProvider: async () => 0,
      fatigueFullRestMinutes: 120,
      minGapMinutes: 15
    }
  );

  assert.ok(best);
  assert.equal(best.driver.driver_id, "002");
});

test("linked return ride detection validates realistic time gap and close locations", async () => {
  const opportunity = await detectLinkedRideOpportunity({
    ride: {
      ...RIDE,
      Refer: "RID-CHELSEA-GATWICK",
      Pickup: "Chelsea",
      "Drop Off": "Gatwick",
      "Required Vehicle": "MPV",
      "Start Time": "2026-07-21T12:00:00.000Z"
    },
    driver: { driver_id: "001" },
    vehicle: { vehicle_id: "V001", vehicle_type: "MPV" },
    scheduleRows: [
      {
        "Assignment ID": "ASG-FIRST",
        "Driver ID": "001",
        "Ride ID": "RID-HEATHROW-CHELSEA",
        Pickup: "Heathrow",
        "Drop Off": "Chelsea",
        "Start Time": "2026-07-21T10:00:00.000Z",
        "End Time": "2026-07-21T11:00:00.000Z",
        Status: "Assigned",
        "Next Available Time": "2026-07-21T11:00:00.000Z",
        "Current Location": "Chelsea"
      }
    ],
    distanceProvider: async (from, to) => (from === "Chelsea" && to === "Chelsea" ? 0 : 30000),
    options: { minGapMinutes: 15, maxLinkedRideGapMinutes: 180 }
  });

  assert.ok(opportunity);
  assert.equal(opportunity.firstRideId, "RID-HEATHROW-CHELSEA");
  assert.equal(opportunity.secondRideId, "RID-CHELSEA-GATWICK");
  assert.equal(opportunity.gapMinutes, 60);
  assert.equal(opportunity.score, 100);
});

test("linked return ride detection rejects unrealistic time gap and distant pickup", async () => {
  const baseSchedule = {
    "Assignment ID": "ASG-FIRST",
    "Driver ID": "001",
    "Ride ID": "RID-OLD",
    Pickup: "Heathrow",
    "Drop Off": "Chelsea",
    "Start Time": "2026-07-21T10:00:00.000Z",
    "End Time": "2026-07-21T11:00:00.000Z",
    Status: "Assigned",
    "Next Available Time": "2026-07-21T11:00:00.000Z",
    "Current Location": "Chelsea"
  };
  const lateRide = await detectLinkedRideOpportunity({
    ride: { ...RIDE, Refer: "RID-LATE", Pickup: "Chelsea", "Start Time": "2026-07-21T18:00:00.000Z" },
    driver: { driver_id: "001" },
    vehicle: { vehicle_id: "V001" },
    scheduleRows: [baseSchedule],
    distanceProvider: async () => 0,
    options: { maxLinkedRideGapMinutes: 180 }
  });
  const farRide = await detectLinkedRideOpportunity({
    ride: { ...RIDE, Refer: "RID-FAR", Pickup: "Luton", "Start Time": "2026-07-21T12:00:00.000Z" },
    driver: { driver_id: "001" },
    vehicle: { vehicle_id: "V001" },
    scheduleRows: [baseSchedule],
    distanceProvider: async () => 50000,
    options: { maxLinkedRideGapMinutes: 180 }
  });

  assert.equal(lateRide, null);
  assert.equal(farRide, null);
});

test("recommendation sheet output uses requested schema and Driver ID", async () => {
  const recommendation = await generateRecommendation(
    {
      ...RIDE,
      Refer: "RID-LINKED-SECOND",
      Pickup: "Chelsea",
      "Drop Off": "Gatwick",
      "Start Time": "2026-07-21T12:00:00.000Z"
    },
    [DRIVERS[0]],
    [VEHICLES[0]],
    {
    scheduleRows: [
      {
        "Assignment ID": "ASG-LINKED-FIRST",
        "Driver ID": "001",
        "Ride ID": "RID-LINKED-FIRST",
        Pickup: "Heathrow",
        "Drop Off": "Chelsea",
        "Start Time": "2026-07-21T10:00:00.000Z",
        "End Time": "2026-07-21T11:00:00.000Z",
        Status: "Assigned",
        "Next Available Time": "2026-07-21T11:00:00.000Z",
        "Current Location": "Chelsea"
      }
    ],
    distanceProvider: async (from, to) => {
      if (from === "Chelsea" && to === "Chelsea") return 0;
      return 25000;
    },
    now: new Date("2026-07-21T10:00:00.000Z")
  });
  const row = buildRecommendationSheetRow(recommendation, RECOMMENDATION_HEADERS);

  assert.deepEqual(Object.keys(recommendation), RECOMMENDATION_HEADERS);
  assert.equal(recommendation["Recommended Driver"], "001");
  assert.equal(recommendation["Recommended Vehicle"], "V001");
  assert.equal(recommendation["Linked Ride ID"], "LINK-RID-LINKED-FIRST-RID-LINKED-SECOND-001-V001");
  assert.equal(recommendation["Previous Ride"], "RID-LINKED-FIRST");
  assert.equal(recommendation["Next Ride"], "RID-LINKED-SECOND");
  assert.equal(recommendation["Time Gap"], "60 min");
  assert.equal(recommendation["Distance Between"], "0 m");
  assert.equal(recommendation["Estimated Saving"], "0 km empty-mile saving");
  assert.equal(recommendation.Status, "Pending");
  assert.equal(recommendation["Assignment Status"], "Pending");
  assert.equal(row.length, 17);
  assert.deepEqual(row, [
    "RID-LINKED-SECOND",
    "Chelsea",
    "Gatwick",
    "MPV",
    "001",
    "V001",
    "LINK-RID-LINKED-FIRST-RID-LINKED-SECOND-001-V001",
    "RID-LINKED-FIRST",
    "RID-LINKED-SECOND",
    "60 min",
    "0 m",
    "0 km empty-mile saving",
    "93",
    "Vehicle matched, driver available, closest location, linked route opportunity, return ride match, short rest window",
    "2026-07-21T10:00:00.000Z",
    "Pending",
    "Pending"
  ]);
});

test("linked ride sheet creation uses requested schema", () => {
  const opportunity = {
    linkId: "LINK-RID1-RID2-001-V001",
    firstRideId: "RID1",
    secondRideId: "RID2",
    driverId: "001",
    vehicleId: "V001",
    previousDrop: "Chelsea",
    nextPickup: "Chelsea",
    gapMinutes: 60,
    distanceMeters: 1500,
    savingEstimate: "2 km empty-mile saving"
  };
  const rowObject = buildLinkedRideRowObject(opportunity);
  const row = buildLinkedRideSheetRow(rowObject, LINKED_RIDES_HEADERS);

  assert.deepEqual(Object.keys(rowObject), LINKED_RIDES_HEADERS);
  assert.deepEqual(row, [
    "LINK-RID1-RID2-001-V001",
    "RID1",
    "RID2",
    "001",
    "V001",
    "Chelsea",
    "Chelsea",
    "60 min",
    "1500 m",
    "2 km empty-mile saving",
    "Pending"
  ]);
});

test("recommendation polling appends one row for unrecommended Final Bid ride", async () => {
  const appendedRows = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          const text = String(range);
          if (text.includes("Final Bid")) {
            return {
              data: {
                values: [
                  ["Refer", "Pickup", "Drop Off", "Required Vehicle", "Status", "Assigned Driver"],
                  ["RID-20260721-001", "Heathrow", "Chelsea", "MPV", "Pending", ""]
                ]
              }
            };
          }
          if (text.includes("Driver Recommendations")) {
            return { data: { values: [RECOMMENDATION_HEADERS] } };
          }
          if (text.includes("Driver Schedule")) {
            return { data: { values: [DRIVER_SCHEDULE_HEADERS] } };
          }
          if (text.includes("Vehicle Schedule")) {
            return { data: { values: [VEHICLE_SCHEDULE_HEADERS] } };
          }
          if (text.includes("Linked Rides")) {
            return { data: { values: [LINKED_RIDES_HEADERS] } };
          }
          if (text.includes("Drivers")) {
            return {
              data: {
                values: [
                  [
                    "Driver ID",
                    "Driver Name",
                    "WhatsApp Number",
                    "Status",
                    "Current Location",
                    "Working Hours",
                    "Vehicle ID"
                  ],
                  ["001", "Ali Khan", "+447xxxx", "Available", "Heathrow", "Any", "V001"],
                  ["002", "Sara Khan", "+447yyyy", "Available", "London", "Any", "V002"]
                ]
              }
            };
          }
          if (text.includes("Vehicles")) {
            return {
              data: {
                values: [
                  ["Vehicle ID", "Vehicle Type", "Seats", "Registration", "Driver ID"],
                  ["V001", "MPV", "8", "AB123CD", "001"],
                  ["V002", "Saloon", "4", "XY123ZZ", "002"]
                ]
              }
            };
          }
          return { data: { values: [] } };
        },
        append: async ({ requestBody }) => {
          appendedRows.push(...requestBody.values);
          return { data: { updates: { updatedRange: "'Driver Recommendations'!A2:Q2" } } };
        }
      }
    }
  };

  const result = await recommendDriversForFinalBidRides({
    sheetsClient,
    spreadsheetId: "sheet-id",
    distanceProvider: async (from) => (from === "Heathrow" ? 0 : 25000),
    now: new Date("2026-07-21T10:00:00.000Z"),
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(result.appended, 1);
  assert.equal(appendedRows.length, 1);
  assert.equal(appendedRows[0][0], "RID-20260721-001");
  assert.equal(appendedRows[0][4], "001");
  assert.equal(appendedRows[0][5], "V001");
  assert.equal(appendedRows[0][15], "Pending");
  assert.equal(appendedRows[0][16], "Pending");
});

test("recommendation polling appends linked ride opportunity row", async () => {
  const recommendationRows = [];
  const linkedRows = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          const text = String(range);
          if (text.includes("Final Bid")) {
            return {
              data: {
                values: [
                  ["Refer", "Pickup", "Drop Off", "Required Vehicle", "Start Time", "Status", "Assigned Driver"],
                  ["RID-RETURN", "Chelsea", "Gatwick", "MPV", "2026-07-21T12:00:00.000Z", "Pending", ""]
                ]
              }
            };
          }
          if (text.includes("Driver Recommendations")) {
            return { data: { values: [RECOMMENDATION_HEADERS] } };
          }
          if (text.includes("Driver Schedule")) {
            return {
              data: {
                values: [
                  DRIVER_SCHEDULE_HEADERS,
                  [
                    "ASG-FIRST",
                    "001",
                    "RID-FIRST",
                    "Heathrow",
                    "Chelsea",
                    "2026-07-21T10:00:00.000Z",
                    "2026-07-21T11:00:00.000Z",
                    "Assigned",
                    "2026-07-21T11:00:00.000Z",
                    "Chelsea",
                    "",
                    ""
                  ]
                ]
              }
            };
          }
          if (text.includes("Vehicle Schedule")) {
            return { data: { values: [VEHICLE_SCHEDULE_HEADERS] } };
          }
          if (text.includes("Linked Rides")) {
            return { data: { values: [LINKED_RIDES_HEADERS] } };
          }
          if (text.includes("Drivers")) {
            return {
              data: {
                values: [
                  ["Driver ID", "Driver Name", "WhatsApp Number", "Status", "Current Location", "Working Hours", "Vehicle ID"],
                  ["001", "Ali Khan", "+447xxxx", "Available", "Chelsea", "Any", ""]
                ]
              }
            };
          }
          if (text.includes("Vehicles")) {
            return {
              data: {
                values: [
                  ["Vehicle ID", "Vehicle Type", "Seats", "Registration", "Driver ID"],
                  ["V001", "MPV", "8", "AB123CD", ""]
                ]
              }
            };
          }
          return { data: { values: [] } };
        },
        append: async ({ range, requestBody }) => {
          if (String(range).includes("Linked Rides")) linkedRows.push(...requestBody.values);
          else recommendationRows.push(...requestBody.values);
          return { data: { updates: { updatedRange: range } } };
        }
      }
    }
  };

  const result = await recommendDriversForFinalBidRides({
    sheetsClient,
    spreadsheetId: "sheet-id",
    distanceProvider: async (from, to) => (from === "Chelsea" && to === "Chelsea" ? 0 : 1000),
    now: new Date("2026-07-21T09:00:00.000Z"),
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(result.appended, 1);
  assert.equal(recommendationRows.length, 1);
  assert.equal(linkedRows.length, 1);
  assert.equal(linkedRows[0][1], "RID-FIRST");
  assert.equal(linkedRows[0][2], "RID-RETURN");
  assert.equal(linkedRows[0][3], "001");
  assert.equal(linkedRows[0][4], "V001");
});

test("approved recommendation assigns driver ID to matching Final Bid ride", async () => {
  const updateCalls = [];
  const appendedRows = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          const text = String(range);
          if (text.includes("Final Bid")) {
            return {
              data: {
                values: [
                  [
                    "Refer",
                    "Pickup",
                    "Drop Off",
                    "Required Vehicle",
                    "Pickup Day & Date",
                    "Starting Timing",
                    "Status",
                    "Assigned Driver"
                  ],
                  [
                    "RID-20260721-001",
                    "Heathrow",
                    "Chelsea",
                    "MPV",
                    "Tuesday 21st July 2026",
                    "10:00 am",
                    "Approved",
                    ""
                  ]
                ]
              }
            };
          }
          if (text.includes("Driver Recommendations")) {
            return {
              data: {
                values: [
                  RECOMMENDATION_HEADERS,
                  [
                    "RID-20260721-001",
                    "Heathrow",
                    "Chelsea",
                    "MPV",
                    "001",
                    "V001",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "96",
                    "Vehicle matched",
                    "2026-07-21T10:00:00.000Z",
                    "Approved",
                    "Pending"
                  ]
                ]
              }
            };
          }
          if (text.includes("Driver Schedule")) {
            return { data: { values: [DRIVER_SCHEDULE_HEADERS] } };
          }
          if (text.includes("Vehicle Schedule")) {
            return { data: { values: [VEHICLE_SCHEDULE_HEADERS] } };
          }
          if (text.includes("Linked Rides")) {
            return { data: { values: [LINKED_RIDES_HEADERS] } };
          }
          if (text.includes("Drivers")) {
            return {
              data: {
                values: [
                  [
                    "Driver ID",
                    "Driver Name",
                    "WhatsApp Number",
                    "Status",
                    "Current Location",
                    "Working Hours",
                    "Vehicle ID"
                  ],
                  ["001", "Ali Khan", "+447xxxx", "Available", "Heathrow", "Any", "V001"]
                ]
              }
            };
          }
          return { data: { values: [] } };
        },
        update: async (request) => {
          updateCalls.push(request);
          return { data: { updatedRange: request.range } };
        },
        append: async ({ requestBody }) => {
          appendedRows.push(...requestBody.values);
          return { data: { updates: { updatedRange: "'Driver Schedule'!A2:L2" } } };
        }
      }
    }
  };

  const result = await processApprovedDriverRecommendations({
    sheetsClient,
    spreadsheetId: "sheet-id",
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(result.assigned, 1);
  assert.equal(result.failed, 0);
  assert.equal(updateCalls.length, 3);
  assert.ok(updateCalls[0].range.includes("Final Bid"));
  assert.deepEqual(updateCalls[0].requestBody.values, [["001"]]);
  assert.ok(updateCalls[1].range.includes("Drivers"));
  assert.deepEqual(updateCalls[1].requestBody.values, [["Chelsea"]]);
  assert.ok(updateCalls[2].range.includes("Driver Recommendations"));
  assert.deepEqual(updateCalls[2].requestBody.values, [["Assigned"]]);
  assert.equal(appendedRows.length, 2);
  assert.equal(appendedRows[0][1], "001");
  assert.equal(appendedRows[0][2], "RID-20260721-001");
  assert.equal(appendedRows[0][3], "Heathrow");
  assert.equal(appendedRows[0][4], "Chelsea");
  assert.equal(appendedRows[0][7], "Assigned");
  assert.equal(appendedRows[0][9], "Chelsea");
  assert.deepEqual(appendedRows[1], [
    "V001",
    "RID-20260721-001",
    "001",
    "2026-07-21T09:00:00.000Z",
    "2026-07-21T10:00:00.000Z",
    "Assigned"
  ]);
});

test("approved recommendation fails when recommended vehicle is already booked", async () => {
  const updateCalls = [];
  const appendedRows = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          const text = String(range);
          if (text.includes("Final Bid")) {
            return {
              data: {
                values: [
                  ["Refer", "Pickup", "Drop Off", "Required Vehicle", "Start Time", "Status", "Assigned Driver"],
                  ["RID-DOUBLE-BOOK", "Heathrow", "Chelsea", "MPV", "2026-07-21T10:00:00.000Z", "Approved", ""]
                ]
              }
            };
          }
          if (text.includes("Driver Recommendations")) {
            return {
              data: {
                values: [
                  RECOMMENDATION_HEADERS,
                  [
                    "RID-DOUBLE-BOOK",
                    "Heathrow",
                    "Chelsea",
                    "MPV",
                    "001",
                    "V001",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "96",
                    "Vehicle matched",
                    "2026-07-21T10:00:00.000Z",
                    "Approved",
                    "Pending"
                  ]
                ]
              }
            };
          }
          if (text.includes("Driver Schedule")) {
            return { data: { values: [DRIVER_SCHEDULE_HEADERS] } };
          }
          if (text.includes("Vehicle Schedule")) {
            return {
              data: {
                values: [
                  VEHICLE_SCHEDULE_HEADERS,
                  [
                    "V001",
                    "RID-EXISTING",
                    "009",
                    "2026-07-21T09:30:00.000Z",
                    "2026-07-21T10:45:00.000Z",
                    "Assigned"
                  ]
                ]
              }
            };
          }
          if (text.includes("Linked Rides")) {
            return { data: { values: [LINKED_RIDES_HEADERS] } };
          }
          if (text.includes("Drivers")) {
            return {
              data: {
                values: [
                  ["Driver ID", "Driver Name", "WhatsApp Number", "Status", "Current Location", "Working Hours", "Vehicle ID"],
                  ["001", "Ali Khan", "+447xxxx", "Available", "Heathrow", "Any", "V001"]
                ]
              }
            };
          }
          return { data: { values: [] } };
        },
        update: async (request) => {
          updateCalls.push(request);
          return { data: { updatedRange: request.range } };
        },
        append: async ({ requestBody }) => {
          appendedRows.push(...requestBody.values);
          return { data: { updates: { updatedRange: "'Driver Schedule'!A2:L2" } } };
        }
      }
    }
  };

  const result = await processApprovedDriverRecommendations({
    sheetsClient,
    spreadsheetId: "sheet-id",
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(result.assigned, 0);
  assert.equal(result.failed, 1);
  assert.equal(appendedRows.length, 0);
  assert.equal(updateCalls.length, 1);
  assert.ok(updateCalls[0].range.includes("Driver Recommendations"));
  assert.deepEqual(updateCalls[0].requestBody.values, [["Failed"]]);
});

test("approved recommendation skips duplicate assignment when Final Bid already has driver", async () => {
  const updateCalls = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          const text = String(range);
          if (text.includes("Final Bid")) {
            return {
              data: {
                values: [
                  ["Refer", "Pickup", "Drop Off", "Required Vehicle", "Status", "Assigned Driver"],
                  ["RID-20260721-001", "Heathrow", "Chelsea", "MPV", "Approved", "009"]
                ]
              }
            };
          }
          if (text.includes("Driver Recommendations")) {
            return {
              data: {
                values: [
                  RECOMMENDATION_HEADERS,
                  [
                    "RID-20260721-001",
                    "Heathrow",
                    "Chelsea",
                    "MPV",
                    "001",
                    "V001",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "96",
                    "Vehicle matched",
                    "2026-07-21T10:00:00.000Z",
                    "Approved",
                    "Pending"
                  ]
                ]
              }
            };
          }
          if (text.includes("Driver Schedule")) {
            return { data: { values: [DRIVER_SCHEDULE_HEADERS] } };
          }
          if (text.includes("Vehicle Schedule")) {
            return { data: { values: [VEHICLE_SCHEDULE_HEADERS] } };
          }
          if (text.includes("Linked Rides")) {
            return { data: { values: [LINKED_RIDES_HEADERS] } };
          }
          if (text.includes("Drivers")) {
            return {
              data: {
                values: [
                  [
                    "Driver ID",
                    "Driver Name",
                    "WhatsApp Number",
                    "Status",
                    "Current Location",
                    "Working Hours",
                    "Vehicle ID"
                  ],
                  ["001", "Ali Khan", "+447xxxx", "Available", "Heathrow", "Any", "V001"]
                ]
              }
            };
          }
          return { data: { values: [] } };
        },
        update: async (request) => {
          updateCalls.push(request);
          return { data: { updatedRange: request.range } };
        }
      }
    }
  };

  const result = await processApprovedDriverRecommendations({
    sheetsClient,
    spreadsheetId: "sheet-id",
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(result.assigned, 0);
  assert.equal(result.skipped, 1);
  assert.equal(updateCalls.length, 1);
  assert.ok(updateCalls[0].range.includes("Driver Recommendations"));
  assert.deepEqual(updateCalls[0].requestBody.values, [["Assigned"]]);
});
