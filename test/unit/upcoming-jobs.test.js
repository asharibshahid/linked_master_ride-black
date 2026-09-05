const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendUpcomingJobIfEligible,
  buildUpcomingDedupeKey,
  isUpcomingHighValueRide,
  parseFare,
  parsePickupDateTime,
  sortRideRecordsByPickupDateTime,
  sortUpcomingJobsSheet
} = require("../../src/sheets/upcomingJobs");

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

function formatInUk(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

test("parseFare extracts numeric fare from plain and decorated values", () => {
  assert.equal(parseFare("145"), 145);
  assert.equal(parseFare("£145"), 145);
  assert.equal(parseFare("85 net"), 85);
  assert.equal(parseFare("PKR 22852.56"), 22852.56);
  assert.equal(parseFare(""), null);
  assert.equal(parseFare("fare unknown"), null);
});

test("parsePickupDateTime parses UK-normalized dates and times deterministically", () => {
  const morning = parsePickupDateTime("Friday 13th March 2026", "6:25 am", {
    timeZone: "Europe/London"
  });
  const legacy = parsePickupDateTime("Tuesday 7th October 2025", "20:05 pm", {
    timeZone: "Europe/London"
  });
  const iso = parsePickupDateTime("2026-05-01", "16:30", {
    timeZone: "Europe/London"
  });
  const shortMonth = parsePickupDateTime("Tuesday 11th Aug 2026", "10:00", {
    timeZone: "Europe/London"
  });

  assert.ok(morning instanceof Date);
  assert.ok(legacy instanceof Date);
  assert.ok(iso instanceof Date);
  assert.ok(shortMonth instanceof Date);
  assert.equal(formatInUk(morning), "13/03/2026, 06:25");
  assert.equal(formatInUk(legacy), "07/10/2025, 20:05");
  assert.equal(formatInUk(iso), "01/05/2026, 16:30");
  assert.equal(formatInUk(shortMonth), "11/08/2026, 10:00");
  assert.equal(parsePickupDateTime("Tomorrow", "12:00 pm"), null);
  assert.equal(parsePickupDateTime("Friday 13th March 2026", ""), null);
});

test("buildUpcomingDedupeKey normalizes pickup, drop off, and starting timing", () => {
  const fromCanonical = buildUpcomingDedupeKey({
    pickup: " Heathrow Airport (LHR) ",
    drop_off: "Nine Elms, London SW11 7DP",
    starting_timing: "1:35 PM"
  });
  const fromHeaders = buildUpcomingDedupeKey({
    Pickup: "heathrow airport (lhr)",
    "Drop Off": "  Nine Elms, London SW11 7DP ",
    "Starting Timing": "1:35 pm"
  });

  assert.equal(
    fromCanonical,
    "heathrow airport (lhr)|nine elms, london sw11 7dp|1:35 pm"
  );
  assert.equal(fromCanonical, fromHeaders);
});

test("sortRideRecordsByPickupDateTime orders valid rides by date then time and puts invalid dates last", () => {
  const sorted = sortRideRecordsByPickupDateTime([
    {
      Refer: "RID-3",
      "Pickup Day & Date": "5 August 2026",
      "Starting Timing": "12:00"
    },
    {
      Refer: "RID-BAD",
      "Pickup Day & Date": "not a date",
      "Starting Timing": "08:00"
    },
    {
      Refer: "RID-1",
      "Pickup Day & Date": "04/08/2026",
      "Starting Timing": "12:00"
    },
    {
      Refer: "RID-2",
      "Pickup Day & Date": "Tuesday 4th August 2026",
      "Starting Timing": "08:00"
    },
    {
      Refer: "RID-NO-TIME",
      "Pickup Day & Date": "4 August 2026",
      "Starting Timing": ""
    }
  ]);

  assert.deepEqual(
    sorted.map((row) => row.Refer),
    ["RID-2", "RID-1", "RID-NO-TIME", "RID-3", "RID-BAD"]
  );
});

test("isUpcomingHighValueRide returns eligibility and skip reasons", () => {
  const eligible = isUpcomingHighValueRide(
    {
      pickup: "Heathrow Airport",
      drop_off: "SW1A 1AA",
      fare: "145",
      pickup_day_date: "Friday 13th March 2026",
      starting_timing: "6:25 am"
    },
    {
      timeZone: "Europe/London",
      now: new Date("2026-03-01T00:00:00.000Z")
    }
  );
  const lowFare = isUpcomingHighValueRide(
    {
      pickup: "Heathrow Airport",
      drop_off: "SW1A 1AA",
      fare: "75",
      pickup_day_date: "Friday 13th March 2026",
      starting_timing: "6:25 am"
    },
    {
      timeZone: "Europe/London",
      now: new Date("2026-03-01T00:00:00.000Z")
    }
  );
  const invalidTime = isUpcomingHighValueRide(
    {
      pickup: "Heathrow Airport",
      drop_off: "SW1A 1AA",
      fare: "145",
      pickup_day_date: "",
      starting_timing: ""
    },
    {
      timeZone: "Europe/London",
      now: new Date("2026-03-01T00:00:00.000Z")
    }
  );
  const past = isUpcomingHighValueRide(
    {
      pickup: "Heathrow Airport",
      drop_off: "SW1A 1AA",
      fare: "145",
      pickup_day_date: "Friday 13th March 2026",
      starting_timing: "6:25 am"
    },
    {
      timeZone: "Europe/London",
      now: new Date("2026-04-01T00:00:00.000Z")
    }
  );

  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, "eligible");
  assert.equal(lowFare.eligible, false);
  assert.equal(lowFare.reason, "fare_too_low");
  assert.equal(invalidTime.eligible, false);
  assert.equal(invalidTime.reason, "pickup_datetime_invalid");
  assert.equal(past.eligible, false);
  assert.equal(past.reason, "pickup_datetime_past");
});

