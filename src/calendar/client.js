const { google } = require("googleapis");
const { env } = require("../config/env");
const { loadServiceAccountCredentials } = require("../sheets/sheetsClient");
const { createLogger, summarizeKnownError } = require("../utils/logger");
const { safeTrim } = require("../utils/text");

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

async function createCalendarClient(options = {}) {
  const logger =
    options.logger ||
    createLogger(env.logLevel || "info", {
      mode: env.logMode,
      baseMeta: { component: "calendar-client" }
    });

  const credentialsStatus = loadServiceAccountCredentials({
    credentialsJson: options.credentialsJson ?? env.googleCredentialsJson,
    credentialsPath: options.credentialsPath ?? env.googleCredentialsPath
  });

  if (!credentialsStatus.ok) {
    logger.error("Google Calendar credentials unavailable", {
      stage: "calendar_auth",
      fallbackUsed: true,
      reason:
        credentialsStatus.reason || credentialsStatus.message || "Missing service account credentials"
    });
    return null;
  }

  try {
    const auth = new google.auth.JWT({
      email: credentialsStatus.clientEmail,
      key: credentialsStatus.privateKey,
      scopes: [CALENDAR_SCOPE]
    });

    await auth.authorize();

    const calendar = google.calendar({
      version: "v3",
      auth
    });

    logger.debug("Google Calendar auth ready", {
      stage: "calendar_auth",
      fallbackUsed: false,
      reason: safeTrim(options.calendarId || env.googleCalendarId || "primary"),
      clientEmail: safeTrim(credentialsStatus.clientEmail)
    });

    return calendar;
  } catch (error) {
    const summary = summarizeKnownError(error, {
      stage: "calendar_auth",
      defaultSummary: "Google Calendar authentication failed",
      fallbackUsed: true
    });

    logger.error(summary.summary, {
      stage: "calendar_auth",
      fallbackUsed: true,
      reason: summary.likelyCause || "Service account credentials were rejected or the service account was not granted access",
      error,
      stack: error?.stack
    });
    return null;
  }
}

module.exports = {
  CALENDAR_SCOPE,
  createCalendarClient
};
