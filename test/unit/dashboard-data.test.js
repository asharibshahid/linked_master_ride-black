const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDashboardPayload,
  buildSummary,
  loadDashboardData,
  recordsFromValues,
  renderDashboardPage
} = require("../../src/dashboard/data");

test("recordsFromValues maps Google Sheets values into objects", () => {
  const records = recordsFromValues([
    ["Refer", "Pickup", "Fare"],
    ["RID-1", "Heathrow", "120"]
  ]);

  assert.deepEqual(records, [{ Refer: "RID-1", Pickup: "Heathrow", Fare: "120" }]);
});

test("buildSummary counts dispatch health metrics and sources", () => {
  const now = new Date("2026-08-10T08:00:00.000Z");
  const summary = buildSummary(
    {
      rides: [
        {
          Refer: "RID-WA",
          "Group Name": "WhatsApp Group",
          "Pickup Day & Date": "Monday 10th Aug 2026"
        },
        {
          Refer: "RID-OTS",
          "Group Name": "OTS",
          "Source Name": "OTS Supplier Portal",
          "Pickup Day & Date": "Tuesday 11th Aug 2026",
          "Starting Timing": "10:00"
        }
      ],
      finalBid: [
        { Refer: "RID-1", Status: "Pending", "Assigned Driver": "", "Calendar Status": "" },
        {
          Refer: "RID-2",
          Status: "Approved",
          "Assigned Driver": "D-001",
          "Calendar Status": "Created"
        },
        {
          Refer: "RID-3",
          Status: "Approved",
          "Assigned Driver": "D-002",
          "Calendar Status": "Failed"
        }
      ],
      recommendations: [{ "Ride ID": "RID-1", Status: "Pending" }],
      needsReview: [{ Refer: "RID-REVIEW" }],
      upcomingJobs: [{ Refer: "RID-UPCOMING" }, { Refer: "RID-UPCOMING-2" }],
      drivers: [
        { "Driver ID": "D-001", Status: "Available" },
        { "Driver ID": "D-002", Status: "Offline" }
      ],
      vehicles: [
        { "Vehicle ID": "V-001", Status: "Available" },
        { "Vehicle ID": "V-002", Status: "Offline" },
        { "Vehicle ID": "V-003" }
      ],
      driverSchedule: [
        { "Driver ID": "D-001", "Ride ID": "RID-A", Status: "Assigned" },
        { "Driver ID": "D-002", "Ride ID": "RID-B", Status: "Completed" }
      ],
      vehicleSchedule: [
        { "Vehicle ID": "V-001", "Ride ID": "RID-A", Status: "Assigned" },
        { "Vehicle ID": "V-002", "Ride ID": "RID-B", Status: "Failed" }
      ],
      linkedRides: [{ "Link ID": "LINK-1", Status: "Open" }],
      bidTracker: [
        { "Ride ID": "RID-1", "Bid Status": "Suggested", "Admin Status": "Pending" },
        { "Ride ID": "RID-2", "Bid Status": "Bid Done", "Admin Status": "Approved" },
        { "Ride ID": "RID-3", "Bid Status": "Approved", "Admin Status": "Approved" },
        { "Ride ID": "RID-4", "Bid Status": "Bid Failed", "Admin Status": "Approved" }
      ]
    },
    now
  );

  assert.equal(summary.totalRides, 2);
  assert.equal(summary.todayRides, 1);
  assert.equal(summary.prebookJobs, 1);
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.upcomingJobs, 2);
  assert.equal(summary.finalBid, 3);
  assert.equal(summary.approvedJobs, 2);
  assert.equal(summary.assignedRides, 2);
  assert.equal(summary.pendingFinalBid, 1);
  assert.equal(summary.calendarCreated, 1);
  assert.equal(summary.calendarFailed, 1);
  assert.equal(summary.activeDriverSchedule, 1);
  assert.equal(summary.activeVehicleSchedule, 1);
  assert.equal(summary.pendingRecommendations, 1);
  assert.equal(summary.availableDrivers, 1);
  assert.equal(summary.availableVehicles, 2);
  assert.equal(summary.totalVehicles, 3);
  assert.equal(summary.linkedOpportunities, 1);
  assert.equal(summary.pendingBids, 1);
  assert.equal(summary.readyBids, 1);
  assert.equal(summary.completedBids, 1);
  assert.equal(summary.failedBids, 1);
  assert.deepEqual(summary.sources, { WhatsApp: 1, OTS: 1 });
});

test("buildDashboardPayload sorts Final Bid jobs by pickup date and time", () => {
  const payload = buildDashboardPayload({
    finalBid: [
      {
        Refer: "RID-2",
        "Pickup Day & Date": "11 August 2026",
        "Starting Timing": "09:00",
        Pickup: "Chelsea",
        "Drop Off": "Gatwick"
      },
      {
        Refer: "RID-1",
        "Pickup Day & Date": "10 August 2026",
        "Starting Timing": "08:00",
        Pickup: "Heathrow",
        "Drop Off": "Chelsea"
      }
    ]
  });

  assert.equal(payload.ok, true);
  assert.deepEqual(
    payload.jobs.map((job) => job.rideId),
    ["RID-1", "RID-2"]
  );
});

