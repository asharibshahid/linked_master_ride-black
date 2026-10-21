const { evaluateRideAreaCriteria } = require("../rules/areaCriteria");

const UK_AREA_PREFIXES = Object.freeze([
  "AL", "B", "BA", "BH", "BL", "BN", "BR", "BS", "CB", "CF", "CM", "CO", "CR", "CT",
  "CV", "DE", "DN", "DT", "DY", "E", "EC", "EN", "EX", "GL", "GU", "HA", "HP", "HR",
  "HU", "IP", "KT", "L", "LE", "LL", "LN", "LU", "M", "ME", "MK", "N", "NE", "NG",
  "NN", "NP", "NR", "NW", "OX", "PE", "PL", "PO", "RG", "RH", "RM", "S", "SA", "SE",
  "SG", "SK", "SL", "SN", "SO", "SP", "ST", "SW", "TA", "TN", "TQ", "TR", "TS", "TW",
  "UB", "W", "WC", "WR", "WS", "LHR", "LGW", "STN", "LTN", "LCY", "SEN", "BHX", "MAN"
]);

const DEFAULT_JOB_LINKER_CRITERIA = Object.freeze({
  minFare: 80,
  allowedVehicles: ["Saloon", "MPV", "6 Seater"],
  allowedAreaCodes: UK_AREA_PREFIXES,
  areaMatchMode: "either",
  maxLinkGapHours: 6,
  minimumTurnaroundMinutes: 30,
  expireAfterPickupHours: 12,
  trashRetentionHours: 24
});

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value, fallback = []) {
  const input = Array.isArray(value) ? value : text(value).split(/[;,\n]/);
  const normalized = input.map((item) => text(item)).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback];
}

function normalizeVehicle(value) {
  const normalized = text(value).toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
  if (!normalized) return "";
  if (/\b(mp ?v|mpv\s*8|8\s*seater|8\s*seat|minibus|people\s*carrier)\b/.test(normalized)) return "MPV";
  if (/\b6\s*(seater|seat)\b/.test(normalized)) return "6 Seater";
  if (/\b(saloon|sedan|estate)\b/.test(normalized)) return "Saloon";
  return text(value);
}

function normalizeCriteria(value = {}) {
  const defaults = DEFAULT_JOB_LINKER_CRITERIA;
  const mode = text(value.areaMatchMode || defaults.areaMatchMode).toLowerCase();
  return {
    minFare: Math.max(0, finiteNumber(value.minFare, defaults.minFare)),
    allowedVehicles: list(value.allowedVehicles, defaults.allowedVehicles).map(normalizeVehicle),
    allowedAreaCodes: list(value.allowedAreaCodes, defaults.allowedAreaCodes).map((code) => code.toUpperCase()),
    areaMatchMode: ["either", "pickup", "dropoff", "both"].includes(mode) ? mode : "either",
    maxLinkGapHours: Math.min(168, Math.max(1, finiteNumber(value.maxLinkGapHours, defaults.maxLinkGapHours))),
    minimumTurnaroundMinutes: Math.min(240, Math.max(0, finiteNumber(value.minimumTurnaroundMinutes, defaults.minimumTurnaroundMinutes))),
    expireAfterPickupHours: Math.min(72, Math.max(1, finiteNumber(value.expireAfterPickupHours, defaults.expireAfterPickupHours))),
    trashRetentionHours: Math.min(168, Math.max(1, finiteNumber(value.trashRetentionHours, defaults.trashRetentionHours)))
  };
}

function evaluateJob(job = {}, rawCriteria = {}) {
  const criteria = normalizeCriteria(rawCriteria);
  const failedRules = [];
  const fare = finiteNumber(job.fare ?? job.Fare, null);
  const vehicle = normalizeVehicle(job.requiredVehicle || job.required_vehicle || job["Required Vehicle"]);
  const pickup = text(job.pickup || job.Pickup);
  const dropOff = text(job.dropOff || job.drop_off || job["Drop Off"]);
  const pickupAt = job.pickupAt || job.pickup_at;

  if (!pickup) failedRules.push("pickup_missing");
  if (!dropOff) failedRules.push("drop_off_missing");
  if (!pickupAt || Number.isNaN(new Date(pickupAt).getTime())) failedRules.push("pickup_time_invalid");
  if (fare === null) failedRules.push("fare_missing");
  else if (fare < criteria.minFare) failedRules.push("fare_below_minimum");
  if (!vehicle) failedRules.push("vehicle_missing");
  else if (!criteria.allowedVehicles.some((allowed) => normalizeVehicle(allowed) === vehicle)) {
    failedRules.push("vehicle_not_allowed");
  }

  const area = evaluateRideAreaCriteria(
    { Pickup: pickup, "Drop Off": dropOff },
    { allowedAreaCodes: criteria.allowedAreaCodes, matchMode: criteria.areaMatchMode }
  );
  if (!area.eligible) failedRules.push("area_not_allowed");

  return {
    eligible: failedRules.length === 0,
    failedRules,
    reason: failedRules.length === 0 ? "Matches fare, vehicle, area and required fields" : failedRules.join(", "),
    vehicle,
    fare,
    area
  };
}

function evaluatePrebookJob(job = {}) {
  const failedRules = [];
  const vehicle = normalizeVehicle(job.requiredVehicle || job.required_vehicle);
  if (!text(job.pickup)) failedRules.push("pickup_missing");
  if (!text(job.dropOff || job.drop_off)) failedRules.push("drop_off_missing");
  if (!job.pickupAt || Number.isNaN(new Date(job.pickupAt).getTime())) failedRules.push("pickup_time_invalid");
  if (!vehicle) failedRules.push("vehicle_missing");
  return {
    eligible: failedRules.length === 0,
    failedRules,
    reason: failedRules.length === 0 ? "Booked job is ready for matching" : failedRules.join(", "),
    vehicle
  };
}

module.exports = {
  UK_AREA_PREFIXES,
  DEFAULT_JOB_LINKER_CRITERIA,
  normalizeVehicle,
  normalizeCriteria,
  evaluateJob,
  evaluatePrebookJob
};
