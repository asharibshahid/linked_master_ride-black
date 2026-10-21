const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAutoBidSettings,
  canonicalVehicle,
  evaluateAutoBidJob,
  buildAutoBidPreview,
  createJobLinkerAutoBidRunner
} = require("../../src/jobLinker/autoBid");

const now = new Date("2026-09-15T12:00:00Z");

function job(overrides = {}) {
  return {
    rideId: "OTS-1",
    sourceType: "OTS",
    pickupAt: "2026-09-16T10:00:00Z",
    expiresAt: "2026-09-15T15:00:00Z",
    distance: "70 mi",
    requiredVehicle: "Saloon Car",
    guidePriceMax: 120,
    ...overrides
  };
}

test("Auto Bid defaults remain safely off", () => {
  const settings = normalizeAutoBidSettings({});
  assert.equal(settings.enabled, false);
  assert.equal(settings.minimumMiles, 70);
  assert.equal(settings.priceDeduction, 5);
  assert.deepEqual(settings.allowedVehicles, ["Saloon Car", "People Carrier", "8 Seater Minibus"]);
});

test("blank numeric settings use safe defaults while an explicit zero deduction remains valid", () => {
  assert.equal(normalizeAutoBidSettings({ priceDeduction: "" }).priceDeduction, 5);
  assert.equal(normalizeAutoBidSettings({ priceDeduction: 0 }).priceDeduction, 0);
});

test("legacy and provider vehicle labels normalize to the seven OTS categories", () => {
  assert.equal(canonicalVehicle("Saloon"), "Saloon Car");
  assert.equal(canonicalVehicle("MPV"), "People Carrier");
  assert.equal(canonicalVehicle("Executive People Carrier"), "Executive People Carrier");
  assert.equal(canonicalVehicle("Fleet Bus"), "Fleet Bus");
});

test("eligible tomorrow job uses OTS maximum minus configured deduction", () => {
  const result = evaluateAutoBidJob(job(), {
    enabled: true,
    minimumMiles: 70,
    priceDeduction: 5,
    minimumExpiryMinutes: 10,
    allowedVehicles: ["Saloon Car"]
  }, { now, timeZone: "Europe/London" });
  assert.equal(result.eligible, true);
  assert.equal(result.amount, 115);
});

test("Auto Bid rejects today, low mileage, disabled vehicles, missing guide max and near expiry", () => {
  const settings = { enabled: true, minimumMiles: 70, priceDeduction: 5, minimumExpiryMinutes: 10, allowedVehicles: ["Saloon Car"] };
  assert.match(evaluateAutoBidJob(job({ pickupAt: "2026-09-15T18:00:00Z" }), settings, { now }).reason, /Outside selected/);
  assert.match(evaluateAutoBidJob(job({ distance: "69 mi" }), settings, { now }).reason, /Below/);
  assert.match(evaluateAutoBidJob(job({ requiredVehicle: "Estate Car" }), settings, { now }).reason, /disabled/);
  assert.match(evaluateAutoBidJob(job({ guidePriceMax: null }), settings, { now }).reason, /maximum missing/);
  assert.match(evaluateAutoBidJob(job({ expiresAt: "2026-09-15T12:05:00Z" }), settings, { now }).reason, /before expiry/);
});

test("date scopes use UK dates and support current-month exclusions, future, next month and custom ranges", () => {
  const base = { enabled: true, minimumMiles: 70, priceDeduction: 5, minimumExpiryMinutes: 10, allowedVehicles: ["Saloon Car"] };
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-15T18:00:00Z" }), { ...base, dateScope: "today" }, { now }).eligible, true);
  assert.equal(normalizeAutoBidSettings({ dateScope: "futureExcludingTodayTomorrow" }).dateScope, "futureExcludingTodayTomorrow");
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-15T18:00:00Z" }), { ...base, dateScope: "futureExcludingTodayTomorrow" }, { now }).eligible, false);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-16T18:00:00Z" }), { ...base, dateScope: "futureExcludingTodayTomorrow" }, { now }).eligible, false);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-17T10:00:00Z" }), { ...base, dateScope: "futureExcludingTodayTomorrow" }, { now }).eligible, true);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-10-05T10:00:00Z" }), { ...base, dateScope: "futureExcludingTodayTomorrow" }, { now }).eligible, true);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-29T10:00:00Z" }), { ...base, dateScope: "currentMonth" }, { now }).eligible, true);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-15T18:00:00Z" }), { ...base, dateScope: "currentMonthExcludingTodayTomorrow" }, { now }).eligible, false);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-16T18:00:00Z" }), { ...base, dateScope: "currentMonthExcludingTodayTomorrow" }, { now }).eligible, false);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-17T10:00:00Z" }), { ...base, dateScope: "currentMonthExcludingTodayTomorrow" }, { now }).eligible, true);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-10-01T10:00:00Z" }), { ...base, dateScope: "currentMonthExcludingTodayTomorrow" }, { now }).eligible, false);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-10-05T10:00:00Z" }), { ...base, dateScope: "futureMonths" }, { now }).eligible, true);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-10-05T10:00:00Z" }), { ...base, dateScope: "nextMonth" }, { now }).eligible, true);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-11-05T10:00:00Z" }), { ...base, dateScope: "nextMonth" }, { now }).eligible, false);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-11-05T10:00:00Z" }), { ...base, dateScope: "custom", dateFrom: "2026-11-01", dateTo: "2026-11-10" }, { now }).eligible, true);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-11-05T10:00:00Z" }), { ...base, dateScope: "customFrom", dateFrom: "2026-09-29" }, { now }).eligible, true);
  assert.equal(evaluateAutoBidJob(job({ pickupAt: "2026-09-28T10:00:00Z" }), { ...base, dateScope: "customFrom", dateFrom: "2026-09-29" }, { now }).eligible, false);
});