test("appendUpcomingJobIfEligible appends qualifying rides and dedupes using live headers", async () => {
  const { logger, entries } = createRecordingLogger();
  const appendCalls = [];
  const headers = [
    "Fare",
    "Pickup",
    "Drop Off",
    "Starting Timing",
    "Refer",
    "Group Name",
    "Source Name",
    "Source Time",
    "Pickup Day & Date",
    "Distance",
    "Required Vehicle",
    "Payment Status"
  ];

  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          if (String(range).includes("!1:1")) {
            return { data: { values: [headers] } };
          }

          return {
            data: {
              values: [
                headers,
                [
                  "145",
                  "Heathrow Airport",
                  "SW1A 1AA",
                  "6:25 am",
                  "RID-EXISTING",
                  "testing",
                  "sender",
                  "10:00:00 am",
                  "Friday 13th March 2026",
                  "12",
                  "Saloon",
                  ""
                ]
              ]
            }
          };
        }
      }
    }
  };

  const duplicateRide = {
    refer: "RID-DUPLICATE",
    group_name: "testing",
    source_name: "sender",
    source_time: "10:00:00 am",
    pickup_day_date: "Friday 13th March 2026",
    starting_timing: "6:25 am",
    pickup: "Heathrow Airport",
    drop_off: "SW1A 1AA",
    distance: "12",
    fare: "145",
    required_vehicle: "Saloon",
    payment_status: ""
  };

  const duplicateResult = await appendUpcomingJobIfEligible(duplicateRide, {
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Upcoming Jobs >79",
    appendRow: async (ride) => {
      appendCalls.push(ride);
      return { updatedRange: "Upcoming Jobs >79!A2", updatedRows: 1 };
    },
    logger,
    timeZone: "Europe/London",
    now: new Date("2026-03-01T00:00:00.000Z")
  });

  assert.equal(duplicateResult.appended, false);
  assert.equal(duplicateResult.reason, "duplicate_exists");
  assert.equal(appendCalls.length, 0);

  const freshResult = await appendUpcomingJobIfEligible(
    {
      ...duplicateRide,
      refer: "RID-FRESH",
      drop_off: "NW1 6XE"
    },
    {
      sheetsClient,
      spreadsheetId: "sheet-id",
      worksheetName: "Upcoming Jobs >79",
      appendRow: async (ride) => {
        appendCalls.push(ride);
        return { updatedRange: "Upcoming Jobs >79!A2", updatedRows: 1 };
      },
      logger,
      timeZone: "Europe/London",
      now: new Date("2026-03-01T00:00:00.000Z")
    }
  );

  assert.equal(freshResult.appended, true);
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0].refer, "RID-FRESH");

  const appendedLog = entries.find((entry) => entry.message === "Upcoming job appended");
  assert.ok(appendedLog);
});

