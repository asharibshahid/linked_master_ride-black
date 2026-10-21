const crypto = require("node:crypto");
const axios = require("axios");
const { extractAreaCodes } = require("../rules/areaCriteria");
const { normalizeVehicle, normalizeCriteria } = require("./criteria");

const MAX_DEADHEAD_MILES = 90;
const ROAD_DISTANCE_PREFILTER_MILES = 115;
const POSSIBLE_MAX_DEADHEAD_MILES = 120;
const POSSIBLE_PAIR_LIMIT = 24;
const AIRPORT_QUERIES = Object.freeze({
  LHR: "Heathrow Airport, UK",
  LGW: "Gatwick Airport, UK",
  STN: "Stansted Airport, UK",
  LTN: "Luton Airport, UK",
  LCY: "London City Airport, UK",
  SEN: "London Southend Airport, UK",
  BHX: "Birmingham Airport, UK",
  MAN: "Manchester Airport, UK"
});
const AIRPORT_COORDINATES = Object.freeze({
  LHR: { lat: 51.47, lng: -0.4543 },
  LGW: { lat: 51.1537, lng: -0.1821 },
  STN: { lat: 51.886, lng: 0.2389 },
  LTN: { lat: 51.8747, lng: -0.3683 },
  LCY: { lat: 51.5053, lng: 0.0553 },
  SEN: { lat: 51.5714, lng: 0.6956 },
  BHX: { lat: 52.4539, lng: -1.748 },
  MAN: { lat: 53.3537, lng: -2.275 }
});
const UK_POSTCODE_PATTERN = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function number(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timeValue(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function estimateRideMinutes(job = {}) {
  const explicit = number(job.estimatedDurationMinutes || job.estimated_duration_minutes, 0);
  if (explicit > 0) return Math.max(20, explicit);
  const miles = number(job.distance, 0);
  return miles > 0 ? Math.max(35, Math.round(miles * 1.5 + 20)) : 60;
}

function normalizeCoordinate(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function haversineMiles(left, right) {
  const from = normalizeCoordinate(left);
  const to = normalizeCoordinate(right);
  if (!from || !to) return null;
  const radians = (degrees) => degrees * (Math.PI / 180);
  const deltaLat = radians(to.lat - from.lat);
  const deltaLng = radians(to.lng - from.lng);
  const fromLat = radians(from.lat);
  const toLat = radians(to.lat);
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function geocodeQuery(address) {
  const value = text(address);
  if (!value) return "";
  const codes = extractAreaCodes(value);
  const airportCode = codes.find((code) => AIRPORT_QUERIES[code]);
  if (!airportCode) return value;
  if (/airport|heathrow|gatwick|stansted|luton/i.test(value)) return value;
  return AIRPORT_QUERIES[airportCode];
}

function airportCoordinate(address) {
  const value = text(address);
  const codes = extractAreaCodes(value);
  const code = codes.find((item) => AIRPORT_COORDINATES[item]);
  if (code) return AIRPORT_COORDINATES[code];
  const names = [
    [/heathrow/i, "LHR"], [/gatwick/i, "LGW"], [/stansted/i, "STN"],
    [/luton/i, "LTN"], [/london city/i, "LCY"], [/southend/i, "SEN"],
    [/birmingham airport/i, "BHX"], [/manchester airport/i, "MAN"]
  ];
  const match = names.find(([pattern]) => pattern.test(value));
  return match ? AIRPORT_COORDINATES[match[1]] : null;
}

function extractUkPostcode(address) {
  const match = text(address).match(UK_POSTCODE_PATTERN);
  if (!match) return "";
  return match[1].replace(/\s+/g, "").toUpperCase();
}

function createUkPostcodeLookup(options = {}) {
  const httpClient = options.httpClient || axios;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
  return async function lookupPostcode(address) {
    const postcode = extractUkPostcode(address);
    if (!postcode) return null;
    try {
      const response = await httpClient.get(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, {
        timeout: timeoutMs
      });
      return normalizeCoordinate({
        lat: response?.data?.result?.latitude,
        lng: response?.data?.result?.longitude
      });
    } catch (_error) {
      return null;
    }
  };
}

function normalizeRoute(value) {
  const distanceMeters = Number(value?.distance_meters ?? value?.distanceMeters);
  const durationSeconds = Number(value?.duration_seconds ?? value?.durationSeconds);
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  return {
    distanceMiles: distanceMeters / 1609.344,
    durationMinutes: durationSeconds / 60
  };
}

function createRoutingResolver(options = {}) {
  const geocoder = options.geocoder;
  const osrmClient = options.osrmClient;
  const postcodeLookup = options.postcodeLookup || createUkPostcodeLookup(options);
  const geocodeCache = new Map();
  const routeCache = new Map();

  async function geocode(address) {
    const query = geocodeQuery(address);
    if (!query) return null;
    const key = query.toLowerCase();
    if (!geocodeCache.has(key)) {
      const method = geocoder.geocodeAddress || geocoder.geocode;
      geocodeCache.set(
        key,
        Promise.resolve(airportCoordinate(address))
          .then(async (knownAirport) => knownAirport || await postcodeLookup(address))
          .then(async (postcodePoint) => postcodePoint || (
            typeof method === "function" ? await method.call(geocoder, query) : null
          ))
          .then(normalizeCoordinate)
          .catch(() => null)
      );
    }
    return geocodeCache.get(key);
  }

  async function route(origin, destination) {
    const from = normalizeCoordinate(origin);
    const to = normalizeCoordinate(destination);
    if (!from || !to || !osrmClient) return null;
    const key = `${from.lat.toFixed(5)},${from.lng.toFixed(5)}>${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
    if (!routeCache.has(key)) {
      const method = osrmClient.getRouteFromOSRM || osrmClient.route;
      routeCache.set(
        key,
        Promise.resolve(typeof method === "function" ? method.call(osrmClient, from, to) : null)
          .then(normalizeRoute)
          .catch(() => null)
      );
    }
    return routeCache.get(key);
  }

  return { geocode, route };
}

function sharedLocationScore(left, right) {
  const leftCodes = extractAreaCodes(left);
  const rightCodes = extractAreaCodes(right);
  const exact = leftCodes.find((code) => rightCodes.includes(code));
  return exact
    ? { score: 30, distanceMiles: null, reason: `same_area_${exact}_routing_required` }
    : { score: 0, distanceMiles: null, reason: "road_route_required" };
}

function buildSequence(anchor, candidate) {
  const anchorStart = timeValue(anchor.pickupAt || anchor.pickup_at);
  const candidateStart = timeValue(candidate.pickupAt || candidate.pickup_at);
  if (!anchorStart || !candidateStart || anchor.rideId === candidate.rideId) return null;
  if (candidateStart <= anchorStart) return null;
  return {
    direction: "after",
    previousRide: anchor,
    nextRide: candidate,
    previousStart: anchorStart,
    nextStart: candidateStart
  };
}

function isAirportLocation(value) {
  return Boolean(airportCoordinate(value));
}

function isStrictAirportReturnPattern(anchor, candidate) {
  const anchorPickup = text(anchor.pickup);
  const anchorDrop = text(anchor.dropOff || anchor.drop_off);
  const candidatePickup = text(candidate.pickup);
  const candidateDrop = text(candidate.dropOff || candidate.drop_off);
  return (
    isAirportLocation(anchorPickup) &&
    !isAirportLocation(anchorDrop) &&
    !isAirportLocation(candidatePickup) &&
    isAirportLocation(candidateDrop)
  );
}

function deadheadScore(distanceMiles) {
  if (distanceMiles <= 5) return 35;
  if (distanceMiles <= 15) return 30;
  if (distanceMiles <= 30) return 24;
  if (distanceMiles <= 50) return 17;
  if (distanceMiles <= 70) return 11;
  return 6;
}

function availabilityScore(slackMinutes) {
  if (slackMinutes <= 120) return 20;
  if (slackMinutes <= 240) return 16;
  if (slackMinutes <= 360) return 12;
  return 8;
}

function returnDirectionScore(startMiles, endMiles) {
  if (!Number.isFinite(startMiles) || !Number.isFinite(endMiles) || startMiles <= 0) return null;
  const progressMiles = startMiles - endMiles;
  const progressRatio = progressMiles / startMiles;
  if (progressRatio < 0.1 && endMiles > 30) return null;
  if (endMiles <= 15 || progressRatio >= 0.7) return { score: 25, progressMiles, progressRatio };
  if (endMiles <= 35 || progressRatio >= 0.45) return { score: 20, progressMiles, progressRatio };
  if (progressRatio >= 0.25) return { score: 14, progressMiles, progressRatio };
  return { score: 8, progressMiles, progressRatio };
}

async function scoreLink(anchor, candidate, rawCriteria = {}, options = {}) {
  const criteria = normalizeCriteria(rawCriteria);
  const anchorVehicle = normalizeVehicle(anchor.requiredVehicle || anchor.required_vehicle);
  const candidateVehicle = normalizeVehicle(candidate.requiredVehicle || candidate.required_vehicle);
  if (!anchorVehicle || anchorVehicle !== candidateVehicle) return null;
  if (!isStrictAirportReturnPattern(anchor, candidate)) return null;

  const sequence = buildSequence(anchor, candidate);
  if (!sequence) return null;
  const { direction, previousRide, nextRide, previousStart, nextStart } = sequence;
  const startDifferenceMinutes = (nextStart - previousStart) / 60000;
  if (startDifferenceMinutes <= 0 || startDifferenceMinutes > criteria.maxLinkGapHours * 60 + 12 * 60) {
    return null;
  }

  const resolver = options.resolver || createRoutingResolver(options);
  const previousPickup = text(previousRide.pickup);
  const previousDrop = text(previousRide.dropOff || previousRide.drop_off);
  const nextPickup = text(nextRide.pickup);
  const nextDrop = text(nextRide.dropOff || nextRide.drop_off);
  if (!previousPickup || !previousDrop || !nextPickup || !nextDrop) return null;

  const previousDropPoint = await resolver.geocode(previousDrop);
  const nextPickupPoint = await resolver.geocode(nextPickup);
  if (!previousDropPoint || !nextPickupPoint) return null;

  const straightDeadheadMiles = haversineMiles(previousDropPoint, nextPickupPoint);
  if (!Number.isFinite(straightDeadheadMiles) || straightDeadheadMiles > ROAD_DISTANCE_PREFILTER_MILES) {
    return null;
  }

  const previousPickupPoint = await resolver.geocode(previousPickup);
  if (!previousPickupPoint) return null;
  const [previousRoute, deadheadRoute] = await Promise.all([
    resolver.route(previousPickupPoint, previousDropPoint),
    resolver.route(previousDropPoint, nextPickupPoint)
  ]);
  if (!deadheadRoute || deadheadRoute.distanceMiles > MAX_DEADHEAD_MILES) return null;

  const previousRideMinutes = previousRoute?.durationMinutes || estimateRideMinutes(previousRide);
  const availableAfterRideMinutes = startDifferenceMinutes - previousRideMinutes;
  if (availableAfterRideMinutes <= 0 || availableAfterRideMinutes > criteria.maxLinkGapHours * 60) {
    return null;
  }
  const remainingAfterDeadheadMinutes = availableAfterRideMinutes - deadheadRoute.durationMinutes;
  if (remainingAfterDeadheadMinutes < criteria.minimumTurnaroundMinutes) return null;

  const nextDropPoint = await resolver.geocode(nextDrop);
  if (!nextDropPoint) return null;
  const originDistance = haversineMiles(previousDropPoint, previousPickupPoint);
  const endingDistance = haversineMiles(nextDropPoint, previousPickupPoint);
  const returnDirection = returnDirectionScore(originDistance, endingDistance);
  if (!returnDirection) return null;

  const slackMinutes = remainingAfterDeadheadMinutes - criteria.minimumTurnaroundMinutes;
  const breakdown = {
    deadhead: deadheadScore(deadheadRoute.distanceMiles),
    availability: availabilityScore(slackMinutes),
    returnDirection: returnDirection.score,
    vehicle: 20
  };
  const score = Math.min(100, Object.values(breakdown).reduce((sum, value) => sum + value, 0));
  const baselineEmptyMiles = originDistance * 1.18;
  const remainingEmptyMiles = endingDistance * 1.18;
  const savedEmptyMiles = Math.max(0, baselineEmptyMiles - deadheadRoute.distanceMiles - remainingEmptyMiles);
  const estimatedSaving = Number((savedEmptyMiles * 1.35).toFixed(2));
  const distanceMiles = Number(deadheadRoute.distanceMiles.toFixed(1));
  const travelMinutes = Math.round(deadheadRoute.durationMinutes);
  const gapMinutes = Math.round(availableAfterRideMinutes);
  const progressPercent = Math.max(0, Math.round(returnDirection.progressRatio * 100));
  const key = `${anchor.rideId}|${candidate.rideId}|${direction}`;

  return {
    linkId: `LINK-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 12).toUpperCase()}`,
    anchorRideId: anchor.rideId,
    candidateRideId: candidate.rideId,
    firstRideId: previousRide.rideId,
    secondRideId: nextRide.rideId,
    candidateSource: candidate.sourceType || candidate.source_type,
    direction,
    previousDrop,
    nextPickup,
    timeGapMinutes: gapMinutes,
    timeGap: `${gapMinutes} min (${travelMinutes} min deadhead)`,
    distanceMiles,
    distanceBetween: `${distanceMiles} mi / ${travelMinutes} min`,
    savingEstimate: estimatedSaving,
    score,
    scoreBreakdown: breakdown,
    reason: `actual drop-to-pickup route ${distanceMiles} mi/${travelMinutes} min; ${Math.round(remainingAfterDeadheadMinutes)} min available; ${progressPercent}% return progress; ${anchorVehicle}`
  };
}

async function findLinkedRideOpportunities(prebookJobs = [], candidateJobs = [], criteria = {}, options = {}) {
  const resolver = options.resolver || createRoutingResolver(options);
  const links = [];
  for (const anchor of prebookJobs) {
    for (const candidate of candidateJobs) {
      const link = await scoreLink(anchor, candidate, criteria, { resolver });
      if (link) links.push(link);
    }
  }
  return links.sort((left, right) => right.score - left.score || left.timeGapMinutes - right.timeGapMinutes);
}

async function scorePossibleReturn(anchor, candidate, rawCriteria = {}, options = {}) {
  const criteria = normalizeCriteria(rawCriteria);
  const anchorVehicle = normalizeVehicle(anchor.requiredVehicle || anchor.required_vehicle);
  const candidateVehicle = normalizeVehicle(candidate.requiredVehicle || candidate.required_vehicle);
  if (!anchorVehicle || anchorVehicle !== candidateVehicle) return null;
  if (!isStrictAirportReturnPattern(anchor, candidate)) return null;

  const sequence = buildSequence(anchor, candidate);
  if (!sequence) return null;
  const { previousRide, nextRide, previousStart, nextStart } = sequence;
  const startDifferenceMinutes = (nextStart - previousStart) / 60000;
  if (startDifferenceMinutes <= 0 || startDifferenceMinutes > (criteria.maxLinkGapHours + 12) * 60) return null;

  const resolver = options.resolver || createRoutingResolver(options);
  const previousPickup = text(previousRide.pickup);
  const previousDrop = text(previousRide.dropOff || previousRide.drop_off);
  const nextPickup = text(nextRide.pickup);
  const nextDrop = text(nextRide.dropOff || nextRide.drop_off);
  if (!previousPickup || !previousDrop || !nextPickup || !nextDrop) return null;

  const previousDropPoint = await resolver.geocode(previousDrop);
  const nextPickupPoint = await resolver.geocode(nextPickup);
  if (!previousDropPoint || !nextPickupPoint) return null;
  const straightDeadheadMiles = haversineMiles(previousDropPoint, nextPickupPoint);
  if (!Number.isFinite(straightDeadheadMiles) || straightDeadheadMiles > POSSIBLE_MAX_DEADHEAD_MILES) return null;

  const previousPickupPoint = await resolver.geocode(previousPickup);
  if (!previousPickupPoint) return null;
  const [previousRoute, deadheadRoute, nextDropPoint] = await Promise.all([
    resolver.route(previousPickupPoint, previousDropPoint),
    resolver.route(previousDropPoint, nextPickupPoint),
    resolver.geocode(nextDrop)
  ]);
  if (!deadheadRoute || !nextDropPoint || deadheadRoute.distanceMiles > POSSIBLE_MAX_DEADHEAD_MILES) return null;

  const previousRideMinutes = previousRoute?.durationMinutes || estimateRideMinutes(previousRide);
  const availableAfterRideMinutes = startDifferenceMinutes - previousRideMinutes;
  const remainingAfterDeadheadMinutes = availableAfterRideMinutes - deadheadRoute.durationMinutes;
  if (remainingAfterDeadheadMinutes < criteria.minimumTurnaroundMinutes) return null;

  const originDistance = haversineMiles(previousDropPoint, previousPickupPoint);
  const endingDistance = haversineMiles(nextDropPoint, previousPickupPoint);
  if (!Number.isFinite(originDistance) || !Number.isFinite(endingDistance) || originDistance <= 0) return null;
  const progressRatio = (originDistance - endingDistance) / originDistance;
  const direction = returnDirectionScore(originDistance, endingDistance);
  if (!direction) return null;
  const slackMinutes = remainingAfterDeadheadMinutes - criteria.minimumTurnaroundMinutes;
  const breakdown = {
    deadhead: deadheadScore(deadheadRoute.distanceMiles),
    availability: availabilityScore(slackMinutes),
    returnDirection: direction?.score || 0,
    vehicle: 20
  };
  const distanceMiles = Number(deadheadRoute.distanceMiles.toFixed(1));
  const travelMinutes = Math.round(deadheadRoute.durationMinutes);
  const gapMinutes = Math.round(availableAfterRideMinutes);
  const reviewReasons = [];
  if (distanceMiles > MAX_DEADHEAD_MILES) reviewReasons.push(`deadhead exceeds the ${MAX_DEADHEAD_MILES} mi strict limit`);
  if (availableAfterRideMinutes > criteria.maxLinkGapHours * 60) {
    reviewReasons.push(`post-ride wait exceeds the ${criteria.maxLinkGapHours} hour strict limit`);
  }
  const key = `${anchor.rideId}|${candidate.rideId}|possible`;

  return {
    linkId: `POSSIBLE-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 12).toUpperCase()}`,
    anchorRideId: anchor.rideId,
    candidateRideId: candidate.rideId,
    firstRideId: previousRide.rideId,
    secondRideId: nextRide.rideId,
    candidateSource: candidate.sourceType || candidate.source_type,
    direction: "manual review",
    previousDrop,
    nextPickup,
    timeGapMinutes: gapMinutes,
    timeGap: `${gapMinutes} min (${travelMinutes} min deadhead)`,
    distanceMiles,
    distanceBetween: `${distanceMiles} mi / ${travelMinutes} min`,
    savingEstimate: null,
    score: Math.min(100, Object.values(breakdown).reduce((sum, value) => sum + value, 0)),
    scoreBreakdown: breakdown,
    reviewOnly: true,
    reason: `review only: actual drop-to-pickup route ${distanceMiles} mi/${travelMinutes} min; ${Math.round(remainingAfterDeadheadMinutes)} min available; ${Math.round(progressRatio * 100)}% return progress; ${reviewReasons.join("; ") || "not promoted to a strict link"}`
  };
}

async function findPossibleReturnOpportunities(prebookJobs = [], candidateJobs = [], criteria = {}, options = {}) {
  const resolver = options.resolver || createRoutingResolver(options);
  const normalizedCriteria = normalizeCriteria(criteria);
  const pairs = [];
  for (const anchor of prebookJobs) {
    const anchorVehicle = normalizeVehicle(anchor.requiredVehicle || anchor.required_vehicle);
    const anchorStart = timeValue(anchor.pickupAt || anchor.pickup_at);
    if (!anchorVehicle || !anchorStart) continue;
    const earliestCandidateStart = anchorStart + (estimateRideMinutes(anchor) + normalizedCriteria.minimumTurnaroundMinutes) * 60000;
    for (const candidate of candidateJobs) {
      const candidateStart = timeValue(candidate.pickupAt || candidate.pickup_at);
      const candidateVehicle = normalizeVehicle(candidate.requiredVehicle || candidate.required_vehicle);
      if (
        candidateVehicle !== anchorVehicle ||
        !isStrictAirportReturnPattern(anchor, candidate) ||
        !candidateStart ||
        candidateStart < earliestCandidateStart ||
        candidateStart - anchorStart > (normalizedCriteria.maxLinkGapHours + 12) * 3600000
      ) continue;
      pairs.push({
        anchor,
        candidate,
        startDifferenceMinutes: (candidateStart - anchorStart) / 60000,
        locationHint: sharedLocationScore(anchor.dropOff || anchor.drop_off, candidate.pickup).score
      });
    }
  }
  const rankedPairs = (await Promise.all(pairs.map(async (pair) => {
    const [anchorDropPoint, candidatePickupPoint] = await Promise.all([
      resolver.geocode(pair.anchor.dropOff || pair.anchor.drop_off),
      resolver.geocode(pair.candidate.pickup)
    ]);
    const proximityMiles = haversineMiles(anchorDropPoint, candidatePickupPoint);
    if (!Number.isFinite(proximityMiles) || proximityMiles > POSSIBLE_MAX_DEADHEAD_MILES) return null;
    return { ...pair, proximityMiles };
  }))).filter(Boolean);
  rankedPairs.sort((left, right) =>
    left.proximityMiles - right.proximityMiles ||
    right.locationHint - left.locationHint ||
    left.startDifferenceMinutes - right.startDifferenceMinutes
  );
  const selected = [];
  const sourceCounts = new Map();
  const sources = new Set(rankedPairs.map((pair) => pair.candidate.sourceType || pair.candidate.source_type));
  const sourceLimit = Math.max(1, Math.ceil(POSSIBLE_PAIR_LIMIT / Math.max(1, sources.size)));
  for (const pair of rankedPairs) {
    const source = pair.candidate.sourceType || pair.candidate.source_type;
    if ((sourceCounts.get(source) || 0) >= sourceLimit) continue;
    selected.push(pair);
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    if (selected.length === POSSIBLE_PAIR_LIMIT) break;
  }
  for (const pair of rankedPairs) {
    if (selected.length === POSSIBLE_PAIR_LIMIT) break;
    if (!selected.includes(pair)) selected.push(pair);
  }
  const links = [];
  for (const { anchor, candidate } of selected) {
    const link = await scorePossibleReturn(anchor, candidate, normalizedCriteria, { resolver });
    if (link) links.push(link);
  }
  return links.sort((left, right) => right.score - left.score || left.timeGapMinutes - right.timeGapMinutes);
}

module.exports = {
  MAX_DEADHEAD_MILES,
  estimateRideMinutes,
  normalizeCoordinate,
  haversineMiles,
  extractUkPostcode,
  createUkPostcodeLookup,
  createRoutingResolver,
  sharedLocationScore,
  isAirportLocation,
  isStrictAirportReturnPattern,
  scoreLink,
  scorePossibleReturn,
  findLinkedRideOpportunities,
  findPossibleReturnOpportunities
};
