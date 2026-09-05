const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { env } = require("./config/env");
const { createLogger, summarizeKnownError } = require("./utils/logger");
const { executeWithRetry } = require("./utils/retry");
const { DedupeStore } = require("./utils/dedupe");
const { createLocalExtractor } = require("./extraction/localExtractor");
const { createOpenAiNormalizer } = require("./extraction/openaiNormalizer");
const { createTesseractOcr } = require("./extraction/tesseractOcr");
const { normalizeHeaderName, STRICT_SHEET_HEADERS } = require("./extraction/schemas");
const { createGeocoder } = require("./routing/geocode");
const { createOsrmClient } = require("./routing/osrm");
const { createSheetsClient, validateSheetsConfig } = require("./sheets/sheetsClient");
const { createAppendRow, buildHeaderRange } = require("./sheets/appendRow");
const { createUpcomingJobAppender } = require("./sheets/upcomingJobs");
const {
  FINAL_BID_HEADERS,
  buildFinalBidSheetRow,
  createFinalBidAppender
} = require("./bids/finalBid");
const {
  BID_TRACKER_HEADERS,
  buildBidTrackerRowObject,
  buildBidTrackerSheetRow
} = require("./bids/tracker");
const { createAutoBidRunner, startAutoBidPolling } = require("./bids/autoBid");
const { createOtsWorkerSubmitter } = require("./bids/otsSubmitter");
const { calculateBidPricing } = require("./bids/pricingEngine");
const { createBidAiReviewer } = require("./bids/aiReview");
const { createCalendarClient } = require("./calendar/client");
const { startFinalBidApprovalPolling } = require("./calendar/approvalWorkflow");
const { DRIVER_HEADERS, VEHICLE_HEADERS, loadAvailableDrivers } = require("./drivers/management");
const { startRecommendationPolling } = require("./polling");
const {
  DRIVER_SCHEDULE_HEADERS,
  LINKED_RIDES_HEADERS,
  RECOMMENDATION_HEADERS,
  RECOMMENDATION_WORKSHEET_NAME,
  VEHICLE_SCHEDULE_HEADERS
} = require("./engine");
const { loadDashboardData, renderDashboardPage } = require("./dashboard/data");
const {
  isDashboardAuthEnabled,
  verifyDashboardRequest
} = require("./dashboard/auth");
const {
  approveRecommendation,
  createDriverRecord,
  createVehicleRecord,
  BID_ADMIN_STATUS_VALUES,
  BID_STATUS_VALUES,
  DRIVER_STATUS_VALUES,
  promoteNeedsReviewToFinalBid,
  createBidReviewEntry,
  updateDispatchCriteria,
  updateBidAdminStatus,
  updateBidStatus,
  updateDriverStatus,
  updateVehicleStatus,
  updateFinalBidStatus,
  updateNeedsReviewRideFields,
  completeAssignedRideSchedules,
  VEHICLE_STATUS_VALUES,
  resetFinalBidCalendarRetry
} = require("./dashboard/actions");
const { OPERATIONS_VIEW_HEADERS, startOperationsViewPolling } = require("./operations/view");
const { createOtsImportRunner, startOtsIntegrationPolling } = require("./ots/integration");
const {
  DISPATCH_CRITERIA_HEADERS,
  buildEnvCriteriaDefaults,
  criteriaRowsFromDefaults,
  mapCriteriaRows,
  resolveCriteriaConfig
} = require("./settings/criteria");
const {
  AUDIT_LOG_HEADERS,
  buildAuditEntriesFromActionResult,
  buildAuditLogSheetRow
} = require("./audit/log");
const {
  ARCHIVE_HEADERS,
  buildDefaultRetentionTargets,
  startRetentionCleanupPolling
} = require("./retention/cleanup");
const { createMessageHandler } = require("./whatsapp/messageHandler");
const { initializeWhatsAppClient } = require("./whatsapp/client");
const { validateAndPrepareSessionStorage, resolveLocalAuthPaths } = require("./whatsapp/session");
const { loadLiveWhatsAppGroups, persistAllowedGroups } = require("./whatsapp/groups");
const { checkDatabaseConnection } = require("./database/client");
const { startDatabaseRetentionPolling } = require("./database/retention");
const { DispatchDatabaseRepository } = require("./database/repository");
const { JobLinkerRepository } = require("./jobLinker/repository");
const { createJobLinkerService } = require("./jobLinker/service");
const { createJobLinkerBidService } = require("./jobLinker/bids");
const { registerJobLinkerRoutes } = require("./jobLinker/routes");

const RAILWAY_PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--single-process"
];
let sheetsStartupQuotaCooldownUntil = 0;

function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeDashboardAllowedValue(value, allowedValues, fieldName) {
  const normalized = safeString(value).toLowerCase();
  const match = allowedValues.find((item) => safeString(item).toLowerCase() === normalized);
  if (!match) {
    throw new Error(`${fieldName} must be one of: ${allowedValues.join(", ")}`);
  }
  return match;
}

function normalizeWorksheetTitle(value) {
  return safeString(value).toLowerCase();
}

function quoteWorksheetNameForRange(worksheetName) {
  const name = safeString(worksheetName);
  return `'${name.replace(/'/g, "''")}'`;
}

function getGoogleApiStatus(error) {
  const status = Number(error?.response?.status || error?.code);
  return Number.isFinite(status) ? status : null;
}

function getGoogleApiReason(error) {
  return safeString(
    error?.response?.data?.error?.message ||
      error?.message ||
      "Google API request failed"
  );
}

function isRetryableGoogleApiError(error) {
  const status = getGoogleApiStatus(error);
  const code = safeString(error?.code);
  return (
    [408, 409, 425, 429, 500, 502, 503, 504].includes(status) ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED"].includes(code)
  );
}

function isGoogleSheetsQuotaError(error) {
  return getGoogleApiStatus(error) === 429;
}

async function runStartupSheetsRequest(requestFn, { logger, action, worksheetName }) {
  if (Date.now() < sheetsStartupQuotaCooldownUntil) {
    const error = new Error("Google Sheets startup quota cooldown is active");
    error.code = 429;
    error.response = {
      status: 429,
      data: {
        error: {
          message: "Google Sheets startup quota cooldown is active"
        }
      }
    };
    throw error;
  }

  return executeWithRetry(requestFn, {
    maxAttempts: 4,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    shouldRetry: isRetryableGoogleApiError,
    onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
      logger.warn("Google Sheets startup request retrying", {
        stage: "sheets_startup",
        fallbackUsed: true,
        attempt,
        maxAttempts,
        delayMs,
        reason: `${action}${worksheetName ? ` ${worksheetName}` : ""}: ${getGoogleApiReason(error)}`
      });
    }
  });
}

function activateSheetsStartupQuotaCooldown() {
  sheetsStartupQuotaCooldownUntil = Date.now() + 60 * 1000;
}

