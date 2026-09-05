const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CRITERIA_KEYS,
  criteriaRowsFromDefaults,
  mapCriteriaRows,
  resolveCriteriaConfig
} = require("../../src/settings/criteria");

test("criteriaRowsFromDefaults creates key/value Dispatch Criteria rows", () => {
  const rows = criteriaRowsFromDefaults({
    FINAL_BID_MIN_FARE: "90",
    FINAL_BID_ALLOWED_AREA_CODES: "LHR,SW3",
    AUTO_BID_MODE: "safe"
  }, new Date("2026-08-12T10:00:00.000Z"));

  assert.equal(rows.length, Object.keys(CRITERIA_KEYS).length);
  assert.deepEqual(rows[0].slice(0, 2), ["FINAL_BID_MIN_FARE", "90"]);
  assert.equal(rows[0][3], "2026-08-12T10:00:00.000Z");
});

test("mapCriteriaRows and resolveCriteriaConfig build runtime config", () => {
  const criteria = mapCriteriaRows([
    { Setting: "FINAL_BID_MIN_FARE", Value: "100" },
    { Setting: "FINAL_BID_ALLOWED_AREA_CODES", Value: "LHR, SW3" },
    { Setting: "FINAL_BID_AREA_MATCH_MODE", Value: "pickup" },
    { Setting: "AUTO_BID_ENABLED", Value: "true" },
    { Setting: "AUTO_BID_MODE", Value: "live" }
  ]);
  const config = resolveCriteriaConfig(criteria, {
    finalBidMinFare: 80,
    finalBidAllowedAreaCodes: [],
    finalBidAreaMatchMode: "either",
    finalBidAllowedVehicles: [],
    finalBidExcludedVehicles: [],
    autoBidEnabled: false,
    autoBidMode: "safe"
  });

  assert.equal(config.minFare, 100);
  assert.deepEqual(config.allowedAreaCodes, ["LHR", "SW3"]);
  assert.equal(config.areaMatchMode, "pickup");
  assert.equal(config.autoBidEnabled, true);
  assert.equal(config.autoBidMode, "live");
});
