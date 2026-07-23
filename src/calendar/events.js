const { safeTrim } = require("../utils/text");

function buildRideCalendarSummary(approval = {}) {
  const refer = safeTrim(approval.refer || approval.Refer);
  const driverId = safeTrim(approval.assigned_driver || approval["Assigned Driver"]);
  const pickup = safeTrim(approval.pickup || approval.Pickup);
  const dropOff = safeTrim(approval.drop_off || approval["Drop Off"]);
  const parts = [
    refer || "Ride",
    driverId ? `Driver ${driverId}` : "",
    pickup && dropOff ? `${pickup} to ${dropOff}` : pickup || dropOff
  ].filter(Boolean);
  return parts.join(" | ");
}

function buildRideCalendarDescription(approval = {}) {
  return [
    `Driver ID: ${safeTrim(approval.assigned_driver || approval["Assigned Driver"])}`,
    `Pickup: ${safeTrim(approval.pickup || approval.Pickup)}`,
    `Drop Off: ${safeTrim(approval.drop_off || approval["Drop Off"])}`,
    `Date: ${safeTrim(approval.pickup_day_date || approval["Pickup Day & Date"])}`,
    `Time: ${safeTrim(approval.starting_timing || approval["Starting Timing"])}`,
    `Vehicle: ${safeTrim(approval.required_vehicle || approval["Required Vehicle"])}`,
    `Refer: ${safeTrim(approval.refer || approval.Refer)}`
  ].join("\n");
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
  const timeZone = safeTrim(options.timeZone, "Europe/London");

  return {
    summary: buildRideCalendarSummary(approval),
    description: buildRideCalendarDescription(approval),
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
  buildRideCalendarSummary,
  buildRideCalendarDescription,
  buildRideCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent
};
