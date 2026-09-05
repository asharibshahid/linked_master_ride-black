const { parsePickupDateTime, sortRideRecordsByPickupDateTime } = require("../sheets/upcomingJobs");
const { mapCriteriaRows, resolveCriteriaConfig } = require("../settings/criteria");
const { safeTrim } = require("../utils/text");

const DEFAULT_LIMIT = 80;

const DEFAULT_WORKSHEET_NAMES = Object.freeze({
  rides: "Rides",
  needsReview: "Needs Review",
  upcomingJobs: "Upcoming Jobs >79",
  finalBid: "Final Bid",
  recommendations: "Driver Recommendations",
  drivers: "Drivers",
  vehicles: "Vehicles",
  driverSchedule: "Driver Schedule",
  vehicleSchedule: "Vehicle Schedule",
  linkedRides: "Linked Rides",
  bidTracker: "Bid Tracker",
  dispatchCriteria: "Dispatch Criteria",
  auditLog: "Audit Log"
});

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName || "").replace(/'/g, "''")}'`;
}

function recordsFromValues(values = []) {
  const rows = Array.isArray(values) ? values : [];
  const headers = Array.isArray(rows[0]) ? rows[0].map(toCell) : [];
  if (headers.length === 0) return [];

  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = toCell(row?.[index]);
    });
    return record;
  });
}

async function readWorksheetRecords({ sheetsClient, spreadsheetId, worksheetName }) {
  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");
  if (!worksheetName) return [];

  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(worksheetName)}!A:Z`,
    majorDimension: "ROWS"
  });

  return recordsFromValues(response?.data?.values || []);
}

function isTodayRide(record = {}, now = new Date()) {
  const raw = toCell(record["Pickup Day & Date"] || record.Date);
  if (!raw) return false;

  const normalized = raw.toLowerCase();
  const day = now.getDate();
  const year = now.getFullYear();
  const monthLong = now.toLocaleString("en-GB", { month: "long" }).toLowerCase();
  const monthShort = now.toLocaleString("en-GB", { month: "short" }).toLowerCase();

  return (
    normalized.includes(String(year)) &&
    normalized.includes(String(day)) &&
    (normalized.includes(monthLong) || normalized.includes(monthShort))
  );
}

function normalizeStatus(value) {
  return toCell(value).toLowerCase();
}

function isClosedScheduleStatus(value) {
  return ["completed", "cancelled", "canceled", "failed"].includes(normalizeStatus(value));
}

function isClosedRideStatus(value) {
  return ["completed", "cancelled", "canceled", "rejected"].includes(normalizeStatus(value));
}

function isBidReadyForSubmission(record = {}) {
  const adminStatus = normalizeStatus(record["Admin Status"]);
  const bidStatus = normalizeStatus(record["Bid Status"]);
  return adminStatus === "approved" && ["approved", "suggested"].includes(bidStatus);
}

