const { buildAppendRange, buildHeaderRange } = require("../sheets/appendRow");
const { parsePickupDateTime } = require("../sheets/upcomingJobs");
const { loadDriverRows } = require("../drivers/management");
const { executeWithRetry } = require("../utils/retry");
const { safeTrim, collapseWhitespace } = require("../utils/text");
const {
  buildRideCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent
} = require("./events");

const CALENDAR_STATUS = Object.freeze({
  PENDING: "",
  CREATED: "Created",
  FAILED: "Failed"
});

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNABORTED"
]);

function isTransientCalendarError(error) {
  const status = Number(error?.response?.status ?? error?.code);
  const code = String(error?.code || "");

  if (RETRYABLE_STATUS_CODES.has(status)) return true;
  if (RETRYABLE_ERROR_CODES.has(code)) return true;
  return false;
}

function normalizeLogger(logger = {}) {
  return {
    info: typeof logger.info === "function" ? logger.info.bind(logger) : () => {},
    warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : () => {},
    debug: typeof logger.debug === "function" ? logger.debug.bind(logger) : () => {},
    error: typeof logger.error === "function" ? logger.error.bind(logger) : () => {}
  };
}

function extractCalendarErrorDetails(error) {
  const apiError = error?.response?.data?.error || {};
  const firstDetail = Array.isArray(apiError.errors) ? apiError.errors[0] || {} : {};
  const status = safeTrim(error?.response?.status || apiError.code || error?.status || error?.code);
  const message =
    safeTrim(apiError.message) ||
    safeTrim(error?.response?.data?.message) ||
    safeTrim(error?.message) ||
    "Calendar API request failed";

  return {
    status,
    code: safeTrim(apiError.code || error?.code),
    reason: safeTrim(firstDetail.reason || apiError.status || message),
    domain: safeTrim(firstDetail.domain),
    message
  };
}

function buildCalendarFailureReason(error) {
  const details = extractCalendarErrorDetails(error);
  const parts = [
    details.status ? `status=${details.status}` : "",
    details.code && details.code !== details.status ? `code=${details.code}` : "",
    details.reason && details.reason !== details.message ? `reason=${details.reason}` : "",
    details.message
  ].filter(Boolean);
  return parts.join("; ");
}

function findMissingCalendarFields(approval = {}) {
  const required = [
    ["refer", approval.refer],
    ["assigned_driver", approval.assigned_driver],
    ["pickup", approval.pickup],
    ["drop_off", approval.drop_off],
    ["pickup_day_date", approval.pickup_day_date],
    ["starting_timing", approval.starting_timing]
  ];

  return required
    .filter(([, value]) => !safeTrim(value))
    .map(([name]) => name);
}

function normalizeHeader(value) {
  return collapseWhitespace(String(value || "").replace(/[_-]+/g, " ")).toLowerCase();
}

function normalizeStatus(value) {
  return normalizeHeader(value);
}

function findHeaderIndex(headers, name) {
  const target = normalizeHeader(name);
  return (Array.isArray(headers) ? headers : []).findIndex(
    (header) => normalizeHeader(header) === target
  );
}

function mapRowsToFinalBidRecords(headers, rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const record = {
      rowNumber: index + 2,
      rawRow: Array.isArray(row) ? row : []
    };
    headers.forEach((header, columnIndex) => {
      record[header] = safeTrim(Array.isArray(row) ? row[columnIndex] : "");
    });
    return record;
  });
}

// Calendar event should only be created when Status == Approved, a driver is
// assigned, and no event has been created yet. This intentionally does NOT
// look at the Calendar Event ID cell so that an orphaned event ID (created but
// never marked Created, e.g. after a crash between insert() and the sheet
// write) is still picked up below and reconciled instead of silently ignored.
function isApprovedForCalendar(record = {}) {
  const status = normalizeStatus(record.Status);
  const assignedDriver = safeTrim(record["Assigned Driver"]);
  const calendarStatus = normalizeStatus(record["Calendar Status"]);

  return Boolean(status === "approved" && assignedDriver && calendarStatus !== "created");
}

