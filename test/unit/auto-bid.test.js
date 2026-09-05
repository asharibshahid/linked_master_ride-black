const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createAutoBidRunner,
  isApprovedBidReady,
  loadApprovedBidRows,
  processApprovedBids
} = require("../../src/bids/autoBid");

function createSheetsClient(valuesBySheet) {
  const updates = [];
  return {
    updates,
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          const match = String(range).match(/^'((?:[^']|'')+)'!/);
          const sheetName = match ? match[1].replace(/''/g, "'") : "";
          return {
            data: {
              values: valuesBySheet[sheetName] || []
            }
          };
        },
        update: async (request) => {
          updates.push(request);
          return { data: { updatedRange: request.range } };
        }
      }
    }
  };
}

function bidRows(overrides = {}) {
  return [
    [
      "Ride ID",
      "Source",
      "Pickup",
      "Drop Off",
      "Fare",
      "Required Vehicle",
      "Bid Type",
      "Bid Status",
      "Admin Status",
      "Bid Amount",
      "Reason",
      "Updated Time"
    ],
    [
      overrides.rideId || "RID-1",
      "OTS",
      "Heathrow",
      "Chelsea",
      "120",
      "MPV",
      "OTS Bid Review",
      overrides.bidStatus || "Approved",
      overrides.adminStatus || "Approved",
      "",
      "",
      ""
    ]
  ];
}

test("isApprovedBidReady only accepts admin-approved open bids", () => {
  assert.equal(
    isApprovedBidReady({ "Ride ID": "RID-1", "Admin Status": "Approved", "Bid Status": "Approved" }),
    true
  );
  assert.equal(
    isApprovedBidReady({ "Ride ID": "RID-1", "Admin Status": "Pending", "Bid Status": "Approved" }),
    false
  );
  assert.equal(
    isApprovedBidReady({ "Ride ID": "RID-1", "Admin Status": "Approved", "Bid Status": "Bid Done" }),
    false
  );
});

test("loadApprovedBidRows reads only approved rows from Bid Tracker", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": [
      bidRows()[0],
      bidRows()[1],
      ["RID-2", "OTS", "A", "B", "50", "Saloon", "OTS", "Suggested", "Pending", "", "", ""]
    ]
  });

  const rows = await loadApprovedBidRows({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker"
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]["Ride ID"], "RID-1");
});

test("processApprovedBids safe mode keeps approved bid queued and writes reason", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": bidRows()
  });

  const summary = await processApprovedBids({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker",
    mode: "safe"
  });

  assert.equal(summary.safeMode, 1);
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Approved"]]);
  assert.deepEqual(sheetsClient.updates[1].requestBody.values, [["Safe mode: approved and ready for OTS submission"]]);
});

test("processApprovedBids mirrors bid status updates to database repository", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": bidRows()
  });
  const mirrored = [];

  const summary = await processApprovedBids({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker",
    mode: "safe",
    databaseRepository: {
      updateBidStatus: async (update) => mirrored.push(update)
    }
  });

  assert.equal(summary.safeMode, 1);
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0].rideId, "RID-1");
  assert.equal(mirrored[0].bidStatus, "Approved");
});

test("processApprovedBids can run from database bids without Sheets rows", async () => {
  const updated = [];

  const summary = await processApprovedBids({
    mode: "safe",
    databaseRepository: {
      loadApprovedBidRows: async () => [
        {
          "Ride ID": "RID-DB-BID",
          Source: "OTS",
          Pickup: "Heathrow",
          "Drop Off": "Chelsea",
          Fare: "120",
          "Required Vehicle": "MPV",
          "Bid Type": "OTS Bid Review",
          "Bid Status": "Approved",
          "Admin Status": "Approved",
          "Bid Amount": "120",
          Reason: ""
        }
      ],
      updateBidStatus: async (update) => updated.push(update)
    }
  });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.safeMode, 1);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].rideId, "RID-DB-BID");
  assert.equal(updated[0].bidStatus, "Approved");
});

test("processApprovedBids live mode marks successful submit as Bid Done", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": bidRows()
  });

  const summary = await processApprovedBids({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker",
    mode: "live",
    submitBid: async (bid) => ({
      success: true,
      bidAmount: bid.fare,
      providerReference: "OTS-SUBMITTED"
    })
  });

  assert.equal(summary.submitted, 1);
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Bid Done"]]);
  assert.deepEqual(sheetsClient.updates[1].requestBody.values, [["120"]]);
});

test("processApprovedBids live mode marks submitter failure as Bid Failed", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": bidRows()
  });

  const summary = await processApprovedBids({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker",
    mode: "live",
    submitBid: async () => {
      throw new Error("portal rejected bid");
    }
  });

  assert.equal(summary.failed, 1);
  assert.deepEqual(sheetsClient.updates[0].requestBody.values, [["Bid Failed"]]);
  assert.deepEqual(sheetsClient.updates[1].requestBody.values, [["portal rejected bid"]]);
});

test("createAutoBidRunner reuses active run for concurrent manual ticks", async () => {
  const sheetsClient = createSheetsClient({
    "Bid Tracker": bidRows()
  });
  let releaseSubmit;
  const submitGate = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  let submitCalls = 0;
  const runner = createAutoBidRunner({
    sheetsClient,
    spreadsheetId: "sheet-id",
    bidTrackerWorksheetName: "Bid Tracker",
    mode: "live",
    submitBid: async (bid) => {
      submitCalls += 1;
      await submitGate;
      return {
        success: true,
        bidAmount: bid.fare,
        providerReference: "OTS-SUBMITTED"
      };
    }
  });

  const firstTick = runner.tick();
  const secondTick = runner.tick();
  releaseSubmit();
  const [firstSummary, secondSummary] = await Promise.all([firstTick, secondTick]);
  const bidDoneUpdates = sheetsClient.updates.filter(
    (update) => update.requestBody?.values?.[0]?.[0] === "Bid Done"
  );

  assert.equal(submitCalls, 1);
  assert.equal(bidDoneUpdates.length, 1);
  assert.deepEqual(firstSummary, secondSummary);
  assert.equal(firstSummary.submitted, 1);
});