function resolveQrImagePath() {
  const preferredDir = "/data";

  try {
    if (fs.existsSync(preferredDir) && fs.statSync(preferredDir).isDirectory()) {
      return path.join(preferredDir, "qr.png");
    }
  } catch (error) {
    // Fall back to project-local writable storage when /data is unavailable.
  }

  return path.resolve(__dirname, "../data/qr.png");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function describeBotState(state) {
  switch (state) {
    case "qr_required":
      return "Scan this QR with WhatsApp Linked Devices.";
    case "authenticated":
      return "Authentication complete. Waiting for ready state.";
    case "ready":
      return "Bot is ready, QR not required.";
    case "auth_failed":
      return "Authentication failed. Check logs and wait for a fresh QR.";
    case "starting":
    default:
      return "Bot is starting.";
  }
}

function createBotRuntimeStatus() {
  const snapshot = {
    state: "starting",
    qrImagePath: resolveQrImagePath(),
    qrAvailable: false,
    qrUpdatedAt: "",
    lastError: "",
    startedAt: new Date().toISOString()
  };

  return {
    update(state, details = {}) {
      const nextState = safeString(state);
      if (nextState) snapshot.state = nextState;

      if (typeof details.qrAvailable === "boolean") {
        snapshot.qrAvailable = details.qrAvailable;
      }

      if (safeString(details.qrUpdatedAt)) {
        snapshot.qrUpdatedAt = safeString(details.qrUpdatedAt);
      }

      if (safeString(details.qrImagePath)) {
        snapshot.qrImagePath = safeString(details.qrImagePath);
      }

      if (Object.prototype.hasOwnProperty.call(details, "error")) {
        snapshot.lastError = safeString(details.error);
      } else if (nextState !== "auth_failed") {
        snapshot.lastError = "";
      }
    },
    getSnapshot() {
      const qrAvailable = Boolean(
        snapshot.qrAvailable &&
          safeString(snapshot.qrImagePath) &&
          fs.existsSync(snapshot.qrImagePath)
      );

      return {
        ok: true,
        state: snapshot.state,
        qrAvailable,
        qrImagePath: snapshot.qrImagePath,
        qrUpdatedAt: snapshot.qrUpdatedAt,
        lastError: snapshot.lastError,
        startedAt: snapshot.startedAt
      };
    }
  };
}

function renderQrPage(status) {
  const title = "Ride Bot QR";
  const stateLabel = escapeHtml(status.state);
  const statusMessage = escapeHtml(describeBotState(status.state));
  const lastUpdated = escapeHtml(status.qrUpdatedAt || "not generated yet");
  const imageBlock = status.qrAvailable
    ? `<img src="/qr.png?ts=${encodeURIComponent(status.qrUpdatedAt || Date.now())}" alt="WhatsApp QR" style="max-width:320px;width:100%;height:auto;border:1px solid #d0d7de;border-radius:12px;background:#fff;padding:12px;" />`
    : `<p style="margin:0;color:#57606a;">No QR image is currently available.</p>`;
  const extraMessage =
    status.state === "ready"
      ? `<p style="margin:0;color:#1a7f37;">Bot is ready, QR not required.</p>`
      : status.lastError
        ? `<p style="margin:0;color:#d1242f;">${escapeHtml(status.lastError)}</p>`
        : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="font-family:Segoe UI,Arial,sans-serif;background:#f6f8fa;color:#24292f;margin:0;padding:24px;">
    <main style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(31,35,40,.08);">
      <h1 style="margin-top:0;">${title}</h1>
      <p style="margin:0 0 8px;"><strong>State:</strong> ${stateLabel}</p>
      <p style="margin:0 0 16px;">${statusMessage}</p>
      ${extraMessage}
      <div style="display:flex;justify-content:center;align-items:center;min-height:180px;margin:16px 0;">
        ${imageBlock}
      </div>
      <p style="margin:0;color:#57606a;"><strong>QR updated:</strong> ${lastUpdated}</p>
      <p style="margin:12px 0 0;color:#57606a;">Refresh this page if the state changes.</p>
    </main>
  </body>
</html>`;
}

function startHttpServer({ logger, runtimeStatus, port, getDashboardContext }) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));

  function allowDashboardOrigin(request, response) {
    const origin = safeString(request.get("origin"));
    if (!origin || !env.dashboardAllowedOrigins.includes(origin)) return false;

    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dashboard-Token, X-Dashboard-Actor");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Max-Age", "600");
    return true;
  }

  app.use((request, response, next) => {
    allowDashboardOrigin(request, response);
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });

  function requireDashboardQrAccess(request, response) {
    const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
    const auth = verifyDashboardRequest(request, {
      token: context?.dashboardAuthToken || env.dashboardAuthToken,
      defaultActor: context?.dashboardDefaultActor || env.dashboardDefaultActor,
      requireToken: env.nodeEnv === "production"
    });
    if (auth.ok) return true;

    response.status(401).json({
      ok: false,
      authRequired: true,
      message: "Dashboard token required"
    });
    return false;
  }

  app.get("/health", (_request, response) => {
    const status = runtimeStatus.getSnapshot();
    response.json({
      ok: true,
      state: status.state
    });
  });

  app.get("/qr.png", (request, response) => {
    if (!requireDashboardQrAccess(request, response)) return;
    const status = runtimeStatus.getSnapshot();

    if (!status.qrAvailable) {
      response.status(404).json({
        ok: false,
        state: status.state,
        message: "QR image not available"
      });
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    response.sendFile(status.qrImagePath);
  });

  app.get("/qr", (request, response) => {
    if (!requireDashboardQrAccess(request, response)) return;
    const status = runtimeStatus.getSnapshot();
    response.setHeader("Cache-Control", "no-store");
    response.type("html").send(renderQrPage(status));
  });

  app.get("/dashboard", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.type("html").send(renderDashboardPage());
  });

  function sendDashboardUnauthorized(response) {
    response.status(401).json({
      ok: false,
      authRequired: true,
      message: "Dashboard token required"
    });
  }

  function resolveDashboardAuth(request) {
    const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
    return verifyDashboardRequest(request, {
      token: context?.dashboardAuthToken || env.dashboardAuthToken,
      defaultActor: context?.dashboardDefaultActor || env.dashboardDefaultActor,
      requireToken: env.nodeEnv === "production"
    });
  }

  registerJobLinkerRoutes(app, {
    logger: logger.child({ component: "job-linker-api" }),
    getService: () => {
      const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
      return context.jobLinkerService;
    },
    getBidService: () => {
      const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
      return context.jobLinkerBidService;
    },
    repository: {
      getCriteria: (...args) => {
        const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
        if (!context.jobLinkerRepository) throw new Error("Job linker repository is not ready");
        return context.jobLinkerRepository.getCriteria(...args);
      },
      trashJobs: (...args) => {
        const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
        if (!context.jobLinkerRepository) throw new Error("Job linker repository is not ready");
        return context.jobLinkerRepository.trashJobs(...args);
      },
      restoreJobs: (...args) => {
        const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
        if (!context.jobLinkerRepository) throw new Error("Job linker repository is not ready");
        return context.jobLinkerRepository.restoreJobs(...args);
      }
    },
    authorize: (request, response) => {
      const auth = resolveDashboardAuth(request);
      if (auth.ok) {
        request.dashboardActor = auth.actor || env.dashboardDefaultActor || "Dashboard";
        return true;
      }
      sendDashboardUnauthorized(response);
      return false;
    },
    auditBid: async (request, result) => {
      const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
      await appendAuditEntries({ ...context, actor: request.dashboardActor }, {
        action: result.ok ? "Job Linker Bid Submitted" : "Job Linker Bid Failed",
        targetType: "Bid",
        targetId: result.bid?.rideId || request.body?.rideId || "Unknown",
        result: {
          header: "Bid Status",
          key: result.bid?.rideId || request.body?.rideId || "Unknown",
          oldValue: "",
          value: result.bid?.bidStatus || result.code || "Failed"
        },
        reason: result.message || "",
        actor: request.dashboardActor
      });
    }
  });

  app.get("/api/dashboard", async (request, response) => {
    try {
      const auth = resolveDashboardAuth(request);
      if (!auth.ok) {
        sendDashboardUnauthorized(response);
        return;
      }

      const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
      const requestedLimit = Number.parseInt(request.query?.limit, 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(500, requestedLimit))
        : undefined;
      const payload = await loadDashboardData({ ...context, ...(limit ? { limit } : {}) });
      response.setHeader("Cache-Control", "no-store");
      response.json(payload);
    } catch (error) {
      const summary = summarizeKnownError(error, {
        stage: "dashboard",
        defaultSummary: "Dashboard data load failed",
        fallbackUsed: true
      });
      logger.warn(summary.summary, {
        stage: "dashboard",
        fallbackUsed: true,
        reason: summary.likelyCause || error?.message || "dashboard_load_failed",
        error
      });
      response.status(500).json({
        ok: false,
        message: summary.likelyCause || error?.message || "Dashboard data load failed"
      });
    }
  });

  function resolveActionContext(request, response) {
    const auth = resolveDashboardAuth(request);
    if (!auth.ok) {
      sendDashboardUnauthorized(response);
      return null;
    }

    const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
    if (!context?.sheetsClient || !context?.spreadsheetId) {
      response.status(503).json({
        ok: false,
        message: "Dashboard actions are not ready yet"
      });
      return null;
    }
    return {
      ...context,
      actor: auth.actor || context.dashboardDefaultActor || env.dashboardDefaultActor || "Dashboard"
    };
  }

  function resolveControlContext(request, response) {
    const auth = resolveDashboardAuth(request);
    if (!auth.ok) {
      sendDashboardUnauthorized(response);
      return null;
    }
    if (!isDashboardAuthEnabled({ token: env.dashboardAuthToken })) {
      response.status(403).json({ ok: false, message: "Dashboard authentication is required for WhatsApp controls" });
      return null;
    }
    return auth;
  }

  function sendActionError(response, error) {
    const summary = summarizeKnownError(error, {
      stage: "dashboard_action",
      defaultSummary: "Dashboard action failed",
      fallbackUsed: true
    });
    logger.warn(summary.summary, {
      stage: "dashboard_action",
      fallbackUsed: true,
      reason: summary.likelyCause || error?.message || "dashboard_action_failed",
      error
    });
    response.status(400).json({
      ok: false,
      message: summary.likelyCause || error?.message || "Dashboard action failed"
    });
  }

  async function appendAuditEntries(context, auditOptions = {}) {
    if (typeof context?.appendAuditLogRow !== "function") return;
    const entries = buildAuditEntriesFromActionResult(auditOptions);
    for (const entry of entries) {
      try {
        await context.appendAuditLogRow(entry);
      } catch (error) {
        logger.warn("Audit log append failed", {
          stage: "audit_log",
          fallbackUsed: true,
          reason: error?.message || "audit_append_failed",
          error
        });
      }
    }
  }

  app.get("/api/whatsapp/session", (request, response) => {
    const auth = resolveControlContext(request, response);
    if (!auth) return;
    const status = runtimeStatus.getSnapshot();
    response.json({
      ok: true,
      state: status.state,
      qrAvailable: Boolean(status.qrAvailable),
      qrUpdatedAt: status.qrUpdatedAt || null,
      lastError: status.lastError || "",
      qrUrl: status.qrAvailable ? `${request.protocol}://${request.get("host")}/qr` : ""
    });
  });

  app.get("/api/whatsapp/groups", async (request, response) => {
    const auth = resolveControlContext(request, response);
    if (!auth) return;

    try {
      const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
      const client = typeof context.getWhatsAppClient === "function" ? context.getWhatsAppClient() : null;
      if (!client || runtimeStatus.getSnapshot().state !== "ready") {
        response.status(409).json({
          ok: false,
          message: "Connect WhatsApp first, then load its group IDs."
        });
        return;
      }

      const groups = await loadLiveWhatsAppGroups(client);
      response.json({ ok: true, groups });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.get("/api/whatsapp/allowed-groups", (request, response) => {
    const auth = resolveControlContext(request, response);
    if (!auth) return;
    const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
    response.json({ ok: true, groupIds: Array.isArray(context.allowedGroups) ? context.allowedGroups : [] });
  });

  app.post("/api/whatsapp/allowed-groups", (request, response) => {
    const auth = resolveControlContext(request, response);
    if (!auth) return;
    if (safeString(request.body?.confirmation) !== "UPDATE ALLOWED GROUPS") {
      response.status(400).json({ ok: false, message: "Confirmation text is required" });
      return;
    }

    try {
      const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
      if (typeof context.updateAllowedGroups !== "function") {
        response.status(503).json({ ok: false, message: "Allowed group settings are not ready" });
        return;
      }

      const groupIds = context.updateAllowedGroups(request.body?.groupIds);
      logger.info("Allowed WhatsApp groups updated from dashboard", {
        stage: "whatsapp_control",
        reason: `groups=${groupIds.length}, actor=${auth.actor || "Dashboard"}`
      });
      response.json({ ok: true, groupIds, message: "Allowed groups saved. The service is restarting now." });
      setTimeout(() => process.exit(0), 150).unref?.();
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/whatsapp/restart", (request, response) => {
    const auth = resolveControlContext(request, response);
    if (!auth) return;
    response.json({ ok: true, message: "WhatsApp service is restarting" });
    setTimeout(() => process.exit(0), 150).unref?.();
  });

  app.post("/api/whatsapp/stop", async (request, response) => {
    const auth = resolveControlContext(request, response);
    if (!auth) return;
    try {
      const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
      if (typeof context.stopWhatsAppClient !== "function") {
        response.status(503).json({ ok: false, message: "WhatsApp control is not ready" });
        return;
      }
      await context.stopWhatsAppClient();
      logger.info("WhatsApp stopped from dashboard", {
        stage: "whatsapp_control",
        reason: auth.actor || "Dashboard"
      });
      response.json({ ok: true, message: "WhatsApp stopped. OTS and dashboard remain online." });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/whatsapp/session/reset", async (request, response) => {
    const auth = resolveControlContext(request, response);
    if (!auth) return;
    if (safeString(request.body?.confirmation) !== "RESET WHATSAPP SESSION") {
      response.status(400).json({ ok: false, message: "Confirmation text is required" });
      return;
    }
    const session = resolveLocalAuthPaths({
      sessionPath: env.whatsappSessionPath,
      clientId: env.whatsappClientId
    });
    try {
      const context = typeof getDashboardContext === "function" ? getDashboardContext() : {};
      if (typeof context.stopWhatsAppClient === "function") {
        await context.stopWhatsAppClient();
      }
      fs.rmSync(session.sessionFolderPath, { recursive: true, force: true });
      logger.warn("WhatsApp session reset requested from dashboard", {
        stage: "whatsapp_control",
        fallbackUsed: false,
        reason: auth.actor || "Dashboard"
      });
      response.json({ ok: true, message: "Session cleared. Scan the new QR after restart." });
      setTimeout(() => process.exit(0), 150).unref?.();
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/drivers/:driverId/status", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const status = normalizeDashboardAllowedValue(
        request.body?.status,
        DRIVER_STATUS_VALUES,
        "Driver status"
      );
      let result;
      if (context.databasePrimaryEnabled && context.databaseRepository) {
        result = await context.databaseRepository.updateDriverStatus(request.params.driverId, status);
        try {
          await updateDriverStatus({
            sheetsClient: context.sheetsClient,
            spreadsheetId: context.spreadsheetId,
            driversWorksheetName: context.worksheetNames?.drivers,
            driverId: request.params.driverId,
            status
          });
        } catch (error) {
          logger.warn("Driver status Sheets backup failed", {
            stage: "database_backup",
            fallbackUsed: true,
            reason: error?.message || "driver_status_sheet_backup_failed",
            error
          });
        }
      } else {
        result = await updateDriverStatus({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          driversWorksheetName: context.worksheetNames?.drivers,
          driverId: request.params.driverId,
          status
        });
        if (context.databaseRepository && typeof context.databaseRepository.updateDriverStatus === "function") {
          await context.databaseRepository.updateDriverStatus(request.params.driverId, status);
        }
      }
      await appendAuditEntries(context, {
        action: "Driver Status Updated",
        targetType: "Driver",
        targetId: request.params.driverId,
        result,
        actor: context.actor
      });

      logger.info("Driver status updated", {
        stage: "dashboard_action",
        reason: `${request.params.driverId} -> ${result.value}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/drivers", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const driverRecord = {
        driverId: request.body?.driverId,
        driverName: request.body?.driverName,
        whatsappNumber: request.body?.whatsappNumber,
        status: normalizeDashboardAllowedValue(
          request.body?.status || "Available",
          DRIVER_STATUS_VALUES,
          "Driver status"
        ),
        currentLocation: request.body?.currentLocation,
        workingHours: request.body?.workingHours,
        vehicleId: request.body?.vehicleId
      };
      let result;
      if (context.databasePrimaryEnabled && context.databaseRepository) {
        result = await context.databaseRepository.upsertDriver(driverRecord);
        try {
          await createDriverRecord({
            sheetsClient: context.sheetsClient,
            spreadsheetId: context.spreadsheetId,
            driversWorksheetName: context.worksheetNames?.drivers,
            ...driverRecord
          });
        } catch (error) {
          logger.warn("Driver create Sheets backup failed", {
            stage: "database_backup",
            fallbackUsed: true,
            reason: error?.message || "driver_create_sheet_backup_failed",
            error
          });
        }
      } else {
        result = await createDriverRecord({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          driversWorksheetName: context.worksheetNames?.drivers,
          ...driverRecord
        });
        if (context.databaseRepository && typeof context.databaseRepository.upsertDriver === "function") {
          await context.databaseRepository.upsertDriver(driverRecord);
        }
      }
      await appendAuditEntries(context, {
        action: "Driver Created",
        targetType: "Driver",
        targetId: result.key,
        result,
        actor: context.actor
      });

      logger.info("Driver created from dashboard", {
        stage: "dashboard_action",
        reason: result.key
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/vehicles/:vehicleId/status", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const status = normalizeDashboardAllowedValue(
        request.body?.status,
        VEHICLE_STATUS_VALUES,
        "Vehicle status"
      );
      let result;
      if (context.databasePrimaryEnabled && context.databaseRepository) {
        result = await context.databaseRepository.updateVehicleStatus(request.params.vehicleId, status);
        try {
          await updateVehicleStatus({
            sheetsClient: context.sheetsClient,
            spreadsheetId: context.spreadsheetId,
            vehiclesWorksheetName: context.worksheetNames?.vehicles,
            vehicleId: request.params.vehicleId,
            status
          });
        } catch (error) {
          logger.warn("Vehicle status Sheets backup failed", {
            stage: "database_backup",
            fallbackUsed: true,
            reason: error?.message || "vehicle_status_sheet_backup_failed",
            error
          });
        }
      } else {
        result = await updateVehicleStatus({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          vehiclesWorksheetName: context.worksheetNames?.vehicles,
          vehicleId: request.params.vehicleId,
          status
        });
        if (context.databaseRepository && typeof context.databaseRepository.updateVehicleStatus === "function") {
          await context.databaseRepository.updateVehicleStatus(request.params.vehicleId, status);
        }
      }
      await appendAuditEntries(context, {
        action: "Vehicle Status Updated",
        targetType: "Vehicle",
        targetId: request.params.vehicleId,
        result,
        actor: context.actor
      });

      logger.info("Vehicle status updated", {
        stage: "dashboard_action",
        reason: `${request.params.vehicleId} -> ${result.value}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/vehicles", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const vehicleRecord = {
        vehicleId: request.body?.vehicleId,
        vehicleType: request.body?.vehicleType,
        seats: request.body?.seats,
        registration: request.body?.registration,
        driverId: request.body?.driverId,
        status: normalizeDashboardAllowedValue(
          request.body?.status || "Available",
          VEHICLE_STATUS_VALUES,
          "Vehicle status"
        )
      };
      let result;
      if (context.databasePrimaryEnabled && context.databaseRepository) {
        result = await context.databaseRepository.upsertVehicle(vehicleRecord);
        try {
          await createVehicleRecord({
            sheetsClient: context.sheetsClient,
            spreadsheetId: context.spreadsheetId,
            vehiclesWorksheetName: context.worksheetNames?.vehicles,
            ...vehicleRecord
          });
        } catch (error) {
          logger.warn("Vehicle create Sheets backup failed", {
            stage: "database_backup",
            fallbackUsed: true,
            reason: error?.message || "vehicle_create_sheet_backup_failed",
            error
          });
        }
      } else {
        result = await createVehicleRecord({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          vehiclesWorksheetName: context.worksheetNames?.vehicles,
          ...vehicleRecord
        });
        if (context.databaseRepository && typeof context.databaseRepository.upsertVehicle === "function") {
          await context.databaseRepository.upsertVehicle(vehicleRecord);
        }
      }
      await appendAuditEntries(context, {
        action: "Vehicle Created",
        targetType: "Vehicle",
        targetId: result.key,
        result,
        actor: context.actor
      });

      logger.info("Vehicle created from dashboard", {
        stage: "dashboard_action",
        reason: result.key
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/recommendations/:rideId/approve", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      let result;
      if (context.databasePrimaryEnabled && context.databaseRepository) {
        result = await context.databaseRepository.approveRecommendation(request.params.rideId);
        try {
          await approveRecommendation({
            sheetsClient: context.sheetsClient,
            spreadsheetId: context.spreadsheetId,
            recommendationsWorksheetName: context.worksheetNames?.recommendations,
            rideId: request.params.rideId
          });
        } catch (error) {
          logger.warn("Recommendation approval Sheets backup failed", {
            stage: "database_backup",
            fallbackUsed: true,
            reason: error?.message || "recommendation_sheet_backup_failed",
            error
          });
        }
      } else {
        result = await approveRecommendation({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          recommendationsWorksheetName: context.worksheetNames?.recommendations,
          rideId: request.params.rideId
        });
        if (context.databaseRepository && typeof context.databaseRepository.approveRecommendation === "function") {
          await context.databaseRepository.approveRecommendation(request.params.rideId);
        }
      }
      await appendAuditEntries(context, {
        action: "Recommendation Approved",
        targetType: "Recommendation",
        targetId: request.params.rideId,
        result,
        actor: context.actor
      });

      logger.info("Recommendation approved from dashboard", {
        stage: "dashboard_action",
        reason: request.params.rideId
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/recommendations/run-now", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;
      if (typeof context.recommendationPoller?.tick !== "function") {
        throw new Error("Driver recommendation engine is not ready yet");
      }

      const result = await context.recommendationPoller.tick();
      const created = Number(result?.recommendation?.appended || 0);
      const skipped = Number(result?.recommendation?.skipped || 0);
      const assigned = Number(result?.assignment?.assigned || 0);
      const failed = Number(result?.assignment?.failed || 0);
      await appendAuditEntries(context, {
        action: "Recommendations Generated",
        targetType: "Recommendation",
        targetId: "Final Bid",
        result: {
          header: "Manual Run",
          key: "Final Bid",
          oldValue: "",
          value: `created=${created}; assigned=${assigned}; skipped=${skipped}; failed=${failed}`
        },
        actor: context.actor
      });

      logger.info("Driver recommendations generated from dashboard", {
        stage: "dashboard_action",
        reason: `created=${created} assigned=${assigned} skipped=${skipped} failed=${failed}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/final-bid/:rideId/status", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      let result;
      if (context.databasePrimaryEnabled && context.databaseRepository) {
        result = await context.databaseRepository.updateFinalBidStatus(request.params.rideId, request.body?.status);
        try {
          await updateFinalBidStatus({
            sheetsClient: context.sheetsClient,
            spreadsheetId: context.spreadsheetId,
            finalBidWorksheetName: context.worksheetNames?.finalBid,
            rideId: request.params.rideId,
            status: request.body?.status
          });
        } catch (error) {
          logger.warn("Final Bid status Sheets backup failed", {
            stage: "database_backup",
            fallbackUsed: true,
            reason: error?.message || "final_bid_sheet_backup_failed",
            error
          });
        }
      } else {
        result = await updateFinalBidStatus({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          finalBidWorksheetName: context.worksheetNames?.finalBid,
          rideId: request.params.rideId,
          status: request.body?.status
        });
        if (context.databaseRepository && typeof context.databaseRepository.updateFinalBidStatus === "function") {
          await context.databaseRepository.updateFinalBidStatus(request.params.rideId, request.body?.status);
        }
      }
      await appendAuditEntries(context, {
        action: "Final Bid Status Updated",
        targetType: "Final Bid",
        targetId: request.params.rideId,
        result,
        actor: context.actor
      });

      logger.info("Final Bid status updated", {
        stage: "dashboard_action",
        reason: `${request.params.rideId} -> ${result.value || result.status || request.body?.status || ""}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/final-bid/:rideId/calendar-retry", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const result = await resetFinalBidCalendarRetry({
        sheetsClient: context.sheetsClient,
        spreadsheetId: context.spreadsheetId,
        finalBidWorksheetName: context.worksheetNames?.finalBid,
        rideId: request.params.rideId
      });
      await appendAuditEntries(context, {
        action: "Calendar Retry Requested",
        targetType: "Final Bid",
        targetId: request.params.rideId,
        result,
        actor: context.actor
      });

      logger.info("Calendar retry requested", {
        stage: "dashboard_action",
        reason: request.params.rideId
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/needs-review/:rideId/promote", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const result = await promoteNeedsReviewToFinalBid({
        sheetsClient: context.sheetsClient,
        spreadsheetId: context.spreadsheetId,
        needsReviewWorksheetName: context.worksheetNames?.needsReview,
        finalBidWorksheetName: context.worksheetNames?.finalBid,
        appendFinalBidIfEligible: context.appendFinalBidIfEligible,
        rideId: request.params.rideId
      });
      await appendAuditEntries(context, {
        action: "Needs Review Promoted",
        targetType: "Needs Review",
        targetId: request.params.rideId,
        result: result.appended
          ? result
          : {
              header: "Final Bid",
              key: request.params.rideId,
              oldValue: "Existing",
              value: "Existing"
            },
        reason: result.reason || "",
        actor: context.actor
      });

      logger.info("Needs Review promoted from dashboard", {
        stage: "dashboard_action",
        reason: `${request.params.rideId} appended=${result.appended}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/needs-review/:rideId/update", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const result = await updateNeedsReviewRideFields({
        sheetsClient: context.sheetsClient,
        spreadsheetId: context.spreadsheetId,
        needsReviewWorksheetName: context.worksheetNames?.needsReview,
        rideId: request.params.rideId,
        fields: request.body?.fields
      });
      await appendAuditEntries(context, {
        action: "Needs Review Updated",
        targetType: "Needs Review",
        targetId: request.params.rideId,
        result,
        actor: context.actor
      });

      logger.info("Needs Review updated from dashboard", {
        stage: "dashboard_action",
        reason: `${request.params.rideId} updates=${result.updates.length}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/bids/:rideId/create", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const result = await createBidReviewEntry({
        sheetsClient: context.sheetsClient,
        spreadsheetId: context.spreadsheetId,
        finalBidWorksheetName: context.worksheetNames?.finalBid,
        bidTrackerWorksheetName: context.worksheetNames?.bidTracker,
        appendBidTrackerRow: context.appendBidTrackerRow,
        rideId: request.params.rideId,
        minFare: env.finalBidMinFare
      });
      if (result.appended && result.entry && context.databaseRepository?.upsertBid) {
        try {
          await context.databaseRepository.upsertBid(result.entry);
        } catch (error) {
          logger.warn("Bid review database mirror failed", {
            stage: "database",
            fallbackUsed: true,
            reason: error?.message || "bid_review_db_mirror_failed",
            error
          });
        }
      }
      await appendAuditEntries(context, {
        action: "Bid Review Created",
        targetType: "Bid",
        targetId: request.params.rideId,
        result: result.appended
          ? {
              header: "Bid Status",
              key: request.params.rideId,
              oldValue: "",
              value: result.entry?.["Bid Status"] || "Suggested"
            }
          : {
              header: "Bid Status",
              key: request.params.rideId,
              oldValue: "Existing",
              value: "Existing"
            },
        reason: result.reason || "",
        actor: context.actor
      });

      logger.info("Bid review entry created", {
        stage: "dashboard_action",
        reason: `${request.params.rideId} appended=${result.appended}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/bids/:rideId/ai-review", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;
      if (!context.databasePrimaryEnabled || !context.databaseRepository?.getBidRecord) {
        throw new Error("AI bid review requires the primary database");
      }
      if (!context.bidAiReviewer?.enabled) {
        throw new Error("AI bid review is disabled. Enable BID_AI_REVIEW_ENABLED only when needed.");
      }

      const current = await context.databaseRepository.getBidRecord(request.params.rideId);
      const pricing = calculateBidPricing(current, {
        linkedSaving: current["Linked Saving"]
      });
      const review = await context.bidAiReviewer.review({ bid: current, pricing });
      const nextPricing = {
        ...pricing,
        suggestedBid: review.suggestedBid,
        estimatedProfit: Math.round((review.suggestedBid - pricing.estimatedCost) * 2) / 2,
        marginPercent: review.suggestedBid
          ? Math.round(((review.suggestedBid - pricing.estimatedCost) / review.suggestedBid) * 1000) / 10
          : 0,
        decision: review.decision,
        confidence: review.confidence
      };
      const nextReason = `${pricing.reason}; AI review: ${review.reason}`;
      const record = {
        ...current,
        "Bid Amount": nextPricing.suggestedBid,
        Reason: nextReason,
        "Estimated Cost": nextPricing.estimatedCost,
        "Estimated Profit": nextPricing.estimatedProfit,
        "Margin %": nextPricing.marginPercent,
        "Linked Saving": nextPricing.linkedSaving,
        "AI Decision": nextPricing.decision,
        "Pricing Confidence": nextPricing.confidence,
        pricingPayload: nextPricing
      };
      const result = await context.databaseRepository.upsertBid(record);
      try {
        await updateBidStatus({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          bidTrackerWorksheetName: context.worksheetNames?.bidTracker,
          rideId: request.params.rideId,
          bidStatus: current["Bid Status"] || "Suggested",
          bidAmount: nextPricing.suggestedBid,
          reason: nextReason
        });
      } catch (error) {
        logger.warn("AI bid review Sheets backup failed", {
          stage: "database_backup",
          fallbackUsed: true,
          reason: error?.message || "ai_bid_review_sheet_backup_failed",
          error
        });
      }
      await appendAuditEntries(context, {
        action: "AI Bid Reviewed",
        targetType: "Bid",
        targetId: request.params.rideId,
        result,
        reason: review.cached ? "cached_review" : "operator_requested_review",
        actor: context.actor
      });
      logger.info("AI bid review completed", {
        stage: "bid_ai_review",
        reason: request.params.rideId
      });
      response.json({ ok: true, result: record, cached: review.cached });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/bids/:rideId/admin-status", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const adminStatus = normalizeDashboardAllowedValue(
        request.body?.adminStatus || request.body?.status,
        BID_ADMIN_STATUS_VALUES,
        "Bid admin status"
      );
      let result;
      if (context.databasePrimaryEnabled && context.databaseRepository) {
        result = await context.databaseRepository.updateBidAdminStatus({
          rideId: request.params.rideId,
          adminStatus,
          bidAmount: request.body?.bidAmount,
          reason: request.body?.reason
        });
        try {
          await updateBidAdminStatus({
            sheetsClient: context.sheetsClient,
            spreadsheetId: context.spreadsheetId,
            bidTrackerWorksheetName: context.worksheetNames?.bidTracker,
            rideId: request.params.rideId,
            adminStatus,
            bidAmount: request.body?.bidAmount,
            reason: request.body?.reason
          });
        } catch (error) {
          logger.warn("Bid admin status Sheets backup failed", {
            stage: "database_backup",
            fallbackUsed: true,
            reason: error?.message || "bid_admin_status_sheet_backup_failed",
            error
          });
        }
      } else {
        result = await updateBidAdminStatus({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          bidTrackerWorksheetName: context.worksheetNames?.bidTracker,
          rideId: request.params.rideId,
          adminStatus,
          bidAmount: request.body?.bidAmount,
          reason: request.body?.reason
        });
        if (context.databaseRepository?.updateBidAdminStatus) {
          await context.databaseRepository.updateBidAdminStatus({
            rideId: request.params.rideId,
            adminStatus,
            bidAmount: request.body?.bidAmount,
            reason: request.body?.reason
          });
        }
      }
      await appendAuditEntries(context, {
        action: "Bid Admin Status Updated",
        targetType: "Bid",
        targetId: request.params.rideId,
        result,
        actor: context.actor
      });

      logger.info("Bid admin status updated", {
        stage: "dashboard_action",
        reason: `${request.params.rideId} -> ${adminStatus}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/bids/:rideId/status", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const bidStatus = normalizeDashboardAllowedValue(
        request.body?.bidStatus || request.body?.status,
        BID_STATUS_VALUES,
        "Bid status"
      );
      let result;
      if (context.databasePrimaryEnabled && context.databaseRepository) {
        result = await context.databaseRepository.updateBidStatus({
          rideId: request.params.rideId,
          bidStatus,
          bidAmount: request.body?.bidAmount,
          reason: request.body?.reason
        });
        try {
          await updateBidStatus({
            sheetsClient: context.sheetsClient,
            spreadsheetId: context.spreadsheetId,
            bidTrackerWorksheetName: context.worksheetNames?.bidTracker,
            rideId: request.params.rideId,
            bidStatus,
            bidAmount: request.body?.bidAmount,
            reason: request.body?.reason
          });
        } catch (error) {
          logger.warn("Bid status Sheets backup failed", {
            stage: "database_backup",
            fallbackUsed: true,
            reason: error?.message || "bid_status_sheet_backup_failed",
            error
          });
        }
      } else {
        result = await updateBidStatus({
          sheetsClient: context.sheetsClient,
          spreadsheetId: context.spreadsheetId,
          bidTrackerWorksheetName: context.worksheetNames?.bidTracker,
          rideId: request.params.rideId,
          bidStatus,
          bidAmount: request.body?.bidAmount,
          reason: request.body?.reason
        });
        if (context.databaseRepository?.updateBidStatus) {
          await context.databaseRepository.updateBidStatus({
            rideId: request.params.rideId,
            bidStatus,
            bidAmount: request.body?.bidAmount,
            reason: request.body?.reason
          });
        }
      }
      await appendAuditEntries(context, {
        action: "Bid Status Updated",
        targetType: "Bid",
        targetId: request.params.rideId,
        result,
        actor: context.actor
      });

      logger.info("Bid status updated", {
        stage: "dashboard_action",
        reason: `${request.params.rideId} -> ${bidStatus}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/bids/process-approved", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const mode = safeString(request.body?.mode || env.autoBidMode, "safe").toLowerCase();
      if (mode === "live" && (!env.otsBidSubmitScript || !fs.existsSync(env.otsBidSubmitScript))) {
        throw new Error("Live auto bid is not configured: OTS bid submit script is missing");
      }
      const submitBid =
        mode === "live"
          ? createOtsWorkerSubmitter({
              scriptPath: env.otsBidSubmitScript,
              projectPath: env.otsProjectPath,
              timeoutMs: env.otsBidSubmitTimeoutMs,
              env: { OTS_BID_MODE: mode }
            })
          : undefined;
      if (typeof context.autoBidRunner?.tick !== "function") {
        throw new Error("Auto bid runner is not ready yet");
      }
      const result = await context.autoBidRunner.tick({
        mode,
        submitBid,
        throwOnError: true
      });

      await appendAuditEntries(context, {
        action: "Auto Bid Processed",
        targetType: "Bid",
        targetId: "Approved Bids",
        result: {
          header: "Bid Status",
          key: "Approved Bids",
          oldValue: "",
          value: `submitted=${result.submitted} safe=${result.safeMode} failed=${result.failed}`
        },
        actor: context.actor
      });

      logger.info("Auto bid processed from dashboard", {
        stage: "dashboard_action",
        reason: `mode=${mode} submitted=${result.submitted} safe=${result.safeMode} failed=${result.failed}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/schedules/:rideId/complete", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const result = await completeAssignedRideSchedules({
        sheetsClient: context.sheetsClient,
        spreadsheetId: context.spreadsheetId,
        driverScheduleWorksheetName: context.worksheetNames?.driverSchedule,
        vehicleScheduleWorksheetName: context.worksheetNames?.vehicleSchedule,
        driversWorksheetName: context.worksheetNames?.drivers,
        vehiclesWorksheetName: context.worksheetNames?.vehicles,
        rideId: request.params.rideId
      });
      if (context.databasePrimaryEnabled && context.databaseRepository?.completeRideSchedules) {
        await context.databaseRepository.completeRideSchedules({
          rideId: request.params.rideId,
          driverId: result.driverId,
          vehicleId: result.vehicleId,
          currentLocation: result.currentLocation
        });
      }
      await appendAuditEntries(context, {
        action: "Schedule Completed",
        targetType: "Schedule",
        targetId: request.params.rideId,
        result: result.completed
          ? result
          : {
              header: "Status",
              key: request.params.rideId,
              oldValue: "Closed",
              value: "Closed"
            },
        reason: result.reason || "",
        actor: context.actor
      });

      logger.info("Schedule completed from dashboard", {
        stage: "dashboard_action",
        reason: `${request.params.rideId} completed=${result.completed}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/ots/import-now", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;
      if (typeof context.appendRideRow !== "function") {
        throw new Error("OTS import is not ready yet");
      }

      if (typeof context.otsImportRunner?.tick !== "function") {
        throw new Error("OTS import runner is not ready yet");
      }

      const result = await context.otsImportRunner.tick({
        runPipeline:
          request.body?.runPipeline === undefined
            ? env.otsRunPipeline
            : Boolean(request.body?.runPipeline),
        throwOnError: true
      });

      await appendAuditEntries(context, {
        action: "OTS Import Requested",
        targetType: "OTS",
        targetId: "Formatted Rows",
        result: {
          header: "Imported",
          key: "OTS",
          oldValue: "",
          value: `imported=${result.imported} review=${result.review} skipped=${result.skipped} failed=${result.failed}`
        },
        actor: context.actor
      });

      logger.info("OTS import requested from dashboard", {
        stage: "dashboard_action",
        reason: `imported=${result.imported} review=${result.review} skipped=${result.skipped} failed=${result.failed}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  app.post("/api/criteria/:setting", async (request, response) => {
    try {
      const context = resolveActionContext(request, response);
      if (!context) return;

      const result = await updateDispatchCriteria({
        sheetsClient: context.sheetsClient,
        spreadsheetId: context.spreadsheetId,
        dispatchCriteriaWorksheetName: context.worksheetNames?.dispatchCriteria,
        setting: request.params.setting,
        value: request.body?.value
      });
      await appendAuditEntries(context, {
        action: "Dispatch Criteria Updated",
        targetType: "Criteria",
        targetId: result.setting,
        result,
        actor: context.actor
      });

      logger.info("Dispatch criteria updated", {
        stage: "dashboard_action",
        reason: `${result.setting}=${result.value}`
      });
      response.json({ ok: true, result });
    } catch (error) {
      sendActionError(response, error);
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info("Dashboard and QR server ready", {
        stage: "http_server",
        reason: `port=${port} /health /qr /dashboard`
      });
      resolve(server);
    });

    server.on("error", (error) => {
      reject(error);
    });
  });
}

function startupHealthSnapshot() {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    rssMb: Math.round(memory.rss / (1024 * 1024)),
    heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024))
  };
}

function resolvePuppeteerOptions() {
  if (env.nodeEnv !== "production") {
    return env.puppeteerExecutablePath
      ? {
          executablePath: env.puppeteerExecutablePath
        }
      : {};
  }

  if (process.platform === "win32") {
    return env.puppeteerExecutablePath
      ? {
          headless: true,
          executablePath: env.puppeteerExecutablePath
        }
      : {
          headless: true
        };
  }

  return {
    headless: true,
    ...(env.puppeteerExecutablePath
      ? { executablePath: env.puppeteerExecutablePath }
      : {}),
    args: RAILWAY_PUPPETEER_ARGS
  };
}

async function verifyWorksheetTargetsReady({
  sheetsClient,
  spreadsheetId,
  worksheetTargets,
  logger
}) {
  if (!sheetsClient || !spreadsheetId) {
    throw new Error("Google Sheets client is not ready for worksheet verification");
  }

  let response;
  try {
    response = await runStartupSheetsRequest(
      () =>
        sheetsClient.spreadsheets.get({
          spreadsheetId,
          fields: "sheets(properties(title))"
        }),
      { logger, action: "list worksheets" }
    );
  } catch (error) {
    if (isGoogleSheetsQuotaError(error)) {
      activateSheetsStartupQuotaCooldown();
      logger.warn("Google Sheets startup verification skipped because quota is temporarily exhausted", {
        stage: "sheets_startup",
        fallbackUsed: true,
        reason: getGoogleApiReason(error)
      });
      return;
    }
    throw error;
  }
  const existingTitles = new Set(
    (Array.isArray(response?.data?.sheets) ? response.data.sheets : [])
      .map((sheet) => safeString(sheet?.properties?.title))
      .filter(Boolean)
      .map((title) => normalizeWorksheetTitle(title))
  );

  const targets = Array.isArray(worksheetTargets) ? worksheetTargets : [];
  const missing = targets
    .map((target) => safeString(target?.worksheetName))
    .filter(
      (worksheetName) =>
        safeString(worksheetName) && !existingTitles.has(normalizeWorksheetTitle(worksheetName))
    );

  if (missing.length > 0) {
    const error = new Error(`Missing Google Sheets worksheets: ${missing.join(", ")}`);
    error.code = "SHEETS_WORKSHEETS_MISSING";
    error.details = {
      missing,
      existing: [...existingTitles]
    };
    throw error;
  }

  for (const target of targets) {
    const worksheetName = safeString(target?.worksheetName);
    const minimumHeaders = Array.isArray(target?.minimumHeaders) ? target.minimumHeaders : [];
    const expectedHeaders = Array.isArray(target?.expectedHeaders) ? target.expectedHeaders : [];
    let headerResponse;
    try {
      headerResponse = await runStartupSheetsRequest(
        () =>
          sheetsClient.spreadsheets.values.get({
            spreadsheetId,
            range: `'${worksheetName.replace(/'/g, "''")}'!1:1`
          }),
        { logger, action: "read worksheet headers", worksheetName }
      );
    } catch (error) {
      if (isGoogleSheetsQuotaError(error)) {
        activateSheetsStartupQuotaCooldown();
        logger.warn("Google Sheets header verification skipped because quota is temporarily exhausted", {
          stage: "sheets_startup",
          fallbackUsed: true,
          reason: `${worksheetName}: ${getGoogleApiReason(error)}`
        });
        continue;
      }
      throw error;
    }
    const rawHeaders = Array.isArray(headerResponse?.data?.values?.[0])
      ? headerResponse.data.values[0]
      : [];
    const normalizedHeaders = new Set(rawHeaders.map((header) => normalizeHeaderName(header)));
    if (expectedHeaders.length > 0) {
      const actualHeaders = rawHeaders.map((header) => normalizeHeaderName(header));
      const expectedNormalized = expectedHeaders.map((header) => normalizeHeaderName(header));
      const exactMatch =
        actualHeaders.length === expectedNormalized.length &&
        actualHeaders.every((header, index) => header === expectedNormalized[index]);

      if (!exactMatch) {
        const error = new Error(
          `Worksheet ${worksheetName} headers do not match strict schema order`
        );
        error.code = "SHEETS_HEADERS_MISMATCH";
        error.details = {
          worksheetName,
          expectedHeaders,
          headers: rawHeaders
        };
        throw error;
      }
      continue;
    }

    const missingHeaders = minimumHeaders.filter(
      (header) => !normalizedHeaders.has(normalizeHeaderName(header))
    );

    if (missingHeaders.length > 0) {
      const error = new Error(
        `Worksheet ${worksheetName} is missing required headers: ${missingHeaders.join(", ")}`
      );
      error.code = "SHEETS_HEADERS_MISSING";
      error.details = {
        worksheetName,
        missingHeaders,
        headers: rawHeaders
      };
      throw error;
    }
  }

  logger.debug("Google Sheets worksheet targets verified", {
    stage: "sheets_startup",
    fallbackUsed: false,
    reason: targets.map((target) => target.worksheetName).join(", ")
  });
}

async function ensureWorksheetWithHeaders({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  headers,
  repairHeaders = false,
  logger
}) {
  if (!sheetsClient || !spreadsheetId || !worksheetName) {
    throw new Error("Google Sheets client is not ready for worksheet setup");
  }

  let response;
  try {
    response = await runStartupSheetsRequest(
      () =>
        sheetsClient.spreadsheets.get({
          spreadsheetId,
          fields: "sheets(properties(title))"
        }),
      { logger, action: "list worksheets", worksheetName }
    );
  } catch (error) {
    if (isGoogleSheetsQuotaError(error)) {
      activateSheetsStartupQuotaCooldown();
      logger.warn("Google Sheets worksheet setup skipped because quota is temporarily exhausted", {
        stage: "sheets_startup",
        fallbackUsed: true,
        reason: `${worksheetName}: ${getGoogleApiReason(error)}`
      });
      return;
    }
    throw error;
  }
  const existingTitles = new Set(
    (Array.isArray(response?.data?.sheets) ? response.data.sheets : [])
      .map((sheet) => safeString(sheet?.properties?.title))
      .filter(Boolean)
      .map((title) => normalizeWorksheetTitle(title))
  );

  if (!existingTitles.has(normalizeWorksheetTitle(worksheetName))) {
    try {
      await runStartupSheetsRequest(
        () =>
          sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [
                {
                  addSheet: {
                    properties: {
                      title: worksheetName
                    }
                  }
                }
              ]
            }
          }),
        { logger, action: "create worksheet", worksheetName }
      );

      logger.info("Google Sheets worksheet created", {
        stage: "sheets_startup",
        fallbackUsed: false,
        reason: worksheetName
      });
    } catch (error) {
      const message = safeString(error?.response?.data?.error?.message || error?.message);
      if (!/already exists/i.test(message)) {
        throw error;
      }

      logger.debug("Google Sheets worksheet already exists", {
        stage: "sheets_startup",
        fallbackUsed: false,
        reason: worksheetName
      });
    }
  }

  let headerResponse;
  try {
    headerResponse = await runStartupSheetsRequest(
      () =>
        sheetsClient.spreadsheets.values.get({
          spreadsheetId,
          range: buildHeaderRange(worksheetName),
          majorDimension: "ROWS"
        }),
      { logger, action: "read worksheet headers", worksheetName }
    );
  } catch (error) {
    if (isGoogleSheetsQuotaError(error)) {
      activateSheetsStartupQuotaCooldown();
      logger.warn("Google Sheets worksheet header setup skipped because quota is temporarily exhausted", {
        stage: "sheets_startup",
        fallbackUsed: true,
        reason: `${worksheetName}: ${getGoogleApiReason(error)}`
      });
      return;
    }
    throw error;
  }
  const currentHeaders = Array.isArray(headerResponse?.data?.values?.[0])
    ? headerResponse.data.values[0].map((header) => safeString(header))
    : [];

  const expectedHeaders = Array.isArray(headers) ? headers : [];
  const headerMismatch =
    currentHeaders.length > 0 &&
    expectedHeaders.length > 0 &&
    (currentHeaders.length !== expectedHeaders.length ||
      currentHeaders.some(
        (header, index) => normalizeHeaderName(header) !== normalizeHeaderName(expectedHeaders[index])
      ));

  if (
    expectedHeaders.length > 0 &&
    (currentHeaders.length === 0 || (repairHeaders && headerMismatch))
  ) {
    try {
      await runStartupSheetsRequest(
        () =>
          sheetsClient.spreadsheets.values.update({
            spreadsheetId,
            range: buildHeaderRange(worksheetName),
            valueInputOption: "RAW",
            requestBody: {
              values: [expectedHeaders]
            }
          }),
        { logger, action: "write worksheet headers", worksheetName }
      );
    } catch (error) {
      if (isGoogleSheetsQuotaError(error)) {
        activateSheetsStartupQuotaCooldown();
        logger.warn("Google Sheets worksheet header write skipped because quota is temporarily exhausted", {
          stage: "sheets_startup",
          fallbackUsed: true,
          reason: `${worksheetName}: ${getGoogleApiReason(error)}`
        });
        return;
      }
      throw error;
    }

    logger.info(
      currentHeaders.length === 0
        ? "Google Sheets worksheet headers initialized"
        : "Google Sheets worksheet headers repaired",
      {
      stage: "sheets_startup",
      fallbackUsed: false,
      reason: worksheetName
      }
    );
  }
}

function normalizeSheetTitleForFormula(worksheetName) {
  const cleanName = safeString(worksheetName);
  if (!cleanName) return "";
  if (/^[A-Za-z0-9_]+$/.test(cleanName)) return cleanName;
  return `'${cleanName.replace(/'/g, "''")}'`;
}

function findSheetPropertiesByTitle(sheetsMetadata, worksheetName) {
  const title = normalizeWorksheetTitle(worksheetName);
  return (Array.isArray(sheetsMetadata?.data?.sheets) ? sheetsMetadata.data.sheets : [])
    .map((sheet) => sheet?.properties || {})
    .find((properties) => normalizeWorksheetTitle(properties.title) === title);
}

async function applyFinalBidAssignedDriverValidation({
  sheetsClient,
  spreadsheetId,
  finalBidWorksheetName,
  driversWorksheetName,
  logger
}) {
  if (!sheetsClient || !spreadsheetId) {
    throw new Error("Google Sheets client is not ready for driver validation setup");
  }

  const metadata = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))"
  });
  const finalBidProperties = findSheetPropertiesByTitle(metadata, finalBidWorksheetName);
  const driversProperties = findSheetPropertiesByTitle(metadata, driversWorksheetName);

  if (!finalBidProperties?.sheetId && finalBidProperties?.sheetId !== 0) {
    throw new Error(`Worksheet ${finalBidWorksheetName} not found for driver validation`);
  }

  if (!driversProperties?.sheetId && driversProperties?.sheetId !== 0) {
    throw new Error(`Worksheet ${driversWorksheetName} not found for driver validation`);
  }

  const headerResponse = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: buildHeaderRange(finalBidWorksheetName),
    majorDimension: "ROWS"
  });
  const headers = Array.isArray(headerResponse?.data?.values?.[0])
    ? headerResponse.data.values[0].map((header) => safeString(header))
    : [];
  const assignedDriverColumnIndex = headers.findIndex(
    (header) => normalizeHeaderName(header) === normalizeHeaderName("Assigned Driver")
  );

  if (assignedDriverColumnIndex < 0) {
    throw new Error("Final Bid worksheet is missing Assigned Driver header");
  }

  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId: finalBidProperties.sheetId,
              startRowIndex: 1,
              startColumnIndex: assignedDriverColumnIndex,
              endColumnIndex: assignedDriverColumnIndex + 1
            },
            rule: {
              condition: {
                type: "ONE_OF_RANGE",
                values: [
                  {
                    userEnteredValue: `=${normalizeSheetTitleForFormula(driversProperties.title)}!$A$2:$A`
                  }
                ]
              },
              strict: false,
              showCustomUi: true
            }
          }
        }
      ]
    }
  });

  logger.debug("Final Bid Assigned Driver validation configured", {
    stage: "sheets_startup",
    fallbackUsed: false,
    reason: `${finalBidProperties.title}!${headers[assignedDriverColumnIndex]} -> ${driversProperties.title}!A2:A`
  });
}

