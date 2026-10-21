const { parsePickupDateTime } = require("./upcomingJobs");
const { withSheetMutation } = require("./mutationQueue");

const TARGET_SHEETS = Object.freeze(["Rides", "Needs Review", "Upcoming Jobs >79"]);
const GRACE_MS = 60 * 60 * 1000;

function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

const SHORT_MONTHS = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
});

function normalizeShortDate(value) {
  const match = String(value || "").trim().match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]{3})\s+(\d{2})$/i
  );
  if (!match) return value;
  const month = SHORT_MONTHS[match[2].toLowerCase()];
  return month ? `${match[1]}/${month}/20${match[3]}` : value;
}

function expiredRowNumbers(values, now) {
  const headers = values[0] || [];
  const dateIndex = headers.indexOf("Pickup Day & Date");
  const timeIndex = headers.indexOf("Starting Timing");
  if (dateIndex < 0 || timeIndex < 0) {
    throw new Error("Pickup date/time columns missing; refusing to delete rows");
  }

  const cutoff = now.getTime() - GRACE_MS;
  return values.slice(1).flatMap((row, index) => {
    const pickup = parsePickupDateTime(normalizeShortDate(row[dateIndex]), row[timeIndex], {
      timeZone: "Europe/London"
    });
    return pickup && pickup.getTime() <= cutoff ? [index + 2] : [];
  });
}

function deleteRanges(rowNumbers, sheetId) {
  const ranges = [];
  for (const rowNumber of rowNumbers) {
    const previous = ranges[ranges.length - 1];
    if (previous && rowNumber === previous.startIndex) {
      previous.startIndex = rowNumber - 1;
    } else {
      ranges.push({ sheetId, dimension: "ROWS", startIndex: rowNumber - 1, endIndex: rowNumber });
    }
  }
  return ranges;
}

async function cleanupExpiredRideRowsOnce({ sheetsClient, spreadsheetId, now = new Date(), dryRun = false }) {
  if (!sheetsClient || !spreadsheetId) throw new Error("Google Sheets is not configured");
  const metadata = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))"
  });
  const sheetIds = new Map((metadata?.data?.sheets || []).map(({ properties }) => [
    properties.title,
    properties.sheetId
  ]));
  const missing = TARGET_SHEETS.filter((name) => !sheetIds.has(name));
  if (missing.length) throw new Error(`Expected worksheet missing: ${missing.join(", ")}`);
  const summary = { scanned: 0, candidates: 0, deleteRequests: 0, deleted: 0, sheets: {}, dryRun };

  for (const worksheetName of TARGET_SHEETS) {
    await withSheetMutation(spreadsheetId, worksheetName, async () => {
      const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${quoteSheetName(worksheetName)}!A:Z`,
        majorDimension: "ROWS"
      });
      const values = response?.data?.values || [];
      const rows = expiredRowNumbers(values, now).sort((a, b) => b - a);
      const ranges = deleteRanges(rows, sheetIds.get(worksheetName));
      summary.scanned += Math.max(0, values.length - 1);
      summary.candidates += rows.length;
      summary.deleteRequests += ranges.length;
      summary.sheets[worksheetName] = rows.length;

      if (dryRun) return;
      for (let offset = 0; offset < ranges.length; offset += 100) {
        await sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: ranges.slice(offset, offset + 100).map((range) => ({
              deleteDimension: { range }
            }))
          }
        });
        summary.deleted += ranges.slice(offset, offset + 100).reduce(
          (count, range) => count + range.endIndex - range.startIndex, 0
        );
      }
    });
  }
  return summary;
}

function startExpiredRideCleanupPolling(options) {
  const logger = options.logger || console;
  const intervalMs = Math.max(60 * 1000, Number(options.intervalMs) || 5 * 60 * 1000);
  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const summary = await cleanupExpiredRideRowsOnce(options);
      if (summary.deleted) {
        logger.info("Expired WhatsApp sheet rides deleted", {
          stage: "expired_ride_cleanup",
          reason: `deleted=${summary.deleted} sheets=${JSON.stringify(summary.sheets)}`
        });
      }
    } catch (error) {
      logger.warn("Expired WhatsApp sheet cleanup failed", {
        stage: "expired_ride_cleanup",
        reason: error?.message || "cleanup_failed",
        error
      });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}

module.exports = { TARGET_SHEETS, GRACE_MS, normalizeShortDate, expiredRowNumbers, deleteRanges, cleanupExpiredRideRowsOnce, startExpiredRideCleanupPolling };
