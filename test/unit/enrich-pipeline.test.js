const test = require("node:test");
const assert = require("node:assert/strict");
const { createMessageHandler } = require("../../src/whatsapp/messageHandler");
const { createUpcomingJobAppender } = require("../../src/sheets/upcomingJobs");
const { createFinalBidAppender } = require("../../src/bids/finalBid");
const { DedupeStore } = require("../../src/utils/dedupe");
const { createSilentLogger } = require("../helpers");

function expectedSourceTimeFromTimestamp(timestampSeconds, timeZone = "Europe/London") {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone
  }).format(new Date(timestampSeconds * 1000));
}

function createRecordingLogger() {
  const entries = [];
  const logger = {
    info: (message, meta = {}) => entries.push({ level: "info", message, meta }),
    warn: (message, meta = {}) => entries.push({ level: "warn", message, meta }),
    error: (message, meta = {}) => entries.push({ level: "error", message, meta }),
    debug: (message, meta = {}) => entries.push({ level: "debug", message, meta }),
    child: () => logger
  };

  return {
    logger,
    entries
  };
}

function createAllowedGroupMessage(body, overrides = {}) {
  const groupId = overrides.groupId || "120363408968321565@g.us";
  const groupName = overrides.groupName || "Test Allowed Group";
  return {
    body,
    fromMe: false,
    type: "chat",
    hasMedia: Boolean(overrides.hasMedia),
    timestamp: 1760000000,
    from: groupId,
    author: overrides.author || "447700900123@c.us",
    _data: overrides._data || { notifyName: "Ali Driver" },
    id: { _serialized: overrides.messageId || `MSG-${Math.random().toString(16).slice(2, 10)}` },
    downloadMedia: overrides.downloadMedia,
    getChat: async () => ({
      isGroup: true,
      id: { _serialized: groupId },
      name: groupName
    })
  };
}

test("enrich pipeline geocodes after normalization, runs OSRM only with both coordinates, and calculates fare from distance plus vehicle", async () => {
  const { logger, entries } = createRecordingLogger();
  const appendRideCalls = [];
  const geocodeCalls = [];
  const osrmCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const expectedSourceTime = expectedSourceTimeFromTimestamp(1760000000);

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "PKR"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extract: () => ({
        pickup: "LOCAL PICKUP",
        drop_off: "LOCAL DROP",
        required_vehicle: "Estate",
        fare: ""
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async () => ({
        pickup: "AI PICKUP",
        drop_off: "AI DROP",
        required_vehicle: "Estate"
      })
    },
    geocoder: {
      geocodeAddress: async (address) => {
        geocodeCalls.push(address);
        if (address === "AI PICKUP") return { lat: 51.47, lng: -0.45 };
        if (address === "AI DROP") return { lat: 51.6, lng: -0.3 };
        return null;
      }
    },
    osrmClient: {
      getRouteFromOSRM: async (origin, destination) => {
        osrmCalls.push({ origin, destination });
        return {
          distance_meters: 10000,
          duration_seconds: 1200,
          distance_text: "6",
          duration_text: "20m"
        };
      }
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    }
  });

  await handler(createAllowedGroupMessage("sample"));

  assert.deepEqual(geocodeCalls, ["AI PICKUP", "AI DROP"]);
  assert.equal(osrmCalls.length, 1);
  assert.equal(appendRideCalls.length, 1);
  assert.equal(appendRideCalls[0].distance, "6");
  assert.match(appendRideCalls[0].fare, /^\d+\.\d{2}$/);
  assert.equal(appendRideCalls[0].pickup, "AI PICKUP");
  assert.equal(appendRideCalls[0].drop_off, "AI DROP");
  assert.equal(appendRideCalls[0].source_name, "Ali Driver");
  assert.equal(appendRideCalls[0].source_time, expectedSourceTime);

  const geocodeSuccessLogs = entries.filter(
    (entry) => entry.message === "Geocode completed" && entry.level === "debug"
  );
  const osrmSuccessLogs = entries.filter(
    (entry) => entry.message === "OSRM route completed" && entry.level === "debug"
  );

  assert.equal(geocodeSuccessLogs.length, 2);
  assert.equal(osrmSuccessLogs.length, 1);
});