test("buildDashboardPayload exposes approved jobs as a sorted operational list", () => {
  const payload = buildDashboardPayload({
    finalBid: [
      {
        Refer: "RID-PENDING",
        Status: "Pending",
        "Pickup Day & Date": "10 August 2026",
        "Starting Timing": "07:00",
        Pickup: "Heathrow"
      },
      {
        Refer: "RID-APPROVED-2",
        Status: "Approved",
        "Assigned Driver": "D-002",
        "Calendar Status": "Created",
        "Pickup Day & Date": "11 August 2026",
        "Starting Timing": "09:00",
        Pickup: "Chelsea"
      },
      {
        Refer: "RID-APPROVED-1",
        Status: "Approved",
        "Assigned Driver": "D-001",
        "Calendar Status": "Pending",
        "Pickup Day & Date": "10 August 2026",
        "Starting Timing": "08:00",
        Pickup: "Heathrow"
      }
    ]
  });

  assert.deepEqual(
    payload.approvedJobs.map((job) => job.rideId),
    ["RID-APPROVED-1", "RID-APPROVED-2"]
  );
  assert.deepEqual(
    payload.approvedJobs.map((job) => job.assignedDriver),
    ["D-001", "D-002"]
  );
  assert.deepEqual(
    payload.approvedJobs.map((job) => job.calendarStatus),
    ["Pending", "Created"]
  );
});

test("buildDashboardPayload resolves assigned vehicle from active vehicle schedule", () => {
  const payload = buildDashboardPayload(
    {
      finalBid: [
        {
          Refer: "RID-APPROVED",
          Status: "Approved",
          "Assigned Driver": "D-001",
          "Pickup Day & Date": "20 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Heathrow",
          "Drop Off": "Chelsea",
          Fare: "120",
          "Required Vehicle": "MPV"
        },
        {
          Refer: "RID-CLOSED",
          Status: "Approved",
          "Assigned Driver": "D-002",
          "Pickup Day & Date": "21 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Chelsea",
          "Drop Off": "Gatwick",
          Fare: "90",
          "Required Vehicle": "Saloon"
        },
        {
          Refer: "RID-EXPLICIT",
          Status: "Approved",
          "Assigned Driver": "D-003",
          "Assigned Vehicle": "V-EXPLICIT",
          "Pickup Day & Date": "22 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Gatwick",
          "Drop Off": "Oxford",
          Fare: "100",
          "Required Vehicle": "MPV"
        }
      ],
      vehicleSchedule: [
        { "Vehicle ID": "V-001", "Ride ID": "RID-APPROVED", Status: "Assigned" },
        { "Vehicle ID": "V-OLD", "Ride ID": "RID-CLOSED", Status: "Completed" },
        { "Vehicle ID": "V-SCHEDULE", "Ride ID": "RID-EXPLICIT", Status: "Assigned" }
      ]
    },
    { now: new Date("2026-08-12T09:00:00.000Z") }
  );

  assert.deepEqual(
    payload.jobs.map((job) => job.assignedVehicle),
    ["V-001", "", "V-EXPLICIT"]
  );
  assert.deepEqual(
    payload.approvedJobs.map((job) => job.assignedVehicle),
    ["V-001", "", "V-EXPLICIT"]
  );
  assert.equal(payload.prebookJobs[0].assignedVehicle, "V-001");
});

test("buildDashboardPayload exposes best recommendation on operational job rows", () => {
  const payload = buildDashboardPayload(
    {
      finalBid: [
        {
          Refer: "RID-RECOMMENDED",
          Status: "Pending",
          "Pickup Day & Date": "20 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Heathrow",
          "Drop Off": "Chelsea",
          Fare: "120",
          "Required Vehicle": "MPV"
        }
      ],
      recommendations: [
        {
          "Ride ID": "RID-RECOMMENDED",
          "Recommended Driver": "D-LOW",
          "Recommended Vehicle": "V-LOW",
          Score: "70",
          Status: "Pending",
          "Assignment Status": "Pending",
          "Created Time": "2026-08-12T09:00:00.000Z"
        },
        {
          "Ride ID": "RID-RECOMMENDED",
          "Recommended Driver": "D-HIGH",
          "Recommended Vehicle": "V-HIGH",
          Score: "94",
          Status: "Pending",
          "Assignment Status": "Pending",
          "Created Time": "2026-08-12T08:00:00.000Z"
        }
      ]
    },
    { now: new Date("2026-08-12T09:00:00.000Z") }
  );

  assert.equal(payload.jobs[0].recommendedDriver, "D-HIGH");
  assert.equal(payload.jobs[0].recommendedVehicle, "V-HIGH");
  assert.equal(payload.jobs[0].recommendationScore, "94");
  assert.equal(payload.jobs[0].recommendationStatus, "Pending");
  assert.equal(payload.jobs[0].assignmentStatus, "Pending");
  assert.equal(payload.prebookJobs[0].recommendedDriver, "D-HIGH");
});

