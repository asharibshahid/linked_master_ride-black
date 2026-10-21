const { env } = require("../src/config/env");
const { STRICT_SHEET_HEADERS } = require("../src/extraction/schemas");
const { createSheetsClient } = require("../src/sheets/sheetsClient");

const worksheets = ["Rides", "Needs Review", "Upcoming Jobs >79"];

async function main() {
  const apply = process.argv.includes("--apply");
  const sheetsClient = createSheetsClient({
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleRidesWorksheetName,
    range: env.googleRidesRange,
    credentialsJson: env.googleCredentialsJson,
    credentialsPath: env.googleCredentialsPath
  });
  if (!sheetsClient) throw new Error("Google Sheets client is unavailable");
  if (STRICT_SHEET_HEADERS.at(-1) !== "Special Instructions") {
    throw new Error("Collector schema has not been updated");
  }

  const results = [];
  for (const name of worksheets) {
    const range = `'${name.replace(/'/g, "''")}'!1:1`;
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: env.googleSheetsId,
      range
    });
    const headers = response?.data?.values?.[0] || [];
    const matchesOld = headers.length === STRICT_SHEET_HEADERS.length - 1 &&
      headers.every((value, index) => value === STRICT_SHEET_HEADERS[index]);
    const matchesNew = headers.length === STRICT_SHEET_HEADERS.length &&
      headers.every((value, index) => value === STRICT_SHEET_HEADERS[index]);
    if (!matchesOld && !matchesNew) {
      throw new Error(`${name} headers differ from expected collector schema; no migration applied`);
    }
    results.push({ name, needsHeader: matchesOld });
  }

  if (apply) {
    for (const item of results.filter((result) => result.needsHeader)) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: env.googleSheetsId,
        range: `'${item.name.replace(/'/g, "''")}'!M1`,
        valueInputOption: "RAW",
        requestBody: { values: [["Special Instructions"]] }
      });
    }
  }
  console.log(JSON.stringify({ apply, results }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
