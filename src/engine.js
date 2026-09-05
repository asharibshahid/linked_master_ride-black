const { getSheetData, writeSheetData } = require("./googleSheetsManager");
const { parsePickupDateTime } = require("./sheets/upcomingJobs");
const { geocodeAddress } = require("./routing/geocode");
const { getRouteFromOSRM } = require("./routing/osrm");
const {
  normalizeDriverRecord,
  normalizeVehicleRecord,
  isDriverAvailable
} = require("./drivers/management");
const { safeTrim, collapseWhitespace } = require("./utils/text");

const RECOMMENDATION_HEADERS = Object.freeze([
  "Ride ID",
  "Pickup",
  "Drop Off",
  "Required Vehicle",
  "Recommended Driver",
  "Recommended Vehicle",
  "Linked Ride ID",
  "Previous Ride",
  "Next Ride",
  "Time Gap",
  "Distance Between",
  "Estimated Saving",
  "Score",
  "Reason",
  "Created Time",
  "Status",
  "Assignment Status"
]);

const RECOMMENDATION_WORKSHEET_NAME = "Driver Recommendations";
const DRIVER_SCHEDULE_WORKSHEET_NAME = "Driver Schedule";
const LINKED_RIDES_WORKSHEET_NAME = "Linked Rides";
const VEHICLE_SCHEDULE_WORKSHEET_NAME = "Vehicle Schedule";

const DRIVER_SCHEDULE_HEADERS = Object.freeze([
  "Assignment ID",
  "Driver ID",
  "Ride ID",
  "Pickup",
  "Drop Off",
  "Start Time",
  "End Time",
  "Status",
  "Next Available Time",
  "Current Location",
  "Previous Ride ID",
  "Next Ride ID"
]);

const LINKED_RIDES_HEADERS = Object.freeze([
  "Link ID",
  "First Ride ID",
  "Second Ride ID",
  "Driver ID",
  "Vehicle ID",
  "Previous Drop",
  "Next Pickup",
  "Time Gap",
  "Distance Between",
  "Saving Estimate",
  "Status"
]);

const VEHICLE_SCHEDULE_HEADERS = Object.freeze([
  "Vehicle ID",
  "Ride ID",
  "Driver ID",
  "Start Time",
  "End Time",
  "Status"
]);

const SCORE_WEIGHTS = Object.freeze({
  vehicle_compatibility: 0.25,
  availability: 0.2,
  pickup_distance: 0.15,
  linked_route: 0.25,
  rest_fatigue: 0.15
});

const NO_CANDIDATE_LOG_TTL_MS = 10 * 60 * 1000;
const noCandidateLogTimes = new Map();

function shouldLogNoCandidate(rideId, nowMs = Date.now()) {
  const key = safeTrim(rideId) || "unknown";
  const lastLogged = noCandidateLogTimes.get(key) || 0;
  if (nowMs - lastLogged < NO_CANDIDATE_LOG_TTL_MS) return false;
  noCandidateLogTimes.set(key, nowMs);
  return true;
}

const BLOCKED_DRIVER_STATUSES = new Set([
  "offline",
  "unavailable",
  "inactive",
  "disabled",
  "suspended"
]);

const CLOSED_FINAL_BID_STATUSES = new Set([
  "rejected",
  "cancelled",
  "canceled",
  "declined",
  "completed"
]);

const ASSIGNMENT_STATUS = Object.freeze({
  PENDING: "Pending",
  APPROVED: "Approved",
  ASSIGNED: "Assigned",
  FAILED: "Failed"
});

const DEFAULT_RIDE_DURATION_MINUTES = 60;
const DEFAULT_MIN_GAP_MINUTES = 15;
const DEFAULT_ROUTE_CHAIN_CLOSE_METERS = 10000;
const DEFAULT_MAX_LINK_GAP_MINUTES = 240;
const DEFAULT_FATIGUE_FULL_REST_MINUTES = 120;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeComparableText(value) {
  return collapseWhitespace(String(value || "")).toLowerCase();
}