test("buildDashboardPayload exposes latest bid tracker state on operational job rows", () => {
  const payload = buildDashboardPayload(
    {
      finalBid: [
        {
          Refer: "RID-BID",
          Status: "Approved",
          "Pickup Day & Date": "20 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Heathrow",
          "Drop Off": "Chelsea",
          Fare: "120",
          "Required Vehicle": "MPV"
        }
      ],
      bidTracker: [
        {
          "Ride ID": "RID-BID",
          "Bid Type": "Manual Review",
          "Bid Status": "Suggested",
          "Admin Status": "Pending",
          "Bid Amount": "110",
          "Updated Time": "2026-08-12T08:00:00.000Z"
        },
        {
          "Ride ID": "RID-BID",
          "Bid Type": "Auto Bid",
          "Bid Status": "Bid Done",
          "Admin Status": "Approved",
          "Bid Amount": "118",
          "Updated Time": "2026-08-12T09:00:00.000Z"
        }
      ]
    },
    { now: new Date("2026-08-12T09:00:00.000Z") }
  );

  assert.equal(payload.jobs[0].bidType, "Auto Bid");
  assert.equal(payload.jobs[0].bidStatus, "Bid Done");
  assert.equal(payload.jobs[0].bidAdminStatus, "Approved");
  assert.equal(payload.jobs[0].bidAmount, "118");
  assert.equal(payload.approvedJobs[0].bidStatus, "Bid Done");
  assert.equal(payload.prebookJobs[0].bidAmount, "118");
});

test("buildDashboardPayload exposes linked ride context on operational job rows", () => {
  const payload = buildDashboardPayload(
    {
      finalBid: [
        {
          Refer: "RID-FIRST",
          Status: "Approved",
          "Pickup Day & Date": "20 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Heathrow",
          "Drop Off": "Chelsea",
          Fare: "120",
          "Required Vehicle": "MPV"
        },
        {
          Refer: "RID-SECOND",
          Status: "Pending",
          "Pickup Day & Date": "20 September 2026",
          "Starting Timing": "13:00",
          Pickup: "Chelsea",
          "Drop Off": "Gatwick",
          Fare: "100",
          "Required Vehicle": "MPV"
        }
      ],
      linkedRides: [
        {
          "Link ID": "LINK-1",
          "First Ride ID": "RID-FIRST",
          "Second Ride ID": "RID-SECOND",
          "Time Gap": "120 min",
          "Distance Between": "900 m",
          "Saving Estimate": "Reduced empty mileage",
          Status: "Open"
        }
      ]
    },
    { now: new Date("2026-08-12T09:00:00.000Z") }
  );

  assert.equal(payload.jobs[0].linkedRideId, "LINK-1");
  assert.equal(payload.jobs[0].linkedWithRideId, "RID-SECOND");
  assert.equal(payload.jobs[0].linkedTimeGap, "120 min");
  assert.equal(payload.jobs[0].linkedDistanceBetween, "900 m");
  assert.equal(payload.jobs[0].linkedSaving, "Reduced empty mileage");
  assert.equal(payload.jobs[1].linkedWithRideId, "RID-FIRST");
  assert.equal(payload.approvedJobs[0].linkedWithRideId, "RID-SECOND");
  assert.equal(payload.prebookJobs[0].linkedRideId, "LINK-1");
});

test("buildDashboardPayload exposes action required jobs without changing date ordered jobs", () => {
  const payload = buildDashboardPayload({
    finalBid: [
      {
        Refer: "RID-PENDING",
        Status: "Pending",
        "Pickup Day & Date": "10 August 2026",
        "Starting Timing": "08:00",
        Pickup: "Heathrow"
      },
      {
        Refer: "RID-CALENDAR",
        Status: "Approved",
        "Assigned Driver": "D-001",
        "Calendar Status": "Create Failed",
        "Pickup Day & Date": "12 August 2026",
        "Starting Timing": "09:00",
        Pickup: "Chelsea"
      },
      {
        Refer: "RID-AI",
        Status: "Approved",
        "Pickup Day & Date": "11 August 2026",
        "Starting Timing": "09:00",
        Pickup: "Gatwick"
      }
    ],
    recommendations: [
      {
        "Ride ID": "RID-AI",
        "Recommended Driver": "D-002",
        "Recommended Vehicle": "V-002",
        Status: "Pending",
        "Assignment Status": "Pending"
      }
    ]
  });

  assert.deepEqual(
    payload.jobs.map((job) => job.rideId),
    ["RID-PENDING", "RID-AI", "RID-CALENDAR"]
  );
  assert.deepEqual(
    payload.actionRequiredJobs.map((job) => [job.rideId, job.actionReason]),
    [
      ["RID-CALENDAR", "Retry Calendar"],
      ["RID-PENDING", "Approve Ride"],
      ["RID-AI", "Assign AI"]
    ]
  );
});

