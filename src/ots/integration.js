const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createEmptyRideObject } = require("../extraction/schemas");
const { summarizeKnownError } = require("../utils/logger");
const { safeTrim } = require("../utils/text");

const DEFAULT_SOURCE_NAME = "OTS Supplier Portal";
const DEFAULT_GROUP_NAME = "OTS";
const REQUIRED_FIELDS = Object.freeze([
  "refer",
  "pickup_day_date",
  "starting_timing",
  "pickup",
  "drop_off"
]);

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function pickFirst(source = {}, keys = [], fallback = "") {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = toCell(source[key]);
      if (value) return value;
    }
  }
  return fallback;
}

function normalizeNumberText(value) {
  const text = toCell(value).replace(/,/g, "");
  if (!text) return "";
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : text;
}

function parseOtsExpiry(row = {}) {
  const direct = pickFirst(row, ["expires_utc_iso", "expiresUtcIso", "offer_expires_at"]);
  if (direct) {
    const parsed = new Date(direct);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const value = pickFirst(row, ["expires_text", "expiresText", "Expires"]);
  const match = value.match(/(?:expires\s+on\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\s*,?\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = String(match[3] || "").toLowerCase();
  if (hour <= 12 && meridiem === "pm" && hour !== 12) hour += 12;
  if (hour <= 12 && meridiem === "am" && hour === 12) hour = 0;
  const parsed = new Date(`${match[4]} ${match[5]} ${match[6]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00 ${/BST/i.test(value) ? "GMT+0100" : "GMT+0000"}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapOtsRowToRide(row = {}, options = {}) {
  const ride = createEmptyRideObject({
    refer: pickFirst(row, ["refer", "Refer", "reference", "Reference"]),
    group_name: options.groupName || DEFAULT_GROUP_NAME,
    source_name: options.sourceName || DEFAULT_SOURCE_NAME,
    source_time: options.sourceTime || new Date().toISOString(),
    pickup_day_date: pickFirst(row, [
      "pickup_day_date",
      "day_date",
      "Day & Date",
      "Pickup Day & Date"
    ]),
    starting_timing: pickFirst(row, [
      "starting_timing",
      "start_time",
      "Starting",
      "Starting Timing"
    ]),
    pickup: pickFirst(row, ["pickup", "Pickup"]),
    drop_off: pickFirst(row, ["drop_off", "dropOff", "Drop Off"]),
    distance: normalizeNumberText(
      pickFirst(row, ["distance", "distance_miles", "Distance"])
    ),
    fare: normalizeNumberText(pickFirst(row, ["fare", "est_fare", "Fare"])),
    required_vehicle: pickFirst(row, [
      "required_vehicle",
      "requiredVehicle",
      "Required Vehicle"
    ]),
    payment_status: pickFirst(row, ["payment_status", "Payment Status"], "OTS")
  });
  ride.source_expires_at = parseOtsExpiry(row);
  return ride;
}

function getMissingRequiredFields(ride = {}) {
  return REQUIRED_FIELDS.filter((field) => !safeTrim(ride[field]));
}

function buildOtsDedupeKey(ride = {}, row = {}) {
  const refer = safeTrim(ride.refer || row.refer || row.Refer);
  if (refer) return `ots:${refer}`;

  return [
    "ots",
    safeTrim(ride.pickup_day_date),
    safeTrim(ride.starting_timing),
    safeTrim(ride.pickup),
    safeTrim(ride.drop_off)
  ].join(":");
}

function loadFormattedRows(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!fs.existsSync(resolved)) {
    throw new Error(`OTS formatted rows file not found: ${resolved}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`OTS formatted rows must be a JSON array: ${resolved}`);
  }

  return parsed;
}

async function importOtsRows(rows = [], options = {}) {
  const logger = options.logger || {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
  const dedupe = options.dedupe;
  const appendRideRow = options.appendRideRow;
  const appendReviewRow = options.appendReviewRow;
  const appendFinalBidIfEligible = options.appendFinalBidIfEligible;
  const appendUpcomingJobIfEligible = options.appendUpcomingJobIfEligible;

  if (typeof appendRideRow !== "function") {
    throw new Error("OTS import requires appendRideRow");
  }

  const summary = {
    seen: Array.isArray(rows) ? rows.length : 0,
    imported: 0,
    review: 0,
    skipped: 0,
    failed: 0
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const ride = mapOtsRowToRide(row, {
      groupName: options.groupName,
      sourceName: options.sourceName,
      sourceTime: options.sourceTime
    });
    const dedupeKey = buildOtsDedupeKey(ride, row);

    if (dedupe && typeof dedupe.hasProcessed === "function" && dedupe.hasProcessed(dedupeKey)) {
      summary.skipped += 1;
      continue;
    }

    const missingFields = getMissingRequiredFields(ride);
    const target = missingFields.length > 0 ? "review" : "rides";

    try {
      if (target === "review" && typeof appendReviewRow === "function") {
        await appendReviewRow({
          ...ride,
          payment_status: `Needs Review: missing ${missingFields.join(", ")}`
        });
        summary.review += 1;
      } else {
        await appendRideRow(ride);
        summary.imported += 1;

        if (typeof appendFinalBidIfEligible === "function") {
          await appendFinalBidIfEligible(ride);
        }

        if (typeof appendUpcomingJobIfEligible === "function") {
          await appendUpcomingJobIfEligible(ride);
        }
      }

      if (dedupe && typeof dedupe.markProcessed === "function") {
        dedupe.markProcessed(dedupeKey, {
          refer: ride.refer,
          source: "ots",
          target,
          processedAt: new Date().toISOString()
        });
      }
    } catch (error) {
      summary.failed += 1;
      const known = summarizeKnownError(error, {
        stage: "ots_import",
        defaultSummary: "OTS ride import failed",
        fallbackUsed: true
      });
      logger.warn(known.summary, {
        stage: "ots_import",
        refer: ride.refer,
        fallbackUsed: true,
        reason: known.likelyCause || error?.message || "import failed",
        error
      });
    }
  }

  if (summary.imported > 0 || summary.review > 0 || summary.failed > 0) {
    logger.info("OTS rides imported", {
      stage: "ots_import",
      reason: `imported=${summary.imported} review=${summary.review} skipped=${summary.skipped} failed=${summary.failed}`
    });
  }

  return summary;
}

async function runOtsImportOnce(options = {}) {
  const formattedRowsPath = path.resolve(String(options.formattedRowsPath || ""));
  const projectPath = options.projectPath ? path.resolve(String(options.projectPath)) : "";
  const runPipeline = options.runPipeline !== false;
  const dispatchManagedPipeline =
    options.dispatchManagedPipeline || options.pipelineEnv?.DISPATCH_MANAGED_PIPELINE === "true";

  if (runPipeline) {
    const result = await runOtsPipeline(projectPath, {
      env: options.pipelineEnv,
      stdio: options.pipelineStdio
    });
    if (result.code !== 0) {
      throw new Error(result.error?.message || `OTS pipeline failed: exit_code=${result.code}`);
    }

    // A managed worker only exposes a formatted batch when it has written this marker.
    // Without it, formatted_rows_latest.json may belong to an earlier, already-acknowledged batch.
    if (dispatchManagedPipeline && !hasPendingDispatchImport(projectPath)) {
      return { seen: 0, imported: 0, review: 0, skipped: 0, failed: 0 };
    }
  }

  const rows = loadFormattedRows(formattedRowsPath);
  const summary = await importOtsRows(rows, options);

  if (dispatchManagedPipeline && summary.failed === 0) {
    const acknowledge = options.acknowledgeDispatchImport || acknowledgeOtsDispatchImport;
    const result = await acknowledge(projectPath, formattedRowsPath);
    if (result.code !== 0) {
      throw new Error(result.error?.message || `OTS import acknowledgement failed: exit_code=${result.code}`);
    }
    options.logger?.info?.("OTS batch acknowledged", {
      stage: "ots_import",
      reason: `rows=${rows.length}`
    });
  }

  return summary;
}

function hasPendingDispatchImport(projectPath) {
  if (!projectPath) return false;
  return fs.existsSync(path.join(projectPath, "output", "pending_dispatch_import.json"));
}

function runOtsPipeline(projectPath, options = {}) {
  const cwd = path.resolve(String(projectPath || ""));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(cwd, "scripts", "pipeline.js")], {
      cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.stdio || "ignore"
    });

    child.on("error", (error) => {
      resolve({ code: 1, error });
    });
    child.on("exit", (code) => {
      resolve({ code: Number(code || 0), error: null });
    });
  });
}

