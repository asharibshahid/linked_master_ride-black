function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function ordinal(value) {
  const number = Number(value);
  const mod100 = number % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${number}th`;
  if (number % 10 === 1) return `${number}st`;
  if (number % 10 === 2) return `${number}nd`;
  if (number % 10 === 3) return `${number}rd`;
  return `${number}th`;
}

function formatUkPickup(value, timeZone = "Europe/London") {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const zone = /BST/i.test(parts.timeZoneName || "") ? "BST" : "GMT";
  const month = parts.month === "Sept" ? "Sep" : parts.month;
  return `${Number(parts.hour)}:${parts.minute} ${String(parts.dayPeriod || "").toLowerCase()}, ${parts.weekday} ${ordinal(parts.day)} ${month} ${parts.year} (${zone})`;
}

function formatPassengerLine(job = {}) {
  const rawCount = job.passengerCount ?? job.passenger_count;
  if (text(rawCount) === "") return "";
  const count = Number(rawCount);
  if (!Number.isFinite(count) || count < 0) return "";
  const luggage = text(job.luggageDetails || job.luggage_details);
  return `Carrying ${count} ${count === 1 ? "passenger" : "passengers"}${luggage ? ` with ${luggage}` : ""}`;
}

function formatBidPrice(job = {}) {
  const raw = job.bidAmount ?? job.bid_amount;
  if (raw === null || raw === undefined || String(raw).trim() === "") return "";
  const amount = Number(String(raw).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? `Bid price: £${amount.toFixed(2)}` : "";
}

function moneyValue(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const amount = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function formatGuideLine(job = {}) {
  const sourceText = text(job.guidePriceText || job.guide_price_text);
  if (sourceText) return sourceText;
  const minimum = moneyValue(job.guidePriceMin ?? job.guide_price_min);
  const maximum = moneyValue(job.guidePriceMax ?? job.guide_price_max);
  if (minimum !== null && maximum !== null) return `As a guide, we are expecting prices between £${minimum.toFixed(2)} and £${maximum.toFixed(2)}.`;
  if (maximum !== null) return `OTS guide maximum: £${maximum.toFixed(2)} (minimum unavailable in source snapshot).`;
  if (minimum !== null) return `OTS guide minimum: £${minimum.toFixed(2)} (maximum unavailable in source snapshot).`;
  return formatBidPrice(job) ? "OTS guide price unavailable in source snapshot." : "";
}

function formatOtsCopyDetail(job = {}, options = {}) {
  const reference = text(job.otsReference || job.refer || job.rideId || job.ride_id);
  const pickup = text(job.pickup);
  const dropOff = text(job.dropOff || job.drop_off);
  const pickupLabel = formatUkPickup(job.pickupAt || job.pickup_at, options.timeZone);
  const vehicle = text(job.requiredVehicle || job.required_vehicle);
  const passenger = formatPassengerLine(job);
  const guide = formatGuideLine(job);
  const bidPrice = formatBidPrice(job);
  const lines = [reference, "", "Route:", `\t\u2022 ${pickup}`, `\t\u2022 ${dropOff}`, ""];
  if (pickupLabel) lines.push(`Pick up at ${pickupLabel}`);
  if (vehicle) lines.push(`Travelling by ${vehicle}`);
  if (passenger) lines.push(passenger);
  if (guide) lines.push("", guide);
  if (bidPrice) lines.push("", bidPrice);
  return lines.join("\n").trim();
}

module.exports = { formatBidPrice, formatGuideLine, formatOtsCopyDetail, formatPassengerLine, formatUkPickup };