test("enrich pipeline preserves extracted fare and logs the final row object before append", async () => {
  const { logger, entries } = createRecordingLogger();
  const appendRideCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const expectedSourceTime = expectedSourceTimeFromTimestamp(1760000000);

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "GBP"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extract: () => ({
        pickup: "Heathrow Airport, Terminal 5",
        drop_off: "10 Oakland Villas, Hay-on-Wye, Hereford, HR3 5PH",
        required_vehicle: "Saloon Car",
        fare: "145"
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async (address) => {
        if (address.includes("Heathrow")) return { lat: 51.47, lng: -0.45 };
        if (address.includes("Oakland Villas")) return { lat: 52.08, lng: -3.13 };
        return null;
      }
    },
    osrmClient: {
      getRouteFromOSRM: async () => ({
        distance_meters: 241723,
        duration_seconds: 1200,
        distance_text: "150",
        duration_text: "20m"
      })
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    }
  });

  await handler(createAllowedGroupMessage("ace-message", { messageId: "ACE-PIPELINE" }));

  assert.equal(appendRideCalls.length, 1);
  assert.equal(appendRideCalls[0].distance, "150");
  assert.equal(appendRideCalls[0].fare, "145");
  assert.equal(appendRideCalls[0].required_vehicle, "Saloon Car");
  assert.equal(appendRideCalls[0].source_time, expectedSourceTime);

  const finalRowLog = entries.find(
    (entry) => entry.message === "Final ride row prepared for Google Sheets"
  );

  assert.ok(finalRowLog);
  assert.equal(finalRowLog.meta.rowObject.Fare, "145");
  assert.equal(finalRowLog.meta.rowObject["Required Vehicle"], "Saloon Car");
});

test("pipeline appends eligible future high-value rides to Upcoming Jobs >79 after Rides", async () => {
  const { logger } = createRecordingLogger();
  const appendRideCalls = [];
  const appendUpcomingCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const upcomingHeaders = [
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
  ];

  const appendUpcomingJobIfEligible = createUpcomingJobAppender({
    sheetsClient: {
      spreadsheets: {
        values: {
          get: async ({ range }) => {
            if (String(range).includes("!1:1")) {
              return { data: { values: [upcomingHeaders] } };
            }
            return { data: { values: [upcomingHeaders] } };
          }
        }
      }
    },
    spreadsheetId: "sheet-id",
    worksheetName: "Upcoming Jobs >79",
    appendRow: async (ride) => {
      appendUpcomingCalls.push(ride);
      return { updatedRange: "Upcoming Jobs >79!A2", updatedRows: 1 };
    },
    logger,
    timeZone: "Europe/London",
    now: new Date("2026-03-01T00:00:00.000Z")
  });

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "GBP"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extractWithAnalysis: () => ({
        record: {
          pickup_day_date: "Friday 13th March 2026",
          starting_timing: "6:25 am",
          pickup: "Heathrow Airport, Terminal 5",
          drop_off: "10 Oakland Villas, Hay-on-Wye, Hereford, HR3 5PH",
          required_vehicle: "Saloon Car",
          fare: "145"
        },
        analysis: {
          hadDateLikeText: true,
          hadTimeLikeText: true,
          selected: {
            pickup: { value: "Heathrow Airport, Terminal 5", contaminated: false },
            drop_off: {
              value: "10 Oakland Villas, Hay-on-Wye, Hereford, HR3 5PH",
              contaminated: false
            },
            required_vehicle: { value: "Saloon Car", source: "vehicle_line" }
          }
        }
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async () => ({ lat: 51.47, lng: -0.45 })
    },
    osrmClient: {
      getRouteFromOSRM: async () => ({
        distance_meters: 241723,
        duration_seconds: 1200,
        distance_text: "150",
        duration_text: "20m"
      })
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    },
    appendUpcomingJobIfEligible
  });

  await handler(createAllowedGroupMessage("future-high-value", { messageId: "UPCOMING-HIGH" }));

  assert.equal(appendRideCalls.length, 1);
  assert.equal(appendUpcomingCalls.length, 1);
  assert.equal(appendUpcomingCalls[0].fare, "145");
});

