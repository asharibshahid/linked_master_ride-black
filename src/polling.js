const {
  processApprovedDriverRecommendations,
  recommendDriversForApprovedRides
} = require("./engine");

function isQuotaError(error) {
  const text = String(error?.message || error?.response?.data?.error?.message || "").toLowerCase();
  const status = Number(error?.code || error?.response?.status || error?.status);
  return status === 429 || text.includes("quota exceeded") || text.includes("rate limit");
}

/**
 * Starts polling for approved rides to generate driver recommendations.
 * @param {object} options
 * @param {object} options.sheetsClient Authenticated Google Sheets client.
 * @param {string} options.spreadsheetId ID of the spreadsheet.
 * @param {number} options.intervalMs Polling interval in milliseconds.
 * @param {object} options.logger A logger instance.
 * @returns {{stop: function, tick: function}} Controls for the polling loop.
 */
function startRecommendationPolling({
  sheetsClient,
  spreadsheetId,
  finalBidWorksheetName,
  recommendationsWorksheetName,
  driverScheduleWorksheetName,
  vehicleScheduleWorksheetName,
  linkedRidesWorksheetName,
  driversWorksheetName,
  vehiclesWorksheetName,
  intervalMs,
  timeZone,
  durationMinutes,
  minGapMinutes,
  databaseRepository,
  logger
}) {
  const safeLogger = {
    info: typeof logger?.info === "function" ? logger.info.bind(logger) : () => {},
    warn: typeof logger?.warn === "function" ? logger.warn.bind(logger) : () => {},
    debug: typeof logger?.debug === "function" ? logger.debug.bind(logger) : () => {},
    error: typeof logger?.error === "function" ? logger.error.bind(logger) : () => {}
  };
  const safeIntervalMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
    ? Number(intervalMs)
    : 60000;

  safeLogger.debug("Starting driver recommendation polling", {
    stage: "recommendations",
    fallbackUsed: false,
    reason: `interval=${safeIntervalMs}ms`
  });

  let activeRun = null;
  let backoffUntil = 0;

  const executeRun = async () => {
    const now = Date.now();
    if (backoffUntil > now) {
      safeLogger.debug("Driver recommendation polling paused for Sheets quota backoff", {
        stage: "recommendations",
        fallbackUsed: true,
        reason: `backoff_seconds=${Math.ceil((backoffUntil - now) / 1000)}`
      });
      return {
        assignment: null,
        recommendation: null,
        skipped: true,
        reason: "sheets_quota_backoff"
      };
    }

    try {
      const assignment = await processApprovedDriverRecommendations({
        sheetsClient,
        spreadsheetId,
        finalBidWorksheetName,
        recommendationsWorksheetName,
        driverScheduleWorksheetName,
        vehicleScheduleWorksheetName,
        linkedRidesWorksheetName,
        driversWorksheetName,
        logger: safeLogger,
        timeZone,
        durationMinutes,
        minGapMinutes,
        databaseRepository
      });
      const recommendation = await recommendDriversForApprovedRides({
        sheetsClient,
        spreadsheetId,
        finalBidWorksheetName,
        recommendationsWorksheetName,
        driverScheduleWorksheetName,
        vehicleScheduleWorksheetName,
        linkedRidesWorksheetName,
        driversWorksheetName,
        vehiclesWorksheetName,
        logger: safeLogger,
        timeZone,
        durationMinutes,
        minGapMinutes,
        databaseRepository
      });
      return {
        assignment,
        recommendation
      };
    } catch (error) {
      if (isQuotaError(error)) {
        backoffUntil = Date.now() + Math.max(safeIntervalMs * 3, 3 * 60 * 1000);
      }
      safeLogger.error("Error during driver recommendation polling", {
        stage: "recommendations",
        fallbackUsed: true,
        reason: isQuotaError(error) ? "sheets_quota_backoff" : error?.message || "recommendation_poll_failed",
        error
      });
      return {
        assignment: null,
        recommendation: null,
        failed: true,
        reason: error?.message || "recommendation_poll_failed",
        error
      };
    }
  };

  const run = () => {
    if (activeRun) {
      safeLogger.debug("Driver recommendation run already active", {
        stage: "recommendations",
        fallbackUsed: false,
        reason: "reusing_active_run"
      });
      return activeRun;
    }

    activeRun = executeRun().finally(() => {
      activeRun = null;
    });
    return activeRun;
  };

  run();
  const intervalId = setInterval(run, safeIntervalMs);

  return {
    stop: () => clearInterval(intervalId),
    tick: async () => {
      const result = await run();
      if (result?.failed) {
        throw result.error || new Error(result.reason || "recommendation_poll_failed");
      }
      return result;
    }
  };
}

module.exports = { startRecommendationPolling };