function normalizeVehicleText(value) {
  return normalizeComparableText(value)
    .replace(/\bcar\b/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSeatCount(...values) {
  for (const value of values) {
    const text = normalizeComparableText(value);
    if (!text) continue;
    const match = text.match(/\b([1-9]\d?)\s*(?:seat|seater|pax|passenger)s?\b/i);
    if (match) return Number(match[1]);
    if (/^\d+$/.test(text)) return Number(text);
  }
  return null;
}

function normalizeRideRecord(ride = {}) {
  return {
    ride_id: firstNonEmpty(ride["Ride ID"], ride.Refer, ride.refer),
    pickup: firstNonEmpty(ride.Pickup, ride.pickup),
    drop_off: firstNonEmpty(ride["Drop Off"], ride["Drop-off"], ride.drop_off),
    required_vehicle: firstNonEmpty(ride["Required Vehicle"], ride.Vehicle, ride.required_vehicle),
    status: firstNonEmpty(ride.Status, ride.status),
    assigned_driver: firstNonEmpty(ride["Assigned Driver"], ride.assigned_driver)
  };
}

function normalizeRecommendationRecord(record = {}) {
  return {
    ride_id: firstNonEmpty(record["Ride ID"], record.Refer, record.refer),
    status: firstNonEmpty(record.Status, record.status),
    recommended_driver: firstNonEmpty(record["Recommended Driver"], record.recommended_driver),
    recommended_vehicle: firstNonEmpty(record["Recommended Vehicle"], record.recommended_vehicle),
    assignment_status: firstNonEmpty(record["Assignment Status"], record.assignment_status)
  };
}

function normalizeLinkedRideRecord(record = {}) {
  return {
    link_id: firstNonEmpty(record["Link ID"], record.link_id),
    first_ride_id: firstNonEmpty(record["First Ride ID"], record.first_ride_id),
    second_ride_id: firstNonEmpty(record["Second Ride ID"], record.second_ride_id),
    driver_id: firstNonEmpty(record["Driver ID"], record.driver_id),
    vehicle_id: firstNonEmpty(record["Vehicle ID"], record.vehicle_id),
    status: firstNonEmpty(record.Status, record.status)
  };
}

function normalizeScheduleRecord(record = {}) {
  return {
    assignment_id: firstNonEmpty(record["Assignment ID"], record.assignment_id),
    driver_id: firstNonEmpty(record["Driver ID"], record.driver_id),
    ride_id: firstNonEmpty(record["Ride ID"], record.ride_id),
    pickup: firstNonEmpty(record.Pickup, record.pickup),
    drop_off: firstNonEmpty(record["Drop Off"], record.drop_off),
    start_time: firstNonEmpty(record["Start Time"], record.start_time),
    end_time: firstNonEmpty(record["End Time"], record.end_time),
    status: firstNonEmpty(record.Status, record.status),
    next_available_time: firstNonEmpty(record["Next Available Time"], record.next_available_time),
    current_location: firstNonEmpty(record["Current Location"], record.current_location),
    previous_ride_id: firstNonEmpty(record["Previous Ride ID"], record.previous_ride_id),
    next_ride_id: firstNonEmpty(record["Next Ride ID"], record.next_ride_id)
  };
}

function normalizeVehicleScheduleRecord(record = {}) {
  return {
    vehicle_id: firstNonEmpty(record["Vehicle ID"], record.vehicle_id),
    ride_id: firstNonEmpty(record["Ride ID"], record.ride_id),
    driver_id: firstNonEmpty(record["Driver ID"], record.driver_id),
    start_time: firstNonEmpty(record["Start Time"], record.start_time),
    end_time: firstNonEmpty(record["End Time"], record.end_time),
    status: firstNonEmpty(record.Status, record.status)
  };
}

function isApprovedRecommendationPendingAssignment(recommendation = {}) {
  const normalized = normalizeRecommendationRecord(recommendation);
  const status = normalizeComparableText(normalized.status);
  const assignmentStatus = normalizeComparableText(normalized.assignment_status);

  return (
    status === "approved" &&
    !["assigned", "failed"].includes(assignmentStatus)
  );
}

function addMinutes(date, minutes) {
  const source = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(source.getTime())) return null;
  const numericMinutes = Number(minutes);
  if (!Number.isFinite(numericMinutes)) return null;
  return new Date(source.getTime() + numericMinutes * 60 * 1000);
}

function parseIsoDateTime(value) {
  const text = safeTrim(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveRideStartTime(ride = {}, options = {}) {
  const direct = parseIsoDateTime(
    firstNonEmpty(ride["Start Time"], ride.start_time, ride.startTime)
  );
  if (direct) return direct;

  return parsePickupDateTime(
    firstNonEmpty(ride["Pickup Day & Date"], ride.pickup_day_date),
    firstNonEmpty(ride["Starting Timing"], ride.starting_timing),
    { timeZone: options.timeZone || "Europe/London" }
  );
}

function resolveRideEndTime(ride = {}, startTime, options = {}) {
  const direct = parseIsoDateTime(firstNonEmpty(ride["End Time"], ride.end_time, ride.endTime));
  if (direct) return direct;
  const durationMinutes =
    Number.isFinite(Number(options.durationMinutes)) && Number(options.durationMinutes) > 0
      ? Number(options.durationMinutes)
      : DEFAULT_RIDE_DURATION_MINUTES;
  return addMinutes(startTime, durationMinutes);
}

function resolveRideWindow(ride = {}, options = {}) {
  const startTime = resolveRideStartTime(ride, options);
  const endTime = startTime ? resolveRideEndTime(ride, startTime, options) : null;
  return { startTime, endTime };
}

function isClosedScheduleStatus(value) {
  const status = normalizeComparableText(value);
  return ["completed", "cancelled", "canceled", "failed"].includes(status);
}

function schedulesOverlapWithGap(schedule = {}, rideWindow = {}, options = {}) {
  const normalized = normalizeScheduleRecord(schedule);
  if (isClosedScheduleStatus(normalized.status)) return false;

  const scheduleStart = parseIsoDateTime(normalized.start_time);
  const rawScheduleEnd =
    parseIsoDateTime(normalized.next_available_time) || parseIsoDateTime(normalized.end_time);
  if (!scheduleStart || !rawScheduleEnd || !rideWindow.startTime || !rideWindow.endTime) {
    return false;
  }

  const minGapMinutes =
    Number.isFinite(Number(options.minGapMinutes)) && Number(options.minGapMinutes) >= 0
      ? Number(options.minGapMinutes)
      : DEFAULT_MIN_GAP_MINUTES;
  const scheduleStartWithGap = addMinutes(scheduleStart, -minGapMinutes);
  const scheduleEndWithGap = addMinutes(rawScheduleEnd, minGapMinutes);
  if (!scheduleStartWithGap || !scheduleEndWithGap) return false;

  return (
    rideWindow.startTime.getTime() < scheduleEndWithGap.getTime() &&
    rideWindow.endTime.getTime() > scheduleStartWithGap.getTime()
  );
}

function findDriverScheduleRows(driverId, scheduleRows = []) {
  const target = safeTrim(driverId);
  if (!target) return [];
  return (Array.isArray(scheduleRows) ? scheduleRows : [])
    .map(normalizeScheduleRecord)
    .filter((schedule) => safeTrim(schedule.driver_id) === target);
}

function findVehicleScheduleRows(vehicleId, vehicleScheduleRows = []) {
  const target = safeTrim(vehicleId);
  if (!target) return [];
  return (Array.isArray(vehicleScheduleRows) ? vehicleScheduleRows : [])
    .map(normalizeVehicleScheduleRecord)
    .filter((schedule) => safeTrim(schedule.vehicle_id) === target);
}

function hasScheduleConflict(driverId, ride = {}, scheduleRows = [], options = {}) {
  const rideWindow = resolveRideWindow(ride, options);
  if (!rideWindow.startTime || !rideWindow.endTime) return false;

  return findDriverScheduleRows(driverId, scheduleRows).some((schedule) =>
    schedulesOverlapWithGap(schedule, rideWindow, options)
  );
}

function hasVehicleScheduleConflict(vehicleId, ride = {}, vehicleScheduleRows = [], options = {}) {
  const rideWindow = resolveRideWindow(ride, options);
  if (!rideWindow.startTime || !rideWindow.endTime) return false;

  return findVehicleScheduleRows(vehicleId, vehicleScheduleRows).some((schedule) =>
    schedulesOverlapWithGap(schedule, rideWindow, options)
  );
}

function findPreviousSchedule(driverId, ride = {}, scheduleRows = [], options = {}) {
  const rideWindow = resolveRideWindow(ride, options);
  if (!rideWindow.startTime) return null;

  return findDriverScheduleRows(driverId, scheduleRows)
    .filter((schedule) => {
      const endTime = parseIsoDateTime(schedule.end_time);
      return endTime && endTime.getTime() <= rideWindow.startTime.getTime();
    })
    .sort((a, b) => parseIsoDateTime(b.end_time).getTime() - parseIsoDateTime(a.end_time).getTime())[0] || null;
}

function findNextSchedule(driverId, ride = {}, scheduleRows = [], options = {}) {
  const rideWindow = resolveRideWindow(ride, options);
  if (!rideWindow.endTime) return null;

  return findDriverScheduleRows(driverId, scheduleRows)
    .filter((schedule) => {
      const startTime = parseIsoDateTime(schedule.start_time);
      return startTime && startTime.getTime() >= rideWindow.endTime.getTime();
    })
    .sort((a, b) => parseIsoDateTime(a.start_time).getTime() - parseIsoDateTime(b.start_time).getTime())[0] || null;
}

function calculateMinutesBetween(start, end) {
  const startDate = start instanceof Date ? start : parseIsoDateTime(start);
  const endDate = end instanceof Date ? end : parseIsoDateTime(end);
  if (!startDate || !endDate) return null;
  return Math.round((endDate.getTime() - startDate.getTime()) / 60000);
}

function getVehicleType(vehicle = {}) {
  return firstNonEmpty(vehicle.vehicle_type, vehicle["Vehicle Type"], vehicle["Vehicle Category"]);
}

function getDriverStatus(driver = {}) {
  return firstNonEmpty(driver.current_status, driver.status, driver.Status, driver["Current Status"]);
}

function getVehicleStatus(vehicle = {}) {
  return firstNonEmpty(vehicle.status, vehicle.Status, vehicle.availability, vehicle.Availability);
}

function isDriverBlockedByStatus(driver = {}) {
  const status = normalizeComparableText(getDriverStatus(driver));
  return !status || BLOCKED_DRIVER_STATUSES.has(status);
}

function isVehicleAvailable(vehicle = {}) {
  const status = normalizeComparableText(getVehicleStatus(vehicle));
  if (!status) return true;
  return ["available", "active", "ready", "standby"].includes(status);
}

function isFinalBidRideEligibleForRecommendation(ride = {}) {
  const normalized = normalizeRideRecord(ride);
  const status = normalizeComparableText(normalized.status);

  if (!normalized.ride_id) return false;
  if (normalized.assigned_driver) return false;
  if (CLOSED_FINAL_BID_STATUSES.has(status)) return false;
  return true;
}

function calculateVehicleMatchScore(requiredVehicle, vehicle = {}) {
  const required = normalizeVehicleText(requiredVehicle);
  const actual = normalizeVehicleText(getVehicleType(vehicle));
  const requiredSeats = extractSeatCount(requiredVehicle);
  const actualSeats = extractSeatCount(vehicle.seats, vehicle.Seats, getVehicleType(vehicle));

  if (!required || !actual) return 0;
  if (actual === required) return 100;
  if (required.replace(/\s+/g, "") === actual.replace(/\s+/g, "")) return 100;
  if (required === "saloon" && actual === "saloon") return 100;
  if (required.includes(actual) || actual.includes(required)) return 70;
  if (requiredSeats !== null && actualSeats !== null && actualSeats >= requiredSeats) return 70;
  if (required.includes("mpv") && actual.includes("mpv")) return 100;
  if (required.includes("mpv") && actualSeats !== null && actualSeats >= 6) return 70;
  if (requiredSeats !== null && actual.includes("mpv")) return 70;
  return 0;
}

function calculateAvailabilityScore(driver = {}) {
  return isDriverAvailable(driver) ? 100 : 0;
}

function calculateDriverStatusScore(driver = {}) {
  const status = normalizeComparableText(getDriverStatus(driver));
  if (status === "available") return 100;
  if (status === "busy") return 40;
  if (status === "on job" || status === "on-job") return 40;
  if (status === "standby") return 80;
  return 0;
}

function calculateRouteCompatibilityScore(driver = {}, ride = {}) {
  const normalizedRide = normalizeRideRecord(ride);
  if (!normalizedRide.pickup || !normalizedRide.drop_off) return 0;

  const preferredAreas = normalizeComparableText(
    firstNonEmpty(driver.preferred_areas, driver["Preferred Areas"])
  );
  if (!preferredAreas) return 75;

  const pickup = normalizeComparableText(normalizedRide.pickup);
  const dropOff = normalizeComparableText(normalizedRide.drop_off);
  if (preferredAreas.includes(pickup) || preferredAreas.includes(dropOff)) return 100;
  return 70;
}

function calculateRouteChainScore(distanceMeters, options = {}) {
  const distance = Number(distanceMeters);
  if (!Number.isFinite(distance) || distance < 0) return 0;
  const closeMeters =
    Number.isFinite(Number(options.routeChainCloseMeters)) &&
    Number(options.routeChainCloseMeters) > 0
      ? Number(options.routeChainCloseMeters)
      : DEFAULT_ROUTE_CHAIN_CLOSE_METERS;

  if (distance <= closeMeters) return 100;
  if (distance >= closeMeters * 3) return 0;
  return Math.max(0, Math.min(100, Math.round(100 - ((distance - closeMeters) / (closeMeters * 2)) * 100)));
}

function calculateRestFatigueScore(previousSchedule, ride = {}, options = {}) {
  if (!previousSchedule) return 100;
  const rideWindow = resolveRideWindow(ride, options);
  const previousEnd = parseIsoDateTime(previousSchedule.end_time);
  if (!previousEnd || !rideWindow.startTime) return 80;

  const gapMinutes = calculateMinutesBetween(previousEnd, rideWindow.startTime);
  if (gapMinutes === null) return 80;
  const fullRestMinutes =
    Number.isFinite(Number(options.fatigueFullRestMinutes)) &&
    Number(options.fatigueFullRestMinutes) > 0
      ? Number(options.fatigueFullRestMinutes)
      : DEFAULT_FATIGUE_FULL_REST_MINUTES;

  if (gapMinutes >= fullRestMinutes) return 100;
  if (gapMinutes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((gapMinutes / fullRestMinutes) * 100)));
}

async function defaultDistanceProvider(fromAddress, toAddress) {
  const from = firstNonEmpty(fromAddress);
  const to = firstNonEmpty(toAddress);
  if (!from || !to) return Number.POSITIVE_INFINITY;
  if (normalizeComparableText(from) === normalizeComparableText(to)) return 0;

  const origin = await geocodeAddress(from);
  const destination = await geocodeAddress(to);
  if (!origin || !destination) return Number.POSITIVE_INFINITY;

  const route = await getRouteFromOSRM(origin, destination);
  const distance = Number(route?.distance_meters);
  return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

function calculateDistanceScore(distanceMeters, context = {}) {
  const distance = Number(distanceMeters);
  if (!Number.isFinite(distance) || distance < 0) return 0;

  const minDistance = Number(context.minDistanceMeters);
  const maxDistance = Number(context.maxDistanceMeters);
  if (!Number.isFinite(minDistance) || !Number.isFinite(maxDistance)) {
    if (distance <= 5000) return 100;
    if (distance >= 50000) return 0;
    return Math.round(100 - ((distance - 5000) / 45000) * 100);
  }

  if (maxDistance <= minDistance) return 100;
  const ratio = (distance - minDistance) / (maxDistance - minDistance);
  return Math.max(0, Math.min(100, Math.round(100 - ratio * 100)));
}

function calculateFinalScore(scores = {}) {
  const total =
    Number(scores.vehicle_compatibility ?? scores.vehicle_match ?? 0) *
      SCORE_WEIGHTS.vehicle_compatibility +
    Number(scores.availability || 0) * SCORE_WEIGHTS.availability +
    Number(scores.pickup_distance || 0) * SCORE_WEIGHTS.pickup_distance +
    Number(scores.linked_route ?? scores.route_compatibility ?? 0) * SCORE_WEIGHTS.linked_route +
    Number(scores.rest_fatigue ?? scores.driver_status ?? 0) * SCORE_WEIGHTS.rest_fatigue;

  return Math.max(0, Math.min(100, Math.round(total)));
}

function buildRecommendationReason(candidate = {}) {
  const reasons = [];
  const scores = candidate.scores || {};

  if (scores.vehicle_compatibility >= 100) reasons.push("Vehicle matched");
  else if (scores.vehicle_compatibility >= 70) reasons.push("Vehicle compatible");

  if (scores.availability >= 100) reasons.push("driver available");
  else reasons.push("driver availability limited");

  if (scores.pickup_distance >= 100) reasons.push("closest location");
  else if (scores.pickup_distance >= 60) reasons.push("near pickup");
  else reasons.push("not closest to pickup");

  if (scores.linked_route >= 70) reasons.push("linked route opportunity");
  if (candidate.linkedOpportunity?.firstRideId && scores.linked_route >= 100) {
    reasons.push("return ride match");
  }
  if (scores.rest_fatigue >= 80) reasons.push("rest window ok");
  else reasons.push("short rest window");

  return reasons.join(", ");
}

function buildAssignmentId(driverId, rideId) {
  const cleanDriverId = safeTrim(driverId).replace(/[^A-Za-z0-9-]/g, "");
  const cleanRideId = safeTrim(rideId).replace(/[^A-Za-z0-9-]/g, "");
  return `ASG-${cleanRideId || "RIDE"}-${cleanDriverId || "DRIVER"}`;
}

function buildDriverScheduleRowObject({
  ride,
  driverId,
  previousSchedule,
  nextSchedule,
  options = {}
} = {}) {
  const normalizedRide = normalizeRideRecord(ride);
  const rideWindow = resolveRideWindow(ride, options);
  const endTime = rideWindow.endTime || rideWindow.startTime;

  return {
    "Assignment ID": buildAssignmentId(driverId, normalizedRide.ride_id),
    "Driver ID": safeTrim(driverId),
    "Ride ID": normalizedRide.ride_id,
    Pickup: normalizedRide.pickup,
    "Drop Off": normalizedRide.drop_off,
    "Start Time": rideWindow.startTime ? rideWindow.startTime.toISOString() : "",
    "End Time": endTime ? endTime.toISOString() : "",
    Status: "Assigned",
    "Next Available Time": endTime ? endTime.toISOString() : "",
    "Current Location": normalizedRide.drop_off,
    "Previous Ride ID": previousSchedule?.ride_id || "",
    "Next Ride ID": nextSchedule?.ride_id || ""
  };
}

function buildDriverScheduleSheetRow(record = {}, headers = DRIVER_SCHEDULE_HEADERS) {
  const safeHeaders =
    Array.isArray(headers) && headers.length > 0 ? headers : DRIVER_SCHEDULE_HEADERS;
  return safeHeaders.map((header) => safeTrim(record[header]));
}

function buildVehicleScheduleRowObject({ ride, driverId, vehicleId, options = {} } = {}) {
  const normalizedRide = normalizeRideRecord(ride);
  const rideWindow = resolveRideWindow(ride, options);
  return {
    "Vehicle ID": safeTrim(vehicleId),
    "Ride ID": normalizedRide.ride_id,
    "Driver ID": safeTrim(driverId),
    "Start Time": rideWindow.startTime ? rideWindow.startTime.toISOString() : "",
    "End Time": rideWindow.endTime ? rideWindow.endTime.toISOString() : "",
    Status: "Assigned"
  };
}

function buildVehicleScheduleSheetRow(record = {}, headers = VEHICLE_SCHEDULE_HEADERS) {
  const safeHeaders =
    Array.isArray(headers) && headers.length > 0 ? headers : VEHICLE_SCHEDULE_HEADERS;
  return safeHeaders.map((header) => safeTrim(record[header]));
}

function buildRecommendationRowObject({ ride, candidate, createdTime = "" } = {}) {
  const normalizedRide = normalizeRideRecord(ride);
  const linkedOpportunity = candidate?.linkedOpportunity || {};
  return {
    "Ride ID": normalizedRide.ride_id,
    Pickup: normalizedRide.pickup,
    "Drop Off": normalizedRide.drop_off,
    "Required Vehicle": normalizedRide.required_vehicle,
    "Recommended Driver": candidate?.driver?.driver_id || "",
    "Recommended Vehicle": candidate?.vehicle?.vehicle_id || "",
    "Linked Ride ID": linkedOpportunity.linkId || "",
    "Previous Ride": linkedOpportunity.firstRideId || "",
    "Next Ride": linkedOpportunity.secondRideId || "",
    "Time Gap": linkedOpportunity.gapMinutes === undefined ? "" : `${linkedOpportunity.gapMinutes} min`,
    "Distance Between": Number.isFinite(Number(linkedOpportunity.distanceMeters))
      ? `${Math.round(Number(linkedOpportunity.distanceMeters))} m`
      : "",
    "Estimated Saving": linkedOpportunity.savingEstimate || "",
    Score: String(candidate?.scores?.total ?? ""),
    Reason: candidate?.reason || buildRecommendationReason(candidate),
    "Created Time": createdTime || new Date().toISOString(),
    Status: "Pending",
    "Assignment Status": ASSIGNMENT_STATUS.PENDING
  };
}

function buildRecommendationSheetRow(record = {}, headers = RECOMMENDATION_HEADERS) {
  const safeHeaders =
    Array.isArray(headers) && headers.length > 0 ? headers : RECOMMENDATION_HEADERS;
  return safeHeaders.map((header) => safeTrim(record[header]));
}

function buildLinkedRideId(firstRideId, secondRideId, driverId, vehicleId) {
  const clean = (value, fallback) =>
    safeTrim(value).replace(/[^A-Za-z0-9-]/g, "") || fallback;
  return `LINK-${clean(firstRideId, "FIRST")}-${clean(secondRideId, "SECOND")}-${clean(driverId, "DRIVER")}-${clean(vehicleId, "VEHICLE")}`;
}

function buildLinkedRideSheetRow(record = {}, headers = LINKED_RIDES_HEADERS) {
  const safeHeaders = Array.isArray(headers) && headers.length > 0 ? headers : LINKED_RIDES_HEADERS;
  return safeHeaders.map((header) => safeTrim(record[header]));
}

async function detectLinkedRideOpportunity({
  ride,
  driver,
  vehicle,
  scheduleRows = [],
  distanceProvider,
  options = {}
} = {}) {
  const normalizedRide = normalizeRideRecord(ride);
  const previousSchedule = findPreviousSchedule(driver?.driver_id, ride, scheduleRows, options);
  if (!previousSchedule?.ride_id || !previousSchedule.drop_off || !normalizedRide.pickup) {
    return null;
  }

  const previousEnd = parseIsoDateTime(previousSchedule.end_time);
  const rideWindow = resolveRideWindow(ride, options);
  if (!previousEnd || !rideWindow.startTime) return null;

  const gapMinutes = calculateMinutesBetween(previousEnd, rideWindow.startTime);
  const minGapMinutes =
    Number.isFinite(Number(options.minGapMinutes)) && Number(options.minGapMinutes) >= 0
      ? Number(options.minGapMinutes)
      : DEFAULT_MIN_GAP_MINUTES;
  const maxGapMinutes =
    Number.isFinite(Number(options.maxLinkedRideGapMinutes)) &&
    Number(options.maxLinkedRideGapMinutes) > 0
      ? Number(options.maxLinkedRideGapMinutes)
      : DEFAULT_MAX_LINK_GAP_MINUTES;

  if (gapMinutes === null || gapMinutes < minGapMinutes || gapMinutes > maxGapMinutes) {
    return null;
  }

  let distanceMeters = Number.POSITIVE_INFINITY;
  try {
    distanceMeters = await distanceProvider(previousSchedule.drop_off, normalizedRide.pickup, {
      driver,
      vehicle,
      ride: normalizedRide,
      previousSchedule,
      purpose: "linked_ride"
    });
  } catch (error) {
    distanceMeters = Number.POSITIVE_INFINITY;
  }

  const score = calculateRouteChainScore(distanceMeters, options);
  if (score <= 0) return null;

  return {
    linkId: buildLinkedRideId(
      previousSchedule.ride_id,
      normalizedRide.ride_id,
      driver?.driver_id,
      vehicle?.vehicle_id
    ),
    firstRideId: previousSchedule.ride_id,
    secondRideId: normalizedRide.ride_id,
    driverId: driver?.driver_id || "",
    vehicleId: vehicle?.vehicle_id || "",
    previousDrop: previousSchedule.drop_off,
    nextPickup: normalizedRide.pickup,
    gapMinutes,
    distanceMeters,
    score,
    savingEstimate: Number.isFinite(distanceMeters)
      ? `${Math.round(distanceMeters / 1000)} km empty-mile saving`
      : ""
  };
}

function buildLinkedRideRowObject(opportunity = {}) {
  return {
    "Link ID": opportunity.linkId || "",
    "First Ride ID": opportunity.firstRideId || "",
    "Second Ride ID": opportunity.secondRideId || "",
    "Driver ID": opportunity.driverId || "",
    "Vehicle ID": opportunity.vehicleId || "",
    "Previous Drop": opportunity.previousDrop || "",
    "Next Pickup": opportunity.nextPickup || "",
    "Time Gap": opportunity.gapMinutes === undefined ? "" : `${opportunity.gapMinutes} min`,
    "Distance Between": Number.isFinite(Number(opportunity.distanceMeters))
      ? `${Math.round(Number(opportunity.distanceMeters))} m`
      : "",
    "Saving Estimate": opportunity.savingEstimate || "",
    Status: "Pending"
  };
}

function pairDriversWithVehicles(drivers = [], vehicles = []) {
  const normalizedDrivers = (Array.isArray(drivers) ? drivers : [])
    .map(normalizeDriverRecord)
    .filter((driver) => driver.driver_id);
  const normalizedVehicles = (Array.isArray(vehicles) ? vehicles : [])
    .map(normalizeVehicleRecord)
    .filter((vehicle) => vehicle.vehicle_id);

  const pairs = [];
  for (const driver of normalizedDrivers) {
    for (const vehicle of normalizedVehicles) {
      pairs.push({ driver, vehicle });
    }
  }
  return pairs;
}

function filterValidDriverCandidates(ride = {}, drivers = [], vehicles = [], options = {}) {
  const normalizedRide = normalizeRideRecord(ride);
  const scheduleRows = Array.isArray(options.scheduleRows) ? options.scheduleRows : [];
  const vehicleScheduleRows = Array.isArray(options.vehicleScheduleRows)
    ? options.vehicleScheduleRows
    : [];

  return pairDriversWithVehicles(drivers, vehicles)
    .map((candidate) => ({
      ...candidate,
      vehicleMatchScore: calculateVehicleMatchScore(
        normalizedRide.required_vehicle,
        candidate.vehicle
      )
    }))
    .filter((candidate) => {
      if (!candidate.driver.driver_id) return false;
      if (!candidate.vehicle) return false;
      if (isDriverBlockedByStatus(candidate.driver)) return false;
      if (!isVehicleAvailable(candidate.vehicle)) return false;
      if (candidate.vehicleMatchScore <= 0) return false;
      if (hasScheduleConflict(candidate.driver.driver_id, ride, scheduleRows, options)) return false;
      if (
        hasVehicleScheduleConflict(
          candidate.vehicle.vehicle_id,
          ride,
          vehicleScheduleRows,
          options
        )
      ) {
        return false;
      }
      return true;
    });
}

async function scoreDriverCandidates(ride = {}, candidates = [], options = {}) {
  const distanceProvider =
    typeof options.distanceProvider === "function"
      ? options.distanceProvider
      : defaultDistanceProvider;
  const normalizedRide = normalizeRideRecord(ride);
  const scheduleRows = Array.isArray(options.scheduleRows) ? options.scheduleRows : [];

  const candidatesWithDistances = [];
  for (const candidate of candidates) {
    let distanceMeters = Number.POSITIVE_INFINITY;
    try {
      distanceMeters = await distanceProvider(candidate.driver.location, normalizedRide.pickup, {
        driver: candidate.driver,
        vehicle: candidate.vehicle,
        ride: normalizedRide
      });
    } catch (error) {
      distanceMeters = Number.POSITIVE_INFINITY;
    }

    candidatesWithDistances.push({
      ...candidate,
      distanceMeters
    });
  }

  const finiteDistances = candidatesWithDistances
    .map((candidate) => Number(candidate.distanceMeters))
    .filter((distance) => Number.isFinite(distance));
  const minDistanceMeters =
    finiteDistances.length > 0 ? Math.min(...finiteDistances) : Number.POSITIVE_INFINITY;
  const maxDistanceMeters =
    finiteDistances.length > 0 ? Math.max(...finiteDistances) : Number.POSITIVE_INFINITY;

  const scoredCandidates = [];
  for (const candidate of candidatesWithDistances) {
    const previousSchedule = findPreviousSchedule(
      candidate.driver.driver_id,
      ride,
      scheduleRows,
      options
    );
    const linkedOpportunity = await detectLinkedRideOpportunity({
      ride,
      driver: candidate.driver,
      vehicle: candidate.vehicle,
      scheduleRows,
      distanceProvider,
      options
    });
    const linkedRouteScore = Math.max(
      calculateRouteCompatibilityScore(candidate.driver, ride),
      linkedOpportunity?.score || 0
    );
    const scores = {
      vehicle_compatibility: candidate.vehicleMatchScore,
      availability: calculateAvailabilityScore(candidate.driver),
      pickup_distance: calculateDistanceScore(candidate.distanceMeters, {
        minDistanceMeters,
        maxDistanceMeters
      }),
      linked_route: linkedRouteScore,
      rest_fatigue: calculateRestFatigueScore(previousSchedule, ride, options)
    };
    scores.vehicle_match = scores.vehicle_compatibility;
    scores.route_compatibility = scores.linked_route;
    scores.driver_status = scores.rest_fatigue;
    scores.total = calculateFinalScore(scores);

    const scored = {
      driver: candidate.driver,
      vehicle: candidate.vehicle,
      distanceMeters: candidate.distanceMeters,
      previousSchedule,
      linkedOpportunity,
      scores
    };
    scored.reason = buildRecommendationReason(scored);
    scoredCandidates.push(scored);
  }

  return scoredCandidates;
}

async function selectBestDriverRecommendation(ride = {}, drivers = [], vehicles = [], options = {}) {
  const candidates = filterValidDriverCandidates(ride, drivers, vehicles, options);
  if (candidates.length === 0) return null;

  const scoredCandidates = await scoreDriverCandidates(ride, candidates, options);
  scoredCandidates.sort((a, b) => {
    if (b.scores.total !== a.scores.total) return b.scores.total - a.scores.total;
    const aDistance = Number.isFinite(a.distanceMeters) ? a.distanceMeters : Number.POSITIVE_INFINITY;
    const bDistance = Number.isFinite(b.distanceMeters) ? b.distanceMeters : Number.POSITIVE_INFINITY;
    return aDistance - bDistance;
  });

  return scoredCandidates[0] || null;
}

async function generateRecommendation(ride, drivers, vehicles, options = {}) {
  const candidate = await selectBestDriverRecommendation(ride, drivers, vehicles, options);
  if (!candidate) return null;

  return buildRecommendationRowObject({
    ride,
    candidate,
    createdTime:
      typeof options.now === "function"
        ? options.now().toISOString()
        : options.now instanceof Date
          ? options.now.toISOString()
          : ""
  });
}

async function recommendDriversForFinalBidRides({
  sheetsClient,
  spreadsheetId,
  finalBidWorksheetName = "Final Bid",
  recommendationsWorksheetName = RECOMMENDATION_WORKSHEET_NAME,
  driverScheduleWorksheetName = DRIVER_SCHEDULE_WORKSHEET_NAME,
  vehicleScheduleWorksheetName = VEHICLE_SCHEDULE_WORKSHEET_NAME,
  linkedRidesWorksheetName = LINKED_RIDES_WORKSHEET_NAME,
  driversWorksheetName = "Drivers",
  vehiclesWorksheetName = "Vehicles",
  logger,
  distanceProvider,
  now,
  timeZone,
  durationMinutes,
  minGapMinutes,
  routeChainCloseMeters,
  maxLinkedRideGapMinutes,
  fatigueFullRestMinutes,
  databaseRepository
} = {}) {
  const safeLogger =
    logger || {
      info: () => {},
      warn: () => {},
      error: () => {}
    };

  const finalBids = await getSheetData(sheetsClient, spreadsheetId, finalBidWorksheetName);
  const existingRecommendations = await getSheetData(
    sheetsClient,
    spreadsheetId,
    recommendationsWorksheetName
  );
  const drivers = await getSheetData(sheetsClient, spreadsheetId, driversWorksheetName);
  const vehicles = await getSheetData(sheetsClient, spreadsheetId, vehiclesWorksheetName);
  const scheduleRows = await getSheetData(sheetsClient, spreadsheetId, driverScheduleWorksheetName);
  const vehicleScheduleRows = await getSheetData(
    sheetsClient,
    spreadsheetId,
    vehicleScheduleWorksheetName
  );
  const existingLinkedRides = await getSheetData(sheetsClient, spreadsheetId, linkedRidesWorksheetName);

  const recommendedRideIds = new Set(
    existingRecommendations
      .map(normalizeRecommendationRecord)
      .map((recommendation) => recommendation.ride_id)
      .filter(Boolean)
  );
  const existingLinkIds = new Set(
    existingLinkedRides
      .map(normalizeLinkedRideRecord)
      .map((linkedRide) => linkedRide.link_id)
      .filter(Boolean)
  );

  const ridesToRecommend = finalBids
    .filter(isFinalBidRideEligibleForRecommendation)
    .filter((ride) => !recommendedRideIds.has(normalizeRideRecord(ride).ride_id));

  if (ridesToRecommend.length === 0) {
    safeLogger.debug("No Final Bid rides need driver recommendations", {
      stage: "recommendations",
      fallbackUsed: false
    });
    return {
      appended: 0,
      skipped: 0,
      recommendations: []
    };
  }

  const appendedRecommendations = [];
  let skipped = 0;

  for (const ride of ridesToRecommend) {
    const candidate = await selectBestDriverRecommendation(ride, drivers, vehicles, {
      distanceProvider,
      scheduleRows,
      vehicleScheduleRows,
      timeZone,
      durationMinutes,
      minGapMinutes,
      routeChainCloseMeters,
      maxLinkedRideGapMinutes,
      fatigueFullRestMinutes
    });

    const recommendation = candidate
      ? buildRecommendationRowObject({
          ride,
          candidate,
          createdTime:
            typeof now === "function"
              ? now().toISOString()
              : now instanceof Date
                ? now.toISOString()
                : ""
        })
      : null;

    if (!recommendation) {
      skipped += 1;
      const rideId = normalizeRideRecord(ride).ride_id;
      if (shouldLogNoCandidate(rideId)) {
        safeLogger.warn("No suitable driver found for Final Bid ride", {
          stage: "recommendations",
          fallbackUsed: true,
          rideId,
          reason: "no_valid_driver_candidates"
        });
      }
      continue;
    }

    await writeSheetData(sheetsClient, spreadsheetId, recommendationsWorksheetName, [
      buildRecommendationSheetRow(recommendation)
    ]);
    if (databaseRepository && typeof databaseRepository.upsertRecommendation === "function") {
      try {
        await databaseRepository.upsertRecommendation(recommendation);
      } catch (error) {
        safeLogger.warn("Driver recommendation database mirror failed", {
          stage: "database",
          fallbackUsed: true,
          rideId: recommendation["Ride ID"],
          reason: safeTrim(error?.message) || "recommendation_db_mirror_failed",
          error
        });
      }
    }
    if (candidate?.linkedOpportunity?.linkId && !existingLinkIds.has(candidate.linkedOpportunity.linkId)) {
      const linkedRideRecord = buildLinkedRideRowObject(candidate.linkedOpportunity);
      await writeSheetData(sheetsClient, spreadsheetId, linkedRidesWorksheetName, [
        buildLinkedRideSheetRow(linkedRideRecord)
      ]);
      if (databaseRepository && typeof databaseRepository.upsertLinkedRide === "function") {
        try {
          await databaseRepository.upsertLinkedRide(linkedRideRecord);
        } catch (error) {
          safeLogger.warn("Linked ride database mirror failed", {
            stage: "database",
            fallbackUsed: true,
            linkId: linkedRideRecord["Link ID"],
            reason: safeTrim(error?.message) || "linked_ride_db_mirror_failed",
            error
          });
        }
      }
      existingLinkIds.add(candidate.linkedOpportunity.linkId);
    }
    appendedRecommendations.push(recommendation);

    safeLogger.info("Driver recommendation created", {
      stage: "recommendations",
      fallbackUsed: false,
      rideId: recommendation["Ride ID"],
      recommendedDriver: recommendation["Recommended Driver"],
      score: recommendation.Score
    });
  }

  return {
    appended: appendedRecommendations.length,
    skipped,
    recommendations: appendedRecommendations
  };
}

async function recommendDriversForApprovedRides(options = {}) {
  return recommendDriversForFinalBidRides(options);
}

function quoteSheetName(sheetName) {
  const name = safeTrim(sheetName);
  if (!name) return "";
  return name.includes(" ") || name.includes("!")
    ? `'${name.replace(/'/g, "''")}'`
    : name;
}

function columnIndexToLetter(index) {
  let value = Number(index) + 1;
  if (!Number.isFinite(value) || value < 1) return "A";

  let output = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function buildCellRange(worksheetName, rowNumber, columnIndex) {
  return `${quoteSheetName(worksheetName)}!${columnIndexToLetter(columnIndex)}${rowNumber}`;
}

function findHeaderIndex(headers = [], headerName) {
  const target = normalizeComparableText(headerName);
  return headers.findIndex((header) => normalizeComparableText(header) === target);
}

function mapSheetRows(headers = [], rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const record = {
      rowNumber: index + 2,
      rawRow: Array.isArray(row) ? row : []
    };
    headers.forEach((header, columnIndex) => {
      record[header] = safeTrim(Array.isArray(row) ? row[columnIndex] : "");
    });
    return record;
  });
}

async function loadSheetRowsWithMeta({ sheetsClient, spreadsheetId, worksheetName }) {
  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(worksheetName)}!A:Z`,
    majorDimension: "ROWS"
  });
  const values = Array.isArray(response?.data?.values) ? response.data.values : [];
  if (values.length === 0) {
    return { headers: [], records: [] };
  }

  const headers = (Array.isArray(values[0]) ? values[0] : [])
    .map((header) => safeTrim(header))
    .filter(Boolean);
  return {
    headers,
    records: mapSheetRows(headers, values.slice(1))
  };
}

async function updateSingleSheetCell({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  rowNumber,
  columnIndex,
  value
}) {
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: buildCellRange(worksheetName, rowNumber, columnIndex),
    valueInputOption: "RAW",
    requestBody: {
      values: [[safeTrim(value)]]
    }
  });
}

async function updateRecommendationAssignmentStatus({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  headers,
  rowNumber,
  status
}) {
  const columnIndex = findHeaderIndex(headers, "Assignment Status");
  if (columnIndex < 0) {
    throw new Error("Driver Recommendations sheet is missing Assignment Status column");
  }

  await updateSingleSheetCell({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    rowNumber,
    columnIndex,
    value: status
  });
}

async function updateFinalBidAssignedDriver({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  headers,
  rowNumber,
  assignedDriver
}) {
  const columnIndex = findHeaderIndex(headers, "Assigned Driver");
  if (columnIndex < 0) {
    throw new Error("Final Bid sheet is missing Assigned Driver column");
  }

  await updateSingleSheetCell({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    rowNumber,
    columnIndex,
    value: assignedDriver
  });
}

async function updateDriverCurrentLocation({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  headers,
  records,
  driverId,
  currentLocation
}) {
  const driverIdIndex = findHeaderIndex(headers, "Driver ID");
  const locationIndex = findHeaderIndex(headers, "Current Location");
  if (driverIdIndex < 0) throw new Error("Drivers sheet is missing Driver ID column");
  if (locationIndex < 0) throw new Error("Drivers sheet is missing Current Location column");

  const targetDriverId = safeTrim(driverId);
  const driverRecord = (Array.isArray(records) ? records : []).find(
    (record) => safeTrim(record["Driver ID"]) === targetDriverId
  );
  if (!driverRecord) {
    throw new Error(`Driver ${targetDriverId} not found`);
  }

  await updateSingleSheetCell({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    rowNumber: driverRecord.rowNumber,
    columnIndex: locationIndex,
    value: currentLocation
  });
}

async function updateScheduleRideLink({
  sheetsClient,
  spreadsheetId,
  worksheetName,
  headers,
  records,
  rideId,
  columnName,
  value
}) {
  const rideIdIndex = findHeaderIndex(headers, "Ride ID");
  const targetIndex = findHeaderIndex(headers, columnName);
  if (rideIdIndex < 0 || targetIndex < 0) return;

  const scheduleRecord = (Array.isArray(records) ? records : []).find(
    (record) => safeTrim(record["Ride ID"]) === safeTrim(rideId)
  );
  if (!scheduleRecord) return;

  await updateSingleSheetCell({
    sheetsClient,
    spreadsheetId,
    worksheetName,
    rowNumber: scheduleRecord.rowNumber,
    columnIndex: targetIndex,
    value
  });
}

async function processApprovedDriverRecommendations({
  sheetsClient,
  spreadsheetId,
  finalBidWorksheetName = "Final Bid",
  recommendationsWorksheetName = RECOMMENDATION_WORKSHEET_NAME,
  driverScheduleWorksheetName = DRIVER_SCHEDULE_WORKSHEET_NAME,
  vehicleScheduleWorksheetName = VEHICLE_SCHEDULE_WORKSHEET_NAME,
  driversWorksheetName = "Drivers",
  logger,
  timeZone,
  durationMinutes,
  minGapMinutes,
  databaseRepository
} = {}) {
  const safeLogger =
    logger || {
      info: () => {},
      warn: () => {},
      error: () => {}
    };

  if (!sheetsClient) throw new Error("Google Sheets client is not configured");
  if (!spreadsheetId) throw new Error("Spreadsheet ID is missing");

  const finalBidSheet = await loadSheetRowsWithMeta({
    sheetsClient,
    spreadsheetId,
    worksheetName: finalBidWorksheetName
  });
  const recommendationsSheet = await loadSheetRowsWithMeta({
    sheetsClient,
    spreadsheetId,
    worksheetName: recommendationsWorksheetName
  });
  const driverScheduleSheet = await loadSheetRowsWithMeta({
    sheetsClient,
    spreadsheetId,
    worksheetName: driverScheduleWorksheetName
  });
  const vehicleScheduleSheet = await loadSheetRowsWithMeta({
    sheetsClient,
    spreadsheetId,
    worksheetName: vehicleScheduleWorksheetName
  });
  const driversSheet = await loadSheetRowsWithMeta({
    sheetsClient,
    spreadsheetId,
    worksheetName: driversWorksheetName
  });

  const finalBidByRideId = new Map(
    finalBidSheet.records
      .map((record) => [normalizeRideRecord(record).ride_id, record])
      .filter(([rideId]) => rideId)
  );

  let assigned = 0;
  let skipped = 0;
  let failed = 0;

  for (const recommendation of recommendationsSheet.records) {
    if (!isApprovedRecommendationPendingAssignment(recommendation)) {
      skipped += 1;
      continue;
    }

    const normalizedRecommendation = normalizeRecommendationRecord(recommendation);
    if (!normalizedRecommendation.ride_id || !normalizedRecommendation.recommended_driver) {
      failed += 1;
      await updateRecommendationAssignmentStatus({
        sheetsClient,
        spreadsheetId,
        worksheetName: recommendationsWorksheetName,
        headers: recommendationsSheet.headers,
        rowNumber: recommendation.rowNumber,
        status: ASSIGNMENT_STATUS.FAILED
      });
      safeLogger.warn("Approved recommendation cannot be assigned", {
        stage: "recommendation_assignment",
        fallbackUsed: true,
        rideId: normalizedRecommendation.ride_id,
        reason: "ride_id_or_recommended_driver_missing"
      });
      continue;
    }
    if (!normalizedRecommendation.recommended_vehicle) {
      failed += 1;
      await updateRecommendationAssignmentStatus({
        sheetsClient,
        spreadsheetId,
        worksheetName: recommendationsWorksheetName,
        headers: recommendationsSheet.headers,
        rowNumber: recommendation.rowNumber,
        status: ASSIGNMENT_STATUS.FAILED
      });
      safeLogger.warn("Approved recommendation cannot be assigned", {
        stage: "recommendation_assignment",
        fallbackUsed: true,
        rideId: normalizedRecommendation.ride_id,
        reason: "recommended_vehicle_missing"
      });
      continue;
    }

    const finalBid = finalBidByRideId.get(normalizedRecommendation.ride_id);
    if (!finalBid) {
      failed += 1;
      await updateRecommendationAssignmentStatus({
        sheetsClient,
        spreadsheetId,
        worksheetName: recommendationsWorksheetName,
        headers: recommendationsSheet.headers,
        rowNumber: recommendation.rowNumber,
        status: ASSIGNMENT_STATUS.FAILED
      });
      safeLogger.warn("Approved recommendation has no matching Final Bid ride", {
        stage: "recommendation_assignment",
        fallbackUsed: true,
        rideId: normalizedRecommendation.ride_id,
        reason: "final_bid_not_found"
      });
      continue;
    }

    const normalizedFinalBid = normalizeRideRecord(finalBid);
    if (normalizedFinalBid.assigned_driver) {
      skipped += 1;
      await updateRecommendationAssignmentStatus({
        sheetsClient,
        spreadsheetId,
        worksheetName: recommendationsWorksheetName,
        headers: recommendationsSheet.headers,
        rowNumber: recommendation.rowNumber,
        status: ASSIGNMENT_STATUS.ASSIGNED
      });
      safeLogger.info("Approved recommendation skipped because Final Bid already has driver", {
        stage: "recommendation_assignment",
        fallbackUsed: false,
        rideId: normalizedRecommendation.ride_id,
        assignedDriver: normalizedFinalBid.assigned_driver
      });
      continue;
    }

    if (
      hasScheduleConflict(
        normalizedRecommendation.recommended_driver,
        finalBid,
        driverScheduleSheet.records,
        { timeZone, durationMinutes, minGapMinutes }
      )
    ) {
      failed += 1;
      await updateRecommendationAssignmentStatus({
        sheetsClient,
        spreadsheetId,
        worksheetName: recommendationsWorksheetName,
        headers: recommendationsSheet.headers,
        rowNumber: recommendation.rowNumber,
        status: ASSIGNMENT_STATUS.FAILED
      });
      safeLogger.warn("Approved recommendation conflicts with driver schedule", {
        stage: "recommendation_assignment",
        fallbackUsed: true,
        rideId: normalizedRecommendation.ride_id,
        assignedDriver: normalizedRecommendation.recommended_driver,
        reason: "driver_schedule_conflict"
      });
      continue;
    }

    if (
      hasVehicleScheduleConflict(
        normalizedRecommendation.recommended_vehicle,
        finalBid,
        vehicleScheduleSheet.records,
        { timeZone, durationMinutes, minGapMinutes }
      )
    ) {
      failed += 1;
      await updateRecommendationAssignmentStatus({
        sheetsClient,
        spreadsheetId,
        worksheetName: recommendationsWorksheetName,
        headers: recommendationsSheet.headers,
        rowNumber: recommendation.rowNumber,
        status: ASSIGNMENT_STATUS.FAILED
      });
      safeLogger.warn("Approved recommendation conflicts with vehicle schedule", {
        stage: "recommendation_assignment",
        fallbackUsed: true,
        rideId: normalizedRecommendation.ride_id,
        assignedDriver: normalizedRecommendation.recommended_driver,
        vehicleId: normalizedRecommendation.recommended_vehicle,
        reason: "vehicle_schedule_conflict"
      });
      continue;
    }

    try {
      const previousSchedule = findPreviousSchedule(
        normalizedRecommendation.recommended_driver,
        finalBid,
        driverScheduleSheet.records,
        { timeZone, durationMinutes }
      );
      const nextSchedule = findNextSchedule(
        normalizedRecommendation.recommended_driver,
        finalBid,
        driverScheduleSheet.records,
        { timeZone, durationMinutes }
      );
      const scheduleRowObject = buildDriverScheduleRowObject({
        ride: finalBid,
        driverId: normalizedRecommendation.recommended_driver,
        previousSchedule,
        nextSchedule,
        options: { timeZone, durationMinutes }
      });
      const vehicleScheduleRowObject = buildVehicleScheduleRowObject({
        ride: finalBid,
        driverId: normalizedRecommendation.recommended_driver,
        vehicleId: normalizedRecommendation.recommended_vehicle,
        options: { timeZone, durationMinutes }
      });

      await updateFinalBidAssignedDriver({
        sheetsClient,
        spreadsheetId,
        worksheetName: finalBidWorksheetName,
        headers: finalBidSheet.headers,
        rowNumber: finalBid.rowNumber,
        assignedDriver: normalizedRecommendation.recommended_driver
      });
      await writeSheetData(sheetsClient, spreadsheetId, driverScheduleWorksheetName, [
        buildDriverScheduleSheetRow(scheduleRowObject)
      ]);
      await writeSheetData(sheetsClient, spreadsheetId, vehicleScheduleWorksheetName, [
        buildVehicleScheduleSheetRow(vehicleScheduleRowObject)
      ]);
      await updateDriverCurrentLocation({
        sheetsClient,
        spreadsheetId,
        worksheetName: driversWorksheetName,
        headers: driversSheet.headers,
        records: driversSheet.records,
        driverId: normalizedRecommendation.recommended_driver,
        currentLocation: scheduleRowObject["Current Location"]
      });
      if (previousSchedule?.ride_id) {
        await updateScheduleRideLink({
          sheetsClient,
          spreadsheetId,
          worksheetName: driverScheduleWorksheetName,
          headers: driverScheduleSheet.headers,
          records: driverScheduleSheet.records,
          rideId: previousSchedule.ride_id,
          columnName: "Next Ride ID",
          value: normalizedRecommendation.ride_id
        });
      }
      if (nextSchedule?.ride_id) {
        await updateScheduleRideLink({
          sheetsClient,
          spreadsheetId,
          worksheetName: driverScheduleWorksheetName,
          headers: driverScheduleSheet.headers,
          records: driverScheduleSheet.records,
          rideId: nextSchedule.ride_id,
          columnName: "Previous Ride ID",
          value: normalizedRecommendation.ride_id
        });
      }
      await updateRecommendationAssignmentStatus({
        sheetsClient,
        spreadsheetId,
        worksheetName: recommendationsWorksheetName,
        headers: recommendationsSheet.headers,
        rowNumber: recommendation.rowNumber,
        status: ASSIGNMENT_STATUS.ASSIGNED
      });
      if (databaseRepository && typeof databaseRepository.assignRide === "function") {
        try {
          await databaseRepository.assignRide({
            rideId: normalizedRecommendation.ride_id,
            driverId: normalizedRecommendation.recommended_driver,
            vehicleId: normalizedRecommendation.recommended_vehicle,
            driverSchedule: scheduleRowObject,
            vehicleSchedule: vehicleScheduleRowObject
          });
          await databaseRepository.markRecommendationAssignmentStatus(
            normalizedRecommendation.ride_id,
            ASSIGNMENT_STATUS.ASSIGNED
          );
        } catch (error) {
          safeLogger.warn("Recommendation assignment database mirror failed", {
            stage: "database",
            fallbackUsed: true,
            rideId: normalizedRecommendation.ride_id,
            reason: safeTrim(error?.message) || "assignment_db_mirror_failed",
            error
          });
        }
      }

      assigned += 1;
      safeLogger.info("Approved recommendation assigned to Final Bid", {
        stage: "recommendation_assignment",
        fallbackUsed: false,
        rideId: normalizedRecommendation.ride_id,
        assignedDriver: normalizedRecommendation.recommended_driver
      });
    } catch (error) {
      failed += 1;
      await updateRecommendationAssignmentStatus({
        sheetsClient,
        spreadsheetId,
        worksheetName: recommendationsWorksheetName,
        headers: recommendationsSheet.headers,
        rowNumber: recommendation.rowNumber,
        status: ASSIGNMENT_STATUS.FAILED
      });
      safeLogger.warn("Approved recommendation assignment failed", {
        stage: "recommendation_assignment",
        fallbackUsed: true,
        rideId: normalizedRecommendation.ride_id,
        reason: safeTrim(error?.message) || "assignment_update_failed",
        error
      });
    }
  }

  return {
    checked: recommendationsSheet.records.length,
    assigned,
    skipped,
    failed
  };
}

module.exports = {
  RECOMMENDATION_HEADERS,
  RECOMMENDATION_WORKSHEET_NAME,
  DRIVER_SCHEDULE_HEADERS,
  DRIVER_SCHEDULE_WORKSHEET_NAME,
  LINKED_RIDES_HEADERS,
  LINKED_RIDES_WORKSHEET_NAME,
  VEHICLE_SCHEDULE_HEADERS,
  VEHICLE_SCHEDULE_WORKSHEET_NAME,
  ASSIGNMENT_STATUS,
  SCORE_WEIGHTS,
  calculateVehicleMatchScore,
  calculateAvailabilityScore,
  calculateDistanceScore,
  calculateRouteCompatibilityScore,
  calculateRouteChainScore,
  calculateRestFatigueScore,
  calculateDriverStatusScore,
  calculateFinalScore,
  hasScheduleConflict,
  hasVehicleScheduleConflict,
  detectLinkedRideOpportunity,
  filterValidDriverCandidates,
  scoreDriverCandidates,
  selectBestDriverRecommendation,
  buildRecommendationRowObject,
  buildRecommendationSheetRow,
  buildDriverScheduleRowObject,
  buildDriverScheduleSheetRow,
  buildVehicleScheduleRowObject,
  buildVehicleScheduleSheetRow,
  buildLinkedRideRowObject,
  buildLinkedRideSheetRow,
  generateRecommendation,
  recommendDriversForFinalBidRides,
  recommendDriversForApprovedRides,
  processApprovedDriverRecommendations,
  updateFinalBidAssignedDriver,
  updateRecommendationAssignmentStatus
};
