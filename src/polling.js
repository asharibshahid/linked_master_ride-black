const { recommendDriversForApprovedRides } = require("./engine");

/**
 * Starts polling for approved rides to generate driver recommendations.
 * @param {object} options
 * @param {object} options.sheetsClient Authenticated Google Sheets client.
 * @param {string} options.spreadsheetId ID of the spreadsheet.
 * @param {number} options.intervalMs Polling interval in milliseconds.
 * @param {object} options.logger A logger instance.
 * @returns {{stop: function}} An object with a stop function to halt polling.
 */
function startRecommendationPolling({
  sheetsClient,
  spreadsheetId,
  finalBidWorksheetName,
  recommendationsWorksheetName,
  driversWorksheetName,
  vehiclesWorksheetName,
  intervalMs,
  logger
}) {
  logger.info("Starting driver recommendation polling.", { interval: intervalMs });

  const run = async () => {
    try {
      await recommendDriversForApprovedRides({
        sheetsClient,
        spreadsheetId,
        finalBidWorksheetName,
        recommendationsWorksheetName,
        driversWorksheetName,
        vehiclesWorksheetName
      });
    } catch (error) {
      logger.error("Error during driver recommendation polling:", { error });
    }
  };

  const intervalId = setInterval(run, intervalMs);

  return {
    stop: () => clearInterval(intervalId),
  };
}

module.exports = { startRecommendationPolling };
