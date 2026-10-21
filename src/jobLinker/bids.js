function cleanText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeBusinessReference(value) {
  return cleanText(value).replace(/\s+/g, "").toUpperCase();
}

function publicProviderFailure(value) {
  const message = cleanText(value);
  if (!message) return "OTS bid submission failed.";
  if (/\n|\r|node_modules|(?:[a-z]:\\)|(?:\/(?:opt|home|var)\/)/i.test(message)) {
    return "OTS provider submission failed. Check backend logs.";
  }
  return message.slice(0, 300);
}

class JobLinkerBidError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message);
    this.name = "JobLinkerBidError";
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function bidError(code, message, statusCode, details) {
  return new JobLinkerBidError(code, message, statusCode, details);
}

function validateBidAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw bidError("INVALID_BID_AMOUNT", "Bid amount must be a finite positive GBP amount.", 400);
  }
  if (amount > 100000) {
    throw bidError("INVALID_BID_AMOUNT", "Bid amount is outside the supported GBP range.", 400);
  }
  return Math.round(amount * 100) / 100;
}

function validateManualBidRide(ride, now = new Date()) {
  if (!ride) throw bidError("RIDE_NOT_FOUND", "Ride was not found.", 404);
  if (cleanText(ride.sourceType || ride.source_type).toLowerCase() !== "ots") {
    throw bidError("NON_OTS_RIDE", "Only active OTS jobs can be submitted through this bid endpoint.", 400);
  }
  if (ride.trashedAt || ride.trashed_at) {
    throw bidError("RIDE_TRASHED", "This ride is in Trash and cannot be bid.", 409);
  }
  if (ride.deletedAt || ride.deleted_at) {
    throw bidError("RIDE_INACTIVE", "This ride is no longer active.", 409);
  }
  const status = cleanText(ride.status).toLowerCase();
  if (["completed", "cancelled", "canceled", "rejected", "expired", "failed", "closed"].includes(status)) {
    throw bidError("RIDE_INACTIVE", `Ride status ${status} is not actionable.`, 409);
  }
  const nowTime = new Date(now).getTime();
  const pickupTime = new Date(ride.pickupAt || ride.pickup_at || "").getTime();
  const expiryTime = new Date(ride.expiresAt || ride.source_expires_at || "").getTime();
  if ((Number.isFinite(pickupTime) && pickupTime <= nowTime) || (Number.isFinite(expiryTime) && expiryTime <= nowTime)) {
    throw bidError("RIDE_EXPIRED", "This OTS job has expired and cannot be bid.", 409);
  }
  return ride;
}

function normalizeSubmitResult(result = {}) {
  const state = cleanText(result.state || (result.success ? "confirmed" : "failed")).toLowerCase();
  return {
    state,
    success: Boolean(result.success || (result.ok && state === "confirmed")),
    bidAmount: cleanText(result.bidAmount),
    providerReference: cleanText(result.providerReference),
    message: cleanText(result.reason || result.message),
    timing: result.timing && typeof result.timing === "object" ? result.timing : {}
  };
}

