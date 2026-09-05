const { parseArray, parseNumber, parseBoolean } = require("../config/env");
const { safeTrim } = require("../utils/text");

const DISPATCH_CRITERIA_WORKSHEET_NAME = "Dispatch Criteria";

const DISPATCH_CRITERIA_HEADERS = Object.freeze([
  "Setting",
  "Value",
  "Description",
  "Updated Time"
]);

const CRITERIA_KEYS = Object.freeze({
  FINAL_BID_MIN_FARE: "FINAL_BID_MIN_FARE",
  FINAL_BID_ALLOWED_AREA_CODES: "FINAL_BID_ALLOWED_AREA_CODES",
  FINAL_BID_AREA_MATCH_MODE: "FINAL_BID_AREA_MATCH_MODE",
  FINAL_BID_ALLOWED_VEHICLES: "FINAL_BID_ALLOWED_VEHICLES",
  FINAL_BID_EXCLUDED_VEHICLES: "FINAL_BID_EXCLUDED_VEHICLES",
  AUTO_BID_ENABLED: "AUTO_BID_ENABLED",
  AUTO_BID_MODE: "AUTO_BID_MODE"
});

const CRITERIA_DESCRIPTIONS = Object.freeze({
  FINAL_BID_MIN_FARE: "Minimum fare required before a ride enters Final Bid.",
  FINAL_BID_ALLOWED_AREA_CODES: "Comma-separated allowed pickup/dropoff area codes, e.g. LHR,LGW,SW3.",
  FINAL_BID_AREA_MATCH_MODE: "Area matching mode: either, pickup, dropoff, or both.",
  FINAL_BID_ALLOWED_VEHICLES: "Comma-separated allowed vehicle types. Blank means any.",
  FINAL_BID_EXCLUDED_VEHICLES: "Comma-separated blocked vehicle types.",
  AUTO_BID_ENABLED: "Whether auto-bid worker may process admin-approved bids.",
  AUTO_BID_MODE: "Auto-bid mode: safe or live."
});

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeKey(value) {
  return safeTrim(value).toUpperCase();
}

function criteriaRowsFromDefaults(defaults = {}, now = new Date()) {
  const updatedTime = now.toISOString();
  return Object.values(CRITERIA_KEYS).map((key) => [
    key,
    toCell(defaults[key]),
    CRITERIA_DESCRIPTIONS[key] || "",
    updatedTime
  ]);
}

function mapCriteriaRows(records = []) {
  const out = {};
  for (const record of Array.isArray(records) ? records : []) {
    const key = normalizeKey(record.Setting || record.setting);
    if (!key) continue;
    out[key] = toCell(record.Value || record.value);
  }
  return out;
}

function resolveCriteriaConfig(criteria = {}, env = {}) {
  const read = (key, fallback = "") =>
    Object.prototype.hasOwnProperty.call(criteria, key) ? criteria[key] : fallback;

  return {
    minFare: parseNumber(read(CRITERIA_KEYS.FINAL_BID_MIN_FARE, env.finalBidMinFare), env.finalBidMinFare || 80, {
      min: 0
    }),
    allowedAreaCodes: parseArray(
      read(CRITERIA_KEYS.FINAL_BID_ALLOWED_AREA_CODES, (env.finalBidAllowedAreaCodes || []).join(","))
    ),
    areaMatchMode: safeTrim(
      read(CRITERIA_KEYS.FINAL_BID_AREA_MATCH_MODE, env.finalBidAreaMatchMode || "either")
    ).toLowerCase() || "either",
    allowedVehicles: parseArray(
      read(CRITERIA_KEYS.FINAL_BID_ALLOWED_VEHICLES, (env.finalBidAllowedVehicles || []).join(","))
    ),
    excludedVehicles: parseArray(
      read(CRITERIA_KEYS.FINAL_BID_EXCLUDED_VEHICLES, (env.finalBidExcludedVehicles || []).join(","))
    ),
    autoBidEnabled: parseBoolean(
      read(CRITERIA_KEYS.AUTO_BID_ENABLED, env.autoBidEnabled ? "true" : "false"),
      Boolean(env.autoBidEnabled)
    ),
    autoBidMode:
      safeTrim(read(CRITERIA_KEYS.AUTO_BID_MODE, env.autoBidMode || "safe")).toLowerCase() ||
      "safe"
  };
}

function buildEnvCriteriaDefaults(env = {}) {
  return {
    FINAL_BID_MIN_FARE: env.finalBidMinFare,
    FINAL_BID_ALLOWED_AREA_CODES: (env.finalBidAllowedAreaCodes || []).join(","),
    FINAL_BID_AREA_MATCH_MODE: env.finalBidAreaMatchMode || "either",
    FINAL_BID_ALLOWED_VEHICLES: (env.finalBidAllowedVehicles || []).join(","),
    FINAL_BID_EXCLUDED_VEHICLES: (env.finalBidExcludedVehicles || []).join(","),
    AUTO_BID_ENABLED: env.autoBidEnabled ? "true" : "false",
    AUTO_BID_MODE: env.autoBidMode || "safe"
  };
}

module.exports = {
  DISPATCH_CRITERIA_WORKSHEET_NAME,
  DISPATCH_CRITERIA_HEADERS,
  CRITERIA_KEYS,
  CRITERIA_DESCRIPTIONS,
  criteriaRowsFromDefaults,
  mapCriteriaRows,
  resolveCriteriaConfig,
  buildEnvCriteriaDefaults
};
