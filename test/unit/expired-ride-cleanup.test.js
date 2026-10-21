const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TARGET_SHEETS,
  normalizeShortDate,
  expiredRowNumbers,
  deleteRanges,
  cleanupExpiredRideRowsOnce
} = require("../../src/sheets/expiredRideCleanup");
const { withSheetMutation } = require("../../src/sheets/mutationQueue");

const headers = ["Refer", "Pickup Day & Date", "Starting Timing", "Pickup", "Drop Off"];

test("expiry uses UK pickup time and waits for the full one-hour grace", () => {
  assert.equal(normalizeShortDate("Tue 13th Oct 26"), "13/10/2026");
  const now = new Date("2026-10-14T12:00:00Z"); // 13:00 UK
  const values = [
    headers,
    ["old", "Tue 13th Oct 26", "8:00 pm"],
    ["boundary", "Wed 14th Oct 26", "12:00 pm"],
    ["recent", "Wed 14th Oct 26", "12:01 pm"],
    ["future", "Thu 15th Oct 26", "9:00 am"],
    ["unknown", "not a date", "9:00 am"],
    ["missing", "Wed 14th Oct 26", ""]
  ];
  assert.deepEqual(expiredRowNumbers(values, now), [2, 3]);
});

test("adjacent expired rows become one descending delete range", () => {
  assert.deepEqual(deleteRanges([8, 7, 6, 3, 2], 5), [
    { sheetId: 5, dimension: "ROWS", startIndex: 5, endIndex: 8 },
    { sheetId: 5, dimension: "ROWS", startIndex: 1, endIndex: 3 }
  ]);
});

test("cleanup physically deletes only the three ride tabs, bottom-up", async () => {
  const calls = [];
  const rowsBySheet = {
    Rides: [headers, ["a", "Tue 13th Oct 26", "8:00 pm"], ["b", "Wed 14th Oct 26", "12:30 pm"], ["c", "Tue 13th Oct 26", "9:00 pm"]],
    "Needs Review": [headers, ["d", "Tue 13th Oct 26", "8:00 pm"]],
    "Upcoming Jobs >79": [headers, ["e", "Wed 14th Oct 26", "1:00 pm"]]
  };
  const ids = new Map(TARGET_SHEETS.map((name, index) => [name, index]));
  const sheetsClient = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [
        ...TARGET_SHEETS.map((title) => ({ properties: { title, sheetId: ids.get(title) } })),
        { properties: { title: "PreBook", sheetId: 9 } },
        { properties: { title: "OTS", sheetId: 10 } }
      ] } }),
      values: {
        get: async ({ range }) => {
          const name = range.slice(1, range.indexOf("'!"));
          calls.push({ type: "read", name });
          return { data: { values: rowsBySheet[name] } };
        },
        append: async () => { throw new Error("Must not archive"); }
      },
      batchUpdate: async ({ requestBody }) => calls.push({ type: "delete", requests: requestBody.requests })
    }
  };
  const dryRun = await cleanupExpiredRideRowsOnce({
    sheetsClient,
    spreadsheetId: "test-sheet",
    now: new Date("2026-10-14T12:00:00Z"),
    dryRun: true
  });
  assert.equal(dryRun.candidates, 3);
  assert.equal(dryRun.deleted, 0);
  assert.equal(calls.filter((call) => call.type === "delete").length, 0);
  calls.length = 0;
  const result = await cleanupExpiredRideRowsOnce({
    sheetsClient,
    spreadsheetId: "test-sheet",
    now: new Date("2026-10-14T12:00:00Z")
  });
  assert.equal(result.deleted, 3);
  assert.deepEqual(calls.filter((call) => call.type === "read").map((call) => call.name), TARGET_SHEETS);
  assert.deepEqual(calls.filter((call) => call.type === "delete").flatMap((call) =>
    call.requests.map((request) => [request.deleteDimension.range.sheetId, request.deleteDimension.range.startIndex])
  ), [[0, 3], [0, 1], [1, 1]]);
});

test("missing pickup columns fail closed without deleting anything", () => {
  assert.throws(
    () => expiredRowNumbers([["Refer", "Date"], ["x", "y"]], new Date()),
    /refusing to delete/
  );
});

test("mutations on Upcoming Jobs wait for an in-progress append or sort", async () => {
  const events = [];
  let releaseFirst;
  const first = withSheetMutation("sheet", "Upcoming Jobs >79", async () => {
    events.push("append-start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("append-end");
  });
  const second = withSheetMutation("sheet", "Upcoming Jobs >79", async () => {
    events.push("cleanup");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["append-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["append-start", "append-end", "cleanup"]);
});