test("preview never retries a ride with any persisted bid history", () => {
  const result = buildAutoBidPreview([job()], [{ rideId: "OTS-1", bidStatus: "Submission Failed" }], {
    enabled: true,
    allowedVehicles: ["Saloon Car"]
  }, { now });
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.reasons["Existing bid"], 1);
});

test("runner reserves one Auto Bid through the existing bid service", async () => {
  const calls = [];
  const settings = { enabled: true, minimumMiles: 70, priceDeduction: 5, minimumExpiryMinutes: 10, allowedVehicles: ["Saloon Car"] };
  const runner = createJobLinkerAutoBidRunner({
    repository: {
      getAutoBidSettings: async () => settings,
      saveAutoBidSettings: async () => settings,
      listJobs: async () => [job()],
      listBids: async () => []
    },
    bidService: {
      isBusy: () => false,
      submitManualBid: async (value) => { calls.push(value); return { bid: { rideId: value.rideId } }; }
    },
    getSourceStatus: () => ({ otsSourceComplete: true, otsLastError: "", otsLastSyncAt: new Date().toISOString() }),
    now: () => now,
    intervalMs: 60_000
  });
  const result = await runner.tick();
  assert.equal(result.submitted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bidAmount, 115);
  assert.equal(calls[0].automated, true);
  assert.equal(calls[0].bidType, "Job Linker Auto Bid");
  runner.stop();
});

test("runner pauses when OTS inventory is not fresh and complete", async () => {
  let submitted = false;
  const runner = createJobLinkerAutoBidRunner({
    repository: {
      getAutoBidSettings: async () => ({ enabled: true, allowedVehicles: ["Saloon Car"] }),
      saveAutoBidSettings: async () => ({}),
      listJobs: async () => [job()],
      listBids: async () => []
    },
    bidService: { isBusy: () => false, submitManualBid: async () => { submitted = true; } },
    getSourceStatus: () => ({ otsSourceComplete: false, otsLastSyncAt: now.toISOString() }),
    now: () => now
  });
  const result = await runner.tick();
  assert.equal(result.submitted, false);
  assert.match(result.reason, /not fresh and complete/);
  assert.equal(submitted, false);
  runner.stop();
});

test("runner does not queue a second job while V2 bid service is busy", async () => {
  let submitted = false;
  const runner = createJobLinkerAutoBidRunner({
    repository: {
      getAutoBidSettings: async () => ({ enabled: true, allowedVehicles: ["Saloon Car"] }),
      saveAutoBidSettings: async () => ({}),
      listJobs: async () => [job()],
      listBids: async () => []
    },
    bidService: { isBusy: () => true, submitManualBid: async () => { submitted = true; } },
    getSourceStatus: () => ({ otsSourceComplete: true, otsLastSyncAt: new Date().toISOString() }),
    now: () => now
  });
  const result = await runner.tick();
  assert.equal(result.submitted, false);
  assert.equal(submitted, false);
  runner.stop();
});

test("runner status names the selected scope instead of always saying tomorrow", async () => {
  const runner = createJobLinkerAutoBidRunner({
    repository: {
      getAutoBidSettings: async () => ({ enabled: true, dateScope: "futureMonths", allowedVehicles: ["Saloon Car"] }),
      saveAutoBidSettings: async () => ({}),
      listJobs: async () => [],
      listBids: async () => []
    },
    bidService: { isBusy: () => false, submitManualBid: async () => { throw new Error("must not submit"); } },
    getSourceStatus: () => ({ otsSourceComplete: true, otsLastError: "", otsLastSyncAt: new Date().toISOString() }),
    now: () => now
  });
  const result = await runner.tick();
  assert.equal(result.reason, "No eligible jobs for future months");
  runner.stop();
});

test("runner aborts an old-scope candidate when settings change during evaluation", async () => {
  let reads = 0;
  let submitted = false;
  const runner = createJobLinkerAutoBidRunner({
    repository: {
      getAutoBidSettings: async () => {
        reads += 1;
        return reads === 1
          ? { enabled: true, dateScope: "currentMonth", minimumMiles: 70, allowedVehicles: ["Saloon Car"] }
          : { enabled: true, dateScope: "futureMonths", minimumMiles: 70, allowedVehicles: ["Saloon Car"] };
      },
      saveAutoBidSettings: async () => ({}),
      listJobs: async () => [job({ pickupAt: "2026-09-20T10:00:00Z" })],
      listBids: async () => []
    },
    bidService: { isBusy: () => false, submitManualBid: async () => { submitted = true; } },
    getSourceStatus: () => ({ otsSourceComplete: true, otsLastError: "", otsLastSyncAt: new Date().toISOString() }),
    now: () => now
  });
  const result = await runner.tick();
  assert.equal(result.submitted, false);
  assert.match(result.reason, /rules changed/);
  assert.equal(submitted, false);
  runner.stop();
});
