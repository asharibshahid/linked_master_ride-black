const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_JOB_LINKER_CRITERIA,
  evaluateJob,
  evaluatePrebookJob,
  normalizeVehicle
} = require("../../src/jobLinker/criteria");
const {
  createRoutingResolver,
  findLinkedRideOpportunities,
  findPossibleReturnOpportunities,
  haversineMiles,
  isStrictAirportReturnPattern,
  scoreLink
} = require("../../src/jobLinker/linker");
const { createJobLinkerService } = require("../../src/jobLinker/service");
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

test("complete empty OTS inventory is allowed to reconcile stale Master jobs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/jobLinker/otsMaster.js"), "utf8");
  assert.match(source, /const removed = sourceComplete && typeof options\.repository\.expireMissingOtsJobs/);
  assert.doesNotMatch(source, /sourceComplete && rows\.length > 0/);
});

test("OTS Master exposes added, updated and removed sync counts", () => {
  const master = fs.readFileSync(path.join(__dirname, "../../src/jobLinker/otsMaster.js"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "../../src/jobLinker/service.js"), "utf8");
  const repository = fs.readFileSync(path.join(__dirname, "../../src/jobLinker/repository.js"), "utf8");
  assert.match(repository, /let added = 0/);
  assert.match(repository, /returning \(xmax = '0'::xid\) as inserted/);
  assert.match(master, /added: imported\.added \|\| 0/);
  assert.match(master, /updated: imported\.updated \|\| 0/);
  assert.match(service, /otsRowsAdded: 0/);
  assert.match(service, /state\.otsRowsRemoved = ots\.removed \|\| 0/);
  assert.match(repository, /guide_price_min = coalesce\(excluded\.guide_price_min, rides\.guide_price_min\)/);
  assert.match(repository, /guide_price_max = coalesce\(excluded\.guide_price_max, rides\.guide_price_max\)/);
  assert.match(repository, /guide_price_text = coalesce\(nullif\(excluded\.guide_price_text, ''\), rides\.guide_price_text\)/);
});

