const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_JOB_LINKER_CRITERIA,
  evaluateJob,
  evaluatePrebookJob,
  normalizeVehicle
} = require("../../src/jobLinker/criteria");
const {
  findLinkedRideOpportunities,
  haversineMiles,
  scoreLink
} = require("../../src/jobLinker/linker");
const {
  buildDemoPrebookJobs,
  detectNumericDateOrder,
  loadPrebookJobs,
  normalizePrebookRow,
  rowsToRecords
} = require("../../src/jobLinker/prebook");
const { prepareSourceJob } = require("../../src/jobLinker/repository");
const {
  loadWhatsAppSheetJobs,
  normalizeWhatsAppSheetRow
} = require("../../src/jobLinker/whatsappSheets");

function job(overrides = {}) {
  return {
    rideId: "OTS-001",
    sourceType: "OTS",
    pickup: "Heathrow Airport Terminal 5",
    dropOff: "Chelsea London SW3",
    fare: 120,
    requiredVehicle: "MPV",
    pickupAt: "2026-09-01T09:00:00.000Z",
    distance: 20,
    ...overrides
  };
}

const TEST_COORDINATES = Object.freeze({
  "Heathrow Airport Terminal 5": { lat: 51.47, lng: -0.4543 },
  "Heathrow Airport": { lat: 51.47, lng: -0.4543 },
  "Heathrow T2": { lat: 51.47, lng: -0.4543 },
  "Heathrow T3": { lat: 51.47, lng: -0.4543 },
  "Chelsea London SW3": { lat: 51.487, lng: -0.168 },
  "Chelsea SW3": { lat: 51.487, lng: -0.168 },
  "Gatwick Airport": { lat: 51.1537, lng: -0.1821 },
  "Gatwick North Terminal": { lat: 51.1537, lng: -0.1821 },
  "Manchester M1": { lat: 53.48, lng: -2.24 },
  "IP27 9FD": { lat: 52.36, lng: 0.55 },
  "NR30 4LU": { lat: 52.62, lng: 1.72 },
  "LE2 6FJ, Leicester": { lat: 52.6, lng: -1.1 },
  "LE15 6FD, Oakham": { lat: 52.67, lng: -0.73 },
  "Stansted Airport": { lat: 51.886, lng: 0.238 },
  "TA3 6PF, Taunton": { lat: 50.99, lng: -3.03 },
  "EX9 6QH, Budleigh Salterton": { lat: 50.63, lng: -3.32 },
  "SA2 0QB, Swansea": { lat: 51.62, lng: -3.98 },
  "BS4 5QG, Bristol": { lat: 51.43, lng: -2.54 },
  "Oadby, Leicester LE2": { lat: 52.6, lng: -1.08 },
  "Stratford-upon-Avon": { lat: 52.19, lng: -1.71 }
});

function routingOptions(extraCoordinates = {}) {
  const coordinates = { ...TEST_COORDINATES, ...extraCoordinates };
  const routeCalls = [];
  return {
    routeCalls,
    postcodeLookup: async (address) => coordinates[address] || null,
    geocoder: {
      geocodeAddress: async (address) => coordinates[address] || null
    },
    osrmClient: {
      getRouteFromOSRM: async (origin, destination) => {
        routeCalls.push({ origin, destination });
        const miles = haversineMiles(origin, destination) * 1.2;
        return {
          distance_meters: miles * 1609.344,
          duration_seconds: (miles / 50) * 3600
        };
      }
    }
  };
}

test("shared criteria accepts configured fare, UK area and normalized vehicle", () => {
  const result = evaluateJob(job(), DEFAULT_JOB_LINKER_CRITERIA);
  assert.equal(result.eligible, true);
  assert.equal(result.vehicle, "MPV");
});

test("shared criteria rejects low fares and wrong vehicle types", () => {
  const result = evaluateJob(job({ fare: 60, requiredVehicle: "Coach" }), DEFAULT_JOB_LINKER_CRITERIA);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.failedRules, ["fare_below_minimum", "vehicle_not_allowed"]);
});

test("vehicle aliases normalize to the three configured categories", () => {
  assert.equal(normalizeVehicle("8-Seater"), "MPV");
  assert.equal(normalizeVehicle("Estate Car"), "Saloon");
  assert.equal(normalizeVehicle("6 seat"), "6 Seater");
  assert.equal(normalizeVehicle("Executive People Carrier"), "MPV");
});

