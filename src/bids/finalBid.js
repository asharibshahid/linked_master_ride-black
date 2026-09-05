const { parseBoolean, parseNumber, parseArray } = require("../config/env");
const { evaluateRideAreaCriteria } = require("../rules/areaCriteria");
const { safeTrim, collapseWhitespace } = require("../utils/text");

const FINAL_BID_HEADERS = Object.freeze([
  "Refer",
  "Group Name",
  "Source Name",
  "Pickup Day & Date",
  "Starting Timing",
  "Pickup",
  "Drop Off",
  "Distance",
  "Fare",
  "Required Vehicle",
  "Bid Score",
  "Reason",
  "Status",
  "Assigned Driver",
  "Payment Status",
  "Passenger Count",
  "Calendar Status",
  "Calendar Event ID",
  "Calendar Created Time",
  "Calendar Error",
  "Created Time"
]);

const PASSENGER_COUNT_PATTERN = /(\d{1,2})\s*(?:persons?|pax|passengers?)\b/i;

function resolvePassengerCount(ride = {}) {
  const explicit = toCell(ride.passenger_count || ride["Passenger Count"]);
  if (/^\d+$/.test(explicit)) return explicit;

  const vehicleText = toCell(ride.required_vehicle || ride["Required Vehicle"]);
  const match = vehicleText.match(PASSENGER_COUNT_PATTERN);
  return match ? match[1] : "";
}

const DEFAULT_FINAL_BID_CONFIG = Object.freeze({
  enabled: true,
  minFare: 80,
  minDistance: 0,
  maxDistance: 0,
  minScore: 60,
  allowedVehicles: [],
  excludedVehicles: [],
  allowedGroups: [],
  allowedAreaCodes: [],
  areaMatchMode: "either",
  requireFare: true,
  requireDistance: false
});

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeComparableText(value) {
  return collapseWhitespace(String(value || "")).toLowerCase();
}