function createJobLinkerBidService(options = {}) {
  const repository = options.repository;
  const submitBid = options.submitBid;
  const logger = options.logger || { info: () => {}, warn: () => {} };
  const pollIntervalMs = Math.max(1000, Number(options.pollIntervalMs) || 5000);
  const staleTimeoutMs = Math.max(60000, Number(options.staleTimeoutMs) || 5 * 60 * 1000);
  const activeBidIds = new Set();
  let timer = null;
  if (!repository) throw new Error("Job Linker bid repository is required");

  async function persistCompletion(value) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await repository.completeManualBid(value);
      } catch (error) {
        lastError = error;
        if (error?.code === "BID_STATE_CONFLICT") throw error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
    throw lastError;
  }

  async function processReservation(reservation) {
    try {
      await repository.markManualBidSubmitting(reservation.bidId);
      let result;
      try {
        result = normalizeSubmitResult(await submitBid(reservation.trustedBid));
      } catch (error) {
        const errorDetail = cleanText(error?.message) || "OTS bid submission failed.";
        await persistCompletion({
          bidId: reservation.bidId,
          success: false,
          bidAmount: reservation.trustedBid.bidAmount,
          message: publicProviderFailure(errorDetail),
          timing: error?.timing && typeof error.timing === "object" ? error.timing : {}
        });
        logger.warn("Manual OTS bid failed", {
          stage: "job_linker_bid",
          fallbackUsed: true,
          reason: `${reservation.trustedBid.rideId}: ${errorDetail}`,
          error
        });
        return;
      }
      if (!result.success) {
        await persistCompletion({
          bidId: reservation.bidId,
          success: false,
          state: result.state,
          bidAmount: reservation.trustedBid.bidAmount,
          message: publicProviderFailure(result.message || "OTS submitter returned an unsuccessful result."),
          timing: result.timing
        });
        return;
      }
      await persistCompletion({
        bidId: reservation.bidId,
        success: true,
        state: result.state,
        bidAmount: result.bidAmount || reservation.trustedBid.bidAmount,
        providerReference: result.providerReference,
        message: result.message || "OTS provider confirmed the submission.",
        timing: result.timing
      });
      const elapsed = Number(result.timing?.totalMs);
      logger.info("OTS bid submission completed", {
        stage: "job_linker_bid",
        reason: `${reservation.trustedBid.bidType}: ${reservation.trustedBid.rideId}${Number.isFinite(elapsed) ? ` in ${(elapsed / 1000).toFixed(1)}s` : ""}`
      });
    } catch (error) {
      if (error?.code === "BID_STATE_CONFLICT") return;
      logger.warn("Manual OTS bid worker failed", {
        stage: "job_linker_bid",
        fallbackUsed: true,
        reason: `${reservation.trustedBid.rideId}: ${cleanText(error?.message) || "bid_worker_failed"}`,
        error
      });
    } finally {
      activeBidIds.delete(reservation.bidId);
    }
  }

  function enqueue(reservation) {
    if (!reservation?.bidId || activeBidIds.has(reservation.bidId)) return false;
    activeBidIds.add(reservation.bidId);
    setImmediate(() => processReservation(reservation).catch((error) => {
      logger.warn("Manual OTS bid worker failed", {
        stage: "job_linker_bid",
        fallbackUsed: true,
        reason: error?.message || "bid_worker_failed"
      });
    }));
    return true;
  }

  async function drain() {
    if (typeof submitBid !== "function") return;
    if (activeBidIds.size > 0) return;
    if (typeof repository.failStaleSubmittingBids === "function") {
      await repository.failStaleSubmittingBids(staleTimeoutMs);
    }
    if (typeof repository.listPendingManualBids !== "function") return;
    const pending = await repository.listPendingManualBids(1);
    if (pending[0]) enqueue(pending[0]);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => drain().catch((error) => {
      logger.warn("Manual OTS bid queue check failed", {
        stage: "job_linker_bid",
        fallbackUsed: true,
        reason: error?.message || "bid_queue_check_failed"
      });
    }), pollIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    setImmediate(() => drain().catch(() => {}));
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function submitManualBid(input = {}) {
    const rideId = cleanText(input.rideId);
    if (!rideId) throw bidError("RIDE_ID_REQUIRED", "Ride ID is required.", 400);
    const bidAmount = validateBidAmount(input.bidAmount);
    if (typeof submitBid !== "function") {
      throw bidError("OTS_SUBMITTER_UNAVAILABLE", "OTS bid submission is not configured on the server.", 503);
    }
    const reservation = await repository.reserveManualBid({
      rideId,
      bidAmount,
      reason: cleanText(input.reason),
      actor: cleanText(input.actor) || "Dashboard",
      bidType: cleanText(input.bidType) || "Job Linker Manual Bid",
      automated: input.automated === true,
      now: options.now ? options.now() : new Date()
    });
    enqueue(reservation);
    return {
      ok: true,
      message: "Bid accepted and queued for OTS submission.",
      bid: reservation.bid
    };
  }

  if (options.autoStart !== false) start();
  function isBusy() {
    return activeBidIds.size > 0;
  }

  return { submitManualBid, drain, start, stop, isBusy };
}

module.exports = {
  JobLinkerBidError,
  createJobLinkerBidService,
  normalizeBusinessReference,
  publicProviderFailure,
  validateBidAmount,
  validateManualBidRide
};