test("PreBook validation does not reject a confirmed job because of fare", () => {
  const result = evaluatePrebookJob(job({ sourceType: "PreBook", fare: 0 }));
  assert.equal(result.eligible, true);
});

test("linker finds a realistic same-vehicle return opportunity after PreBook", async () => {
  const anchor = job({
    rideId: "PRE-001",
    sourceType: "PreBook",
    pickupAt: "2026-09-01T09:00:00.000Z",
    pickup: "Heathrow Airport Terminal 5",
    dropOff: "Chelsea London SW3",
    distance: 18
  });
  const candidate = job({
    rideId: "OTS-002",
    pickupAt: "2026-09-01T12:00:00.000Z",
    pickup: "Chelsea SW3",
    dropOff: "Heathrow Airport",
    distance: 30
  });
  const link = await scoreLink(anchor, candidate, DEFAULT_JOB_LINKER_CRITERIA, routingOptions());
  assert.ok(link);
  assert.equal(link.direction, "after");
  assert.equal(link.firstRideId, "PRE-001");
  assert.equal(link.secondRideId, "OTS-002");
  assert.ok(link.score >= 90);
  assert.match(link.reason, /actual drop-to-pickup route/);
});

test("linker rejects wrong vehicles and impossible time gaps", async () => {
  const anchor = job({ rideId: "PRE-001", sourceType: "PreBook" });
  assert.equal(await scoreLink(anchor, job({ rideId: "OTS-WRONG", requiredVehicle: "Saloon" })), null);
  assert.equal(await scoreLink(anchor, job({ rideId: "OTS-LATE", pickupAt: "2026-09-04T15:00:00.000Z" })), null);
});

test("linker compares only the supplied PreBook anchors and sorts strongest match first", async () => {
  const anchors = [job({ rideId: "PRE-001", sourceType: "PreBook" })];
  const candidates = [
    job({ rideId: "OTS-FAR", pickupAt: "2026-09-01T12:00:00.000Z", pickup: "Manchester M1", dropOff: "Heathrow Airport" }),
    job({ rideId: "OTS-CLOSE", pickupAt: "2026-09-01T12:00:00.000Z", pickup: "Chelsea SW3", dropOff: "Heathrow Airport" })
  ];
  const links = await findLinkedRideOpportunities(
    anchors,
    candidates,
    DEFAULT_JOB_LINKER_CRITERIA,
    routingOptions()
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].candidateRideId, "OTS-CLOSE");
});

test("linker rejects Gatwick to Oadby followed by Heathrow to Stratford using actual endpoints", async () => {
  const anchor = job({
    rideId: "PRE-OADBY",
    sourceType: "PreBook",
    pickup: "Gatwick North Terminal",
    dropOff: "Oadby, Leicester LE2",
    pickupAt: "2026-09-01T08:00:00.000Z",
    distance: 120,
    requiredVehicle: "Saloon"
  });
  const candidate = job({
    rideId: "OTS-STRATFORD",
    pickup: "Heathrow T2",
    dropOff: "Stratford-upon-Avon",
    pickupAt: "2026-09-01T15:00:00.000Z",
    requiredVehicle: "Saloon"
  });
  const routing = routingOptions();
  const link = await scoreLink(anchor, candidate, DEFAULT_JOB_LINKER_CRITERIA, routing);
  assert.equal(link, null);
  assert.equal(routing.routeCalls.some((call) =>
    call.origin.lat === TEST_COORDINATES["Oadby, Leicester LE2"].lat &&
    call.destination.lat === TEST_COORDINATES["Heathrow T2"].lat
  ), true);
  assert.equal(routing.routeCalls.some((call) =>
    call.origin.lat === TEST_COORDINATES["Gatwick North Terminal"].lat &&
    call.destination.lat === TEST_COORDINATES["Heathrow T2"].lat
  ), false);
});