function buildApprovalPayload(record = {}, options = {}) {
  const pickupDayDate = safeTrim(record["Pickup Day & Date"]);
  const startingTiming = safeTrim(record["Starting Timing"]);
  const startDateTime = parsePickupDateTime(pickupDayDate, startingTiming, {
    timeZone: options.timeZone || "Europe/London"
  });
  const assignedDriver = safeTrim(record["Assigned Driver"]);

  return {
    refer: safeTrim(record.Refer),
    group_name: safeTrim(record["Group Name"]),
    source_name: safeTrim(record["Source Name"]),
    pickup_day_date: pickupDayDate,
    starting_timing: startingTiming,
    pickup: safeTrim(record.Pickup),
    drop_off: safeTrim(record["Drop Off"]),
    distance: safeTrim(record.Distance),
    fare: safeTrim(record.Fare),
    required_vehicle: safeTrim(record["Required Vehicle"]),
    payment_status: safeTrim(record["Payment Status"]),
    passenger_count: safeTrim(record["Passenger Count"]),
    assigned_driver: assignedDriver,
    driver_name: safeTrim((options.driverNameById || {})[assignedDriver]) || assignedDriver,
    startDateTime
  };
}

function buildCellRange(worksheetName, rowNumber, columnIndex) {
  const safeWorksheetName =
    safeTrim(worksheetName).includes(" ") || safeTrim(worksheetName).includes("!")
      ? `'${safeTrim(worksheetName).replace(/'/g, "''")}'`
      : safeTrim(worksheetName);
  const columnLetter = columnIndexToLetter(columnIndex);
  return `${safeWorksheetName}!${columnLetter}${rowNumber}`;
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

async function updateFinalBidCalendarColumns({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  headers,
  rowNumber,
  calendarStatus,
  calendarEventId,
  calendarCreatedTime = "",
  calendarError = "",
  logger = { warn: () => {} }
}) {
  const statusIndex = findHeaderIndex(headers, "Calendar Status");
  const eventIdIndex = findHeaderIndex(headers, "Calendar Event ID");
  if (statusIndex < 0) throw new Error("Final Bid sheet is missing Calendar Status column");
  if (eventIdIndex < 0) throw new Error("Final Bid sheet is missing Calendar Event ID column");

  const updates = [
    {
      range: buildCellRange(worksheetName, rowNumber, statusIndex),
      values: [[safeTrim(calendarStatus)]]
    },
    {
      range: buildCellRange(worksheetName, rowNumber, eventIdIndex),
      values: [[safeTrim(calendarEventId)]]
    }
  ];

  const createdTimeIndex = findHeaderIndex(headers, "Calendar Created Time");
  if (createdTimeIndex >= 0) {
    updates.push({
      range: buildCellRange(worksheetName, rowNumber, createdTimeIndex),
      values: [[safeTrim(calendarCreatedTime)]]
    });
  } else {
    logger.warn("Final Bid sheet is missing Calendar Created Time column", {
      stage: "calendar_approval",
      fallbackUsed: true,
      reason: worksheetName
    });
  }

  const errorIndex = findHeaderIndex(headers, "Calendar Error");
  if (errorIndex >= 0) {
    updates.push({
      range: buildCellRange(worksheetName, rowNumber, errorIndex),
      values: [[safeTrim(calendarError)]]
    });
  } else {
    logger.warn("Final Bid sheet is missing Calendar Error column", {
      stage: "calendar_approval",
      fallbackUsed: true,
      reason: worksheetName
    });
  }

  await sheetsClient.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: updates
    }
  });
}

async function loadFinalBidRows({ sheetsClient, spreadsheetId, worksheetName, logger }) {
  const headerResponse = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: buildHeaderRange(worksheetName),
    majorDimension: "ROWS"
  });
  const headers = Array.isArray(headerResponse?.data?.values?.[0])
    ? headerResponse.data.values[0].map((header) => safeTrim(header)).filter(Boolean)
    : [];

  if (headers.length === 0) {
    logger.warn("Final Bid headers missing; approval workflow skipped", {
      stage: "calendar_approval",
      fallbackUsed: true,
      reason: worksheetName
    });
    return { headers: [], records: [] };
  }

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: buildAppendRange({ range: "", worksheetName }),
    majorDimension: "ROWS"
  });
  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  const headerMatches = headers.every(
    (header, index) => safeTrim(values[0]?.[index]) === safeTrim(header)
  );
  const rows = headerMatches ? values.slice(1) : values;

  return {
    headers,
    records: mapRowsToFinalBidRecords(headers, rows)
  };
}