test("fresh completed source sync immediately wakes Auto Bid evaluation", () => {
  const service = fs.readFileSync(path.join(__dirname, "../../src/jobLinker/service.js"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../../src/app.js"), "utf8");
  assert.match(service, /typeof options\.onSyncComplete === "function"/);
  assert.match(service, /options\.onSyncComplete\(\{ \.\.\.state \}\)/);
  assert.match(app, /onSyncComplete: \(\) => jobLinkerAutoBidRunnerRef\?\.tick\?\.\(\)/);
});

const TEST_COORDINATES = Object.freeze({
  "Heathrow Airport Terminal 5": { lat: 51.47, lng: -0.4543 },
  "Heathrow Airport": { lat: 51.47, lng: -0.4543 },
  "Heathrow T2": { lat: 51.47, lng: -0.4543 },
  "Heathrow T3": { lat: 51.47, lng: -0.4543 },
  "Chelsea London SW3": { lat: 51.487, lng: -0.168 },
  "Chelsea SW3": { lat: 51.487, lng: -0.168 },
  "Fulham SW6": { lat: 51.474, lng: -0.2 },
  "Reading RG1": { lat: 51.455, lng: -0.969 },
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
  "PE33 9LE, King's Lynn": { lat: 52.65, lng: 0.54 },
  "LN5 0TT, Lincoln": { lat: 53.12, lng: -0.52 },
  "LE2 8FA, Leicester": { lat: 52.6, lng: -1.1 },
  "NG2 5HX, Nottingham": { lat: 52.92, lng: -1.13 },
  "SO16 6BD, Southampton": { lat: 50.93, lng: -1.43 },
  "IP28 8EZ": { lat: 52.34, lng: 0.53 },
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

test("Linker matches next-morning confirmed PreBook return without losing live OTS candidates", async () => {
  const outbound = normalizePrebookRow({
    "Booking ID": "PB-OUTBOUND",
    Date: "Thursday 8th Oct 2026",
    Time: "12/30/1899",
    Pickup: "Heathrow Airport, Terminal 4",
    "Drop-off": "Ipplepen, Newton Abbot, TQ12 5SE",
    Vehicle: "Saloon Car (1 Persons)"
  }, 0, { rawTime: 0.75 });
  const bookedReturn = normalizePrebookRow({
    "Booking ID": "PB-RETURN",
    Date: "9/10/2026",
    Time: "5:30",
    Pickup: "Linhay Lane, Plymouth, PL9 7FL",
    "Drop-off": "Heathrow Airport, Terminal 3",
    Vehicle: "Saloon Car"
  }, 1);
  const otsReturn = job({
    rideId: "OTS-RETURN",
    pickupAt: bookedReturn.pickupAt,
    pickup: bookedReturn.pickup,
    dropOff: bookedReturn.dropOff,
    fare: 180,
    requiredVehicle: "Saloon Car"
  });
  const routing = createRoutingResolver(routingOptions({
    [outbound.dropOff]: { lat: 50.49, lng: -3.65 },
    [bookedReturn.pickup]: { lat: 50.35, lng: -4.11 }
  }));
  assert.equal(outbound.pickupAt, "2026-10-08T17:00:00.000Z");
  assert.equal(bookedReturn.pickupAt, "2026-10-09T04:30:00.000Z");
  const criteria = { ...DEFAULT_JOB_LINKER_CRITERIA, maxLinkGapHours: 12 };
  const savedLinks = [];
  const repository = {
    listJobs: async () => [outbound, bookedReturn, otsReturn],
    replaceLinks: async (links) => { savedLinks.push(...links); }
  };
  const service = createJobLinkerService({ repository, routingResolver: routing, now: () => new Date("2026-10-08T12:00:00.000Z") });
  const links = await service.refreshLinks(criteria);
  assert.equal(links.length, 2);
  assert.deepEqual(new Set(links.map((link) => link.candidateSource)), new Set(["PreBook", "OTS"]));
  assert.ok(links.every((link) => link.anchorRideId === outbound.rideId));
  assert.ok(links.every((link) => link.candidateRideId !== link.anchorRideId));
  assert.equal(savedLinks.length, 2);
  assert.equal(await scoreLink(outbound, bookedReturn, { ...criteria, maxLinkGapHours: 4 }, { resolver: routing }), null);
});

test("Linker does not propose a return whose pickup has already passed", async () => {
  const anchor = job({ rideId: "PRE-PAST", sourceType: "PreBook", pickup: "Heathrow Airport", dropOff: "Chelsea SW3", pickupAt: "2026-10-08T09:00:00.000Z", requiredVehicle: "Saloon" });
  const candidate = job({ rideId: "OTS-PAST", pickup: "Chelsea SW3", dropOff: "Heathrow Airport", pickupAt: "2026-10-08T13:00:00.000Z", requiredVehicle: "Saloon" });
  const writes = [];
  const repository = { listJobs: async () => [anchor, candidate], replaceLinks: async (links) => writes.push(links) };
  const service = createJobLinkerService({ repository, routingResolver: createRoutingResolver(routingOptions()), now: () => new Date("2026-10-08T14:00:00.000Z") });
  assert.deepEqual(await service.refreshLinks(DEFAULT_JOB_LINKER_CRITERIA), []);
  assert.deepEqual(writes, [[]]);
});

test("Linker criteria do not expire incomplete upcoming sheet rows from Groups", async () => {
  const expired = [];
  const repository = {
    listJobs: async () => [
      job({ rideId: "RID-SHEET", sourceType: "WhatsApp", groupName: "WhatsApp Sheet: Upcoming Jobs >79", fare: null, pickupAt: "2026-10-13T10:00:00.000Z" }),
      job({ rideId: "RID-DIRECT", sourceType: "WhatsApp", groupName: "Direct", fare: null, pickupAt: "2026-10-13T10:00:00.000Z" })
    ],
    expireSourceJobs: async (ids) => expired.push(...ids),
    replaceLinks: async () => {}
  };
  const service = createJobLinkerService({ repository, now: () => new Date("2026-10-12T12:00:00.000Z") });
  await service.refreshLinks(DEFAULT_JOB_LINKER_CRITERIA);
  assert.deepEqual(expired, ["RID-DIRECT"]);
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
  assert.equal(routing.routeCalls.length, 0, "wrong-direction pairs must fail before route scoring");
});

test("Linker exposes only true airport-return rides as review-only suggestions", async () => {
  const anchor = job({
    rideId: "PRE-REVIEW",
    sourceType: "PreBook",
    pickup: "Heathrow Airport",
    dropOff: "Chelsea SW3",
    pickupAt: "2026-09-01T08:00:00.000Z",
    requiredVehicle: "Saloon"
  });
  const candidate = job({
    rideId: "OTS-REVIEW",
    pickup: "Chelsea SW3",
    dropOff: "Heathrow Airport",
    pickupAt: "2026-09-01T20:00:00.000Z",
    requiredVehicle: "Saloon"
  });
  const routing = routingOptions();
  assert.equal(await scoreLink(anchor, candidate, DEFAULT_JOB_LINKER_CRITERIA, routing), null);
  const possible = await findPossibleReturnOpportunities([anchor], [candidate], DEFAULT_JOB_LINKER_CRITERIA, routing);
  assert.equal(possible.length, 1);
  assert.equal(possible[0].reviewOnly, true);
  assert.match(possible[0].reason, /review only/);
  assert.match(possible[0].reason, /post-ride wait exceeds/);
});

test("Linker never reviews an outward airport pickup after an outbound ride", async () => {
  const anchor = job({
    rideId: "PRE-FROME",
    sourceType: "PreBook",
    pickup: "Heathrow Airport Terminal 4",
    dropOff: "Frome BA11 3DB",
    pickupAt: "2026-10-28T19:20:00.000Z",
    requiredVehicle: "Saloon"
  });
  const irrelevant = job({
    rideId: "OTS-RUGBY",
    pickup: "Heathrow Airport Terminal 2",
    dropOff: "Rugby CV22 7NW",
    pickupAt: "2026-10-29T09:10:00.000Z",
    requiredVehicle: "Saloon"
  });
  const routing = routingOptions();
  assert.deepEqual(
    await findPossibleReturnOpportunities([anchor], [irrelevant], DEFAULT_JOB_LINKER_CRITERIA, routing),
    []
  );
  assert.equal(routing.routeCalls.length, 0);
});

test("Linker bounds review-only route checks", async () => {
  const anchor = job({ rideId: "PRE-BOUNDED", sourceType: "PreBook", requiredVehicle: "Saloon" });
  const candidates = Array.from({ length: 40 }, (_, index) => job({
    rideId: `OTS-BOUNDED-${index}`,
    requiredVehicle: "Saloon",
    pickupAt: new Date(Date.parse("2026-09-01T09:00:00.000Z") + (index + 2) * 3600000).toISOString(),
    pickup: "Chelsea SW3",
    dropOff: "Manchester M1"
  }));
  const routing = routingOptions();
  await findPossibleReturnOpportunities([anchor], candidates, DEFAULT_JOB_LINKER_CRITERIA, routing);
  assert.ok(routing.routeCalls.length <= 48, "review-only fallback must stay bounded");
});

test("Linker reviews nearby OTS returns even when earlier distant WhatsApp jobs fill the time list", async () => {
  const anchor = job({
    rideId: "PRE-LOCATION",
    sourceType: "PreBook",
    pickup: "Heathrow Airport",
    dropOff: "Chelsea SW3",
    requiredVehicle: "Saloon"
  });
  const distant = Array.from({ length: 30 }, (_, index) => job({
    rideId: `WA-DISTANT-${index}`,
    sourceType: "WhatsApp",
    pickup: "Reading RG1",
    dropOff: "Heathrow Airport",
    pickupAt: "2026-09-01T11:00:00.000Z",
    requiredVehicle: "Saloon"
  }));
  const nearby = job({
    rideId: "OTS-NEARBY",
    pickup: "Fulham SW6",
    dropOff: "Heathrow Airport",
    pickupAt: "2026-09-01T20:00:00.000Z",
    requiredVehicle: "Saloon"
  });
  const locationRouting = routingOptions({
    "Fulham SW6": TEST_COORDINATES["Fulham SW6"]
  });
  const possible = await findPossibleReturnOpportunities(
    [anchor],
    [...distant, nearby],
    DEFAULT_JOB_LINKER_CRITERIA,
    locationRouting
  );
  assert.ok(possible.some((link) => link.candidateRideId === "OTS-NEARBY"));
});

test("Groups sheet jobs can anchor a later OTS airport return", async () => {
  const groupAnchor = job({
    rideId: "GROUP-OUTBOUND",
    sourceType: "WhatsApp",
    groupName: "WhatsApp Sheet: Upcoming Jobs >79",
    pickup: "Heathrow Airport",
    dropOff: "Chelsea SW3",
    pickupAt: "2026-09-01T09:00:00.000Z",
    requiredVehicle: "MPV"
  });
  const otsReturn = job({
    rideId: "OTS-GROUP-RETURN",
    sourceType: "OTS",
    pickup: "Chelsea SW3",
    dropOff: "Heathrow Airport",
    pickupAt: "2026-09-01T12:00:00.000Z",
    requiredVehicle: "MPV"
  });
  const repository = {
    listJobs: async () => [groupAnchor, otsReturn],
    replaceLinks: async (links) => links
  };
  const service = createJobLinkerService({
    repository,
    routingResolver: createRoutingResolver(routingOptions()),
    now: () => new Date("2026-09-01T08:00:00.000Z")
  });
  const links = await service.refreshLinks(DEFAULT_JOB_LINKER_CRITERIA);
  assert.equal(links.length, 1);
  assert.equal(links[0].anchorRideId, "GROUP-OUTBOUND");
  assert.equal(links[0].candidateRideId, "OTS-GROUP-RETURN");
  assert.equal(service.state.possibleLinkCount, 0);
});

test("Possible returns remain available when another pair has a strict link", async () => {
  const strictAnchor = job({
    rideId: "PRE-STRICT",
    sourceType: "PreBook",
    pickup: "Heathrow Airport",
    dropOff: "Chelsea SW3",
    pickupAt: "2026-09-01T09:00:00.000Z",
    requiredVehicle: "Saloon"
  });
  const strictReturn = job({
    rideId: "OTS-STRICT",
    pickup: "Chelsea SW3",
    dropOff: "Heathrow Airport",
    pickupAt: "2026-09-01T12:00:00.000Z",
    requiredVehicle: "Saloon"
  });
  const reviewAnchor = job({
    rideId: "PRE-REVIEW-WAIT",
    sourceType: "PreBook",
    pickup: "Heathrow Airport",
    dropOff: "Reading RG1",
    pickupAt: "2026-09-01T09:00:00.000Z",
    requiredVehicle: "MPV"
  });
  const reviewReturn = job({
    rideId: "OTS-REVIEW-WAIT",
    pickup: "Reading RG1",
    dropOff: "Heathrow Airport",
    pickupAt: "2026-09-01T20:00:00.000Z",
    requiredVehicle: "MPV"
  });
  let savedLinks = [];
  const repository = {
    listJobs: async () => [strictAnchor, strictReturn, reviewAnchor, reviewReturn],
    replaceLinks: async (links) => { savedLinks = links; },
    listLinks: async () => savedLinks.filter((link) => !link.reviewOnly),
    listReviewLinks: async () => savedLinks.filter((link) => link.reviewOnly)
  };
  const service = createJobLinkerService({
    repository,
    routingResolver: createRoutingResolver(routingOptions()),
    now: () => new Date("2026-09-01T08:00:00.000Z")
  });
  const links = await service.refreshLinks(DEFAULT_JOB_LINKER_CRITERIA);
  assert.ok(links.some((link) => link.candidateRideId === "OTS-STRICT"));
  assert.ok(service.state.possibleLinks.some((link) => link.candidateRideId === "OTS-REVIEW-WAIT"));
  assert.ok(savedLinks.some((link) => link.reviewOnly && link.linkId.startsWith("POSSIBLE-")));
});

test("possible return archive and unarchive refresh persisted review state without recomputing links", async () => {
  let stored = [];
  const repository = {
    archiveLink: async (linkId) => ({ ok: linkId === "POSSIBLE-1", linkId }),
    unarchiveLink: async (linkId) => ({ ok: linkId === "POSSIBLE-1", linkId }),
    listReviewLinks: async () => stored
  };
  const service = createJobLinkerService({ repository });
  service.state.possibleLinks = [{ linkId: "POSSIBLE-1" }];
  service.state.possibleLinkCount = 1;

  assert.equal((await service.archiveLink("POSSIBLE-1")).ok, true);
  assert.deepEqual(service.state.possibleLinks, []);
  assert.equal(service.state.possibleLinkCount, 0);

  stored = [{ linkId: "POSSIBLE-1", reviewOnly: true }];
  assert.equal((await service.unarchiveLink("POSSIBLE-1")).ok, true);
  assert.deepEqual(service.state.possibleLinks, stored);
  assert.equal(service.state.possibleLinkCount, 1);
});

test("linker accepts all six approved airport return chains from sample.txt", async () => {
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
    },
    {
      id: "E",
      first: ["Heathrow T3", "PE33 9LE, King's Lynn", "2026-08-29T06:15:00.000Z"],
      second: ["LN5 0TT, Lincoln", "Heathrow Airport", "2026-08-29T13:45:00.000Z"]
    },
    {
      id: "F",
      first: ["Heathrow T3", "LE2 8FA, Leicester", "2026-06-11T05:25:00.000Z"],
      second: ["NG2 5HX, Nottingham", "Heathrow T2", "2026-06-11T11:45:00.000Z"]
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

test("linker rejects all seven bad-pair classes from sample.txt", async () => {
  const wrongDirectionPairs = [
    ["LN4 4SY", "Heathrow Airport", "Heathrow Airport", "NR31 6JF"],
    ["RG1 1PZ", "Gatwick Airport", "Stansted Airport", "NG9 1LB"],
    ["PE15 8UN", "Heathrow Airport", "Heathrow Airport", "NG1 3PZ"],
    ["NR32 5LQ", "Heathrow Airport", "Gatwick Airport", "OX15 5PF"]
  ];
  for (const [firstPickup, firstDrop, secondPickup, secondDrop] of wrongDirectionPairs) {
    assert.equal(isStrictAirportReturnPattern(
      job({ pickup: firstPickup, dropOff: firstDrop }),
      job({ pickup: secondPickup, dropOff: secondDrop })
    ), false);
  }

  const beforeAnchor = await scoreLink(
    job({ rideId: "PRE-BEFORE", pickup: "Heathrow Airport", dropOff: "CF24 3JX", pickupAt: "2026-08-27T04:50:00.000Z", requiredVehicle: "MPV" }),
    job({ rideId: "OTS-BEFORE", pickup: "BS36 2QG", dropOff: "Heathrow Airport", pickupAt: "2026-08-26T10:20:00.000Z", requiredVehicle: "MPV" }),
    DEFAULT_JOB_LINKER_CRITERIA,
    routingOptions()
  );
  assert.equal(beforeAnchor, null);

  const wrongVehicle = await scoreLink(
    job({ rideId: "PRE-VEHICLE", pickup: "Heathrow Airport", dropOff: "IP27 9PN", requiredVehicle: "8 Seater Minibus" }),
    job({ rideId: "OTS-VEHICLE", pickup: "DN21 1BH", dropOff: "Heathrow Airport", pickupAt: "2026-09-01T12:00:00.000Z", requiredVehicle: "People Carrier" }),
    DEFAULT_JOB_LINKER_CRITERIA,
    routingOptions()
  );
  assert.equal(wrongVehicle, null);

  const impracticalDeadhead = await scoreLink(
    job({ rideId: "PRE-FAR", pickup: "Stansted Airport", dropOff: "SO16 6BD, Southampton", pickupAt: "2026-08-07T21:30:00.000Z", requiredVehicle: "Saloon" }),
    job({ rideId: "OTS-FAR", pickup: "IP28 8EZ", dropOff: "Heathrow Airport", pickupAt: "2026-08-08T02:00:00.000Z", requiredVehicle: "Saloon" }),
    DEFAULT_JOB_LINKER_CRITERIA,
    routingOptions()
  );
  assert.equal(impracticalDeadhead, null);
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

test("PreBook recovers next-day time durations from raw sheet values", async () => {
  const formatted = [
    ["Booking ID", "Date", "Time", "Pickup", "Drop-off", "Vehicle"],
    ["PB-DURATION", "Thursday 8th Oct 2026", "12/30/1899", "Heathrow Airport", "Reading RG1", "Saloon"]
  ];
  const raw = [
    formatted[0],
    ["PB-DURATION", "Thursday 8th Oct 2026", 1 + (4 * 60 + 10) / 1440, "Heathrow Airport", "Reading RG1", "Saloon"]
  ];
  const calls = [];
  const sheetsClient = { spreadsheets: { values: { get: async (options) => {
    calls.push(options.valueRenderOption || "FORMATTED_VALUE");
    return { data: { values: options.valueRenderOption === "UNFORMATTED_VALUE" ? raw : formatted } };
  } } } };
  const result = await loadPrebookJobs({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Bookings",
    now: new Date("2026-10-07T00:00:00.000Z")
  });
  assert.deepEqual(calls, ["FORMATTED_VALUE", "UNFORMATTED_VALUE"]);
  assert.equal(result.jobs[0].startingTiming, "28:10");
  assert.equal(result.jobs[0].pickupAt, "2026-10-09T03:10:00.000Z");
});

test("PreBook raw duration wins even when Sheet displays a valid but misleading clock time", async () => {
  const formatted = [
    ["Booking ID", "Date", "Time", "Pickup", "Drop-off", "Vehicle", "Booking Status"],
    ["PB-ROLLOVER", "18/10/2026", "5:00", "Risley, Derby, DE72 3SS", "Heathrow Airport", "Saloon Car", "Active"]
  ];
  const raw = [formatted[0], ["PB-ROLLOVER", "18/10/2026", 1 + 5 / 24, ...formatted[1].slice(3)]];
  const calls = [];
  const sheetsClient = { spreadsheets: { values: { get: async (options) => {
    calls.push(options.valueRenderOption || "FORMATTED_VALUE");
    return { data: { values: options.valueRenderOption === "UNFORMATTED_VALUE" ? raw : formatted } };
  } } } };
  const result = await loadPrebookJobs({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Bookings",
    now: new Date("2026-10-09T00:00:00.000Z")
  });
  assert.deepEqual(calls, ["FORMATTED_VALUE", "UNFORMATTED_VALUE"]);
  assert.equal(result.jobs[0].pickupDayDate, "18/10/2026");
  assert.equal(result.jobs[0].startingTiming, "29:00");
  assert.equal(result.jobs[0].pickupAt, "2026-10-19T04:00:00.000Z");
  assert.equal(normalizePrebookRow({
    "Booking ID": "PB-ROLLOVER",
    Date: "18/10/2026",
    Time: "5:00",
    Pickup: "Risley, Derby, DE72 3SS",
    "Drop-off": "Heathrow Airport",
    Vehicle: "Saloon Car"
  }).pickupAt, "2026-10-18T04:00:00.000Z");
});

test("OTS Master import keeps all valid live jobs independent of Linker criteria", () => {
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

  const importTime = new Date("2026-08-30T12:00:00.000Z");
  assert.equal(prepareSourceJob({ ...source, fare: 60 }, "OTS", DEFAULT_JOB_LINKER_CRITERIA, importTime).fare, 60);
  assert.equal(prepareSourceJob({ ...source, pickup: "Glasgow", required_vehicle: "Coach" }, "OTS", DEFAULT_JOB_LINKER_CRITERIA, importTime).pickup, "Glasgow");
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

test("Groups upcoming sheet uses its vehicle column and excludes past pickups", async () => {
  const values = [
    ["Refer", "Group Name", "Source Name", "Source Time", "Pickup Day & Date", "Starting Timing", "Pickup", "Drop Off", "Distance", "Fare", "Required Vehicle", "Payment Status"],
    ["RID-FUTURE", "group-id", "Operator", "10:00", "Tuesday 13th October 2026", "10:45 am", "LHR T2", "OX7 4JS", "62", "130", "8 Seater", ""],
    ["RID-PAST", "group-id", "Operator", "09:00", "Sunday 11th October 2026", "09:00 am", "LHR T2", "OX7 4JS", "62", "130", "Saloon", ""]
  ];
  const sheetsClient = { spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [{ values }] } }) } } };
  const result = await loadWhatsAppSheetJobs({ sheetsClient, spreadsheetId: "sheet-id", worksheetNames: ["Upcoming Jobs >79"], now: new Date("2026-10-12T12:00:00.000Z") });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].refer, "RID-FUTURE");
  assert.equal(result.jobs[0].required_vehicle, "8 Seater");
  assert.equal(result.jobs[0].source_expires_at, result.jobs[0].pickupAt);
  assert.ok(prepareSourceJob(result.jobs[0], "WhatsApp", DEFAULT_JOB_LINKER_CRITERIA, new Date("2026-10-12T12:00:00.000Z")));
  await assert.rejects(loadWhatsAppSheetJobs({ sheetsClient: { spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [{ values: [["Wrong header"]] }] } }) } } }, spreadsheetId: "sheet-id", worksheetNames: ["Upcoming Jobs >79"] }), /unexpected headers/);
});