async function applyTextFormatForHeaders({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  headerNames,
  logger
}) {
  if (!sheetsClient || !spreadsheetId || !worksheetName) {
    throw new Error("Google Sheets client is not ready for text format setup");
  }

  const metadata = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))"
  });
  const sheetProperties = findSheetPropertiesByTitle(metadata, worksheetName);
  if (!sheetProperties?.sheetId && sheetProperties?.sheetId !== 0) {
    throw new Error(`Worksheet ${worksheetName} not found for text format setup`);
  }

  const headerResponse = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: buildHeaderRange(worksheetName),
    majorDimension: "ROWS"
  });
  const headers = Array.isArray(headerResponse?.data?.values?.[0])
    ? headerResponse.data.values[0].map((header) => safeString(header))
    : [];
  const requestedHeaders = new Set(
    (Array.isArray(headerNames) ? headerNames : []).map((header) => normalizeHeaderName(header))
  );
  const requests = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => requestedHeaders.has(normalizeHeaderName(header)))
    .map(({ index }) => ({
      repeatCell: {
        range: {
          sheetId: sheetProperties.sheetId,
          startRowIndex: 1,
          startColumnIndex: index,
          endColumnIndex: index + 1
        },
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type: "TEXT"
            }
          }
        },
        fields: "userEnteredFormat.numberFormat"
      }
    }));

  if (requests.length === 0) return;

  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests
    }
  });

  logger.debug("Google Sheets text formatting configured", {
    stage: "sheets_startup",
    fallbackUsed: false,
    reason: `${sheetProperties.title}: ${requests.length} columns`
  });
}

