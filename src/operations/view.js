const { buildAppendRange } = require("../sheets/appendRow");
const { sortRideRecordsByPickupDateTime } = require("../sheets/upcomingJobs");
const { safeTrim } = require("../utils/text");
const { loadFinalBidRows } = require("../calendar/approvalWorkflow");

const OPERATIONS_VIEW_HEADERS = Object.freeze([
  "Ride ID",
  "Route",
  "Date",
  "Time",
  "Fare",
  "Status",
  "Assigned Driver",
  "Calendar Status",
  "Linked Ride"
]);

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function buildRoute(record = {}) {
  const pickup = toCell(record.Pickup);
  const dropOff = toCell(record["Drop Off"]);
  if (pickup && dropOff) return `${pickup} -> ${dropOff}`;
  return pickup || dropOff || "";
}

function buildLinkedRide(record = {}) {
  return toCell(record.Refer);
}

function mapFinalBidRecordToOperationsRow(record = {}) {
  return [
    toCell(record.Refer),
    buildRoute(record),
    toCell(record["Pickup Day & Date"]),
    toCell(record["Starting Timing"]),
    toCell(record.Fare),
    toCell(record.Status) || "Pending",
    toCell(record["Assigned Driver"]),
    toCell(record["Calendar Status"]),
    buildLinkedRide(record)
  ];
}

function buildOperationsRows(records = []) {
  return sortRideRecordsByPickupDateTime(Array.isArray(records) ? records : [])
    .filter((record) => toCell(record.Refer))
    .map(mapFinalBidRecordToOperationsRow);
}

function buildOperationsRange(worksheetName, rangeSuffix) {
  const worksheet = buildAppendRange({ range: "", worksheetName });
  return `${worksheet}!${rangeSuffix}`;
}

async function refreshOperationsView(options = {}) {
  const {
    sheetsClient,
    spreadsheetId,
    finalBidWorksheetName = "Final Bid",
    operationsWorksheetName = "Operations View",
    logger = { info: () => {}, warn: () => {}, debug: () => {} }
  } = options;

  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");

  const { records } = await loadFinalBidRows({
    sheetsClient,
    spreadsheetId,
    worksheetName: finalBidWorksheetName,
    logger
  });
  const rows = buildOperationsRows(records);

  await sheetsClient.spreadsheets.values.clear({
    spreadsheetId,
    range: buildOperationsRange(operationsWorksheetName, "A2:I")
  });

  if (rows.length > 0) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: buildOperationsRange(operationsWorksheetName, "A2:I"),
      valueInputOption: "RAW",
      requestBody: {
        values: rows
      }
    });
  }

  return {
    rowsWritten: rows.length
  };
}

function startOperationsViewPolling(options = {}) {
  const logger = {
    info: typeof options.logger?.info === "function" ? options.logger.info.bind(options.logger) : () => {},
    warn: typeof options.logger?.warn === "function" ? options.logger.warn.bind(options.logger) : () => {},
    debug: typeof options.logger?.debug === "function" ? options.logger.debug.bind(options.logger) : () => {}
  };
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(10000, Math.trunc(options.intervalMs))
    : 60000;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await refreshOperationsView(options);
    } catch (error) {
      logger.warn("Operations View refresh failed", {
        stage: "operations_view",
        fallbackUsed: true,
        reason: safeTrim(error?.message) || "Refresh failed",
        error
      });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(tick, 1500).unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
    tick
  };
}

module.exports = {
  OPERATIONS_VIEW_HEADERS,
  buildRoute,
  buildLinkedRide,
  mapFinalBidRecordToOperationsRow,
  buildOperationsRows,
  refreshOperationsView,
  startOperationsViewPolling
};
