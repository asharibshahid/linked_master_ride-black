const test = require("node:test");
const assert = require("node:assert/strict");
const { formatOtsCopyDetail, formatPassengerLine, formatUkPickup } = require("../../src/jobLinker/detailFormatter");

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
