const { parsePickupDateTime } = require("../sheets/upcomingJobs");
const { safeTrim } = require("../utils/text");

const ARCHIVE_WORKSHEET_NAME = "Ride Archive";

const ARCHIVE_HEADERS = Object.freeze([
  "Archive ID",
  "Source Sheet",
  "Source Row",
  "Archive Reason",
  "Ride ID",
  "Status",
  "Pickup Day & Date",
  "Starting Timing",
  "Archived Time",
  "Payload JSON"
]);

const CLOSED_STATUSES = new Set([
  "assigned",
  "bid done",
  "bid failed",
  "cancelled",
  "canceled",
  "closed",
  "completed",
  "create failed",
  "expired",
  "failed",
  "rejected",
  "skipped"
]);

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName || "").replace(/'/g, "''")}'`;
}

function normalizeStatus(value) {
  return toCell(value).toLowerCase();
}

function daysToMs(days) {
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed * 24 * 60 * 60 * 1000;
}

function recordsFromValues(values = []) {
  const rows = Array.isArray(values) ? values : [];
  const headers = Array.isArray(rows[0]) ? rows[0].map(toCell) : [];
  return rows.slice(1).map((row, index) => {
    const record = {};
    headers.forEach((header, columnIndex) => {
      if (header) record[header] = toCell(row?.[columnIndex]);
    });
    return {
      record,
      rowNumber: index + 2
    };
  });
}

function readRideId(record = {}) {
  return (
    toCell(record.Refer) ||
    toCell(record["Ride ID"]) ||
    toCell(record["Assignment ID"]) ||
    toCell(record["Link ID"]) ||
    toCell(record["Audit ID"])
  );
}

function readStatus(record = {}) {
  return (
    toCell(record.Status) ||
    toCell(record["Bid Status"]) ||
    toCell(record["Assignment Status"]) ||
    toCell(record["Calendar Status"])
  );
}

function readStatuses(record = {}) {
  return [
    record.Status,
    record["Bid Status"],
    record["Assignment Status"],
    record["Calendar Status"]
  ]
    .map(toCell)
    .filter(Boolean);
}

function parseAnyDateTime(record = {}, options = {}) {
  const timeZone = options.timeZone || "Europe/London";
  const pickupDate = toCell(record["Pickup Day & Date"] || record.Date);
  const pickupTime = toCell(record["Starting Timing"] || record.Time);
  if (pickupDate && pickupTime) {
    const parsedPickup = parsePickupDateTime(pickupDate, pickupTime, { timeZone });
    if (parsedPickup) return parsedPickup;
  }

  const directFields = [
    "End Time",
    "Next Available Time",
    "Updated Time",
    "Created Time",
    "Source Time",
    "Archived Time"
  ];
  for (const field of directFields) {
    const raw = toCell(record[field]);
    if (!raw) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function isFutureRide(record = {}, options = {}) {
  const parsed = parseAnyDateTime(record, options);
  if (!parsed) return false;
  const now = options.now || new Date();
  return parsed.getTime() > now.getTime();
}

function isClosedOperationalRecord(record = {}, target = {}) {
  const statuses = readStatuses(record).map(normalizeStatus).filter(Boolean);
  if (!statuses.length) return false;
  const closedStatuses = new Set(
    (Array.isArray(target.closedStatuses) && target.closedStatuses.length > 0
      ? target.closedStatuses
      : Array.from(CLOSED_STATUSES)
    ).map(normalizeStatus)
  );
  return statuses.some((status) => closedStatuses.has(status));
}

function shouldArchiveRecord(record = {}, target = {}, options = {}) {
  if (isFutureRide(record, options)) {
    return { archive: false, reason: "future_record_protected" };
  }

  if (!isClosedOperationalRecord(record, target)) {
    return { archive: false, reason: "record_not_closed" };
  }

  const parsed = parseAnyDateTime(record, options);
  if (!parsed) {
    return { archive: false, reason: "record_date_missing_or_invalid" };
  }

  const now = options.now || new Date();
  const retentionDays = Number.isFinite(Number(target.retentionDays))
    ? Number(target.retentionDays)
    : Number(options.defaultRetentionDays || 10);
  const ageMs = now.getTime() - parsed.getTime();
  if (ageMs < daysToMs(retentionDays)) {
    return { archive: false, reason: "record_within_retention_window" };
  }

  return {
    archive: true,
    reason: `${target.reason || "closed_record"}_older_than_${retentionDays}_days`
  };
}

function buildArchiveId({ sourceSheet = "", sourceRow = "", archivedTime = "" } = {}) {
  const stamp = safeTrim(archivedTime) || new Date().toISOString();
  const cleanSheet = safeTrim(sourceSheet).replace(/[^A-Za-z0-9-]/g, "") || "Sheet";
  return `ARC-${stamp.replace(/[^0-9]/g, "").slice(0, 14)}-${cleanSheet}-${sourceRow || "row"}`;
}

function buildArchiveRowObject({
  sourceSheet = "",
  sourceRow = "",
  reason = "",
  record = {},
  archivedTime = ""
} = {}) {
  const timestamp = safeTrim(archivedTime) || new Date().toISOString();
  return {
    "Archive ID": buildArchiveId({ sourceSheet, sourceRow, archivedTime: timestamp }),
    "Source Sheet": toCell(sourceSheet),
    "Source Row": toCell(sourceRow),
    "Archive Reason": toCell(reason),
    "Ride ID": readRideId(record),
    Status: readStatus(record),
    "Pickup Day & Date": toCell(record["Pickup Day & Date"] || record.Date),
    "Starting Timing": toCell(record["Starting Timing"] || record.Time),
    "Archived Time": timestamp,
    "Payload JSON": JSON.stringify(record || {})
  };
}

function buildArchiveSheetRow(record = {}, headers = ARCHIVE_HEADERS) {
  const safeHeaders = Array.isArray(headers) && headers.length > 0 ? headers : ARCHIVE_HEADERS;
  return safeHeaders.map((header) => toCell(record[header]));
}

function buildDefaultRetentionTargets(env = {}) {
  const completedDays = Number(env.retentionCompletedDays || 10);
  const reviewDays = Number(env.retentionReviewDays || 7);
  const auditDays = Number(env.retentionAuditDays || 30);
  return [
    {
      worksheetName: env.googleFinalBidWorksheetName || "Final Bid",
      retentionDays: completedDays,
      reason: "final_bid_closed",
      closedStatuses: ["Rejected", "Cancelled", "Canceled", "Completed", "Created", "Create Failed"]
    },
    {
      worksheetName: "Driver Recommendations",
      retentionDays: completedDays,
      reason: "recommendation_closed",
      closedStatuses: ["Assigned", "Failed", "Rejected", "Expired"]
    },
    {
      worksheetName: env.googleDriverScheduleWorksheetName || "Driver Schedule",
      retentionDays: completedDays,
      reason: "driver_schedule_completed",
      closedStatuses: ["Completed", "Failed", "Cancelled", "Canceled"]
    },
    {
      worksheetName: env.googleVehicleScheduleWorksheetName || "Vehicle Schedule",
      retentionDays: completedDays,
      reason: "vehicle_schedule_completed",
      closedStatuses: ["Completed", "Failed", "Cancelled", "Canceled"]
    },
    {
      worksheetName: env.googleLinkedRidesWorksheetName || "Linked Rides",
      retentionDays: reviewDays,
      reason: "linked_ride_closed",
      closedStatuses: ["Assigned", "Closed", "Expired", "Failed", "Rejected"]
    },
    {
      worksheetName: env.googleBidTrackerWorksheetName || "Bid Tracker",
      retentionDays: completedDays,
      reason: "bid_closed",
      closedStatuses: ["Bid Done", "Bid Failed", "Skipped", "Rejected"]
    },
    {
      worksheetName: env.googleAuditLogWorksheetName || "Audit Log",
      retentionDays: auditDays,
      reason: "audit_log_old",
      closedStatuses: ["Success", "Failed"]
    }
  ].filter((target) => toCell(target.worksheetName));
}

async function getSheetIdByTitle({ sheetsClient, spreadsheetId, worksheetName }) {
  const metadata = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))"
  });
  const sheet = (metadata?.data?.sheets || []).find(
    (item) => normalizeStatus(item?.properties?.title) === normalizeStatus(worksheetName)
  );
  return sheet?.properties?.sheetId;
}

async function loadWorksheetRows({ sheetsClient, spreadsheetId, worksheetName }) {
  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(worksheetName)}!A:Z`,
    majorDimension: "ROWS"
  });
  return recordsFromValues(response?.data?.values || []);
}

