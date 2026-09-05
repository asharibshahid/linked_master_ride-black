const { readSheetValues, updateBidStatus } = require("../dashboard/actions");
const { safeTrim } = require("../utils/text");

const AUTO_BID_MODE = Object.freeze({
  SAFE: "safe",
  LIVE: "live"
});

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeComparable(value) {
  return toCell(value).toLowerCase();
}

function mapRowsToRecords(headers = [], rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const record = {};
    (Array.isArray(headers) ? headers : []).forEach((header, index) => {
      if (header) record[header] = toCell(row?.[index]);
    });
    return record;
  });
}

function normalizeBidRecord(record = {}) {
  return {
    rideId: toCell(record["Ride ID"]),
    source: toCell(record.Source),
    pickup: toCell(record.Pickup),
    dropOff: toCell(record["Drop Off"]),
    fare: toCell(record.Fare),
    requiredVehicle: toCell(record["Required Vehicle"]),
    bidType: toCell(record["Bid Type"]),
    bidStatus: toCell(record["Bid Status"]),
    adminStatus: toCell(record["Admin Status"]),
    bidAmount: toCell(record["Bid Amount"]),
    reason: toCell(record.Reason)
  };
}

function isApprovedBidReady(record = {}) {
  const bid = normalizeBidRecord(record);
  if (!bid.rideId) return false;
  if (normalizeComparable(bid.adminStatus) !== "approved") return false;

  const status = normalizeComparable(bid.bidStatus);
  return status === "approved" || status === "suggested";
}

async function loadApprovedBidRows(options = {}) {
  if (options.databaseRepository && typeof options.databaseRepository.loadApprovedBidRows === "function") {
    const rows = await options.databaseRepository.loadApprovedBidRows();
    return (Array.isArray(rows) ? rows : []).filter(isApprovedBidReady);
  }

  const sheet = await readSheetValues({
    sheetsClient: options.sheetsClient,
    spreadsheetId: options.spreadsheetId,
    worksheetName: options.bidTrackerWorksheetName || "Bid Tracker"
  });
  return mapRowsToRecords(sheet.headers, sheet.rows).filter(isApprovedBidReady);
}

async function defaultSubmitBid() {
  throw new Error("OTS bid submitter is not configured");
}

async function setBidStatus(options = {}, update = {}) {
  const logger = options.logger || {
    warn: () => {}
  };
  let databaseUpdated = false;
  let sheetUpdated = false;
  let databaseError = null;
  let sheetError = null;

  if (options.databaseRepository && typeof options.databaseRepository.updateBidStatus === "function") {
    try {
      await options.databaseRepository.updateBidStatus(update);
      databaseUpdated = true;
    } catch (error) {
      databaseError = error;
    }
  }

  if (options.sheetsClient && options.spreadsheetId) {
    try {
      await updateBidStatus({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        bidTrackerWorksheetName: options.bidTrackerWorksheetName,
        ...update
      });
      sheetUpdated = true;
    } catch (error) {
      sheetError = error;
    }
  }

  if (databaseUpdated && sheetError) {
    logger.warn("Bid status Sheets backup failed", {
      stage: "database_backup",
      fallbackUsed: true,
      reason: safeTrim(sheetError?.message) || "bid_status_sheet_backup_failed",
      error: sheetError
    });
  }

  if (sheetUpdated && databaseError) {
    logger.warn("Bid status database mirror failed", {
      stage: "database",
      fallbackUsed: true,
      reason: safeTrim(databaseError?.message) || "bid_status_db_mirror_failed",
      error: databaseError
    });
  }

  if (!databaseUpdated && !sheetUpdated) {
    throw databaseError || sheetError || new Error("Bid status update target is not configured");
  }
}

function normalizeSubmitResult(result = {}) {
  return {
    success: Boolean(result.success),
    bidAmount: toCell(result.bidAmount),
    reason: toCell(result.reason || result.message),
    providerReference: toCell(result.providerReference)
  };
}

