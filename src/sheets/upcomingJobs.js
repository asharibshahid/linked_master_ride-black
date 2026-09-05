const { env } = require("../config/env");
const { buildSheetRowObject } = require("../extraction/schemas");
const { buildAppendRange, classifyAppendFailure, fetchSheetHeaders } = require("./appendRow");
const { executeWithRetry } = require("../utils/retry");
const { collapseWhitespace, safeTrim } = require("../utils/text");

const MONTH_INDEX = Object.freeze({
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12
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

function isValidDateParts({ year, month, day } = {}) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parsePickupDateParts(value, options = {}) {
  const text = collapseWhitespace(String(value || "").replace(/,/g, " "));
  if (!text) return null;

  let match = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parts = { year, month, day };
    if (isValidDateParts(parts)) {
      return parts;
    }
  }

  match = text.match(
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})\b/i
  );
  if (match) {
    const day = Number(match[1]);
    const month = MONTH_INDEX[String(match[2] || "").toLowerCase()];
    const year = normalizeYear(match[3]);
    const parts = { year, month, day };
    if (month && year && isValidDateParts(parts)) {
      return parts;
    }
  }

  match = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})\b/i);
  if (match) {
    const day = Number(match[1]);
    const month = MONTH_INDEX[String(match[2] || "").toLowerCase()];
    const year = normalizeYear(match[3]);
    const parts = { year, month, day };
    if (month && year && isValidDateParts(parts)) {
      return parts;
    }
  }

  match = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const numericDateOrder = String(options.numericDateOrder || "dmy").toLowerCase();
    const day = numericDateOrder === "mdy" ? second : first;
    const month = numericDateOrder === "mdy" ? first : second;
    const year = normalizeYear(match[3]);
    const parts = { year, month, day };
    if (year && isValidDateParts(parts)) {
      return parts;
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
  const dateParts = parsePickupDateParts(dateValue, options);
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

function buildPickupSortKey(record = {}) {
  const dateParts = parsePickupDateParts(readRideField(record, "pickup_day_date", "Pickup Day & Date"));
  const timeParts = parsePickupTimeParts(readRideField(record, "starting_timing", "Starting Timing"));

  if (!dateParts) {
    return {
      invalidDate: 1,
      dateValue: Number.POSITIVE_INFINITY,
      invalidTime: 1,
      timeValue: Number.POSITIVE_INFINITY
    };
  }

  return {
    invalidDate: 0,
    dateValue: Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day),
    invalidTime: timeParts ? 0 : 1,
    timeValue: timeParts ? timeParts.hour * 60 + timeParts.minute : Number.POSITIVE_INFINITY
  };
}

function comparePickupSortKeys(left, right) {
  if (left.invalidDate !== right.invalidDate) return left.invalidDate - right.invalidDate;
  if (left.dateValue !== right.dateValue) return left.dateValue - right.dateValue;
  if (left.invalidTime !== right.invalidTime) return left.invalidTime - right.invalidTime;
  if (left.timeValue !== right.timeValue) return left.timeValue - right.timeValue;
  return 0;
}

function sortRideRecordsByPickupDateTime(records = []) {
  return (Array.isArray(records) ? records : [])
    .map((record, index) => ({
      record,
      index,
      sortKey: buildPickupSortKey(record)
    }))
    .sort((left, right) => {
      const comparison = comparePickupSortKeys(left.sortKey, right.sortKey);
      return comparison || left.index - right.index;
    })
    .map((entry) => entry.record);
}

function columnIndexToLetter(index) {
  let value = Number(index) + 1;
  if (!Number.isFinite(value) || value < 1) return "A";

  let output = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function buildSheetValuesFromRecords(headers = [], rows = []) {
  return rows.map((row) => headers.map((header) => safeTrim(row[header])));
}

function canRewriteSheetRows(sheetsClient) {
  return Boolean(
    sheetsClient?.spreadsheets?.values?.clear &&
      sheetsClient?.spreadsheets?.values?.update
  );
}

async function rewriteUpcomingJobsRows({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  headers,
  rows
}) {
  if (!canRewriteSheetRows(sheetsClient)) {
    return { sorted: false, reason: "sheet_update_unavailable" };
  }

  const sortedRows = sortRideRecordsByPickupDateTime(rows);
  const values = buildSheetValuesFromRecords(headers, sortedRows);
  const lastColumn = columnIndexToLetter(Math.max(headers.length - 1, 0));
  const dataRange = `${buildAppendRange({ range: "", worksheetName })}!A2:${lastColumn}`;

  await sheetsClient.spreadsheets.values.clear({
    spreadsheetId,
    range: dataRange
  });

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: dataRange,
    valueInputOption: "RAW",
    requestBody: {
      values
    }
  });

  return { sorted: true, reason: "sorted", rows: sortedRows.length };
}

function buildUpcomingDedupeKey(ride = {}) {
  const pickup = normalizeComparableText(readRideField(ride, "pickup", "Pickup"));
  const dropOff = normalizeComparableText(readRideField(ride, "drop_off", "Drop Off"));
  const startingTiming = normalizeComparableText(
    readRideField(ride, "starting_timing", "Starting Timing")
  );

  return `${pickup}|${dropOff}|${startingTiming}`;
}

async function sortUpcomingJobsSheet({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  logger = { warn: () => {} }
}) {
  if (!canRewriteSheetRows(sheetsClient)) {
    return { sorted: false, reason: "sheet_update_unavailable" };
  }

  const { headers, rows } = await loadExistingUpcomingRows({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    logger
  });

  if (rows.length <= 1) {
    return { sorted: false, reason: "not_enough_rows" };
  }

  return rewriteUpcomingJobsRows({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    headers,
    rows
  });
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
  const sourceLogger = options.logger || env.logger || {};
  const logger = {
    info: typeof sourceLogger.info === "function" ? sourceLogger.info.bind(sourceLogger) : () => {},
    warn: typeof sourceLogger.warn === "function" ? sourceLogger.warn.bind(sourceLogger) : () => {},
    debug: typeof sourceLogger.debug === "function" ? sourceLogger.debug.bind(sourceLogger) : () => {},
    error: typeof sourceLogger.error === "function" ? sourceLogger.error.bind(sourceLogger) : () => {}
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
    return {
      appended: false,
      reason: eligibility.reason
    };
  }

  const dedupeKey = buildUpcomingDedupeKey(ride);
  const { headers, rows } = await loadExistingUpcomingRows({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    logger
  });

  const duplicateExists = rows.some((row) => buildUpcomingDedupeKey(row) === dedupeKey);
  if (duplicateExists) {
    return {
      appended: false,
      reason: "duplicate_exists"
    };
  }

  await appendRow(ride);
  try {
    const appendedRow = buildSheetRowObject(ride);
    await rewriteUpcomingJobsRows({
      sheetsClient,
      spreadsheetId,
      worksheetName,
      headers,
      rows: [...rows, appendedRow]
    });
  } catch (error) {
    logger.warn("Upcoming Jobs sort failed", {
      stage: "upcoming_jobs",
      fallbackUsed: true,
      refer: safeTrim(ride?.refer),
      reason: safeTrim(error?.message) || "Unable to sort Upcoming Jobs sheet",
      error
    });
  }

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
  sortRideRecordsByPickupDateTime,
  sortUpcomingJobsSheet,
  buildUpcomingDedupeKey,
  isUpcomingHighValueRide,
  appendUpcomingJobIfEligible,
  createUpcomingJobAppender
};
