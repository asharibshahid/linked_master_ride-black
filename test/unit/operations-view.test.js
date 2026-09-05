const test = require("node:test");
const assert = require("node:assert/strict");
const { FINAL_BID_HEADERS } = require("../../src/bids/finalBid");
const {
  OPERATIONS_VIEW_HEADERS,
  buildRoute,
  mapFinalBidRecordToOperationsRow,
  buildOperationsRows,
  refreshOperationsView
} = require("../../src/operations/view");

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

function createFinalBidRecord(overrides = {}) {
  return {
    Refer: "RID-1",
    "Group Name": "General Taxi Bookings",
    "Source Name": "Dispatcher",
    "Pickup Day & Date": "Friday 13th March 2026",
    "Starting Timing": "6:25 am",
    Pickup: "Heathrow",
    "Drop Off": "SW1A 1AA",
    Distance: "68",
    Fare: "145",
    "Required Vehicle": "Saloon",
    "Bid Score": "85",
    Reason: "good",
    Status: "Approved",
    "Assigned Driver": "001",
    "Calendar Status": "Created",
    "Calendar Event ID": "evt_123",
    "Created Time": "2026-07-18T12:00:00.000Z",
    ...overrides
  };
}

function recordToRow(record) {
  return FINAL_BID_HEADERS.map((header) => record[header] || "");
}

test("Operations View headers match operator schema", () => {
  assert.deepEqual(OPERATIONS_VIEW_HEADERS, [
    "Ride ID",
    "Route",
    "Date",
    "Time",
    "Fare",
    "Status",
    "Assigned Driver",
    "Calendar Status",
    "Linked Ride"
  ]);
});

test("Operations View maps Final Bid records to monitoring rows", () => {
  const record = createFinalBidRecord();
  const row = mapFinalBidRecordToOperationsRow(record);

  assert.equal(buildRoute(record), "Heathrow -> SW1A 1AA");
  assert.deepEqual(row, [
    "RID-1",
    "Heathrow -> SW1A 1AA",
    "Friday 13th March 2026",
    "6:25 am",
    "145",
    "Approved",
    "001",
    "Created",
    "RID-1"
  ]);
});

test("Operations View uses Pending as default status and skips blank ride IDs", () => {
  const rows = buildOperationsRows([
    createFinalBidRecord({ Refer: "RID-1", Status: "" }),
    createFinalBidRecord({ Refer: "" })
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0][5], "Pending");
});

test("Operations View sorts rows by pickup date and starting time", () => {
  const rows = buildOperationsRows([
    createFinalBidRecord({
      Refer: "RID-3",
      "Pickup Day & Date": "5 August 2026",
      "Starting Timing": "12:00"
    }),
    createFinalBidRecord({
      Refer: "RID-1",
      "Pickup Day & Date": "4 August 2026",
      "Starting Timing": "12:00"
    }),
    createFinalBidRecord({
      Refer: "RID-BAD",
      "Pickup Day & Date": "unknown",
      "Starting Timing": "09:00"
    }),
    createFinalBidRecord({
      Refer: "RID-2",
      "Pickup Day & Date": "Tuesday 4th August 2026",
      "Starting Timing": "08:00"
    })
  ]);

  assert.deepEqual(
    rows.map((row) => row[0]),
    ["RID-2", "RID-1", "RID-3", "RID-BAD"]
  );
});

test("refreshOperationsView clears and writes derived rows", async () => {
  const calls = [];
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          if (String(range).includes("!1:1")) {
            return {
              data: {
                values: [FINAL_BID_HEADERS]
              }
            };
          }

          return {
            data: {
              values: [
                FINAL_BID_HEADERS,
                recordToRow(
                  createFinalBidRecord({
                    Refer: "RID-2",
                    "Pickup Day & Date": "5 August 2026",
                    "Starting Timing": "12:00"
                  })
                ),
                recordToRow(
                  createFinalBidRecord({
                    Refer: "RID-1",
                    "Pickup Day & Date": "4 August 2026",
                    "Starting Timing": "08:00"
                  })
                )
              ]
            }
          };
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

  const result = await refreshOperationsView({
    sheetsClient,
    spreadsheetId: "sheet-id",
    finalBidWorksheetName: "Final Bid",
    operationsWorksheetName: "Operations View",
    logger: createSilentLogger()
  });

  assert.equal(result.rowsWritten, 2);
  assert.equal(calls[0].type, "clear");
  assert.equal(calls[0].request.range, "'Operations View'!A2:I");
  assert.equal(calls[1].type, "update");
  assert.equal(calls[1].request.range, "'Operations View'!A2:I");
  assert.deepEqual(calls[1].request.requestBody.values[0], [
    "RID-1",
    "Heathrow -> SW1A 1AA",
    "4 August 2026",
    "08:00",
    "145",
    "Approved",
    "001",
    "Created",
    "RID-1"
  ]);
});
