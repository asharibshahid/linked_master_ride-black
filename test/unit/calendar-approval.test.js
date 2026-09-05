const test = require("node:test");
const assert = require("node:assert/strict");
const { FINAL_BID_HEADERS } = require("../../src/bids/finalBid");
const { DRIVER_HEADERS } = require("../../src/drivers/management");
const {
  buildRideCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent
} = require("../../src/calendar/events");
const {
  CALENDAR_STATUS,
  buildCellRange,
  columnIndexToLetter,
  isApprovedForCalendar,
  processFinalBidApprovals
} = require("../../src/calendar/approvalWorkflow");

function createSilentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return this;
    }
  };
}

function createRecordingLogger() {
  const entries = [];
  const logger = {
    info: (message, meta = {}) => entries.push({ level: "info", message, meta }),
    warn: (message, meta = {}) => entries.push({ level: "warn", message, meta }),
    error: (message, meta = {}) => entries.push({ level: "error", message, meta }),
    debug: (message, meta = {}) => entries.push({ level: "debug", message, meta }),
    child() {
      return logger;
    }
  };
  return { logger, entries };
}

function createFinalBidRow(overrides = {}) {
  const record = {
    Refer: "RID-APPROVED",
    "Group Name": "General Taxi Bookings",
    "Source Name": "Dispatcher",
    "Pickup Day & Date": "Friday 13th March 2026",
    "Starting Timing": "6:25 am",
    Pickup: "Heathrow Airport",
    "Drop Off": "SW1A 1AA",
    Distance: "68",
    Fare: "145",
    "Required Vehicle": "Saloon Car",
    "Bid Score": "85",
    Reason: "fare accepted",
    Status: "Approved",
    "Assigned Driver": "001",
    "Payment Status": "Cash",
    "Passenger Count": "1",
    "Calendar Status": "",
    "Calendar Event ID": "",
    "Calendar Created Time": "",
    "Calendar Error": "",
    "Created Time": "2026-07-18T12:00:00.000Z",
    ...overrides
  };

  return FINAL_BID_HEADERS.map((header) => record[header] || "");
}

function createDriversRow(overrides = {}) {
  const record = {
    "Driver ID": "001",
    "Driver Name": "Ali Khan",
    "WhatsApp Number": "447700900123",
    Status: "Available",
    "Current Location": "",
    "Working Hours": "",
    "Vehicle ID": "",
    ...overrides
  };
  return DRIVER_HEADERS.map((header) => record[header] || "");
}

function createSheetsClient({ finalBidRow, driversRows = [createDriversRow()], onBatchUpdate }) {
  const batchUpdates = [];
  return {
    batchUpdates,
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          const rangeText = String(range);
          if (rangeText.includes("Drivers")) {
            if (rangeText.includes("!1:1")) {
              return { data: { values: [DRIVER_HEADERS] } };
            }
            return { data: { values: [DRIVER_HEADERS, ...driversRows] } };
          }

          if (rangeText.includes("!1:1")) {
            return { data: { values: [FINAL_BID_HEADERS] } };
          }

          return {
            data: {
              values: [FINAL_BID_HEADERS, finalBidRow || createFinalBidRow()]
            }
          };
        },
        batchUpdate: async (request) => {
          batchUpdates.push(request);
          if (onBatchUpdate) onBatchUpdate(request);
          return {};
        }
      }
    }
  };
}

