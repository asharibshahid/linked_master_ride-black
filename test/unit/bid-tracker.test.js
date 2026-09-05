const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BID_TRACKER_HEADERS,
  buildBidTrackerRowObject,
  buildBidTrackerSheetRow,
  buildSuggestedBidEntries,
  hasBidTrackerEntry,
  shouldSuggestBid
} = require("../../src/bids/tracker");

const FINAL_BID_RIDE = {
  Refer: "RID-1",
  "Group Name": "OTS",
  "Source Name": "OTS Supplier Portal",
  Pickup: "Heathrow",
  "Drop Off": "Chelsea",
  Fare: "120",
  "Required Vehicle": "MPV",
  Status: "Pending"
};

test("buildBidTrackerRowObject maps a ride into Bid Tracker schema", () => {
  const record = buildBidTrackerRowObject({
    ride: FINAL_BID_RIDE,
    bidType: "OTS Bid Review",
    reason: "eligible"
  });
  const row = buildBidTrackerSheetRow(record, BID_TRACKER_HEADERS);

  assert.equal(record["Ride ID"], "RID-1");
  assert.equal(record.Source, "OTS");
  assert.equal(record["Bid Type"], "OTS Bid Review");
  assert.equal(record["Bid Status"], "Suggested");
  assert.equal(record["Admin Status"], "Pending");
  assert.equal(record.Reason, "eligible");
  assert.equal(row.length, BID_TRACKER_HEADERS.length);
});

test("shouldSuggestBid rejects closed rides and low fare rides", () => {
  assert.equal(shouldSuggestBid(FINAL_BID_RIDE, { minFare: 80 }).suggested, true);
  assert.equal(
    shouldSuggestBid({ ...FINAL_BID_RIDE, Status: "Rejected" }, { minFare: 80 }).suggested,
    false
  );
  assert.equal(
    shouldSuggestBid({ ...FINAL_BID_RIDE, Fare: "40" }, { minFare: 80 }).suggested,
    false
  );
});

test("buildSuggestedBidEntries skips rides already in Bid Tracker", () => {
  const first = buildSuggestedBidEntries([FINAL_BID_RIDE], [], { minFare: 80 });
  const second = buildSuggestedBidEntries([FINAL_BID_RIDE], [{ "Ride ID": "RID-1" }], {
    minFare: 80
  });

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(hasBidTrackerEntry(first, "RID-1"), true);
  assert.notEqual(first[0]["Bid Amount"], FINAL_BID_RIDE.Fare);
  assert.equal(first[0]["AI Decision"], "Review Recommended");
});
