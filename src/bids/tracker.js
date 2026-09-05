const { safeTrim } = require("../utils/text");
const { calculateBidPricing } = require("./pricingEngine");

const BID_TRACKER_WORKSHEET_NAME = "Bid Tracker";

const BID_TRACKER_HEADERS = Object.freeze([
  "Ride ID",
  "Source",
  "Pickup",
  "Drop Off",
  "Fare",
  "Required Vehicle",
  "Bid Type",
  "Bid Status",
  "Admin Status",
  "Bid Amount",
  "Reason",
  "Created Time",
  "Updated Time"
]);

const BID_STATUS = Object.freeze({
  SUGGESTED: "Suggested",
  APPROVED: "Approved",
  BID_DONE: "Bid Done",
  BID_FAILED: "Bid Failed",
  SKIPPED: "Skipped"
});

const ADMIN_STATUS = Object.freeze({
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected"
});

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeComparable(value) {
  return toCell(value).toLowerCase();
}

function detectRideSource(record = {}) {
  const source = `${toCell(record["Group Name"])} ${toCell(record["Source Name"])}`.toLowerCase();
  if (source.includes("ots")) return "OTS";
  if (source.includes("whatsapp") || toCell(record["Group Name"])) return "WhatsApp";
  return "Other";
}

function readRideId(record = {}) {
  return toCell(record.Refer || record["Ride ID"] || record.rideId || record.refer);
}

function buildBidTrackerRowObject({
  ride = {},
  bidType = "Manual Review",
  bidStatus = BID_STATUS.SUGGESTED,
  adminStatus = ADMIN_STATUS.PENDING,
  bidAmount = "",
  reason = "",
  pricing = null,
  createdTime = "",
  updatedTime = ""
} = {}) {
  const now = new Date().toISOString();
  return {
    "Ride ID": readRideId(ride),
    Source: detectRideSource(ride),
    Pickup: toCell(ride.Pickup || ride.pickup),
    "Drop Off": toCell(ride["Drop Off"] || ride.drop_off),
    Fare: toCell(ride.Fare || ride.fare),
    "Required Vehicle": toCell(ride["Required Vehicle"] || ride.required_vehicle),
    "Bid Type": toCell(bidType) || "Manual Review",
    "Bid Status": toCell(bidStatus) || BID_STATUS.SUGGESTED,
    "Admin Status": toCell(adminStatus) || ADMIN_STATUS.PENDING,
    "Bid Amount": toCell(bidAmount || pricing?.suggestedBid),
    Reason: toCell(reason || pricing?.reason),
    "Estimated Cost": toCell(pricing?.estimatedCost),
    "Estimated Profit": toCell(pricing?.estimatedProfit),
    "Margin %": toCell(pricing?.marginPercent),
    "Linked Saving": toCell(pricing?.linkedSaving),
    "AI Decision": toCell(pricing?.decision),
    "Pricing Confidence": toCell(pricing?.confidence),
    pricingPayload: pricing || null,
    "Created Time": toCell(createdTime) || now,
    "Updated Time": toCell(updatedTime) || now
  };
}

function buildBidTrackerSheetRow(record = {}, headers = BID_TRACKER_HEADERS) {
  const safeHeaders = Array.isArray(headers) && headers.length > 0 ? headers : BID_TRACKER_HEADERS;
  return safeHeaders.map((header) => safeTrim(record[header]));
}

function hasBidTrackerEntry(entries = [], rideId) {
  const normalizedRideId = normalizeComparable(rideId);
  if (!normalizedRideId) return false;
  return (Array.isArray(entries) ? entries : []).some(
    (entry) => normalizeComparable(entry["Ride ID"]) === normalizedRideId
  );
}

function shouldSuggestBid(ride = {}, options = {}) {
  const rideId = readRideId(ride);
  if (!rideId) return { suggested: false, reason: "ride_id_missing" };

  const status = normalizeComparable(ride.Status);
  if (["rejected", "cancelled", "canceled", "completed"].includes(status)) {
    return { suggested: false, reason: `ride_status_${status}` };
  }

  const fare = Number(toCell(ride.Fare || ride.fare).replace(/[^0-9.]/g, ""));
  const minFare = Number(options.minFare);
  if (Number.isFinite(minFare) && minFare > 0 && Number.isFinite(fare) && fare < minFare) {
    return { suggested: false, reason: `fare_below_${minFare}` };
  }

  return { suggested: true, reason: "eligible_for_bid_review" };
}

function buildSuggestedBidEntries(finalBidRows = [], existingBidRows = [], options = {}) {
  const entries = [];
  for (const ride of Array.isArray(finalBidRows) ? finalBidRows : []) {
    const rideId = readRideId(ride);
    if (!rideId || hasBidTrackerEntry(existingBidRows, rideId)) continue;

    const suggestion = shouldSuggestBid(ride, options);
    if (!suggestion.suggested) continue;

    const pricing = calculateBidPricing(ride, options.pricingOptions);
    entries.push(
      buildBidTrackerRowObject({
        ride,
        bidType: detectRideSource(ride) === "OTS" ? "OTS Bid Review" : "Manual Bid Review",
        pricing,
        reason: pricing.reason || suggestion.reason
      })
    );
  }
  return entries;
}

module.exports = {
  BID_TRACKER_WORKSHEET_NAME,
  BID_TRACKER_HEADERS,
  BID_STATUS,
  ADMIN_STATUS,
  buildBidTrackerRowObject,
  buildBidTrackerSheetRow,
  hasBidTrackerEntry,
  shouldSuggestBid,
  buildSuggestedBidEntries
};
