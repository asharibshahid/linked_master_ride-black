const DEFAULT_AUTO_BID_SETTINGS = Object.freeze({
  enabled: false,
  dateScope: "tomorrow",
  dateFrom: "",
  dateTo: "",
  minimumMiles: 70,
  priceDeduction: 5,
  minimumExpiryMinutes: 10,
  allowedVehicles: ["Saloon Car", "People Carrier", "8 Seater Minibus"]
});

const AUTO_BID_DATE_SCOPES = new Set(["today", "tomorrow", "futureExcludingTodayTomorrow", "currentMonth", "currentMonthExcludingTodayTomorrow", "futureMonths", "nextMonth", "custom", "customFrom"]);
const OTS_VEHICLES = Object.freeze([
  "Saloon Car",
  "Executive Car",
  "Estate Car",
  "People Carrier",
  "Executive People Carrier",
  "8 Seater Minibus",
  "Fleet Bus"
]);
const AUTO_BID_SCOPE_LABELS = Object.freeze({
  today: "today",
  tomorrow: "tomorrow",
  futureExcludingTodayTomorrow: "future dates excluding today and tomorrow",
  currentMonth: "the current month",
  currentMonthExcludingTodayTomorrow: "the current month excluding today and tomorrow",
  futureMonths: "future months",
  nextMonth: "next month",
  custom: "the custom date range",
  customFrom: "the selected start date onward"
});

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function finiteNumber(value, fallback, minimum = 0, maximum = 100000) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizeVehicle(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function canonicalVehicle(value) {
  const normalized = normalizeVehicle(value);
  if (normalized === "saloon" || normalized === "saloon car") return "Saloon Car";
  if (normalized === "executive" || normalized === "executive car") return "Executive Car";
  if (normalized === "estate" || normalized === "estate car") return "Estate Car";
  if (normalized === "executive people carrier" || normalized === "executive mpv") return "Executive People Carrier";
  if (normalized === "people carrier" || normalized === "mpv" || normalized === "6 seater") return "People Carrier";
  if (normalized === "8 seater" || normalized === "8 seater minibus" || normalized === "minibus") return "8 Seater Minibus";
  if (normalized === "fleet bus" || normalized === "bus") return "Fleet Bus";
  return text(value);
}

function validDateKey(value) {
  const candidate = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) && !Number.isNaN(new Date(`${candidate}T00:00:00Z`).getTime()) ? candidate : "";
}

function normalizeAutoBidSettings(value = {}) {
  const vehicles = value.allowedVehicles === undefined || value.allowedVehicles === null
    ? DEFAULT_AUTO_BID_SETTINGS.allowedVehicles
    : Array.isArray(value.allowedVehicles)
      ? value.allowedVehicles
      : text(value.allowedVehicles).split(",");
  return {
    enabled: value.enabled === true || String(value.enabled).toLowerCase() === "true",
    dateScope: AUTO_BID_DATE_SCOPES.has(value.dateScope) ? value.dateScope : DEFAULT_AUTO_BID_SETTINGS.dateScope,
    dateFrom: validDateKey(value.dateFrom),
    dateTo: validDateKey(value.dateTo),
    minimumMiles: finiteNumber(value.minimumMiles, DEFAULT_AUTO_BID_SETTINGS.minimumMiles, 0, 1000),
    priceDeduction: finiteNumber(value.priceDeduction, DEFAULT_AUTO_BID_SETTINGS.priceDeduction, 0, 10000),
    minimumExpiryMinutes: finiteNumber(value.minimumExpiryMinutes, DEFAULT_AUTO_BID_SETTINGS.minimumExpiryMinutes, 1, 1440),
    allowedVehicles: [...new Map(vehicles.map(canonicalVehicle).filter((vehicle) => OTS_VEHICLES.includes(vehicle)).map((vehicle) => [vehicle, vehicle])).values()]
  };
}

function settingsFingerprint(settings) {
  const value = normalizeAutoBidSettings(settings);
  return JSON.stringify({
    ...value,
    allowedVehicles: [...value.allowedVehicles].sort()
  });
}

function scopeLabel(dateScope) {
  return AUTO_BID_SCOPE_LABELS[dateScope] || "the selected date scope";
}