test("pipeline skips Upcoming Jobs >79 for low-fare rides but still appends to Rides", async () => {
  const { logger, entries } = createRecordingLogger();
  const appendRideCalls = [];
  const appendUpcomingCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const upcomingHeaders = [
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
  ];

  const appendUpcomingJobIfEligible = createUpcomingJobAppender({
    sheetsClient: {
      spreadsheets: {
        values: {
          get: async ({ range }) => {
            if (String(range).includes("!1:1")) {
              return { data: { values: [upcomingHeaders] } };
            }
            return { data: { values: [upcomingHeaders] } };
          }
        }
      }
    },
    spreadsheetId: "sheet-id",
    worksheetName: "Upcoming Jobs >79",
    appendRow: async (ride) => {
      appendUpcomingCalls.push(ride);
      return { updatedRange: "Upcoming Jobs >79!A2", updatedRows: 1 };
    },
    logger,
    timeZone: "Europe/London",
    now: new Date("2026-03-01T00:00:00.000Z")
  });

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "GBP"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extractWithAnalysis: () => ({
        record: {
          pickup_day_date: "Friday 13th March 2026",
          starting_timing: "6:25 am",
          pickup: "Heathrow Airport, Terminal 5",
          drop_off: "SW1A 1AA",
          required_vehicle: "Saloon Car",
          fare: "75"
        },
        analysis: {
          hadDateLikeText: true,
          hadTimeLikeText: true,
          selected: {
            pickup: { value: "Heathrow Airport, Terminal 5", contaminated: false },
            drop_off: { value: "SW1A 1AA", contaminated: false },
            required_vehicle: { value: "Saloon Car", source: "vehicle_line" }
          }
        }
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async () => ({ lat: 51.47, lng: -0.45 })
    },
    osrmClient: {
      getRouteFromOSRM: async () => ({
        distance_meters: 24140,
        duration_seconds: 1200,
        distance_text: "15",
        duration_text: "20m"
      })
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    },
    appendUpcomingJobIfEligible
  });

  await handler(createAllowedGroupMessage("future-low-fare", { messageId: "UPCOMING-LOW" }));

  assert.equal(appendRideCalls.length, 1);
  assert.equal(appendUpcomingCalls.length, 0);
  assert.equal(entries.some((entry) => entry.message === "Upcoming job skipped because fare <= 79"), false);
});

test("pipeline appends eligible clean rides to Final Bid after Rides", async () => {
  const { logger } = createRecordingLogger();
  const appendRideCalls = [];
  const appendFinalBidCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const appendFinalBidIfEligible = createFinalBidAppender({
    appendRow: async (payload) => {
      appendFinalBidCalls.push(payload);
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

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "GBP"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extractWithAnalysis: () => ({
        record: {
          pickup_day_date: "Friday 13th March 2026",
          starting_timing: "6:25 am",
          pickup: "Heathrow Airport, Terminal 5",
          drop_off: "SW1A 1AA",
          required_vehicle: "Saloon Car",
          fare: "145"
        },
        analysis: {
          hadDateLikeText: true,
          hadTimeLikeText: true,
          selected: {
            pickup: { value: "Heathrow Airport, Terminal 5", contaminated: false },
            drop_off: { value: "SW1A 1AA", contaminated: false },
            required_vehicle: { value: "Saloon Car", source: "vehicle_line" }
          }
        }
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async () => ({ lat: 51.47, lng: -0.45 })
    },
    osrmClient: {
      getRouteFromOSRM: async () => ({
        distance_meters: 109435,
        duration_seconds: 1200,
        distance_text: "68",
        duration_text: "20m"
      })
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    },
    appendFinalBidIfEligible
  });

  await handler(createAllowedGroupMessage("final-bid-eligible", { messageId: "FINAL-BID-HIGH" }));

  assert.equal(appendRideCalls.length, 1);
  assert.equal(appendFinalBidCalls.length, 1);
  assert.equal(appendFinalBidCalls[0].Refer, appendRideCalls[0].refer);
  assert.equal(appendFinalBidCalls[0].Status, "Pending");
  assert.equal(appendFinalBidCalls[0].Fare, "145");
  assert.equal(appendFinalBidCalls[0].Distance, "68");
});

test("pipeline skips Final Bid for rides that fail bid criteria but still appends to Rides", async () => {
  const { logger, entries } = createRecordingLogger();
  const appendRideCalls = [];
  const appendFinalBidCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const appendFinalBidIfEligible = createFinalBidAppender({
    appendRow: async (payload) => {
      appendFinalBidCalls.push(payload);
      return { updatedRange: "Final Bid!A2", updatedRows: 1 };
    },
    config: {
      minFare: 80
    },
    logger
  });

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "GBP"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extractWithAnalysis: () => ({
        record: {
          pickup_day_date: "Friday 13th March 2026",
          starting_timing: "6:25 am",
          pickup: "Heathrow Airport, Terminal 5",
          drop_off: "SW1A 1AA",
          required_vehicle: "Saloon Car",
          fare: "60"
        },
        analysis: {
          hadDateLikeText: true,
          hadTimeLikeText: true,
          selected: {
            pickup: { value: "Heathrow Airport, Terminal 5", contaminated: false },
            drop_off: { value: "SW1A 1AA", contaminated: false },
            required_vehicle: { value: "Saloon Car", source: "vehicle_line" }
          }
        }
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async () => ({ lat: 51.47, lng: -0.45 })
    },
    osrmClient: {
      getRouteFromOSRM: async () => ({
        distance_meters: 24140,
        duration_seconds: 1200,
        distance_text: "15",
        duration_text: "20m"
      })
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    },
    appendFinalBidIfEligible
  });

  await handler(createAllowedGroupMessage("final-bid-low", { messageId: "FINAL-BID-LOW" }));

  assert.equal(appendRideCalls.length, 1);
  assert.equal(appendFinalBidCalls.length, 0);
  assert.ok(entries.some((entry) => entry.message === "Final Bid skipped"));
});

test("enrich pipeline leaves distance and fare blank when coordinates are incomplete", async () => {
  const { logger, entries } = createRecordingLogger();
  const appendRideCalls = [];
  const osrmCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const expectedSourceTime = expectedSourceTimeFromTimestamp(1760000000);

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "PKR"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extract: () => ({
        pickup: "PICKUP A",
        drop_off: "DROP B",
        required_vehicle: "MPV"
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async (address) => {
        if (address === "PICKUP A") return { lat: 51.47, lng: -0.45 };
        return null;
      }
    },
    osrmClient: {
      getRouteFromOSRM: async (origin, destination) => {
        osrmCalls.push({ origin, destination });
        return null;
      }
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    }
  });

  await handler(createAllowedGroupMessage("sample-2"));

  assert.equal(osrmCalls.length, 0);
  assert.equal(appendRideCalls.length, 1);
  assert.equal(appendRideCalls[0].distance, "");
  assert.equal(appendRideCalls[0].fare, "");
  assert.equal(appendRideCalls[0].source_time, expectedSourceTime);

  const geocodeFailureLogs = entries.filter(
    (entry) => entry.message === "Geocode returned no coordinates" && entry.level === "warn"
  );

  assert.equal(geocodeFailureLogs.length, 1);
});

