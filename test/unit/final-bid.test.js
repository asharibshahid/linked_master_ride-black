const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FINAL_BID_HEADERS,
  evaluateFinalBidRide,
  buildFinalBidSheetRowObject,
  buildFinalBidSheetRow,
  createFinalBidAppender
} = require("../../src/bids/finalBid");

function createRecordingLogger() {
  const entries = [];
  const logger = {
    info: (message, meta = {}) => entries.push({ level: "info", message, meta }),
    warn: (message, meta = {}) => entries.push({ level: "warn", message, meta }),
    error: (message, meta = {}) => entries.push({ level: "error", message, meta }),
    debug: (message, meta = {}) => entries.push({ level: "debug", message, meta }),
    child: () => logger
  };

  return { logger, entries };
}

const ELIGIBLE_RIDE = {
  refer: "RID-20260718-AB12",
  group_name: "General Taxi Bookings",
  source_name: "Ali Driver",
  pickup_day_date: "Friday 13th March 2026",
  starting_timing: "6:25 am",
  pickup: "Heathrow Airport",
  drop_off: "SW1A 1AA",
  distance: "68",
  fare: "145",
  required_vehicle: "Saloon Car",
  payment_status: ""
};

test("evaluateFinalBidRide accepts rides that match configurable fare and distance rules", () => {
  const evaluation = evaluateFinalBidRide(ELIGIBLE_RIDE, {
    config: {
      minFare: 80,
      maxDistance: 100,
      allowedVehicles: ["Saloon Car"],
      minScore: 60
    }
  });

  assert.equal(evaluation.eligible, true);
  assert.ok(evaluation.score >= 60);
  assert.match(evaluation.reason, /fare 145 >= 80/);
  assert.match(evaluation.reason, /distance 68 accepted/);
});

test("evaluateFinalBidRide rejects rides that do not match configured bid rules", () => {
  const lowFare = evaluateFinalBidRide(
    {
      ...ELIGIBLE_RIDE,
      fare: "75"
    },
    {
      config: {
        minFare: 80
      }
    }
  );

  const excludedVehicle = evaluateFinalBidRide(
    {
      ...ELIGIBLE_RIDE,
      required_vehicle: "8 Seater"
    },
    {
      config: {
        minFare: 80,
        excludedVehicles: ["8 Seater"]
      }
    }
  );

  assert.equal(lowFare.eligible, false);
  assert.ok(lowFare.failedRules.includes("fare_below_minimum"));
  assert.equal(excludedVehicle.eligible, false);
  assert.ok(excludedVehicle.failedRules.includes("vehicle_excluded"));
});

test("evaluateFinalBidRide applies allowed area code criteria before downstream workflows", () => {
  const accepted = evaluateFinalBidRide(
    {
      ...ELIGIBLE_RIDE,
      pickup: "Heathrow Terminal 5",
      drop_off: "Chelsea SW3 1AA"
    },
    {
      config: {
        minFare: 80,
        allowedAreaCodes: ["LHR"],
        areaMatchMode: "pickup"
      }
    }
  );
  const rejected = evaluateFinalBidRide(
    {
      ...ELIGIBLE_RIDE,
      pickup: "Manchester Airport",
      drop_off: "Liverpool L1 1AA"
    },
    {
      config: {
        minFare: 80,
        allowedAreaCodes: ["LHR", "SW3"],
        areaMatchMode: "either"
      }
    }
  );

  assert.equal(accepted.eligible, true);
  assert.match(accepted.reason, /area accepted/);
  assert.equal(rejected.eligible, false);
  assert.ok(rejected.failedRules.includes("area_not_allowed"));
});

test("buildFinalBidSheetRowObject maps eligible ride into Final Bid schema with Pending status", () => {
  const evaluation = evaluateFinalBidRide(ELIGIBLE_RIDE, {
    config: {
      minFare: 80
    }
  });
  const rowObject = buildFinalBidSheetRowObject({
    ride: ELIGIBLE_RIDE,
    evaluation,
    createdTime: "2026-07-18T12:00:00.000Z"
  });
  const row = buildFinalBidSheetRow(rowObject, FINAL_BID_HEADERS);

  assert.equal(rowObject.Status, "Pending");
  assert.equal(rowObject["Assigned Driver"], "");
  assert.equal(rowObject["Calendar Status"], "");
  assert.equal(rowObject["Calendar Event ID"], "");
  assert.equal(rowObject["Created Time"], "2026-07-18T12:00:00.000Z");
  assert.equal(rowObject["Calendar Created Time"], "");
  assert.equal(rowObject["Calendar Error"], "");
  assert.equal(row.length, FINAL_BID_HEADERS.length);
  assert.equal(row[0], "RID-20260718-AB12");
  assert.equal(row[10], String(evaluation.score));
  assert.equal(row[12], "Pending");
});

test("createFinalBidAppender appends matching rides and skips non-matching rides", async () => {
  const { logger, entries } = createRecordingLogger();
  const appendCalls = [];
  const appendFinalBidIfEligible = createFinalBidAppender({
    appendRow: async (payload) => {
      appendCalls.push(payload);
      return { updatedRange: "Final Bid!A2", updatedRows: 1 };
    },
    config: {
      minFare: 80,
      maxDistance: 100,
      minScore: 60
    },
    logger,
    now: new Date("2026-07-18T12:00:00.000Z")
  });

  const appended = await appendFinalBidIfEligible(ELIGIBLE_RIDE);
  const skipped = await appendFinalBidIfEligible({
    ...ELIGIBLE_RIDE,
    refer: "RID-LOW",
    fare: "60"
  });

  assert.equal(appended.appended, true);
  assert.equal(skipped.appended, false);
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].Status, "Pending");
  assert.ok(entries.some((entry) => entry.message === "Final Bid appended"));
  assert.ok(entries.some((entry) => entry.message === "Final Bid skipped"));
});

test("createFinalBidAppender can use dynamic criteria provider", async () => {
  const appendCalls = [];
  const appendFinalBidIfEligible = createFinalBidAppender({
    appendRow: async (payload) => {
      appendCalls.push(payload);
      return { updatedRange: "Final Bid!A2", updatedRows: 1 };
    },
    config: {
      minFare: 80
    },
    configProvider: async () => ({
      minFare: 200,
      allowedAreaCodes: ["LHR"],
      areaMatchMode: "pickup"
    })
  });

  const skipped = await appendFinalBidIfEligible({
    ...ELIGIBLE_RIDE,
    refer: "RID-DYN-LOW",
    pickup: "Heathrow Terminal 5",
    fare: "145"
  });
  const appended = await appendFinalBidIfEligible({
    ...ELIGIBLE_RIDE,
    refer: "RID-DYN-HIGH",
    pickup: "Heathrow Terminal 5",
    fare: "220"
  });

  assert.equal(skipped.appended, false);
  assert.ok(skipped.evaluation.failedRules.includes("fare_below_minimum"));
  assert.equal(appended.appended, true);
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].Refer, "RID-DYN-HIGH");
});