function acknowledgeOtsDispatchImport(projectPath, formattedRowsPath) {
  const cwd = path.resolve(String(projectPath || ""));
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(cwd, "scripts", "ack_dispatch_import.js"), "--input", formattedRowsPath],
      { cwd, env: process.env, stdio: "ignore" }
    );

    child.on("error", (error) => resolve({ code: 1, error }));
    child.on("exit", (code) => resolve({ code: Number(code || 0), error: null }));
  });
}

function createOtsImportRunner(options = {}) {
  const logger = options.logger || {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
  let activeRun = null;

  async function executeRun(overrides = {}) {
    const merged = { ...options, ...overrides };
    const formattedRowsPath = path.resolve(String(merged.formattedRowsPath || ""));
    const projectPath = merged.projectPath ? path.resolve(String(merged.projectPath)) : "";
    const runPipeline = merged.runPipeline !== false;
    return runOtsImportOnce({
      ...merged,
      projectPath,
      formattedRowsPath,
      runPipeline
    });
  }

  function tick(overrides = {}) {
    if (activeRun) {
      logger.debug("OTS import run already active", {
        stage: "ots_import",
        reason: "reusing_active_run"
      });
      return activeRun;
    }

    activeRun = executeRun(overrides).finally(() => {
      activeRun = null;
    });
    return activeRun;
  }

  return { tick };
}

function startOtsIntegrationPolling(options = {}) {
  const logger = options.logger || {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
  const intervalMs = Math.max(60 * 1000, Number(options.intervalMs || 15 * 60 * 1000));
  const runner = options.runner || createOtsImportRunner(options);
  let timer = null;
  let stopped = false;

  async function tick(overrides = {}) {
    if (stopped) return undefined;
    try {
      return await runner.tick(overrides);
    } catch (error) {
      const known = summarizeKnownError(error, {
        stage: "ots_import",
        defaultSummary: "OTS integration polling failed",
        fallbackUsed: true
      });
      logger.warn(known.summary, {
        stage: "ots_import",
        fallbackUsed: true,
        reason: known.likelyCause || error?.message || "poll failed",
        error
      });
      if (overrides.throwOnError) throw error;
      return undefined;
    }
  }

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  setImmediate(tick);

  logger.info("OTS integration started", {
    stage: "ots_import",
    reason: `interval=${intervalMs}ms runPipeline=${options.runPipeline !== false}`
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick
  };
}

module.exports = {
  DEFAULT_GROUP_NAME,
  DEFAULT_SOURCE_NAME,
  mapOtsRowToRide,
  parseOtsExpiry,
  getMissingRequiredFields,
  buildOtsDedupeKey,
  loadFormattedRows,
  importOtsRows,
  hasPendingDispatchImport,
  runOtsImportOnce,
  runOtsPipeline,
  acknowledgeOtsDispatchImport,
  createOtsImportRunner,
  startOtsIntegrationPolling
};