test("pipeline routes rows with missing critical fields to Needs Review", async () => {
  const { logger } = createRecordingLogger();
  const appendRideCalls = [];
  const appendReviewCalls = [];
  const appendUpcomingCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const expectedSourceTime = expectedSourceTimeFromTimestamp(1760000000);

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "PKR"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extractWithAnalysis: () => ({
        record: {
          pickup: "PICKUP ONLY",
          drop_off: "",
          required_vehicle: ""
        },
        analysis: {
          hadDateLikeText: false,
          hadTimeLikeText: false,
          selected: {
            pickup: { value: "PICKUP ONLY", contaminated: false },
            drop_off: { value: "", contaminated: false },
            required_vehicle: { value: "", source: "" }
          }
        }
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async () => null
    },
    osrmClient: {
      getRouteFromOSRM: async () => null
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    },
    appendReviewRow: async (ride) => {
      appendReviewCalls.push(ride);
      return { updatedRange: "Needs Review!A2", updatedRows: 1 };
    },
    appendUpcomingJobIfEligible: async (ride) => {
      appendUpcomingCalls.push(ride);
    }
  });

  await handler(createAllowedGroupMessage("sample-3"));

  assert.equal(appendRideCalls.length, 0);
  assert.equal(appendReviewCalls.length, 1);
  assert.equal(appendUpcomingCalls.length, 0);
  assert.equal(appendReviewCalls[0].pickup, "PICKUP ONLY");
  assert.equal(appendReviewCalls[0].drop_off, "");
  assert.equal(appendReviewCalls[0].distance, "");
  assert.equal(appendReviewCalls[0].fare, "");
  assert.equal(appendReviewCalls[0].source_time, expectedSourceTime);
});

