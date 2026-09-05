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
  return {
    success: Boolean(result.success),
    bidAmount: cleanText(result.bidAmount),
    providerReference: cleanText(result.providerReference),
    message: cleanText(result.reason || result.message)
  };
}

function createJobLinkerBidService(options = {}) {
  const repository = options.repository;
  const submitBid = options.submitBid;
  const logger = options.logger || { info: () => {}, warn: () => {} };
  if (!repository) throw new Error("Job Linker bid repository is required");

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
      now: options.now ? options.now() : new Date()
    });

    await repository.markManualBidSubmitting(reservation.bidId);
    try {
      const result = normalizeSubmitResult(await submitBid(reservation.trustedBid));
      if (!result.success) {
        throw new Error(result.message || "OTS submitter returned an unsuccessful result.");
      }
      const bid = await repository.completeManualBid({
        bidId: reservation.bidId,
        success: true,
        bidAmount: result.bidAmount || bidAmount,
        providerReference: result.providerReference,
        message: result.message || "OTS submission completed without provider outcome confirmation."
      });
      logger.info("Manual OTS bid submitted", { stage: "job_linker_bid", reason: rideId });
      return {
        ok: true,
        message: "Bid submitted to OTS. Booking outcome is not yet confirmed.",
        bid
      };
    } catch (error) {
      const errorDetail = cleanText(error?.message) || "OTS bid submission failed.";
      const message = publicProviderFailure(errorDetail);
      const bid = await repository.completeManualBid({
        bidId: reservation.bidId,
        success: false,
        bidAmount,
        message
      });
      logger.warn("Manual OTS bid failed", {
        stage: "job_linker_bid",
        fallbackUsed: true,
        reason: `${rideId}: ${errorDetail}`,
        error
      });
      throw bidError("OTS_SUBMISSION_FAILED", message, 502, { bid });
    }
  }

  return { submitManualBid };
}

module.exports = {
  JobLinkerBidError,
  createJobLinkerBidService,
  normalizeBusinessReference,
  publicProviderFailure,
  validateBidAmount,
  validateManualBidRide
};
