const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DedupeStore } = require("../../src/utils/dedupe");
const {
  buildOtsDedupeKey,
  hasPendingDispatchImport,
  getMissingRequiredFields,
  importOtsRows,
  mapOtsRowToRide,
  parseOtsExpiry,
  createOtsImportRunner,
  runOtsImportOnce
} = require("../../src/ots/integration");
const { createSilentLogger } = require("../helpers");

const OTS_ROW = {
  refer: "OTS-1001",
  day_date: "Monday 10th Aug 2026",
  start_time: "10:00",
  pickup: "LHR T5",
  drop_off: "Chelsea London",
  distance_miles: 19,
  est_fare: "£120",
  required_vehicle: "MPV"
};

test("mapOtsRowToRide converts formatted OTS rows into dispatch ride schema", () => {
  const ride = mapOtsRowToRide(OTS_ROW, {
    groupName: "OTS Jobs",
    sourceName: "OTS Worker",
    sourceTime: "2026-08-09T10:00:00.000Z"
  });

  assert.equal(ride.refer, "OTS-1001");
  assert.equal(ride.group_name, "OTS Jobs");
  assert.equal(ride.source_name, "OTS Worker");
  assert.equal(ride.source_time, "2026-08-09T10:00:00.000Z");
  assert.equal(ride.pickup_day_date, "Monday 10th Aug 2026");
  assert.equal(ride.starting_timing, "10:00");
  assert.equal(ride.pickup, "LHR T5");
  assert.equal(ride.drop_off, "Chelsea London");
  assert.equal(ride.distance, "19");
  assert.equal(ride.fare, "120");
  assert.equal(ride.required_vehicle, "MPV");
  assert.equal(ride.payment_status, "OTS");
});

test("OTS offer expiry parses portal text even when 24-hour time includes am or pm", () => {
  assert.equal(
    parseOtsExpiry({ expires_text:"Expires on 20:17 pm, Wed 26th Aug 2026 (BST)" }),
    "2026-08-26T19:17:00.000Z"
  );
  assert.equal(
    parseOtsExpiry({ expires_text:"Expires on 08:10 am, Wed 19th Aug 2026 (BST)" }),
    "2026-08-19T07:10:00.000Z"
  );
});

test("getMissingRequiredFields flags incomplete OTS rides for review", () => {
  const ride = mapOtsRowToRide({
    ...OTS_ROW,
    pickup: ""
  });

  assert.deepEqual(getMissingRequiredFields(ride), ["pickup"]);
});

test("importOtsRows appends valid rides to dispatch flow", async () => {
  const dedupe = new DedupeStore({ logger: createSilentLogger() });
  const rideRows = [];
  const reviewRows = [];
  const finalBidRows = [];
  const upcomingRows = [];

  const summary = await importOtsRows([OTS_ROW], {
    dedupe,
    appendRideRow: async (ride) => rideRows.push(ride),
    appendReviewRow: async (ride) => reviewRows.push(ride),
    appendFinalBidIfEligible: async (ride) => finalBidRows.push(ride),
    appendUpcomingJobIfEligible: async (ride) => upcomingRows.push(ride),
    logger: createSilentLogger()
  });

  assert.equal(summary.imported, 1);
  assert.equal(summary.review, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(rideRows.length, 1);
  assert.equal(reviewRows.length, 0);
  assert.equal(finalBidRows.length, 1);
  assert.equal(upcomingRows.length, 1);
  assert.equal(rideRows[0].refer, "OTS-1001");
  assert.equal(dedupe.hasProcessed(buildOtsDedupeKey(rideRows[0], OTS_ROW)), true);
});

test("importOtsRows skips duplicate OTS references", async () => {
  const dedupe = new DedupeStore({ logger: createSilentLogger() });
  const rideRows = [];

  const first = await importOtsRows([OTS_ROW], {
    dedupe,
    appendRideRow: async (ride) => rideRows.push(ride),
    logger: createSilentLogger()
  });
  const second = await importOtsRows([OTS_ROW], {
    dedupe,
    appendRideRow: async (ride) => rideRows.push(ride),
    logger: createSilentLogger()
  });

  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);
  assert.equal(rideRows.length, 1);
});