async function processApprovedBids(options = {}) {
  const logger = options.logger || {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
  const mode = normalizeComparable(options.mode || AUTO_BID_MODE.SAFE);
  const submitBid = typeof options.submitBid === "function" ? options.submitBid : defaultSubmitBid;
  const rows = await loadApprovedBidRows(options);
  const summary = {
    scanned: rows.length,
    submitted: 0,
    safeMode: 0,
    failed: 0,
    skipped: 0
  };

  for (const row of rows) {
    const bid = normalizeBidRecord(row);

    if (mode !== AUTO_BID_MODE.LIVE) {
      summary.safeMode += 1;
      await setBidStatus(options, {
        rideId: bid.rideId,
        bidStatus: "Approved",
        reason: "Safe mode: approved and ready for OTS submission"
      });
      continue;
    }

    try {
      const result = normalizeSubmitResult(await submitBid(bid));
      if (result.success) {
        summary.submitted += 1;
        await setBidStatus(options, {
          rideId: bid.rideId,
          bidStatus: "Bid Done",
          bidAmount: result.bidAmount || bid.bidAmount || bid.fare,
          reason: result.reason || result.providerReference || "OTS bid submitted"
        });
        logger.info("Auto bid submitted", {
          stage: "auto_bid",
          reason: bid.rideId
        });
      } else {
        summary.failed += 1;
        await setBidStatus(options, {
          rideId: bid.rideId,
          bidStatus: "Bid Failed",
          reason: result.reason || "OTS bid submitter returned failure"
        });
      }
    } catch (error) {
      summary.failed += 1;
      await setBidStatus(options, {
        rideId: bid.rideId,
        bidStatus: "Bid Failed",
        reason: safeTrim(error?.message) || "OTS bid submission failed"
      });
      logger.warn("Auto bid failed", {
        stage: "auto_bid",
        fallbackUsed: true,
        reason: `${bid.rideId}: ${safeTrim(error?.message) || "submit failed"}`,
        error
      });
    }
  }

  return summary;
}

function createAutoBidRunner(options = {}) {
  const logger = options.logger || {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
  let activeRun = null;

  async function executeRun(overrides = {}) {
    const merged = { ...options, ...overrides };
    try {
      const summary = await processApprovedBids(merged);
      if (summary.submitted > 0 || summary.failed > 0 || summary.safeMode > 0) {
        logger.info("Auto bid poll complete", {
          stage: "auto_bid",
          reason: `submitted=${summary.submitted} safe=${summary.safeMode} failed=${summary.failed}`
        });
      }
      return summary;
    } catch (error) {
      logger.warn("Auto bid polling failed", {
        stage: "auto_bid",
        fallbackUsed: true,
        reason: safeTrim(error?.message) || "auto_bid_poll_failed",
        error
      });
      if (overrides.throwOnError) throw error;
      return {
        scanned: 0,
        submitted: 0,
        safeMode: 0,
        failed: 1,
        skipped: 0,
        reason: safeTrim(error?.message) || "auto_bid_poll_failed"
      };
    }
  }

  function tick(overrides = {}) {
    if (activeRun) {
      logger.debug("Auto bid run already active", {
        stage: "auto_bid",
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

function startAutoBidPolling(options = {}) {
  const logger = options.logger || {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
  const intervalMs =
    Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
      ? Number(options.intervalMs)
      : 60000;
  const runner = options.runner || createAutoBidRunner(options);
  async function tick(overrides = {}) {
    return runner.tick(overrides);
  }

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(tick, 2000).unref?.();

  logger.info("Auto bid polling started", {
    stage: "auto_bid",
    reason: `mode=${options.mode || AUTO_BID_MODE.SAFE} interval=${intervalMs}ms`
  });

  return {
    stop() {
      clearInterval(timer);
    },
    tick
  };
}

module.exports = {
  AUTO_BID_MODE,
  normalizeBidRecord,
  isApprovedBidReady,
  loadApprovedBidRows,
  processApprovedBids,
  createAutoBidRunner,
  startAutoBidPolling
};
