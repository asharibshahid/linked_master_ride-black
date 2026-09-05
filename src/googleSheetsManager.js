// src/googleSheetsManager.js

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

// Load environment variables
require('dotenv').config();

const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const DRIVERS_WORKSHEET_NAME = 'Drivers';
const VEHICLES_WORKSHEET_NAME = 'Vehicles';
const RECOMMENDATIONS_WORKSHEET_NAME = 'Driver Recommendations';
const DRIVER_SCHEDULE_WORKSHEET_NAME = 'Driver Schedule';
const LINKED_RIDES_WORKSHEET_NAME = 'Linked Rides';
const VEHICLE_SCHEDULE_WORKSHEET_NAME = 'Vehicle Schedule';

const DRIVERS_HEADERS = [
  'Driver ID',
  'Driver Name',
  'WhatsApp Number',
  'Status',
  'Current Location',
  'Working Hours',
  'Vehicle ID',
];

const VEHICLES_HEADERS = [
  'Vehicle ID',
  'Vehicle Type',
  'Seats',
  'Registration',
  'Driver ID',
];

const RECOMMENDATION_HEADERS = [
  'Ride ID',
  'Pickup',
  'Drop Off',
  'Required Vehicle',
  'Recommended Driver',
  'Recommended Vehicle',
  'Linked Ride ID',
  'Previous Ride',
  'Next Ride',
  'Time Gap',
  'Distance Between',
  'Estimated Saving',
  'Score',
  'Reason',
  'Created Time',
  'Status',
  'Assignment Status',
];

const DRIVER_SCHEDULE_HEADERS = [
  'Assignment ID',
  'Driver ID',
  'Ride ID',
  'Pickup',
  'Drop Off',
  'Start Time',
  'End Time',
  'Status',
  'Next Available Time',
  'Current Location',
  'Previous Ride ID',
  'Next Ride ID',
];

const LINKED_RIDES_HEADERS = [
  'Link ID',
  'First Ride ID',
  'Second Ride ID',
  'Driver ID',
  'Vehicle ID',
  'Previous Drop',
  'Next Pickup',
  'Time Gap',
  'Distance Between',
  'Saving Estimate',
  'Status',
];

const VEHICLE_SCHEDULE_HEADERS = [
  'Vehicle ID',
  'Ride ID',
  'Driver ID',
  'Start Time',
  'End Time',
  'Status',
];


const DRIVERS_DEMO_DATA = [
  ['001', 'Ali Khan', '+447700000001', 'Available', 'Heathrow', 'Any', 'V001'],
  ['002', 'Sarah Connor', '+447700000002', 'Available', 'Gatwick', 'Any', 'V002'],
  ['003', 'Mike Johnson', '+447700000003', 'Busy', 'Central London', '08:00-20:00', 'V003'],
];

const VEHICLES_DEMO_DATA = [
  ['V001', 'MPV', '8', 'ABC-123', '001'],
  ['V002', 'Estate', '5', 'XYZ-789', '002'],
  ['V003', 'Saloon', '4', 'LMN-456', '003'],
];

const RECOMMENDATIONS_DEMO_DATA = []; // No demo data needed for recommendations
const DRIVER_SCHEDULE_DEMO_DATA = [];
const LINKED_RIDES_DEMO_DATA = [];
const VEHICLE_SCHEDULE_DEMO_DATA = [];

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
  await verifyAndInitializeSheet(DRIVER_SCHEDULE_WORKSHEET_NAME, DRIVER_SCHEDULE_HEADERS, DRIVER_SCHEDULE_DEMO_DATA);
  await verifyAndInitializeSheet(VEHICLE_SCHEDULE_WORKSHEET_NAME, VEHICLE_SCHEDULE_HEADERS, VEHICLE_SCHEDULE_DEMO_DATA);
  await verifyAndInitializeSheet(LINKED_RIDES_WORKSHEET_NAME, LINKED_RIDES_HEADERS, LINKED_RIDES_DEMO_DATA);

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
  DRIVER_SCHEDULE_WORKSHEET_NAME,
  DRIVER_SCHEDULE_HEADERS,
  LINKED_RIDES_WORKSHEET_NAME,
  LINKED_RIDES_HEADERS,
  VEHICLE_SCHEDULE_WORKSHEET_NAME,
  VEHICLE_SCHEDULE_HEADERS,
};