test("approval workflow creates calendar event, sets Created status/event id/timestamp, and clears the error column", async () => {
  const insertedEvents = [];
  const sheetsClient = createSheetsClient({});
  const calendarClient = {
    events: {
      insert: async ({ calendarId, requestBody }) => {
        insertedEvents.push({ calendarId, requestBody });
        return {
          data: {
            id: "evt_123",
            htmlLink: "https://calendar.example/evt_123"
          }
        };
      }
    }
  };

  const { logger, entries } = createRecordingLogger();

  const result = await processFinalBidApprovals({
    sheetsClient,
    calendarClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    driversWorksheetName: "Drivers",
    calendarId: "calendar-id",
    timeZone: "Europe/London",
    durationMinutes: 90,
    companyCode: "ACE",
    logger
  });

  assert.equal(result.created, 1);
  assert.equal(result.failed, 0);
  assert.equal(insertedEvents.length, 1);
  assert.equal(insertedEvents[0].calendarId, "calendar-id");

  const event = insertedEvents[0].requestBody;
  assert.match(event.summary, /^🚗 ACE \d{6}-\d{4} - 1 Pax ➡️$/);
  assert.equal(event.location, "Heathrow Airport");
  assert.match(event.description, /Ride ID: RID-APPROVED/);
  assert.match(event.description, /Driver: Ali Khan/);
  assert.match(event.description, /Pickup: Heathrow Airport/);
  assert.match(event.description, /Dropoff: SW1A 1AA/);
  assert.match(event.description, /Fare: 145/);
  assert.match(event.description, /Distance: 68/);
  assert.match(event.description, /Payment: Cash/);
  assert.match(event.description, /Source Group: General Taxi Bookings/);
  assert.match(event.description, /Pickup Map: https:\/\/www\.google\.com\/maps\/search/);

  assert.equal(sheetsClient.batchUpdates.length, 1);
  const data = sheetsClient.batchUpdates[0].requestBody.data;
  assert.equal(data[0].range, "'Final Bid'!Q2");
  assert.deepEqual(data[0].values, [[CALENDAR_STATUS.CREATED]]);
  assert.equal(data[1].range, "'Final Bid'!R2");
  assert.deepEqual(data[1].values, [["evt_123"]]);
  assert.equal(data[2].range, "'Final Bid'!S2");
  assert.ok(data[2].values[0][0]);
  assert.equal(data[3].range, "'Final Bid'!T2");
  assert.deepEqual(data[3].values, [[""]]);

  const createdLog = entries.find((entry) => entry.message === "Calendar Event Created");
  assert.ok(createdLog);
  assert.equal(createdLog.level, "info");
  assert.equal(createdLog.meta.refer, "RID-APPROVED");
  assert.equal(createdLog.meta.driverId, "001");
  assert.equal(createdLog.meta.eventId, "evt_123");

  const startLog = entries.find((entry) => entry.message === "Calendar creation started");
  assert.ok(startLog);
  assert.equal(startLog.meta.calendarId, "calendar-id");
  assert.equal(startLog.meta.timeZone, "Europe/London");

  const payloadLog = entries.find((entry) => entry.message === "Event payload generated");
  assert.ok(payloadLog);
  assert.equal(payloadLog.meta.location, "Heathrow Airport");
  assert.equal(payloadLog.meta.timeZone, "Europe/London");

  const apiResponseLog = entries.find((entry) => entry.message === "Google Calendar API response");
  assert.ok(apiResponseLog);
  assert.equal(apiResponseLog.meta.eventId, "evt_123");
});

test("approval workflow marks Failed with error message and stack when pickup datetime is invalid", async () => {
  const sheetsClient = createSheetsClient({
    finalBidRow: createFinalBidRow({
      "Pickup Day & Date": "",
      "Starting Timing": ""
    })
  });
  const calendarClient = {
    events: {
      insert: async () => {
        throw new Error("should not insert");
      }
    }
  };

  const { logger, entries } = createRecordingLogger();

  const result = await processFinalBidApprovals({
    sheetsClient,
    calendarClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    driversWorksheetName: "Drivers",
    calendarId: "calendar-id",
    logger
  });

  assert.equal(result.created, 0);
  assert.equal(result.failed, 1);

  const data = sheetsClient.batchUpdates[0].requestBody.data;
  assert.deepEqual(data[0], {
    range: "'Final Bid'!Q2",
    values: [[CALENDAR_STATUS.FAILED]]
  });
  assert.equal(data[3].range, "'Final Bid'!T2");
  assert.match(data[3].values[0][0], /Invalid pickup date\/time/);

  const failureLog = entries.find((entry) => entry.message === "Failure reason");
  assert.ok(failureLog);
  assert.equal(failureLog.level, "error");
  assert.equal(failureLog.meta.refer, "RID-APPROVED");
  assert.equal(failureLog.meta.driverId, "001");
  assert.match(failureLog.meta.reason, /Invalid pickup date\/time/);
});

test("approval workflow records exact Google Calendar API failure details", async () => {
  const sheetsClient = createSheetsClient({});
  const calendarClient = {
    events: {
      insert: async () => {
        const error = new Error("Request failed with status code 404");
        error.response = {
          status: 404,
          data: {
            error: {
              code: 404,
              message: "Not Found",
              errors: [
                {
                  domain: "global",
                  reason: "notFound",
                  message: "Not Found"
                }
              ]
            }
          }
        };
        throw error;
      }
    }
  };

  const { logger, entries } = createRecordingLogger();

  const result = await processFinalBidApprovals({
    sheetsClient,
    calendarClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    driversWorksheetName: "Drivers",
    calendarId: "primary",
    timeZone: "Europe/London",
    logger
  });

  assert.equal(result.created, 0);
  assert.equal(result.failed, 1);

  const data = sheetsClient.batchUpdates[0].requestBody.data;
  assert.equal(data[3].range, "'Final Bid'!T2");
  assert.match(data[3].values[0][0], /status=404/);
  assert.match(data[3].values[0][0], /reason=notFound/);
  assert.match(data[3].values[0][0], /Not Found/);

  const failureLog = entries.find((entry) => entry.message === "Failure reason");
  assert.ok(failureLog);
  assert.equal(failureLog.meta.calendarId, "primary");
  assert.equal(failureLog.meta.status, "404");
  assert.equal(failureLog.meta.apiReason, "notFound");
  assert.equal(failureLog.meta.domain, "global");
  assert.match(failureLog.meta.eventStart, /^\d{4}-\d{2}-\d{2}T/);
});

