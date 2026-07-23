// src/googleSheetsManager.js

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

// Load environment variables
require('dotenv').config();

const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const DRIVERS_WORKSHEET_NAME = 'Drivers';
const VEHICLES_WORKSHEET_NAME = 'Vehicles';
const RECOMMENDATIONS_WORKSHEET_NAME = 'Driver Recommendations';

const DRIVERS_HEADERS = [
  'Driver ID',
  'Driver Name',
  'WhatsApp Number',
  'Vehicle ID',
  'Status',
  'Current Location',
  'Home Location',
  'Working Hours',
  'Preferred Areas',
  'Last Assigned Ride',
  'Total Jobs',
  'Performance Score',
];

const VEHICLES_HEADERS = [
  'Vehicle ID',
  'Vehicle Category',
  'Make',
  'Model',
  'Seats',
  'Registration',
  'Assigned Driver ID',
  'Status',
];

const RECOMMENDATION_HEADERS = [ // Updated headers
  'Ride ID',
  'Pickup',
  'Drop Off',
  'Required Vehicle',
  'Recommended Driver',
  'Vehicle Match Score',
  'Availability Score',
  'Calendar Score', // Added Calendar Score
  'Distance Score',
  'Route Compatibility Score',
  'Total Score',
  'Reason',
];


const DRIVERS_DEMO_DATA = [
  ['D-001', 'John Smith', '+447700000001', 'V-001', 'Available', 'Heathrow', 'London', '06:00-23:00', 'Central London, West London', '', '0', '100'],
  ['D-002', 'Sarah Connor', '+447700000002', 'V-002', 'Available', 'Gatwick', 'London', '06:00-23:00', 'South London, East London', '', '0', '100'],
  ['D-003', 'Mike Johnson', '+447700000003', 'V-003', 'Busy', 'Central London', 'London', '08:00-20:00', 'Central London', '', '0', '95'],
];

const VEHICLES_DEMO_DATA = [
  ['V-001', 'MPV', 'Toyota', 'Camry', '7', 'ABC-123', 'D-001', 'Active'],
  ['V-002', 'Estate', 'Ford', 'Explorer', '5', 'XYZ-789', 'D-002', 'Active'],
  ['V-003', 'Saloon', 'Honda', 'Odyssey', '4', 'LMN-456', 'D-003', 'Active'],
];

const RECOMMENDATIONS_DEMO_DATA = []; // No demo data needed for recommendations

let sheets;

function quoteSheetName(sheetName) {
  const name = String(sheetName || "").trim();
  if (!name) return "";
  return `'${name.replace(/'/g, "''")}'`;
}

function mapRowsToRecords(headers, rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      const value = Array.isArray(row) ? row[index] : "";
      record[header] = value === null || value === undefined ? "" : String(value).trim();
    });
    return record;
  });
}

/**
 * Initializes the Google Sheets API client.
 */
async function initializeSheetsClient() {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  sheets = google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Retrieves the headers of a given Google Sheet.
 * @param {string} sheetName The name of the sheet.
 * @returns {Promise<Array<string>>} A promise that resolves to an array of header strings.
 */
async function getSheetHeaders(sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: `${sheetName}!1:1`, // Get the first row
  });
  return response.data.values ? response.data.values[0] : [];
}

/**
 * Clears the content of a specified sheet.
 * @param {string} sheetName The name of the sheet to clear.
 */
async function clearSheet(sheetName) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: sheetName,
  });
}

/**
 * Writes data to a specified sheet, starting from a given row.
 * @param {string} sheetName The name of the sheet.
 * @param {Array<Array<any>>} data The data to write.
 * @param {string} range The A1 notation of the range to write to (e.g., 'Sheet1!A1').
 */
async function writeSheetData(sheetName, data, range) {
  if (sheetName?.spreadsheets?.values && arguments.length >= 4) {
    const [client, spreadsheetId, targetSheetName, rows] = arguments;
    await client.spreadsheets.values.append({
      spreadsheetId,
      range: `${quoteSheetName(targetSheetName)}!A:Z`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: Array.isArray(rows) ? rows : [],
      },
    });
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: `${sheetName}!${range}`,
    valueInputOption: 'RAW',
    resource: {
      values: data,
    },
  });
}

async function getSheetData(sheetsClient, spreadsheetId, sheetName) {
  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");
  if (!sheetName) throw new Error("Sheet name is missing");

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(sheetName)}!A:Z`,
    majorDimension: 'ROWS',
  });
  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  if (values.length === 0) return [];

  const headers = values[0].map((header) => String(header || "").trim());
  return mapRowsToRecords(headers, values.slice(1));
}

/**
 * Verifies the schema of a sheet and initializes it with demo data if empty or schema is incorrect.
 * @param {string} sheetName The name of the sheet.
 * @param {Array<string>} expectedHeaders The expected headers for the sheet.
 * @param {Array<Array<any>>} demoData The demo data to populate if the sheet is empty.
 */
async function verifyAndInitializeSheet(sheetName, expectedHeaders, demoData) {
  console.log(`Verifying schema for sheet: ${sheetName}`);
  let currentHeaders = await getSheetHeaders(sheetName);

  const headersMatch =
    currentHeaders.length === expectedHeaders.length &&
    currentHeaders.every((header, index) => header === expectedHeaders[index]);

  if (!headersMatch) {
    console.warn(`Schema mismatch for sheet: ${sheetName}. Clearing and re-initializing.`);
    await clearSheet(sheetName);
    await writeSheetData(sheetName, [expectedHeaders], 'A1');
    await writeSheetData(sheetName, demoData, 'A2');
    console.log(`Sheet '${sheetName}' re-initialized with expected schema and demo data.`);
  } else if (currentHeaders.length === expectedHeaders.length && currentHeaders.length === 0) {
    // Sheet exists but is completely empty (no headers or data)
    console.log(`Sheet '${sheetName}' is empty. Initializing with schema and demo data.`);
    await writeSheetData(sheetName, [expectedHeaders], 'A1');
    await writeSheetData(sheetName, demoData, 'A2');
  } else {
    console.log(`Schema for sheet '${sheetName}' is correct.`);
    // Check if there's any data beyond headers. If not, add demo data.
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${sheetName}!A2`, // Check if there's data in the second row
    });
    if (!response.data.values || response.data.values.length === 0) {
      console.log(`Sheet '${sheetName}' has correct schema but no data. Populating with demo data.`);
      await writeSheetData(sheetName, demoData, 'A2');
    }
  }
}

/**
 * Main function to set up Google Sheets for AI driver assignment.
 */
async function setupDriverAssignmentSheets() {
  await initializeSheetsClient();

  await verifyAndInitializeSheet(DRIVERS_WORKSHEET_NAME, DRIVERS_HEADERS, DRIVERS_DEMO_DATA);
  await verifyAndInitializeSheet(VEHICLES_WORKSHEET_NAME, VEHICLES_HEADERS, VEHICLES_DEMO_DATA);
  await verifyAndInitializeSheet(RECOMMENDATIONS_WORKSHEET_NAME, RECOMMENDATION_HEADERS, RECOMMENDATIONS_DEMO_DATA);

  console.log('Google Sheets setup for AI driver assignment completed.');
}

module.exports = {
  setupDriverAssignmentSheets,
  getSheetData,
  writeSheetData,
  DRIVERS_WORKSHEET_NAME,
  VEHICLES_WORKSHEET_NAME,
  DRIVERS_HEADERS,
  VEHICLES_HEADERS,
  RECOMMENDATION_HEADERS,
};
