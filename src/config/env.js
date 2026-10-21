const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const RAILWAY_DATA_ROOT = "/data";

try {
  // dotenv is optional in environments that already inject variables.
  // Always resolve from project root so startup location does not change config source.
  // eslint-disable-next-line global-require
  require("dotenv").config({ path: path.resolve(PROJECT_ROOT, ".env") });
} catch (error) {
  // Ignore missing dotenv package so imports do not crash before install.
}

function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function isProductionNodeEnv() {
  return safeString(process.env.NODE_ENV, "development").toLowerCase() === "production";
}

function parseArray(value) {
  if (!value) return [];

  return String(value)
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeStringArray(values) {
  const seen = new Set();
  const output = [];

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = safeString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function parseNumber(value, fallback, options = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  let next = parsed;
  if (options.integer) next = Math.trunc(next);
  if (Number.isFinite(options.min) && next < options.min) return fallback;
  if (Number.isFinite(options.max) && next > options.max) return fallback;
  return next;
}

function parseBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizePrivateKey(value) {
  const input = safeString(value);
  if (!input) return "";

  const hasWrappingQuotes =
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"));
  const unwrapped = hasWrappingQuotes ? input.slice(1, -1) : input;

  return unwrapped.replace(/\\n/g, "\n");
}

function resolveSessionPath(value) {
  const fromEnv = safeString(value);
  if (!fromEnv) {
    if (isProductionNodeEnv()) {
      return path.resolve(RAILWAY_DATA_ROOT, ".wwebjs_auth");
    }
    return path.resolve(PROJECT_ROOT, "data/.wwebjs_auth");
  }

  return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(PROJECT_ROOT, fromEnv);
}

function resolveWhatsAppSessionPath() {
  return resolveSessionPath(process.env.WHATSAPP_SESSION_PATH || process.env.WHATSAPP_SESSION_DIR);
}

function resolveDataPath(value, fallbackRelativePath) {
  const fromEnv = safeString(value);
  if (!fromEnv) {
    return path.resolve(PROJECT_ROOT, fallbackRelativePath);
  }

  return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(PROJECT_ROOT, fromEnv);
}

function resolveGoogleCredentialsPath() {
  const fallbackPath = isProductionNodeEnv()
    ? path.resolve(RAILWAY_DATA_ROOT, "credentials.json")
    : path.resolve(PROJECT_ROOT, "credentials.json");

  return resolveDataPath(process.env.GOOGLE_APPLICATION_CREDENTIALS, fallbackPath);
}

function parseGoogleCredentialsJson(rawValue) {
  const raw = safeString(rawValue);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (firstError) {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch (secondError) {
      const error = new Error("GOOGLE_CREDENTIALS_JSON is not valid JSON or base64 JSON");
      error.code = "GOOGLE_CREDENTIALS_JSON_INVALID";
      throw error;
    }
  }
}

function resolveGoogleCredentialsState() {
  const rawCredentials = safeString(process.env.GOOGLE_CREDENTIALS_JSON);
  if (!rawCredentials) {
    return {
      json: null,
      error: "",
      source: "file_path"
    };
  }

  try {
    return {
      json: parseGoogleCredentialsJson(rawCredentials),
      error: "",
      source: "env_json"
    };
  } catch (error) {
    return {
      json: null,
      error: safeString(error?.message || "GOOGLE_CREDENTIALS_JSON could not be parsed"),
      source: "env_json"
    };
  }
}

function extractWorksheetNameFromRange(rangeValue) {
  const range = safeString(rangeValue);
  if (!range) return "";

  const separatorIndex = range.indexOf("!");
  const worksheetPart = separatorIndex >= 0 ? range.slice(0, separatorIndex) : range;
  return safeString(worksheetPart.replace(/^'(.+)'$/, "$1"));
}

function resolveGoogleSheetsRange() {
  const explicitRange = safeString(process.env.GOOGLE_SHEETS_RANGE);
  if (explicitRange) return explicitRange;

  const worksheetName = safeString(
    process.env.GOOGLE_SHEETS_WORKSHEET_NAME || process.env.GOOGLE_WORKSHEET_NAME,
    "Sheet1"
  );
  return worksheetName;
}

function resolveWorksheetRange(preferredRange, worksheetName, fallbackRange) {
  const explicitRange = safeString(preferredRange);
  if (explicitRange) return explicitRange;
  const explicitWorksheet = safeString(worksheetName);
  if (explicitWorksheet) return explicitWorksheet;
  return safeString(fallbackRange);
}

const resolvedGoogleSheetsRange = resolveGoogleSheetsRange();
const resolvedGoogleWorksheetName = safeString(
  process.env.GOOGLE_SHEETS_WORKSHEET_NAME || process.env.GOOGLE_WORKSHEET_NAME,
  extractWorksheetNameFromRange(resolvedGoogleSheetsRange) || "Sheet1"
);
const parsedAllowedGroups = parseArray(process.env.ALLOWED_GROUPS);
const parsedAllowedGroupIds = parseArray(process.env.ALLOWED_GROUP_IDS);
const parsedAllowedGroupNames = parseArray(process.env.ALLOWED_GROUP_NAMES);
const mergedAllowedGroups = dedupeStringArray([
  ...parsedAllowedGroups,
  ...parsedAllowedGroupIds,
  ...parsedAllowedGroupNames
]);
const googleCredentialsState = resolveGoogleCredentialsState();
const defaultDedupeStorePath = isProductionNodeEnv()
  ? path.resolve(RAILWAY_DATA_ROOT, "dedupe-store.json")
  : path.resolve(PROJECT_ROOT, "data/dedupe-store.json");

const env = Object.freeze({
  nodeEnv: safeString(process.env.NODE_ENV, "development"),
  logLevel: safeString(process.env.LOG_LEVEL, "info").toLowerCase(),
  logMode: safeString(process.env.LOG_MODE).toLowerCase() || undefined,
  openaiEnabled: parseBoolean(process.env.OPENAI_ENABLED, false),
  openaiExtractionEnabled: parseBoolean(process.env.OPENAI_EXTRACTION_ENABLED, false),
  bidAiReviewEnabled: parseBoolean(process.env.BID_AI_REVIEW_ENABLED, false),
  openaiApiKey: safeString(process.env.OPENAI_API_KEY),
  openaiModel: safeString(process.env.OPENAI_MODEL, "gpt-4.1-mini"),
  dashboardAuthToken: safeString(process.env.DASHBOARD_AUTH_TOKEN),
  dashboardDefaultActor: safeString(process.env.DASHBOARD_DEFAULT_ACTOR, "Dashboard"),
  // Separate dashboard deployments (for example Vercel) must be explicitly allowed.
  // Keep this empty by default so the API is not opened to arbitrary browser origins.
  dashboardAllowedOrigins: dedupeStringArray([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...parseArray(process.env.DASHBOARD_ALLOWED_ORIGINS)
  ]),
  supabaseUrl: safeString(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: safeString(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  supabaseServiceRoleKey: safeString(process.env.SUPABASE_SERVICE_ROLE_KEY),
  databaseUrl: safeString(
    process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || process.env.POSTGRES_URL
  ),
  databasePrimaryEnabled: parseBoolean(process.env.DATABASE_PRIMARY_ENABLED, false),
  databaseSheetsBackupEnabled: parseBoolean(process.env.DATABASE_SHEETS_BACKUP_ENABLED, true),
  databaseRetentionEnabled: parseBoolean(process.env.DATABASE_RETENTION_ENABLED, false),
  databaseRetentionPollMs: parseNumber(process.env.DATABASE_RETENTION_POLL_MS, 60 * 60 * 1000, {
    integer: true,
    min: 60 * 1000,
    max: 7 * 24 * 60 * 60 * 1000
  }),
  googleSheetsId: safeString(
    process.env.GOOGLE_SHEETS_ID || process.env.GOOGLE_SHEETS_SPREADSHEET_ID
  ),
  googleSheetsRange: resolvedGoogleSheetsRange,
  googleWorksheetName: resolvedGoogleWorksheetName,
  googleRidesWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_RIDES_WORKSHEET_NAME,
    resolvedGoogleWorksheetName || "Rides"
  ),
  googleNeedsReviewWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_NEEDS_REVIEW_WORKSHEET_NAME,
    "Needs Review"
  ),
  googleUpcomingJobsWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_UPCOMING_JOBS_WORKSHEET_NAME,
    "Upcoming Jobs >79"
  ),
  googleFinalBidWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_FINAL_BID_WORKSHEET_NAME,
    "Final Bid"
  ),
  googleDriversWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_DRIVERS_WORKSHEET_NAME,
    "Drivers"
  ),
  googleVehiclesWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_VEHICLES_WORKSHEET_NAME,
    "Vehicles"
  ),
  googleOperationsViewWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_OPERATIONS_VIEW_WORKSHEET_NAME,
    "Operations View"
  ),
  googleDriverScheduleWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_DRIVER_SCHEDULE_WORKSHEET_NAME,
    "Driver Schedule"
  ),
  googleVehicleScheduleWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_VEHICLE_SCHEDULE_WORKSHEET_NAME,
    "Vehicle Schedule"
  ),
  googleLinkedRidesWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_LINKED_RIDES_WORKSHEET_NAME,
    "Linked Rides"
  ),
  googleBidTrackerWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_BID_TRACKER_WORKSHEET_NAME,
    "Bid Tracker"
  ),
  googleDispatchCriteriaWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_DISPATCH_CRITERIA_WORKSHEET_NAME,
    "Dispatch Criteria"
  ),
  googleAuditLogWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_AUDIT_LOG_WORKSHEET_NAME,
    "Audit Log"
  ),
  googleArchiveWorksheetName: safeString(
    process.env.GOOGLE_SHEETS_ARCHIVE_WORKSHEET_NAME,
    "Ride Archive"
  ),
  googleRidesRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_RIDES_RANGE,
    process.env.GOOGLE_SHEETS_RIDES_WORKSHEET_NAME,
    resolvedGoogleSheetsRange || resolvedGoogleWorksheetName || "Rides"
  ),
  googleNeedsReviewRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_NEEDS_REVIEW_RANGE,
    process.env.GOOGLE_SHEETS_NEEDS_REVIEW_WORKSHEET_NAME,
    "Needs Review"
  ),
  googleUpcomingJobsRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_UPCOMING_JOBS_RANGE,
    process.env.GOOGLE_SHEETS_UPCOMING_JOBS_WORKSHEET_NAME,
    "Upcoming Jobs >79"
  ),
  googleFinalBidRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_FINAL_BID_RANGE,
    process.env.GOOGLE_SHEETS_FINAL_BID_WORKSHEET_NAME,
    "Final Bid"
  ),
  googleDriversRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_DRIVERS_RANGE,
    process.env.GOOGLE_SHEETS_DRIVERS_WORKSHEET_NAME,
    "Drivers"
  ),
  googleVehiclesRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_VEHICLES_RANGE,
    process.env.GOOGLE_SHEETS_VEHICLES_WORKSHEET_NAME,
    "Vehicles"
  ),
  googleOperationsViewRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_OPERATIONS_VIEW_RANGE,
    process.env.GOOGLE_SHEETS_OPERATIONS_VIEW_WORKSHEET_NAME,
    "Operations View"
  ),
  googleDriverScheduleRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_DRIVER_SCHEDULE_RANGE,
    process.env.GOOGLE_SHEETS_DRIVER_SCHEDULE_WORKSHEET_NAME,
    "Driver Schedule"
  ),
  googleVehicleScheduleRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_VEHICLE_SCHEDULE_RANGE,
    process.env.GOOGLE_SHEETS_VEHICLE_SCHEDULE_WORKSHEET_NAME,
    "Vehicle Schedule"
  ),
  googleLinkedRidesRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_LINKED_RIDES_RANGE,
    process.env.GOOGLE_SHEETS_LINKED_RIDES_WORKSHEET_NAME,
    "Linked Rides"
  ),
  googleBidTrackerRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_BID_TRACKER_RANGE,
    process.env.GOOGLE_SHEETS_BID_TRACKER_WORKSHEET_NAME,
    "Bid Tracker"
  ),
  googleDispatchCriteriaRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_DISPATCH_CRITERIA_RANGE,
    process.env.GOOGLE_SHEETS_DISPATCH_CRITERIA_WORKSHEET_NAME,
    "Dispatch Criteria"
  ),
  googleAuditLogRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_AUDIT_LOG_RANGE,
    process.env.GOOGLE_SHEETS_AUDIT_LOG_WORKSHEET_NAME,
    "Audit Log"
  ),
  googleArchiveRange: resolveWorksheetRange(
    process.env.GOOGLE_SHEETS_ARCHIVE_RANGE,
    process.env.GOOGLE_SHEETS_ARCHIVE_WORKSHEET_NAME,
    "Ride Archive"
  ),
  prebookGoogleSheetsId: safeString(process.env.PREBOOK_GOOGLE_SHEETS_ID),
  prebookWorksheetName: safeString(process.env.PREBOOK_WORKSHEET_NAME, "PreBook"),
  whatsappSourceGoogleSheetsId: safeString(process.env.WHATSAPP_SOURCE_GOOGLE_SHEETS_ID),
  whatsappSourceWorksheetNames: parseArray(
    process.env.WHATSAPP_SOURCE_WORKSHEET_NAMES || "Saloon,MPV"
  ),
  jobLinkerEnabled: parseBoolean(process.env.JOB_LINKER_ENABLED, true),
  jobLinkerSyncMs: parseNumber(process.env.JOB_LINKER_SYNC_MS, 60 * 1000, {
    integer: true,
    min: 60 * 1000,
    max: 60 * 60 * 1000
  }),
  jobLinkerOtsEnabled: parseBoolean(
    process.env.JOB_LINKER_OTS_ENABLED,
    parseBoolean(process.env.OTS_INTEGRATION_ENABLED, false)
  ),
  googleCredentialsPath: resolveGoogleCredentialsPath(),
  googleCredentialsJson: googleCredentialsState.json,
  googleCredentialsJsonError: googleCredentialsState.error,
  googleCredentialsSource: googleCredentialsState.source,
  whatsappClientId: safeString(process.env.WHATSAPP_CLIENT_ID),
  whatsappEnabled: parseBoolean(process.env.WHATSAPP_ENABLED, true),
  whatsappStartupTimeoutMs: parseNumber(process.env.WHATSAPP_STARTUP_TIMEOUT_MS, 90000, {
    integer: true,
    min: 15000,
    max: 300000
  }),
  whatsappAutoClearStaleSession: parseBoolean(process.env.WHATSAPP_AUTO_CLEAR_STALE_SESSION, false),
  whatsappSessionPath: resolveWhatsAppSessionPath(),
  // Backward-compatible alias used by existing modules.
  whatsappSessionDir: resolveWhatsAppSessionPath(),
  whatsappDirectDatabaseEnabled: parseBoolean(
    process.env.WHATSAPP_DIRECT_DATABASE_ENABLED,
    false
  ),
  whatsappDirectIngestUrl: safeString(process.env.WHATSAPP_DIRECT_INGEST_URL),
  whatsappDirectIngestToken: safeString(
    process.env.WHATSAPP_DIRECT_INGEST_TOKEN || process.env.DASHBOARD_AUTH_TOKEN
  ),
  whatsappDirectQueuePath: resolveDataPath(
    process.env.WHATSAPP_DIRECT_QUEUE_PATH,
    "data/whatsapp-direct-queue.json"
  ),
  whatsappDirectRetryMs: parseNumber(process.env.WHATSAPP_DIRECT_RETRY_MS, 60 * 1000, {
    integer: true,
    min: 5000,
    max: 60 * 60 * 1000
  }),
  whatsappBackfillEnabled: parseBoolean(process.env.WHATSAPP_BACKFILL_ENABLED, true),
  whatsappBackfillHours: parseNumber(process.env.WHATSAPP_BACKFILL_HOURS, 24, {
    integer: true,
    min: 1,
    max: 168
  }),
  whatsappBackfillPerGroup: parseNumber(process.env.WHATSAPP_BACKFILL_PER_GROUP, 100, {
    integer: true,
    min: 1,
    max: 500
  }),
  dedupeStorePath: resolveDataPath(process.env.DEDUPE_STORE_PATH, defaultDedupeStorePath),
  dedupeTtlMs: parseNumber(process.env.DEDUPE_TTL_MS, 6 * 60 * 60 * 1000, {
    integer: true,
    min: 60 * 1000,
    max: 7 * 24 * 60 * 60 * 1000
  }),
  dedupeMaxEntries: parseNumber(process.env.DEDUPE_MAX_ENTRIES, 20000, {
    integer: true,
    min: 1000,
    max: 500000
  }),
  allowedGroups: mergedAllowedGroups,
  allowedGroupIds: dedupeStringArray(parsedAllowedGroupIds),
  allowedGroupNames: dedupeStringArray(parsedAllowedGroupNames),
  ingestDebug: parseBoolean(process.env.INGEST_DEBUG || process.env.WHATSAPP_INGEST_DEBUG, false),
  allowFromMeMessages: parseBoolean(
    process.env.ALLOW_FROM_ME_MESSAGES || process.env.WHATSAPP_ALLOW_FROM_ME_TEST_MESSAGES,
    false
  ),
  defaultCurrency: safeString(process.env.DEFAULT_CURRENCY, "PKR").toUpperCase(),
  appTimeZone: safeString(process.env.APP_TIME_ZONE, "Europe/London"),
  fareBase: parseNumber(process.env.FARE_BASE, 250, { min: 0 }),
  farePerKm: parseNumber(process.env.FARE_PER_KM, 95, { min: 0 }),
  finalBidEnabled: parseBoolean(process.env.FINAL_BID_ENABLED, true),
  finalBidMinFare: parseNumber(process.env.FINAL_BID_MIN_FARE || process.env.BID_MIN_FARE, 80, {
    min: 0
  }),
  finalBidMinDistance: parseNumber(
    process.env.FINAL_BID_MIN_DISTANCE || process.env.BID_MIN_DISTANCE,
    0,
    { min: 0 }
  ),
  finalBidMaxDistance: parseNumber(
    process.env.FINAL_BID_MAX_DISTANCE || process.env.BID_MAX_DISTANCE,
    0,
    { min: 0 }
  ),
  finalBidMinScore: parseNumber(
    process.env.FINAL_BID_MIN_SCORE || process.env.BID_MIN_SCORE,
    60,
    { min: 0, max: 100 }
  ),
  finalBidAllowedVehicles: parseArray(
    process.env.FINAL_BID_ALLOWED_VEHICLES || process.env.BID_ALLOWED_VEHICLES
  ),
  finalBidExcludedVehicles: parseArray(
    process.env.FINAL_BID_EXCLUDED_VEHICLES || process.env.BID_EXCLUDED_VEHICLES
  ),
  finalBidAllowedGroups: parseArray(
    process.env.FINAL_BID_ALLOWED_GROUPS || process.env.BID_ALLOWED_GROUPS
  ),
  finalBidAllowedAreaCodes: parseArray(
    process.env.FINAL_BID_ALLOWED_AREA_CODES || process.env.ALLOWED_AREA_CODES
  ),
  finalBidAreaMatchMode: safeString(
    process.env.FINAL_BID_AREA_MATCH_MODE || process.env.AREA_CODE_MATCH_MODE,
    "either"
  ).toLowerCase(),
  finalBidRequireFare: parseBoolean(process.env.FINAL_BID_REQUIRE_FARE, true),
  finalBidRequireDistance: parseBoolean(process.env.FINAL_BID_REQUIRE_DISTANCE, false),
  calendarEnabled: parseBoolean(process.env.CALENDAR_ENABLED, true),
  googleCalendarId: safeString(process.env.GOOGLE_CALENDAR_ID, "primary"),
  calendarApprovalPollMs: parseNumber(process.env.CALENDAR_APPROVAL_POLL_MS, 60000, {
    integer: true,
    min: 10000,
    max: 30 * 60 * 1000
  }),
  recommendationPollMs: parseNumber(process.env.RECOMMENDATION_POLL_MS, 120000, {
    integer: true,
    min: 30000,
    max: 30 * 60 * 1000
  }),
  calendarEventDurationMinutes: parseNumber(process.env.CALENDAR_EVENT_DURATION_MINUTES, 60, {
    integer: true,
    min: 5,
    max: 24 * 60
  }),
  calendarCompanyCode: safeString(process.env.CALENDAR_COMPANY_CODE).toUpperCase(),
  operationsViewRefreshMs: parseNumber(process.env.OPERATIONS_VIEW_REFRESH_MS, 60000, {
    integer: true,
    min: 10000,
    max: 30 * 60 * 1000
  }),
  otsIntegrationEnabled: parseBoolean(process.env.OTS_INTEGRATION_ENABLED, false),
  otsProjectPath: resolveDataPath(
    process.env.OTS_PROJECT_PATH,
    path.resolve(PROJECT_ROOT, "../../ridemanagemnet/ride_Managment_Worker")
  ),
  otsFormattedRowsPath: resolveDataPath(
    process.env.OTS_FORMATTED_ROWS_PATH,
    path.resolve(PROJECT_ROOT, "../../ridemanagemnet/ride_Managment_Worker/output/formatted_rows_latest.json")
  ),
  otsRunPipeline: parseBoolean(process.env.OTS_RUN_PIPELINE, true),
  otsPollMs: parseNumber(process.env.OTS_POLL_MS, 60 * 1000, {
    integer: true,
    min: 60 * 1000,
    max: 24 * 60 * 60 * 1000
  }),
  otsGroupName: safeString(process.env.OTS_GROUP_NAME, "OTS"),
  otsSourceName: safeString(process.env.OTS_SOURCE_NAME, "OTS Supplier Portal"),
  autoBidEnabled: parseBoolean(process.env.AUTO_BID_ENABLED, false),
  autoBidMode: safeString(process.env.AUTO_BID_MODE, "safe").toLowerCase(),
  autoBidPollMs: parseNumber(process.env.AUTO_BID_POLL_MS, 60000, {
    integer: true,
    min: 10000,
    max: 24 * 60 * 60 * 1000
  }),
  otsBidSubmitScript: resolveDataPath(
    process.env.OTS_BID_SUBMIT_SCRIPT,
    path.resolve(PROJECT_ROOT, "../../ridemanagemnet/ride_Managment_Worker/scripts/submit_bid_v2.js")
  ),
  otsBidSubmitTimeoutMs: parseNumber(process.env.OTS_BID_SUBMIT_TIMEOUT_MS, 120000, {
    integer: true,
    min: 10000,
    max: 10 * 60 * 1000
  }),
  retentionCleanupEnabled: parseBoolean(process.env.RETENTION_CLEANUP_ENABLED, false),
  expiredRideCleanupEnabled: parseBoolean(process.env.EXPIRED_RIDE_CLEANUP_ENABLED, false),
  expiredRideCleanupPollMs: parseNumber(process.env.EXPIRED_RIDE_CLEANUP_POLL_MS, 5 * 60 * 1000, {
    integer: true,
    min: 60 * 1000,
    max: 24 * 60 * 60 * 1000
  }),
  retentionCleanupPollMs: parseNumber(process.env.RETENTION_CLEANUP_POLL_MS, 24 * 60 * 60 * 1000, {
    integer: true,
    min: 60 * 1000,
    max: 7 * 24 * 60 * 60 * 1000
  }),
  retentionCompletedDays: parseNumber(process.env.RETENTION_COMPLETED_DAYS, 10, {
    integer: true,
    min: 1,
    max: 3650
  }),
  retentionReviewDays: parseNumber(process.env.RETENTION_REVIEW_DAYS, 7, {
    integer: true,
    min: 1,
    max: 3650
  }),
  retentionAuditDays: parseNumber(process.env.RETENTION_AUDIT_DAYS, 30, {
    integer: true,
    min: 1,
    max: 3650
  }),
  geocodingProvider: safeString(process.env.GEOCODING_PROVIDER, "nominatim").toLowerCase(),
  geocodingBaseUrl: safeString(process.env.GEOCODING_BASE_URL),
  geocodingUserAgent: safeString(process.env.GEOCODING_USER_AGENT, "ride-bot/1.0 (geocode)"),
  geocodingTimeoutMs: parseNumber(process.env.GEOCODING_TIMEOUT_MS, 12000, {
    integer: true,
    min: 1000,
    max: 120000
  }),
  geocodingApiKey: safeString(process.env.GEOCODING_API_KEY),
  ocrTesseractPath: safeString(process.env.OCR_TESSERACT_PATH, "tesseract"),
  ocrTimeoutMs: parseNumber(process.env.OCR_TIMEOUT_MS, 20000, {
    integer: true,
    min: 1000,
    max: 120000
  }),
  ocrTempDir: resolveDataPath(process.env.OCR_TEMP_DIR, path.join(os.tmpdir(), "ride-bot-ocr")),
  puppeteerExecutablePath: safeString(process.env.PUPPETEER_EXECUTABLE_PATH),
  puppeteerNoSandbox: parseBoolean(process.env.PUPPETEER_NO_SANDBOX, true),
  port: parseNumber(process.env.PORT, 3000, { integer: true, min: 1, max: 65535 })
});

module.exports = {
  env,
  parseNumber,
  parseBoolean,
  parseArray,
  normalizePrivateKey,
  safeString,
  resolveSessionPath,
  resolveWhatsAppSessionPath,
  resolveDataPath,
  PROJECT_ROOT
};