function parseNumericCell(value) {
  const text = toCell(value).replace(/,/g, "");
  if (!text) return null;

  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeList(value) {
  return (Array.isArray(value) ? value : parseArray(value))
    .map((item) => normalizeComparableText(item))
    .filter(Boolean);
}

function includesNormalized(list, value) {
  const normalizedValue = normalizeComparableText(value);
  if (!normalizedValue) return false;
  return list.some((item) => normalizedValue === item || normalizedValue.includes(item));
}

function resolveFinalBidConfig(config = {}) {
  return {
    enabled: parseBoolean(config.enabled, DEFAULT_FINAL_BID_CONFIG.enabled),
    minFare: parseNumber(config.minFare, DEFAULT_FINAL_BID_CONFIG.minFare, { min: 0 }),
    minDistance: parseNumber(config.minDistance, DEFAULT_FINAL_BID_CONFIG.minDistance, { min: 0 }),
    maxDistance: parseNumber(config.maxDistance, DEFAULT_FINAL_BID_CONFIG.maxDistance, { min: 0 }),
    minScore: parseNumber(config.minScore, DEFAULT_FINAL_BID_CONFIG.minScore, {
      min: 0,
      max: 100
    }),
    allowedVehicles: normalizeList(config.allowedVehicles),
    excludedVehicles: normalizeList(config.excludedVehicles),
    allowedGroups: normalizeList(config.allowedGroups),
    allowedAreaCodes: parseArray(config.allowedAreaCodes),
    areaMatchMode: toCell(config.areaMatchMode || DEFAULT_FINAL_BID_CONFIG.areaMatchMode),
    requireFare: parseBoolean(config.requireFare, DEFAULT_FINAL_BID_CONFIG.requireFare),
    requireDistance: parseBoolean(
      config.requireDistance,
      DEFAULT_FINAL_BID_CONFIG.requireDistance
    )
  };
}

function readRideField(ride = {}, canonicalField, headerName) {
  return toCell(ride[canonicalField] || ride[headerName] || "");
}

function evaluateFinalBidRide(ride = {}, options = {}) {
  const config = resolveFinalBidConfig(options.config || options);
  const reasons = [];
  const failedRules = [];

  if (!config.enabled) {
    return {
      eligible: false,
      score: 0,
      reason: "Final Bid disabled",
      failedRules: ["disabled"],
      config
    };
  }

  const refer = readRideField(ride, "refer", "Refer");
  const groupName = readRideField(ride, "group_name", "Group Name");
  const pickupDayDate = readRideField(ride, "pickup_day_date", "Pickup Day & Date");
  const startingTiming = readRideField(ride, "starting_timing", "Starting Timing");
  const pickup = readRideField(ride, "pickup", "Pickup");
  const dropOff = readRideField(ride, "drop_off", "Drop Off");
  const distanceText = readRideField(ride, "distance", "Distance");
  const fareText = readRideField(ride, "fare", "Fare");
  const vehicle = readRideField(ride, "required_vehicle", "Required Vehicle");
  const fare = parseNumericCell(fareText);
  const distance = parseNumericCell(distanceText);
  let score = 0;

  if (!pickup) failedRules.push("pickup_missing");
  if (!dropOff) failedRules.push("drop_off_missing");
  if (!pickupDayDate) failedRules.push("pickup_day_date_missing");
  if (!startingTiming) failedRules.push("starting_timing_missing");

  if (config.allowedGroups.length > 0 && !includesNormalized(config.allowedGroups, groupName)) {
    failedRules.push("group_not_allowed");
  } else if (groupName) {
    score += 10;
    reasons.push(`group ${groupName} accepted`);
  }

  const areaCriteria = evaluateRideAreaCriteria(
    {
      Pickup: pickup,
      "Drop Off": dropOff
    },
    {
      allowedAreaCodes: config.allowedAreaCodes,
      matchMode: config.areaMatchMode
    }
  );
  if (!areaCriteria.eligible) {
    failedRules.push("area_not_allowed");
    reasons.push(
      `area not allowed (${areaCriteria.mode || "either"}; allowed ${config.allowedAreaCodes.join(", ")})`
    );
  } else if (config.allowedAreaCodes.length > 0) {
    score += 10;
    reasons.push("area accepted");
  }

  if (fare === null) {
    if (config.requireFare) failedRules.push("fare_missing");
  } else if (fare < config.minFare) {
    failedRules.push("fare_below_minimum");
    reasons.push(`fare ${fare} below ${config.minFare}`);
  } else {
    score += 35;
    reasons.push(`fare ${fare} >= ${config.minFare}`);
  }

  if (distance === null) {
    if (config.requireDistance) failedRules.push("distance_missing");
  } else if (config.minDistance > 0 && distance < config.minDistance) {
    failedRules.push("distance_below_minimum");
    reasons.push(`distance ${distance} below ${config.minDistance}`);
  } else if (config.maxDistance > 0 && distance > config.maxDistance) {
    failedRules.push("distance_above_maximum");
    reasons.push(`distance ${distance} above ${config.maxDistance}`);
  } else {
    score += 25;
    reasons.push(`distance ${distance} accepted`);
  }

  if (config.allowedVehicles.length > 0 && !includesNormalized(config.allowedVehicles, vehicle)) {
    failedRules.push("vehicle_not_allowed");
  } else if (config.excludedVehicles.length > 0 && includesNormalized(config.excludedVehicles, vehicle)) {
    failedRules.push("vehicle_excluded");
  } else if (vehicle) {
    score += 15;
    reasons.push(`vehicle ${vehicle} accepted`);
  }

  if (refer) score += 5;
  if (pickup && dropOff && pickupDayDate && startingTiming) {
    score += 10;
    reasons.push("required ride fields present");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (failedRules.length === 0 && score < config.minScore) {
    failedRules.push("score_below_minimum");
    reasons.push(`score ${score} below ${config.minScore}`);
  }

  return {
    eligible: failedRules.length === 0,
    score,
    reason: reasons.length > 0 ? reasons.join("; ") : failedRules.join("; "),
    failedRules,
    config
  };
}

function buildFinalBidSheetRowObject({ ride = {}, evaluation = {}, createdTime = "" } = {}) {
  return {
    Refer: readRideField(ride, "refer", "Refer"),
    "Group Name": readRideField(ride, "group_name", "Group Name"),
    "Source Name": readRideField(ride, "source_name", "Source Name"),
    "Pickup Day & Date": readRideField(ride, "pickup_day_date", "Pickup Day & Date"),
    "Starting Timing": readRideField(ride, "starting_timing", "Starting Timing"),
    Pickup: readRideField(ride, "pickup", "Pickup"),
    "Drop Off": readRideField(ride, "drop_off", "Drop Off"),
    Distance: readRideField(ride, "distance", "Distance"),
    Fare: readRideField(ride, "fare", "Fare"),
    "Required Vehicle": readRideField(ride, "required_vehicle", "Required Vehicle"),
    "Bid Score": toCell(evaluation.score),
    Reason: toCell(evaluation.reason),
    Status: "Pending",
    "Assigned Driver": "",
    "Payment Status": readRideField(ride, "payment_status", "Payment Status"),
    "Passenger Count": resolvePassengerCount(ride),
    "Calendar Status": "",
    "Calendar Event ID": "",
    "Calendar Created Time": "",
    "Calendar Error": "",
    "Created Time": toCell(createdTime) || new Date().toISOString()
  };
}

function buildFinalBidSheetRow(record = {}, headers = FINAL_BID_HEADERS) {
  const safeHeaders = Array.isArray(headers) && headers.length > 0 ? headers : FINAL_BID_HEADERS;
  return safeHeaders.map((header) => toCell(record[header]));
}

function createFinalBidAppender(options = {}) {
  const appendRow = options.appendRow;
  const logger = {
    info: typeof options.logger?.info === "function" ? options.logger.info.bind(options.logger) : () => {},
    warn: typeof options.logger?.warn === "function" ? options.logger.warn.bind(options.logger) : () => {},
    debug: typeof options.logger?.debug === "function" ? options.logger.debug.bind(options.logger) : () => {},
    error: typeof options.logger?.error === "function" ? options.logger.error.bind(options.logger) : () => {}
  };
  const config = resolveFinalBidConfig(options.config || {});

  return async function appendFinalBidIfEligible(ride = {}) {
    const activeConfig =
      typeof options.configProvider === "function"
        ? resolveFinalBidConfig(await options.configProvider({ ride, baseConfig: config }))
        : config;
    const evaluation = evaluateFinalBidRide(ride, { config: activeConfig });
    if (!evaluation.eligible) {
      logger.debug("Final Bid skipped", {
        stage: "final_bid",
        fallbackUsed: true,
        refer: readRideField(ride, "refer", "Refer"),
        reason: evaluation.failedRules.join(", ") || evaluation.reason,
        bidScore: evaluation.score
      });

      return {
        appended: false,
        reason: evaluation.failedRules.join(", ") || evaluation.reason,
        evaluation
      };
    }

    if (typeof appendRow !== "function") {
      throw new Error("Final Bid append function is not configured");
    }

    const payload = buildFinalBidSheetRowObject({
      ride,
      evaluation,
      createdTime:
        typeof options.now === "function"
          ? options.now().toISOString()
          : options.now instanceof Date
            ? options.now.toISOString()
            : ""
    });

    await appendRow(payload);

    logger.info("Final Bid appended", {
      stage: "final_bid",
      fallbackUsed: false,
      refer: payload.Refer,
      bidScore: evaluation.score,
      reason: evaluation.reason
    });

    return {
      appended: true,
      reason: "appended",
      evaluation,
      payload
    };
  };
}

module.exports = {
  FINAL_BID_HEADERS,
  DEFAULT_FINAL_BID_CONFIG,
  resolveFinalBidConfig,
  parseNumericCell,
  evaluateFinalBidRide,
  buildFinalBidSheetRowObject,
  buildFinalBidSheetRow,
  createFinalBidAppender
};