async function seedDispatchCriteriaIfEmpty({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  defaults,
  logger
}) {
  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteWorksheetNameForRange(worksheetName)}!A2:D`,
    majorDimension: "ROWS"
  });
  const rows = Array.isArray(response?.data?.values) ? response.data.values : [];
  const hasExistingSetting = rows.some((row) => safeString(row?.[0]));
  if (hasExistingSetting) return { seeded: false };

  const values = criteriaRowsFromDefaults(defaults);
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteWorksheetNameForRange(worksheetName)}!A2:D${values.length + 1}`,
    valueInputOption: "RAW",
    requestBody: { values }
  });
  logger.info("Dispatch criteria defaults seeded", {
    stage: "sheets_startup",
    reason: worksheetName
  });
  return { seeded: true, rows: values.length };
}

function configBaseFinalBid(envConfig = {}) {
  return {
    enabled: envConfig.finalBidEnabled,
    minFare: envConfig.finalBidMinFare,
    minDistance: envConfig.finalBidMinDistance,
    maxDistance: envConfig.finalBidMaxDistance,
    minScore: envConfig.finalBidMinScore,
    allowedVehicles: envConfig.finalBidAllowedVehicles,
    excludedVehicles: envConfig.finalBidExcludedVehicles,
    allowedGroups: envConfig.finalBidAllowedGroups,
    allowedAreaCodes: envConfig.finalBidAllowedAreaCodes,
    areaMatchMode: envConfig.finalBidAreaMatchMode,
    requireFare: envConfig.finalBidRequireFare,
    requireDistance: envConfig.finalBidRequireDistance
  };
}