test("linker accepts the four realistic airport return chains", async () => {
  const examples = [
    {
      id: "A",
      first: ["Heathrow Airport", "IP27 9FD", "2026-09-03T05:20:00.000Z"],
      second: ["NR30 4LU", "Heathrow Airport", "2026-09-03T10:15:00.000Z"]
    },
    {
      id: "B",
      first: ["Gatwick North Terminal", "LE2 6FJ, Leicester", "2026-09-04T23:35:00.000Z"],
      second: ["LE15 6FD, Oakham", "Stansted Airport", "2026-09-05T06:30:00.000Z"]
    },
    {
      id: "C",
      first: ["Gatwick North Terminal", "TA3 6PF, Taunton", "2026-09-05T22:00:00.000Z"],
      second: ["EX9 6QH, Budleigh Salterton", "Heathrow T2", "2026-09-06T03:30:00.000Z"]
    },
    {
      id: "D",
      first: ["Heathrow T3", "SA2 0QB, Swansea", "2026-08-29T21:15:00.000Z"],
      second: ["BS4 5QG, Bristol", "Heathrow Airport", "2026-08-30T05:45:00.000Z"]
    }
  ];

  for (const example of examples) {
    const anchor = job({
      rideId: `PRE-${example.id}`,
      sourceType: "PreBook",
      pickup: example.first[0],
      dropOff: example.first[1],
      pickupAt: example.first[2],
      requiredVehicle: "Saloon"
    });
    const candidate = job({
      rideId: `OTS-${example.id}`,
      pickup: example.second[0],
      dropOff: example.second[1],
      pickupAt: example.second[2],
      requiredVehicle: "Saloon"
    });
    const link = await scoreLink(anchor, candidate, DEFAULT_JOB_LINKER_CRITERIA, routingOptions());
    assert.ok(link, `example ${example.id} should link`);
    assert.equal(link.previousDrop, example.first[1]);
    assert.equal(link.nextPickup, example.second[0]);
    assert.ok(link.distanceMiles <= 90);
    assert.ok(link.scoreBreakdown.returnDirection >= 14);
  }
});

test("PreBook rows normalize flexible sheet headers and demo fallback stays usable", () => {
  const records = rowsToRecords([
    ["Job ID", "Pickup Date", "Pickup Time", "From", "To", "Price", "Car"],
    ["PB-99", "1 Sep 2026", "10:00", "LHR", "Chelsea SW3", "95", "Saloon"]
  ]);
  const normalized = normalizePrebookRow(records[0], 0, { timeZone: "Europe/London" });
  assert.equal(normalized.rideId, "PB-99");
  assert.equal(normalized.pickup, "LHR");
  assert.ok(normalized.pickupAt);

  const demo = buildDemoPrebookJobs(new Date("2026-08-30T12:00:00.000Z"));
  assert.equal(demo.length, 2);
  assert.equal(demo.every((entry) => entry.isDemo), true);
});

test("PreBook uses OTS Booking ID as the business reference instead of internal ACE ID", () => {
  const normalized = normalizePrebookRow({
    "Booking ID": " OTS-05092026-12345-1 ",
    "ACE ID": "ACE 050926-1910",
    Date: "05/09/2026",
    Time: "19:10",
    Pickup: "Gatwick Airport",
    "Drop-off": "Heathrow Airport",
    Vehicle: "Saloon Car",
    "Booking Status": "Active"
  });
  assert.equal(normalized.rideId, "OTS-05092026-12345-1");
  assert.equal(normalized.refer, "OTS-05092026-12345-1");
});

test("PreBook infers month-first numeric sheet dates without corrupting ambiguous rows", () => {
  const rows = [
    { "Booking ID": "PB-1", Date: "8/29/2026", Time: "22:15", Pickup: "LHR", "Drop-off": "SA2 0QB", Vehicle: "MPV" },
    { "Booking ID": "PB-2", Date: "9/3/2026", Time: "06:20", Pickup: "LHR", "Drop-off": "IP27 9FD", Vehicle: "MPV" }
  ];
  const order = detectNumericDateOrder(rows);
  const normalized = normalizePrebookRow(rows[1], 1, {
    timeZone: "Europe/London",
    numericDateOrder: order
  });
  assert.equal(order, "mdy");
  assert.match(normalized.pickupAt, /^2026-09-03T05:20:00/);
});

