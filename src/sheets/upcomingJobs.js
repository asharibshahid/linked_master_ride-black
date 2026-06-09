const { env } = require("../config/env");
const { buildSheetRowObject } = require("../extraction/schemas");
const { buildAppendRange, classifyAppendFailure, fetchSheetHeaders } = require("./appendRow");
const { executeWithRetry } = require("../utils/retry");
const { collapseWhitespace, safeTrim } = require("../utils/text");

const MONTH_INDEX = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
});

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNABORTED"
]);

function normalizeComparableText(value) {
  return collapseWhitespace(String(value || "")).toLowerCase();
}

function readRideField(record = {}, canonicalField, headerName) {
  return safeTrim(record[canonicalField] || record[headerName] || "");
}

function parseFare(value) {
  const text = safeTrim(value);
  if (!text) return null;

  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeYear(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 100) return 2000 + parsed;
  return parsed;
}

function parsePickupDateParts(value) {
  const text = collapseWhitespace(String(value || "").replace(/,/g, " "));
  if (!text) return null;

  let match = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }

  match = text.match(
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})\b/i
  );
  if (match) {
    const day = Number(match[1]);
    const month = MONTH_INDEX[String(match[2] || "").toLowerCase()];
    const year = normalizeYear(match[3]);
    if (month && year && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }

  match = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})\b/i);
  if (match) {
    const day = Number(match[1]);
    const month = MONTH_INDEX[String(match[2] || "").toLowerCase()];
    const year = normalizeYear(match[3]);
    if (month && year && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }

  match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = normalizeYear(match[3]);
    if (year && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }

  return null;
}

function parsePickupTimeParts(value) {
  const text = collapseWhitespace(String(value || "").replace(/@/g, " "));
  if (!text) return null;

  let match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (match) {
    const rawHour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = String(match[3] || "").toLowerCase();
    if (!Number.isFinite(rawHour) || !Number.isFinite(minute)) return null;
    if (rawHour < 0 || rawHour > 23 || minute < 0 || minute > 59) return null;

    let hour = rawHour;
    if (rawHour <= 12) {
      hour = rawHour % 12;
      if (meridiem === "pm") hour += 12;
    }

    return { hour, minute };
  }

  match = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  return null;
}

function extractDateTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone || "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const mapped = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      mapped[part.type] = Number(part.value);
    }
  }

  return {
    year: mapped.year,
    month: mapped.month,
    day: mapped.day,
    hour: mapped.hour,
    minute: mapped.minute,
    second: mapped.second
  };
}

function resolveTimeZoneDateTime(parts, timeZone) {
  const desiredUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0
  );

  let timestamp = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actualParts = extractDateTimeParts(new Date(timestamp), timeZone);
    const actualUtc = Date.UTC(
      actualParts.year,
      actualParts.month - 1,
      actualParts.day,
      actualParts.hour,
      actualParts.minute,
      actualParts.second || 0
    );
    const difference = desiredUtc - actualUtc;
    if (difference === 0) {
      return new Date(timestamp);
    }
    timestamp += difference;
  }

  const verified = extractDateTimeParts(new Date(timestamp), timeZone);
  if (
    verified.year === parts.year &&
    verified.month === parts.month &&
    verified.day === parts.day &&
    verified.hour === parts.hour &&
    verified.minute === parts.minute
  ) {
    return new Date(timestamp);
  }

  return null;
}

function parsePickupDateTime(dateValue, timeValue, options = {}) {
  const dateParts = parsePickupDateParts(dateValue);
  const timeParts = parsePickupTimeParts(timeValue);
  if (!dateParts || !timeParts) return null;

  return resolveTimeZoneDateTime(
    {
      ...dateParts,
      ...timeParts,
      second: 0
    },
    options.timeZone || "Europe/London"
  );
}

function buildUpcomingDedupeKey(ride = {}) {
  const pickup = normalizeComparableText(readRideField(ride, "pickup", "Pickup"));
  const dropOff = normalizeComparableText(readRideField(ride, "drop_off", "Drop Off"));
  const startingTiming = normalizeComparableText(
    readRideField(ride, "starting_timing", "Starting Timing")
  );

  return `${pickup}|${dropOff}|${startingTiming}`;
}

function isUpcomingHighValueRide(ride = {}, options = {}) {
  const pickup = readRideField(ride, "pickup", "Pickup");
  const dropOff = readRideField(ride, "drop_off", "Drop Off");
  if (!pickup || !dropOff) {
    return {
      eligible: false,
      reason: "pickup_drop_missing",
      parsedFare: null,
      pickupDateTime: null
    };
  }

  const parsedFare = parseFare(readRideField(ride, "fare", "Fare"));
  if (parsedFare === null) {
    return {
      eligible: false,
      reason: "fare_missing_invalid",
      parsedFare: null,
      pickupDateTime: null
    };
  }

  if (parsedFare <= 79) {
    return {
      eligible: false,
      reason: "fare_too_low",
      parsedFare,
      pickupDateTime: null
    };
  }

  const pickupDateTime = parsePickupDateTime(
    readRideField(ride, "pickup_day_date", "Pickup Day & Date"),
    readRideField(ride, "starting_timing", "Starting Timing"),
    { timeZone: options.timeZone || "Europe/London" }
  );

  if (!pickupDateTime) {
    return {
      eligible: false,
      reason: "pickup_datetime_invalid",
      parsedFare,
      pickupDateTime: null
    };
  }

  const now = options.now instanceof Date ? options.now : new Date();
  if (pickupDateTime.getTime() <= now.getTime()) {
    return {
      eligible: false,
      reason: "pickup_datetime_past",
      parsedFare,
      pickupDateTime
    };
  }

  return {
    eligible: true,
    reason: "eligible",
    parsedFare,
    pickupDateTime
  };
}