function registerProcessHandlers(logger) {
  process.on("uncaughtException", (error) => {
    const summary = summarizeKnownError(error, {
      stage: "process",
      defaultSummary: "Service error: uncaught exception"
    });

    logger.error(summary.summary, {
      stage: "process",
      reason: summary.likelyCause || "Check debug logs for stack trace",
      fallbackUsed: false,
      status: summary.status,
      code: summary.code,
      error
    });
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const summary = summarizeKnownError(error, {
      stage: "process",
      defaultSummary: "Service error: unhandled promise rejection"
    });

    logger.error(summary.summary, {
      stage: "process",
      reason: summary.likelyCause || "Unhandled async failure",
      fallbackUsed: false,
      status: summary.status,
      code: summary.code,
      error
    });
  });
}

function registerShutdownHooks({
  logger,
  getClient,
  getDedupe,
  getServer,
  getApprovalPoller,
  getOperationsPoller,
  getOtsIntegrationPoller,
  getAutoBidPoller,
  getRetentionCleanupPoller,
  getDatabaseRetentionPoller,
  getJobLinkerService,
  sessionPath
}) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn("Shutdown signal received", {
      stage: "shutdown",
      reason: signal
    });

    const client = typeof getClient === "function" ? getClient() : null;
    if (client && typeof client.destroy === "function") {
      try {
        await Promise.race([
          client.destroy(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("WhatsApp client shutdown timeout")), 10000)
          )
        ]);
        logger.info("WhatsApp client closed", {
          stage: "shutdown",
          reason: "session data preserved"
        });
      } catch (error) {
        const summary = summarizeKnownError(error, {
          stage: "whatsapp_shutdown",
          defaultSummary: "WhatsApp close issue during shutdown"
        });

        logger.warn(summary.summary, {
          stage: "shutdown",
          reason: summary.likelyCause || "Timeout or browser disconnect",
          fallbackUsed: true,
          error
        });
      }
    }

    const dedupeStore = typeof getDedupe === "function" ? getDedupe() : null;
    if (dedupeStore && typeof dedupeStore.flush === "function") {
      try {
        const flushed = dedupeStore.flush();
        if (flushed) {
          logger.info("Dedupe state flushed", {
            stage: "shutdown"
          });
        }
      } catch (error) {
        logger.warn("Unable to flush dedupe state", {
          stage: "shutdown",
          fallbackUsed: true
        });
      }
    }

    const server = typeof getServer === "function" ? getServer() : null;
    if (server && typeof server.close === "function" && server.listening) {
      await new Promise((resolve) => {
        server.close((error) => {
          if (error) {
            logger.warn("HTTP server close issue during shutdown", {
              stage: "shutdown",
              fallbackUsed: true,
              error
            });
          } else {
            logger.info("HTTP server closed", {
              stage: "shutdown"
            });
          }
          resolve();
        });
      });
    }

    const approvalPoller = typeof getApprovalPoller === "function" ? getApprovalPoller() : null;
    if (approvalPoller && typeof approvalPoller.stop === "function") {
      try {
        approvalPoller.stop();
        logger.info("Approval poller stopped", {
          stage: "shutdown"
        });
      } catch (error) {
        logger.warn("Unable to stop approval poller", {
          stage: "shutdown",
          fallbackUsed: true
        });
      }
    }

    const operationsPoller =
      typeof getOperationsPoller === "function" ? getOperationsPoller() : null;
    if (operationsPoller && typeof operationsPoller.stop === "function") {
      try {
        operationsPoller.stop();
        logger.info("Operations View poller stopped", {
          stage: "shutdown"
        });
      } catch (error) {
        logger.warn("Unable to stop Operations View poller", {
          stage: "shutdown",
          fallbackUsed: true
        });
      }
    }

    const otsIntegrationPoller =
      typeof getOtsIntegrationPoller === "function" ? getOtsIntegrationPoller() : null;
    if (otsIntegrationPoller && typeof otsIntegrationPoller.stop === "function") {
      try {
        otsIntegrationPoller.stop();
        logger.info("OTS integration poller stopped", {
          stage: "shutdown"
        });
      } catch (error) {
        logger.warn("Unable to stop OTS integration poller", {
          stage: "shutdown",
          fallbackUsed: true
        });
      }
    }

    const autoBidPoller = typeof getAutoBidPoller === "function" ? getAutoBidPoller() : null;
    if (autoBidPoller && typeof autoBidPoller.stop === "function") {
      try {
        autoBidPoller.stop();
        logger.info("Auto bid poller stopped", {
          stage: "shutdown"
        });
      } catch (error) {
        logger.warn("Unable to stop auto bid poller", {
          stage: "shutdown",
          fallbackUsed: true
        });
      }
    }

    const retentionCleanupPoller =
      typeof getRetentionCleanupPoller === "function" ? getRetentionCleanupPoller() : null;
    if (retentionCleanupPoller && typeof retentionCleanupPoller.stop === "function") {
      try {
        retentionCleanupPoller.stop();
        logger.info("Retention cleanup poller stopped", {
          stage: "shutdown"
        });
      } catch (error) {
        logger.warn("Unable to stop retention cleanup poller", {
          stage: "shutdown",
          fallbackUsed: true
        });
      }
    }

    const databaseRetentionPoller =
      typeof getDatabaseRetentionPoller === "function" ? getDatabaseRetentionPoller() : null;
    if (databaseRetentionPoller && typeof databaseRetentionPoller.stop === "function") {
      try {
        databaseRetentionPoller.stop();
        logger.info("Database retention poller stopped", {
          stage: "shutdown"
        });
      } catch (error) {
        logger.warn("Unable to stop database retention poller", {
          stage: "shutdown",
          fallbackUsed: true
        });
      }
    }

    const jobLinkerService = typeof getJobLinkerService === "function" ? getJobLinkerService() : null;
    if (jobLinkerService && typeof jobLinkerService.stop === "function") {
      jobLinkerService.stop();
    }

    logger.info("Service stopped", {
      stage: "shutdown",
      reason: sessionPath || ""
    });
    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