function dateKeyInTimeZone(value, timeZone = "Europe/London") {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function tomorrowDateKey(now = new Date(), timeZone = "Europe/London") {
  const today = dateKeyInTimeZone(now, timeZone);
  if (!today) return "";
  const [year, month, day] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  return tomorrow.toISOString().slice(0, 10);
}

function shiftMonth(dateKey, offset) {
  const [year, month] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dateMatchesScope(pickupDate, settings, now, timeZone) {
  const today = dateKeyInTimeZone(now, timeZone);
  if (!pickupDate || !today) return false;
  const currentMonth = today.slice(0, 7);
  if (settings.dateScope === "today") return pickupDate === today;
  if (settings.dateScope === "tomorrow") return pickupDate === tomorrowDateKey(now, timeZone);
  if (settings.dateScope === "futureExcludingTodayTomorrow") return pickupDate > tomorrowDateKey(now, timeZone);
  if (settings.dateScope === "currentMonth") return pickupDate.slice(0, 7) === currentMonth;
  if (settings.dateScope === "currentMonthExcludingTodayTomorrow") {
    return pickupDate.slice(0, 7) === currentMonth && pickupDate > tomorrowDateKey(now, timeZone);
  }
  if (settings.dateScope === "futureMonths") return pickupDate.slice(0, 7) > currentMonth;
  if (settings.dateScope === "nextMonth") return pickupDate.slice(0, 7) === shiftMonth(today, 1);
  if (settings.dateScope === "custom") {
    return Boolean(settings.dateFrom && settings.dateTo && pickupDate >= settings.dateFrom && pickupDate <= settings.dateTo);
  }
  if (settings.dateScope === "customFrom") return Boolean(settings.dateFrom && pickupDate >= settings.dateFrom);
  return false;
}

function numeric(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function evaluateAutoBidJob(job = {}, settings = {}, options = {}) {
  const rule = normalizeAutoBidSettings(settings);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const timeZone = options.timeZone || "Europe/London";
  if (text(job.sourceType).toLowerCase() !== "ots") return { eligible: false, reason: "OTS jobs only" };
  const pickupDate = dateKeyInTimeZone(job.pickupAt, timeZone);
  if (!dateMatchesScope(pickupDate, rule, now, timeZone)) return { eligible: false, reason: "Outside selected UK date scope" };

  const miles = numeric(job.distance);
  if (miles === null) return { eligible: false, reason: "Mileage missing" };
  if (miles < rule.minimumMiles) return { eligible: false, reason: `Below ${rule.minimumMiles} miles` };

  const allowed = new Set(rule.allowedVehicles);
  const vehicle = canonicalVehicle(job.requiredVehicle);
  if (!vehicle || !allowed.has(vehicle)) return { eligible: false, reason: `${text(job.requiredVehicle) || "Vehicle missing"} disabled` };

  const maximum = numeric(job.guidePriceMax);
  if (maximum === null || maximum <= 0) return { eligible: false, reason: "Guide maximum missing" };
  const amount = Math.round((maximum - rule.priceDeduction) * 100) / 100;
  if (amount <= 0) return { eligible: false, reason: "Calculated bid is not positive" };

  const expiry = new Date(job.expiresAt || "").getTime();
  if (!Number.isFinite(expiry) || expiry - now.getTime() < rule.minimumExpiryMinutes * 60_000) {
    return { eligible: false, reason: `Less than ${rule.minimumExpiryMinutes} minutes before expiry` };
  }

  return {
    eligible: true,
    amount,
    miles,
    reason: `Auto Bid: ${rule.dateScope}, ${miles} mi, ${vehicle}, guide max GBP ${maximum.toFixed(2)} minus GBP ${rule.priceDeduction.toFixed(2)}`
  };
}

function buildAutoBidPreview(jobs = [], bids = [], settings = {}, options = {}) {
  const attemptedRideIds = new Set((Array.isArray(bids) ? bids : []).map((bid) => text(bid.rideId)).filter(Boolean));
  const reasons = {};
  const eligible = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (attemptedRideIds.has(text(job.rideId))) {
      reasons["Existing bid"] = (reasons["Existing bid"] || 0) + 1;
      continue;
    }
    const result = evaluateAutoBidJob(job, settings, options);
    if (result.eligible) eligible.push({ rideId: text(job.rideId), amount: result.amount, reason: result.reason });
    else reasons[result.reason] = (reasons[result.reason] || 0) + 1;
  }
  return { eligible, eligibleCount: eligible.length, skippedCount: Math.max(0, jobs.length - eligible.length), reasons };
}

function createJobLinkerAutoBidRunner(options = {}) {
  const repository = options.repository;
  const bidService = options.bidService;
  const logger = options.logger || { info: () => {}, warn: () => {} };
  const timeZone = options.timeZone || "Europe/London";
  const intervalMs = Math.max(15_000, Number(options.intervalMs) || 30_000);
  const runtime = { running: false, lastRunAt: null, lastError: "", lastDecision: "Auto Bid is off", processingRideId: "" };
  let timer = null;
  let activeRun = null;
  let rerunRequested = false;

  if (!repository || !bidService) throw new Error("Auto Bid repository and bid service are required");

  async function getSettings() {
    return normalizeAutoBidSettings(await repository.getAutoBidSettings());
  }

  async function preview(settings) {
    const [jobs, bids] = await Promise.all([repository.listJobs(), repository.listBids()]);
    return buildAutoBidPreview(jobs, bids, settings || await getSettings(), { timeZone, now: options.now?.() || new Date() });
  }

  async function snapshot() {
    const settings = await getSettings();
    const [result, jobs] = await Promise.all([preview(settings), repository.listJobs()]);
    const availableVehicles = [...new Set(jobs.filter((job) => text(job.sourceType).toLowerCase() === "ots").map((job) => text(job.requiredVehicle)).filter(Boolean))].sort();
    return { settings, preview: result, availableVehicles, runtime: { ...runtime, busy: Boolean(bidService.isBusy?.()) } };
  }

  async function saveSettings(value = {}) {
    const settings = normalizeAutoBidSettings(value);
    await repository.saveAutoBidSettings(settings);
    runtime.lastDecision = settings.enabled ? "Auto Bid enabled; waiting for an eligible job" : "Auto Bid is off";
    if (settings.enabled) setImmediate(() => tick());
    return snapshot();
  }

  async function execute() {
    runtime.running = true;
    runtime.lastRunAt = new Date().toISOString();
    runtime.lastError = "";
    try {
      const settings = await getSettings();
      if (!settings.enabled) {
        runtime.lastDecision = "Auto Bid is off";
        return { ok: true, submitted: false, reason: runtime.lastDecision };
      }
      const source = options.getSourceStatus?.() || {};
      const lastSyncAge = Date.now() - new Date(source.otsLastSyncAt || 0).getTime();
      if (!source.otsSourceComplete || source.otsLastError || !Number.isFinite(lastSyncAge) || lastSyncAge > 5 * 60_000) {
        runtime.lastDecision = "Paused: OTS source is not fresh and complete";
        return { ok: true, submitted: false, reason: runtime.lastDecision };
      }
      if (bidService.isBusy?.()) {
        runtime.lastDecision = "Waiting for the current bid to finish";
        return { ok: true, submitted: false, reason: runtime.lastDecision };
      }
      const result = await preview(settings);
      const candidate = result.eligible[0];
      if (!candidate) {
        runtime.lastDecision = `No eligible jobs for ${scopeLabel(settings.dateScope)}`;
        return { ok: true, submitted: false, reason: runtime.lastDecision };
      }
      const latestSettings = await getSettings();
      if (settingsFingerprint(latestSettings) !== settingsFingerprint(settings)) {
        runtime.lastDecision = "Auto Bid rules changed during evaluation; old-scope candidate was not submitted";
        rerunRequested = Boolean(latestSettings.enabled);
        return { ok: true, submitted: false, reason: runtime.lastDecision };
      }
      runtime.processingRideId = candidate.rideId;
      const queued = await bidService.submitManualBid({
        rideId: candidate.rideId,
        bidAmount: candidate.amount,
        reason: candidate.reason,
        actor: "Auto Bid",
        bidType: "Job Linker Auto Bid",
        automated: true
      });
      runtime.lastDecision = `Queued ${candidate.rideId} at GBP ${candidate.amount.toFixed(2)}`;
      logger.info("Job Linker Auto Bid queued", { stage: "job_linker_auto_bid", reason: runtime.lastDecision });
      return { ok: true, submitted: true, bid: queued.bid };
    } catch (error) {
      runtime.lastError = text(error?.message) || "Auto Bid failed";
      runtime.lastDecision = "Auto Bid attempt failed; no automatic retry";
      logger.warn("Job Linker Auto Bid failed", { stage: "job_linker_auto_bid", reason: runtime.lastError });
      return { ok: false, submitted: false, reason: runtime.lastError };
    } finally {
      runtime.processingRideId = "";
      runtime.running = false;
    }
  }

  function tick() {
    if (activeRun) {
      rerunRequested = true;
      return activeRun;
    }
    activeRun = execute().finally(() => {
      activeRun = null;
      if (rerunRequested) {
        rerunRequested = false;
        setImmediate(() => tick());
      }
    });
    return activeRun;
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { getSettings, saveSettings, snapshot, tick, start, stop, runtime };
}

module.exports = {
  DEFAULT_AUTO_BID_SETTINGS,
  OTS_VEHICLES,
  normalizeAutoBidSettings,
  canonicalVehicle,
  dateKeyInTimeZone,
  tomorrowDateKey,
  dateMatchesScope,
  scopeLabel,
  settingsFingerprint,
  evaluateAutoBidJob,
  buildAutoBidPreview,
  createJobLinkerAutoBidRunner
};