test("sortUpcomingJobsSheet rewrites existing Upcoming Jobs rows in pickup date and time order", async () => {
  const headers = [
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
  const rows = [
    ["RID-3", "", "", "", "5 August 2026", "12:00", "C", "D", "", "120", "MPV", ""],
    ["RID-1", "", "", "", "4 August 2026", "12:00", "A", "B", "", "120", "MPV", ""],
    ["RID-2", "", "", "", "4 August 2026", "08:00", "A", "B", "", "120", "MPV", ""],
    ["RID-BAD", "", "", "", "bad date", "08:00", "X", "Y", "", "120", "MPV", ""]
  ];
  const calls = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          if (String(range).includes("!1:1")) return { data: { values: [headers] } };
          return { data: { values: [headers, ...rows] } };
        },
        clear: async (request) => {
          calls.push({ type: "clear", request });
          return {};
        },
        update: async (request) => {
          calls.push({ type: "update", request });
          return {};
        }
      }
    }
  };

  const result = await sortUpcomingJobsSheet({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Upcoming Jobs >79",
    logger: createRecordingLogger().logger
  });

  assert.equal(result.sorted, true);
  assert.equal(calls[0].type, "clear");
  assert.equal(calls[0].request.range, "'Upcoming Jobs >79'!A2:L");
  assert.equal(calls[1].type, "update");
  assert.deepEqual(
    calls[1].request.requestBody.values.map((row) => row[0]),
    ["RID-2", "RID-1", "RID-3", "RID-BAD"]
  );
});

test("appendUpcomingJobIfEligible skips low fares and invalid datetimes without appending", async () => {
  const { logger, entries } = createRecordingLogger();
  const appendCalls = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async () => ({
          data: { values: [["Refer", "Group Name", "Source Name", "Source Time", "Pickup Day & Date", "Starting Timing", "Pickup", "Drop Off", "Distance", "Fare", "Required Vehicle", "Payment Status"]] }
        })
      }
    }
  };

  const lowFare = await appendUpcomingJobIfEligible(
    {
      pickup: "Heathrow Airport",
      drop_off: "SW1A 1AA",
      pickup_day_date: "Friday 13th March 2026",
      starting_timing: "6:25 am",
      fare: "75"
    },
    {
      sheetsClient,
      spreadsheetId: "sheet-id",
      worksheetName: "Upcoming Jobs >79",
      appendRow: async (ride) => {
        appendCalls.push(ride);
      },
      logger,
      timeZone: "Europe/London",
      now: new Date("2026-03-01T00:00:00.000Z")
    }
  );

  const invalidDateTime = await appendUpcomingJobIfEligible(
    {
      pickup: "Heathrow Airport",
      drop_off: "SW1A 1AA",
      pickup_day_date: "",
      starting_timing: "",
      fare: "145"
    },
    {
      sheetsClient,
      spreadsheetId: "sheet-id",
      worksheetName: "Upcoming Jobs >79",
      appendRow: async (ride) => {
        appendCalls.push(ride);
      },
      logger,
      timeZone: "Europe/London",
      now: new Date("2026-03-01T00:00:00.000Z")
    }
  );

  assert.equal(lowFare.reason, "fare_too_low");
  assert.equal(invalidDateTime.reason, "pickup_datetime_invalid");
  assert.equal(appendCalls.length, 0);
  assert.equal(entries.length, 0);
});
