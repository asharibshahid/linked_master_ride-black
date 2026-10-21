(() => {
  "use strict";

  const PAGE_SIZE = 24;
  const BID_POLL_INTERVAL_MS = 2000;
  const BID_POLL_TIMEOUT_MS = 150000;
  const TOKEN_KEY = "aceDashboardToken";
  const ACTOR_KEY = "aceDashboardActor";
  const THEME_KEY = "aceDashboardTheme";
  const LONDON_POSTCODE_AREAS = new Set(["E", "EC", "N", "NW", "SE", "SW", "W", "WC"]);
  const UK_POSTCODE_AREAS = new Set([
    "AB", "AL", "B", "BA", "BB", "BD", "BH", "BL", "BN", "BR", "BS", "BT", "CA", "CB", "CF", "CH", "CM", "CO", "CR", "CT", "CV", "CW", "DA", "DD", "DE", "DG", "DH", "DL", "DN", "DT", "DY", "E", "EC", "EH", "EN", "EX", "FK", "FY", "G", "GL", "GU", "GY", "HA", "HD", "HG", "HP", "HR", "HS", "HU", "HX", "IG", "IM", "IP", "IV", "JE", "KA", "KT", "KW", "KY", "L", "LA", "LD", "LE", "LL", "LN", "LS", "LU", "M", "ME", "MK", "ML", "N", "NE", "NG", "NN", "NP", "NR", "NW", "OL", "OX", "PA", "PE", "PH", "PL", "PO", "PR", "RG", "RH", "RM", "S", "SA", "SE", "SG", "SK", "SL", "SM", "SN", "SO", "SP", "SR", "SS", "ST", "SW", "SY", "TA", "TD", "TF", "TN", "TQ", "TR", "TS", "TW", "UB", "W", "WA", "WC", "WD", "WF", "WN", "WR", "WS", "WV", "YO"
  ]);
  const CATEGORY_META = {
    saloon: { label: "Saloon" },
    estate: { label: "Estate Car" },
    other: { label: "People Carrier / Executive / MPV" }
  };
  const VIEW_META = {
    master: ["OTS LIVE JOBS", "Master", "All currently live OTS quotation requests."],
    bid: ["BID WORKSPACE", "Bid", "Persisted manual OTS submissions and confirmed outcomes."],
    prebook: ["CONFIRMED WORK", "PreBook", "Future confirmed bookings used as Linker anchors."],
    groups: ["UPCOMING SHEET", "Groups", "Upcoming jobs from the connected Google Sheet."],
    linker: ["RETURN MATCHING", "Linker", "Realistic return opportunities for confirmed bookings."],
    settings: ["ADMIN", "Settings", "Shared rules, source health, WhatsApp and recovery controls."]
  };

  const state = {
    apiBaseUrl: "",
    data: null,
    tab: "master",
    pages: { master: 1, bid: 1, prebook: 1, groups: 1, linker: 1 },
    selected: { master: new Set(), prebook: new Set(), groups: new Set() },
    mobileCategory: { master: "saloon", prebook: "saloon", groups: "saloon" },
    master: { preset: "all", mileage: "all", vehicle: "all", location: "all", fare: "all", from: "", to: "", sort: "pickupAsc" },
    groups: { preset: "all", mileage: "all", vehicle: "all", location: "all", fare: "all", from: "", to: "", sort: "pickupAsc" },
    prebookVehicle: "all",
    prebookLocation: "all",
    bidQuery: "",
    bidLocation: "all",
    linkerLocation: "all",
    reportPreset: "2",
    whatsappQrUrl: "",
    whatsappTimer: null,
    liveGroups: [],
    allowedGroupIds: new Set(),
    groupsLoaded: false,
    groupsLoading: false,
    submittingBids: new Set(),
    toastTimer: null
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const token = () => localStorage.getItem(TOKEN_KEY) || "";
  const actor = () => localStorage.getItem(ACTOR_KEY) || "Operator";
  const api = (path) => `${state.apiBaseUrl}${path}`;
  const headers = (json = false) => ({
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token() ? { "X-Dashboard-Token": token() } : {}),
    "X-Dashboard-Actor": actor()
  });

  function applyTheme(theme) {
    const selected = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = selected;
    localStorage.setItem(THEME_KEY, selected);
    const useLight = selected === "dark";
    const label = useLight ? "Use light theme" : "Use dark theme";
    $("#theme-icon").textContent = useLight ? "☀" : "☾";
    $("#theme-toggle").setAttribute("aria-label", label);
    $("#theme-toggle").title = label;
    $("meta[name='theme-color']").content = selected === "light" ? "#f3f5f6" : "#0f0f0d";
  }

  function numeric(value) {
    const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function money(value) {
    const amount = numeric(value);
    return amount === null ? "-" : `\u00a3${amount.toFixed(2)}`;
  }

  function positiveNumeric(value) {
    const amount = numeric(value);
    return amount !== null && amount > 0 ? amount : null;
  }

  function distanceLabel(value) {
    const miles = positiveNumeric(value);
    return miles === null ? "Distance missing" : `${miles} mi`;
  }

  function guidePrice(job = {}) {
    const minimum = positiveNumeric(job.guidePriceMin);
    const maximum = positiveNumeric(job.guidePriceMax);
    if (minimum !== null && maximum !== null) return `${money(minimum)} - ${money(maximum)}`;
    if (minimum !== null) return `From ${money(minimum)}`;
    return "Guide unavailable";
  }

  function defaultBidAmount(job = {}) {
    const maximum = positiveNumeric(job.guidePriceMax);
    if (maximum !== null) return Math.max(0.01, Math.round((maximum - 5) * 100) / 100);
    return positiveNumeric(job.guidePriceMin) ?? "";
  }

  function dateValue(value, fallback = Number.POSITIVE_INFINITY) {
    const result = new Date(value || "").getTime();
    return Number.isFinite(result) ? result : fallback;
  }

  function formatUkDateTime(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "Date missing";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const month = parts.month === "Sep" ? "Sept" : parts.month;
    return `${parts.weekday}, ${parts.day} ${month} ${parts.year}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod || "").toLowerCase()}`;
  }

  function pickupLabel(job) {
    const label = job.pickupAt ? formatUkDateTime(job.pickupAt) : [job.pickupDayDate, job.startingTiming].filter(Boolean).join(", ") || "Date missing";
    const hours = Number(String(job.startingTiming || "").match(/^(\d{2}):\d{2}$/)?.[1]);
    if (job.sourceType !== "PreBook" || !job.pickupAt || !job.pickupDayDate || !Number.isFinite(hours) || hours < 24) return label;
    const days = Math.floor(hours / 24);
    return `${label} (Sheet date ${job.pickupDayDate} + ${days} ${days === 1 ? "day" : "days"})`;
  }

  function durationLabel(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
    return milliseconds < 60_000 ? `${(milliseconds / 1000).toFixed(1)} sec` : `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
  }

  function bidTimingLine(bid = {}) {
    const sentAt = bid.submitActivatedAt;
    const completedAt = bid.completedAt;
    const workerDuration = durationLabel(bid.processingDurationMs || bid.workerTiming?.totalMs);
    const totalDuration = durationLabel(bid.totalDurationMs);
    if (sentAt || completedAt) {
      return [
        sentAt ? `Bid sent ${formatUkDateTime(sentAt)}` : `Completed ${formatUkDateTime(completedAt)}`,
        workerDuration ? `OTS worker ${workerDuration}` : "",
        totalDuration && totalDuration !== workerDuration ? `total ${totalDuration}` : ""
      ].filter(Boolean).join(" | ");
    }
    if (bid.attemptedAt) return `OTS worker started ${formatUkDateTime(bid.attemptedAt)}`;
    if (bid.queuedAt) return `Queued ${formatUkDateTime(bid.queuedAt)}`;
    return "";
  }

  function otsSyncSummary(source = {}) {
    const seen = Number(source.otsRowsSeen || 0);
    const accepted = Number(source.otsRowsImported || 0);
    const added = Number(source.otsRowsAdded || 0);
    const updated = Number(source.otsRowsUpdated || Math.max(0, accepted - added));
    const removed = Number(source.otsRowsRemoved || 0);
    const last = source.otsLastSyncAt ? formatUkDateTime(source.otsLastSyncAt) : "Waiting";
    return `Last OTS update: ${last}. Source loaded: ${accepted} of ${seen || accepted}. New added: ${added}. Updated: ${updated}. Removed/deleted from Master: ${removed}.`;
  }

  function londonDateKey(value = new Date()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function shiftDateKey(key, days) {
    const date = new Date(`${key}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function londonWeekday() {
    return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[
      new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(new Date())
    ] || 1;
  }

  function monthEnd(key) {
    const [year, month] = key.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }

  function categoryFor(job) {
    const label = String(job.requiredVehicle || job.vehicle || "").toLowerCase();
    if (label.includes("estate")) return "estate";
    if (label.includes("saloon") || label.includes("sedan")) return "saloon";
    return "other";
  }

  function postcodeAreas(value) {
    const matches = String(value || "").toUpperCase().matchAll(/\b([A-Z]{1,2})\d{1,2}[A-Z]?(?:\s*\d[A-Z]{2})?\b/g);
    return [...matches].map((match) => match[1]).filter((area) => UK_POSTCODE_AREAS.has(area));
  }

  function locationClassForValues(...values) {
    const areas = values.flatMap(postcodeAreas);
    if (areas.some((area) => LONDON_POSTCODE_AREAS.has(area))) return "inside";
    if (areas.length > 0) return "outside";
    return "unknown";
  }

  function locationClassForJob(job = {}) {
    return locationClassForValues(job.pickup, job.dropOff || job.drop_off);
  }

  function locationClassForLink(link = {}) {
    const anchor = jobById(link.anchorRideId || link.firstRideId);
    const candidate = jobById(link.candidateRideId || link.secondRideId);
    return locationClassForValues(anchor.pickup, anchor.dropOff, candidate.pickup, candidate.dropOff);
  }

  function locationMatches(value, filter) {
    return filter === "all" || value === filter;
  }

  function locationBadge(locationClass) {
    const labels = { inside: "Inside London", outside: "Outside London", unknown: "Area unknown" };
    return `<span class="location-pill ${locationClass}">${labels[locationClass] || labels.unknown}</span>`;
  }

  function inNumericBand(value, band) {
    if (band === "all") return true;
    const number = numeric(value);
    if (number === null) return false;
    if (band.endsWith("+")) return number >= Number(band.slice(0, -1));
    const [min, max] = band.split("-").map(Number);
    return number >= min && number <= max;
  }

  function showNotice(message, type = "") {
    const element = $("#notice");
    element.textContent = message;
    element.className = `notice${type ? ` ${type}` : ""}`;
  }

  function clearNotice() {
    $("#notice").className = "notice hidden";
  }

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.remove("hidden");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.add("hidden"), 2800);
  }

  function showLogin() {
    const dialog = $("#login-dialog");
    if (!dialog.open) dialog.showModal();
  }

  async function request(path, options = {}) {
    const response = await fetch(api(path), {
      cache: "no-store",
      ...options,
      headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showLogin();
      throw new Error("Dashboard access token required.");
    }
    if (!response.ok || body.ok === false) {
      const error = new Error(body.message || `Request failed (${response.status}).`);
      error.code = body.code || "REQUEST_FAILED";
      error.payload = body;
      throw error;
    }
    return body;
  }

  async function load() {
    if (!state.data) showNotice("Loading live workspace...");
    try {
      state.data = await request("/api/job-linker");
      $("#live-status").innerHTML = `<span class="status-dot"></span><span>Live ${esc(formatUkDateTime(state.data.generatedAt))}</span>`;
      $("#live-status").className = "connection ok";
      $("#operator-name").textContent = actor();
      clearNotice();
      renderAll();
    } catch (error) {
      $("#live-status").innerHTML = `<span class="status-dot"></span><span>Connection issue</span>`;
      $("#live-status").className = "connection bad";
      showNotice(error.message, "error");
    }
  }

  async function post(path, body, progress, success) {
    try {
      showNotice(`${progress}...`);
      const result = await request(path, { method: "POST", body: JSON.stringify(body || {}) });
      await load();
      showNotice(result.message || success || `${progress} completed.`);
      return true;
    } catch (error) {
      showNotice(error.message, "error");
      return false;
    }
  }

  function setTab(tab, updateHash = true) {
    if (!VIEW_META[tab]) tab = "master";
    state.tab = tab;
    $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    $$(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === tab));
    const meta = VIEW_META[tab];
    $("#eyebrow").textContent = meta[0];
    $("#page-title").textContent = meta[1];
    $("#page-description").textContent = meta[2];
    if (updateHash) history.replaceState(null, "", `#${tab}`);
    if (tab === "settings") {
      startWhatsAppPolling();
      if (!state.groupsLoaded && !state.groupsLoading) loadGroupManager();
    } else {
      stopWhatsAppPolling();
    }
  }

  function allJobs() {
    if (!state.data) return [];
    return [...(state.data.master || []), ...(state.data.prebook || []), ...(state.data.groups || [])];
  }

  function jobById(id) {
    return allJobs().find((job) => job.rideId === id) || {};
  }

  function linkForJob(id) {
    return (state.data?.links || []).find((link) => link.candidateRideId === id || link.secondRideId === id || link.anchorRideId === id || link.firstRideId === id) || null;
  }

  function bidForRide(id) {
    return (state.data?.bids || []).find((bid) => bid.rideId === id) || null;
  }

  function bidBlocksSubmission(bid) {
    if (!bid) return false;
    return !["suggested", "approved", "failed", "submission failed", "submission unconfirmed"].includes(String(bid.bidStatus || "").toLowerCase());
  }

  function jobFromBid(bid = {}) {
    return {
      rideId: bid.rideId || bid.otsReference,
      sourceType: bid.source || "OTS",
      sourceName: bid.sourceName || "OTS",
      pickupDayDate: bid.pickupDayDate,
      startingTiming: bid.startingTiming,
      pickupAt: bid.pickupAt,
      pickup: bid.pickup,
      dropOff: bid.dropOff,
      requiredVehicle: bid.requiredVehicle,
      distance: bid.distance,
      fare: bid.originalFare,
      passengerCount: bid.passengerCount,
      luggageDetails: bid.luggageDetails,
      guidePriceMin: bid.guidePriceMin,
      guidePriceMax: bid.guidePriceMax,
      guidePriceText: bid.guidePriceText,
      copyDetail: bid.copyDetail
    };
  }

  function linkedRecommendation(link) {
    if (!link) return `<div class="link-recommendation">No linked return opportunity currently detected.</div>`;
    const source = link.candidateSource || "eligible source";
    const saving = link.savingEstimate === null || link.savingEstimate === undefined ? "saving not supplied" : `estimated saving ${money(link.savingEstimate)}`;
    return `<div class="link-recommendation"><strong>Linked ${esc(link.score)}/100</strong> - ${esc(source)}, ${esc(link.direction || "return direction")}; ${esc(link.distanceBetween || "deadhead unavailable")} deadhead, ${esc(link.timeGap || "gap unavailable")} gap, ${esc(saving)}.<br>${esc(link.reason || "Passed current Linker rules.")}</div>`;
  }

  function searchMatches(job, query) {
    if (!query) return true;
    return [job.rideId, job.sourceName, job.sourceType, job.pickup, job.dropOff, job.requiredVehicle]
      .join(" ").toLowerCase().includes(query);
  }

  function sortJobs(rows, sort = "pickupAsc") {
    return rows.slice().sort((left, right) => {
      if (sort === "pickupDesc") return dateValue(right.pickupAt, 0) - dateValue(left.pickupAt, 0) || String(left.rideId).localeCompare(String(right.rideId));
      if (sort === "fareDesc") return (numeric(right.fare) || 0) - (numeric(left.fare) || 0) || dateValue(left.pickupAt) - dateValue(right.pickupAt);
      if (sort === "newest") return dateValue(right.sourceTime || right.createdAt, 0) - dateValue(left.sourceTime || left.createdAt, 0);
      return dateValue(left.pickupAt) - dateValue(right.pickupAt) || String(left.rideId).localeCompare(String(right.rideId));
    });
  }

  function filteredMaster() {
    const query = $("#master-search").value.trim().toLowerCase();
    const today = londonDateKey();
    const weekEnd = shiftDateKey(today, 7 - londonWeekday());
    const filter = state.master;
    const rows = (state.data?.master || []).filter((job) => {
      if (job.eligible === false || !searchMatches(job, query)) return false;
      if (bidBlocksSubmission(bidForRide(job.rideId))) return false;
      if (!locationMatches(locationClassForJob(job), filter.location)) return false;
      const pickupKey = londonDateKey(job.pickupAt);
      if (filter.preset === "upcoming" && (!pickupKey || pickupKey < today || pickupKey > weekEnd)) return false;
      if (filter.preset === "future" && (!pickupKey || pickupKey <= weekEnd)) return false;
      if (filter.preset === "highFare" && (numeric(job.fare) || 0) < 100) return false;
      if (filter.from && (!pickupKey || pickupKey < filter.from)) return false;
      if (filter.to && (!pickupKey || pickupKey > filter.to)) return false;
      if (!inNumericBand(job.distance, filter.mileage) || !inNumericBand(job.fare, filter.fare)) return false;
      if (filter.vehicle !== "all" && categoryFor(job) !== filter.vehicle) return false;
      return true;
    });
    return sortJobs(rows, filter.sort);
  }

  function filteredPrebook() {
    const query = $("#prebook-search").value.trim().toLowerCase();
    const rows = (state.data?.prebook || []).filter((job) => {
      if (!searchMatches(job, query)) return false;
      if (dateValue(job.pickupAt, 0) < Date.now()) return false;
      if (!locationMatches(locationClassForJob(job), state.prebookLocation)) return false;
      return state.prebookVehicle === "all" || categoryFor(job) === state.prebookVehicle;
    });
    return sortJobs(rows, "pickupAsc");
  }

  function filteredGroups() {
    const query = $("#groups-search").value.trim().toLowerCase();
    const today = londonDateKey();
    const weekEnd = shiftDateKey(today, 7 - londonWeekday());
    const filter = state.groups;
    const rows = (state.data?.groups || []).filter((job) => {
      if (!searchMatches(job, query)) return false;
      if (!locationMatches(locationClassForJob(job), filter.location)) return false;
      const pickupKey = londonDateKey(job.pickupAt);
      if (filter.preset === "upcoming" && (!pickupKey || pickupKey < today || pickupKey > weekEnd)) return false;
      if (filter.preset === "future" && (!pickupKey || pickupKey <= weekEnd)) return false;
      if (filter.preset === "highFare" && (numeric(job.fare) || 0) < 100) return false;
      if (filter.from && (!pickupKey || pickupKey < filter.from)) return false;
      if (filter.to && (!pickupKey || pickupKey > filter.to)) return false;
      if (!inNumericBand(job.distance, filter.mileage) || !inNumericBand(job.fare, filter.fare)) return false;
      if (filter.vehicle !== "all" && categoryFor(job) !== filter.vehicle) return false;
      return true;
    });
    return sortJobs(rows, filter.sort);
  }

  function paginate(rows, key) {
    const total = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.pages[key] = Math.min(Math.max(1, state.pages[key]), total);
    const page = state.pages[key];
    return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, total, count: rows.length };
  }

  function renderPager(key, result) {
    const element = $(`#${key}-pager`);
    if (!element) return;
    element.innerHTML = result.total <= 1 ? "" : `<button class="button" type="button" data-page-key="${key}" data-page="${result.page - 1}" ${result.page === 1 ? "disabled" : ""}>Previous</button><span>Page ${result.page} of ${result.total} - ${result.count} jobs</span><button class="button" type="button" data-page-key="${key}" data-page="${result.page + 1}" ${result.page === result.total ? "disabled" : ""}>Next</button>`;
  }

  function jobCard(job, key) {
    const category = categoryFor(job);
    const linked = linkForJob(job.rideId);
    const existingBid = bidForRide(job.rideId);
    const bidLocked = bidBlocksSubmission(existingBid);
    const submitting = state.submittingBids.has(job.rideId);
    const selected = state.selected[key]?.has(job.rideId);
    const expiry = job.expiresAt || job.sourceExpiresAt || job.offerExpiresAt;
    const bidValue = existingBid?.bidAmount ?? defaultBidAmount(job);
    const guideLine = key === "master" && job.guidePriceText ? `<div class="guide-line">${esc(job.guidePriceText)}</div>` : "";
    const bidHistory = existingBid ? `<div class="bid-history">Persisted bid <b>${money(existingBid.bidAmount)}</b> - ${esc(existingBid.bidStatus || existingBid.submissionState || "Created")}</div>` : "";
    const masterActions = key === "master" ? `<div class="card-actions"><input class="bid-amount" type="number" min="0.01" step="0.01" value="${esc(bidValue)}" data-bid-amount="${esc(job.rideId)}" aria-label="Bid amount for ${esc(job.rideId)}" ${bidLocked || submitting ? "disabled" : ""}><button class="button primary" type="button" data-submit-bid="${esc(job.rideId)}" ${bidLocked || submitting ? "disabled" : ""}>${submitting ? "Submitting" : bidLocked ? esc(existingBid.bidStatus || "Saved") : existingBid ? "Submit" : "Bid"}</button><button class="button copy-button" type="button" data-copy-job="${esc(job.rideId)}">Copy Detail</button></div>${bidLocked ? "" : `<input class="bid-reason" type="text" maxlength="240" data-bid-reason="${esc(job.rideId)}" value="${esc(existingBid?.reason || "")}" placeholder="Reason (optional)">`}` : `<div class="card-actions compact-actions"><button class="button copy-button" type="button" data-copy-job="${esc(job.rideId)}">Copy Detail</button></div>`;
    return `<article class="job-card ${category}${linked ? " linked" : ""}">
      <div class="job-card-head"><input type="checkbox" data-select-key="${key}" data-id="${esc(job.rideId)}" ${selected ? "checked" : ""} aria-label="Select ${esc(job.rideId)}"><div class="job-ref">${esc(job.rideId || "Reference missing")}</div><span class="job-source">${esc(job.sourceName || job.sourceType || key)}</span></div>
      <div class="job-time">${esc(pickupLabel(job))}</div>
      <div class="job-route"><div class="route-track"><span></span></div><div class="route-points"><div><small>Pickup</small><strong>${esc(job.pickup || "Pickup missing")}</strong></div><div><small>Drop-off</small><strong>${esc(job.dropOff || "Drop-off missing")}</strong></div></div></div>
      <div class="job-meta"><span><b>${esc(job.requiredVehicle || job.vehicle || "Vehicle missing")}</b></span><span>${esc(distanceLabel(job.distance))}</span><span class="fare">${esc(key === "master" ? guidePrice(job) : money(job.fare))}</span>${locationBadge(locationClassForJob(job))}<span class="status-pill ${job.eligible === false ? "bad" : ""}">${key === "master" ? "Live" : job.eligible === false ? "Review" : "Eligible"}</span></div>
      ${guideLine}
      ${expiry ? `<div class="expiry">Expires ${esc(formatUkDateTime(expiry))}</div>` : ""}${key === "master" ? linkedRecommendation(linked) : linked ? linkedRecommendation(linked) : ""}${bidHistory}${masterActions}
    </article>`;
  }

  function renderMobileCategories(key, grouped) {
    const element = document.querySelector(`[data-mobile-tabs="${key}"]`);
    element.innerHTML = Object.entries(CATEGORY_META).map(([category, meta]) => `<button type="button" data-mobile-category="${category}" data-mobile-key="${key}" class="${state.mobileCategory[key] === category ? "active" : ""}">${esc(meta.label)} (${grouped[category].length})</button>`).join("");
  }

  function renderJobColumns(key, rows) {
    const page = paginate(rows, key);
    const grouped = { saloon: [], estate: [], other: [] };
    page.rows.forEach((job) => grouped[categoryFor(job)].push(job));
    renderMobileCategories(key, grouped);
    $(`#${key}-columns`).innerHTML = Object.entries(CATEGORY_META).map(([category, meta]) => `<section class="job-column ${state.mobileCategory[key] === category ? "mobile-active" : ""}" data-category="${category}"><div class="column-title"><span></span><strong>${esc(meta.label)}</strong><span class="count">${grouped[category].length}</span></div><div class="job-stack">${grouped[category].length ? grouped[category].map((job) => jobCard(job, key)).join("") : `<div class="column-empty">No matching jobs.</div>`}</div></section>`).join("");
    renderPager(key, page);
    updateBulkState(key);
  }

  function updateBulkState(key) {
    const count = state.selected[key].size;
    $(`#${key}-bulk`).classList.toggle("hidden", count === 0);
    $(`#${key}-selected-count`).textContent = `${count} selected`;
  }

  function renderMaster() {
    const source = state.data?.sourceStatus || {};
    const failed = Boolean(source.otsLastError);
    const ready = Boolean(source.otsEnabled && source.otsLastSyncAt && !failed);
    const banner = $("#master-source-banner");
    banner.classList.toggle("source-error", failed);
    banner.innerHTML = `<div><strong>${failed ? "OTS source needs attention" : ready ? "Live OTS source connected" : source.otsEnabled ? "OTS source is starting" : "OTS source is not configured"}</strong><span>${failed ? esc(source.otsLastError) : ready ? esc(otsSyncSummary(source)) : "Master displays the complete live OTS inventory after source synchronization."}</span></div><span class="status-pill ${ready ? "" : failed ? "bad" : "warn"}">${ready ? "Live" : failed ? "Error" : "Waiting"}</span>`;
    const rows = filteredMaster();
    const linkedCount = rows.filter((job) => linkForJob(job.rideId)).length;
    const fareValue = rows.reduce((total, job) => total + (positiveNumeric(job.guidePriceMin) || 0), 0);
    $("#master-summary").innerHTML = `<div class="stat"><strong>${rows.length}</strong><span>Jobs shown</span></div><div class="stat"><strong>${Number(source.otsRowsAdded || 0)}</strong><span>New OTS rides last sync</span></div><div class="stat"><strong>${Number(source.otsRowsRemoved || 0)}</strong><span>Removed/deleted last sync</span></div><div class="stat"><strong>${linkedCount}</strong><span>Linked opportunities</span></div><div class="stat"><strong>${money(fareValue)}</strong><span>Visible guide minimum</span></div>`;
    renderJobColumns("master", rows);
  }

  function bidStatusClass(bid) {
    const status = String(bid.bidStatus || bid.submissionState || "").toLowerCase();
    if (status.includes("fail")) return "failed";
    if (status.includes("confirm")) return "confirmed";
    return "";
  }

  function renderBids() {
    const query = state.bidQuery.trim().toLowerCase();
    const allRows = (state.data?.bids || []).slice().sort((left, right) => dateValue(right.createdAt || right.updatedAt, 0) - dateValue(left.createdAt || left.updatedAt, 0));
    const rows = allRows.filter((bid) => {
      if (!locationMatches(locationClassForJob(bid), state.bidLocation)) return false;
      return !query || [bid.otsReference, bid.rideId, bid.pickup, bid.dropOff, bid.requiredVehicle, bid.bidType, bid.bidStatus, bid.submissionState, bid.bidAmount, bid.reason].join(" ").toLowerCase().includes(query);
    });
    const page = paginate(rows, "bid");
    const submitted = allRows.filter((bid) => ["submitted", "unconfirmed"].includes(String(bid.bidStatus).toLowerCase())).length;
    const confirmed = allRows.filter((bid) => String(bid.bidStatus).toLowerCase() === "confirmed").length;
    $("#bid-summary").innerHTML = `<div class="stat"><strong>${rows.length}</strong><span>Bids shown</span></div><div class="stat"><strong>${submitted}</strong><span>Submitted, unconfirmed</span></div><div class="stat"><strong>${confirmed}</strong><span>Confirmed in PreBook</span></div>`;
    $("#bid-list").innerHTML = page.rows.length ? page.rows.map((bid) => {
      const job = jobFromBid(bid);
      const timingLine = bidTimingLine(bid);
      return `<article class="bid-card ${bidStatusClass(bid)}">
        <div class="bid-cell bid-reference"><div class="job-ref">${esc(bid.otsReference || bid.rideId || "Reference missing")}</div><span class="job-source">${esc(String(bid.bidType || "").includes("Auto") ? "AUTO BID" : bid.source || "OTS")}</span><div class="bid-vehicle">${esc(bid.requiredVehicle || "Vehicle missing")}</div>${locationBadge(locationClassForJob(bid))}</div>
        <div class="bid-cell bid-time"><small>Date &amp; time</small><strong>${esc(pickupLabel(job))}</strong></div>
        <div class="bid-cell bid-pickup"><small>Pickup</small><strong>${esc(bid.pickup || "Pickup missing")}</strong></div>
        <div class="bid-cell bid-dropoff"><small>Drop-off</small><strong>${esc(bid.dropOff || "Drop-off missing")}</strong></div>
        <div class="bid-cell bid-numbers"><small>${esc(distanceLabel(bid.distance))}</small><strong>Bid ${money(bid.bidAmount)}</strong></div>
        <div class="bid-cell bid-status-cell"><div class="bid-state"><span class="status-pill ${bidStatusClass(bid) === "failed" ? "bad" : bidStatusClass(bid) ? "" : "warn"}">${esc(bid.bidStatus || "Created")}</span><span class="status-pill warn">${esc(bid.submissionState || "pending")}</span></div>${timingLine ? `<div class="bid-timing">${esc(timingLine)}</div>` : ""}<div class="bid-result">${esc(bid.submissionResult || bid.reason || "Awaiting a provider or booking signal.")}</div><div class="card-actions compact-actions"><button class="button copy-button" type="button" data-copy-bid="${esc(bid.bidId)}">Copy Detail</button></div></div>
      </article>`;
    }).join("") : `<div class="empty">No persisted bids yet. Submit one manually from Master.</div>`;
    renderPager("bid", page);
  }

  function renderPrebook() {
    const source = state.data?.sourceStatus || {};
    const failed = Boolean(source.prebookLastError);
    const live = !failed && source.prebookMode && source.prebookMode !== "demo";
    const banner = $("#prebook-banner");
    banner.classList.toggle("source-error", failed);
    banner.innerHTML = `<div><strong>${failed ? "PreBook source needs attention" : live ? "Live PreBook sheet connected" : "PreBook source is not live"}</strong><span>${esc(failed ? source.prebookLastError : source.prebookMessage || "Future confirmed jobs are shown here.")}</span></div><span class="status-pill ${live ? "" : failed ? "bad" : "warn"}">${live ? "Live" : failed ? "Error" : esc(source.prebookMode || "Waiting")}</span>`;
    renderJobColumns("prebook", filteredPrebook());
  }

  function renderGroups() {
    const source = state.data?.sourceStatus || {};
    const rows = state.data?.groups || [];
    const failed = Boolean(source.whatsappSheetLastError);
    const sheetLive = !failed && source.whatsappSheetEnabled && source.whatsappSheetMode !== "off";
    const latestReceived = rows.reduce((latest, job) => {
      const value = dateValue(job.sourceTime || job.createdAt, 0);
      return value > latest ? value : latest;
    }, 0);
    const available = rows.length > 0;
    const banner = $("#groups-banner");
    banner.classList.toggle("source-error", failed);
    const title = failed
      ? "Groups sheet needs attention"
      : available
        ? "Upcoming sheet jobs available"
        : sheetLive
          ? "Upcoming sheet connected"
          : "Groups sheet is starting";
    const detail = failed
      ? `${source.whatsappSheetLastError}${source.whatsappSheetLastSyncAt ? ` Last successful sync ${formatUkDateTime(source.whatsappSheetLastSyncAt)}.` : ""}`
      : available
        ? `${rows.length} upcoming sheet jobs${source.whatsappSheetLastSyncAt ? `; synced ${formatUkDateTime(source.whatsappSheetLastSyncAt)}` : ""}. Direct WhatsApp rides are hidden here.`
        : source.whatsappSheetMessage || "Waiting for upcoming sheet jobs.";
    banner.innerHTML = `<div><strong>${esc(title)}</strong><span>${esc(detail)}</span></div><span class="status-pill ${failed ? "bad" : available || sheetLive ? "" : "warn"}">${failed ? "Error" : available ? "Available" : sheetLive ? "Live" : "Waiting"}</span>`;
    renderJobColumns("groups", filteredGroups());
  }

  function firstDayOfMonth(key) {
    return `${key.slice(0, 7)}-01`;
  }

  function setReportRange(preset = state.reportPreset) {
    const today = londonDateKey();
    state.reportPreset = preset;
    let from = $("#report-from").value;
    let to = $("#report-to").value;
    if (preset === "month") {
      from = firstDayOfMonth(today);
      to = today;
    } else if (/^\d+$/.test(preset)) {
      from = shiftDateKey(today, -(Number(preset) - 1));
      to = today;
    }
    $("#report-from").value = from || today;
    $("#report-to").value = to || today;
    $$('[data-report-preset]').forEach((button) => button.classList.toggle("active", button.dataset.reportPreset === preset));
  }

  function inReportRange(value, from, to) {
    const key = londonDateKey(value);
    return Boolean(key && key >= from && key <= to);
  }

  function downloadOperationsReport() {
    const from = $("#report-from").value;
    const to = $("#report-to").value;
    if (!from || !to || from > to) {
      showNotice("Choose a valid report date range.", "error");
      return;
    }
    if (!window.OtsSupplierReport?.download) {
      showNotice("PDF report module is unavailable. Refresh the dashboard and try again.", "error");
      return;
    }
    const received = allJobs().filter((job) => ["OTS", "WhatsApp"].includes(job.sourceType) && inReportRange(job.createdAt || job.sourceTime, from, to));
    const bids = (state.data?.bids || []).filter((bid) => inReportRange(bid.createdAt, from, to));
    const links = (state.data?.links || []).filter((link) => {
      const anchor = jobById(link.anchorRideId || link.firstRideId);
      return inReportRange(link.createdAt || anchor.pickupAt, from, to);
    });
    const otsCount = received.filter((job) => job.sourceType === "OTS").length;
    const whatsappCount = received.filter((job) => job.sourceType === "WhatsApp").length;
    const manualCount = bids.filter((bid) => !String(bid.bidType || "").includes("Auto")).length;
    const autoCount = bids.length - manualCount;
    window.OtsSupplierReport.download({
      from,
      to,
      generatedAt: formatUkDateTime(new Date()),
      metrics: [
        { label: "OTS rides received", value: otsCount },
        { label: "WhatsApp rides received", value: whatsappCount },
        { label: "Manual bids", value: manualCount },
        { label: "Auto bids", value: autoCount },
        { label: "Linker suggestions", value: links.length }
      ],
      rides: received.sort((left, right) => dateValue(left.createdAt || left.sourceTime, 0) - dateValue(right.createdAt || right.sourceTime, 0)).map((job) => ({
        source: job.sourceType,
        created: formatUkDateTime(job.createdAt || job.sourceTime),
        reference: job.rideId,
        pickup: job.pickup,
        dropOff: job.dropOff,
        vehicle: job.requiredVehicle,
        milesFare: `${distanceLabel(job.distance)} / ${job.sourceType === "OTS" ? guidePrice(job) : money(job.fare)}`
      })),
      bids: bids.sort((left, right) => dateValue(left.createdAt, 0) - dateValue(right.createdAt, 0)).map((bid) => ({
        created: formatUkDateTime(bid.createdAt),
        type: String(bid.bidType || "").includes("Auto") ? "Auto" : "Manual",
        reference: bid.otsReference || bid.rideId,
        route: `${bid.pickup || ""} -> ${bid.dropOff || ""}`,
        amount: money(bid.bidAmount),
        status: bid.bidStatus || bid.submissionState,
        reason: bid.reason || bid.submissionResult
      })),
      links: links.map((link) => {
        const anchor = jobById(link.anchorRideId || link.firstRideId);
        const candidate = jobById(link.candidateRideId || link.secondRideId);
        return {
          created: formatUkDateTime(link.createdAt || anchor.pickupAt),
          references: `${link.anchorRideId || link.firstRideId} / ${link.candidateRideId || link.secondRideId}`,
          route: `${anchor.pickup || ""} -> ${anchor.dropOff || ""}; ${candidate.pickup || ""} -> ${candidate.dropOff || ""}`,
          deadhead: `${link.distanceBetween || "-"}; ${link.timeGap || "-"}`,
          score: link.score,
          reason: link.reason
        };
      })
    });
    showNotice(`PDF operations report downloaded for ${from} to ${to}.`);
  }

  function renderLinks() {
    const source = state.data?.sourceStatus || {};
    const failed = Boolean(source.linkerLastError || source.prebookLastError);
    const overview = document.querySelector(".linker-overview");
    const possible = (state.data?.possibleLinks || []).filter((link) => locationMatches(locationClassForLink(link), state.linkerLocation));
    const prebook = state.data?.prebook || [];
    const missingPickupTimes = prebook.filter((job) => !job.pickupAt).length;
    overview.classList.toggle("source-error", failed);
    $("#linker-source-message").textContent = failed
      ? source.linkerLastError || "Linker is unavailable because PreBook could not synchronize."
      : possible.length
        ? `${possible.length} possible ${possible.length === 1 ? "opportunity" : "opportunities"} needs manual review. These are not strict links.`
        : `Checked ${prebook.length} PreBook bookings against other confirmed PreBook bookings, current OTS and upcoming sheet jobs.${missingPickupTimes ? ` ${missingPickupTimes} have no usable pickup time.` : ""}`;
    const current = (link) => dateValue(jobById(link.secondRideId).pickupAt, 0) > Date.now();
    const rows = (state.data?.links || []).filter((link) => current(link) && locationMatches(locationClassForLink(link), state.linkerLocation)).sort((left, right) => dateValue(jobById(left.anchorRideId).pickupAt) - dateValue(jobById(right.anchorRideId).pickupAt) || String(left.linkId).localeCompare(String(right.linkId)));
    const page = paginate(rows, "linker");
    $("#link-count").textContent = `${rows.length} ${rows.length === 1 ? "link" : "links"}`;
    $("#link-nav-count").textContent = String(rows.length);
    $("#link-list").innerHTML = page.rows.length ? page.rows.map((link) => {
      const anchor = jobById(link.anchorRideId || link.firstRideId);
      const candidate = jobById(link.candidateRideId || link.secondRideId);
      const score = link.scoreBreakdown || {};
      return `<article class="link-card">
        <div><div class="link-score">${esc(link.score)}<small>/100</small></div><span class="status-pill">Linked</span>${locationBadge(locationClassForLink(link))}</div>
        <div class="link-leg"><span class="label">Booked anchor - ${esc(link.anchorRideId || link.firstRideId)}</span><strong>${esc(anchor.pickup || "Pickup missing")} &rarr; ${esc(anchor.dropOff || link.previousDrop || "Drop-off missing")}</strong><small>${esc(pickupLabel(anchor))} - ${esc(anchor.requiredVehicle || "Vehicle missing")}</small></div>
        <div class="link-arrow">&rarr;</div>
        <div class="link-leg"><span class="label">${esc(link.candidateSource === "PreBook" ? "Confirmed return" : link.candidateSource || candidate.sourceType || "Candidate")} - ${esc(link.candidateRideId || link.secondRideId)}</span><strong>${esc(candidate.pickup || link.nextPickup || "Pickup missing")} &rarr; ${esc(candidate.dropOff || "Drop-off missing")}</strong><small>${esc(pickupLabel(candidate))} - ${esc(link.timeGap || "Gap missing")}</small></div>
        <div class="link-outcome"><strong>${link.savingEstimate === null || link.savingEstimate === undefined ? "Saving pending" : `Estimated saving ${money(link.savingEstimate)}`}</strong><p>${esc(link.direction || "Return direction")} - deadhead ${esc(link.distanceBetween || "not available")}</p><div class="score-breakdown"><span>Deadhead ${esc(score.deadhead ?? 0)}</span><span>Availability ${esc(score.availability ?? 0)}</span><span>Return ${esc(score.returnDirection ?? 0)}</span><span>Vehicle ${esc(score.vehicle ?? 0)}</span></div><p>${esc(link.reason || "Match passed current Linker rules.")}</p><button class="button ghost" type="button" data-archive-link="${esc(link.linkId)}">Archive</button></div>
      </article>`;
    }).join("") : `<div class="empty">No strict return link is available.</div>`;
    $("#possible-links").innerHTML = `<div class="possible-links-head"><span class="section-kicker">POSSIBLE RETURNS</span><strong>${possible.length} possible | Manual review only</strong><p>These are feasible same-vehicle sequences but did not pass the strict return-match rules. They never trigger Auto Bid.</p></div>${possible.length ? `<div class="link-list">${possible.map((link) => {
      const anchor = jobById(link.anchorRideId || link.firstRideId);
      const candidate = jobById(link.candidateRideId || link.secondRideId);
      const score = link.scoreBreakdown || {};
      return `<article class="link-card possible">
        <div><div class="link-score">${esc(link.score)}<small>/100</small></div><span class="status-pill warn">Review only</span>${locationBadge(locationClassForLink(link))}</div>
        <div class="link-leg"><span class="label">Booked anchor - ${esc(link.anchorRideId || link.firstRideId)}</span><strong>${esc(anchor.pickup || "Pickup missing")} &rarr; ${esc(anchor.dropOff || link.previousDrop || "Drop-off missing")}</strong><small>${esc(pickupLabel(anchor))} - ${esc(anchor.requiredVehicle || "Vehicle missing")}</small></div>
        <div class="link-arrow">&rarr;</div>
        <div class="link-leg"><span class="label">${esc(link.candidateSource || candidate.sourceType || "Candidate")} - ${esc(link.candidateRideId || link.secondRideId)}</span><strong>${esc(candidate.pickup || link.nextPickup || "Pickup missing")} &rarr; ${esc(candidate.dropOff || "Drop-off missing")}</strong><small>${esc(pickupLabel(candidate))} - ${esc(link.timeGap || "Gap missing")}</small></div>
        <div class="link-outcome"><strong>Manual review required</strong><p>Deadhead ${esc(link.distanceBetween || "not available")}</p><div class="score-breakdown"><span>Deadhead ${esc(score.deadhead ?? 0)}</span><span>Availability ${esc(score.availability ?? 0)}</span><span>Return ${esc(score.returnDirection ?? 0)}</span><span>Vehicle ${esc(score.vehicle ?? 0)}</span></div><p>${esc(link.reason || "Does not pass the strict return-match rules.")}</p><button class="button ghost" type="button" data-archive-link="${esc(link.linkId)}">Archive</button></div>
      </article>`;
    }).join("")}</div>` : `<div class="empty">No reviewed return suggestion passed the current route checks.</div>`}`;
    const archived = (state.data?.archivedLinks || []).filter((link) => current(link) && locationMatches(locationClassForLink(link), state.linkerLocation));
    $("#archived-links").innerHTML = `<details><summary>Archived (${archived.length})</summary>${archived.length ? `<div class="archived-link-list">${archived.map((link) => `<div class="archived-link-row"><strong>${esc(link.anchorRideId)} &rarr; ${esc(link.candidateRideId)}</strong><span>${esc(pickupLabel(jobById(link.secondRideId)))} - ${esc(link.score)}/100</span><button class="button ghost" type="button" data-unarchive-link="${esc(link.linkId)}">Unarchive</button></div>`).join("")}</div>` : `<p>No archived opportunities.</p>`}</details>`;
    renderPager("linker", page);
  }

  function healthRow(label, value, status = "") {
    return `<div class="health-row"><strong>${esc(label)}</strong><span class="health-detail ${status ? `status-pill ${status}` : ""}">${esc(value)}</span></div>`;
  }

  function renderAutoBidSettings() {
    const autoBid = state.data?.autoBid;
    const form = $("#auto-bid-form");
    if (!autoBid || !form) return;
    const settings = autoBid.settings || {};
    form.elements.dateScope.value = settings.dateScope || "tomorrow";
    form.elements.dateFrom.value = settings.dateFrom || "";
    form.elements.dateTo.value = settings.dateTo || "";
    form.elements.minimumMiles.value = settings.minimumMiles ?? 70;
    form.elements.priceDeduction.value = settings.priceDeduction ?? 5;
    form.elements.minimumExpiryMinutes.value = settings.minimumExpiryMinutes ?? 10;
    const toggle = $("#auto-bid-toggle");
    toggle.checked = Boolean(settings.enabled);
    toggle.disabled = false;
    $("#auto-bid-settings-status").textContent = settings.enabled ? "On" : "Off";
    const customRange = settings.dateScope === "custom";
    const customFrom = settings.dateScope === "customFrom";
    $("#auto-bid-custom-range").classList.toggle("hidden", !customRange && !customFrom);
    $("#auto-bid-date-to-field").classList.toggle("hidden", customFrom);
    form.elements.dateFrom.required = customRange || customFrom;
    form.elements.dateTo.required = customRange;
    const vehicles = ["Saloon Car", "Executive Car", "Estate Car", "People Carrier", "Executive People Carrier", "8 Seater Minibus", "Fleet Bus"];
    const selected = new Set((settings.allowedVehicles || []).map((value) => String(value).toLowerCase()));
    $("#auto-bid-vehicles").innerHTML = vehicles.map((vehicle) => `<label class="vehicle-check"><input type="checkbox" name="autoBidVehicle" value="${esc(vehicle)}" ${selected.has(String(vehicle).toLowerCase()) ? "checked" : ""}><span>${esc(vehicle)}</span></label>`).join("");
    const scopeLabels = { today: "today", tomorrow: "tomorrow", futureExcludingTodayTomorrow: "future dates excluding today and tomorrow", currentMonth: "this month", currentMonthExcludingTodayTomorrow: "this month excluding today and tomorrow", futureMonths: "future months", nextMonth: "next month", custom: `${settings.dateFrom || "start"} to ${settings.dateTo || "end"}`, customFrom: `${settings.dateFrom || "the selected date"} onward` };
    $("#auto-bid-preview").textContent = `${Number(autoBid.preview?.eligibleCount || 0)} currently eligible for ${scopeLabels[settings.dateScope] || "the selected dates"}; ${Number(autoBid.preview?.skippedCount || 0)} skipped. ${autoBid.runtime?.lastDecision || ""}`;
  }

  function renderGroupManager() {
    const list = $("#whatsapp-group-list");
    if (state.groupsLoading) {
      list.innerHTML = `<div class="empty compact">Loading WhatsApp groups...</div>`;
      return;
    }
    const byId = new Map(state.liveGroups.map((group) => [group.id, group]));
    state.allowedGroupIds.forEach((id) => {
      if (!byId.has(id)) byId.set(id, { id, name: "Saved group (not currently loaded)" });
    });
    const groups = [...byId.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)));
    list.innerHTML = groups.length ? groups.map((group) => `<label class="group-row"><input type="checkbox" data-group-id="${esc(group.id)}" ${state.allowedGroupIds.has(group.id) ? "checked" : ""}><span><strong>${esc(group.name)}</strong><small>${esc(group.id)}</small></span><span class="status-pill ${state.allowedGroupIds.has(group.id) ? "" : "warn"}">${state.allowedGroupIds.has(group.id) ? "Allowed" : "Blocked"}</span></label>`).join("") : `<div class="empty compact">No groups loaded. Connect WhatsApp, then choose Load groups.</div>`;
  }

  function renderSettings() {
    const criteria = state.data?.criteria || {};
    const form = $("#criteria-form");
    Object.entries(criteria).forEach(([key, value]) => {
      const input = form.elements[key];
      if (input) input.value = Array.isArray(value) ? value.join(", ") : value;
    });
    const source = state.data?.sourceStatus || {};
    $("#source-health").innerHTML = [
      healthRow("OTS Master", source.otsLastError ? source.otsLastError : otsSyncSummary(source), source.otsLastError ? "bad" : ""),
      healthRow("Groups sheet", source.whatsappSheetLastError ? source.whatsappSheetLastError : `${Number(source.whatsappSheetCount || 0)} upcoming jobs`, source.whatsappSheetLastError ? "bad" : ""),
      healthRow("PreBook", source.prebookLastError || source.prebookMessage || source.prebookMode || "Waiting", source.prebookLastError ? "bad" : source.prebookMode === "demo" ? "warn" : ""),
      healthRow("Linker", source.linkerLastError || `${Number(source.linkCount ?? state.data?.links?.length ?? 0)} current matches`, source.linkerLastError ? "bad" : ""),
      healthRow("Last sync", source.lastSyncAt ? formatUkDateTime(source.lastSyncAt) : "Waiting", source.lastError ? "bad" : "")
    ].join("");
    const trash = state.data?.trash || [];
    $("#trash-list").innerHTML = trash.length ? trash.map((job) => `<div class="trash-row"><div><strong>${esc(job.rideId)}</strong><small>${esc(job.pickup || "Pickup missing")} &rarr; ${esc(job.dropOff || "Drop-off missing")} - deletes ${job.trashDeleteAt ? esc(formatUkDateTime(job.trashDeleteAt)) : "after the recovery window"}</small></div><button class="button" type="button" data-restore="${esc(job.rideId)}">Restore</button></div>`).join("") : `<div class="empty compact">Trash is empty.</div>`;
    renderGroupManager();
    renderAutoBidSettings();
  }

  function renderAll() {
    if (!state.data) return;
    renderMaster();
    renderBids();
    renderPrebook();
    renderGroups();
    renderLinks();
    renderSettings();
    updateFilterControls();
    setTab(state.tab, false);
  }

  function updateFilterControls() {
    $$("[data-master-preset]").forEach((button) => button.classList.toggle("active", button.dataset.masterPreset === state.master.preset));
    $$("[data-groups-preset]").forEach((button) => button.classList.toggle("active", button.dataset.groupsPreset === state.groups.preset));
    $$("[data-mileage-scope]").forEach((button) => {
      const filter = state[button.dataset.mileageScope];
      button.classList.toggle("active", Boolean(filter) && button.dataset.mileageValue === filter.mileage);
    });
    $("#master-date-from").value = state.master.from;
    $("#master-date-to").value = state.master.to;
    $("#master-mileage").value = state.master.mileage;
    $("#master-vehicle").value = state.master.vehicle;
    $("#master-location").value = state.master.location;
    $("#master-fare").value = state.master.fare;
    $("#master-sort").value = state.master.sort;
    $("#groups-date-from").value = state.groups.from;
    $("#groups-date-to").value = state.groups.to;
    $("#groups-mileage").value = state.groups.mileage;
    $("#groups-vehicle").value = state.groups.vehicle;
    $("#groups-location").value = state.groups.location;
    $("#groups-fare").value = state.groups.fare;
    $("#groups-sort").value = state.groups.sort;
    $("#prebook-vehicle").value = state.prebookVehicle;
    $("#prebook-location").value = state.prebookLocation;
    $("#bid-location").value = state.bidLocation;
    $("#linker-location").value = state.linkerLocation;
  }

  function refreshList(key) {
    state.pages[key] = 1;
    renderList(key);
    updateFilterControls();
  }

  function renderList(key) {
    if (key === "master") renderMaster();
    if (key === "bid") renderBids();
    if (key === "prebook") renderPrebook();
    if (key === "groups") renderGroups();
    if (key === "linker") renderLinks();
  }

  function formatJobDetail(job) {
    if (job.copyDetail) return job.copyDetail;
    return [
      job.rideId,
      "Route:",
      `  - ${job.pickup || "Pickup missing"}`,
      `  - ${job.dropOff || "Drop-off missing"}`,
      `Pick up at ${pickupLabel(job)} (UK time)`,
      `Travelling by ${job.requiredVehicle || job.vehicle || "Vehicle missing"}`,
      `Distance: ${positiveNumeric(job.distance) === null ? "Not supplied" : `${positiveNumeric(job.distance)} mi`}`,
      "",
      `Fare: ${money(job.fare)}`
    ].join("\n");
  }

  function terminalBidStatus(bid) {
    const status = String(bid?.bidStatus || "").toLowerCase();
    return status === "submitted" || status === "submission failed" || status === "submission unconfirmed";
  }

  async function pollBidStatus(rideId) {
    const deadline = Date.now() + BID_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, BID_POLL_INTERVAL_MS));
      try {
        await load();
      } catch {
        continue;
      }
      const bid = bidForRide(rideId);
      if (!terminalBidStatus(bid)) continue;
      if (String(bid.bidStatus).toLowerCase() === "submitted") {
        showNotice(`Bid ${rideId} was confirmed submitted by OTS.`);
      } else {
        showNotice(bid.submissionResult || `Bid ${rideId} failed.`, "error");
      }
      return bid;
    }
    showNotice(`Bid ${rideId} is still processing. Its persisted status remains available in Bid.`, "error");
    return null;
  }

  function copyText(detail) {
    const fallback = () => {
      const input = document.createElement("textarea");
      input.value = detail;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      toast("Job details copied.");
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(detail).then(() => toast("Job details copied."), fallback);
    else fallback();
  }

  function copyJob(id) {
    const job = jobById(id);
    if (job.rideId) copyText(formatJobDetail(job));
  }

  function copyBid(id) {
    const bid = (state.data?.bids || []).find((entry) => entry.bidId === id);
    if (bid) copyText(formatJobDetail(jobFromBid(bid)));
  }

  async function submitManualBid(rideId) {
    if (state.submittingBids.has(rideId) || bidBlocksSubmission(bidForRide(rideId))) return;
    const amountInput = document.querySelector(`[data-bid-amount="${CSS.escape(rideId)}"]`);
    const reasonInput = document.querySelector(`[data-bid-reason="${CSS.escape(rideId)}"]`);
    const bidAmount = Number(amountInput?.value);
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
      showNotice("Enter a valid positive bid amount.", "error");
      return;
    }
    if (!window.confirm(`Submit a ${money(bidAmount)} bid to OTS for ${rideId}?`)) return;
    state.submittingBids.add(rideId);
    renderMaster();
    showNotice(`Queuing ${rideId} for OTS submission...`);
    try {
      const result = await request("/api/job-linker/bids", {
        method: "POST",
        body: JSON.stringify({ rideId, bidAmount, reason: reasonInput?.value.trim() || "" })
      });
      if (result.bid && state.data) {
        state.data.bids = [result.bid, ...(state.data.bids || []).filter((bid) => bid.rideId !== rideId)];
      }
      await load();
      showNotice(result.message || "Bid queued. Waiting for OTS confirmation.");
      await pollBidStatus(rideId);
    } catch (error) {
      await load().catch(() => {});
      showNotice(error.message, "error");
    } finally {
      state.submittingBids.delete(rideId);
      renderMaster();
    }
  }

  function hideWhatsAppQr() {
    $("#whatsapp-qr").classList.add("hidden");
    if (state.whatsappQrUrl) URL.revokeObjectURL(state.whatsappQrUrl);
    state.whatsappQrUrl = "";
    $("#whatsapp-qr-image").removeAttribute("src");
  }

  async function refreshWhatsAppStatus() {
    try {
      const data = await request("/api/whatsapp/session");
      const labels = { ready: "connected", qr_required: "scan required", starting: "starting", stopped: "stopped", disconnected: "disconnected", failed: "attention required" };
      $("#whatsapp-result").textContent = `WhatsApp: ${labels[data.state] || data.state || "unknown"}${data.lastError ? ` - ${data.lastError}` : ""}`;
      if (!data.qrAvailable) {
        hideWhatsAppQr();
        return;
      }
      const response = await fetch(api(`/qr.png?ts=${encodeURIComponent(data.qrUpdatedAt || Date.now())}`), { cache: "no-store", headers: headers() });
      if (!response.ok) throw new Error("WhatsApp QR image could not be loaded.");
      const nextUrl = URL.createObjectURL(await response.blob());
      if (state.whatsappQrUrl) URL.revokeObjectURL(state.whatsappQrUrl);
      state.whatsappQrUrl = nextUrl;
      $("#whatsapp-qr-image").src = nextUrl;
      $("#whatsapp-qr").classList.remove("hidden");
    } catch (error) {
      $("#whatsapp-result").textContent = error.message;
      hideWhatsAppQr();
    }
  }

  function startWhatsAppPolling() {
    if (!state.whatsappTimer) state.whatsappTimer = setInterval(refreshWhatsAppStatus, 15000);
    refreshWhatsAppStatus();
  }

  function stopWhatsAppPolling() {
    if (state.whatsappTimer) clearInterval(state.whatsappTimer);
    state.whatsappTimer = null;
  }

  async function loadGroupManager() {
    state.groupsLoading = true;
    renderGroupManager();
    try {
      const allowed = await request("/api/whatsapp/allowed-groups");
      state.allowedGroupIds = new Set(allowed.groupIds || []);
      const live = await request("/api/whatsapp/groups");
      state.liveGroups = live.groups || [];
      state.groupsLoaded = true;
      $("#whatsapp-result").textContent = `WhatsApp: connected - ${state.liveGroups.length} groups loaded`;
    } catch (error) {
      state.liveGroups = [];
      $("#whatsapp-result").textContent = error.message;
    } finally {
      state.groupsLoading = false;
      renderGroupManager();
    }
  }

  async function saveAllowedGroups() {
    const result = await post("/api/whatsapp/allowed-groups", { groupIds: [...state.allowedGroupIds], confirmation: "UPDATE ALLOWED GROUPS" }, "Saving WhatsApp groups", "Groups saved; WhatsApp is restarting.");
    if (result) {
      state.groupsLoaded = false;
      setTimeout(() => { refreshWhatsAppStatus(); load(); }, 5000);
    }
  }

  function autoBidFormValues(enabled = Boolean(state.data?.autoBid?.settings?.enabled)) {
    const form = $("#auto-bid-form");
    const deductionValue = form.elements.priceDeduction.value.trim();
    return {
      enabled,
      dateScope: form.elements.dateScope.value,
      dateFrom: form.elements.dateFrom.value,
      dateTo: form.elements.dateScope.value === "customFrom" ? "" : form.elements.dateTo.value,
      minimumMiles: Number(form.elements.minimumMiles.value),
      priceDeduction: deductionValue === "" ? null : Number(deductionValue),
      minimumExpiryMinutes: Number(form.elements.minimumExpiryMinutes.value),
      allowedVehicles: $$('[name="autoBidVehicle"]:checked').map((input) => input.value),
      ...(enabled ? { confirmation: "ENABLE AUTO BID" } : {})
    };
  }

  function validAutoBidForm(values) {
    if (!values.allowedVehicles.length) {
      showNotice("Select at least one vehicle for Auto Bid.", "error");
      return false;
    }
    if (values.dateScope === "custom" && (!values.dateFrom || !values.dateTo || values.dateFrom > values.dateTo)) {
      showNotice("Choose a valid Auto Bid date range.", "error");
      return false;
    }
    if (values.dateScope === "customFrom" && !values.dateFrom) {
      showNotice("Choose the date Auto Bid should start from.", "error");
      return false;
    }
    if (!Number.isFinite(values.priceDeduction) || values.priceDeduction < 0) {
      showNotice("Enter a valid bid deduction. Use 0 to bid the OTS maximum.", "error");
      return false;
    }
    return true;
  }

  async function toggleAutoBid() {
    const enabled = Boolean(state.data?.autoBid?.settings?.enabled);
    const nextEnabled = !enabled;
    if (nextEnabled) {
      const preview = Number(state.data?.autoBid?.preview?.eligibleCount || 0);
      if (!window.confirm(`Enable Auto Bid? ${preview} current job${preview === 1 ? "" : "s"} match the saved rules. New eligible jobs will be submitted automatically.`)) {
        $("#auto-bid-toggle").checked = enabled;
        return;
      }
    }
    const values = autoBidFormValues(nextEnabled);
    if (!validAutoBidForm(values)) {
      $("#auto-bid-toggle").checked = enabled;
      return;
    }
    await post(
      "/api/job-linker/auto-bid/settings",
      values,
      nextEnabled ? "Enabling Auto Bid" : "Disabling Auto Bid",
      `Auto Bid ${nextEnabled ? "enabled" : "disabled"}.`
    );
  }

  async function runWhatsAppControl(path, body, label) {
    const done = await post(path, body, label, `${label} requested.`);
    if (done) {
      hideWhatsAppQr();
      setTimeout(refreshWhatsAppStatus, path.endsWith("/stop") ? 500 : 4000);
    }
  }

  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
  $("#refresh-button").addEventListener("click", load);
  $("#master-search").addEventListener("input", () => refreshList("master"));
  $("#prebook-search").addEventListener("input", () => refreshList("prebook"));
  $("#groups-search").addEventListener("input", () => refreshList("groups"));

  $$("[data-master-preset]").forEach((button) => button.addEventListener("click", () => {
    state.master.preset = button.dataset.masterPreset;
    refreshList("master");
  }));
  $$("[data-groups-preset]").forEach((button) => button.addEventListener("click", () => {
    state.groups.preset = button.dataset.groupsPreset;
    refreshList("groups");
  }));
  $("#master-date-from").addEventListener("change", (event) => { state.master.from = event.target.value; refreshList("master"); });
  $("#master-date-to").addEventListener("change", (event) => { state.master.to = event.target.value; refreshList("master"); });
  $("#master-mileage").addEventListener("change", (event) => { state.master.mileage = event.target.value; refreshList("master"); });
  $("#master-vehicle").addEventListener("change", (event) => { state.master.vehicle = event.target.value; refreshList("master"); });
  $("#master-location").addEventListener("change", (event) => { state.master.location = event.target.value; refreshList("master"); });
  $("#master-fare").addEventListener("change", (event) => { state.master.fare = event.target.value; refreshList("master"); });
  $("#master-sort").addEventListener("change", (event) => { state.master.sort = event.target.value; refreshList("master"); });
  $("#groups-date-from").addEventListener("change", (event) => { state.groups.from = event.target.value; refreshList("groups"); });
  $("#groups-date-to").addEventListener("change", (event) => { state.groups.to = event.target.value; refreshList("groups"); });
  $("#groups-mileage").addEventListener("change", (event) => { state.groups.mileage = event.target.value; refreshList("groups"); });
  $("#groups-vehicle").addEventListener("change", (event) => { state.groups.vehicle = event.target.value; refreshList("groups"); });
  $("#groups-location").addEventListener("change", (event) => { state.groups.location = event.target.value; refreshList("groups"); });
  $("#groups-fare").addEventListener("change", (event) => { state.groups.fare = event.target.value; refreshList("groups"); });
  $("#groups-sort").addEventListener("change", (event) => { state.groups.sort = event.target.value; refreshList("groups"); });
  $("#prebook-vehicle").addEventListener("change", (event) => { state.prebookVehicle = event.target.value; refreshList("prebook"); });
  $("#prebook-location").addEventListener("change", (event) => { state.prebookLocation = event.target.value; refreshList("prebook"); });
  $("#bid-location").addEventListener("change", (event) => { state.bidLocation = event.target.value; refreshList("bid"); });
  $("#linker-location").addEventListener("change", (event) => { state.linkerLocation = event.target.value; refreshList("linker"); });
  $("#bid-search").addEventListener("input", (event) => { state.bidQuery = event.target.value; state.pages.bid = 1; renderBids(); });
  $("#bid-clear-filters").addEventListener("click", () => {
    state.bidQuery = "";
    state.bidLocation = "all";
    $("#bid-search").value = "";
    state.pages.bid = 1;
    setReportRange("2");
    renderBids();
  });
  $("#prebook-clear-filters").addEventListener("click", () => {
    state.prebookVehicle = "all";
    state.prebookLocation = "all";
    $("#prebook-search").value = "";
    refreshList("prebook");
  });
  $("#linker-clear-filters").addEventListener("click", () => {
    state.linkerLocation = "all";
    refreshList("linker");
  });
  $("#download-report").addEventListener("click", downloadOperationsReport);
  $("#theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
  $$('[data-report-preset]').forEach((button) => button.addEventListener("click", () => setReportRange(button.dataset.reportPreset)));
  [$("#report-from"), $("#report-to")].forEach((input) => input.addEventListener("change", () => setReportRange("custom")));

  $$("[data-date-preset]").forEach((button) => button.addEventListener("click", () => {
    const today = londonDateKey();
    const preset = button.dataset.datePreset;
    const scope = button.dataset.dateScope || "master";
    const filter = state[scope];
    if (!filter) return;
    if (preset === "today") filter.from = filter.to = today;
    if (preset === "tomorrow") filter.from = filter.to = shiftDateKey(today, 1);
    if (preset === "week") { filter.from = today; filter.to = shiftDateKey(today, 7 - londonWeekday()); }
    if (preset === "month") { filter.from = today; filter.to = monthEnd(today); }
    if (preset === "nextMonth") {
      const [year, month] = today.split("-").map(Number);
      filter.from = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
      filter.to = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    }
    refreshList(scope);
  }));

  $$("[data-mileage-scope]").forEach((button) => button.addEventListener("click", () => {
    const filter = state[button.dataset.mileageScope];
    if (!filter) return;
    filter.mileage = button.dataset.mileageValue;
    refreshList(button.dataset.mileageScope);
  }));

  $("#master-clear-filters").addEventListener("click", () => {
    state.master = { preset: "all", mileage: "all", vehicle: "all", location: "all", fare: "all", from: "", to: "", sort: "pickupAsc" };
    $("#master-search").value = "";
    refreshList("master");
  });
  $("#groups-clear-filters").addEventListener("click", () => {
    state.groups = { preset: "all", mileage: "all", vehicle: "all", location: "all", fare: "all", from: "", to: "", sort: "pickupAsc" };
    $("#groups-search").value = "";
    refreshList("groups");
  });

  document.addEventListener("click", async (event) => {
    const unarchiveButton = event.target.closest("[data-unarchive-link]");
    if (unarchiveButton) {
      unarchiveButton.disabled = true;
      const done = await post(`/api/job-linker/links/${encodeURIComponent(unarchiveButton.dataset.unarchiveLink)}/unarchive`, {}, "Restoring link", "Link restored.");
      if (!done && unarchiveButton.isConnected) unarchiveButton.disabled = false;
      return;
    }
    const archiveButton = event.target.closest("[data-archive-link]");
    if (archiveButton) {
      archiveButton.disabled = true;
      await post(`/api/job-linker/links/${encodeURIComponent(archiveButton.dataset.archiveLink)}/archive`, {}, "Archiving link", "Link archived.");
      return;
    }
    const pageButton = event.target.closest("[data-page-key]");
    if (pageButton && !pageButton.disabled) {
      state.pages[pageButton.dataset.pageKey] = Number(pageButton.dataset.page);
      if (pageButton.dataset.pageKey === "linker") renderLinks();
      else renderList(pageButton.dataset.pageKey);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const mobileButton = event.target.closest("[data-mobile-category]");
    if (mobileButton) {
      state.mobileCategory[mobileButton.dataset.mobileKey] = mobileButton.dataset.mobileCategory;
      refreshList(mobileButton.dataset.mobileKey);
      return;
    }
    const copyButton = event.target.closest("[data-copy-job]");
    if (copyButton) {
      copyJob(copyButton.dataset.copyJob);
      return;
    }
    const copyBidButton = event.target.closest("[data-copy-bid]");
    if (copyBidButton) {
      copyBid(copyBidButton.dataset.copyBid);
      return;
    }
    const submitBidButton = event.target.closest("[data-submit-bid]");
    if (submitBidButton) {
      await submitManualBid(submitBidButton.dataset.submitBid);
      return;
    }
    const restoreButton = event.target.closest("[data-restore]");
    if (restoreButton) await post("/api/job-linker/restore", { rideIds: [restoreButton.dataset.restore] }, "Restoring job");
  });

  document.addEventListener("change", (event) => {
    const select = event.target.closest("[data-select-key]");
    if (select) {
      const selected = state.selected[select.dataset.selectKey];
      if (select.checked) selected.add(select.dataset.id);
      else selected.delete(select.dataset.id);
      updateBulkState(select.dataset.selectKey);
      return;
    }
    const group = event.target.closest("[data-group-id]");
    if (group) {
      if (group.checked) state.allowedGroupIds.add(group.dataset.groupId);
      else state.allowedGroupIds.delete(group.dataset.groupId);
      renderGroupManager();
    }
  });

  $$("[data-trash-selected]").forEach((button) => button.addEventListener("click", async () => {
    const key = button.dataset.trashSelected;
    const ids = [...state.selected[key]];
    if (!ids.length || !window.confirm(`Move ${ids.length} selected job${ids.length === 1 ? "" : "s"} to Trash?`)) return;
    if (await post("/api/job-linker/trash", { rideIds: ids }, "Moving jobs to Trash")) {
      state.selected[key].clear();
      renderAll();
    }
  }));

  $("#sync-button").addEventListener("click", () => post("/api/job-linker/sync", {}, "Synchronizing sources"));
  $("#criteria-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    post("/api/job-linker/criteria", {
      minFare: Number(form.get("minFare")),
      areaMatchMode: form.get("areaMatchMode"),
      allowedVehicles: String(form.get("allowedVehicles")).split(",").map((value) => value.trim()).filter(Boolean),
      allowedAreaCodes: String(form.get("allowedAreaCodes")).split(",").map((value) => value.trim()).filter(Boolean),
      maxLinkGapHours: Number(form.get("maxLinkGapHours")),
      minimumTurnaroundMinutes: Number(form.get("minimumTurnaroundMinutes")),
      expireAfterPickupHours: Number(form.get("expireAfterPickupHours")),
      trashRetentionHours: Number(form.get("trashRetentionHours"))
    }, "Saving rules");
  });
  $("#auto-bid-toggle").addEventListener("click", toggleAutoBid);
  $("#auto-bid-form").elements.dateScope.addEventListener("change", (event) => {
    const customRange = event.target.value === "custom";
    const customFrom = event.target.value === "customFrom";
    $("#auto-bid-custom-range").classList.toggle("hidden", !customRange && !customFrom);
    $("#auto-bid-date-to-field").classList.toggle("hidden", customFrom);
    event.currentTarget.form.elements.dateFrom.required = customRange || customFrom;
    event.currentTarget.form.elements.dateTo.required = customRange;
    if (customFrom) event.currentTarget.form.elements.dateTo.value = "";
  });
  $("#auto-bid-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const currentEnabled = Boolean(state.data?.autoBid?.settings?.enabled);
    const values = autoBidFormValues(currentEnabled);
    if (!validAutoBidForm(values)) return;
    if (currentEnabled && !window.confirm("Auto Bid is ON. Apply these rules immediately to new eligible jobs?")) return;
    post("/api/job-linker/auto-bid/settings", values, "Saving Auto Bid rules", "Auto Bid rules saved.");
  });
  $("#whatsapp-status-button").addEventListener("click", refreshWhatsAppStatus);
  $("#whatsapp-groups-button").addEventListener("click", loadGroupManager);
  $("#whatsapp-restart-button").addEventListener("click", () => runWhatsAppControl("/api/whatsapp/restart", {}, "Restarting WhatsApp"));
  $("#whatsapp-stop-button").addEventListener("click", () => {
    if (window.confirm("Stop WhatsApp ingestion? OTS and the dashboard will remain online.")) runWhatsAppControl("/api/whatsapp/stop", {}, "Stopping WhatsApp");
  });
  $("#whatsapp-reset-button").addEventListener("click", () => {
    if (window.confirm("Delete the saved WhatsApp session and generate a new QR?")) runWhatsAppControl("/api/whatsapp/session/reset", { confirmation: "RESET WHATSAPP SESSION" }, "Resetting WhatsApp session");
  });
  $("#groups-select-all").addEventListener("click", () => { state.liveGroups.forEach((group) => state.allowedGroupIds.add(group.id)); renderGroupManager(); });
  $("#groups-clear-all").addEventListener("click", () => { state.allowedGroupIds.clear(); renderGroupManager(); });
  $("#groups-save").addEventListener("click", saveAllowedGroups);

  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    localStorage.setItem(TOKEN_KEY, $("#token-input").value.trim());
    localStorage.setItem(ACTOR_KEY, $("#actor-input").value.trim() || "Operator");
    $("#login-dialog").close();
    load();
  });

  (async () => {
    try {
      applyTheme(document.documentElement.dataset.theme);
      const configResponse = await fetch("/api/config", { cache: "no-store" });
      const config = await configResponse.json();
      if (!config.ok || !config.apiBaseUrl) throw new Error(config.message || "Dashboard API is not configured.");
      state.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
      setReportRange("2");
      const requestedTab = window.location.hash.replace("#", "");
      state.tab = VIEW_META[requestedTab] ? requestedTab : "master";
      if (!token()) showLogin();
      else await load();
    } catch (error) {
      showNotice(error.message, "error");
      $("#live-status").innerHTML = `<span class="status-dot"></span><span>Not configured</span>`;
      $("#live-status").className = "connection bad";
    }
  })();
  setInterval(() => {
    if (state.tab === "linker" && token()) load();
  }, 60000);
})();