async function loadDriverNameLookup({ sheetsClient, spreadsheetId, driversWorksheetName, logger }) {
  try {
    const drivers = await loadDriverRows({
      sheetsClient,
      spreadsheetId,
      worksheetName: driversWorksheetName || "Drivers",
      logger
    });
    return drivers.reduce((map, driver) => {
      if (driver.driver_id) map[driver.driver_id] = driver.driver_name;
      return map;
    }, {});
  } catch (error) {
    logger.warn("Unable to load Drivers sheet for calendar descriptions", {
      stage: "calendar_approval",
      fallbackUsed: true,
      reason: safeTrim(error?.message) || "Drivers sheet lookup failed",
      error,
      stack: error?.stack
    });
    return {};
  }
}

function buildCalendarFailureMeta(error, { refer, driverId, calendarId, timeZone, event } = {}) {
  const details = extractCalendarErrorDetails(error);
  return {
    stage: "calendar_approval",
    fallbackUsed: true,
    refer: safeTrim(refer),
    driverId: safeTrim(driverId),
    calendarId: safeTrim(calendarId),
    timeZone: safeTrim(timeZone),
    eventStart: safeTrim(event?.start?.dateTime),
    eventEnd: safeTrim(event?.end?.dateTime),
    status: details.status,
    code: details.code,
    apiReason: details.reason,
    domain: details.domain,
    reason: details.message,
    error,
    stack: error?.stack || ""
  };
}