test("Groups sheet sync reconciles only after a healthy source read and hides direct rows", async () => {
  const values = [
    ["Refer", "Pickup Day & Date", "Starting Timing", "Pickup", "Drop Off", "Fare", "Required Vehicle"],
    ["RID-FUTURE", "Tuesday 13th October 2026", "10:45 am", "LHR T2", "OX7 4JS", "130", "Saloon"]
  ];
  let fail = false;
  const calls = [];
  const sheetsClient = { spreadsheets: { values: { batchGet: async () => {
    if (fail) throw new Error("Sheet unavailable");
    return { data: { valueRanges: [{ values }] } };
  } } } };
  const repository = {
    getCriteria: async () => DEFAULT_JOB_LINKER_CRITERIA,
    syncSourceJobs: async (jobs) => { calls.push("import"); return { count: jobs.length, acceptedRideIds: jobs.map((job) => job.refer) }; },
    expireMissingSheetJobs: async (ids) => { calls.push(["expire", ids]); },
    listJobs: async () => [
      { rideId: "RID-FUTURE", sourceType: "WhatsApp", groupName: "WhatsApp Sheet: Upcoming Jobs >79", pickupAt: "2026-10-13T09:45:00.000Z" },
      { rideId: "RID-DIRECT", sourceType: "WhatsApp", groupName: "Direct", pickupAt: "2026-10-13T09:45:00.000Z" }
    ],
    replaceLinks: async () => {},
    listLinks: async () => [],
    listJobsTrash: async () => [],
    getAutoBidSettings: async () => ({})
  };
  const service = createJobLinkerService({ repository, whatsappSheetsClient: sheetsClient, whatsappSpreadsheetId: "sheet-id", whatsappWorksheetNames: ["Upcoming Jobs >79"], now: () => new Date("2026-10-12T12:00:00.000Z"), logger: { warn: () => {} } });
  assert.equal((await service.syncGroupsSheet()).ok, true);
  assert.deepEqual(calls, ["import", ["expire", ["RID-FUTURE"]]]);
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.groups.map((item) => item.rideId), ["RID-FUTURE"]);
  fail = true;
  assert.equal((await service.syncGroupsSheet()).ok, false);
  assert.equal(calls.length, 2);
});
