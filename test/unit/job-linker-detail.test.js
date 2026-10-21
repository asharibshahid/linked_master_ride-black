const test = require("node:test");
const assert = require("node:assert/strict");
const { formatBidPrice, formatGuideLine, formatOtsCopyDetail, formatPassengerLine, formatUkPickup } = require("../../src/jobLinker/detailFormatter");

test("OTS Copy Detail uses exact source fields and UK summer time", () => {
  const result = formatOtsCopyDetail({
    rideId: "OTS-05092026131453-98704-1",
    pickup: "Heathrow Airport, Terminal 2",
    dropOff: "Willow Avenue, Torquay, TQ2 8DH",
    pickupAt: "2026-09-06T11:55:00.000Z",
    requiredVehicle: "Saloon Car",
    passengerCount: 1,
    luggageDetails: "Suitcases",
    guidePriceText: "As a guide, we are expecting prices between £158.00 and £186.00."
  });
  assert.equal(result, [
    "OTS-05092026131453-98704-1",
    "",
    "Route:",
    "\t• Heathrow Airport, Terminal 2",
    "\t• Willow Avenue, Torquay, TQ2 8DH",
    "",
    "Pick up at 12:55 pm, Sun 6th Sep 2026 (BST)",
    "Travelling by Saloon Car",
    "Carrying 1 passenger with Suitcases",
    "",
    "As a guide, we are expecting prices between £158.00 and £186.00."
  ].join("\n"));
});

test("Copy Detail uses GMT in winter and never invents passengers", () => {
  assert.match(formatUkPickup("2026-12-06T12:55:00.000Z"), /\(GMT\)$/);
  assert.equal(formatPassengerLine({ luggageDetails: "Suitcases" }), "");
  assert.equal(formatPassengerLine({ passengerCount: 2 }), "Carrying 2 passengers");
});

test("Bid Copy Detail includes the persisted bid price", () => {
  const result = formatOtsCopyDetail({
    rideId: "OTS-BID-1",
    pickup: "Heathrow Airport, Terminal 5",
    dropOff: "York Avenue, New Milton, BH25 6BT",
    bidAmount: 125
  });
  assert.match(result, /Bid price: £125\.00$/);
  assert.equal(formatBidPrice({}), "");
});

test("Bid Copy Detail always explains full, partial or unavailable OTS guide data", () => {
  assert.equal(formatGuideLine({ guidePriceMin: 76, guidePriceMax: 89 }), "As a guide, we are expecting prices between £76.00 and £89.00.");
  assert.equal(formatGuideLine({ guidePriceMax: 241 }), "OTS guide maximum: £241.00 (minimum unavailable in source snapshot).");
  assert.equal(formatGuideLine({ bidAmount: 236 }), "OTS guide price unavailable in source snapshot.");
  assert.match(formatOtsCopyDetail({ rideId: "OTS-MISSING", bidAmount: 236 }), /OTS guide price unavailable in source snapshot\./);
});