test("approval workflow retries transient Calendar API failures before succeeding", async () => {
  const sheetsClient = createSheetsClient({});
  let attempts = 0;
  const calendarClient = {
    events: {
      insert: async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("temporarily unavailable");
          error.code = 503;
          throw error;
        }
        return { data: { id: "evt_after_retry" } };
      }
    }
  };

  const { logger, entries } = createRecordingLogger();

  const result = await processFinalBidApprovals({
    sheetsClient,
    calendarClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    driversWorksheetName: "Drivers",
    calendarId: "calendar-id",
    logger
  });

  assert.equal(attempts, 3);
  assert.equal(result.created, 1);
  const retryLogs = entries.filter((entry) => entry.message === "Calendar Retry");
  assert.equal(retryLogs.length, 2);
  assert.equal(retryLogs[0].level, "warn");
});

test("approval workflow reconciles an orphaned event id instead of creating a duplicate", async () => {
  const sheetsClient = createSheetsClient({
    finalBidRow: createFinalBidRow({
      "Calendar Status": "Failed",
      "Calendar Event ID": "evt_orphan",
      "Calendar Error": "sheet write failed after insert"
    })
  });
  let insertCalls = 0;
  const calendarClient = {
    events: {
      insert: async () => {
        insertCalls += 1;
        return { data: { id: "evt_should_not_happen" } };
      }
    }
  };

  const { logger, entries } = createRecordingLogger();

  const result = await processFinalBidApprovals({
    sheetsClient,
    calendarClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    driversWorksheetName: "Drivers",
    calendarId: "calendar-id",
    logger
  });

  assert.equal(insertCalls, 0);
  assert.equal(result.created, 0);
  assert.equal(result.failed, 0);

  const data = sheetsClient.batchUpdates[0].requestBody.data;
  assert.deepEqual(data[0], {
    range: "'Final Bid'!Q2",
    values: [[CALENDAR_STATUS.CREATED]]
  });
  assert.deepEqual(data[1], {
    range: "'Final Bid'!R2",
    values: [["evt_orphan"]]
  });

  const alreadyExistsLog = entries.find((entry) => entry.message === "Calendar Already Exists");
  assert.ok(alreadyExistsLog);
  assert.equal(alreadyExistsLog.meta.eventId, "evt_orphan");
});

test("approval helper ignores pending, rejected, already-created, and unassigned rows", () => {
  assert.equal(
    isApprovedForCalendar({
      Status: "Approved",
      "Assigned Driver": "001",
      "Calendar Status": ""
    }),
    true
  );
  assert.equal(isApprovedForCalendar({ Status: "Pending", "Assigned Driver": "001" }), false);
  assert.equal(isApprovedForCalendar({ Status: "Rejected", "Assigned Driver": "001" }), false);
  assert.equal(isApprovedForCalendar({ Status: "Approved", "Assigned Driver": "" }), false);
  assert.equal(
    isApprovedForCalendar({
      Status: "Approved",
      "Assigned Driver": "001",
      "Calendar Status": "Created"
    }),
    false
  );
  assert.equal(
    isApprovedForCalendar({
      Status: "Approved",
      "Assigned Driver": "001",
      "Calendar Status": "Failed"
    }),
    true
  );
});

test("calendar event builder sets title/description/location and future update/delete helpers use Calendar API contracts", async () => {
  const event = buildRideCalendarEvent(
    {
      refer: "RID-1",
      assigned_driver: "001",
      driver_name: "Ali Khan",
      pickup: "Heathrow",
      drop_off: "SW1A 1AA",
      fare: "50",
      distance: "12",
      payment_status: "Cash",
      group_name: "General Taxi Bookings",
      required_vehicle: "Estate",
      passenger_count: "2",
      startDateTime: new Date("2026-07-31T23:40:00.000Z")
    },
    {
      durationMinutes: 30,
      timeZone: "Europe/London",
      companyCode: "ACE"
    }
  );

  assert.match(event.summary, /^🚙 ACE 010826-0040 - 2 Pax ➡️$/);
  assert.equal(event.location, "Heathrow");
  assert.match(event.description, /Ride ID: RID-1/);
  assert.match(event.description, /Driver: Ali Khan/);
  assert.match(event.description, /Dropoff: SW1A 1AA/);

  const calls = [];
  const calendarClient = {
    events: {
      patch: async (request) => {
        calls.push({ type: "patch", request });
        return { data: { id: request.eventId, htmlLink: "updated" } };
      },
      delete: async (request) => {
        calls.push({ type: "delete", request });
        return {};
      }
    }
  };

  const updated = await updateCalendarEvent({
    calendarClient,
    calendarId: "calendar-id",
    eventId: "evt_123",
    event
  });
  const deleted = await deleteCalendarEvent({
    calendarClient,
    calendarId: "calendar-id",
    eventId: "evt_123"
  });

  assert.equal(updated.eventId, "evt_123");
  assert.equal(deleted.deleted, true);
  assert.deepEqual(
    calls.map((call) => call.type),
    ["patch", "delete"]
  );
});

test("approval utility builds expected A1 ranges and column letters", () => {
  assert.equal(columnIndexToLetter(0), "A");
  assert.equal(columnIndexToLetter(25), "Z");
  assert.equal(columnIndexToLetter(26), "AA");
  assert.equal(buildCellRange("Final Bid", 7, 15), "'Final Bid'!P7");
});
