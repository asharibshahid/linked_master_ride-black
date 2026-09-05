const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateBidPricing, estimateDistanceMiles } = require("../../src/bids/pricingEngine");

const RIDE = {
  Refer: "RID-PRICE-1",
  Pickup: "Heathrow Terminal 5",
  "Drop Off": "Chelsea London",
  Distance: "19 mi",
  Fare: "120",
  "Required Vehicle": "MPV"
};

test("pricing engine creates a profitable bid instead of copying fare", () => {
  const result = calculateBidPricing(RIDE);

  assert.equal(result.suggestedBid < 120, true);
  assert.equal(result.estimatedCost > 0, true);
  assert.equal(result.estimatedProfit > 0, true);
  assert.equal(result.marginPercent >= 20, true);
  assert.equal(result.decision, "Ready for Review");
});

test("pricing engine flags an unprofitable quoted fare for review", () => {
  const result = calculateBidPricing({ ...RIDE, Fare: "30", Distance: "80 mi" });

  assert.equal(result.decision, "Review Required");
  assert.match(result.reason, /below the profitable floor/i);
});

test("linked route saving reduces the cost floor", () => {
  const normal = calculateBidPricing(RIDE);
  const linked = calculateBidPricing(RIDE, { linkedSaving: 10 });

  assert.equal(linked.estimatedCost < normal.estimatedCost, true);
  assert.equal(linked.linkedSaving, 10);
});

test("distance parser converts kilometre routes", () => {
  const result = estimateDistanceMiles({ Distance: "100 km" });
  assert.equal(result.miles > 62 && result.miles < 63, true);
  assert.equal(result.source, "km");
});