async function appendArchiveRows({
  sheetsClient,
  spreadsheetId,
  archiveWorksheetName,
  rows,
  archivedTime
}) {
  if (!rows.length) return { appended: 0 };
  const archiveRows = rows.map((item) =>
    buildArchiveSheetRow(
      buildArchiveRowObject({
        sourceSheet: item.sourceSheet,
        sourceRow: item.rowNumber,
        reason: item.reason,
        record: item.record,
        archivedTime
      })
    )
  );
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range: quoteSheetName(archiveWorksheetName),
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: archiveRows }
  });
  return { appended: archiveRows.length };
}

async function deleteWorksheetRows({ sheetsClient, spreadsheetId, worksheetName, rowNumbers }) {
  const safeRows = (Array.isArray(rowNumbers) ? rowNumbers : [])
    .map((row) => Number(row))
    .filter((row) => Number.isInteger(row) && row >= 2)
    .sort((left, right) => right - left);
  if (!safeRows.length) return { deleted: 0 };

  const sheetId = await getSheetIdByTitle({ sheetsClient, spreadsheetId, worksheetName });
  if (sheetId === null || sheetId === undefined) {
    throw new Error(`Worksheet ${worksheetName} not found for retention cleanup`);
  }

  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: safeRows.map((rowNumber) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber
          }
        }
      }))
    }
  });
  return { deleted: safeRows.length };
}

