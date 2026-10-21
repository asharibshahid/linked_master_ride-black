const { parsePickupDateTime } = require("../sheets/upcomingJobs");

const PREBOOK_HEADERS = Object.freeze({
  rideId: ["Booking ID", "ACE ID", "Ride ID", "Refer", "Reference", "Job ID"],
  pickup: ["Pickup", "Pick-Up", "From", "Origin"],
  dropOff: ["Drop-off", "Drop Off", "Dropoff", "Drop", "Destination", "To"],
  date: ["Pickup Day & Date", "Date", "Pickup Date"],
  time: ["Starting Timing", "Time", "Pickup Time"],
  fare: ["Discounted Fare", "Fare", "Price", "Cost", "Net Fare"],
  vehicle: ["Required Vehicle", "Vehicle", "Vehicle Type", "Car", "Type"],
  distance: ["Miles", "Distance", "Distance Miles"],
  status: ["Booking Status", "Status"]
});

const CLOSED_STATUSES = /cancelled|canceled|rejected|deleted|failed/i;

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function read(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && text(row[name])) return text(row[name]);
  }
  return "";
}

function detectNumericDateOrder(rows = []) {
  let mdyEvidence = 0;
  let dmyEvidence = 0;
  for (const row of rows) {
    const value = read(row, PREBOOK_HEADERS.date);
    const match = value.match(/\b(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}\b/);
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first <= 12 && second > 12) mdyEvidence += 1;
    if (first > 12 && second <= 12) dmyEvidence += 1;
  }
  return mdyEvidence > dmyEvidence ? "mdy" : "dmy";
}

function normalizePrebookRow(row = {}, index = 0, options = {}) {
  const date = read(row, PREBOOK_HEADERS.date);
  const formattedTime = read(row, PREBOOK_HEADERS.time);
  const rawTime = typeof options.rawTime === "number" ? options.rawTime : null;
  const durationMinutes = rawTime !== null && Number.isFinite(rawTime) && rawTime >= 0 && rawTime < 2
    ? Math.round(rawTime * 1440)
    : null;
  const recoveredTime = durationMinutes === null
    ? ""
    : `${String(Math.floor(durationMinutes / 60)).padStart(2, "0")}:${String(durationMinutes % 60).padStart(2, "0")}`;
  const time = recoveredTime || formattedTime;
  const parsed = parsePickupDateTime(date, time, {
    timeZone: options.timeZone || "Europe/London",
    numericDateOrder: options.numericDateOrder || "dmy"
  });
  const rideId = read(row, PREBOOK_HEADERS.rideId) || `PRE-${String(index + 1).padStart(4, "0")}`;
  return {
    rideId,
    refer: rideId,
    sourceType: "PreBook",
    sourceName: options.sourceName || "PreBook Sheet",
    pickupDayDate: date,
    startingTiming: time,
    pickup: read(row, PREBOOK_HEADERS.pickup),
    dropOff: read(row, PREBOOK_HEADERS.dropOff),
    fare: read(row, PREBOOK_HEADERS.fare).replace(/[^\d.-]/g, ""),
    requiredVehicle: read(row, PREBOOK_HEADERS.vehicle),
    distance: read(row, PREBOOK_HEADERS.distance).replace(/[^\d.-]/g, ""),
    status: read(row, PREBOOK_HEADERS.status),
    pickupAt: parsed ? parsed.toISOString() : null,
    isDemo: Boolean(options.isDemo)
  };
}

function buildDemoPrebookJobs(now = new Date()) {
  const londonDate = new Date(now.getTime() + 2 * 86400000);
  const laterDate = new Date(now.getTime() + 5 * 86400000);
  const dateText = (date) => new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
  return [
    normalizePrebookRow({
      "Ride ID": "PRE-DEMO-001",
      Date: dateText(londonDate),
      Time: "10:00",
      Pickup: "Heathrow Airport Terminal 5",
      "Drop Off": "Chelsea London SW3",
      Fare: "120",
      Vehicle: "MPV"
    }, 0, { sourceName: "Demo PreBook", isDemo: true }),
    normalizePrebookRow({
      "Ride ID": "PRE-DEMO-002",
      Date: dateText(laterDate),
      Time: "14:30",
      Pickup: "Gatwick Airport",
      "Drop Off": "Reading RG1",
      Fare: "105",
      Vehicle: "Saloon"
    }, 1, { sourceName: "Demo PreBook", isDemo: true })
  ];
}

function rowsToRecords(values = []) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0].map(text);
  return values.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

async function loadPrebookJobs(options = {}) {
  const spreadsheetId = text(options.spreadsheetId);
  const worksheetName = text(options.worksheetName || "PreBook");
  if (!spreadsheetId || !options.sheetsClient) {
    return { mode: "demo", jobs: buildDemoPrebookJobs(options.now || new Date()), message: "Demo data active until a PreBook Google Sheet is configured." };
  }

  const response = await options.sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `'${worksheetName.replace(/'/g, "''")}'`
  });
  const now = options.now instanceof Date ? options.now : new Date();
  const expiryHours = Math.max(1, Number(options.expireAfterPickupHours) || 12);
  const records = rowsToRecords(response.data.values || []);
  const numericDateOrder = detectNumericDateOrder(records);
  let rawRows = [];
  if (records.length > 0) {
    const rawResponse = await options.sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${worksheetName.replace(/'/g, "''")}'`,
      valueRenderOption: "UNFORMATTED_VALUE"
    });
    rawRows = rawResponse.data.values || [];
  }
  const timeHeaderIndex = (response.data.values?.[0] || []).findIndex((header) =>
    PREBOOK_HEADERS.time.some((name) => name.toLowerCase() === text(header).toLowerCase()));
  const jobs = records
    .map((row, index) => normalizePrebookRow(row, index, {
      timeZone: options.timeZone,
      numericDateOrder,
      rawTime: timeHeaderIndex >= 0 ? rawRows[index + 1]?.[timeHeaderIndex] : undefined
    }))
    .filter((job) => job.rideId && !CLOSED_STATUSES.test(job.status))
    .filter((job) => !job.pickupAt || new Date(job.pickupAt).getTime() + expiryHours * 3600000 > now.getTime());
  return { mode: "sheet", jobs, message: `${jobs.length} PreBook jobs loaded from Google Sheets.` };
}

module.exports = {
  PREBOOK_HEADERS,
  detectNumericDateOrder,
  normalizePrebookRow,
  buildDemoPrebookJobs,
  rowsToRecords,
  loadPrebookJobs
};
