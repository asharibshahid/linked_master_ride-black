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
  assert.equal(row.length, 17);
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
