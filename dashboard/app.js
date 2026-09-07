(() => {
  "use strict";

  const PAGE_SIZE = 24;
  const BID_POLL_INTERVAL_MS = 2000;
  const BID_POLL_TIMEOUT_MS = 150000;
  const TOKEN_KEY = "aceDashboardToken";
  const ACTOR_KEY = "aceDashboardActor";
  const CATEGORY_META = {
    saloon: { label: "Saloon" },
    estate: { label: "Estate Car" },
    other: { label: "People Carrier / Executive / MPV" }
  };
  const VIEW_META = {
    master: ["OTS LIVE JOBS", "Master", "All currently live OTS quotation requests."],
    bid: ["BID WORKSPACE", "Bid", "Persisted manual OTS submissions and confirmed outcomes."],
    prebook: ["CONFIRMED WORK", "PreBook", "Future confirmed bookings used as Linker anchors."],
    groups: ["WHATSAPP JOBS", "Groups", "Eligible Saloon and MPV jobs from WhatsApp sources."],
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
    master: { preset: "all", mileage: "all", vehicle: "all", fare: "all", from: "", to: "", sort: "pickupAsc" },
    prebookVehicle: "all",
    groupVehicle: "all",
    groupSort: "pickupAsc",
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

  function numeric(value) {
    const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function money(value) {
    const amount = numeric(value);
    return amount === null ? "-" : `\u00a3${amount.toFixed(2)}`;
  }

  function guidePrice(job = {}) {
    const minimum = numeric(job.guidePriceMin);
    const maximum = numeric(job.guidePriceMax);
    if (minimum !== null && maximum !== null) return `${money(minimum)} - ${money(maximum)}`;
    if (minimum !== null) return `From ${money(minimum)}`;
    return "Guide unavailable";
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
    return job.pickupAt ? formatUkDateTime(job.pickupAt) : [job.pickupDayDate, job.startingTiming].filter(Boolean).join(", ") || "Date missing";
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
      return state.prebookVehicle === "all" || categoryFor(job) === state.prebookVehicle;
    });
    return sortJobs(rows, "pickupAsc");
  }

  function filteredGroups() {
    const query = $("#groups-search").value.trim().toLowerCase();
    const rows = (state.data?.groups || []).filter((job) => {
      if (job.eligible === false || !searchMatches(job, query)) return false;
      if (state.groupVehicle === "all") return true;
      const label = String(job.vehicle || job.requiredVehicle || "").toLowerCase();
      return state.groupVehicle === "saloon" ? label.includes("saloon") : label.includes("mpv") || label.includes("seater") || label.includes("people carrier");
    });
    return sortJobs(rows, state.groupSort);
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
    const bidValue = existingBid?.bidAmount ?? numeric(job.guidePriceMin) ?? "";
    const guideLine = key === "master" && job.guidePriceText ? `<div class="guide-line">${esc(job.guidePriceText)}</div>` : "";
    const bidHistory = existingBid ? `<div class="bid-history">Persisted bid <b>${money(existingBid.bidAmount)}</b> - ${esc(existingBid.bidStatus || existingBid.submissionState || "Created")}</div>` : "";
    const masterActions = key === "master" ? `<div class="card-actions"><input class="bid-amount" type="number" min="0.01" step="0.01" value="${esc(bidValue)}" data-bid-amount="${esc(job.rideId)}" aria-label="Bid amount for ${esc(job.rideId)}" ${bidLocked || submitting ? "disabled" : ""}><button class="button primary" type="button" data-submit-bid="${esc(job.rideId)}" ${bidLocked || submitting ? "disabled" : ""}>${submitting ? "Submitting" : bidLocked ? esc(existingBid.bidStatus || "Saved") : existingBid ? "Submit" : "Bid"}</button><button class="button copy-button" type="button" data-copy-job="${esc(job.rideId)}">Copy Detail</button></div>${bidLocked ? "" : `<input class="bid-reason" type="text" maxlength="240" data-bid-reason="${esc(job.rideId)}" value="${esc(existingBid?.reason || "")}" placeholder="Reason (optional)">`}` : `<div class="card-actions compact-actions"><button class="button copy-button" type="button" data-copy-job="${esc(job.rideId)}">Copy Detail</button></div>`;
    return `<article class="job-card ${category}${linked ? " linked" : ""}">
      <div class="job-card-head"><input type="checkbox" data-select-key="${key}" data-id="${esc(job.rideId)}" ${selected ? "checked" : ""} aria-label="Select ${esc(job.rideId)}"><div class="job-ref">${esc(job.rideId || "Reference missing")}</div><span class="job-source">${esc(job.sourceName || job.sourceType || key)}</span></div>
      <div class="job-time">${esc(pickupLabel(job))}</div>
      <div class="job-route"><div class="route-track"><span></span></div><div class="route-points"><div><small>Pickup</small><strong>${esc(job.pickup || "Pickup missing")}</strong></div><div><small>Drop-off</small><strong>${esc(job.dropOff || "Drop-off missing")}</strong></div></div></div>
      <div class="job-meta"><span><b>${esc(job.requiredVehicle || job.vehicle || "Vehicle missing")}</b></span><span>${numeric(job.distance) === null ? "Distance missing" : `${esc(numeric(job.distance))} mi`}</span><span class="fare">${esc(key === "master" ? guidePrice(job) : money(job.fare))}</span><span class="status-pill ${job.eligible === false ? "bad" : ""}">${key === "master" ? "Live" : job.eligible === false ? "Review" : "Eligible"}</span></div>
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
    const fareValue = rows.reduce((total, job) => total + (numeric(job.guidePriceMin) || 0), 0);
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
    const rows = (state.data?.bids || []).slice().sort((left, right) => dateValue(right.updatedAt, 0) - dateValue(left.updatedAt, 0));
    const page = paginate(rows, "bid");
    const submitted = rows.filter((bid) => ["submitted", "unconfirmed"].includes(String(bid.bidStatus).toLowerCase())).length;
    const confirmed = rows.filter((bid) => String(bid.bidStatus).toLowerCase() === "confirmed").length;
    $("#bid-summary").innerHTML = `<div class="stat"><strong>${rows.length}</strong><span>Persisted bids</span></div><div class="stat"><strong>${submitted}</strong><span>Submitted, unconfirmed</span></div><div class="stat"><strong>${confirmed}</strong><span>Confirmed in PreBook</span></div>`;
    $("#bid-list").innerHTML = page.rows.length ? page.rows.map((bid) => {
      const job = jobFromBid(bid);
      return `<article class="bid-card ${bidStatusClass(bid)}">
        <div class="bid-card-head"><div class="job-ref">${esc(bid.otsReference || bid.rideId || "Reference missing")}</div><span class="job-source">${esc(bid.source || "OTS")}</span></div>
        <div class="job-time">${esc(pickupLabel(job))}</div>
        <div class="job-route"><div class="route-track"><span></span></div><div class="route-points"><div><small>Pickup</small><strong>${esc(bid.pickup || "Pickup missing")}</strong></div><div><small>Drop-off</small><strong>${esc(bid.dropOff || "Drop-off missing")}</strong></div></div></div>
        <div class="job-meta"><span><b>${esc(bid.requiredVehicle || "Vehicle missing")}</b></span><span>${numeric(bid.distance) === null ? "Distance missing" : `${esc(numeric(bid.distance))} mi`}</span><span class="fare">Bid ${money(bid.bidAmount)}</span></div>
        <div class="bid-state"><span class="status-pill ${bidStatusClass(bid) === "failed" ? "bad" : bidStatusClass(bid) ? "" : "warn"}">${esc(bid.bidStatus || "Created")}</span><span class="status-pill warn">${esc(bid.submissionState || "pending")}</span></div>
        <div class="bid-result">${esc(bid.submissionResult || bid.reason || "Awaiting a provider or booking signal.")}</div>
        <div class="card-actions compact-actions"><button class="button copy-button" type="button" data-copy-bid="${esc(bid.bidId)}">Copy Detail</button></div>
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
    const failed = Boolean(source.whatsappSheetLastError);
    const live = !failed && source.whatsappSheetEnabled && source.whatsappSheetMode !== "off";
    const banner = $("#groups-banner");
    banner.classList.toggle("source-error", failed);
    banner.innerHTML = `<div><strong>${failed ? "WhatsApp source needs attention" : live ? "WhatsApp source sheets connected" : source.whatsappSheetEnabled ? "WhatsApp source is starting" : "WhatsApp source sheets are not configured"}</strong><span>${esc(failed ? source.whatsappSheetLastError : source.whatsappSheetMessage || `${Number(source.whatsappSheetCount || 0)} eligible jobs synchronized.`)}</span></div><span class="status-pill ${live ? "" : failed ? "bad" : "warn"}">${live ? "Live" : failed ? "Error" : "Waiting"}</span>`;
    renderJobColumns("groups", filteredGroups());
  }

  function renderLinks() {
    const source = state.data?.sourceStatus || {};
    const failed = Boolean(source.linkerLastError || source.prebookLastError);
    const overview = document.querySelector(".linker-overview");
    overview.classList.toggle("source-error", failed);
    $("#linker-source-message").textContent = failed
      ? source.linkerLastError || "Linker is unavailable because PreBook could not synchronize."
      : "PreBook anchors matched to eligible OTS or WhatsApp return work.";
    const rows = (state.data?.links || []).slice().sort((left, right) => dateValue(jobById(left.anchorRideId).pickupAt) - dateValue(jobById(right.anchorRideId).pickupAt) || String(left.linkId).localeCompare(String(right.linkId)));
    const page = paginate(rows, "linker");
    $("#link-count").textContent = `${rows.length} ${rows.length === 1 ? "opportunity" : "opportunities"}`;
    $("#link-nav-count").textContent = String(rows.length);
    $("#link-list").innerHTML = page.rows.length ? page.rows.map((link) => {
      const anchor = jobById(link.anchorRideId || link.firstRideId);
      const candidate = jobById(link.candidateRideId || link.secondRideId);
      const score = link.scoreBreakdown || {};
      return `<article class="link-card">
        <div><div class="link-score">${esc(link.score)}<small>/100</small></div><span class="status-pill">Linked</span></div>
        <div class="link-leg"><span class="label">Booked anchor - ${esc(link.anchorRideId || link.firstRideId)}</span><strong>${esc(anchor.pickup || "Pickup missing")} &rarr; ${esc(anchor.dropOff || link.previousDrop || "Drop-off missing")}</strong><small>${esc(pickupLabel(anchor))} - ${esc(anchor.requiredVehicle || "Vehicle missing")}</small></div>
        <div class="link-arrow">&rarr;</div>
        <div class="link-leg"><span class="label">${esc(link.candidateSource || candidate.sourceType || "Candidate")} - ${esc(link.candidateRideId || link.secondRideId)}</span><strong>${esc(candidate.pickup || link.nextPickup || "Pickup missing")} &rarr; ${esc(candidate.dropOff || "Drop-off missing")}</strong><small>${esc(pickupLabel(candidate))} - ${esc(link.timeGap || "Gap missing")}</small></div>
        <div class="link-outcome"><strong>${link.savingEstimate === null || link.savingEstimate === undefined ? "Saving pending" : `Estimated saving ${money(link.savingEstimate)}`}</strong><p>${esc(link.direction || "Return direction")} - deadhead ${esc(link.distanceBetween || "not available")}</p><div class="score-breakdown"><span>Deadhead ${esc(score.deadhead ?? 0)}</span><span>Availability ${esc(score.availability ?? 0)}</span><span>Return ${esc(score.returnDirection ?? 0)}</span><span>Vehicle ${esc(score.vehicle ?? 0)}</span></div><p>${esc(link.reason || "Match passed current Linker rules.")}</p></div>
      </article>`;
    }).join("") : `<div class="empty">No realistic return opportunity is available.</div>`;
    renderPager("linker", page);
  }

  function healthRow(label, value, status = "") {
    return `<div class="health-row"><strong>${esc(label)}</strong><span class="health-detail ${status ? `status-pill ${status}` : ""}">${esc(value)}</span></div>`;
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
      healthRow("WhatsApp sheets", source.whatsappSheetLastError ? source.whatsappSheetLastError : `${Number(source.whatsappSheetCount || 0)} eligible jobs`, source.whatsappSheetLastError ? "bad" : ""),
      healthRow("PreBook", source.prebookLastError || source.prebookMessage || source.prebookMode || "Waiting", source.prebookLastError ? "bad" : source.prebookMode === "demo" ? "warn" : ""),
      healthRow("Linker", source.linkerLastError || `${Number(source.linkCount ?? state.data?.links?.length ?? 0)} current matches`, source.linkerLastError ? "bad" : ""),
      healthRow("Last sync", source.lastSyncAt ? formatUkDateTime(source.lastSyncAt) : "Waiting", source.lastError ? "bad" : "")
    ].join("");
    const trash = state.data?.trash || [];
    $("#trash-list").innerHTML = trash.length ? trash.map((job) => `<div class="trash-row"><div><strong>${esc(job.rideId)}</strong><small>${esc(job.pickup || "Pickup missing")} &rarr; ${esc(job.dropOff || "Drop-off missing")} - deletes ${job.trashDeleteAt ? esc(formatUkDateTime(job.trashDeleteAt)) : "after the recovery window"}</small></div><button class="button" type="button" data-restore="${esc(job.rideId)}">Restore</button></div>`).join("") : `<div class="empty compact">Trash is empty.</div>`;
    renderGroupManager();
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
    $("#master-date-from").value = state.master.from;
    $("#master-date-to").value = state.master.to;
    $("#master-mileage").value = state.master.mileage;
    $("#master-vehicle").value = state.master.vehicle;
    $("#master-fare").value = state.master.fare;
    $("#master-sort").value = state.master.sort;
    $("#prebook-vehicle").value = state.prebookVehicle;
    $("#groups-sort").value = state.groupSort;
    $$("[data-group-vehicle]").forEach((button) => button.classList.toggle("active", button.dataset.groupVehicle === state.groupVehicle));
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
      `Distance: ${numeric(job.distance) === null ? "Not supplied" : `${numeric(job.distance)} mi`}`,
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
      setTab("bid");
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
  $("#master-date-from").addEventListener("change", (event) => { state.master.from = event.target.value; refreshList("master"); });
  $("#master-date-to").addEventListener("change", (event) => { state.master.to = event.target.value; refreshList("master"); });
  $("#master-mileage").addEventListener("change", (event) => { state.master.mileage = event.target.value; refreshList("master"); });
  $("#master-vehicle").addEventListener("change", (event) => { state.master.vehicle = event.target.value; refreshList("master"); });
  $("#master-fare").addEventListener("change", (event) => { state.master.fare = event.target.value; refreshList("master"); });
  $("#master-sort").addEventListener("change", (event) => { state.master.sort = event.target.value; refreshList("master"); });
  $("#prebook-vehicle").addEventListener("change", (event) => { state.prebookVehicle = event.target.value; refreshList("prebook"); });
  $("#groups-sort").addEventListener("change", (event) => { state.groupSort = event.target.value; refreshList("groups"); });

  $$("[data-group-vehicle]").forEach((button) => button.addEventListener("click", () => {
    state.groupVehicle = button.dataset.groupVehicle;
    refreshList("groups");
  }));

  $$("[data-date-preset]").forEach((button) => button.addEventListener("click", () => {
    const today = londonDateKey();
    const preset = button.dataset.datePreset;
    if (preset === "today") state.master.from = state.master.to = today;
    if (preset === "tomorrow") state.master.from = state.master.to = shiftDateKey(today, 1);
    if (preset === "week") { state.master.from = today; state.master.to = shiftDateKey(today, 7 - londonWeekday()); }
    if (preset === "month") { state.master.from = today; state.master.to = monthEnd(today); }
    if (preset === "nextMonth") {
      const [year, month] = today.split("-").map(Number);
      state.master.from = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
      state.master.to = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    }
    refreshList("master");
  }));

  $("#master-clear-filters").addEventListener("click", () => {
    state.master = { preset: "all", mileage: "all", vehicle: "all", fare: "all", from: "", to: "", sort: "pickupAsc" };
    $("#master-search").value = "";
    refreshList("master");
  });

  document.addEventListener("click", async (event) => {
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
      const configResponse = await fetch("/api/config", { cache: "no-store" });
      const config = await configResponse.json();
      if (!config.ok || !config.apiBaseUrl) throw new Error(config.message || "Dashboard API is not configured.");
      state.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
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
})();
