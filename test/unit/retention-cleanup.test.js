const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ARCHIVE_HEADERS,
  buildArchiveRowObject,
  buildArchiveSheetRow,
  buildDefaultRetentionTargets,
  cleanupRetentionOnce,
  shouldArchiveRecord
} = require("../../src/retention/cleanup");

function createSheetsClient(valuesBySheet = {}) {
  const appended = [];
  const batchUpdates = [];
  return {
    appended,
    batchUpdates,
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: Object.keys(valuesBySheet).map((title, index) => ({
            properties: { title, sheetId: index + 100 }
          }))
        }
      }),
      values: {
        get: async ({ range }) => {
          const match = String(range).match(/^'((?:[^']|'')+)'!/);
          const sheetName = match ? match[1].replace(/''/g, "'") : String(range).split("!")[0];
          return { data: { values: valuesBySheet[sheetName] || [] } };
        },
        append: async (request) => {
          appended.push(request);
          return { data: { updates: { updatedRows: request.requestBody.values.length } } };
        }
      },
      batchUpdate: async (request) => {
        batchUpdates.push(request);
        return { data: {} };
      }
    }
  };
}

test("shouldArchiveRecord protects future rides even when status is closed", () => {
  const now = new Date("2026-08-12T09:00:00.000Z");
  const decision = shouldArchiveRecord(
    {
      Refer: "RID-FUTURE",
      Status: "Approved",
      "Calendar Status": "Created",
      "Pickup Day & Date": "21 September 2026",
      "Starting Timing": "10:00"
    },
    {
      retentionDays: 10,
      closedStatuses: ["Created"]
    },
    { now, timeZone: "Europe/London" }
  );

  assert.equal(decision.archive, false);
  assert.equal(decision.reason, "future_record_protected");
});

test("cleanupRetentionOnce archives old closed rows and deletes only those source rows", async () => {
  const now = new Date("2026-08-12T09:00:00.000Z");
  const sheetsClient = createSheetsClient({
    "Final Bid": [
      ["Refer", "Status", "Calendar Status", "Pickup Day & Date", "Starting Timing"],
      ["RID-OLD", "Approved", "Created", "1 August 2026", "10:00"],
      ["RID-FUTURE", "Approved", "Created", "21 September 2026", "10:00"],
      ["RID-PENDING", "Pending", "", "1 August 2026", "10:00"]
    ],
    "Ride Archive": [ARCHIVE_HEADERS]
  });

  const summary = await cleanupRetentionOnce({
    sheetsClient,
    spreadsheetId: "sheet-id",
    archiveWorksheetName: "Ride Archive",
    targets: [
      {
        worksheetName: "Final Bid",
        retentionDays: 10,
        reason: "final_bid_closed",
        closedStatuses: ["Created", "Rejected"]
      }
    ],
    now,
    timeZone: "Europe/London"
  });

  assert.equal(summary.scanned, 3);
  assert.equal(summary.archived, 1);
  assert.equal(summary.deleted, 1);
  assert.equal(sheetsClient.appended.length, 1);
  assert.equal(sheetsClient.appended[0].requestBody.values.length, 1);
  assert.equal(sheetsClient.appended[0].requestBody.values[0][4], "RID-OLD");
  assert.equal(sheetsClient.batchUpdates.length, 1);
  assert.deepEqual(
    sheetsClient.batchUpdates[0].requestBody.requests.map(
      (request) => request.deleteDimension.range.startIndex
    ),
    [1]
  );
});

test("cleanupRetentionOnce dry run reports candidates without appending or deleting", async () => {
  const now = new Date("2026-08-12T09:00:00.000Z");
  const sheetsClient = createSheetsClient({
    "Bid Tracker": [
      ["Ride ID", "Bid Status", "Updated Time"],
      ["RID-OLD", "Bid Done", "2026-07-20T10:00:00.000Z"]
    ],
    "Ride Archive": [ARCHIVE_HEADERS]
  });

  const summary = await cleanupRetentionOnce({
    sheetsClient,
    spreadsheetId: "sheet-id",
    archiveWorksheetName: "Ride Archive",
    targets: [
      {
        worksheetName: "Bid Tracker",
        retentionDays: 10,
        reason: "bid_closed",
        closedStatuses: ["Bid Done"]
      }
    ],
    now,
    dryRun: true
  });

  assert.equal(summary.archived, 1);
  assert.equal(summary.deleted, 0);
  assert.equal(sheetsClient.appended.length, 0);
  assert.equal(sheetsClient.batchUpdates.length, 0);
});

test("buildArchiveSheetRow stores source snapshot in archive schema", () => {
  const record = buildArchiveRowObject({
    sourceSheet: "Final Bid",
    sourceRow: 4,
    reason: "final_bid_closed_older_than_10_days",
    record: {
      Refer: "RID-1",
      Status: "Rejected",
      Pickup: "Heathrow"
    },
    archivedTime: "2026-08-12T09:00:00.000Z"
  });

  const row = buildArchiveSheetRow(record);

  assert.equal(row.length, ARCHIVE_HEADERS.length);
  assert.equal(row[1], "Final Bid");
  assert.equal(row[2], "4");
  assert.equal(row[4], "RID-1");
  assert.match(row[9], /Heathrow/);
});

test("buildDefaultRetentionTargets includes operational sheets only", () => {
  const targets = buildDefaultRetentionTargets({
    googleFinalBidWorksheetName: "Final Bid",
    googleDriverScheduleWorksheetName: "Driver Schedule",
    googleVehicleScheduleWorksheetName: "Vehicle Schedule",
    googleLinkedRidesWorksheetName: "Linked Rides",
    googleBidTrackerWorksheetName: "Bid Tracker",
    googleAuditLogWorksheetName: "Audit Log"
  });

  assert.equal(targets.some((target) => target.worksheetName === "Final Bid"), true);
  assert.equal(targets.some((target) => target.worksheetName === "Rides"), false);
});
