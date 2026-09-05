const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateRideAreaCriteria,
  extractAirportCodes,
  extractAreaCodes,
  extractOutwardPostcodes,
  locationMatchesAllowedArea
} = require("../../src/rules/areaCriteria");

test("extractOutwardPostcodes detects full and outward UK postcode area codes", () => {
  assert.deepEqual(extractOutwardPostcodes("KT10 0BJ to SL5"), ["KT10", "SL5"]);
  assert.deepEqual(extractOutwardPostcodes("LE16 7EF"), ["LE16"]);
});

test("extractAirportCodes detects common UK airport aliases", () => {
  assert.deepEqual(extractAirportCodes("Heathrow Terminal 5"), ["LHR"]);
  assert.deepEqual(extractAirportCodes("LGW South Terminal"), ["LGW"]);
});

test("extractAreaCodes combines postcodes and airport codes", () => {
  assert.deepEqual(extractAreaCodes("Heathrow Terminal 5 KT10 0BJ"), ["KT10", "LHR"]);
});

test("locationMatchesAllowedArea allows prefix area matches", () => {
  const result = locationMatchesAllowedArea("KT10 0BJ", ["KT"]);
  assert.equal(result.matches, true);
  assert.deepEqual(result.matched, ["KT10"]);
});

test("evaluateRideAreaCriteria supports pickup, dropoff, either, and both modes", () => {
  const ride = {
    Pickup: "Heathrow Terminal 5",
    "Drop Off": "Chelsea SW3 1AA"
  };

  assert.equal(
    evaluateRideAreaCriteria(ride, { allowedAreaCodes: ["LHR"], matchMode: "pickup" }).eligible,
    true
  );
  assert.equal(
    evaluateRideAreaCriteria(ride, { allowedAreaCodes: ["SW3"], matchMode: "dropoff" }).eligible,
    true
  );
  assert.equal(
    evaluateRideAreaCriteria(ride, { allowedAreaCodes: ["SW3"], matchMode: "either" }).eligible,
    true
  );
  assert.equal(
    evaluateRideAreaCriteria(ride, { allowedAreaCodes: ["LHR", "SW3"], matchMode: "both" }).eligible,
    true
  );
  assert.equal(
    evaluateRideAreaCriteria(ride, { allowedAreaCodes: ["LHR"], matchMode: "both" }).eligible,
    false
  );
});
