const { safeTrim } = require("../utils/text");

const VEHICLE_COST_PER_MILE = Object.freeze({
  saloon: 0.62,
  estate: 0.68,
  mpv: 0.78,
  "6 seater": 0.86,
  "8 seater": 0.95,
  "9 seater": 1.02,
  executive: 0.92
});

function toNumber(value, fallback = 0) {
  const normalized = String(value ?? "").replace(/[^0-9.]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 2) / 2;
}

function normalizeVehicle(value) {
  return safeTrim(value).toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
}

function resolveVehicleCostPerMile(vehicle) {
  const normalized = normalizeVehicle(vehicle);
  if (normalized.includes("9")) return VEHICLE_COST_PER_MILE["9 seater"];
  if (normalized.includes("8")) return VEHICLE_COST_PER_MILE["8 seater"];
  if (normalized.includes("6")) return VEHICLE_COST_PER_MILE["6 seater"];
  if (normalized.includes("mpv")) return VEHICLE_COST_PER_MILE.mpv;
  if (normalized.includes("estate")) return VEHICLE_COST_PER_MILE.estate;
  if (normalized.includes("executive")) return VEHICLE_COST_PER_MILE.executive;
  return VEHICLE_COST_PER_MILE.saloon;
}

function hasAirportRoute(ride = {}) {
  const route = `${ride.Pickup || ride.pickup || ""} ${ride["Drop Off"] || ride.dropOff || ride.drop_off || ""}`.toLowerCase();
  return /\b(lhr|lgw|stn|ltn|lcy|heathrow|gatwick|stansted|luton|city airport|terminal)\b/.test(route);
}

function estimateDistanceMiles(ride = {}) {
  const raw = safeTrim(ride.Distance || ride.distance);
  const numeric = toNumber(raw);
  if (!numeric) return { miles: 0, confidence: "low", source: "missing" };
  if (/\bkm\b/i.test(raw)) return { miles: numeric * 0.621371, confidence: "high", source: "km" };
  return { miles: numeric, confidence: /\bmi|mile/i.test(raw) ? "high" : "medium", source: "assumed_miles" };
}

function calculateBidPricing(ride = {}, options = {}) {
  const fare = toNumber(ride.Fare || ride.fare);
  const vehicle = safeTrim(ride["Required Vehicle"] || ride.requiredVehicle || ride.required_vehicle) || "Saloon";
  const distance = estimateDistanceMiles(ride);
  const minMarginPercent = Number.isFinite(Number(options.minMarginPercent))
    ? Number(options.minMarginPercent)
    : 20;
  const competitiveDiscountPercent = Number.isFinite(Number(options.competitiveDiscountPercent))
    ? Number(options.competitiveDiscountPercent)
    : 6;
  const linkedSaving = Math.max(0, toNumber(options.linkedSaving ?? ride["Estimated Saving"]));
  const baseCost = Number.isFinite(Number(options.baseCost)) ? Number(options.baseCost) : 12;
  const airportSurcharge = hasAirportRoute(ride)
    ? (Number.isFinite(Number(options.airportSurcharge)) ? Number(options.airportSurcharge) : 5)
    : 0;
  const estimatedCost = Math.max(
    0,
    baseCost + distance.miles * resolveVehicleCostPerMile(vehicle) + airportSurcharge - linkedSaving
  );
  const requiredRevenue = estimatedCost / Math.max(0.05, 1 - minMarginPercent / 100);
  const competitiveTarget = fare > 0 ? fare * Math.max(0.5, 1 - competitiveDiscountPercent / 100) : 0;
  const suggestedBid = roundMoney(Math.max(requiredRevenue, competitiveTarget));
  const marginPercent = suggestedBid > 0 ? ((suggestedBid - estimatedCost) / suggestedBid) * 100 : 0;
  const impossible = fare > 0 && requiredRevenue > fare;
  const lowConfidence = distance.confidence === "low" || !fare;
  const decision = impossible ? "Review Required" : lowConfidence ? "Review Recommended" : "Ready for Review";
  const reasons = [
    `${vehicle} estimated cost £${roundMoney(estimatedCost).toFixed(2)}`,
    distance.miles ? `${roundMoney(distance.miles)} mi route` : "distance missing",
    `target margin ${roundMoney(marginPercent)}%`
  ];
  if (linkedSaving > 0) reasons.push(`linked route saving £${roundMoney(linkedSaving).toFixed(2)}`);
  if (impossible) reasons.push("quoted fare is below the profitable floor");
  if (lowConfidence) reasons.push("manual check needed");

  return {
    suggestedBid,
    estimatedCost: roundMoney(estimatedCost),
    estimatedProfit: roundMoney(suggestedBid - estimatedCost),
    marginPercent: roundMoney(marginPercent),
    linkedSaving: roundMoney(linkedSaving),
    decision,
    confidence: lowConfidence ? "Low" : distance.confidence === "medium" ? "Medium" : "High",
    reason: reasons.join("; "),
    distanceMiles: roundMoney(distance.miles)
  };
}

module.exports = {
  calculateBidPricing,
  estimateDistanceMiles,
  resolveVehicleCostPerMile
};