async function bootstrap() {
  const logger = createLogger(env.logLevel || "info", {
    mode: env.logMode,
    baseMeta: { service: "ride-bot", component: "app" }
  });

  registerProcessHandlers(logger);
  let clientRef = null;
  let dedupeRef = null;
  let serverRef = null;
  let sheetsClientRef = null;
  let appendRideRowRef = null;
  let appendReviewRowRef = null;
  let appendUpcomingJobIfEligibleRef = null;
  let appendFinalBidAndBidTrackerIfEligibleRef = null;
  let appendBidTrackerRowRef = null;
  let appendAuditLogRowRef = null;
  let calendarClientRef = null;
  let approvalPollerRef = null;
  let operationsPollerRef = null;
  let recommendationPollerRef = null;
  let otsImportRunnerRef = null;
  let otsIntegrationPollerRef = null;
  let autoBidRunnerRef = null;
  let autoBidPollerRef = null;
  let retentionCleanupPollerRef = null;
  let databaseRetentionPollerRef = null;
  let jobLinkerRepositoryRef = null;
  let jobLinkerServiceRef = null;
  let jobLinkerBidServiceRef = null;
  let databaseHealth = {
    configured: Boolean(env.databaseUrl),
    ok: false,
    reason: env.databaseUrl ? "not_checked" : "DATABASE_URL missing"
  };
  let databaseRepositoryRef = null;
  const bidAiReviewer = createBidAiReviewer({
    enabled: env.bidAiReviewEnabled,
    apiKey: env.openaiApiKey,
    model: env.openaiModel,
    maxCallsPerHour: 8
  });
  const runtimeStatus = createBotRuntimeStatus();
  registerShutdownHooks({
    logger,
    getClient: () => clientRef,
    getDedupe: () => dedupeRef,
    getServer: () => serverRef,
    getApprovalPoller: () => approvalPollerRef,
    getOperationsPoller: () => operationsPollerRef,
    getRecommendationPoller: () => recommendationPollerRef,
    getOtsIntegrationPoller: () => otsIntegrationPollerRef,
    getAutoBidPoller: () => autoBidPollerRef,
    getRetentionCleanupPoller: () => retentionCleanupPollerRef,
    getDatabaseRetentionPoller: () => databaseRetentionPollerRef,
    getJobLinkerService: () => jobLinkerServiceRef,
    sessionPath: env.whatsappSessionPath
  });

  logger.info("Ride bot starting", {
    stage: "startup",
    reason: `env=${env.nodeEnv}`
  });

  logger.debug("Startup diagnostics", {
    stage: "startup",
    ...startupHealthSnapshot()
  });

  if (env.databaseUrl) {
    databaseHealth = await checkDatabaseConnection({ databaseUrl: env.databaseUrl });
    if (databaseHealth.ok) {
      databaseRepositoryRef = new DispatchDatabaseRepository({
        databaseUrl: env.databaseUrl,
        timeZone: env.appTimeZone
      });
      jobLinkerRepositoryRef = new JobLinkerRepository({ databaseUrl: env.databaseUrl });
      logger.info("Supabase database connected", {
        stage: "database",
        fallbackUsed: false
      });
    } else {
      logger.warn("Supabase database connection failed", {
        stage: "database",
        fallbackUsed: true,
        reason: databaseHealth.reason || "database_connection_failed"
      });
    }
  } else {
    logger.warn("Supabase database not configured", {
      stage: "database",
      fallbackUsed: true,
      reason: "DATABASE_URL missing"
    });
  }

  if (env.jobLinkerEnabled && jobLinkerRepositoryRef) {
    const manualBidSubmitter = env.otsBidSubmitScript && fs.existsSync(env.otsBidSubmitScript)
      ? createOtsWorkerSubmitter({
          scriptPath: env.otsBidSubmitScript,
          projectPath: env.otsProjectPath,
          timeoutMs: env.otsBidSubmitTimeoutMs,
          env: { OTS_BID_MODE: "live" }
        })
      : null;
    jobLinkerBidServiceRef = createJobLinkerBidService({
      repository: jobLinkerRepositoryRef,
      submitBid: manualBidSubmitter,
      logger: logger.child({ component: "job-linker-bid" })
    });
    const jobLinkerGeocoder = createGeocoder({
      provider: env.geocodingProvider,
      apiKey: env.geocodingApiKey,
      baseUrl: env.geocodingBaseUrl,
      userAgent: env.geocodingUserAgent,
      timeoutMs: env.geocodingTimeoutMs,
      logger: logger.child({ component: "job-linker-geocoder" })
    });
    const jobLinkerOsrmClient = createOsrmClient({
      logger: logger.child({ component: "job-linker-osrm" })
    });
    const prebookSheetsClient = env.prebookGoogleSheetsId
      ? createSheetsClient({
          spreadsheetId: env.prebookGoogleSheetsId,
          worksheetName: env.prebookWorksheetName,
          range: env.prebookWorksheetName,
          credentialsJson: env.googleCredentialsJson,
          credentialsPath: env.googleCredentialsPath,
          logger: logger.child({ component: "prebook-sheets" })
        })
      : null;
    const whatsappSourceSheetsClient = env.whatsappSourceGoogleSheetsId
      ? createSheetsClient({
          spreadsheetId: env.whatsappSourceGoogleSheetsId,
          worksheetName: env.whatsappSourceWorksheetNames[0] || "Saloon",
          range: env.whatsappSourceWorksheetNames[0] || "Saloon",
          credentialsJson: env.googleCredentialsJson,
          credentialsPath: env.googleCredentialsPath,
          logger: logger.child({ component: "whatsapp-source-sheets" })
        })
      : null;
    jobLinkerServiceRef = createJobLinkerService({
      repository: jobLinkerRepositoryRef,
      sheetsClient: prebookSheetsClient,
      prebookSpreadsheetId: env.prebookGoogleSheetsId,
      prebookWorksheetName: env.prebookWorksheetName,
      whatsappSheetsClient: whatsappSourceSheetsClient,
      whatsappSpreadsheetId: env.whatsappSourceGoogleSheetsId,
      whatsappWorksheetNames: env.whatsappSourceWorksheetNames,
      geocoder: jobLinkerGeocoder,
      osrmClient: jobLinkerOsrmClient,
      timeZone: env.appTimeZone,
      otsEnabled: env.jobLinkerOtsEnabled,
      otsProjectPath: env.otsProjectPath,
      otsFormattedRowsPath: env.otsFormattedRowsPath,
      otsGroupName: env.otsGroupName,
      otsSourceName: env.otsSourceName,
      logger: logger.child({ component: "job-linker" })
    });
    jobLinkerServiceRef.start(env.jobLinkerSyncMs);
  }

  serverRef = await startHttpServer({
    logger: logger.child({ component: "http-server" }),
    runtimeStatus,
    port: env.port,
    getDashboardContext: () => ({
      sheetsClient: sheetsClientRef,
      spreadsheetId: env.googleSheetsId,
      appendBidTrackerRow: appendBidTrackerRowRef,
      appendAuditLogRow: appendAuditLogRowRef,
      appendRideRow: appendRideRowRef,
      appendReviewRow: appendReviewRowRef,
      appendUpcomingJobIfEligible: appendUpcomingJobIfEligibleRef,
      appendFinalBidIfEligible: appendFinalBidAndBidTrackerIfEligibleRef,
      recommendationPoller: recommendationPollerRef,
      otsImportRunner: otsImportRunnerRef,
      autoBidRunner: autoBidRunnerRef,
      dedupe: dedupeRef,
      databaseRepository: databaseRepositoryRef,
      jobLinkerRepository: jobLinkerRepositoryRef,
      jobLinkerService: jobLinkerServiceRef,
      jobLinkerBidService: jobLinkerBidServiceRef,
      databasePrimaryEnabled: env.databasePrimaryEnabled && Boolean(databaseRepositoryRef),
      bidAiReviewer,
      dashboardAuthToken: env.dashboardAuthToken,
      dashboardDefaultActor: env.dashboardDefaultActor,
      getWhatsAppClient: () => clientRef,
      stopWhatsAppClient: async () => {
        const activeClient = clientRef;
        clientRef = null;
        if (activeClient && typeof activeClient.destroy === "function") {
          await Promise.race([
            activeClient.destroy(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("WhatsApp stop timed out")), 10000))
          ]);
        }
        const qrPath = runtimeStatus.getSnapshot().qrImagePath;
        if (qrPath) fs.rmSync(qrPath, { force: true });
        runtimeStatus.update("stopped", { qrAvailable: false, error: "" });
      },
      allowedGroups: env.allowedGroups,
      updateAllowedGroups: (groupIds) =>
        persistAllowedGroups({
          envFilePath: path.resolve(__dirname, "../.env"),
          groupIds
        }),
      system: {
        dashboardAuthEnabled: isDashboardAuthEnabled({ token: env.dashboardAuthToken }),
        whatsappState: runtimeStatus.getSnapshot().state,
        whatsappQrAvailable: runtimeStatus.getSnapshot().qrAvailable,
        whatsappLastError: runtimeStatus.getSnapshot().lastError,
        allowedGroups: env.allowedGroups,
        bidAiReviewEnabled: Boolean(bidAiReviewer.enabled),
        recommendationEngineReady: Boolean(recommendationPollerRef?.tick),
        otsImportRunnerReady: Boolean(otsImportRunnerRef?.tick),
        autoBidRunnerReady: Boolean(autoBidRunnerRef?.tick),
        calendarEnabled: env.calendarEnabled,
        calendarClientReady: Boolean(calendarClientRef),
        calendarIdConfigured: Boolean(env.googleCalendarId),
        autoBidEnabled: env.autoBidEnabled,
        autoBidMode: env.autoBidMode,
        otsBidSubmitConfigured: Boolean(env.otsBidSubmitScript && fs.existsSync(env.otsBidSubmitScript)),
        allowedAreaCodes: env.finalBidAllowedAreaCodes,
        areaMatchMode: env.finalBidAreaMatchMode,
        otsIntegrationEnabled: env.otsIntegrationEnabled,
        otsRunPipeline: env.otsRunPipeline,
        otsProjectConfigured: Boolean(env.otsProjectPath && fs.existsSync(env.otsProjectPath)),
        otsFormattedRowsPathConfigured: Boolean(env.otsFormattedRowsPath),
        otsFormattedRowsConfigured: Boolean(
          env.otsFormattedRowsPath && fs.existsSync(env.otsFormattedRowsPath)
        ),
        databaseConfigured: Boolean(databaseHealth.configured),
        databaseReady: Boolean(databaseHealth.ok),
        databaseLastError: databaseHealth.ok ? "" : databaseHealth.reason,
        databasePrimaryEnabled: env.databasePrimaryEnabled && Boolean(databaseRepositoryRef)
      },
      worksheetNames: {
        rides: env.googleRidesWorksheetName,
        needsReview: env.googleNeedsReviewWorksheetName,
        upcomingJobs: env.googleUpcomingJobsWorksheetName,
        finalBid: env.googleFinalBidWorksheetName,
        recommendations: RECOMMENDATION_WORKSHEET_NAME,
        drivers: env.googleDriversWorksheetName,
        vehicles: env.googleVehiclesWorksheetName,
        driverSchedule: env.googleDriverScheduleWorksheetName,
        vehicleSchedule: env.googleVehicleScheduleWorksheetName,
        linkedRides: env.googleLinkedRidesWorksheetName,
        bidTracker: env.googleBidTrackerWorksheetName,
        dispatchCriteria: env.googleDispatchCriteriaWorksheetName,
        auditLog: env.googleAuditLogWorksheetName
      }
    })
  });

  if (!env.whatsappClientId) {
    throw new Error("WHATSAPP_CLIENT_ID is required for stable LocalAuth persistence");
  }

  const sessionState = validateAndPrepareSessionStorage({
    sessionPath: env.whatsappSessionPath,
    clientId: env.whatsappClientId
  });

  logger.debug("WhatsApp session path resolved", {
    stage: "whatsapp_auth",
    reason: sessionState.sessionPath
  });

  logger.debug(
    sessionState.sessionFolderHasData
      ? "Saved session found before startup"
      : "No saved session found before startup",
    {
      stage: "whatsapp_auth",
      reason: sessionState.sessionFolderPath
    }
  );

  let activeMessageHandler = null;
  let resolvePipelineReady;
  let rejectPipelineReady;
  const pipelineReady = new Promise((resolve, reject) => {
    resolvePipelineReady = resolve;
    rejectPipelineReady = reject;
  });
  pipelineReady.catch(() => {});
  const gatedOnMessage = async (message) => {
    await pipelineReady;
    if (typeof activeMessageHandler !== "function") {
      throw new Error("Message pipeline is not ready");
    }
    return activeMessageHandler(message);
  };
  let client = null;

  logger.info("Waiting for WhatsApp login before starting downstream workflows", {
    stage: "whatsapp_auth",
    reason: "sheets/pollers/message-processing are gated until WhatsApp ready"
  });

  try {
    client = await initializeWhatsAppClient({
      sessionPath: sessionState.sessionPath,
      clientId: sessionState.clientId,
      startupTimeoutMs: env.whatsappStartupTimeoutMs,
      autoClearStaleSession: env.whatsappAutoClearStaleSession,
      persistedSessionDetected: sessionState.sessionFolderHasData,
      qrImagePath: runtimeStatus.getSnapshot().qrImagePath,
      onStateChange: (state, details = {}) => {
        runtimeStatus.update(state, details);
      },
      onClientCreated: (createdClient) => {
        clientRef = createdClient;
      },
      logger: logger.child({ component: "whatsapp-client" }),
      puppeteer: resolvePuppeteerOptions(),
      onMessage: gatedOnMessage
    });
    clientRef = client;
  } catch (error) {
    rejectPipelineReady(error);
    throw error;
  }

  logger.info("WhatsApp login confirmed; starting downstream workflows", {
    stage: "whatsapp_connect"
  });

  if (env.googleCredentialsJsonError) {
    const startupError = new Error(
      `Google credentials env parsing failed: ${env.googleCredentialsJsonError}`
    );
    startupError.code = "GOOGLE_CREDENTIALS_JSON_INVALID";
    throw startupError;
  }

  if (env.googleCredentialsSource === "env_json" && env.googleCredentialsJson) {
    logger.debug("Google credentials loaded from env", {
      stage: "sheets_startup",
      reason: "GOOGLE_CREDENTIALS_JSON"
    });
  }

  const startupSheetTargets = [
    {
      worksheetName: env.googleRidesWorksheetName,
      range: env.googleRidesRange
    },
    {
      worksheetName: env.googleNeedsReviewWorksheetName,
      range: env.googleNeedsReviewRange
    },
    {
      worksheetName: env.googleUpcomingJobsWorksheetName,
      range: env.googleUpcomingJobsRange
    },
    {
      worksheetName: env.googleFinalBidWorksheetName,
      range: env.googleFinalBidRange
    },
    {
      worksheetName: env.googleDriversWorksheetName,
      range: env.googleDriversRange
    },
    {
      worksheetName: env.googleVehiclesWorksheetName,
      range: env.googleVehiclesRange
    },
    {
      worksheetName: env.googleOperationsViewWorksheetName,
      range: env.googleOperationsViewRange
    }
  ];

  for (const target of startupSheetTargets) {
    const sheetsStartupValidation = validateSheetsConfig({
      spreadsheetId: env.googleSheetsId,
      worksheetName: target.worksheetName,
      range: target.range,
      credentialsJson: env.googleCredentialsJson,
      credentialsPath: env.googleCredentialsPath
    });
    if (!sheetsStartupValidation.valid) {
      const sheetsReason =
        sheetsStartupValidation.reason ||
        sheetsStartupValidation.credentialsStatus?.message ||
        sheetsStartupValidation.missing.join(", ");
      const startupError = new Error(
        `Google Sheets startup validation failed: ${sheetsReason}`
      );
      startupError.code = "SHEETS_STARTUP_CONFIG_MISSING";

      logger.error("Google Sheets startup validation failed", {
        stage: "sheets_startup",
        fallbackUsed: true,
        reason: `${target.worksheetName}: ${sheetsReason}`
      });
      throw startupError;
    }
  }

  logger.debug("Google Sheets startup validation passed", {
    stage: "sheets_startup",
    fallbackUsed: false,
    reason: `worksheets=${env.googleRidesWorksheetName},${env.googleNeedsReviewWorksheetName},${env.googleUpcomingJobsWorksheetName}`
  });

  const dedupe = new DedupeStore({
    ttlMs: env.dedupeTtlMs,
    maxEntries: env.dedupeMaxEntries,
    filePath: env.dedupeStorePath,
    logger: logger.child({ component: "dedupe" })
  });
  dedupeRef = dedupe;

  const localExtractor = createLocalExtractor({
    logger: logger.child({ component: "local-extractor" })
  });

  const openaiNormalizer = env.openaiExtractionEnabled && env.openaiApiKey
    ? createOpenAiNormalizer({
        apiKey: env.openaiApiKey,
        model: env.openaiModel,
        logger: logger.child({ component: "openai-normalizer" })
      })
    : null;

  const ocrExtractor = createTesseractOcr({
    tesseractPath: env.ocrTesseractPath,
    timeoutMs: env.ocrTimeoutMs,
    tempDir: env.ocrTempDir,
    logger: logger.child({ component: "ocr" })
  });

  const geocoder = createGeocoder({
    provider: env.geocodingProvider,
    apiKey: env.geocodingApiKey,
    baseUrl: env.geocodingBaseUrl,
    userAgent: env.geocodingUserAgent,
    timeoutMs: env.geocodingTimeoutMs,
    logger: logger.child({ component: "geocoder" })
  });

  const osrmClient = createOsrmClient({
    logger: logger.child({ component: "osrm" })
  });

  const sheetsClient = createSheetsClient({
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleRidesWorksheetName,
    range: env.googleRidesRange,
    credentialsJson: env.googleCredentialsJson,
    credentialsPath: env.googleCredentialsPath,
    logger: logger.child({ component: "sheets-client" })
  });
  sheetsClientRef = sheetsClient;

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleFinalBidWorksheetName,
    headers: FINAL_BID_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleDriversWorksheetName,
    headers: DRIVER_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleVehiclesWorksheetName,
    headers: VEHICLE_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleOperationsViewWorksheetName,
    headers: OPERATIONS_VIEW_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: RECOMMENDATION_WORKSHEET_NAME,
    headers: RECOMMENDATION_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleDriverScheduleWorksheetName,
    headers: DRIVER_SCHEDULE_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleVehicleScheduleWorksheetName,
    headers: VEHICLE_SCHEDULE_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleLinkedRidesWorksheetName,
    headers: LINKED_RIDES_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleBidTrackerWorksheetName,
    headers: BID_TRACKER_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleDispatchCriteriaWorksheetName,
    headers: DISPATCH_CRITERIA_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  await ensureWorksheetWithHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleAuditLogWorksheetName,
    headers: AUDIT_LOG_HEADERS,
    repairHeaders: true,
    logger: logger.child({ component: "sheets-startup" })
  });

  if (env.retentionCleanupEnabled) {
    await ensureWorksheetWithHeaders({
      sheetsClient,
      spreadsheetId: env.googleSheetsId,
      worksheetName: env.googleArchiveWorksheetName,
      headers: ARCHIVE_HEADERS,
      repairHeaders: true,
      logger: logger.child({ component: "sheets-startup" })
    });
  }

  await seedDispatchCriteriaIfEmpty({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleDispatchCriteriaWorksheetName,
    defaults: buildEnvCriteriaDefaults(env),
    logger: logger.child({ component: "sheets-startup" })
  });

  await applyTextFormatForHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleDriversWorksheetName,
    headerNames: ["Driver ID", "WhatsApp Number", "Vehicle ID"],
    logger: logger.child({ component: "sheets-startup" })
  });

  await applyTextFormatForHeaders({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleVehiclesWorksheetName,
    headerNames: ["Vehicle ID", "Registration", "Driver ID"],
    logger: logger.child({ component: "sheets-startup" })
  });

  await applyFinalBidAssignedDriverValidation({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    finalBidWorksheetName: env.googleFinalBidWorksheetName,
    driversWorksheetName: env.googleDriversWorksheetName,
    logger: logger.child({ component: "sheets-startup" })
  });

  await verifyWorksheetTargetsReady({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetTargets: [
      {
        worksheetName: env.googleRidesWorksheetName,
        expectedHeaders: STRICT_SHEET_HEADERS
      },
      {
        worksheetName: env.googleNeedsReviewWorksheetName,
        expectedHeaders: STRICT_SHEET_HEADERS
      },
      {
        worksheetName: env.googleUpcomingJobsWorksheetName,
        expectedHeaders: STRICT_SHEET_HEADERS
      },
      {
        worksheetName: env.googleFinalBidWorksheetName,
        expectedHeaders: FINAL_BID_HEADERS
      },
      {
        worksheetName: env.googleDriversWorksheetName,
        expectedHeaders: DRIVER_HEADERS
      },
      {
        worksheetName: env.googleVehiclesWorksheetName,
        expectedHeaders: VEHICLE_HEADERS
      },
      {
        worksheetName: env.googleOperationsViewWorksheetName,
        expectedHeaders: OPERATIONS_VIEW_HEADERS
      },
      {
        worksheetName: RECOMMENDATION_WORKSHEET_NAME,
        expectedHeaders: RECOMMENDATION_HEADERS
      },
      {
        worksheetName: env.googleDriverScheduleWorksheetName,
        expectedHeaders: DRIVER_SCHEDULE_HEADERS
      },
      {
        worksheetName: env.googleVehicleScheduleWorksheetName,
        expectedHeaders: VEHICLE_SCHEDULE_HEADERS
      },
      {
        worksheetName: env.googleLinkedRidesWorksheetName,
        expectedHeaders: LINKED_RIDES_HEADERS
      },
      {
        worksheetName: env.googleBidTrackerWorksheetName,
        expectedHeaders: BID_TRACKER_HEADERS
      },
      {
        worksheetName: env.googleDispatchCriteriaWorksheetName,
        expectedHeaders: DISPATCH_CRITERIA_HEADERS
      },
      {
        worksheetName: env.googleAuditLogWorksheetName,
        expectedHeaders: AUDIT_LOG_HEADERS
      },
      ...(env.retentionCleanupEnabled
        ? [
            {
              worksheetName: env.googleArchiveWorksheetName,
              expectedHeaders: ARCHIVE_HEADERS
            }
          ]
        : [])
    ],
    logger: logger.child({ component: "sheets-startup" })
  });

  const availableDrivers = await loadAvailableDrivers({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleDriversWorksheetName,
    logger: logger.child({ component: "drivers" })
  });

  logger.debug("Available drivers loaded", {
    stage: "driver_management",
    fallbackUsed: false,
    reason: `count=${availableDrivers.length}`
  });

  const calendarClient = env.calendarEnabled
    ? await createCalendarClient({
        calendarId: env.googleCalendarId,
        credentialsJson: env.googleCredentialsJson,
        credentialsPath: env.googleCredentialsPath,
        logger: logger.child({ component: "calendar-client" })
      })
    : null;
  calendarClientRef = calendarClient;

  if (env.calendarEnabled && calendarClient) {
    approvalPollerRef = startFinalBidApprovalPolling({
      sheetsClient,
      calendarClient,
      spreadsheetId: env.googleSheetsId,
      worksheetName: env.googleFinalBidWorksheetName,
      driversWorksheetName: env.googleDriversWorksheetName,
      calendarId: env.googleCalendarId,
      timeZone: env.appTimeZone,
      durationMinutes: env.calendarEventDurationMinutes,
      companyCode: env.calendarCompanyCode,
      intervalMs: env.calendarApprovalPollMs,
      logger: logger.child({ component: "calendar-approval" })
    });

    logger.debug("Final Bid approval polling started", {
      stage: "calendar_approval",
      fallbackUsed: false,
      reason: `interval=${env.calendarApprovalPollMs}ms calendar=${env.googleCalendarId}`
    });
  } else if (env.calendarEnabled) {
    logger.warn("Final Bid approval polling disabled because Calendar client is unavailable", {
      stage: "calendar_approval",
      fallbackUsed: true,
      reason: env.googleCalendarId || "calendar_id_missing"
    });
  } else {
    logger.warn("Final Bid approval polling disabled by config", {
      stage: "calendar_approval",
      fallbackUsed: true
    });
  }

  recommendationPollerRef = startRecommendationPolling({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    finalBidWorksheetName: env.googleFinalBidWorksheetName,
    recommendationsWorksheetName: RECOMMENDATION_WORKSHEET_NAME,
    driverScheduleWorksheetName: env.googleDriverScheduleWorksheetName,
    vehicleScheduleWorksheetName: env.googleVehicleScheduleWorksheetName,
    linkedRidesWorksheetName: env.googleLinkedRidesWorksheetName,
    bidTrackerWorksheetName: env.googleBidTrackerWorksheetName,
    driversWorksheetName: env.googleDriversWorksheetName,
    vehiclesWorksheetName: env.googleVehiclesWorksheetName,
    intervalMs: env.recommendationPollMs || 60000,
    timeZone: env.appTimeZone,
    durationMinutes: env.calendarEventDurationMinutes,
    minGapMinutes: 15,
    databaseRepository: databaseRepositoryRef,
    logger: logger.child({ component: "recommendation-engine" }),
  });

  logger.debug("Driver recommendation polling started", {
    stage: "recommendations",
    fallbackUsed: false,
    reason: `interval=${env.recommendationPollMs || 60000}ms`,
  });

  operationsPollerRef = startOperationsViewPolling({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    finalBidWorksheetName: env.googleFinalBidWorksheetName,
    operationsWorksheetName: env.googleOperationsViewWorksheetName,
    intervalMs: env.operationsViewRefreshMs,
    logger: logger.child({ component: "operations-view" })
  });

  logger.debug("Operations View refresh polling started", {
    stage: "operations_view",
    fallbackUsed: false,
    reason: `interval=${env.operationsViewRefreshMs}ms sheet=${env.googleOperationsViewWorksheetName}`
  });

  async function runSheetsBackup(label, fn, meta = {}) {
    if (!env.databasePrimaryEnabled || env.databaseSheetsBackupEnabled) {
      try {
        return await fn();
      } catch (error) {
        if (!env.databasePrimaryEnabled) throw error;
        logger.warn(`${label} backup failed`, {
          stage: "database_backup",
          fallbackUsed: true,
          reason: error?.message || "sheets_backup_failed",
          ...meta,
          error
        });
        return { skipped: true, reason: "sheets_backup_failed" };
      }
    }
    return { skipped: true, reason: "sheets_backup_disabled" };
  }

  const appendRideRowToSheets = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleRidesWorksheetName,
    range: env.googleRidesRange,
    logger: logger.child({ component: "sheets-append-rides" })
  });

  const appendRideRow = async (ride) => {
    if (env.databasePrimaryEnabled && databaseRepositoryRef) {
      await databaseRepositoryRef.upsertRide(ride, {
        status: "New",
        retentionClass: "operational"
      });
      logger.info("Ride saved to database", {
        stage: "database",
        refer: ride?.refer || ride?.Refer,
        fallbackUsed: false
      });
    }

    return runSheetsBackup(
      "Rides sheet",
      () => appendRideRowToSheets(ride),
      { refer: ride?.refer || ride?.Refer }
    );
  };
  appendRideRowRef = appendRideRow;

  const appendReviewRowToSheets = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleNeedsReviewWorksheetName,
    range: env.googleNeedsReviewRange,
    logger: logger.child({ component: "sheets-append-review" })
  });

  const appendReviewRow = async (ride) => {
    if (env.databasePrimaryEnabled && databaseRepositoryRef) {
      await databaseRepositoryRef.markNeedsReview(
        ride,
        ride?.payment_status || ride?.["Payment Status"] || "Needs operator review"
      );
      logger.info("Needs Review ride saved to database", {
        stage: "database",
        refer: ride?.refer || ride?.Refer,
        fallbackUsed: false
      });
    }

    return runSheetsBackup(
      "Needs Review sheet",
      () => appendReviewRowToSheets(ride),
      { refer: ride?.refer || ride?.Refer }
    );
  };
  appendReviewRowRef = appendReviewRow;

  const appendUpcomingRow = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleUpcomingJobsWorksheetName,
    range: env.googleUpcomingJobsRange,
    logger: logger.child({ component: "sheets-append-upcoming" })
  });

  const appendFinalBidRowToSheets = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleFinalBidWorksheetName,
    range: env.googleFinalBidRange,
    rowBuilder: buildFinalBidSheetRow,
    logger: logger.child({ component: "sheets-append-final-bid" })
  });

  const appendFinalBidRow = async (row) => {
    if (env.databasePrimaryEnabled && databaseRepositoryRef) {
      await databaseRepositoryRef.markFinalBid(row);
      logger.info("Final Bid saved to database", {
        stage: "database",
        refer: row?.Refer || row?.refer,
        fallbackUsed: false
      });
    }

    return runSheetsBackup(
      "Final Bid sheet",
      () => appendFinalBidRowToSheets(row),
      { refer: row?.Refer || row?.refer }
    );
  };

  const appendBidTrackerRow = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleBidTrackerWorksheetName,
    range: env.googleBidTrackerRange,
    rowBuilder: buildBidTrackerSheetRow,
    logger: logger.child({ component: "sheets-append-bid-tracker" })
  });
  appendBidTrackerRowRef = appendBidTrackerRow;

  const appendAuditLogRow = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleAuditLogWorksheetName,
    range: env.googleAuditLogRange,
    rowBuilder: buildAuditLogSheetRow,
    logger: logger.child({ component: "sheets-append-audit-log" })
  });
  appendAuditLogRowRef = appendAuditLogRow;

  let dispatchCriteriaCache = null;
  let dispatchCriteriaCacheAt = 0;
  async function resolveDynamicFinalBidConfig() {
    const now = Date.now();
    if (dispatchCriteriaCache && now - dispatchCriteriaCacheAt < 30 * 1000) {
      return dispatchCriteriaCache;
    }

    try {
      const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: env.googleSheetsId,
        range: `${quoteWorksheetNameForRange(env.googleDispatchCriteriaWorksheetName)}!A:D`,
        majorDimension: "ROWS"
      });
      const values = Array.isArray(response?.data?.values) ? response.data.values : [];
      const headers = (values[0] || []).map((header) => safeString(header));
      const records = values.slice(1).map((row) => {
        const record = {};
        headers.forEach((header, index) => {
          if (header) record[header] = safeString(row?.[index]);
        });
        return record;
      });
      const criteria = mapCriteriaRows(records);
      const resolved = resolveCriteriaConfig(criteria, env);
      dispatchCriteriaCache = {
        ...configBaseFinalBid(env),
        minFare: resolved.minFare,
        allowedVehicles: resolved.allowedVehicles,
        excludedVehicles: resolved.excludedVehicles,
        allowedAreaCodes: resolved.allowedAreaCodes,
        areaMatchMode: resolved.areaMatchMode
      };
      dispatchCriteriaCacheAt = now;
      return dispatchCriteriaCache;
    } catch (error) {
      logger.warn("Dispatch criteria load failed; using env defaults", {
        stage: "dispatch_criteria",
        fallbackUsed: true,
        reason: error?.message || "criteria_load_failed",
        error
      });
      dispatchCriteriaCache = configBaseFinalBid(env);
      dispatchCriteriaCacheAt = now;
      return dispatchCriteriaCache;
    }
  }

  const appendUpcomingJobIfEligible = createUpcomingJobAppender({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleUpcomingJobsWorksheetName,
    range: env.googleUpcomingJobsRange,
    appendRow: appendUpcomingRow,
    logger: logger.child({ component: "upcoming-jobs" }),
    timeZone: env.appTimeZone
  });
  appendUpcomingJobIfEligibleRef = appendUpcomingJobIfEligible;

  const appendFinalBidIfEligible = createFinalBidAppender({
    appendRow: appendFinalBidRow,
    config: configBaseFinalBid(env),
    configProvider: resolveDynamicFinalBidConfig,
    logger: logger.child({ component: "final-bid" })
  });

  const appendFinalBidAndBidTrackerIfEligible = async (ride) => {
    const result = await appendFinalBidIfEligible(ride);
    if (result?.appended) {
      try {
        const bidRide = result.payload || ride;
        const bidSourceText = `${safeString(bidRide?.["Group Name"] || bidRide?.group_name)} ${safeString(bidRide?.["Source Name"] || bidRide?.source_name)}`.toLowerCase();
        const bidTrackerRow = buildBidTrackerRowObject({
          ride: bidRide,
          bidType: bidSourceText.includes("ots") ? "OTS Bid Review" : "Manual Bid Review",
          pricing: calculateBidPricing(bidRide),
          reason: ""
        });
        if (env.databasePrimaryEnabled && databaseRepositoryRef?.upsertBid) {
          await databaseRepositoryRef.upsertBid(bidTrackerRow);
        }
        await runSheetsBackup(
          "Bid Tracker sheet",
          () => appendBidTrackerRow(bidTrackerRow),
          { refer: bidTrackerRow["Ride ID"] }
        );
        logger.info("Bid review suggested", {
          stage: "bid_tracker",
          refer: ride?.refer || ride?.Refer,
          reason: bidTrackerRow["AI Decision"] || "bid_pricing_created"
        });
      } catch (error) {
        const summary = summarizeKnownError(error, {
          stage: "bid_tracker",
          defaultSummary: "Bid review suggestion failed",
          fallbackUsed: true
        });
        logger.warn(summary.summary, {
          stage: "bid_tracker",
          refer: ride?.refer || ride?.Refer,
          fallbackUsed: true,
          reason: summary.likelyCause || "Bid Tracker append failed",
          error
        });
      }
    }
    return result;
  };
  appendFinalBidAndBidTrackerIfEligibleRef = appendFinalBidAndBidTrackerIfEligible;

  activeMessageHandler = createMessageHandler({
    env,
    logger: logger.child({ component: "message-handler" }),
    dedupe,
    localExtractor,
    openaiNormalizer,
    ocrExtractor,
    geocoder,
    osrmClient,
    appendRideRow,
    appendReviewRow,
    appendUpcomingJobIfEligible,
    appendFinalBidIfEligible: appendFinalBidAndBidTrackerIfEligible
  });
  resolvePipelineReady();

  const otsImportOptions = {
    projectPath: env.otsProjectPath,
    formattedRowsPath: env.otsFormattedRowsPath,
    runPipeline: env.otsRunPipeline,
    dispatchManagedPipeline: true,
    pipelineEnv: { DISPATCH_MANAGED_PIPELINE: "true" },
    intervalMs: env.otsPollMs,
    groupName: env.otsGroupName,
    sourceName: env.otsSourceName,
    dedupe,
    appendRideRow,
    appendReviewRow,
    appendFinalBidIfEligible: appendFinalBidAndBidTrackerIfEligible,
    appendUpcomingJobIfEligible,
    logger: logger.child({ component: "ots-integration" })
  };
  otsImportRunnerRef = createOtsImportRunner(otsImportOptions);
  if (env.otsIntegrationEnabled && !env.jobLinkerOtsEnabled) {
    otsIntegrationPollerRef = startOtsIntegrationPolling({
      ...otsImportOptions,
      runner: otsImportRunnerRef
    });
  } else {
    logger.debug("OTS integration disabled", {
      stage: "ots_import",
      reason: "OTS_INTEGRATION_ENABLED=false"
    });
  }

  const submitBid =
    env.autoBidMode === "live"
      ? createOtsWorkerSubmitter({
          scriptPath: env.otsBidSubmitScript,
          projectPath: env.otsProjectPath,
          timeoutMs: env.otsBidSubmitTimeoutMs,
          env: { OTS_BID_MODE: env.autoBidMode }
        })
      : undefined;
  autoBidRunnerRef = createAutoBidRunner({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    bidTrackerWorksheetName: env.googleBidTrackerWorksheetName,
    intervalMs: env.autoBidPollMs,
    mode: env.autoBidMode,
    submitBid,
    databaseRepository: databaseRepositoryRef,
    logger: logger.child({ component: "auto-bid" })
  });
  if (env.autoBidEnabled) {
    autoBidPollerRef = startAutoBidPolling({
      sheetsClient,
      spreadsheetId: env.googleSheetsId,
      bidTrackerWorksheetName: env.googleBidTrackerWorksheetName,
      intervalMs: env.autoBidPollMs,
      mode: env.autoBidMode,
      submitBid,
      databaseRepository: databaseRepositoryRef,
      runner: autoBidRunnerRef,
      logger: logger.child({ component: "auto-bid" })
    });
  } else {
    logger.debug("Auto bid polling disabled", {
      stage: "auto_bid",
      reason: "AUTO_BID_ENABLED=false"
    });
  }

  if (env.retentionCleanupEnabled) {
    retentionCleanupPollerRef = startRetentionCleanupPolling({
      sheetsClient,
      spreadsheetId: env.googleSheetsId,
      archiveWorksheetName: env.googleArchiveWorksheetName,
      targets: buildDefaultRetentionTargets(env),
      intervalMs: env.retentionCleanupPollMs,
      timeZone: env.appTimeZone,
      logger: logger.child({ component: "retention-cleanup" })
    });
  } else {
    logger.debug("Retention cleanup disabled", {
      stage: "retention_cleanup",
      reason: "RETENTION_CLEANUP_ENABLED=false"
    });
  }

  if (env.databaseRetentionEnabled && databaseHealth.ok) {
    databaseRetentionPollerRef = startDatabaseRetentionPolling({
      databaseUrl: env.databaseUrl,
      intervalMs: env.databaseRetentionPollMs,
      logger: logger.child({ component: "database-retention" })
    });
  } else if (env.databaseRetentionEnabled) {
    logger.warn("Database retention cleanup disabled because Supabase is not connected", {
      stage: "database_retention",
      fallbackUsed: true,
      reason: databaseHealth.reason || "database_not_ready"
    });
  } else {
    logger.debug("Database retention cleanup disabled", {
      stage: "database_retention",
      reason: "DATABASE_RETENTION_ENABLED=false"
    });
  }

  logger.debug("Message processing pipeline ready", {
    stage: "startup",
    reason: "WhatsApp ready + downstream workflows configured"
  });

  const bootSummary = {
    allowedGroups: env.allowedGroups,
    whatsappClientId: env.whatsappClientId,
    sessionDir: sessionState.sessionPath,
    worksheetName: env.googleRidesWorksheetName,
    needsReviewWorksheetName: env.googleNeedsReviewWorksheetName,
    upcomingJobsWorksheetName: env.googleUpcomingJobsWorksheetName,
    finalBidWorksheetName: env.googleFinalBidWorksheetName,
    driverScheduleWorksheetName: env.googleDriverScheduleWorksheetName,
    vehicleScheduleWorksheetName: env.googleVehicleScheduleWorksheetName,
    linkedRidesWorksheetName: env.googleLinkedRidesWorksheetName,
    driversWorksheetName: env.googleDriversWorksheetName,
    vehiclesWorksheetName: env.googleVehiclesWorksheetName,
    operationsViewWorksheetName: env.googleOperationsViewWorksheetName,
    geocodingProvider: env.geocodingProvider || "",
    sheetsConfigured: Boolean(sheetsClient && env.googleSheetsId),
    googleCredentialsSource: env.googleCredentialsSource,
    googleCredentialsPath:
      env.googleCredentialsSource === "file_path" ? env.googleCredentialsPath : "",
    openaiConfigured: Boolean(env.openaiExtractionEnabled && env.openaiApiKey),
    openaiEnabled: Boolean(env.openaiExtractionEnabled),
    otsIntegrationEnabled: Boolean(env.otsIntegrationEnabled),
    otsProjectPath: env.otsIntegrationEnabled ? env.otsProjectPath : "",
    otsFormattedRowsPath: env.otsIntegrationEnabled ? env.otsFormattedRowsPath : "",
    dedupePersistence: env.dedupeStorePath
  };

  logger.debug("Startup summary", {
    stage: "startup",
      reason: `allowedGroups=${bootSummary.allowedGroups.length}, clientId=${bootSummary.whatsappClientId}, sessionDir=${bootSummary.sessionDir}, geocoder=${bootSummary.geocodingProvider}, sheetsConfigured=${bootSummary.sheetsConfigured}, sheetsCredentials=${bootSummary.googleCredentialsSource || "unknown"}, openaiConfigured=${bootSummary.openaiConfigured}, otsIntegration=${bootSummary.otsIntegrationEnabled}, ridesSheet=${bootSummary.worksheetName}, reviewSheet=${bootSummary.needsReviewWorksheetName}, upcomingSheet=${bootSummary.upcomingJobsWorksheetName}, finalBidSheet=${bootSummary.finalBidWorksheetName}, driverScheduleSheet=${bootSummary.driverScheduleWorksheetName}, vehicleScheduleSheet=${bootSummary.vehicleScheduleWorksheetName}, linkedRidesSheet=${bootSummary.linkedRidesWorksheetName}, bidTrackerSheet=${bootSummary.bidTrackerWorksheetName}, driversSheet=${bootSummary.driversWorksheetName}, vehiclesSheet=${bootSummary.vehiclesWorksheetName}, operationsViewSheet=${bootSummary.operationsViewWorksheetName}`
  });
  logger.debug("Startup details", {
    stage: "startup",
    ...bootSummary
  });

  if (env.allowedGroups.length === 0) {
    logger.warn("No allowed groups configured; messages will be ignored", {
      stage: "startup",
      fallbackUsed: true
    });
  }

  if (env.openaiExtractionEnabled && !bootSummary.openaiConfigured) {
    logger.warn("OpenAI key missing; local extraction only", {
      stage: "openai_normalization",
      fallbackUsed: true
    });
  }

  if (!bootSummary.sheetsConfigured) {
    logger.warn("Google Sheets not fully configured; row append will fail", {
      stage: "sheets_append",
      fallbackUsed: false
    });
  }

  return { client, server: serverRef };
}

