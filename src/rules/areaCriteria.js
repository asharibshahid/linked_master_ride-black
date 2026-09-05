const { safeTrim, collapseWhitespace } = require("../utils/text");

const DEFAULT_AREA_MATCH_MODE = "either";

const AIRPORT_ALIASES = Object.freeze({
  LHR: ["lhr", "heathrow"],
  LGW: ["lgw", "gatwick"],
  STN: ["stn", "stansted"],
  LTN: ["ltn", "luton"],
  LCY: ["lcy", "city airport", "london city"],
  SEN: ["sen", "southend"],
  BHX: ["bhx", "birmingham airport"],
  MAN: ["man", "manchester airport"]
});

function normalizeCode(value) {
  return safeTrim(value).replace(/\s+/g, "").toUpperCase();
}

function normalizeAreaCodes(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(normalizeCode)
    .filter(Boolean);
}

function normalizeText(value) {
  return collapseWhitespace(String(value || "")).toLowerCase();
}

function extractOutwardPostcodes(value) {
  const text = String(value || "").toUpperCase();
  const matches = text.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g) || [];
  const out = [];
  for (const match of matches) {
    const outward = match.replace(/\s+/g, "").match(/^[A-Z]{1,2}\d[A-Z\d]?/);
    if (outward?.[0]) out.push(outward[0]);
  }

  const outwardOnly = text.match(/\b[A-Z]{1,2}\d[A-Z\d]?\b/g) || [];
  for (const match of outwardOnly) out.push(match.replace(/\s+/g, ""));

  return [...new Set(out)];
}

function extractAirportCodes(value) {
  const text = normalizeText(value);
  const codes = [];
  for (const [code, aliases] of Object.entries(AIRPORT_ALIASES)) {
    if (aliases.some((alias) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text))) {
      codes.push(code);
    }
  }
  return codes;
}

function extractAreaCodes(value) {
  return [...new Set([...extractOutwardPostcodes(value), ...extractAirportCodes(value)])];
}

function codeMatchesAllowed(code, allowedCode) {
  const normalizedCode = normalizeCode(code);
  const normalizedAllowed = normalizeCode(allowedCode);
  if (!normalizedCode || !normalizedAllowed) return false;
  return normalizedCode === normalizedAllowed || normalizedCode.startsWith(normalizedAllowed);
}

function locationMatchesAllowedArea(value, allowedAreaCodes = []) {
  const detected = extractAreaCodes(value);
  const allowed = normalizeAreaCodes(allowedAreaCodes);
  if (allowed.length === 0) {
    return { matches: true, detected, allowed, reason: "area_filter_disabled" };
  }

  const matched = detected.filter((code) =>
    allowed.some((allowedCode) => codeMatchesAllowed(code, allowedCode))
  );

  return {
    matches: matched.length > 0,
    detected,
    allowed,
    matched,
    reason: matched.length > 0 ? `matched_area_${matched.join(",")}` : "area_not_allowed"
  };
}

function evaluateRideAreaCriteria(ride = {}, options = {}) {
  const allowedAreaCodes = normalizeAreaCodes(options.allowedAreaCodes);
  const mode = safeTrim(options.matchMode || DEFAULT_AREA_MATCH_MODE).toLowerCase();
  if (allowedAreaCodes.length === 0) {
    return {
      eligible: true,
      reason: "area_filter_disabled",
      pickup: locationMatchesAllowedArea(ride.Pickup || ride.pickup, []),
      dropOff: locationMatchesAllowedArea(ride["Drop Off"] || ride.drop_off, [])
    };
  }

  const pickup = locationMatchesAllowedArea(ride.Pickup || ride.pickup, allowedAreaCodes);
  const dropOff = locationMatchesAllowedArea(ride["Drop Off"] || ride.drop_off, allowedAreaCodes);
  let eligible;
  if (mode === "pickup") eligible = pickup.matches;
  else if (mode === "dropoff" || mode === "drop_off") eligible = dropOff.matches;
  else if (mode === "both") eligible = pickup.matches && dropOff.matches;
  else eligible = pickup.matches || dropOff.matches;

  return {
    eligible,
    mode: ["pickup", "dropoff", "drop_off", "both", "either"].includes(mode) ? mode : "either",
    reason: eligible ? "area_allowed" : "area_not_allowed",
    pickup,
    dropOff
  };
}

module.exports = {
  AIRPORT_ALIASES,
  DEFAULT_AREA_MATCH_MODE,
  normalizeAreaCodes,
  extractOutwardPostcodes,
  extractAirportCodes,
  extractAreaCodes,
  locationMatchesAllowedArea,
  evaluateRideAreaCriteria
};
