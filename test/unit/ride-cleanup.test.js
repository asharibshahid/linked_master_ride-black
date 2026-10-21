const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanupRide, summarizeLocation } = require("../../src/extraction/rideCleanup");
const { createLocalExtractor } = require("../../src/extraction/localExtractor");
const { buildRowFromRideObject, STRICT_SHEET_HEADERS } = require("../../src/extraction/schemas");

test("shortens full UK postcodes and airports without changing pickup date", () => {
  const input = {
    pickup_day_date: "Tuesday 13th October 2026",
    pickup: "Address42 Advent House, Levett Square, Kew, Richmond. TW9 4FA",
    drop_off: "DestinationLondon Heathrow Airport, Terminal 5"
  };
  const result = cleanupRide(input, "");
  assert.equal(result.ride.pickup, "TW9 4FA");
  assert.equal(result.ride.drop_off, "LHR T5");
  assert.equal(result.ride.pickup_day_date, input.pickup_day_date);
  assert.deepEqual(result.issues, []);
  assert.equal(summarizeLocation("BN14 ORE").value, "BN14 0RE");
  assert.equal(summarizeLocation("From: Heathrow Terminal 3").value, "LHR T3");
  assert.equal(summarizeLocation("To: GL7 2EH").value, "GL7 2EH");
  assert.equal(summarizeLocation("Heathrow Airport, Terminal 2, TW6 1EW").value, "LHR T2");
  assert.equal(summarizeLocation("Heathrow Hotel, TW6 1EW").value, "TW6 1EW");
});

test("moves booster-seat text out of the destination and splits dashed route", () => {
  const result = cleanupRide(
    { pickup: "PO6-----Heathrow", drop_off: "2&Booster Seat" },
    "PO6-----Heathrow\n2&Booster Seat"
  );
  assert.equal(result.ride.pickup, "PO6");
  assert.equal(result.ride.drop_off, "LHR");
  assert.equal(result.ride.special_instructions, "2 Booster Seats");
  assert.deepEqual(result.issues, []);
});

test("unknown place remains visible without a guessed code, instructions are not a destination", () => {
  const result = cleanupRide({ pickup: "Liverpool Cruise", drop_off: "Child Seat" }, "Child Seat");
  assert.equal(result.ride.pickup, "Liverpool Cruise");
  assert.equal(result.ride.drop_off, "");
  assert.equal(result.ride.special_instructions, "Child Seat");
  assert.deepEqual(result.issues, ["drop_off_instruction_only"]);
});

test("vehicle wording in drop-off is moved to the vehicle field", () => {
  const result = cleanupRide({ pickup: "Heathrow-----Gatwick", drop_off: "Any 9 Seater" }, "");
  assert.equal(result.ride.pickup, "LHR");
  assert.equal(result.ride.drop_off, "LGW");
  assert.equal(result.ride.required_vehicle, "9 Seater");
});

test("real parser output uses short date and separates following notes from route", () => {
  const message = "Tuesday 13th October 2026 1:00 pm\nFrom: Heathrow Terminal 5\nTo: GL7 2EH\n2 Booster Seat\nSpecial Instructions: Call passenger on arrival\nFare: GBP 120";
  const parsed = createLocalExtractor().extract(message, { received_at: "2026-10-13T09:00:00Z" });
  const result = cleanupRide(parsed, message);
  assert.equal(result.ride.pickup_day_date, "Tue 13th Oct 26");
  assert.equal(result.ride.pickup, "LHR T5");
  assert.equal(result.ride.drop_off, "GL7 2EH");
  assert.equal(result.ride.special_instructions, "2 Booster Seats; Call passenger on arrival");
});

test("instructions are appended after the existing sheet columns", () => {
  assert.equal(STRICT_SHEET_HEADERS.at(-1), "Special Instructions");
  const row = buildRowFromRideObject({ pickup: "LHR", drop_off: "BN14 0RE", special_instructions: "2 Booster Seats" });
  assert.equal(row[6], "LHR");
  assert.equal(row[7], "BN14 0RE");
  assert.equal(row.at(-1), "2 Booster Seats");
  assert.equal(row.length, 13);
});
