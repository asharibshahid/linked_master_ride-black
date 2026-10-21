const { env } = require("../src/config/env");
const { createSheetsClient } = require("../src/sheets/sheetsClient");
const { cleanupExpiredRideRowsOnce } = require("../src/sheets/expiredRideCleanup");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const sheetsClient = createSheetsClient({
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleRidesWorksheetName,
    range: env.googleRidesRange,
    credentialsJson: env.googleCredentialsJson,
    credentialsPath: env.googleCredentialsPath
  });
  if (!sheetsClient) throw new Error("Google Sheets client is unavailable");

  const summary = await cleanupExpiredRideRowsOnce({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    dryRun
  });
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error(`Expired ride cleanup failed: ${error.message}`);
  process.exitCode = 1;
});
