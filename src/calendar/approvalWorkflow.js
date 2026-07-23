const { buildAppendRange, buildHeaderRange } = require("../sheets/appendRow");
const { parsePickupDateTime } = require("../sheets/upcomingJobs");
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
  CREATE_FAILED: "Create Failed",
  UPDATE_FAILED: "Update Failed",
  DELETE_FAILED: "Delete Failed",
  DELETED: "Deleted"
});

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

function isApprovedForCalendar(record = {}) {
  const status = normalizeStatus(record.Status);
  const assignedDriver = safeTrim(record["Assigned Driver"]);
  const calendarStatus = normalizeStatus(record["Calendar Status"]);
  const calendarEventId = safeTrim(record["Calendar Event ID"]);

  return Boolean(
    status === "approved" &&
    assignedDriver &&
    !calendarEventId &&
    !["created", "deleted"].includes(calendarStatus)
  );
}

function buildApprovalPayload(record = {}, options = {}) {
  const pickupDayDate = safeTrim(record["Pickup Day & Date"]);
  const startingTiming = safeTrim(record["Starting Timing"]);
  const startDateTime = parsePickupDateTime(pickupDayDate, startingTiming, {
    timeZone: options.timeZone || "Europe/London"
  });

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
    assigned_driver: safeTrim(record["Assigned Driver"]),
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
  calendarEventId
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

async function processFinalBidApprovals(options = {}) {
  const {
    sheetsClient,
    calendarClient,
    spreadsheetId,
    worksheetName = "Final Bid",
    calendarId = "primary",
    timeZone = "Europe/London",
    durationMinutes = 60,
    logger = { info: () => {}, warn: () => {}, error: () => {} }
  } = options;

  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!calendarClient) throw new Error("Google Calendar client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");

  const { headers, records } = await loadFinalBidRows({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    logger
  });
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    if (!isApprovedForCalendar(record)) {
      skipped += 1;
      continue;
    }

    const approval = buildApprovalPayload(record, { timeZone });
    if (!approval.startDateTime) {
      failed += 1;
      await updateFinalBidCalendarColumns({
        sheetsClient,
        spreadsheetId,
        worksheetName,
        headers,
        rowNumber: record.rowNumber,
        calendarStatus: CALENDAR_STATUS.CREATE_FAILED,
        calendarEventId: ""
      });
      logger.warn("Calendar creation skipped because pickup datetime is invalid", {
        stage: "calendar_approval",
        fallbackUsed: true,
        refer: approval.refer,
        reason: `${approval.pickup_day_date} ${approval.starting_timing}`
      });
      continue;
    }

    try {
      const event = buildRideCalendarEvent(approval, {
        timeZone,
        durationMinutes
      });
      const result = await createCalendarEvent({
        calendarClient,
        calendarId,
        event
      });

      await updateFinalBidCalendarColumns({
        sheetsClient,
        spreadsheetId,
        worksheetName,
        headers,
        rowNumber: record.rowNumber,
        calendarStatus: CALENDAR_STATUS.CREATED,
        calendarEventId: result.eventId
      });

      created += 1;
      logger.info("Calendar event created for approved Final Bid", {
        stage: "calendar_approval",
        fallbackUsed: false,
        refer: approval.refer,
        eventId: result.eventId
      });
    } catch (error) {
      failed += 1;
      await updateFinalBidCalendarColumns({
        sheetsClient,
        spreadsheetId,
        worksheetName,
        headers,
        rowNumber: record.rowNumber,
        calendarStatus: CALENDAR_STATUS.CREATE_FAILED,
        calendarEventId: ""
      });

      logger.warn("Calendar event creation failed for approved Final Bid", {
        stage: "calendar_approval",
        fallbackUsed: true,
        refer: approval.refer,
        reason: safeTrim(error?.message) || "Calendar API request failed",
        error
      });
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
  const logger = options.logger || { info: () => {}, warn: () => {}, error: () => {} };
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(10000, Math.trunc(options.intervalMs))
    : 60000;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const result = await processFinalBidApprovals(options);
      logger.info("Final Bid approval poll completed", {
        stage: "calendar_approval",
        fallbackUsed: false,
        reason: `checked=${result.checked}, created=${result.created}, failed=${result.failed}`
      });
    } catch (error) {
      logger.warn("Final Bid approval poll failed", {
        stage: "calendar_approval",
        fallbackUsed: true,
        reason: safeTrim(error?.message) || "Approval scan failed",
        error
      });
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