test("PreBook loader supports the client Bookings sheet and excludes cancelled or expired jobs", async () => {
  const values = [
    ["Booking ID", "Date", "Time", "Pickup", "Drop-off", "Vehicle", "Discounted Fare", "Miles", "Booking Status"],
    ["ACE-101", "2 Sep 2026", "10:00", "LHR", "Chelsea SW3", "MPV", "125", "19", "Active"],
    ["ACE-102", "2 Sep 2026", "11:00", "LGW", "Reading RG1", "Saloon", "95", "45", "Cancelled"],
    ["ACE-OLD", "1 Aug 2026", "10:00", "LHR", "Chelsea", "MPV", "120", "19", "Active"]
  ];
  const sheetsClient = { spreadsheets:{ values:{ get: async () => ({ data:{ values } }) } } };
  const result = await loadPrebookJobs({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Bookings",
    now: new Date("2026-08-31T12:00:00.000Z"),
    expireAfterPickupHours: 12
  });
  assert.equal(result.mode, "sheet");
  assert.deepEqual(result.jobs.map((entry) => entry.rideId), ["ACE-101"]);
  assert.equal(result.jobs[0].dropOff, "Chelsea SW3");
  assert.equal(result.jobs[0].fare, "125");
  assert.equal(result.jobs[0].distance, "19");
});

test("source import keeps only formula-eligible jobs inside the retention window", () => {
  const source = {
    refer: "OTS-LIVE-1",
    pickup_day_date: "Tuesday 1st September 2026",
    starting_timing: "10:00",
    pickup: "Heathrow Airport Terminal 5",
    drop_off: "Chelsea SW3",
    fare: 120,
    required_vehicle: "MPV"
  };
  const prepared = prepareSourceJob(
    source,
    "OTS",
    DEFAULT_JOB_LINKER_CRITERIA,
    new Date("2026-08-30T12:00:00.000Z")
  );
  assert.equal(prepared.rideId, "OTS-LIVE-1");
  assert.equal(prepared.sourceType, "OTS");

  const offerExpiry = prepareSourceJob(
    { ...source, source_expires_at: "2026-08-30T13:00:00.000Z" },
    "OTS",
    DEFAULT_JOB_LINKER_CRITERIA,
    new Date("2026-08-30T12:00:00.000Z")
  );
  assert.equal(offerExpiry.expiresAt, "2026-08-30T13:00:00.000Z");
  assert.equal(prepareSourceJob(
    { ...source, source_expires_at: "2026-08-30T11:00:00.000Z" },
    "OTS",
    DEFAULT_JOB_LINKER_CRITERIA,
    new Date("2026-08-30T12:00:00.000Z")
  ), null);

  assert.equal(prepareSourceJob({ ...source, fare: 60 }, "OTS", DEFAULT_JOB_LINKER_CRITERIA), null);
  assert.equal(
    prepareSourceJob(source, "OTS", DEFAULT_JOB_LINKER_CRITERIA, new Date("2026-09-02T00:00:00.000Z")),
    null
  );
});

test("WhatsApp Saloon and MPV sheets normalize into stable vehicle-specific jobs", async () => {
  const saloonValues = [
    ["Source Name", "Source Time", "Pickup Day & Date", "Starting Timing", "Pickup", "Drop Off", "Distance", "Fare", "Required Vehicle", "Payment Status"],
    ["Jetset Rides", "07:59", "Tuesday 1st September 2026", "09:00", "LU2", "LCY", "30", "95", "Any Car", ""]
  ];
  const mpvValues = [
    saloonValues[0],
    ["Empire Transfers", "08:10", "Tuesday 1st September 2026", "12:00", "LHR", "Chelsea SW3", "19", "120", "8 Seater", "Same Day"]
  ];
  const sheetsClient = {
    spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [
      { values: saloonValues },
      { values: mpvValues }
    ] } }) } }
  };
  const result = await loadWhatsAppSheetJobs({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetNames: ["Saloon", "MPV"],
    now: new Date("2026-08-31T12:00:00.000Z"),
    expireAfterPickupHours: 12
  });
  assert.equal(result.mode, "sheet");
  assert.equal(result.jobs.length, 2);
  assert.deepEqual(result.jobs.map((job) => job.required_vehicle), ["Saloon", "MPV"]);
  assert.equal(result.jobs.every((job) => job.refer.startsWith("WA-SHEET-")), true);

  const repeated = normalizeWhatsAppSheetRow(
    Object.fromEntries(saloonValues[0].map((header, index) => [header, saloonValues[1][index]])),
    "Saloon"
  );
  assert.equal(repeated.refer, result.jobs[0].refer);
});