test("importOtsRows sends incomplete rides to Needs Review", async () => {
  const reviewRows = [];
  const rideRows = [];

  const summary = await importOtsRows([{ ...OTS_ROW, pickup: "" }], {
    appendRideRow: async (ride) => rideRows.push(ride),
    appendReviewRow: async (ride) => reviewRows.push(ride),
    logger: createSilentLogger()
  });

  assert.equal(summary.imported, 0);
  assert.equal(summary.review, 1);
  assert.equal(rideRows.length, 0);
  assert.equal(reviewRows.length, 1);
  assert.match(reviewRows[0].payment_status, /missing pickup/);
});

test("runOtsImportOnce loads formatted rows and imports through dispatch callbacks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ots-import-"));
  const formattedRowsPath = path.join(directory, "formatted-rows.json");
  fs.writeFileSync(formattedRowsPath, JSON.stringify([OTS_ROW]), "utf8");
  const rideRows = [];

  const summary = await runOtsImportOnce({
    formattedRowsPath,
    runPipeline: false,
    appendRideRow: async (ride) => rideRows.push(ride),
    logger: createSilentLogger()
  });

  assert.equal(summary.imported, 1);
  assert.equal(summary.failed, 0);
  assert.equal(rideRows.length, 1);
  assert.equal(rideRows[0].refer, "OTS-1001");

  fs.rmSync(directory, { recursive: true, force: true });
});

test("runOtsImportOnce acknowledges a fully imported dispatch-managed OTS batch", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ots-import-ack-"));
  const formattedRowsPath = path.join(directory, "formatted-rows.json");
  fs.writeFileSync(formattedRowsPath, JSON.stringify([OTS_ROW]), "utf8");
  let acknowledgement = null;

  try {
    const summary = await runOtsImportOnce({
      projectPath: directory,
      formattedRowsPath,
      runPipeline: false,
      dispatchManagedPipeline: true,
      appendRideRow: async () => {},
      acknowledgeDispatchImport: async (projectPath, inputPath) => {
        acknowledgement = { projectPath, inputPath };
        return { code: 0 };
      },
      logger: createSilentLogger()
    });

    assert.equal(summary.imported, 1);
    assert.deepEqual(acknowledgement, { projectPath: directory, inputPath: formattedRowsPath });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("hasPendingDispatchImport only accepts the worker pending marker", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ots-pending-"));
  try {
    assert.equal(hasPendingDispatchImport(directory), false);
    fs.mkdirSync(path.join(directory, "output"));
    fs.writeFileSync(path.join(directory, "output", "pending_dispatch_import.json"), "{}", "utf8");
    assert.equal(hasPendingDispatchImport(directory), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("createOtsImportRunner reuses active import for concurrent manual ticks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ots-import-runner-"));
  const formattedRowsPath = path.join(directory, "formatted-rows.json");
  fs.writeFileSync(formattedRowsPath, JSON.stringify([OTS_ROW]), "utf8");
  let releaseAppend;
  const appendGate = new Promise((resolve) => {
    releaseAppend = resolve;
  });
  const rideRows = [];

  try {
    const runner = createOtsImportRunner({
      formattedRowsPath,
      runPipeline: false,
      appendRideRow: async (ride) => {
        rideRows.push(ride);
        await appendGate;
      },
      logger: createSilentLogger()
    });

    const firstTick = runner.tick();
    const secondTick = runner.tick();
    releaseAppend();
    const [firstSummary, secondSummary] = await Promise.all([firstTick, secondTick]);

    assert.equal(rideRows.length, 1);
    assert.deepEqual(firstSummary, secondSummary);
    assert.equal(firstSummary.imported, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
