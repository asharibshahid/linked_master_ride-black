const test = require("node:test");
const assert = require("node:assert/strict");
const { FINAL_BID_HEADERS } = require("../../src/bids/finalBid");
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
    "Calendar Status": "",
    "Calendar Event ID": "",
    "Created Time": "2026-07-18T12:00:00.000Z",
    ...overrides
  };

  return FINAL_BID_HEADERS.map((header) => record[header] || "");
}

test("approval workflow creates calendar event and stores status plus event ID", async () => {
  const batchUpdates = [];
  const insertedEvents = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          if (String(range).includes("!1:1")) {
            return { data: { values: [FINAL_BID_HEADERS] } };
          }

          return {
            data: {
              values: [FINAL_BID_HEADERS, createFinalBidRow()]
            }
          };
        },
        batchUpdate: async (request) => {
          batchUpdates.push(request);
          return {};
        }
      }
    }
  };
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

  const result = await processFinalBidApprovals({
    sheetsClient,
    calendarClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    calendarId: "calendar-id",
    timeZone: "Europe/London",
    durationMinutes: 90,
    logger: createSilentLogger()
  });

  assert.equal(result.created, 1);
  assert.equal(result.failed, 0);
  assert.equal(insertedEvents.length, 1);
  assert.equal(insertedEvents[0].calendarId, "calendar-id");
  assert.match(insertedEvents[0].requestBody.description, /Driver ID: 001/);
  assert.match(insertedEvents[0].requestBody.description, /Pickup: Heathrow Airport/);
  assert.match(insertedEvents[0].requestBody.description, /Vehicle: Saloon Car/);

  assert.equal(batchUpdates.length, 1);
  assert.deepEqual(batchUpdates[0].requestBody.data, [
    {
      range: "'Final Bid'!O2",
      values: [[CALENDAR_STATUS.CREATED]]
    },
    {
      range: "'Final Bid'!P2",
      values: [["evt_123"]]
    }
  ]);
});

test("approval workflow marks create failure when approved row has invalid datetime", async () => {
  const batchUpdates = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          if (String(range).includes("!1:1")) {
            return { data: { values: [FINAL_BID_HEADERS] } };
          }

          return {
            data: {
              values: [
                FINAL_BID_HEADERS,
                createFinalBidRow({
                  "Pickup Day & Date": "",
                  "Starting Timing": ""
                })
              ]
            }
          };
        },
        batchUpdate: async (request) => {
          batchUpdates.push(request);
          return {};
        }
      }
    }
  };
  const calendarClient = {
    events: {
      insert: async () => {
        throw new Error("should not insert");
      }
    }
  };

  const result = await processFinalBidApprovals({
    sheetsClient,
    calendarClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Final Bid",
    calendarId: "calendar-id",
    logger: createSilentLogger()
  });

  assert.equal(result.created, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(batchUpdates[0].requestBody.data[0], {
    range: "'Final Bid'!O2",
    values: [[CALENDAR_STATUS.CREATE_FAILED]]
  });
});

test("approval helper ignores pending, rejected, already-created, and unassigned rows", () => {
  assert.equal(
    isApprovedForCalendar({
      Status: "Approved",
      "Assigned Driver": "001",
      "Calendar Status": "",
      "Calendar Event ID": ""
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
      "Calendar Status": "Created",
      "Calendar Event ID": "evt_123"
    }),
    false
  );
});

test("calendar event builder and future update/delete helpers use Calendar API contracts", async () => {
  const event = buildRideCalendarEvent(
    {
      refer: "RID-1",
      assigned_driver: "001",
      pickup: "Heathrow",
      drop_off: "SW1A 1AA",
      pickup_day_date: "Friday 13th March 2026",
      starting_timing: "6:25 am",
      required_vehicle: "Saloon",
      startDateTime: new Date("2026-03-13T06:25:00.000Z")
    },
    {
      durationMinutes: 30,
      timeZone: "Europe/London"
    }
  );

  assert.match(event.summary, /Driver 001/);
  assert.match(event.description, /Drop Off: SW1A 1AA/);
  assert.equal(event.extendedProperties.private.driverId, "001");

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