function parseNumber(value) {
  const parsed = Number(toCell(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function recommendationPriority(record = {}) {
  const status = normalizeStatus(record.status || record.Status);
  const assignmentStatus = normalizeStatus(record.assignmentStatus || record["Assignment Status"]);
  if ((!status || status === "pending") && (!assignmentStatus || assignmentStatus === "pending")) return 0;
  if (status === "approved" && (!assignmentStatus || assignmentStatus === "pending")) return 1;
  if (assignmentStatus === "assigned") return 2;
  if (assignmentStatus === "failed" || status === "failed") return 3;
  return 4;
}

function sortRecommendations(records = []) {
  return (Array.isArray(records) ? records : []).slice().sort((left, right) => {
    const priorityDiff = recommendationPriority(left) - recommendationPriority(right);
    if (priorityDiff !== 0) return priorityDiff;

    const leftScore = parseNumber(left.score || left.Score) ?? Number.NEGATIVE_INFINITY;
    const rightScore = parseNumber(right.score || right.Score) ?? Number.NEGATIVE_INFINITY;
    if (leftScore !== rightScore) return rightScore - leftScore;

    const leftCreated = parseTimestamp(left.createdTime || left["Created Time"]);
    const rightCreated = parseTimestamp(right.createdTime || right["Created Time"]);
    if (leftCreated && rightCreated) return rightCreated.getTime() - leftCreated.getTime();
    if (leftCreated) return -1;
    if (rightCreated) return 1;

    return toCell(left.rideId || left["Ride ID"]).localeCompare(toCell(right.rideId || right["Ride ID"]));
  });
}

function buildSystemWarnings(system = {}, criteriaConfig = {}) {
  const warnings = [];
  const autoBidEnabled =
    criteriaConfig.autoBidEnabled !== undefined ? criteriaConfig.autoBidEnabled : system.autoBidEnabled;
  const autoBidMode = safeTrim(criteriaConfig.autoBidMode || system.autoBidMode || "safe").toLowerCase();
  const otsPipelineEnabled = system.otsIntegrationEnabled && system.otsRunPipeline !== false;
  const otsPipelineReady = otsPipelineEnabled && Boolean(system.otsProjectConfigured);
  const otsRowsPathReady = system.otsFormattedRowsPathConfigured !== false;
  const otsRowsResolvable =
    Boolean(system.otsFormattedRowsConfigured) || (otsPipelineReady && otsRowsPathReady);

  if (autoBidEnabled && autoBidMode === "live" && !system.otsBidSubmitConfigured) {
    warnings.push({
      sheet: "Auto Bid",
      reason: "live mode enabled but OTS bid submitter is not configured"
    });
  }

  if (system.whatsappState && normalizeStatus(system.whatsappState) !== "ready") {
    const state = normalizeStatus(system.whatsappState);
    warnings.push({
      sheet: "WhatsApp",
      reason:
        state === "qr_required"
          ? "WhatsApp login requires QR scan at /qr"
          : `WhatsApp is not ready: ${toCell(system.whatsappState)}${system.whatsappLastError ? ` - ${toCell(system.whatsappLastError)}` : ""}`
    });
  }

  if (system.calendarEnabled && !system.calendarClientReady) {
    warnings.push({
      sheet: "Calendar",
      reason: "Calendar is enabled but Google Calendar client is not ready"
    });
  }

  if (system.calendarEnabled && !system.calendarIdConfigured) {
    warnings.push({
      sheet: "Calendar",
      reason: "Calendar is enabled but Calendar ID is missing"
    });
  }

  if (system.databaseConfigured && !system.databaseReady) {
    warnings.push({
      sheet: "Database",
      reason: `Supabase database is not connected${system.databaseLastError ? `: ${toCell(system.databaseLastError)}` : ""}`
    });
  }

  if (system.otsIntegrationEnabled && !otsRowsResolvable) {
    warnings.push({
      sheet: "OTS Import",
      reason: "OTS import is enabled but formatted rows file is not configured or not found"
    });
  }

  if (system.otsIntegrationEnabled && system.otsRunPipeline !== false && !system.otsProjectConfigured) {
    warnings.push({
      sheet: "OTS Import",
      reason: "OTS pipeline is enabled but OTS project path is not configured or not found"
    });
  }

  return warnings;
}

function buildSystemReadiness(system = {}, criteriaConfig = {}) {
  const autoBidEnabled =
    criteriaConfig.autoBidEnabled !== undefined ? criteriaConfig.autoBidEnabled : system.autoBidEnabled;
  const autoBidMode = safeTrim(criteriaConfig.autoBidMode || system.autoBidMode || "safe").toLowerCase();
  const otsPipelineEnabled = system.otsIntegrationEnabled && system.otsRunPipeline !== false;
  const otsPipelineReady = otsPipelineEnabled && Boolean(system.otsProjectConfigured);
  const otsRowsCanBeGenerated = otsPipelineReady && system.otsFormattedRowsPathConfigured !== false;
  const whatsappState = normalizeStatus(system.whatsappState || "ready");
  const whatsappReadiness =
    whatsappState === "ready"
      ? "READY"
      : whatsappState === "qr_required"
        ? "QR"
        : ["auth_failed", "startup_timeout", "disconnected"].includes(whatsappState)
          ? "FAILED"
          : "STARTING";

  return {
    whatsapp: whatsappReadiness,
    whatsappQr: system.whatsappQrAvailable ? "AVAILABLE" : "OFF",
    recommendationEngine: system.recommendationEngineReady === false ? "STARTING" : "READY",
    otsImportRunner: system.otsImportRunnerReady === false ? "STARTING" : "READY",
    otsRows: system.otsFormattedRowsConfigured ? "READY" : otsRowsCanBeGenerated ? "PIPELINE" : "MISSING",
    otsPipeline: !otsPipelineEnabled ? "OFF" : otsPipelineReady ? "READY" : "MISSING",
    otsSubmitter: system.otsBidSubmitConfigured ? "READY" : "MISSING",
    autoBidRunner: system.autoBidRunnerReady === false ? "STARTING" : "READY",
    autoBidMode: autoBidEnabled ? autoBidMode.toUpperCase() : "OFF",
    calendar: !system.calendarEnabled ? "OFF" : system.calendarClientReady ? "READY" : "MISSING",
    calendarId: !system.calendarEnabled ? "OFF" : system.calendarIdConfigured ? "READY" : "MISSING",
    database: !system.databaseConfigured ? "OFF" : system.databaseReady ? "READY" : "MISSING"
  };
}

function getRideId(record = {}) {
  return toCell(record.Refer || record["Ride ID"]);
}

function getRideDedupeKey(record = {}) {
  return (
    getRideId(record) ||
    [
      toCell(record["Pickup Day & Date"] || record.Date),
      toCell(record["Starting Timing"] || record.Time),
      toCell(record.Pickup),
      toCell(record["Drop Off"])
    ]
      .join("|")
      .toLowerCase()
  );
}

function getPickupDateTime(record = {}, options = {}) {
  return parsePickupDateTime(
    toCell(record["Pickup Day & Date"] || record.Date),
    toCell(record["Starting Timing"] || record.Time),
    { timeZone: options.timeZone || "Europe/London" }
  );
}

function isFutureRide(record = {}, options = {}) {
  if (isClosedRideStatus(record.Status)) return false;
  const pickupDateTime = getPickupDateTime(record, options);
  if (!pickupDateTime) return false;
  const now = options.now instanceof Date ? options.now : new Date();
  return pickupDateTime.getTime() > now.getTime();
}

function buildPrebookJobRecords(data = {}, options = {}) {
  const byKey = new Map();
  const sources = [
    ...(data.rides || []),
    ...(data.upcomingJobs || []),
    ...(data.finalBid || [])
  ];

  for (const record of sources) {
    if (!isFutureRide(record, options)) continue;
    const key = getRideDedupeKey(record);
    if (!key) continue;
    byKey.set(key, record);
  }

  return sortRideRecordsByPickupDateTime(Array.from(byKey.values()));
}

function parseTimestamp(value) {
  const text = toCell(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function latestRecordTime(record = {}) {
  return (
    parseTimestamp(
      record.createdTime ||
        record["Created Time"] ||
        record.sourceTime ||
        record["Source Time"] ||
        record.updatedTime ||
        record["Updated Time"]
    ) || null
  );
}

function sortNewestRecords(records = []) {
  return (Array.isArray(records) ? records : []).slice().sort((left, right) => {
    const leftTime = latestRecordTime(left);
    const rightTime = latestRecordTime(right);
    if (leftTime && rightTime && leftTime.getTime() !== rightTime.getTime()) {
      return rightTime.getTime() - leftTime.getTime();
    }
    if (leftTime) return -1;
    if (rightTime) return 1;
    return 0;
  });
}

function sortScheduleRecordsByStartTime(records = []) {
  return (Array.isArray(records) ? records : []).slice().sort((left, right) => {
    const leftDate = parseTimestamp(left["Start Time"] || left.start_time);
    const rightDate = parseTimestamp(right["Start Time"] || right.start_time);
    if (leftDate && rightDate) return leftDate.getTime() - rightDate.getTime();
    if (leftDate) return -1;
    if (rightDate) return 1;
    return 0;
  });
}

function countBy(records = [], resolver = () => "") {
  const out = {};
  for (const record of records) {
    const key = toCell(resolver(record)) || "Unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function detectSource(record = {}) {
  const source = `${toCell(record["Group Name"])} ${toCell(record["Source Name"])}`.toLowerCase();
  if (source.includes("ots")) return "OTS";
  if (source.includes("whatsapp") || toCell(record["Group Name"])) return "WhatsApp";
  return "Other";
}

function deriveReviewReason(record = {}) {
  const explicitReason = toCell(record.Reason || record["Review Reason"]);
  if (explicitReason) return explicitReason;

  const paymentStatus = toCell(record["Payment Status"]);
  if (/missing|invalid|review|failed|unresolved|contaminated|confidence/i.test(paymentStatus)) {
    return paymentStatus;
  }

  const missing = [];
  if (!toCell(record.Pickup)) missing.push("pickup");
  if (!toCell(record["Drop Off"])) missing.push("drop off");
  if (!toCell(record["Pickup Day & Date"] || record.Date)) missing.push("date");
  if (!toCell(record["Starting Timing"] || record.Time)) missing.push("time");
  if (!toCell(record.Fare)) missing.push("fare");
  if (!toCell(record["Required Vehicle"])) missing.push("vehicle");

  if (missing.length > 0) return `Missing ${missing.join(", ")}`;
  return "Needs operator review";
}

function hasRequiredReviewFields(record = {}) {
  return Boolean(
    toCell(record.Pickup) &&
      toCell(record["Drop Off"]) &&
      toCell(record["Pickup Day & Date"] || record.Date) &&
      toCell(record["Starting Timing"] || record.Time) &&
      toCell(record.Fare) &&
      toCell(record["Required Vehicle"])
  );
}

function buildSummary(data = {}, now = new Date(), options = {}) {
  const rides = data.rides || [];
  const finalBid = data.finalBid || [];
  const needsReview = data.needsReview || [];
  const upcomingJobs = data.upcomingJobs || [];
  const recommendations = data.recommendations || [];
  const drivers = data.drivers || [];
  const vehicles = data.vehicles || [];
  const driverSchedule = data.driverSchedule || [];
  const vehicleSchedule = data.vehicleSchedule || [];
  const linkedRides = data.linkedRides || [];
  const bidTracker = data.bidTracker || [];

  return {
    totalRides: rides.length,
    todayRides: rides.filter((record) => isTodayRide(record, now)).length,
    prebookJobs: buildPrebookJobRecords(data, { now, timeZone: options.timeZone }).length,
    needsReview: needsReview.length,
    upcomingJobs: upcomingJobs.length,
    finalBid: finalBid.length,
    approvedJobs: finalBid.filter((record) => normalizeStatus(record.Status) === "approved").length,
    assignedRides: finalBid.filter((record) => toCell(record["Assigned Driver"])).length,
    pendingFinalBid: finalBid.filter((record) => {
      const status = normalizeStatus(record.Status);
      return !status || status === "pending";
    }).length,
    calendarCreated: finalBid.filter(
      (record) => normalizeStatus(record["Calendar Status"]) === "created"
    ).length,
    calendarFailed: finalBid.filter((record) =>
      ["failed", "create failed"].includes(normalizeStatus(record["Calendar Status"]))
    ).length,
    activeDriverSchedule: driverSchedule.filter(
      (record) => !isClosedScheduleStatus(record.Status)
    ).length,
    activeVehicleSchedule: vehicleSchedule.filter(
      (record) => !isClosedScheduleStatus(record.Status)
    ).length,
    pendingRecommendations: recommendations.filter((record) => {
      const status = normalizeStatus(record.Status);
      return !status || status === "pending";
    }).length,
    availableDrivers: drivers.filter(
      (record) => normalizeStatus(record.Status) === "available"
    ).length,
    availableVehicles: vehicles.filter((record) => {
      const status = normalizeStatus(record.Status || record.Availability);
      return !status || status === "available" || status === "active" || status === "ready";
    }).length,
    totalVehicles: vehicles.length,
    linkedOpportunities: linkedRides.filter((record) => {
      const status = normalizeStatus(record.Status);
      return !status || status === "pending" || status === "open";
    }).length,
    pendingBids: bidTracker.filter((record) => {
      const adminStatus = normalizeStatus(record["Admin Status"]);
      const bidStatus = normalizeStatus(record["Bid Status"]);
      return (!adminStatus || adminStatus === "pending") && bidStatus !== "bid done";
    }).length,
    readyBids: bidTracker.filter(isBidReadyForSubmission).length,
    completedBids: bidTracker.filter(
      (record) => normalizeStatus(record["Bid Status"]) === "bid done"
    ).length,
    failedBids: bidTracker.filter(
      (record) => normalizeStatus(record["Bid Status"]) === "bid failed"
    ).length,
    sources: countBy(rides, detectSource)
  };
}

function buildAssignedVehicleLookup(vehicleScheduleRows = []) {
  const lookup = new Map();
  sortScheduleRecordsByStartTime(vehicleScheduleRows).forEach((record) => {
    const rideId = getRideId(record);
    const vehicleId = toCell(record["Vehicle ID"]);
    if (!rideId || !vehicleId || isClosedScheduleStatus(record.Status)) return;
    lookup.set(rideId, vehicleId);
  });
  return lookup;
}

function buildRecommendationLookup(recommendations = []) {
  const lookup = new Map();
  sortRecommendations(recommendations).forEach((record) => {
    if (!record.rideId || lookup.has(record.rideId)) return;
    lookup.set(record.rideId, record);
  });
  return lookup;
}

function bidUpdatedTimestamp(record = {}) {
  const parsed = parseTimestamp(record.updatedTime || record["Updated Time"]);
  return parsed ? parsed.getTime() : 0;
}

function buildBidLookup(bids = []) {
  const lookup = new Map();
  bids
    .slice()
    .sort((left, right) => bidUpdatedTimestamp(right) - bidUpdatedTimestamp(left))
    .forEach((record) => {
      if (!record.rideId || lookup.has(record.rideId)) return;
      lookup.set(record.rideId, record);
    });
  return lookup;
}

function buildLinkedRideLookup(linkedRides = []) {
  const lookup = new Map();
  linkedRides.forEach((record) => {
    const status = normalizeStatus(record.status || record.Status);
    if (["cancelled", "canceled", "failed", "rejected", "completed"].includes(status)) return;

    const linkId = toCell(record.linkId || record["Link ID"]);
    const firstRideId = toCell(record.firstRideId || record["First Ride ID"]);
    const secondRideId = toCell(record.secondRideId || record["Second Ride ID"]);
    if (!linkId || !firstRideId || !secondRideId) return;

    const common = {
      linkId,
      timeGap: toCell(record.timeGap || record["Time Gap"]),
      distanceBetween: toCell(record.distanceBetween || record["Distance Between"]),
      savingEstimate: toCell(record.savingEstimate || record["Saving Estimate"]),
      status: toCell(record.status || record.Status) || "Open"
    };

    if (!lookup.has(firstRideId)) {
      lookup.set(firstRideId, { ...common, linkedWithRideId: secondRideId, linkedRole: "First" });
    }
    if (!lookup.has(secondRideId)) {
      lookup.set(secondRideId, { ...common, linkedWithRideId: firstRideId, linkedRole: "Second" });
    }
  });
  return lookup;
}

function deriveJobAction(record = {}, recommendation = null, bid = null) {
  const rideStatus = normalizeStatus(record.Status);
  const calendarStatus = normalizeStatus(record["Calendar Status"]);
  const assignmentStatus = normalizeStatus(recommendation?.assignmentStatus);
  const bidStatus = normalizeStatus(bid?.bidStatus);
  const bidAdminStatus = normalizeStatus(bid?.adminStatus);
  const assignedDriver = toCell(record["Assigned Driver"]);

  if (["failed", "create failed"].includes(calendarStatus)) {
    return { reason: "Retry Calendar", priority: 0 };
  }
  if (assignmentStatus === "failed") {
    return { reason: "Retry AI Assignment", priority: 1 };
  }
  // A dispatch operator must accept the ride before accepting its driver suggestion.
  // Keeping this order prevents the dashboard from showing an impossible next action.
  if (!rideStatus || rideStatus === "pending") {
    return { reason: "Approve Ride", priority: 2 };
  }
  if (!assignedDriver && recommendation?.driverId && recommendation?.vehicleId && (!assignmentStatus || assignmentStatus === "pending")) {
    return { reason: "Assign AI", priority: 3 };
  }
  if (bidStatus === "bid failed") {
    return { reason: "Review Failed Bid", priority: 4 };
  }
  if (rideStatus === "approved" && !bidStatus) {
    return { reason: "Create Bid", priority: 5 };
  }
  if (bidAdminStatus === "pending") {
    return { reason: "Approve Bid", priority: 6 };
  }
  if (bidAdminStatus === "approved" && bidStatus && bidStatus !== "bid done") {
    return { reason: "Submit Bid", priority: 7 };
  }

  return { reason: "", priority: 99 };
}

function sortActionRequiredJobs(jobs = []) {
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job.actionReason)
    .slice()
    .sort((left, right) => {
      const leftReceived = latestRecordTime(left);
      const rightReceived = latestRecordTime(right);
      if (leftReceived && rightReceived && leftReceived.getTime() !== rightReceived.getTime()) {
        return rightReceived.getTime() - leftReceived.getTime();
      }
      if (leftReceived) return -1;
      if (rightReceived) return 1;

      const priorityDiff = (left.actionPriority ?? 99) - (right.actionPriority ?? 99);
      if (priorityDiff !== 0) return priorityDiff;

      const leftDate = parsePickupDateTime({
        "Pickup Day & Date": left.date,
        "Starting Timing": left.time
      });
      const rightDate = parsePickupDateTime({
        "Pickup Day & Date": right.date,
        "Starting Timing": right.time
      });
      if (leftDate && rightDate) return leftDate.getTime() - rightDate.getTime();
      if (leftDate) return -1;
      if (rightDate) return 1;

      return toCell(left.rideId).localeCompare(toCell(right.rideId));
    });
}

function compactRide(record = {}, context = {}) {
  const rideId = toCell(record.Refer || record["Ride ID"]);
  const recommendation =
    context.recommendationByRideId instanceof Map ? context.recommendationByRideId.get(rideId) : null;
  const bid = context.bidByRideId instanceof Map ? context.bidByRideId.get(rideId) : null;
  const linkedRide =
    context.linkedRideByRideId instanceof Map ? context.linkedRideByRideId.get(rideId) : null;
  const assignedVehicle =
    toCell(record["Assigned Vehicle"]) ||
    (context.assignedVehicleByRideId instanceof Map
      ? context.assignedVehicleByRideId.get(rideId)
      : "");
  const action = deriveJobAction(record, recommendation, bid);

  return {
    rideId,
    source: detectSource(record),
    pickup: toCell(record.Pickup),
    dropOff: toCell(record["Drop Off"]),
    date: toCell(record["Pickup Day & Date"] || record.Date),
    time: toCell(record["Starting Timing"] || record.Time),
    sourceTime: toCell(record["Source Time"]),
    createdTime: toCell(record["Created Time"]),
    fare: toCell(record.Fare),
    vehicle: toCell(record["Required Vehicle"]),
    assignedVehicle: assignedVehicle || "",
    recommendedDriver: recommendation?.driverId || "",
    recommendedVehicle: recommendation?.vehicleId || "",
    recommendationScore: recommendation?.score || "",
    recommendationStatus: recommendation?.status || "",
    assignmentStatus: recommendation?.assignmentStatus || "",
    bidType: bid?.bidType || "",
    bidStatus: bid?.bidStatus || "",
    bidAdminStatus: bid?.adminStatus || "",
    bidAmount: bid?.bidAmount || "",
    linkedRideId: linkedRide?.linkId || recommendation?.linkedRideId || "",
    linkedWithRideId:
      linkedRide?.linkedWithRideId || recommendation?.previousRide || recommendation?.nextRide || "",
    linkedTimeGap: linkedRide?.timeGap || recommendation?.timeGap || "",
    linkedDistanceBetween: linkedRide?.distanceBetween || recommendation?.distanceBetween || "",
    linkedSaving: linkedRide?.savingEstimate || recommendation?.estimatedSaving || "",
    actionReason: action.reason,
    actionPriority: action.priority,
    status: toCell(record.Status) || "Pending",
    assignedDriver: toCell(record["Assigned Driver"]),
    calendarStatus: toCell(record["Calendar Status"]),
    reviewReason: deriveReviewReason(record),
    reviewReady: hasRequiredReviewFields(record)
  };
}

function compactRecommendation(record = {}) {
  return {
    rideId: toCell(record["Ride ID"]),
    driverId: toCell(record["Recommended Driver"]),
    vehicleId: toCell(record["Recommended Vehicle"]),
    previousRide: toCell(record["Previous Ride"]),
    nextRide: toCell(record["Next Ride"]),
    timeGap: toCell(record["Time Gap"]),
    distanceBetween: toCell(record["Distance Between"]),
    estimatedSaving: toCell(record["Estimated Saving"]),
    score: toCell(record.Score),
    status: toCell(record.Status) || "Pending",
    assignmentStatus: toCell(record["Assignment Status"]) || "Pending",
    reason: toCell(record.Reason),
    linkedRideId: toCell(record["Linked Ride ID"]),
    createdTime: toCell(record["Created Time"])
  };
}

function compactLinkedRide(record = {}) {
  return {
    linkId: toCell(record["Link ID"]),
    firstRideId: toCell(record["First Ride ID"]),
    secondRideId: toCell(record["Second Ride ID"]),
    driverId: toCell(record["Driver ID"]),
    vehicleId: toCell(record["Vehicle ID"]),
    previousDrop: toCell(record["Previous Drop"]),
    nextPickup: toCell(record["Next Pickup"]),
    timeGap: toCell(record["Time Gap"]),
    distanceBetween: toCell(record["Distance Between"]),
    savingEstimate: toCell(record["Saving Estimate"]),
    status: toCell(record.Status) || "Pending",
    createdTime: toCell(record["Created Time"])
  };
}

function compactBid(record = {}) {
  return {
    rideId: toCell(record["Ride ID"]),
    source: toCell(record.Source),
    pickup: toCell(record.Pickup),
    dropOff: toCell(record["Drop Off"]),
    fare: toCell(record.Fare),
    vehicle: toCell(record["Required Vehicle"]),
    bidType: toCell(record["Bid Type"]),
    bidStatus: toCell(record["Bid Status"]) || "Suggested",
    adminStatus: toCell(record["Admin Status"]) || "Pending",
    bidAmount: toCell(record["Bid Amount"]),
    reason: toCell(record.Reason),
    estimatedCost: toCell(record["Estimated Cost"]),
    estimatedProfit: toCell(record["Estimated Profit"]),
    marginPercent: toCell(record["Margin %"]),
    linkedSaving: toCell(record["Linked Saving"]),
    aiDecision: toCell(record["AI Decision"]),
    pricingConfidence: toCell(record["Pricing Confidence"]),
    updatedTime: toCell(record["Updated Time"]),
    createdTime: toCell(record["Created Time"])
  };
}

function compactDriverSchedule(record = {}) {
  return {
    assignmentId: toCell(record["Assignment ID"]),
    driverId: toCell(record["Driver ID"]),
    rideId: toCell(record["Ride ID"]),
    pickup: toCell(record.Pickup),
    dropOff: toCell(record["Drop Off"]),
    startTime: toCell(record["Start Time"]),
    endTime: toCell(record["End Time"]),
    status: toCell(record.Status) || "Assigned",
    nextAvailableTime: toCell(record["Next Available Time"]),
    currentLocation: toCell(record["Current Location"]),
    previousRideId: toCell(record["Previous Ride ID"]),
    nextRideId: toCell(record["Next Ride ID"])
  };
}

function compactVehicleSchedule(record = {}) {
  return {
    vehicleId: toCell(record["Vehicle ID"]),
    rideId: toCell(record["Ride ID"]),
    driverId: toCell(record["Driver ID"]),
    startTime: toCell(record["Start Time"]),
    endTime: toCell(record["End Time"]),
    status: toCell(record.Status) || "Assigned"
  };
}

function compactAudit(record = {}) {
  return {
    auditId: toCell(record["Audit ID"]),
    action: toCell(record.Action),
    targetType: toCell(record["Target Type"]),
    targetId: toCell(record["Target ID"]),
    field: toCell(record.Field),
    oldValue: toCell(record["Old Value"]),
    newValue: toCell(record["New Value"]),
    actor: toCell(record.Actor),
    status: toCell(record.Status),
    reason: toCell(record.Reason),
    createdTime: toCell(record["Created Time"])
  };
}

function limitRows(rows = [], limit = DEFAULT_LIMIT) {
  return rows.slice(0, Math.max(1, Number(limit) || DEFAULT_LIMIT));
}

function buildDashboardPayload(data = {}, options = {}) {
  const limit = options.limit || DEFAULT_LIMIT;
  const system = options.system || {};
  const criteriaConfig = resolveCriteriaConfig(mapCriteriaRows(data.dispatchCriteria || []), {
    finalBidMinFare: system.finalBidMinFare || system.minFare,
    finalBidAllowedAreaCodes: system.allowedAreaCodes || [],
    finalBidAreaMatchMode: system.areaMatchMode,
    finalBidAllowedVehicles: system.allowedVehicles || [],
    finalBidExcludedVehicles: system.excludedVehicles || [],
    autoBidEnabled: system.autoBidEnabled,
    autoBidMode: system.autoBidMode
  });
  const sortedFinalBid = sortRideRecordsByPickupDateTime(data.finalBid || []);
  const sortedRides = sortRideRecordsByPickupDateTime(data.rides || []);
  const sortedUpcomingJobs = sortRideRecordsByPickupDateTime(data.upcomingJobs || []);
  const sortedDriverSchedule = sortScheduleRecordsByStartTime(data.driverSchedule || []);
  const sortedVehicleSchedule = sortScheduleRecordsByStartTime(data.vehicleSchedule || []);
  const compactRecommendations = sortRecommendations((data.recommendations || []).map(compactRecommendation));
  const compactBids = sortNewestRecords((data.bidTracker || []).map(compactBid));
  const compactLinkedRides = sortNewestRecords((data.linkedRides || []).map(compactLinkedRide));
  const rideContext = {
    assignedVehicleByRideId: buildAssignedVehicleLookup(sortedVehicleSchedule),
    recommendationByRideId: buildRecommendationLookup(compactRecommendations),
    bidByRideId: buildBidLookup(compactBids),
    linkedRideByRideId: buildLinkedRideLookup(compactLinkedRides)
  };
  const prebookJobs = buildPrebookJobRecords(data, {
    now: options.now || new Date(),
    timeZone: options.timeZone
  });
  const finalBidJobs = sortedFinalBid.map((record) => compactRide(record, rideContext));
  const allJobRecords = new Map();
  sortedRides.forEach((record) => {
    const rideId = toCell(record.Refer || record["Ride ID"]);
    if (rideId) allJobRecords.set(rideId, record);
  });
  sortedFinalBid.forEach((record) => {
    const rideId = toCell(record.Refer || record["Ride ID"]);
    if (rideId) allJobRecords.set(rideId, { ...(allJobRecords.get(rideId) || {}), ...record });
  });
  const allOperationalJobs = Array.from(allJobRecords.values()).map((record) => compactRide(record, rideContext));
  const approvedJobs = sortedFinalBid
    .filter((record) => normalizeStatus(record.Status) === "approved")
    .map((record) => compactRide(record, rideContext));
  const prebookJobRows = prebookJobs.map((record) => compactRide(record, rideContext));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    system,
    criteriaConfig,
    systemReadiness: buildSystemReadiness(system, criteriaConfig),
    systemWarnings: buildSystemWarnings(system, criteriaConfig),
    summary: buildSummary(data, options.now || new Date(), { timeZone: options.timeZone }),
    actionRequiredJobs: limitRows(sortActionRequiredJobs(finalBidJobs), limit),
    jobs: limitRows(sortNewestRecords(allOperationalJobs), limit),
    approvedJobs: limitRows(approvedJobs, limit),
    prebookJobs: limitRows(prebookJobRows, limit),
    upcomingJobs: limitRows(sortedUpcomingJobs.map((record) => compactRide(record, rideContext)), limit),
    needsReview: limitRows(
      (data.needsReview || []).slice().reverse().map((record) => compactRide(record, rideContext)),
      limit
    ),
    recentRides: limitRows(sortedRides.map((record) => compactRide(record, rideContext)), limit),
    recommendations: limitRows(compactRecommendations, limit),
    linkedRides: limitRows(compactLinkedRides, limit),
    driverSchedule: limitRows(sortedDriverSchedule.map(compactDriverSchedule), limit),
    vehicleSchedule: limitRows(sortedVehicleSchedule.map(compactVehicleSchedule), limit),
    bids: limitRows(compactBids, limit),
    criteria: data.dispatchCriteria || [],
    auditLogs: limitRows((data.auditLog || []).slice().reverse().map(compactAudit), 30),
    drivers: limitRows(data.drivers || [], limit),
    vehicles: limitRows(data.vehicles || [], limit)
  };
}

async function loadDashboardData(options = {}) {
  if (options.databasePrimaryEnabled && options.databaseRepository) {
    try {
      const dbData = await options.databaseRepository.loadDashboardData();
      const payload = buildDashboardPayload(dbData, options);
      payload.sheetErrors = [];
      payload.dataSource = "database";
      return payload;
    } catch (error) {
      if (!options.sheetsClient || !options.spreadsheetId) {
        throw error;
      }
    }
  }

  if (!options.sheetsClient || !options.spreadsheetId) {
    const payload = buildDashboardPayload({}, options);
    payload.sheetErrors = [
      {
        sheet: "Google Sheets",
        reason: "Google Sheets data is not ready yet"
      }
    ];
    return payload;
  }

  const worksheetNames = {
    ...DEFAULT_WORKSHEET_NAMES,
    ...(options.worksheetNames || {})
  };

  const names = Object.entries(worksheetNames);
  const settled = await Promise.allSettled(
    names.map(([, worksheetName]) =>
      readWorksheetRecords({
        sheetsClient: options.sheetsClient,
        spreadsheetId: options.spreadsheetId,
        worksheetName
      })
    )
  );

  const data = {};
  const errors = [];
  names.forEach(([key, worksheetName], index) => {
    const result = settled[index];
    if (result.status === "fulfilled") {
      data[key] = result.value;
    } else {
      data[key] = [];
      errors.push({
        sheet: worksheetName,
        reason: safeTrim(result.reason?.message || result.reason)
      });
    }
  });

  const payload = buildDashboardPayload(data, options);
  payload.sheetErrors = errors;
  payload.dataSource = "sheets";
  return payload;
}

function renderDashboardPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ACE Dispatch Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: #f6f7fb; color: #111827; }
    header { position: sticky; top: 0; z-index: 10; height: 58px; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; background: #ffffff; border-bottom: 1px solid #d8dee8; }
    .brand { font-weight: 800; letter-spacing: .4px; }
    .meta { color: #667085; font-size: 12px; text-align: right; }
    main { padding: 18px 24px 34px; max-width: 1500px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 14px; margin: 0 0 12px; }
    .sub { margin: 0; color: #667085; font-size: 13px; }
    .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .page-note { color: #475467; font-size: 12px; text-align: right; }
    .tabs { display: flex; gap: 8px; overflow-x: auto; padding: 4px 0 14px; margin-bottom: 2px; }
    .tabs button { flex: 0 0 auto; min-height: 34px; padding: 8px 12px; border-radius: 7px; background: #fff; color: #334155; }
    .tabs button.active { background: #1f2937; border-color: #1f2937; color: #fff; }
    .view { display: none; }
    .view.active { display: block; }
    .grid { display: grid; gap: 14px; }
    .cards { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .panel { background: #fff; border: 1px solid #d8dee8; border-radius: 8px; }
    .flow-step { display: flex; align-items: center; gap: 10px; min-height: 76px; padding: 12px; background: #fff; border: 1px solid #d8dee8; border-radius: 8px; }
    .flow-step.attention { border-color: #fed7aa; background: #fffaf5; }
    .flow-step.danger { border-color: #fecdd3; background: #fff7f8; }
    .ring { flex: 0 0 auto; width: 48px; height: 48px; border-radius: 50%; border: 5px solid #d8dee8; display: flex; align-items: center; justify-content: center; color: #0f172a; font-size: 17px; font-weight: 800; line-height: 1; }
    .flow-step.attention .ring { border-color: #f59e0b; background: #fffbeb; }
    .flow-step.danger .ring { border-color: #e11d48; background: #fff1f2; }
    .flow-copy { min-width: 0; }
    .flow-title { color: #0f172a; font-size: 12px; font-weight: 800; margin-bottom: 4px; }
    .flow-hint { color: #667085; font-size: 11px; line-height: 1.25; }
    .label { color: #667085; font-size: 12px; }
    .value { font-size: 22px; line-height: 1.1; font-weight: 800; margin-top: 8px; overflow-wrap: anywhere; }
    .panel { padding: 14px; margin-bottom: 14px; overflow: hidden; }
    .panel-note { color: #667085; font-size: 12px; margin: -4px 0 12px; }
    .two-col { grid-template-columns: minmax(0, 1.15fr) minmax(360px, .85fr); align-items: start; }
    .table-shell { width: 100%; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; }
    table { width: 100%; min-width: 920px; border-collapse: collapse; font-size: 12px; }
    th { position: sticky; top: 0; z-index: 1; text-align: left; background: #1f2937; color: #fff; font-size: 11px; letter-spacing: .3px; text-transform: uppercase; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    tr:last-child td { border-bottom: 0; }
    td { color: #1f2937; }
    .pill { display: inline-block; padding: 3px 7px; border-radius: 999px; background: #eef4ff; color: #1d4ed8; font-size: 11px; font-weight: 700; }
    .ok { background: #ecfdf3; color: #047857; }
    .bad { background: #fff1f2; color: #be123c; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .toolbar { display: grid; grid-template-columns: 1fr 120px; gap: 8px; margin: 8px 0 10px; }
    .toolbar input, .toolbar select {
      width: 100%;
      border: 1px solid #cfd8e3;
      border-radius: 6px;
      padding: 7px 8px;
      font-size: 12px;
      background: #fff;
      color: #1f2937;
    }
    .inline-form {
      display: grid;
      grid-template-columns: repeat(6, minmax(96px, 1fr)) auto;
      gap: 8px;
      margin: 8px 0 12px;
    }
    .inline-form input, .inline-form select {
      width: 100%;
      border: 1px solid #cfd8e3;
      border-radius: 6px;
      padding: 7px 8px;
      font-size: 12px;
      background: #fff;
      color: #1f2937;
    }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-weight: 700; color: #1f2937; }
    .section-title span { color: #667085; font-size: 11px; font-weight: 600; }
    .fleet-table { max-height: 360px; overflow: auto; }
    .fleet-table table { min-width: 520px; }
    .reason { display: block; max-width: 260px; white-space: normal; line-height: 1.35; }
    button { border: 1px solid #cfd8e3; background: #fff; color: #1f2937; border-radius: 6px; padding: 6px 8px; font-size: 11px; font-weight: 700; cursor: pointer; }
    button:hover { background: #f3f6fb; }
    body.busy button { pointer-events: none; opacity: .65; }
    button:disabled { cursor: not-allowed; opacity: .55; background: #f3f4f6; color: #64748b; }
    button.primary { background: #1f2937; color: #fff; border-color: #1f2937; }
    button.good { background: #ecfdf3; color: #047857; border-color: #a7f3d0; }
    button.warn { background: #fff7ed; color: #c2410c; border-color: #fed7aa; }
    .empty { color: #667085; padding: 18px 0; }
    .compact table { min-width: 640px; }
    @media (max-width: 980px) {
      .cards, .two-col { grid-template-columns: 1fr; }
      .page-head { align-items: flex-start; flex-direction: column; }
      .page-note { text-align: left; }
      main { padding: 16px; }
      table { font-size: 11px; }
      th, td { padding: 8px; }
      .toolbar { grid-template-columns: 1fr; }
      .inline-form { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">ACE</div>
    <div class="meta" id="updated">Loading...</div>
  </header>
  <main>
    <div class="page-head">
      <div>
        <h1>Dispatch Dashboard</h1>
        <p class="sub">WhatsApp, OTS, AI dispatch, schedules, bids and fleet controls.</p>
      </div>
      <div class="page-note">Work from left to right: review, approve, assign, then schedule.</div>
    </div>
    <nav class="tabs" aria-label="Dashboard views">
      <button class="active" data-view-tab="command" onclick="showView('command')">Command Center</button>
      <button data-view-tab="pipeline" onclick="showView('pipeline')">Ride Pipeline</button>
      <button data-view-tab="ai" onclick="showView('ai')">AI & Schedules</button>
      <button data-view-tab="bids" onclick="showView('bids')">Bid Control</button>
      <button data-view-tab="fleet" onclick="showView('fleet')">Fleet & Settings</button>
    </nav>
    <section class="grid cards" id="cards"></section>
    <section class="view active" data-view="command">
      <div class="grid two-col">
        <div>
          <div class="panel">
            <h2>Action Required</h2>
            <p class="panel-note">Jobs needing approval, assignment, calendar retry, or bid review.</p>
            <div id="actionRequiredJobs"></div>
          </div>
          <div class="panel">
            <h2>Final Bid Jobs</h2>
            <div id="warnings"></div>
            <div id="jobs"></div>
          </div>
        </div>
        <div>
          <div class="panel">
            <h2>Approved Jobs</h2>
            <p class="panel-note">Approved rides with driver, vehicle, bid, and calendar status.</p>
            <div id="approvedJobs"></div>
          </div>
        </div>
      </div>
    </section>
    <section class="view" data-view="pipeline">
      <div class="grid two-col">
        <div>
          <div class="panel">
            <h2>Pre-book Jobs</h2>
            <div id="prebookJobs"></div>
          </div>
          <div class="panel">
            <h2>Upcoming Jobs</h2>
            <div id="upcoming"></div>
          </div>
        </div>
        <div>
          <div class="panel">
            <h2>Needs Review</h2>
            <p class="panel-note">Fix missing route, date, fare, or vehicle fields, then move to Final Bid.</p>
            <div id="needsReview"></div>
          </div>
        </div>
      </div>
    </section>
    <section class="view" data-view="ai">
      <div class="grid two-col">
        <div>
          <div class="panel">
            <h2>Driver Recommendations</h2>
            <div id="recommendations"></div>
          </div>
          <div class="panel">
            <h2>Linked Ride Opportunities</h2>
            <div id="linked"></div>
          </div>
        </div>
        <div>
          <div class="panel">
            <h2>Driver Timeline</h2>
            <div id="driverSchedule"></div>
          </div>
          <div class="panel">
            <h2>Vehicle Bookings</h2>
            <div id="vehicleSchedule"></div>
          </div>
        </div>
      </div>
    </section>
    <section class="view" data-view="bids">
      <div class="panel">
        <h2>Bid Control</h2>
        <p class="panel-note">Price is a profitable estimate. Review amount and margin, then approve before OTS submission.</p>
        <div id="bids"></div>
      </div>
    </section>
    <section class="view" data-view="fleet">
      <div class="grid two-col">
        <div class="panel">
          <h2>Fleet Snapshot</h2>
          <p class="panel-note">Add drivers and vehicles, then mark availability before dispatch testing.</p>
          <div id="fleet"></div>
        </div>
        <div class="panel">
          <h2>Dispatch Criteria</h2>
          <div id="criteria"></div>
          <h2 style="margin-top:18px;">WhatsApp Connection</h2>
          <div id="whatsappControl"></div>
          <h2 style="margin-top:18px;">Audit Log</h2>
          <div id="audit"></div>
        </div>
      </div>
    </section>
  </main>
  <script>
    const money = (v) => v ? (String(v).startsWith("£") ? v : "£" + v) : "";
    const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    const pillClass = (v) => /fail|offline|busy/i.test(v || "") ? "pill bad" : /created|assigned|available|approved/i.test(v || "") ? "pill ok" : "pill";
    const TOKEN_KEY = 'aceDashboardToken';
    const ACTOR_KEY = 'aceDashboardActor';
    let latestDashboardData = null;
    let currentDashboardView = 'command';
    let dashboardActionInFlight = false;
    function table(rows, cols) {
      if (!rows.length) return '<div class="empty">No records yet.</div>';
      return '<div class="table-shell"><table><thead><tr>' + cols.map(c => '<th>' + esc(c.label) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + cols.map(c => '<td>' + (c.render ? c.render(r) : esc(r[c.key])) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }
    function showView(view) {
      currentDashboardView = view || 'command';
      document.querySelectorAll('[data-view]').forEach(section => {
        section.classList.toggle('active', section.getAttribute('data-view') === currentDashboardView);
      });
      document.querySelectorAll('[data-view-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.getAttribute('data-view-tab') === currentDashboardView);
      });
    }
    function renderSystemWarnings(data) {
      const sheetErrors = Array.isArray(data.sheetErrors) ? data.sheetErrors : [];
      const systemWarnings = Array.isArray(data.systemWarnings) ? data.systemWarnings : [];
      const items = sheetErrors.concat(systemWarnings);
      const target = document.getElementById('warnings');
      if (!target) return;
      if (!items.length) {
        target.innerHTML = '';
        return;
      }
      function warningLine(item) {
        const sheet = item.sheet || 'Sheet';
        const reason = item.reason || 'read failed';
        const base = esc(sheet + ': ' + reason);
        if (String(sheet).toLowerCase() === 'whatsapp' && /QR scan|\\/qr/i.test(String(reason || ''))) {
          return base + ' <a href="/qr" target="_blank" rel="noreferrer" style="color:#9a3412;font-weight:800;">Open QR</a>';
        }
        return base;
      }
      target.innerHTML = '<div style="border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;line-height:1.45;"><strong>System Warnings</strong><br>' +
        items.map(warningLine).join('<br>') +
        '</div>';
    }
    function dashboardHeaders(extra) {
      const headers = Object.assign({}, extra || {});
      const token = localStorage.getItem(TOKEN_KEY) || '';
      const actor = localStorage.getItem(ACTOR_KEY) || '';
      if (token) headers['X-Dashboard-Token'] = token;
      if (actor) headers['X-Dashboard-Actor'] = actor;
      return headers;
    }
    function promptForToken(message) {
      const token = window.prompt(message || 'Dashboard token');
      if (!token) return false;
      localStorage.setItem(TOKEN_KEY, token.trim());
      return true;
    }
    function ensureActor() {
      if (localStorage.getItem(ACTOR_KEY)) return;
      const actor = window.prompt('Operator name') || '';
      if (actor.trim()) localStorage.setItem(ACTOR_KEY, actor.trim());
    }
    async function fetchDashboard(retryAuth) {
      const res = await fetch('/api/dashboard', { cache: 'no-store', headers: dashboardHeaders() });
      if (res.status === 401 && retryAuth !== false && promptForToken('Dashboard token')) {
        return fetchDashboard(false);
      }
      return res;
    }
    async function postJson(url, body, retryAuth) {
      ensureActor();
      const res = await fetch(url, {
        method: 'POST',
        headers: dashboardHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body || {})
      });
      if (res.status === 401 && retryAuth !== false && promptForToken('Dashboard token')) {
        return postJson(url, body, false);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.message || 'Action failed');
      return data;
    }
    async function runAction(label, fn) {
      if (dashboardActionInFlight) return;
      dashboardActionInFlight = true;
      const previous = document.getElementById('updated').textContent;
      document.body.classList.add('busy');
      document.getElementById('updated').textContent = label + '...';
      try {
        await fn();
        await load();
      } catch (err) {
        document.getElementById('updated').textContent = err.message || previous;
      } finally {
        dashboardActionInFlight = false;
        document.body.classList.remove('busy');
        showView(currentDashboardView);
      }
    }
    function jsArg(value) {
      return JSON.stringify(String(value || '')).replace(/"/g, '&quot;');
    }
    function approveJob(rideId) {
      return runAction('Approving ride', () => postJson('/api/final-bid/' + encodeURIComponent(rideId) + '/status', { status: 'Approved' }));
    }
    function rejectJob(rideId) {
      return runAction('Rejecting ride', () => postJson('/api/final-bid/' + encodeURIComponent(rideId) + '/status', { status: 'Rejected' }));
    }
    function retryCalendar(rideId) {
      return runAction('Retrying calendar', () => postJson('/api/final-bid/' + encodeURIComponent(rideId) + '/calendar-retry'));
    }
    function approveRecommendationAction(rideId) {
      return runAction('Approving recommendation', () => postJson('/api/recommendations/' + encodeURIComponent(rideId) + '/approve'));
    }
    function runRecommendationsNow() {
      return runAction('Generating recommendations', () => postJson('/api/recommendations/run-now', {}));
    }
    function setDriverStatus(driverId, status) {
      return runAction('Updating driver', () => postJson('/api/drivers/' + encodeURIComponent(driverId) + '/status', { status }));
    }
    function setVehicleStatus(vehicleId, status) {
      return runAction('Updating vehicle', () => postJson('/api/vehicles/' + encodeURIComponent(vehicleId) + '/status', { status }));
    }
    function valueOf(id) {
      const input = document.getElementById(id);
      return input ? input.value.trim() : '';
    }
    function createDriver() {
      return runAction('Adding driver', () => postJson('/api/drivers', {
        driverId: valueOf('newDriverId'),
        driverName: valueOf('newDriverName'),
        whatsappNumber: valueOf('newDriverPhone'),
        currentLocation: valueOf('newDriverLocation'),
        workingHours: valueOf('newDriverHours') || 'Any',
        status: valueOf('newDriverStatus') || 'Available',
        vehicleId: ''
      }));
    }
    function createVehicle() {
      return runAction('Adding vehicle', () => postJson('/api/vehicles', {
        vehicleId: valueOf('newVehicleId'),
        vehicleType: valueOf('newVehicleType'),
        seats: valueOf('newVehicleSeats'),
        registration: valueOf('newVehicleReg'),
        driverId: '',
        status: valueOf('newVehicleStatus') || 'Available'
      }));
    }
    function createBidReview(rideId) {
      return runAction('Creating bid review', () => postJson('/api/bids/' + encodeURIComponent(rideId) + '/create'));
    }
    function runBidAiReview(rideId) {
      return runAction('Reviewing one bid with AI', () => postJson('/api/bids/' + encodeURIComponent(rideId) + '/ai-review', {}));
    }
    function promoteNeedsReview(rideId) {
      return runAction('Moving review ride', () => postJson('/api/needs-review/' + encodeURIComponent(rideId) + '/promote'));
    }
    function findReviewInput(rideId, field) {
      return Array.from(document.querySelectorAll('[data-review-field="' + field + '"]')).find(input => input.getAttribute('data-review-ride') === String(rideId || ''));
    }
    function reviewInput(r, field, value) {
      return '<input data-review-ride="' + esc(r.rideId) + '" data-review-field="' + esc(field) + '" value="' + esc(value || '') + '" style="width:150px;border:1px solid #cfd8e3;border-radius:6px;padding:6px;font-size:12px;" />';
    }
    function readReviewDraft(rideId) {
      const fields = {};
      ['pickupDayDate', 'startingTiming', 'pickup', 'dropOff', 'fare', 'requiredVehicle'].forEach(field => {
        const input = findReviewInput(rideId, field);
        if (input) fields[field] = input.value;
      });
      return fields;
    }
    function saveNeedsReview(rideId) {
      return runAction('Saving review ride', () => postJson('/api/needs-review/' + encodeURIComponent(rideId) + '/update', { fields: readReviewDraft(rideId) }));
    }
    function runOtsImportNow() {
      return runAction('Importing OTS', () => postJson('/api/ots/import-now', {}));
    }
    function runAutoBidNow() {
      const data = latestDashboardData || {};
      const criteriaConfig = data.criteriaConfig || {};
      const system = data.system || {};
      const autoBidMode = criteriaConfig.autoBidMode || system.autoBidMode || 'safe';
      return runAction('Running auto bid', () => postJson('/api/bids/process-approved', { mode: autoBidMode }));
    }
    function restartWhatsApp() {
      if (!window.confirm('Restart WhatsApp service? Saved session stays safe.')) return Promise.resolve();
      return runAction('Restarting WhatsApp', () => postJson('/api/whatsapp/restart', {}));
    }
    function resetWhatsAppSession() {
      const confirmation = window.prompt('This signs out the saved WhatsApp session. Type RESET WHATSAPP SESSION to continue.');
      if (confirmation !== 'RESET WHATSAPP SESSION') return Promise.resolve();
      return runAction('Resetting WhatsApp session', () => postJson('/api/whatsapp/session/reset', { confirmation }));
    }
    function completeScheduleRide(rideId) {
      return runAction('Completing ride', () => postJson('/api/schedules/' + encodeURIComponent(rideId) + '/complete', {}));
    }
    function readinessValue(data, key, fallback) {
      const readiness = (data && data.systemReadiness) || {};
      return String(readiness[key] || fallback || '').toUpperCase();
    }
    function headerButton(label, onClick, enabled, disabledLabel) {
      const style = 'margin-left:auto;';
      if (!enabled) {
        return '<button disabled title="' + esc(disabledLabel || label) + '" style="' + style + '">' + esc(disabledLabel || label) + '</button>';
      }
      return '<button class="primary" style="' + style + '" onclick="' + esc(onClick) + '">' + esc(label) + '</button>';
    }
    function otsImportHeaderButton(data) {
      const otsRowsState = readinessValue(data, 'otsRows', 'MISSING');
      const rowsReady = otsRowsState === 'READY' || otsRowsState === 'PIPELINE';
      const pipelineReady = readinessValue(data, 'otsPipeline', 'OFF') !== 'MISSING';
      const runnerReady = readinessValue(data, 'otsImportRunner', 'READY') === 'READY';
      if (!runnerReady) return headerButton('Import OTS Now', 'runOtsImportNow()', false, 'OTS Starting');
      if (!rowsReady || !pipelineReady) return headerButton('Import OTS Now', 'runOtsImportNow()', false, 'OTS Setup Missing');
      return headerButton('Import OTS Now', 'runOtsImportNow()', true);
    }
    function autoBidHeaderButton(data) {
      const runnerReady = readinessValue(data, 'autoBidRunner', 'READY') === 'READY';
      const liveMode = readinessValue(data, 'autoBidMode', 'SAFE') === 'LIVE';
      const submitterReady = readinessValue(data, 'otsSubmitter', 'MISSING') === 'READY';
      if (!runnerReady) return headerButton('Run Auto Bid', 'runAutoBidNow()', false, 'Auto Bid Starting');
      if (liveMode && !submitterReady) return headerButton('Run Auto Bid', 'runAutoBidNow()', false, 'Bid Setup Missing');
      return headerButton('Run Auto Bid', 'runAutoBidNow()', true);
    }
    function recommendationsHeaderButton(data) {
      const engineReady = readinessValue(data, 'recommendationEngine', 'READY') === 'READY';
      if (!engineReady) return headerButton('Generate AI Now', 'runRecommendationsNow()', false, 'AI Starting');
      return headerButton('Generate AI Now', 'runRecommendationsNow()', true);
    }
    function findBidInput(kind, rideId) {
      const attr = kind === 'reason' ? 'data-bid-reason' : 'data-bid-amount';
      return Array.from(document.querySelectorAll('[' + attr + ']')).find(input => input.getAttribute(attr) === String(rideId || ''));
    }
    function readBidDraft(rideId) {
      const amountInput = findBidInput('amount', rideId);
      const reasonInput = findBidInput('reason', rideId);
      return {
        bidAmount: amountInput ? amountInput.value : '',
        reason: reasonInput ? reasonInput.value : ''
      };
    }
    function approveBid(rideId) {
      const draft = readBidDraft(rideId);
      return runAction('Approving bid', () => postJson('/api/bids/' + encodeURIComponent(rideId) + '/admin-status', { adminStatus: 'Approved', bidAmount: draft.bidAmount, reason: draft.reason }));
    }
    function rejectBid(rideId) {
      const draft = readBidDraft(rideId);
      return runAction('Rejecting bid', () => postJson('/api/bids/' + encodeURIComponent(rideId) + '/admin-status', { adminStatus: 'Rejected', reason: draft.reason }));
    }
    function markBidDone(rideId) {
      const draft = readBidDraft(rideId);
      return runAction('Marking bid done', () => postJson('/api/bids/' + encodeURIComponent(rideId) + '/status', { bidStatus: 'Bid Done', bidAmount: draft.bidAmount, reason: draft.reason }));
    }
    function markBidFailed(rideId) {
      const draft = readBidDraft(rideId);
      return runAction('Marking bid failed', () => postJson('/api/bids/' + encodeURIComponent(rideId) + '/status', { bidStatus: 'Bid Failed', reason: draft.reason }));
    }
    function saveBidDraft(rideId, bidStatus) {
      const draft = readBidDraft(rideId);
      return runAction('Saving bid', () => postJson('/api/bids/' + encodeURIComponent(rideId) + '/status', { bidStatus: bidStatus || 'Suggested', bidAmount: draft.bidAmount, reason: draft.reason }));
    }
    function saveCriteria(setting) {
      const input = document.querySelector('[data-criteria="' + setting + '"]');
      return runAction('Saving criteria', () => postJson('/api/criteria/' + encodeURIComponent(setting), { value: input ? input.value : '' }));
    }
    function optionList(options, selected) {
      return options.map(option => '<option value="' + esc(option) + '"' + (String(selected || '').toLowerCase() === String(option).toLowerCase() ? ' selected' : '') + '>' + esc(option) + '</option>').join('');
    }
    function criteriaInput(r) {
      const setting = String(r.Setting || '');
      const value = String(r.Value || '');
      const baseStyle = 'width:100%;border:1px solid #cfd8e3;border-radius:6px;padding:6px;font-size:12px;';
      if (setting === 'FINAL_BID_AREA_MATCH_MODE') {
        return '<select data-criteria="' + esc(setting) + '" style="' + baseStyle + '">' + optionList(['either', 'pickup', 'dropoff', 'both'], value || 'either') + '</select>';
      }
      if (setting === 'AUTO_BID_ENABLED') {
        return '<select data-criteria="' + esc(setting) + '" style="' + baseStyle + '">' + optionList(['false', 'true'], value || 'false') + '</select>';
      }
      if (setting === 'AUTO_BID_MODE') {
        return '<select data-criteria="' + esc(setting) + '" style="' + baseStyle + '">' + optionList(['safe', 'live'], value || 'safe') + '</select>';
      }
      const placeholder = setting === 'FINAL_BID_ALLOWED_AREA_CODES' ? 'LHR,LGW,SW3' : '';
      return '<input data-criteria="' + esc(setting) + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" style="' + baseStyle + '" />';
    }
    function renderCriteriaPanel(data) {
      const cfg = data.criteriaConfig || {};
      const areaCodes = Array.isArray(cfg.allowedAreaCodes) ? cfg.allowedAreaCodes : [];
      const summary = '<div class="label" style="margin-bottom:10px;line-height:1.5;">Area: <strong>' + esc(areaCodes.length ? areaCodes.join(', ') : 'OFF') + '</strong><br>Mode: <strong>' + esc(cfg.areaMatchMode || 'either') + '</strong><br>Auto Bid: <strong>' + esc(cfg.autoBidEnabled ? String(cfg.autoBidMode || 'safe').toUpperCase() : 'OFF') + '</strong></div>';
      document.getElementById('criteria').innerHTML = summary + table((data.criteria || []), [
        { label: 'Setting', key: 'Setting' },
        { label: 'Value', render: criteriaInput },
        { label: 'Action', render: r => '<button class="primary" onclick="saveCriteria(' + jsArg(r.Setting) + ')">Save</button>' }
      ]);
    }
    function approveJobButton(r) {
      const status = String(r.status || '').toLowerCase();
      if (!r.rideId || status === 'approved') return '';
      if (['rejected', 'cancelled', 'canceled', 'completed'].includes(status)) return '<button disabled title="Closed Ride">Closed Ride</button>';
      return '<button class="primary" onclick="approveJob(' + jsArg(r.rideId) + ')">Approve</button>';
    }
    function rejectJobButton(r) {
      const status = String(r.status || '').toLowerCase();
      if (!r.rideId || status === 'approved') return '';
      if (['rejected', 'cancelled', 'canceled', 'completed'].includes(status)) return '';
      return '<button class="warn" onclick="rejectJob(' + jsArg(r.rideId) + ')">Reject</button>';
    }
    function retryCalendarButton(r) {
      if (!r.rideId || !/fail/i.test(String(r.calendarStatus || ''))) return '';
      const data = latestDashboardData || {};
      const calendarReady = readinessValue(data, 'calendar', 'READY') === 'READY';
      const calendarIdReady = readinessValue(data, 'calendarId', 'READY') === 'READY';
      if (!calendarReady || !calendarIdReady) return '<button disabled title="Calendar Missing">Calendar Missing</button>';
      return '<button class="warn" onclick="retryCalendar(' + jsArg(r.rideId) + ')">Retry Calendar</button>';
    }
    function approveRecommendationButton(r) {
      if (!r.rideId) return '';
      const status = String(r.status || '').toLowerCase();
      const assignmentStatus = String(r.assignmentStatus || '').toLowerCase();
      if (assignmentStatus === 'failed') {
        if (!r.driverId || !r.vehicleId) return '<button disabled title="Incomplete AI">Incomplete AI</button>';
        return '<button class="warn" onclick="approveRecommendationAction(' + jsArg(r.rideId) + ')">Retry</button>';
      }
      if (status === 'approved') return '';
      if (!r.driverId || !r.vehicleId) return '<button disabled title="Incomplete AI">Incomplete AI</button>';
      return '<button class="primary" onclick="approveRecommendationAction(' + jsArg(r.rideId) + ')">Approve</button>';
    }
    function assignAiButton(r) {
      if (!r.rideId || r.assignedDriver || !r.recommendedDriver || !r.recommendedVehicle) return '';
      const assignmentStatus = String(r.assignmentStatus || '').toLowerCase();
      if (assignmentStatus && assignmentStatus !== 'pending' && assignmentStatus !== 'failed') return '';
      const cls = assignmentStatus === 'failed' ? 'warn' : 'primary';
      const label = assignmentStatus === 'failed' ? 'Retry AI' : 'Assign AI';
      return '<button class="' + cls + '" onclick="approveRecommendationAction(' + jsArg(r.rideId) + ')">' + label + '</button>';
    }
    function promoteNeedsReviewButton(r) {
      if (!r.rideId) return '';
      if (!r.reviewReady) return '<button disabled title="Incomplete Review">Incomplete</button>';
      return '<button class="primary" onclick="promoteNeedsReview(' + jsArg(r.rideId) + ')">Move Final Bid</button>';
    }
    function saveNeedsReviewButton(r) {
      if (!r.rideId) return '';
      return '<button onclick="saveNeedsReview(' + jsArg(r.rideId) + ')">Save</button>';
    }
    function completeScheduleButton(r) {
      const status = String(r.status || '').toLowerCase();
      if (!r.rideId || ['completed', 'cancelled', 'canceled', 'failed'].includes(status)) return '';
      return '<button class="good" onclick="completeScheduleRide(' + jsArg(r.rideId) + ')">Complete</button>';
    }
    function driverStatusButtons(r) {
      const id = r['Driver ID'];
      if (!id) return '';
      return '<div class="actions">' +
        ['Available', 'Busy', 'Offline'].map(status => '<button class="' + (status === 'Available' ? 'good' : status === 'Busy' ? 'warn' : '') + '" onclick="setDriverStatus(' + jsArg(id) + ', ' + jsArg(status) + ')">' + status + '</button>').join('') +
        '</div>';
    }
    function vehicleStatusButtons(r) {
      const id = r['Vehicle ID'];
      if (!id) return '';
      return '<div class="actions">' +
        ['Available', 'Busy', 'Offline'].map(status => '<button class="' + (status === 'Available' ? 'good' : status === 'Busy' ? 'warn' : '') + '" onclick="setVehicleStatus(' + jsArg(id) + ', ' + jsArg(status) + ')">' + status + '</button>').join('') +
        '</div>';
    }
    function normalizeFleetText(value) {
      return String(value || '').trim().toLowerCase();
    }
    function readFilter(id, fallback) {
      const el = document.getElementById(id);
      return el ? el.value : fallback;
    }
    function filterFleetRows(rows, query, status, fields) {
      const q = normalizeFleetText(query);
      const wantedStatus = normalizeFleetText(status);
      return (rows || []).filter(row => {
        const rowStatus = normalizeFleetText(row.Status || row.Availability || 'Available');
        const statusOk = !wantedStatus || wantedStatus === 'all' || rowStatus === wantedStatus;
        const queryOk = !q || fields.some(field => normalizeFleetText(row[field]).includes(q));
        return statusOk && queryOk;
      });
    }
    function renderFleet(data) {
      if (!data) return;
      const driverQuery = readFilter('driverSearch', '');
      const driverStatus = readFilter('driverStatusFilter', 'all');
      const vehicleQuery = readFilter('vehicleSearch', '');
      const vehicleStatus = readFilter('vehicleStatusFilter', 'all');
      const drivers = filterFleetRows(data.drivers || [], driverQuery, driverStatus, ['Driver ID', 'Driver Name', 'WhatsApp Number', 'Current Location', 'Working Hours']);
      const vehicles = filterFleetRows(data.vehicles || [], vehicleQuery, vehicleStatus, ['Vehicle ID', 'Vehicle Type', 'Seats', 'Registration']);
      document.getElementById('fleet').innerHTML =
        '<div class="section-title">Drivers <span>' + drivers.length + '/' + (data.drivers || []).length + '</span></div>' +
        '<div class="inline-form">' +
          '<input id="newDriverId" placeholder="Driver ID">' +
          '<input id="newDriverName" placeholder="Driver Name">' +
          '<input id="newDriverPhone" placeholder="WhatsApp Number">' +
          '<input id="newDriverLocation" placeholder="Current Location">' +
          '<input id="newDriverHours" placeholder="Working Hours" value="Any">' +
          '<select id="newDriverStatus">' + optionList(['Available', 'Busy', 'Offline'], 'Available') + '</select>' +
          '<button class="primary" onclick="createDriver()">Add Driver</button>' +
        '</div>' +
        '<div class="toolbar">' +
          '<input id="driverSearch" value="' + esc(driverQuery) + '" oninput="renderFleet(latestDashboardData)" placeholder="Search driver, phone, location">' +
          '<select id="driverStatusFilter" onchange="renderFleet(latestDashboardData)">' +
            ['all', 'available', 'busy', 'offline'].map(status => '<option value="' + status + '"' + (normalizeFleetText(driverStatus) === status ? ' selected' : '') + '>' + esc(status === 'all' ? 'All Drivers' : status.charAt(0).toUpperCase() + status.slice(1)) + '</option>').join('') +
          '</select>' +
        '</div>' +
        '<div class="fleet-table">' + table(drivers, [
          { label: 'Driver', key: 'Driver ID' },
          { label: 'Name', key: 'Driver Name' },
          { label: 'Status', render: r => '<span class="' + pillClass(r.Status) + '">' + esc(r.Status) + '</span>' },
          { label: 'Location', key: 'Current Location' },
          { label: 'Action', render: driverStatusButtons }
        ]) + '</div>' +
        '<div class="section-title" style="margin-top:16px;">Vehicles <span>' + vehicles.length + '/' + (data.vehicles || []).length + '</span></div>' +
        '<div class="inline-form">' +
          '<input id="newVehicleId" placeholder="Vehicle ID">' +
          '<input id="newVehicleType" placeholder="Vehicle Type">' +
          '<input id="newVehicleSeats" placeholder="Seats">' +
          '<input id="newVehicleReg" placeholder="Registration">' +
          '<select id="newVehicleStatus">' + optionList(['Available', 'Busy', 'Offline'], 'Available') + '</select>' +
          '<span></span>' +
          '<button class="primary" onclick="createVehicle()">Add Vehicle</button>' +
        '</div>' +
        '<div class="toolbar">' +
          '<input id="vehicleSearch" value="' + esc(vehicleQuery) + '" oninput="renderFleet(latestDashboardData)" placeholder="Search vehicle, type, reg">' +
          '<select id="vehicleStatusFilter" onchange="renderFleet(latestDashboardData)">' +
            ['all', 'available', 'busy', 'offline'].map(status => '<option value="' + status + '"' + (normalizeFleetText(vehicleStatus) === status ? ' selected' : '') + '>' + esc(status === 'all' ? 'All Vehicles' : status.charAt(0).toUpperCase() + status.slice(1)) + '</option>').join('') +
          '</select>' +
        '</div>' +
        '<div class="fleet-table">' + table(vehicles, [
          { label: 'Vehicle', key: 'Vehicle ID' },
          { label: 'Type', key: 'Vehicle Type' },
          { label: 'Seats', key: 'Seats' },
          { label: 'Reg', key: 'Registration' },
          { label: 'Status', render: r => '<span class="' + pillClass(r.Status || r.Availability || 'Available') + '">' + esc(r.Status || r.Availability || 'Available') + '</span>' },
          { label: 'Action', render: vehicleStatusButtons }
        ]) + '</div>';
      const system = data.system || {};
      const state = system.whatsappState || 'starting';
      const qrAvailable = Boolean(system.whatsappQrAvailable);
      document.getElementById('whatsappControl').innerHTML =
        '<div class="label" style="line-height:1.6;">Status: <strong>' + esc(state) + '</strong>' +
          (system.whatsappLastError ? '<br>Reason: ' + esc(system.whatsappLastError) : '') + '</div>' +
        '<div class="actions" style="margin-top:10px;">' +
          (qrAvailable ? '<a class="button-link" href="/qr" target="_blank" rel="noopener">Open QR</a>' : '') +
          '<button onclick="restartWhatsApp()">Restart</button>' +
          '<button class="warn" onclick="resetWhatsAppSession()">Reset Session</button>' +
        '</div>';
    }
    function bidButtons(r) {
      if (!r.rideId) return '';
      const approved = String(r.adminStatus || '').toLowerCase() === 'approved';
      const rejected = String(r.adminStatus || '').toLowerCase() === 'rejected';
      const done = String(r.bidStatus || '').toLowerCase() === 'bid done';
      const aiEnabled = Boolean((latestDashboardData || {}).system?.bidAiReviewEnabled);
      return '<div class="actions">' +
        '<button onclick="saveBidDraft(' + jsArg(r.rideId) + ', ' + jsArg(r.bidStatus || 'Suggested') + ')">Save</button>' +
        (aiEnabled && !done ? '<button onclick="runBidAiReview(' + jsArg(r.rideId) + ')">AI Review</button>' : '') +
        (approved ? '' : '<button class="primary" onclick="approveBid(' + jsArg(r.rideId) + ')">Approve</button>') +
        (rejected || done ? '' : '<button class="warn" onclick="rejectBid(' + jsArg(r.rideId) + ')">Reject</button>') +
        (done ? '' : '<button class="good" onclick="markBidDone(' + jsArg(r.rideId) + ')">Done</button>') +
        '<button class="warn" onclick="markBidFailed(' + jsArg(r.rideId) + ')">Failed</button>' +
        '</div>';
    }
    async function load() {
      const res = await fetchDashboard(true);
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || 'Dashboard unavailable');
      latestDashboardData = data;
      document.getElementById('updated').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString();
      const s = data.summary;
      const system = data.system || {};
      const warningCount = (Array.isArray(data.sheetErrors) ? data.sheetErrors.length : 0) + (Array.isArray(data.systemWarnings) ? data.systemWarnings.length : 0);
      const cards = [
        ['Inbox', s.totalRides, 'WhatsApp + OTS rides', ''],
        ['Review', s.needsReview, 'Fix incomplete rides', s.needsReview ? 'attention' : ''],
        ['Final Bid', s.finalBid, 'Ready for approval', (data.actionRequiredJobs || []).length ? 'attention' : ''],
        ['AI Match', s.pendingRecommendations, 'Driver + vehicle suggestions', s.pendingRecommendations ? 'attention' : ''],
        ['Assigned', s.assignedRides, 'Driver and vehicle booked', ''],
        ['Calendar', s.calendarFailed ? s.calendarFailed : 'OK', s.calendarFailed ? 'Needs retry' : 'Events created', s.calendarFailed ? 'danger' : '']
      ];
      if (warningCount) {
        cards.push(['Warnings', warningCount, 'System needs attention', 'danger']);
      }
      document.getElementById('cards').innerHTML = cards.map(([label, value, hint, tone]) =>
        '<div class="flow-step ' + esc(tone || '') + '">' +
          '<div class="ring">' + esc(value) + '</div>' +
          '<div class="flow-copy"><div class="flow-title">' + esc(label) + '</div><div class="flow-hint">' + esc(hint) + '</div></div>' +
        '</div>'
      ).join('');
      renderSystemWarnings(data);
      document.querySelector('#actionRequiredJobs').previousElementSibling.innerHTML = 'Action Required ' + otsImportHeaderButton(data);
      document.getElementById('actionRequiredJobs').innerHTML = table(data.actionRequiredJobs || [], [
        { label: 'Action', render: r => '<span class="' + pillClass(r.actionReason) + '">' + esc(r.actionReason) + '</span>' },
        { label: 'Ride', key: 'rideId' },
        { label: 'Source', key: 'source' },
        { label: 'Pickup', key: 'pickup' },
        { label: 'Drop Off', key: 'dropOff' },
        { label: 'Date', key: 'date' },
        { label: 'Time', key: 'time' },
        { label: 'AI Driver', key: 'recommendedDriver' },
        { label: 'Driver', key: 'assignedDriver' },
        { label: 'Bid', render: r => '<span class="' + pillClass(r.bidStatus) + '">' + esc(r.bidStatus || 'No Bid') + '</span>' },
        { label: 'Calendar', render: r => '<span class="' + pillClass(r.calendarStatus) + '">' + esc(r.calendarStatus || 'Pending') + '</span>' },
        { label: 'Do', render: r => '<div class="actions">' + approveJobButton(r) + rejectJobButton(r) + assignAiButton(r) + retryCalendarButton(r) + (r.rideId ? '<button onclick="createBidReview(' + jsArg(r.rideId) + ')">Bid</button>' : '') + '</div>' }
      ]);
      document.getElementById('jobs').innerHTML = table(data.jobs, [
        { label: 'Ride', key: 'rideId' },
        { label: 'Source', key: 'source' },
        { label: 'Pickup', key: 'pickup' },
        { label: 'Drop Off', key: 'dropOff' },
        { label: 'Date', key: 'date' },
        { label: 'Time', key: 'time' },
        { label: 'Fare', render: r => esc(money(r.fare)) },
        { label: 'AI Driver', key: 'recommendedDriver' },
        { label: 'AI Vehicle', key: 'recommendedVehicle' },
        { label: 'Score', key: 'recommendationScore' },
        { label: 'Link', render: r => esc(r.linkedRideId ? r.linkedRideId + (r.linkedWithRideId ? ' / ' + r.linkedWithRideId : '') : '') },
        { label: 'Link Gap', key: 'linkedTimeGap' },
        { label: 'Saving', key: 'linkedSaving' },
        { label: 'Driver', key: 'assignedDriver' },
        { label: 'Vehicle', key: 'assignedVehicle' },
        { label: 'Bid', render: r => '<span class="' + pillClass(r.bidStatus) + '">' + esc(r.bidStatus || 'No Bid') + '</span>' },
        { label: 'Bid Admin', render: r => '<span class="' + pillClass(r.bidAdminStatus) + '">' + esc(r.bidAdminStatus || 'Pending') + '</span>' },
        { label: 'Bid Amount', render: r => esc(money(r.bidAmount)) },
        { label: 'Calendar', render: r => '<span class="' + pillClass(r.calendarStatus) + '">' + esc(r.calendarStatus || 'Pending') + '</span>' },
        { label: 'Action', render: r => '<div class="actions">' + approveJobButton(r) + rejectJobButton(r) + assignAiButton(r) + retryCalendarButton(r) + (r.rideId ? '<button onclick="createBidReview(' + jsArg(r.rideId) + ')">Bid</button>' : '') + '</div>' }
      ]);
      document.getElementById('approvedJobs').innerHTML = table(data.approvedJobs || [], [
        { label: 'Ride', key: 'rideId' },
        { label: 'Source', key: 'source' },
        { label: 'Pickup', key: 'pickup' },
        { label: 'Drop Off', key: 'dropOff' },
        { label: 'Date', key: 'date' },
        { label: 'Time', key: 'time' },
        { label: 'Fare', render: r => esc(money(r.fare)) },
        { label: 'AI Driver', key: 'recommendedDriver' },
        { label: 'AI Vehicle', key: 'recommendedVehicle' },
        { label: 'Score', key: 'recommendationScore' },
        { label: 'Link', render: r => esc(r.linkedRideId ? r.linkedRideId + (r.linkedWithRideId ? ' / ' + r.linkedWithRideId : '') : '') },
        { label: 'Link Gap', key: 'linkedTimeGap' },
        { label: 'Saving', key: 'linkedSaving' },
        { label: 'Driver', key: 'assignedDriver' },
        { label: 'Vehicle', key: 'assignedVehicle' },
        { label: 'Bid', render: r => '<span class="' + pillClass(r.bidStatus) + '">' + esc(r.bidStatus || 'No Bid') + '</span>' },
        { label: 'Bid Admin', render: r => '<span class="' + pillClass(r.bidAdminStatus) + '">' + esc(r.bidAdminStatus || 'Pending') + '</span>' },
        { label: 'Bid Amount', render: r => esc(money(r.bidAmount)) },
        { label: 'Calendar', render: r => '<span class="' + pillClass(r.calendarStatus) + '">' + esc(r.calendarStatus || 'Pending') + '</span>' },
        { label: 'Action', render: r => '<div class="actions">' + assignAiButton(r) + retryCalendarButton(r) + (r.rideId ? '<button onclick="createBidReview(' + jsArg(r.rideId) + ')">Bid</button>' : '') + '</div>' }
      ]);
      document.getElementById('prebookJobs').innerHTML = table(data.prebookJobs || [], [
        { label: 'Ride', key: 'rideId' },
        { label: 'Source', key: 'source' },
        { label: 'Pickup', key: 'pickup' },
        { label: 'Drop Off', key: 'dropOff' },
        { label: 'Date', key: 'date' },
        { label: 'Time', key: 'time' },
        { label: 'Fare', render: r => esc(money(r.fare)) },
        { label: 'Required Vehicle', key: 'vehicle' },
        { label: 'AI Driver', key: 'recommendedDriver' },
        { label: 'AI Vehicle', key: 'recommendedVehicle' },
        { label: 'Score', key: 'recommendationScore' },
        { label: 'Link', render: r => esc(r.linkedRideId ? r.linkedRideId + (r.linkedWithRideId ? ' / ' + r.linkedWithRideId : '') : '') },
        { label: 'Link Gap', key: 'linkedTimeGap' },
        { label: 'Saving', key: 'linkedSaving' },
        { label: 'Assigned Vehicle', key: 'assignedVehicle' },
        { label: 'Bid', render: r => '<span class="' + pillClass(r.bidStatus) + '">' + esc(r.bidStatus || 'No Bid') + '</span>' },
        { label: 'Bid Amount', render: r => esc(money(r.bidAmount)) },
        { label: 'Status', render: r => '<span class="' + pillClass(r.status) + '">' + esc(r.status || 'Pending') + '</span>' },
        { label: 'Driver', key: 'assignedDriver' },
        { label: 'Action', render: r => '<div class="actions">' + assignAiButton(r) + '</div>' }
      ]);
      document.getElementById('upcoming').innerHTML = table(data.upcomingJobs || [], [
        { label: 'Ride', key: 'rideId' },
        { label: 'Source', key: 'source' },
        { label: 'Pickup', key: 'pickup' },
        { label: 'Drop Off', key: 'dropOff' },
        { label: 'Date', key: 'date' },
        { label: 'Time', key: 'time' },
        { label: 'Fare', render: r => esc(money(r.fare)) },
        { label: 'Vehicle', key: 'vehicle' }
      ]);
      document.getElementById('needsReview').innerHTML = table(data.needsReview || [], [
        { label: 'Ride', key: 'rideId' },
        { label: 'Source', key: 'source' },
        { label: 'Pickup', render: r => reviewInput(r, 'pickup', r.pickup) },
        { label: 'Drop Off', render: r => reviewInput(r, 'dropOff', r.dropOff) },
        { label: 'Date', render: r => reviewInput(r, 'pickupDayDate', r.date) },
        { label: 'Time', render: r => reviewInput(r, 'startingTiming', r.time) },
        { label: 'Fare', render: r => reviewInput(r, 'fare', money(r.fare)) },
        { label: 'Vehicle', render: r => reviewInput(r, 'requiredVehicle', r.vehicle) },
        { label: 'Review', render: r => '<span class="reason" title="' + esc(r.reviewReason) + '">' + esc(r.reviewReason) + '</span>' },
        { label: 'Action', render: r => '<div class="actions">' + saveNeedsReviewButton(r) + promoteNeedsReviewButton(r) + '</div>' }
      ]);
      renderCriteriaPanel(data);
      document.querySelector('#recommendations').previousElementSibling.innerHTML = 'Driver Recommendations ' + recommendationsHeaderButton(data);
      document.getElementById('recommendations').innerHTML = '<div class="fleet-table">' + table(data.recommendations || [], [
        { label: 'Ride', key: 'rideId' },
        { label: 'Driver', key: 'driverId' },
        { label: 'Vehicle', key: 'vehicleId' },
        { label: 'Link', render: r => esc(r.linkedRideId || '') },
        { label: 'Chain', render: r => esc(r.previousRide || r.nextRide ? (r.previousRide || '') + ' -> ' + (r.nextRide || '') : '') },
        { label: 'Gap', key: 'timeGap' },
        { label: 'Saving', key: 'estimatedSaving' },
        { label: 'Score', key: 'score' },
        { label: 'Status', render: r => '<span class="' + pillClass(r.status) + '">' + esc(r.status) + '</span>' },
        { label: 'Assignment', render: r => '<span class="' + pillClass(r.assignmentStatus) + '">' + esc(r.assignmentStatus) + '</span>' },
        { label: 'Reason', render: r => '<span class="reason" title="' + esc(r.reason) + '">' + esc(r.reason) + '</span>' },
        { label: 'Action', render: approveRecommendationButton }
      ]) + '</div>';
      document.getElementById('linked').innerHTML = table(data.linkedRides, [
        { label: 'Link', key: 'linkId' },
        { label: 'First Ride', key: 'firstRideId' },
        { label: 'Second Ride', key: 'secondRideId' },
        { label: 'Driver', key: 'driverId' },
        { label: 'Vehicle', key: 'vehicleId' },
        { label: 'Gap', key: 'timeGap' },
        { label: 'Saving', key: 'savingEstimate' },
        { label: 'Status', render: r => '<span class="' + pillClass(r.status) + '">' + esc(r.status) + '</span>' }
      ]);
      document.getElementById('driverSchedule').innerHTML = table(data.driverSchedule || [], [
        { label: 'Driver', key: 'driverId' },
        { label: 'Ride', key: 'rideId' },
        { label: 'Pickup', key: 'pickup' },
        { label: 'Drop Off', key: 'dropOff' },
        { label: 'Start', key: 'startTime' },
        { label: 'End', key: 'endTime' },
        { label: 'Next Available', key: 'nextAvailableTime' },
        { label: 'Status', render: r => '<span class="' + pillClass(r.status) + '">' + esc(r.status) + '</span>' },
        { label: 'Action', render: r => '<div class="actions">' + completeScheduleButton(r) + '</div>' }
      ]);
      document.getElementById('vehicleSchedule').innerHTML = table(data.vehicleSchedule || [], [
        { label: 'Vehicle', key: 'vehicleId' },
        { label: 'Ride', key: 'rideId' },
        { label: 'Driver', key: 'driverId' },
        { label: 'Start', key: 'startTime' },
        { label: 'End', key: 'endTime' },
        { label: 'Status', render: r => '<span class="' + pillClass(r.status) + '">' + esc(r.status) + '</span>' },
        { label: 'Action', render: r => '<div class="actions">' + completeScheduleButton(r) + '</div>' }
      ]);
      document.querySelector('#bids').previousElementSibling.innerHTML = 'Bid Control ' + autoBidHeaderButton(data);
      document.getElementById('bids').innerHTML = table(data.bids, [
        { label: 'Ride', key: 'rideId' },
        { label: 'Source', key: 'source' },
        { label: 'Type', key: 'bidType' },
        { label: 'Route', render: r => esc((r.pickup || '') + ' -> ' + (r.dropOff || '')) },
        { label: 'Fare', render: r => esc(money(r.fare)) },
        { label: 'Suggested', render: r => '<input data-bid-amount="' + esc(r.rideId) + '" value="' + esc(r.bidAmount || '') + '" placeholder="Set price" style="width:86px;border:1px solid #cfd8e3;border-radius:6px;padding:6px;font-size:12px;" />' },
        { label: 'Cost / Profit', render: r => esc(money(r.estimatedCost) + ' / ' + money(r.estimatedProfit)) },
        { label: 'Margin', render: r => esc(r.marginPercent ? r.marginPercent + '%' : '') },
        { label: 'Decision', render: r => '<span class="' + pillClass(r.aiDecision) + '">' + esc(r.aiDecision || 'Ready for Review') + '</span>' },
        { label: 'Reason', render: r => '<input data-bid-reason="' + esc(r.rideId) + '" value="' + esc(r.reason || '') + '" style="width:180px;border:1px solid #cfd8e3;border-radius:6px;padding:6px;font-size:12px;" />' },
        { label: 'Bid', render: r => '<span class="' + pillClass(r.bidStatus) + '">' + esc(r.bidStatus) + '</span>' },
        { label: 'Admin', render: r => '<span class="' + pillClass(r.adminStatus) + '">' + esc(r.adminStatus) + '</span>' },
        { label: 'Updated', key: 'updatedTime' },
        { label: 'Action', render: bidButtons }
      ]);
      document.getElementById('audit').innerHTML = table((data.auditLogs || []).slice(0, 20), [
        { label: 'Time', key: 'createdTime' },
        { label: 'Action', key: 'action' },
        { label: 'Target', render: r => esc((r.targetType || '') + ' ' + (r.targetId || '')) },
        { label: 'Field', key: 'field' },
        { label: 'Old', key: 'oldValue' },
        { label: 'New', key: 'newValue' },
        { label: 'Status', render: r => '<span class="' + pillClass(r.status) + '">' + esc(r.status || 'Success') + '</span>' }
      ]);
      renderFleet(data);
    }
    load().catch(err => {
      document.getElementById('updated').textContent = 'Dashboard error';
      document.getElementById('cards').innerHTML = '<div class="panel" style="padding:16px;color:#be123c;">' + esc(err.message) + '</div>';
    });
    setInterval(load, 60000);
  </script>
</body>
</html>`;
}

module.exports = {
  DEFAULT_WORKSHEET_NAMES,
  recordsFromValues,
  readWorksheetRecords,
  buildSummary,
  buildDashboardPayload,
  loadDashboardData,
  renderDashboardPage
};