test("buildDashboardPayload puts newly received action jobs ahead of older pickup dates", () => {
  const payload = buildDashboardPayload({
    finalBid: [
      {
        Refer: "RID-OLD-RECEIVED",
        Status: "Pending",
        "Pickup Day & Date": "30 August 2026",
        "Starting Timing": "08:00",
        "Created Time": "2026-08-27T08:00:00.000Z"
      },
      {
        Refer: "RID-NEW-RECEIVED",
        Status: "Pending",
        "Pickup Day & Date": "29 August 2026",
        "Starting Timing": "08:00",
        "Created Time": "2026-08-27T10:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(payload.actionRequiredJobs.map((job) => job.rideId), [
    "RID-NEW-RECEIVED",
    "RID-OLD-RECEIVED"
  ]);
  assert.deepEqual(payload.jobs.map((job) => job.rideId), ["RID-NEW-RECEIVED", "RID-OLD-RECEIVED"]);
});

test("buildDashboardPayload includes raw OTS rides in Jobs even before Final Bid eligibility", () => {
  const payload = buildDashboardPayload({
    rides: [
      {
        Refer: "OTS-RAW-001",
        "Group Name": "OTS",
        Pickup: "Heathrow",
        "Drop Off": "Chelsea",
        "Pickup Day & Date": "28 August 2026",
        "Starting Timing": "10:00",
        "Created Time": "2026-08-27T10:00:00.000Z"
      }
    ],
    finalBid: []
  });

  assert.equal(payload.jobs.length, 1);
  assert.equal(payload.jobs[0].rideId, "OTS-RAW-001");
  assert.equal(payload.jobs[0].source, "OTS");
});

test("buildDashboardPayload requires ride approval before driver recommendation approval", () => {
  const payload = buildDashboardPayload({
    finalBid: [
      {
        Refer: "RID-SEQUENCE",
        Status: "Pending",
        "Pickup Day & Date": "12 August 2026",
        "Starting Timing": "10:00",
        Pickup: "Heathrow",
        "Drop Off": "Chelsea",
        "Required Vehicle": "MPV"
      }
    ],
    recommendations: [
      {
        "Ride ID": "RID-SEQUENCE",
        "Recommended Driver": "D-001",
        "Recommended Vehicle": "V-001",
        Status: "Pending",
        "Assignment Status": "Pending"
      }
    ]
  });

  assert.equal(payload.actionRequiredJobs.length, 1);
  assert.equal(payload.actionRequiredJobs[0].actionReason, "Approve Ride");
});

test("buildDashboardPayload exposes deduped future pre-book jobs", () => {
  const payload = buildDashboardPayload(
    {
      rides: [
        {
          Refer: "RID-FUTURE",
          "Group Name": "WhatsApp Group",
          "Pickup Day & Date": "20 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Heathrow",
          "Drop Off": "Chelsea",
          Fare: "120",
          "Required Vehicle": "MPV"
        },
        {
          Refer: "RID-PAST",
          "Pickup Day & Date": "01 August 2026",
          "Starting Timing": "10:00",
          Pickup: "Old pickup"
        },
        {
          Refer: "RID-BAD-DATE",
          "Pickup Day & Date": "unknown",
          "Starting Timing": "10:00",
          Pickup: "Unknown"
        }
      ],
      upcomingJobs: [
        {
          Refer: "RID-FUTURE",
          "Pickup Day & Date": "20 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Heathrow",
          "Drop Off": "Chelsea",
          Fare: "120",
          "Required Vehicle": "MPV"
        },
        {
          Refer: "RID-UPCOMING-ONLY",
          "Group Name": "OTS",
          "Pickup Day & Date": "21 September 2026",
          "Starting Timing": "08:00",
          Pickup: "Chelsea",
          "Drop Off": "Gatwick",
          Fare: "95",
          "Required Vehicle": "Saloon"
        }
      ],
      finalBid: [
        {
          Refer: "RID-FUTURE",
          Status: "Approved",
          "Assigned Driver": "D-001",
          "Calendar Status": "Created",
          "Pickup Day & Date": "20 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Heathrow Terminal 5",
          "Drop Off": "Chelsea",
          Fare: "120",
          "Required Vehicle": "MPV"
        },
        {
          Refer: "RID-CANCELLED",
          Status: "Cancelled",
          "Pickup Day & Date": "22 September 2026",
          "Starting Timing": "10:00",
          Pickup: "Cancelled pickup"
        }
      ]
    },
    { now: new Date("2026-08-12T09:00:00.000Z") }
  );

  assert.deepEqual(
    payload.prebookJobs.map((job) => job.rideId),
    ["RID-FUTURE", "RID-UPCOMING-ONLY"]
  );
  assert.equal(payload.prebookJobs[0].pickup, "Heathrow Terminal 5");
  assert.equal(payload.prebookJobs[0].status, "Approved");
  assert.equal(payload.prebookJobs[0].assignedDriver, "D-001");
  assert.equal(payload.prebookJobs[1].source, "OTS");
  assert.equal(payload.summary.prebookJobs, 2);
});

test("buildDashboardPayload exposes Upcoming Jobs sorted and Needs Review latest first", () => {
  const payload = buildDashboardPayload({
    upcomingJobs: [
      {
        Refer: "RID-UP-2",
        "Pickup Day & Date": "12 August 2026",
        "Starting Timing": "12:00",
        Pickup: "Chelsea"
      },
      {
        Refer: "RID-UP-1",
        "Pickup Day & Date": "12 August 2026",
        "Starting Timing": "08:00",
        Pickup: "Heathrow"
      }
    ],
    needsReview: [
      { Refer: "RID-OLD", Pickup: "", "Drop Off": "Chelsea" },
      {
        Refer: "RID-NEW",
        Pickup: "Heathrow",
        "Drop Off": "Chelsea",
        "Pickup Day & Date": "12 August 2026",
        "Starting Timing": "10:00",
        Fare: "120",
        "Required Vehicle": "MPV",
        Reason: "fixed by operator"
      }
    ]
  });

  assert.deepEqual(
    payload.upcomingJobs.map((job) => job.rideId),
    ["RID-UP-1", "RID-UP-2"]
  );
  assert.deepEqual(
    payload.needsReview.map((job) => job.rideId),
    ["RID-NEW", "RID-OLD"]
  );
  assert.equal(payload.needsReview[0].reviewReason, "fixed by operator");
  assert.match(payload.needsReview[1].reviewReason, /Missing pickup/);
  assert.equal(payload.needsReview[0].reviewReady, true);
  assert.equal(payload.needsReview[1].reviewReady, false);
});

test("buildDashboardPayload sorts recommendations by action priority and exposes linked context", () => {
  const payload = buildDashboardPayload({
    recommendations: [
      {
        "Ride ID": "RID-ASSIGNED",
        "Recommended Driver": "D-003",
        "Recommended Vehicle": "V-003",
        Score: "99",
        Reason: "Already assigned",
        Status: "Approved",
        "Assignment Status": "Assigned",
        "Created Time": "2026-08-12T08:00:00.000Z"
      },
      {
        "Ride ID": "RID-PENDING-LOW",
        "Recommended Driver": "D-002",
        "Recommended Vehicle": "V-002",
        Score: "70",
        Reason: "Available driver",
        Status: "Pending",
        "Assignment Status": "Pending",
        "Created Time": "2026-08-12T09:00:00.000Z"
      },
      {
        "Ride ID": "RID-PENDING-HIGH",
        "Recommended Driver": "D-001",
        "Recommended Vehicle": "V-001",
        "Linked Ride ID": "LINK-1",
        "Previous Ride": "RID-FIRST",
        "Next Ride": "RID-PENDING-HIGH",
        "Time Gap": "90 min",
        "Distance Between": "500 m",
        "Estimated Saving": "Reduced empty mileage",
        Score: "95",
        Reason: "Vehicle matched, linked route opportunity",
        Status: "Pending",
        "Assignment Status": "Pending",
        "Created Time": "2026-08-12T07:00:00.000Z"
      },
      {
        "Ride ID": "RID-FAILED",
        "Recommended Driver": "D-004",
        "Recommended Vehicle": "V-004",
        Score: "90",
        Reason: "Assignment failed",
        Status: "Approved",
        "Assignment Status": "Failed",
        "Created Time": "2026-08-12T10:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(
    payload.recommendations.map((row) => row.rideId),
    ["RID-PENDING-HIGH", "RID-PENDING-LOW", "RID-ASSIGNED", "RID-FAILED"]
  );
  assert.equal(payload.recommendations[0].linkedRideId, "LINK-1");
  assert.equal(payload.recommendations[0].previousRide, "RID-FIRST");
  assert.equal(payload.recommendations[0].timeGap, "90 min");
  assert.equal(payload.recommendations[0].distanceBetween, "500 m");
  assert.equal(payload.recommendations[0].estimatedSaving, "Reduced empty mileage");
  assert.match(payload.recommendations[0].reason, /linked route/);
});

test("buildDashboardPayload resolves active dispatch criteria for dashboard cards", () => {
  const payload = buildDashboardPayload(
    {
      dispatchCriteria: [
        { Setting: "FINAL_BID_MIN_FARE", Value: "95" },
        { Setting: "FINAL_BID_ALLOWED_AREA_CODES", Value: "LHR, SW3" },
        { Setting: "FINAL_BID_AREA_MATCH_MODE", Value: "pickup" },
        { Setting: "AUTO_BID_ENABLED", Value: "true" },
        { Setting: "AUTO_BID_MODE", Value: "safe" }
      ]
    },
    {
      system: {
        allowedAreaCodes: ["LGW"],
        areaMatchMode: "either",
        autoBidEnabled: false,
        autoBidMode: "live"
      }
    }
  );

  assert.deepEqual(payload.criteriaConfig.allowedAreaCodes, ["LHR", "SW3"]);
  assert.equal(payload.criteriaConfig.areaMatchMode, "pickup");
  assert.equal(payload.criteriaConfig.autoBidEnabled, true);
  assert.equal(payload.criteriaConfig.autoBidMode, "safe");
});

test("buildDashboardPayload warns when live auto-bid has no OTS submitter", () => {
  const payload = buildDashboardPayload(
    {
      dispatchCriteria: [
        { Setting: "AUTO_BID_ENABLED", Value: "true" },
        { Setting: "AUTO_BID_MODE", Value: "live" }
      ]
    },
    {
      system: {
        otsBidSubmitConfigured: false,
        autoBidEnabled: false,
        autoBidMode: "safe"
      }
    }
  );

  assert.equal(payload.systemWarnings.length, 1);
  assert.equal(payload.systemWarnings[0].sheet, "Auto Bid");
  assert.match(payload.systemWarnings[0].reason, /submitter is not configured/);
  assert.equal(payload.systemReadiness.otsSubmitter, "MISSING");
  assert.equal(payload.systemReadiness.autoBidMode, "LIVE");
});

test("buildDashboardPayload warns when OTS import inputs are missing", () => {
  const payload = buildDashboardPayload(
    {},
    {
      system: {
        otsIntegrationEnabled: true,
        otsRunPipeline: true,
        otsProjectConfigured: false,
        otsFormattedRowsConfigured: false
      }
    }
  );

  assert.equal(payload.systemWarnings.length, 2);
  assert.deepEqual(
    payload.systemWarnings.map((warning) => warning.sheet),
    ["OTS Import", "OTS Import"]
  );
  assert.match(payload.systemWarnings[0].reason, /formatted rows file/);
  assert.match(payload.systemWarnings[1].reason, /project path/);
  assert.equal(payload.systemReadiness.otsRows, "MISSING");
  assert.equal(payload.systemReadiness.otsPipeline, "MISSING");
});

test("buildDashboardPayload treats missing OTS rows as pipeline-generated when pipeline is ready", () => {
  const payload = buildDashboardPayload(
    {},
    {
      system: {
        otsIntegrationEnabled: true,
        otsRunPipeline: true,
        otsProjectConfigured: true,
        otsFormattedRowsPathConfigured: true,
        otsFormattedRowsConfigured: false
      }
    }
  );

  assert.equal(payload.systemWarnings.length, 0);
  assert.equal(payload.systemReadiness.otsRows, "PIPELINE");
  assert.equal(payload.systemReadiness.otsPipeline, "READY");
});

test("buildDashboardPayload warns when Calendar is enabled but client is not ready", () => {
  const payload = buildDashboardPayload(
    {},
    {
      system: {
        calendarEnabled: true,
        calendarClientReady: false,
        calendarIdConfigured: true
      }
    }
  );

  assert.equal(payload.systemWarnings.length, 1);
  assert.equal(payload.systemWarnings[0].sheet, "Calendar");
  assert.match(payload.systemWarnings[0].reason, /client is not ready/);
  assert.equal(payload.systemReadiness.calendar, "MISSING");
  assert.equal(payload.systemReadiness.calendarId, "READY");
});

test("buildDashboardPayload warns when WhatsApp is waiting for QR scan", () => {
  const payload = buildDashboardPayload(
    {},
    {
      system: {
        whatsappState: "qr_required",
        whatsappQrAvailable: true
      }
    }
  );

  assert.equal(payload.systemWarnings.length, 1);
  assert.equal(payload.systemWarnings[0].sheet, "WhatsApp");
  assert.match(payload.systemWarnings[0].reason, /QR scan/);
  assert.equal(payload.systemReadiness.whatsapp, "QR");
  assert.equal(payload.systemReadiness.whatsappQr, "AVAILABLE");
});

test("buildDashboardPayload exposes schedule timelines sorted by start time", () => {
  const payload = buildDashboardPayload({
    driverSchedule: [
      {
        "Assignment ID": "A-2",
        "Driver ID": "D-002",
        "Ride ID": "RID-2",
        Pickup: "Chelsea",
        "Drop Off": "Gatwick",
        "Start Time": "2026-08-12T12:00:00.000Z",
        "End Time": "2026-08-12T13:00:00.000Z",
        Status: "Assigned"
      },
      {
        "Assignment ID": "A-1",
        "Driver ID": "D-001",
        "Ride ID": "RID-1",
        Pickup: "Heathrow",
        "Drop Off": "Chelsea",
        "Start Time": "2026-08-12T09:00:00.000Z",
        "End Time": "2026-08-12T10:00:00.000Z",
        Status: "Assigned"
      }
    ],
    vehicleSchedule: [
      {
        "Vehicle ID": "V-002",
        "Ride ID": "RID-2",
        "Driver ID": "D-002",
        "Start Time": "2026-08-12T12:00:00.000Z",
        Status: "Assigned"
      },
      {
        "Vehicle ID": "V-001",
        "Ride ID": "RID-1",
        "Driver ID": "D-001",
        "Start Time": "2026-08-12T09:00:00.000Z",
        Status: "Assigned"
      }
    ]
  });

  assert.deepEqual(
    payload.driverSchedule.map((row) => row.rideId),
    ["RID-1", "RID-2"]
  );
  assert.deepEqual(
    payload.vehicleSchedule.map((row) => row.vehicleId),
    ["V-001", "V-002"]
  );
});

test("buildDashboardPayload exposes latest audit log entries", () => {
  const payload = buildDashboardPayload({
    auditLog: [
      {
        "Audit ID": "AUD-1",
        Action: "Driver Status Updated",
        "Target Type": "Driver",
        "Target ID": "D-001",
        Field: "Status",
        "Old Value": "Offline",
        "New Value": "Available",
        Actor: "Dashboard",
        Status: "Success",
        "Created Time": "2026-08-12T10:00:00.000Z"
      },
      {
        "Audit ID": "AUD-2",
        Action: "Final Bid Status Updated",
        "Target Type": "Final Bid",
        "Target ID": "RID-1",
        Field: "Status",
        "Old Value": "Pending",
        "New Value": "Approved",
        Actor: "Dashboard",
        Status: "Success",
        "Created Time": "2026-08-12T10:05:00.000Z"
      }
    ]
  });

  assert.equal(payload.auditLogs.length, 2);
  assert.equal(payload.auditLogs[0].auditId, "AUD-2");
  assert.equal(payload.auditLogs[0].targetId, "RID-1");
  assert.equal(payload.auditLogs[1].oldValue, "Offline");
});

test("renderDashboardPage includes audit log panel and fleet status actions", () => {
  const html = renderDashboardPage();

  assert.match(html, /Audit Log/);
  assert.match(html, /Command Center/);
  assert.match(html, /Ride Pipeline/);
  assert.match(html, /AI & Schedules/);
  assert.match(html, /Fleet & Settings/);
  assert.match(html, /data-view="command"/);
  assert.match(html, /data-view="pipeline"/);
  assert.match(html, /data-view="ai"/);
  assert.match(html, /data-view="bids"/);
  assert.match(html, /data-view="fleet"/);
  assert.match(html, /showView/);
  assert.match(html, /table-shell/);
  assert.match(html, /Upcoming Jobs/);
  assert.match(html, /Action Required/);
  assert.match(html, /Closed Ride/);
  assert.match(html, /Approved Jobs/);
  assert.match(html, /Pre-book Jobs/);
  assert.match(html, /Needs Review/);
  assert.match(html, /reviewReason/);
  assert.match(html, /promoteNeedsReview/);
  assert.match(html, /Move Final Bid/);
  assert.match(html, /Incomplete Review/);
  assert.match(html, /saveNeedsReview/);
  assert.match(html, /data-review-field/);
  assert.match(html, /pickupDayDate/);
  assert.match(html, /requiredVehicle/);
  assert.match(html, /\/api\/needs-review\/.*\/update/);
  assert.match(html, /\/api\/needs-review\//);
  assert.match(html, /Driver Timeline/);
  assert.match(html, /Vehicle Bookings/);
  assert.match(html, /completeScheduleRide/);
  assert.match(html, /Completing ride/);
  assert.match(html, /\/api\/schedules\/.*\/complete/);
  assert.match(html, /id="audit"/);
  assert.match(html, /id="warnings"/);
  assert.match(html, /id="upcoming"/);
  assert.match(html, /id="actionRequiredJobs"/);
  assert.match(html, /id="approvedJobs"/);
  assert.match(html, /id="prebookJobs"/);
  assert.match(html, /id="needsReview"/);
  assert.match(html, /id="driverSchedule"/);
  assert.match(html, /id="vehicleSchedule"/);
  assert.match(html, /setDriverStatus/);
  assert.match(html, /setVehicleStatus/);
  assert.match(html, /driverSearch/);
  assert.match(html, /vehicleSearch/);
  assert.match(html, /driverStatusFilter/);
  assert.match(html, /vehicleStatusFilter/);
  assert.match(html, /renderFleet/);
  assert.match(html, /All Drivers/);
  assert.match(html, /All Vehicles/);
  assert.match(html, /retryCalendar/);
  assert.match(html, /Retry Calendar/);
  assert.match(html, /rejectJob/);
  assert.match(html, /Rejecting ride/);
  assert.match(html, /status: 'Rejected'/);
  assert.match(html, /Calendar Missing/);
  assert.match(html, /Retry/);
  assert.match(html, /data-bid-amount/);
  assert.match(html, /data-bid-reason/);
  assert.match(html, /saveBidDraft/);
  assert.match(html, /rejectBid/);
  assert.match(html, /Rejecting bid/);
  assert.match(html, /adminStatus: 'Rejected'/);
  assert.match(html, /runAutoBidNow/);
  assert.match(html, /Run Auto Bid/);
  assert.match(html, /Bid Setup Missing/);
  assert.match(html, /Auto Bid Starting/);
  assert.match(html, /\/api\/bids\/process-approved/);
  assert.match(html, /runOtsImportNow/);
  assert.match(html, /Import OTS Now/);
  assert.match(html, /OTS Setup Missing/);
  assert.match(html, /OTS Starting/);
  assert.match(html, /\/api\/ots\/import-now/);
  assert.match(html, /runRecommendationsNow/);
  assert.match(html, /Generate AI Now/);
  assert.match(html, /AI Starting/);
  assert.match(html, /\/api\/recommendations\/run-now/);
  assert.match(html, /assignmentStatus/);
  assert.match(html, /Incomplete AI/);
  assert.match(html, /actionReason/);
  assert.match(html, /linkedRideId/);
  assert.match(html, /estimatedSaving/);
  assert.match(html, /class="reason"/);
  assert.match(html, /criteriaInput/);
  assert.match(html, /renderCriteriaPanel/);
  assert.match(html, /renderSystemWarnings/);
  assert.match(html, /System Warnings/);
  assert.match(html, /Open QR/);
  assert.match(html, /href="\/qr"/);
  assert.match(html, /Inbox/);
  assert.match(html, /AI Match/);
  assert.match(html, /Driver \+ vehicle suggestions/);
  assert.match(html, /flow-step/);
  assert.match(html, /ring/);
  assert.match(html, /MISSING/);
  assert.match(html, /FINAL_BID_AREA_MATCH_MODE/);
  assert.match(html, /AUTO_BID_ENABLED/);
  assert.match(html, /AUTO_BID_MODE/);
  assert.match(html, /LHR,LGW,SW3/);
  assert.match(html, /bidType/);
  assert.match(html, /updatedTime/);
  assert.match(html, /assignedVehicle/);
  assert.match(html, /Assigned Vehicle/);
  assert.match(html, /recommendedDriver/);
  assert.match(html, /recommendedVehicle/);
  assert.match(html, /recommendationScore/);
  assert.match(html, /AI Driver/);
  assert.match(html, /AI Vehicle/);
  assert.match(html, /assignAiButton/);
  assert.match(html, /Assign AI/);
  assert.match(html, /Retry AI/);
  assert.match(html, /bidAdminStatus/);
  assert.match(html, /Bid Admin/);
  assert.match(html, /No Bid/);
  assert.match(html, /linkedWithRideId/);
  assert.match(html, /linkedTimeGap/);
  assert.match(html, /linkedSaving/);
  assert.match(html, /Link Gap/);
  assert.match(html, /Available/);
  assert.match(html, /Offline/);
  assert.match(html, /X-Dashboard-Token/);
  assert.match(html, /X-Dashboard-Actor/);
});

test("loadDashboardData reads configured worksheets and reports partial sheet errors", async () => {
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          if (range.includes("'Broken'")) {
            throw new Error("Sheet missing");
          }
          return {
            data: {
              values: [
                ["Refer", "Pickup", "Drop Off"],
                ["RID-1", "Heathrow", "Chelsea"]
              ]
            }
          };
        }
      }
    }
  };

  const payload = await loadDashboardData({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetNames: {
      rides: "Rides",
      finalBid: "Broken"
    },
    limit: 5
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.recentRides.length, 1);
  assert.equal(payload.sheetErrors.length, 1);
  assert.equal(payload.sheetErrors[0].sheet, "Broken");
});

test("loadDashboardData can read dashboard records from database repository first", async () => {
  const payload = await loadDashboardData({
    databasePrimaryEnabled: true,
    databaseRepository: {
      loadDashboardData: async () => ({
        rides: [{ Refer: "RID-DB", Pickup: "Heathrow", "Drop Off": "Chelsea" }],
        finalBid: [{ Refer: "RID-DB", Status: "Pending", Pickup: "Heathrow", "Drop Off": "Chelsea" }],
        drivers: [{ "Driver ID": "D-001", Status: "Available" }],
        vehicles: [{ "Vehicle ID": "V-001", Status: "Available" }]
      })
    }
  });

  assert.equal(payload.dataSource, "database");
  assert.equal(payload.summary.totalRides, 1);
  assert.equal(payload.jobs[0].rideId, "RID-DB");
});

test("loadDashboardData returns readiness payload before Google Sheets is ready", async () => {
  const payload = await loadDashboardData({
    system: {
      whatsappState: "qr_required",
      whatsappQrAvailable: true
    }
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.systemReadiness.whatsapp, "QR");
  assert.equal(payload.sheetErrors.length, 1);
  assert.equal(payload.sheetErrors[0].sheet, "Google Sheets");
  assert.deepEqual(payload.jobs, []);
});
