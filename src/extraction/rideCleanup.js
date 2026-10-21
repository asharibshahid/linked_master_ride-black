const { safeTrim } = require("../utils/text");
const { normalizeVehicleText } = require("./localExtractor");

const POSTCODE_PATTERN = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*([0O]\s*[A-Z]{2}|[1-9]\s*[A-Z]{2})\b/i;
const OUTCODE_PATTERN = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const AIRPORTS = [
  { code: "LHR", pattern: /\b(?:LHR|Heathrow)\b/i },
  { code: "LGW", pattern: /\b(?:LGW|Gatwick)\b/i },
  { code: "STN", pattern: /\b(?:STN|Stansted)\b/i },
  { code: "LTN", pattern: /\b(?:LTN|Luton Airport)\b/i },
  { code: "LCY", pattern: /\b(?:LCY|London City Airport)\b/i },
  { code: "SEN", pattern: /\b(?:SEN|Southend)\b/i }
];
const SEAT_PATTERN = /\b(\d+\s*(?:&|x)?\s*)?(booster|child|baby|infant)\s*seats?\b/gi;
const VEHICLE_ONLY_PATTERN = /^(?:any\s+)?(?:[6-9]\s*seater|saloon(?:\s+car)?|estate(?:\s+car)?|executive(?:\s+car)?|mpv|minibus)$/i;

function stripLabels(value) {
  return safeTrim(String(value || "")
    .replace(/^(?:from|to|pickup|pick\s*up|drop\s*off|dropoff|origin|destination|address)\s*:\s*/i, "")
    .replace(/^(?:address|destination)\s*(?=\d|[A-Z])/i, "")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, ""));
}

function summarizeLocation(value) {
  const cleaned = stripLabels(value).replace(SEAT_PATTERN, "").replace(/[\s,;:-]+$/g, "");
  if (!cleaned) return { value: "", resolved: false };

  const airport = AIRPORTS.find((item) => item.pattern.test(cleaned));
  if (airport && (cleaned.match(/\bairport\b/i) || new RegExp(`\\b${airport.code}\\b`, "i").test(cleaned))) {
    const terminal = cleaned.match(/\b(?:terminal|term|t)\s*([1-5])\b/i);
    return { value: terminal ? `${airport.code} T${terminal[1]}` : airport.code, resolved: true };
  }

  const postcode = cleaned.match(POSTCODE_PATTERN);
  if (postcode) {
    const inward = postcode[2].replace(/\s+/g, "").replace(/^O/i, "0").toUpperCase();
    return { value: `${postcode[1].toUpperCase()} ${inward}`, resolved: true };
  }

  if (airport) {
    const terminal = cleaned.match(/\b(?:terminal|term|t)\s*([1-5])\b/i);
    return { value: terminal ? `${airport.code} T${terminal[1]}` : airport.code, resolved: true };
  }

  if (OUTCODE_PATTERN.test(cleaned)) return { value: cleaned.toUpperCase(), resolved: true };
  return { value: cleaned, resolved: false };
}

function extractSeatInstructions(value) {
  const matches = [...String(value || "").matchAll(SEAT_PATTERN)];
  return [...new Set(matches.map((match) => {
    const count = safeTrim(match[1] || "").replace(/\s*[&x]\s*$/i, "");
    const seat = `${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()} Seat`;
    return `${count ? `${count} ` : ""}${seat}${count && Number(count) > 1 ? "s" : ""}`;
  }))].join("; ");
}

function extractLabeledInstructions(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:special\s+instructions?|instructions?|notes?)\s*:\s*(.+)$/i)?.[1] || "")
    .map((line) => safeTrim(line.replace(SEAT_PATTERN, "").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")))
    .filter(Boolean)
    .map((line) => line.slice(0, 250))
    .join("; ");
}

function cleanupRide(ride, rawMessage) {
  const next = { ...ride };
  const issues = [];
  const instructions = [
    extractSeatInstructions(rawMessage),
    extractLabeledInstructions(rawMessage),
    extractSeatInstructions(next.pickup),
    extractSeatInstructions(next.drop_off)
  ].filter(Boolean);
  next.special_instructions = [...new Set(instructions)].join("; ");

  if (VEHICLE_ONLY_PATTERN.test(safeTrim(next.drop_off))) {
    next.required_vehicle = next.required_vehicle || normalizeVehicleText(next.drop_off);
  }

  const combined = String(next.pickup || "").match(/^(.+?)\s*-{3,}\s*(.+)$/);
  if (combined && (!next.drop_off || extractSeatInstructions(next.drop_off) || VEHICLE_ONLY_PATTERN.test(safeTrim(next.drop_off)))) {
    next.pickup = combined[1];
    next.drop_off = combined[2];
  }

  for (const field of ["pickup", "drop_off"]) {
    const raw = safeTrim(next[field]);
    if (VEHICLE_ONLY_PATTERN.test(raw)) {
      next.required_vehicle = next.required_vehicle || normalizeVehicleText(raw);
      next[field] = "";
    } else if (extractSeatInstructions(raw) && !POSTCODE_PATTERN.test(raw) && !AIRPORTS.some((a) => a.pattern.test(raw))) {
      next[field] = "";
    }
    const location = summarizeLocation(next[field]);
    next[field] = location.value;
    if (raw && !location.value) issues.push(`${field}_instruction_only`);
  }

  return { ride: next, issues };
}

module.exports = { summarizeLocation, extractSeatInstructions, cleanupRide };