function formatStartupError(error) {
  if (error instanceof Error) {
    return {
      message: String(error.message || error.name || "Unknown startup error"),
      code: error.code ? String(error.code) : "",
      stack: typeof error.stack === "string" ? error.stack : ""
    };
  }

  if (error && typeof error === "object") {
    const candidateMessage = error.message || error.reason || error.error;
    const candidateStack = error.stack;

    return {
      message: candidateMessage ? String(candidateMessage) : String(error),
      code: error.code ? String(error.code) : "",
      stack: typeof candidateStack === "string" ? candidateStack : ""
    };
  }

  return {
    message: String(error || "Unknown startup error"),
    code: "",
    stack: ""
  };
}

if (require.main === module) {
  bootstrap().catch((error) => {
    const summary = summarizeKnownError(error, {
      stage: "startup",
      defaultSummary: "Service failed to start"
    });
    const details = formatStartupError(error);

    console.error("Startup failed. Service is shutting down.");
    console.error(`Reason: ${details.message || summary.summary}`);

    if (details.code) {
      console.error(`Code: ${details.code}`);
    }

    if (summary.likelyCause) {
      console.error(`Hint: ${summary.likelyCause}`);
    }

    if (env.nodeEnv === "development" && details.stack) {
      console.error("Stack trace:");
      console.error(details.stack);
    }

    process.exit(1);
  });
}

module.exports = {
  bootstrap,
  verifyWorksheetTargetsReady,
  ensureWorksheetWithHeaders,
  applyFinalBidAssignedDriverValidation,
  applyTextFormatForHeaders
};