async function processFinalBidApprovals(options = {}) {
  const {
    sheetsClient,
    calendarClient,
    spreadsheetId,
    worksheetName = "Final Bid",
    driversWorksheetName = "Drivers",
    calendarId = "primary",
    timeZone = "Europe/London",
    durationMinutes = 60,
    companyCode = "",
    logger: inputLogger = {}
  } = options;
  const logger = normalizeLogger(inputLogger);
  const safeCalendarId = safeTrim(calendarId) || "primary";
  const safeTimeZone = safeTrim(timeZone) || "Europe/London";

  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!calendarClient) throw new Error("Google Calendar client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");

  const { headers, records } = await loadFinalBidRows({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    logger
  });

  const pending = records.filter(isApprovedForCalendar);
  let created = 0;
  let skipped = records.length - pending.length;
  let failed = 0;

  if (pending.length === 0) {
    return { checked: records.length, created, skipped, failed };
  }

  const driverNameById = await loadDriverNameLookup({
    sheetsClient,
    spreadsheetId,
    driversWorksheetName,
    logger
  });

  for (const record of pending) {
    const approval = buildApprovalPayload(record, { timeZone: safeTimeZone, driverNameById });
    const existingEventId = safeTrim(record["Calendar Event ID"]);
    const missingFields = findMissingCalendarFields(approval);

    // Reconcile an orphaned event: the insert() succeeded on a previous run
    // but the sheet write that should have marked it Created never
    // completed. Re-inserting here would create a duplicate calendar event,
    // so just repair the status column instead.
    if (existingEventId) {
      try {
        await updateFinalBidCalendarColumns({
          sheetsClient,
          spreadsheetId,
          worksheetName,
          headers,
          rowNumber: record.rowNumber,
          calendarStatus: CALENDAR_STATUS.CREATED,
          calendarEventId: existingEventId,
          calendarCreatedTime: safeTrim(record["Calendar Created Time"]) || new Date().toISOString(),
          calendarError: "",
          logger
        });
        logger.info("Calendar Already Exists", {
          stage: "calendar_approval",
          fallbackUsed: false,
          refer: approval.refer,
          driverId: approval.assigned_driver,
          eventId: existingEventId
        });
      } catch (error) {
        failed += 1;
        logger.error("Calendar Failed", buildCalendarFailureMeta(error, {
          refer: approval.refer,
          driverId: approval.assigned_driver
        }));
      }
      continue;
    }

    logger.debug("Calendar creation started", {
      stage: "calendar_approval",
      fallbackUsed: false,
      refer: approval.refer,
      driverId: approval.assigned_driver,
      calendarId: safeCalendarId,
      timeZone: safeTimeZone,
      pickupDayDate: approval.pickup_day_date,
      startingTiming: approval.starting_timing,
      missingFields: missingFields.join(", ")
    });

    if (!approval.startDateTime) {
      failed += 1;
      const error = new Error(
        `Invalid pickup date/time: "${approval.pickup_day_date} ${approval.starting_timing}"`
      );
      const failureReason = buildCalendarFailureReason(error);
      try {
        await updateFinalBidCalendarColumns({
          sheetsClient,
          spreadsheetId,
          worksheetName,
          headers,
          rowNumber: record.rowNumber,
          calendarStatus: CALENDAR_STATUS.FAILED,
          calendarEventId: "",
          calendarCreatedTime: "",
          calendarError: failureReason,
          logger
        });
      } catch (writeError) {
        logger.error("Calendar Failed", buildCalendarFailureMeta(writeError, {
          refer: approval.refer,
          driverId: approval.assigned_driver,
          calendarId: safeCalendarId,
          timeZone: safeTimeZone
        }));
      }
      logger.error("Failure reason", buildCalendarFailureMeta(error, {
        refer: approval.refer,
        driverId: approval.assigned_driver,
        calendarId: safeCalendarId,
        timeZone: safeTimeZone
      }));
      continue;
    }

    let event;
    try {
      event = buildRideCalendarEvent(approval, {
        timeZone: safeTimeZone,
        durationMinutes,
        companyCode
      });

      logger.debug("Event payload generated", {
        stage: "calendar_approval",
        fallbackUsed: false,
        refer: approval.refer,
        driverId: approval.assigned_driver,
        calendarId: safeCalendarId,
        summary: event.summary,
        start: event.start.dateTime,
        end: event.end.dateTime,
        timeZone: event.start.timeZone,
        location: event.location
      });

      const result = await executeWithRetry(
        () => createCalendarEvent({ calendarClient, calendarId: safeCalendarId, event }),
        {
          maxAttempts: 3,
          shouldRetry: isTransientCalendarError,
          onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
            logger.warn("Calendar Retry", {
              stage: "calendar_approval",
              fallbackUsed: true,
              refer: approval.refer,
              driverId: approval.assigned_driver,
              attempt,
              maxAttempts,
              delayMs,
              reason: buildCalendarFailureReason(error)
            });
          }
        }
      );

      logger.debug("Google Calendar API response", {
        stage: "calendar_approval",
        fallbackUsed: false,
        refer: approval.refer,
        driverId: approval.assigned_driver,
        calendarId: safeCalendarId,
        eventId: result.eventId,
        htmlLink: result.htmlLink
      });

      const createdTime = new Date().toISOString();
      await updateFinalBidCalendarColumns({
        sheetsClient,
        spreadsheetId,
        worksheetName,
        headers,
        rowNumber: record.rowNumber,
        calendarStatus: CALENDAR_STATUS.CREATED,
        calendarEventId: result.eventId,
        calendarCreatedTime: createdTime,
        calendarError: "",
        logger
      });

      created += 1;
      logger.info("Calendar Event Created", {
        stage: "calendar_approval",
        fallbackUsed: false,
        refer: approval.refer,
        driverId: approval.assigned_driver,
        eventId: result.eventId
      });
    } catch (error) {
      failed += 1;
      const failureReason = buildCalendarFailureReason(error);

      try {
        await updateFinalBidCalendarColumns({
          sheetsClient,
          spreadsheetId,
          worksheetName,
          headers,
          rowNumber: record.rowNumber,
          calendarStatus: CALENDAR_STATUS.FAILED,
          calendarEventId: "",
          calendarCreatedTime: "",
          calendarError: failureReason,
          logger
        });
      } catch (writeError) {
        logger.error("Calendar Failed", buildCalendarFailureMeta(writeError, {
          refer: approval.refer,
          driverId: approval.assigned_driver,
          calendarId: safeCalendarId,
          timeZone: safeTimeZone,
          event
        }));
      }

      logger.error("Failure reason", buildCalendarFailureMeta(error, {
        refer: approval.refer,
        driverId: approval.assigned_driver,
        calendarId: safeCalendarId,
        timeZone: safeTimeZone,
        event
      }));
    }
  }

  return {
    checked: records.length,
    created,
    skipped,
    failed
  };
}

function startFinalBidApprovalPolling(options = {}) {
  const logger = normalizeLogger(options.logger);
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(10000, Math.trunc(options.intervalMs))
    : 60000;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    logger.debug("Calendar Poll Started", {
      stage: "calendar_approval",
      fallbackUsed: false
    });
    try {
      await processFinalBidApprovals({ ...options, logger });
    } catch (error) {
      logger.error("Calendar Failed", buildCalendarFailureMeta(error, {}));
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(tick, 1000).unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
    tick
  };
}

module.exports = {
  CALENDAR_STATUS,
  normalizeStatus,
  columnIndexToLetter,
  isApprovedForCalendar,
  buildApprovalPayload,
  buildCellRange,
  loadFinalBidRows,
  updateFinalBidCalendarColumns,
  processFinalBidApprovals,
  startFinalBidApprovalPolling,
  updateCalendarEvent,
  deleteCalendarEvent
};
