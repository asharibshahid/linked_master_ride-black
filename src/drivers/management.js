const { fetchSheetHeaders, buildAppendRange } = require("../sheets/appendRow");
const { safeTrim, collapseWhitespace } = require("../utils/text");

const DRIVER_HEADERS = Object.freeze([
  "Driver ID",
  "Driver Name",
  "WhatsApp Number",
  "Status",
  "Current Location",
  "Working Hours",
  "Vehicle ID"
]);

const VEHICLE_HEADERS = Object.freeze([
  "Vehicle ID",
  "Vehicle Type",
  "Seats",
  "Registration",
  "Driver ID",
  "Status"
]);

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeComparableText(value) {
  return collapseWhitespace(String(value || "")).toLowerCase();
}

function formatDriverId(value) {
  const text = toCell(value);
  if (!text) return "";

  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return text;
  }

  return String(Math.trunc(numeric)).padStart(3, "0");
}

function mapRowsToObjects(headers, rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = toCell(Array.isArray(row) ? row[index] : "");
    });
    return record;
  });
}

function normalizeDriverRecord(record = {}) {
  return {
    driver_id: formatDriverId(record.driver_id || record["Driver ID"]),
    driver_name: toCell(record.driver_name || record["Driver Name"]),
    whatsapp_number: toCell(record.whatsapp_number || record["WhatsApp Number"]),
    current_status: toCell(record.current_status || record.status || record.Status || record["Current Status"]),
    location: toCell(record.location || record["Current Location"] || record.Location),
    working_hours: toCell(record.working_hours || record["Working Hours"]),
    vehicle_id: toCell(record.vehicle_id || record["Vehicle ID"])
  };
}

function normalizeVehicleRecord(record = {}) {
  return {
    vehicle_id: toCell(record.vehicle_id || record["Vehicle ID"]),
    vehicle_type: toCell(record.vehicle_type || record["Vehicle Type"]),
    seats: toCell(record.seats || record.Seats),
    registration: toCell(record.registration || record.Registration || record["Registration Number"]),
    driver_id: formatDriverId(record.driver_id || record["Driver ID"]),
    status: toCell(record.status || record.Status || record.availability || record.Availability)
  };
}

function isDriverAvailable(driver = {}, options = {}) {
  const availableStatuses = (
    Array.isArray(options.availableStatuses) && options.availableStatuses.length > 0
      ? options.availableStatuses
      : ["available"]
  ).map((status) => normalizeComparableText(status));
  const status = normalizeComparableText(driver.current_status || driver["Current Status"]);
  return availableStatuses.includes(status);
}

function resolveNextDriverId(drivers = []) {
  const maxId = (Array.isArray(drivers) ? drivers : []).reduce((max, driver) => {
    const id = normalizeDriverRecord(driver).driver_id;
    const numeric = Number(id);
    if (!Number.isFinite(numeric)) return max;
    return Math.max(max, numeric);
  }, 0);

  return formatDriverId(maxId + 1);
}

async function loadDriverRows({
  sheetsClient,
  spreadsheetId,
  worksheetName = "Drivers",
  logger
}) {
  const headers = await fetchSheetHeaders({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    maxAttempts: 3,
    retryDelayMs: 500,
    logger
  });

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: buildAppendRange({ range: "", worksheetName }),
    majorDimension: "ROWS"
  });
  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  const headerMatches = headers.every(
    (header, index) => toCell(values[0]?.[index]) === toCell(header)
  );
  const rows = headerMatches ? values.slice(1) : values;

  return mapRowsToObjects(headers, rows).map(normalizeDriverRecord);
}

async function loadAvailableDrivers(options = {}) {
  const drivers = await loadDriverRows(options);
  return drivers.filter((driver) => isDriverAvailable(driver, options));
}

module.exports = {
  DRIVER_HEADERS,
  VEHICLE_HEADERS,
  formatDriverId,
  normalizeDriverRecord,
  normalizeVehicleRecord,
  isDriverAvailable,
  resolveNextDriverId,
  loadDriverRows,
  loadAvailableDrivers
};