function isRetryableSheetsError(error) {
  const classification = classifyAppendFailure(error);
  if (classification.type === "network_timeout") return true;
  return NETWORK_ERROR_CODES.has(String(error?.code || ""));
}

function mapRowsToObjects(headers, rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = safeTrim(Array.isArray(row) ? row[index] : "");
    });
    return record;
  });
}

async function loadExistingUpcomingRows({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  logger
}) {
  const headers = await fetchSheetHeaders({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    maxAttempts: 3,
    retryDelayMs: 500,
    logger
  });

  const response = await executeWithRetry(
    () =>
      sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: buildAppendRange({ range: "", worksheetName }),
        majorDimension: "ROWS"
      }),
    {
      maxAttempts: 3,
      initialDelayMs: 500,
      maxDelayMs: 4000,
      shouldRetry: isRetryableSheetsError
    }
  );

  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  if (values.length === 0) {
    return { headers, rows: [] };
  }

  const headerMatches = headers.every(
    (header, index) => safeTrim(values[0]?.[index]) === safeTrim(header)
  );
  const dataRows = headerMatches ? values.slice(1) : values;

  return {
    headers,
    rows: mapRowsToObjects(headers, dataRows)
  };
}

async function appendUpcomingJobIfEligible(ride, options = {}) {
  const logger =
    options.logger ||
    env.logger || {
      info: () => {},
      warn: () => {},
      error: () => {}
    };
  const timeZone = options.timeZone || env.appTimeZone || "Europe/London";
  const appendRow = options.appendRow;
  const sheetsClient = options.sheetsClient;
  const spreadsheetId = options.spreadsheetId || env.googleSheetsId;
  const worksheetName =
    safeTrim(options.worksheetName || env.googleUpcomingJobsWorksheetName) ||
    "Upcoming Jobs >79";

  if (typeof appendRow !== "function") {
    throw new Error("Upcoming Jobs append function is not configured");
  }

  if (!sheetsClient || !spreadsheetId || !worksheetName) {
    throw new Error("Upcoming Jobs sheet configuration is incomplete");
  }

  const eligibility = isUpcomingHighValueRide(ride, {
    timeZone,
    now: options.now
  });

  if (!eligibility.eligible) {
    if (eligibility.reason === "pickup_drop_missing") {
      logger.info("Upcoming job skipped because pickup/drop is blank", {
        stage: "upcoming_jobs",
        fallbackUsed: true,
        refer: safeTrim(ride?.refer)
      });
    } else if (eligibility.reason === "fare_too_low") {
      logger.info("Upcoming job skipped because fare <= 79", {
        stage: "upcoming_jobs",
        fallbackUsed: true,
        refer: safeTrim(ride?.refer),
        fare: readRideField(ride, "fare", "Fare")
      });
    } else if (eligibility.reason === "pickup_datetime_invalid") {
      logger.info("Upcoming job skipped because pickup datetime is invalid or missing", {
        stage: "upcoming_jobs",
        fallbackUsed: true,
        refer: safeTrim(ride?.refer),
        pickupDayDate: readRideField(ride, "pickup_day_date", "Pickup Day & Date"),
        startingTiming: readRideField(ride, "starting_timing", "Starting Timing")
      });
    } else if (eligibility.reason === "pickup_datetime_past") {
      logger.info("Upcoming job skipped because pickup datetime is in the past", {
        stage: "upcoming_jobs",
        fallbackUsed: true,
        refer: safeTrim(ride?.refer),
        pickupDateTime: eligibility.pickupDateTime?.toISOString() || ""
      });
    } else {
      logger.info("Upcoming job skipped because fare is missing or invalid", {
        stage: "upcoming_jobs",
        fallbackUsed: true,
        refer: safeTrim(ride?.refer),
        fare: readRideField(ride, "fare", "Fare")
      });
    }

    return {
      appended: false,
      reason: eligibility.reason
    };
  }

  const dedupeKey = buildUpcomingDedupeKey(ride);
  const { rows } = await loadExistingUpcomingRows({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    logger
  });

  const duplicateExists = rows.some((row) => buildUpcomingDedupeKey(row) === dedupeKey);
  if (duplicateExists) {
    logger.info("Upcoming job skipped because duplicate exists", {
      stage: "upcoming_jobs",
      fallbackUsed: true,
      refer: safeTrim(ride?.refer),
      dedupeKey
    });
    return {
      appended: false,
      reason: "duplicate_exists"
    };
  }

  await appendRow(ride);

  logger.info("Upcoming job appended", {
    stage: "upcoming_jobs",
    fallbackUsed: false,
    refer: safeTrim(ride?.refer),
    dedupeKey,
    rowObject: buildSheetRowObject(ride)
  });

  return {
    appended: true,
    reason: "appended"
  };
}

function createUpcomingJobAppender(options = {}) {
  return function appendEligibleUpcomingJob(ride) {
    return appendUpcomingJobIfEligible(ride, options);
  };
}

module.exports = {
  parseFare,
  parsePickupDateTime,
  buildUpcomingDedupeKey,
  isUpcomingHighValueRide,
  appendUpcomingJobIfEligible,
  createUpcomingJobAppender
};