async function cleanupRetentionOnce(options = {}) {
  const {
    sheetsClient,
    spreadsheetId,
    archiveWorksheetName = ARCHIVE_WORKSHEET_NAME,
    targets = [],
    now = new Date(),
    timeZone = "Europe/London",
    dryRun = false
  } = options;

  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");

  const archivedTime = now.toISOString();
  const summary = {
    scanned: 0,
    archived: 0,
    deleted: 0,
    dryRun: Boolean(dryRun),
    sheets: []
  };

  for (const target of targets) {
    const worksheetName = toCell(target.worksheetName);
    if (!worksheetName || worksheetName === archiveWorksheetName) continue;

    const rows = await loadWorksheetRows({ sheetsClient, spreadsheetId, worksheetName });
    const candidates = rows
      .map((row) => {
        const decision = shouldArchiveRecord(row.record, target, { now, timeZone });
        return {
          ...row,
          sourceSheet: worksheetName,
          archive: decision.archive,
          reason: decision.reason
        };
      })
      .filter((row) => row.archive);

    summary.scanned += rows.length;
    summary.sheets.push({
      worksheetName,
      scanned: rows.length,
      archived: candidates.length
    });

    if (!candidates.length) continue;
    if (!dryRun) {
      await appendArchiveRows({
        sheetsClient,
        spreadsheetId,
        archiveWorksheetName,
        rows: candidates,
        archivedTime
      });
      await deleteWorksheetRows({
        sheetsClient,
        spreadsheetId,
        worksheetName,
        rowNumbers: candidates.map((row) => row.rowNumber)
      });
    }

    summary.archived += candidates.length;
    summary.deleted += dryRun ? 0 : candidates.length;
  }

  return summary;
}

function startRetentionCleanupPolling(options = {}) {
  const logger = options.logger || console;
  const intervalMs = Math.max(60 * 1000, Number(options.intervalMs) || 24 * 60 * 60 * 1000);
  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const summary = await cleanupRetentionOnce(options);
      if (summary.archived > 0) {
        logger.info("Retention cleanup completed", {
          stage: "retention_cleanup",
          reason: `archived=${summary.archived} deleted=${summary.deleted}`
        });
      }
    } catch (error) {
      logger.warn("Retention cleanup failed", {
        stage: "retention_cleanup",
        fallbackUsed: true,
        reason: safeTrim(error?.message) || "retention_cleanup_failed",
        error
      });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  tick();

  logger.info("Retention cleanup polling started", {
    stage: "retention_cleanup",
    reason: `interval=${intervalMs}ms`
  });

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

module.exports = {
  ARCHIVE_WORKSHEET_NAME,
  ARCHIVE_HEADERS,
  buildArchiveId,
  buildArchiveRowObject,
  buildArchiveSheetRow,
  buildDefaultRetentionTargets,
  recordsFromValues,
  parseAnyDateTime,
  isFutureRide,
  shouldArchiveRecord,
  cleanupRetentionOnce,
  startRetentionCleanupPolling
};
