const { safeTrim, collapseWhitespace } = require("../utils/text");

const DIRECTION = Object.freeze({
  OUTBOUND: { label: "Outbound", emoji: "➡️" },
  RETURN: { label: "Return", emoji: "↩️" }
});

const VEHICLE_EMOJI_RULES = Object.freeze([
  { pattern: /\b9\s*-?\s*seat/i, emoji: "🚌" },
  { pattern: /\b8\s*-?\s*seat/i, emoji: "🚐" },
  { pattern: /\b6\s*-?\s*seat/i, emoji: "🚐" },
  { pattern: /\bmpv\b/i, emoji: "🚐" },
  { pattern: /\bestate\b/i, emoji: "🚙" },
  { pattern: /\bsaloon\b/i, emoji: "🚗" }
]);

const DEFAULT_VEHICLE_EMOJI = "🚗";
const PASSENGER_COUNT_PATTERN = /(\d{1,2})\s*(?:persons?|pax|passengers?)\b/i;

function normalizeComparableText(value) {
  return collapseWhitespace(String(value || "")).toLowerCase();
}

function resolveVehicleEmoji(vehicleText) {
  const text = normalizeComparableText(vehicleText);
  const rule = VEHICLE_EMOJI_RULES.find((entry) => entry.pattern.test(text));
  return rule ? rule.emoji : DEFAULT_VEHICLE_EMOJI;
}

function resolvePassengerCount(approval = {}) {
  const explicit = safeTrim(approval.passenger_count || approval["Passenger Count"]);
  if (/^\d+$/.test(explicit)) return explicit;

  const vehicleText = safeTrim(approval.required_vehicle || approval["Required Vehicle"]);
  const match = vehicleText.match(PASSENGER_COUNT_PATTERN);
  return match ? match[1] : "1";
}

function resolveDirection(approval = {}) {
  const haystack = normalizeComparableText(
    [
      approval.group_name || approval["Group Name"],
      approval.pickup || approval.Pickup,
      approval.drop_off || approval["Drop Off"]
    ].join(" ")
  );

  return /\breturn\b/.test(haystack) ? DIRECTION.RETURN : DIRECTION.OUTBOUND;
}

function formatEventCode(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const map = {};
  parts.forEach((part) => {
    map[part.type] = part.value;
  });
  const hour = map.hour === "24" ? "00" : map.hour;

  return `${map.day}${map.month}${map.year}-${hour}${map.minute}`;
}

function buildGoogleMapsLink(address) {
  const text = safeTrim(address);
  if (!text) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`;
}

function buildRideCalendarSummary(approval = {}, options = {}) {
  const vehicleEmoji = resolveVehicleEmoji(approval.required_vehicle || approval["Required Vehicle"]);
  const companyCode = safeTrim(options.companyCode);
  const eventCode = formatEventCode(approval.startDateTime, options.timeZone || "Europe/London");
  const pax = resolvePassengerCount(approval);
  const direction = resolveDirection(approval);

  const prefix = [vehicleEmoji, companyCode, eventCode].filter(Boolean).join(" ");
  return `${prefix} - ${pax} Pax ${direction.emoji}`;
}

function buildRideCalendarDescription(approval = {}) {
  const pickup = safeTrim(approval.pickup || approval.Pickup);
  const dropOff = safeTrim(approval.drop_off || approval["Drop Off"]);
  const driverName =
    safeTrim(approval.driver_name || approval["Driver Name"]) ||
    safeTrim(approval.assigned_driver || approval["Assigned Driver"]);

  const lines = [
    `Ride ID: ${safeTrim(approval.refer || approval.Refer)}`,
    `Driver: ${driverName}`,
    `Vehicle: ${safeTrim(approval.required_vehicle || approval["Required Vehicle"])}`,
    `Pickup: ${pickup}`,
    `Dropoff: ${dropOff}`,
    `Fare: ${safeTrim(approval.fare || approval.Fare)}`,
    `Distance: ${safeTrim(approval.distance || approval.Distance)}`,
    `Payment: ${safeTrim(approval.payment_status || approval["Payment Status"]) || "Not specified"}`,
    `Source Group: ${safeTrim(approval.group_name || approval["Group Name"])}`,
    `Pickup Map: ${buildGoogleMapsLink(pickup)}`,
    `Dropoff Map: ${buildGoogleMapsLink(dropOff)}`
  ];

  return lines.join("\n");
}

function buildRideCalendarEvent(approval = {}, options = {}) {
  const startDateTime = approval.startDateTime instanceof Date ? approval.startDateTime : null;
  if (!startDateTime || Number.isNaN(startDateTime.getTime())) {
    throw new Error("Calendar event startDateTime is required");
  }

  const durationMinutes = Number.isFinite(options.durationMinutes)
    ? Math.max(5, Math.trunc(options.durationMinutes))
    : 60;
  const endDateTime = new Date(startDateTime.getTime() + durationMinutes * 60 * 1000);
  const timeZone = safeTrim(options.timeZone) || "Europe/London";

  return {
    summary: buildRideCalendarSummary(approval, { timeZone, companyCode: options.companyCode }),
    description: buildRideCalendarDescription(approval),
    location: safeTrim(approval.pickup || approval.Pickup),
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone
    },
    extendedProperties: {
      private: {
        refer: safeTrim(approval.refer || approval.Refer),
        driverId: safeTrim(approval.assigned_driver || approval["Assigned Driver"])
      }
    }
  };
}

async function createCalendarEvent({ calendarClient, calendarId, event }) {
  if (!calendarClient) throw new Error("Google Calendar client is not configured");
  if (!safeTrim(calendarId)) throw new Error("Google Calendar ID is missing");

  const response = await calendarClient.events.insert({
    calendarId,
    requestBody: event
  });

  return {
    eventId: safeTrim(response?.data?.id),
    htmlLink: safeTrim(response?.data?.htmlLink),
    raw: response?.data || {}
  };
}

async function updateCalendarEvent({ calendarClient, calendarId, eventId, event }) {
  if (!calendarClient) throw new Error("Google Calendar client is not configured");
  if (!safeTrim(calendarId)) throw new Error("Google Calendar ID is missing");
  if (!safeTrim(eventId)) throw new Error("Google Calendar event ID is missing");

  const response = await calendarClient.events.patch({
    calendarId,
    eventId,
    requestBody: event
  });

  return {
    eventId: safeTrim(response?.data?.id),
    htmlLink: safeTrim(response?.data?.htmlLink),
    raw: response?.data || {}
  };
}

async function deleteCalendarEvent({ calendarClient, calendarId, eventId }) {
  if (!calendarClient) throw new Error("Google Calendar client is not configured");
  if (!safeTrim(calendarId)) throw new Error("Google Calendar ID is missing");
  if (!safeTrim(eventId)) throw new Error("Google Calendar event ID is missing");

  await calendarClient.events.delete({
    calendarId,
    eventId
  });

  return {
    eventId: safeTrim(eventId),
    deleted: true
  };
}

module.exports = {
  resolveVehicleEmoji,
  resolvePassengerCount,
  resolveDirection,
  formatEventCode,
  buildGoogleMapsLink,
  buildRideCalendarSummary,
  buildRideCalendarDescription,
  buildRideCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent
};
