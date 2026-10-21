const crypto = require("node:crypto");
const { parsePickupDateTime } = require("../sheets/upcomingJobs");

const WHATSAPP_SHEET_HEADERS = Object.freeze({
  sourceName: ["Source Name", "Company", "Group Name"],
  sourceTime: ["Source Time", "Message Time"],
  date: ["Pickup Day & Date", "Pickup Date", "Date"],
  time: ["Starting Timing", "Pickup Time", "Time"],
  pickup: ["Pickup", "Pick-Up", "From", "Origin"],
  dropOff: ["Drop Off", "Dropoff", "Drop", "Destination", "To"],
  distance: ["Distance", "Miles", "Distance Miles"],
  fare: ["Fare", "Price", "Cost", "Net Fare"],
  vehicle: ["Required Vehicle", "Vehicle", "Vehicle Type"],
  paymentStatus: ["Payment Status", "Payment"],
  refer: ["Refer", "Reference", "Ride ID", "Job ID"]
});

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function read(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && text(row[name])) return text(row[name]);
  }
  return "";
}

function rowsToRecords(values = []) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0].map(text);
  return values.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]))
  );
}

function vehicleForSheet(worksheetName) {
  return /mpv/i.test(text(worksheetName)) ? "MPV" : "Saloon";
}

function generatedRideId(row, worksheetName) {
  const explicit = read(row, WHATSAPP_SHEET_HEADERS.refer);
  if (explicit) return explicit;
  const fingerprint = [
    worksheetName,
    read(row, WHATSAPP_SHEET_HEADERS.sourceName),
    read(row, WHATSAPP_SHEET_HEADERS.sourceTime),
    read(row, WHATSAPP_SHEET_HEADERS.date),
    read(row, WHATSAPP_SHEET_HEADERS.time),
    read(row, WHATSAPP_SHEET_HEADERS.pickup),
    read(row, WHATSAPP_SHEET_HEADERS.dropOff),
    read(row, WHATSAPP_SHEET_HEADERS.fare)
  ].map((value) => text(value).toLowerCase()).join("|");
  return `WA-SHEET-${crypto.createHash("sha1").update(fingerprint).digest("hex").slice(0, 16).toUpperCase()}`;
}

function normalizeWhatsAppSheetRow(row = {}, worksheetName = "Saloon", options = {}) {
  const pickupDayDate = read(row, WHATSAPP_SHEET_HEADERS.date);
  const startingTiming = read(row, WHATSAPP_SHEET_HEADERS.time);
  const parsed = parsePickupDateTime(pickupDayDate, startingTiming, {
    timeZone: options.timeZone || "Europe/London"
  });
  const rideId = generatedRideId(row, worksheetName);
  const upcomingOnly = worksheetName === "Upcoming Jobs >79";
  return {
    rideId,
    refer: rideId,
    group_name: `WhatsApp Sheet: ${worksheetName}`,
    source_name: read(row, WHATSAPP_SHEET_HEADERS.sourceName) || `WhatsApp ${worksheetName}`,
    source_time: read(row, WHATSAPP_SHEET_HEADERS.sourceTime),
    pickup_day_date: pickupDayDate,
    starting_timing: startingTiming,
    pickup: read(row, WHATSAPP_SHEET_HEADERS.pickup),
    drop_off: read(row, WHATSAPP_SHEET_HEADERS.dropOff),
    distance: read(row, WHATSAPP_SHEET_HEADERS.distance).replace(/[^\d.-]/g, ""),
    fare: read(row, WHATSAPP_SHEET_HEADERS.fare).replace(/[^\d.-]/g, ""),
    required_vehicle: upcomingOnly ? read(row, WHATSAPP_SHEET_HEADERS.vehicle) : vehicleForSheet(worksheetName),
    payment_status: read(row, WHATSAPP_SHEET_HEADERS.paymentStatus),
    ...(upcomingOnly && parsed ? { source_expires_at: parsed.toISOString() } : {}),
    pickupAt: parsed ? parsed.toISOString() : null
  };
}

async function loadWhatsAppSheetJobs(options = {}) {
  const spreadsheetId = text(options.spreadsheetId);
  const worksheetNames = (Array.isArray(options.worksheetNames) ? options.worksheetNames : [])
    .map(text)
    .filter(Boolean);
  if (!spreadsheetId || !options.sheetsClient || worksheetNames.length === 0) {
    return { mode: "off", jobs: [], message: "WhatsApp source sheets are not configured." };
  }

  const ranges = worksheetNames.map((name) => `'${name.replace(/'/g, "''")}'!A1:Z`);
  let valueRanges;
  if (typeof options.sheetsClient.spreadsheets?.values?.batchGet === "function") {
    const response = await options.sheetsClient.spreadsheets.values.batchGet({ spreadsheetId, ranges });
    valueRanges = response.data.valueRanges || [];
  } else {
    valueRanges = await Promise.all(ranges.map(async (range) => {
      const response = await options.sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
      return response.data || {};
    }));
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const expiryHours = Math.max(1, Number(options.expireAfterPickupHours) || 12);
  const jobs = [];
  worksheetNames.forEach((worksheetName, sheetIndex) => {
    const values = valueRanges[sheetIndex]?.values;
    if (!Array.isArray(values) || !Array.isArray(values[0])) throw new Error(`Source worksheet ${worksheetName} did not load completely`);
    if (worksheetName === "Upcoming Jobs >79" && !["Refer", "Pickup Day & Date", "Starting Timing", "Pickup", "Drop Off"].every((header) => values[0].includes(header))) {
      throw new Error(`Source worksheet ${worksheetName} has unexpected headers`);
    }
    rowsToRecords(values)
      .map((row) => normalizeWhatsAppSheetRow(row, worksheetName, options))
      .filter((job) => job.pickup && job.drop_off && job.pickupAt)
      .filter((job) => new Date(job.pickupAt).getTime() + (worksheetName === "Upcoming Jobs >79" ? 0 : expiryHours * 3600000) > now.getTime())
      .forEach((job) => jobs.push(job));
  });

  return {
    mode: "sheet",
    jobs,
    message: `${jobs.length} WhatsApp source jobs loaded from ${worksheetNames.join(" and ")}.`
  };
}

module.exports = {
  WHATSAPP_SHEET_HEADERS,
  rowsToRecords,
  vehicleForSheet,
  generatedRideId,
  normalizeWhatsAppSheetRow,
  loadWhatsAppSheetJobs
};
