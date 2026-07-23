const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { env } = require("./config/env");
const { createLogger, summarizeKnownError } = require("./utils/logger");
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
const { createCalendarClient } = require("./calendar/client");
const { startFinalBidApprovalPolling } = require("./calendar/approvalWorkflow");
const { DRIVER_HEADERS, VEHICLE_HEADERS, loadAvailableDrivers } = require("./drivers/management");
const { startRecommendationPolling } = require("./polling");
const { RECOMMENDATION_HEADERS, RECOMMENDATION_WORKSHEET_NAME } = require("./engine");
const { OPERATIONS_VIEW_HEADERS, startOperationsViewPolling } = require("./operations/view");
const { createMessageHandler } = require("./whatsapp/messageHandler");
const { initializeWhatsAppClient } = require("./whatsapp/client");
const { validateAndPrepareSessionStorage } = require("./whatsapp/session");

const RAILWAY_PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--single-process"
];

function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeWorksheetTitle(value) {
  return safeString(value).toLowerCase();
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

function startHttpServer({ logger, runtimeStatus, port }) {
  const app = express();

  app.get("/health", (_request, response) => {
    const status = runtimeStatus.getSnapshot();
    response.json({
      ok: true,
      state: status.state
    });
  });

  app.get("/qr.png", (_request, response) => {
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

  app.get("/qr", (_request, response) => {
    const status = runtimeStatus.getSnapshot();
    response.setHeader("Cache-Control", "no-store");
    response.type("html").send(renderQrPage(status));
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info("QR route available", {
        stage: "http_server",
        reason: `port=${port} /health /qr /qr.png`
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

  const response = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title))"
  });
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
    const headerResponse = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `'${worksheetName.replace(/'/g, "''")}'!1:1`
    });
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

  logger.info("Google Sheets worksheet targets verified", {
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

  const response = await sheetsClient.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(title))"
  });
  const existingTitles = new Set(
    (Array.isArray(response?.data?.sheets) ? response.data.sheets : [])
      .map((sheet) => safeString(sheet?.properties?.title))
      .filter(Boolean)
      .map((title) => normalizeWorksheetTitle(title))
  );

  if (!existingTitles.has(normalizeWorksheetTitle(worksheetName))) {
    try {
      await sheetsClient.spreadsheets.batchUpdate({
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
      });

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

      logger.info("Google Sheets worksheet already exists", {
        stage: "sheets_startup",
        fallbackUsed: false,
        reason: worksheetName
      });
    }
  }

  const headerResponse = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: buildHeaderRange(worksheetName),
    majorDimension: "ROWS"
  });
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
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: buildHeaderRange(worksheetName),
      valueInputOption: "RAW",
      requestBody: {
        values: [expectedHeaders]
      }
    });

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

  logger.info("Final Bid Assigned Driver validation configured", {
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

  logger.info("Google Sheets text formatting configured", {
    stage: "sheets_startup",
    fallbackUsed: false,
    reason: `${sheetProperties.title}: ${requests.length} columns`
  });
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
  let approvalPollerRef = null;
  let operationsPollerRef = null;
  let recommendationPollerRef = null;
  const runtimeStatus = createBotRuntimeStatus();
  registerShutdownHooks({
    logger,
    getClient: () => clientRef,
    getDedupe: () => dedupeRef,
    getServer: () => serverRef,
    getApprovalPoller: () => approvalPollerRef,
    getOperationsPoller: () => operationsPollerRef,
    getRecommendationPoller: () => recommendationPollerRef,
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

  serverRef = await startHttpServer({
    logger: logger.child({ component: "http-server" }),
    runtimeStatus,
    port: env.port
  });

  if (!env.whatsappClientId) {
    throw new Error("WHATSAPP_CLIENT_ID is required for stable LocalAuth persistence");
  }

  const sessionState = validateAndPrepareSessionStorage({
    sessionPath: env.whatsappSessionPath,
    clientId: env.whatsappClientId
  });

  logger.info("WhatsApp session path resolved", {
    stage: "whatsapp_auth",
    reason: sessionState.sessionPath
  });

  logger.info(
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
      persistedSessionDetected: sessionState.sessionFolderHasData,
      qrImagePath: runtimeStatus.getSnapshot().qrImagePath,
      onStateChange: (state, details = {}) => {
        runtimeStatus.update(state, details);
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
    logger.info("Google credentials loaded from env", {
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

  logger.info("Google Sheets startup validation passed", {
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

  const openaiNormalizer = createOpenAiNormalizer({
    apiKey: env.openaiApiKey,
    model: env.openaiModel,
    logger: logger.child({ component: "openai-normalizer" })
  });

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
    headerNames: ["Vehicle ID", "Registration Number", "Driver ID"],
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
      }
    ],
    logger: logger.child({ component: "sheets-startup" })
  });

  const availableDrivers = await loadAvailableDrivers({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleDriversWorksheetName,
    logger: logger.child({ component: "drivers" })
  });

  logger.info("Available drivers loaded", {
    stage: "driver_management",
    fallbackUsed: false,
    reason: `count=${availableDrivers.length}`
  });

  const calendarClient = env.calendarEnabled
    ? createCalendarClient({
        calendarId: env.googleCalendarId,
        credentialsJson: env.googleCredentialsJson,
        credentialsPath: env.googleCredentialsPath,
        logger: logger.child({ component: "calendar-client" })
      })
    : null;

  if (env.calendarEnabled && calendarClient) {
    approvalPollerRef = startFinalBidApprovalPolling({
      sheetsClient,
      calendarClient,
      spreadsheetId: env.googleSheetsId,
      worksheetName: env.googleFinalBidWorksheetName,
      calendarId: env.googleCalendarId,
      timeZone: env.appTimeZone,
      durationMinutes: env.calendarEventDurationMinutes,
      intervalMs: env.calendarApprovalPollMs,
      logger: logger.child({ component: "calendar-approval" })
    });

    logger.info("Final Bid approval polling started", {
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
    driversWorksheetName: env.googleDriversWorksheetName,
    vehiclesWorksheetName: env.googleVehiclesWorksheetName,
    intervalMs: env.recommendationPollMs || 60000,
    logger: logger.child({ component: "recommendation-engine" }),
  });

  logger.info("Driver recommendation polling started", {
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

  logger.info("Operations View refresh polling started", {
    stage: "operations_view",
    fallbackUsed: false,
    reason: `interval=${env.operationsViewRefreshMs}ms sheet=${env.googleOperationsViewWorksheetName}`
  });

  const appendRideRow = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleRidesWorksheetName,
    range: env.googleRidesRange,
    logger: logger.child({ component: "sheets-append-rides" })
  });

  const appendReviewRow = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleNeedsReviewWorksheetName,
    range: env.googleNeedsReviewRange,
    logger: logger.child({ component: "sheets-append-review" })
  });

  const appendUpcomingRow = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleUpcomingJobsWorksheetName,
    range: env.googleUpcomingJobsRange,
    logger: logger.child({ component: "sheets-append-upcoming" })
  });

  const appendFinalBidRow = createAppendRow({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleFinalBidWorksheetName,
    range: env.googleFinalBidRange,
    rowBuilder: buildFinalBidSheetRow,
    logger: logger.child({ component: "sheets-append-final-bid" })
  });

  const appendUpcomingJobIfEligible = createUpcomingJobAppender({
    sheetsClient,
    spreadsheetId: env.googleSheetsId,
    worksheetName: env.googleUpcomingJobsWorksheetName,
    range: env.googleUpcomingJobsRange,
    appendRow: appendUpcomingRow,
    logger: logger.child({ component: "upcoming-jobs" }),
    timeZone: env.appTimeZone
  });

  const appendFinalBidIfEligible = createFinalBidAppender({
    appendRow: appendFinalBidRow,
    config: {
      enabled: env.finalBidEnabled,
      minFare: env.finalBidMinFare,
      minDistance: env.finalBidMinDistance,
      maxDistance: env.finalBidMaxDistance,
      minScore: env.finalBidMinScore,
      allowedVehicles: env.finalBidAllowedVehicles,
      excludedVehicles: env.finalBidExcludedVehicles,
      allowedGroups: env.finalBidAllowedGroups,
      requireFare: env.finalBidRequireFare,
      requireDistance: env.finalBidRequireDistance
    },
    logger: logger.child({ component: "final-bid" })
  });

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
    appendFinalBidIfEligible
  });
  resolvePipelineReady();

  logger.info("Message processing pipeline ready", {
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
    driversWorksheetName: env.googleDriversWorksheetName,
    vehiclesWorksheetName: env.googleVehiclesWorksheetName,
    operationsViewWorksheetName: env.googleOperationsViewWorksheetName,
    geocodingProvider: env.geocodingProvider || "",
    sheetsConfigured: Boolean(sheetsClient && env.googleSheetsId),
    googleCredentialsSource: env.googleCredentialsSource,
    googleCredentialsPath:
      env.googleCredentialsSource === "file_path" ? env.googleCredentialsPath : "",
    openaiConfigured: Boolean(env.openaiApiKey),
    dedupePersistence: env.dedupeStorePath
  };

  logger.info("Startup summary", {
    stage: "startup",
      reason: `allowedGroups=${bootSummary.allowedGroups.length}, clientId=${bootSummary.whatsappClientId}, sessionDir=${bootSummary.sessionDir}, geocoder=${bootSummary.geocodingProvider}, sheetsConfigured=${bootSummary.sheetsConfigured}, sheetsCredentials=${bootSummary.googleCredentialsSource || "unknown"}, openaiConfigured=${bootSummary.openaiConfigured}, ridesSheet=${bootSummary.worksheetName}, reviewSheet=${bootSummary.needsReviewWorksheetName}, upcomingSheet=${bootSummary.upcomingJobsWorksheetName}, finalBidSheet=${bootSummary.finalBidWorksheetName}, driversSheet=${bootSummary.driversWorksheetName}, vehiclesSheet=${bootSummary.vehiclesWorksheetName}, operationsViewSheet=${bootSummary.operationsViewWorksheetName}`
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

  if (!bootSummary.openaiConfigured) {
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