test("pipeline routes both-geocode-failed rows to Needs Review", async () => {
  const { logger } = createRecordingLogger();
  const appendRideCalls = [];
  const appendReviewCalls = [];
  const appendUpcomingCalls = [];
  const allowedGroup = "120363408968321565@g.us";

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "PKR"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extractWithAnalysis: () => ({
        record: {
          pickup: "Heathrow Airport, Terminal 3",
          drop_off: "221B Baker Street, London NW1 6XE",
          required_vehicle: "Saloon"
        },
        analysis: {
          hadDateLikeText: false,
          hadTimeLikeText: false,
          selected: {
            pickup: { value: "Heathrow Airport, Terminal 3", contaminated: false },
            drop_off: { value: "221B Baker Street, London NW1 6XE", contaminated: false },
            required_vehicle: { value: "Saloon", source: "vehicle_line" }
          }
        }
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async () => null
    },
    osrmClient: {
      getRouteFromOSRM: async () => null
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    },
    appendReviewRow: async (ride) => {
      appendReviewCalls.push(ride);
      return { updatedRange: "Needs Review!A2", updatedRows: 1 };
    },
    appendUpcomingJobIfEligible: async (ride) => {
      appendUpcomingCalls.push(ride);
    }
  });

  await handler(createAllowedGroupMessage("sample-geocode-review"));

  assert.equal(appendRideCalls.length, 0);
  assert.equal(appendReviewCalls.length, 1);
  assert.equal(appendUpcomingCalls.length, 0);
  assert.equal(appendReviewCalls[0].distance, "");
});

test("pipeline allows configured group names from env without hardcoded IDs", async () => {
  const { logger } = createRecordingLogger();
  const appendRideCalls = [];

  const handler = createMessageHandler({
    env: {
      allowedGroups: ["  test allowed group  "],
      allowedGroupNames: ["Dispatch Overflow"],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "GBP"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extractWithAnalysis: () => ({
        record: {
          pickup_day_date: "Friday 13th March 2026",
          starting_timing: "6:25 am",
          pickup: "Heathrow Airport",
          drop_off: "SW1A 1AA",
          required_vehicle: "Saloon",
          fare: "90"
        },
        analysis: {
          hadDateLikeText: true,
          hadTimeLikeText: true,
          selected: {
            pickup: { value: "Heathrow Airport", contaminated: false },
            drop_off: { value: "SW1A 1AA", contaminated: false },
            required_vehicle: { value: "Saloon", source: "vehicle_line" }
          }
        }
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async () => ({ lat: 51.47, lng: -0.45 })
    },
    osrmClient: {
      getRouteFromOSRM: async () => ({
        distance_meters: 24140,
        duration_seconds: 1200,
        distance_text: "15",
        duration_text: "20m"
      })
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    }
  });

  await handler(
    createAllowedGroupMessage("group-name-match", {
      groupId: "120363999999999999@g.us",
      groupName: "Test   Allowed    Group"
    })
  );

  assert.equal(appendRideCalls.length, 1);
});

test("pipeline appends OCR-only image attempts into the strict row schema", async () => {
  const { logger } = createRecordingLogger();
  const appendRideCalls = [];
  const allowedGroup = "120363408968321565@g.us";
  const expectedSourceTime = expectedSourceTimeFromTimestamp(1760000000);

  const handler = createMessageHandler({
    env: {
      allowedGroups: [allowedGroup],
      appTimeZone: "Europe/London",
      fareBase: 250,
      farePerKm: 95,
      defaultCurrency: "PKR"
    },
    logger,
    dedupe: new DedupeStore({ logger: createSilentLogger() }),
    localExtractor: {
      extract: (rawText, context) => ({
        group_name: context.group_name,
        source_name: context.source_name,
        required_vehicle: "MPV",
        pickup_day_date: "TODAY",
        starting_timing: "09:15",
        pickup: rawText.includes("LHR") ? "LHR" : "",
        drop_off: rawText.includes("SW1") ? "SW1" : ""
      })
    },
    openaiNormalizer: {
      normalizeWithOpenAI: async ({ extracted }) => extracted
    },
    geocoder: {
      geocodeAddress: async () => null
    },
    osrmClient: {
      getRouteFromOSRM: async () => null
    },
    ocrExtractor: {
      isSupportedImageMimeType: () => true,
      extractTextFromMedia: async () => "MPV\nTODAY 09:15\nLHR TO SW1"
    },
    appendRideRow: async (ride) => {
      appendRideCalls.push(ride);
      return { updatedRange: "Rides!A2", updatedRows: 1 };
    }
  });

  await handler(
    createAllowedGroupMessage("", {
      messageId: "OCR-ONLY",
      _data: { notifyName: "OCR Sender" },
      author: "447700900999@c.us",
      groupId: allowedGroup,
      hasMedia: true,
      downloadMedia: async () => ({
        mimetype: "image/png",
        data: Buffer.from("fake").toString("base64")
      })
    })
  );

  assert.equal(appendRideCalls.length, 1);
  assert.equal(appendRideCalls[0].source_name, "OCR Sender");
  assert.equal(appendRideCalls[0].source_time, expectedSourceTime);
  assert.equal(appendRideCalls[0].pickup, "LHR");
  assert.equal(appendRideCalls[0].drop_off, "SW1");
});
