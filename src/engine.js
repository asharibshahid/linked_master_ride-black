const { getSheetData, writeSheetData } = require("./googleSheetsManager");
const { geocodeAddress } = require("./routing/geocode");
const { getRouteFromOSRM } = require("./routing/osrm");

const RECOMMENDATION_HEADERS = [
  "Ride ID",
  "Pickup",
  "Drop Off",
  "Required Vehicle",
  "Recommended Driver",
  "Vehicle Match Score",
  "Availability Score",
  "Calendar Score",
  "Distance Score",
  "Route Compatibility Score",
  "Total Score",
  "Reason",
];

const RECOMMENDATION_WORKSHEET_NAME = "Driver Recommendations";

/**
 * Calculates a score based on vehicle category match.
 * @param {string} requiredCategory The category required for the ride.
 * @param {object} vehicle The vehicle object.
 * @returns {number} A score from 0 to 1.
 */
function calculateVehicleMatchScore(requiredCategory, vehicle) {
  const required = firstNonEmpty(requiredCategory).toLowerCase();
  const actual = firstNonEmpty(vehicle?.["Vehicle Category"], vehicle?.["Vehicle Type"]).toLowerCase();
  if (!required || !actual) return 0;
  return actual === required ? 1 : 0;
}

/**
 * Calculates a score based on driver availability.
 * @param {object} driver The driver object.
 * @returns {number} A score from 0 to 1.
 */
function calculateAvailabilityScore(driver) {
  const status = firstNonEmpty(driver?.Status, driver?.["Current Status"]).toLowerCase();
  if (status !== "available") return 0;
  // TODO: Check against driver's calendar for conflicts
  return 1;
}

/**
 * Calculates a score based on the distance from the driver's current location to the pickup.
 * @param {string} driverLocation The driver's current location.
 * @param {string} pickupLocation The ride's pickup location.
 * @returns {Promise<number>} A score from 0 to 1 (higher is better).
 */
async function calculateDistanceScore(driverLocation, pickupLocation) {
  try {
    const distance = await getDistanceMeters(driverLocation, pickupLocation);
    // Score inversely proportional to distance. Normalize based on expected distances.
    // e.g., anything under 5km is a perfect score.
    if (distance < 5000) return 1;
    if (distance > 50000) return 0; // Over 50km is a bad match
    return 1 - (distance - 5000) / 45000;
  } catch (error) {
    console.error("Distance calculation failed:", error);
    return 0;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function getRideId(ride = {}) {
  return firstNonEmpty(ride["Ride ID"], ride.Refer, ride.refer);
}

function getRidePickup(ride = {}) {
  return firstNonEmpty(ride.Pickup, ride.pickup);
}

function getRideDropOff(ride = {}) {
  return firstNonEmpty(ride["Drop Off"], ride["Drop-off"], ride.drop_off);
}

function getRideVehicle(ride = {}) {
  return firstNonEmpty(ride["Required Vehicle"], ride.Vehicle, ride.required_vehicle);
}

function getDriverVehicleId(driver = {}) {
  return firstNonEmpty(driver["Vehicle ID"], driver.vehicle_id);
}

function getDriverLocation(driver = {}) {
  return firstNonEmpty(driver["Current Location"], driver.Location, driver.location);
}

function getDriverName(driver = {}) {
  return firstNonEmpty(driver["Driver Name"], driver.driver_name);
}

async function getDistanceMeters(fromAddress, toAddress) {
  const from = firstNonEmpty(fromAddress);
  const to = firstNonEmpty(toAddress);
  if (!from || !to) return Number.POSITIVE_INFINITY;

  const origin = await geocodeAddress(from);
  const destination = await geocodeAddress(to);
  if (!origin || !destination) return Number.POSITIVE_INFINITY;

  const route = await getRouteFromOSRM(origin, destination);
  const distance = Number(route?.distance_meters);
  return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

/**
 * Placeholder for route compatibility score.
 * @param {object} driver The driver object.
 * @param {string} pickup The pickup location.
 * @param {string} dropoff The drop-off location.
 * @returns {number} A score from 0 to 1.
 */
function calculateRouteCompatibilityScore(driver, pickup, dropoff) {
  // TODO: Implement logic to check driver's history for similar routes.
  // For now, return a neutral score.
  return 0.5;
}

/**
 * Generates a recommendation for a given ride.
 * @param {object} ride The ride data from the "Final Bid" sheet.
 * @param {Array<object>} drivers A list of all drivers.
 * @param {Array<object>} vehicles A list of all vehicles.
 * @returns {Promise<object|null>} The best recommendation or null.
 */
async function generateRecommendation(ride, drivers, vehicles) {
  const recommendations = [];
  const pickup = getRidePickup(ride);
  const dropOff = getRideDropOff(ride);
  const requiredVehicle = getRideVehicle(ride);

  for (const driver of drivers) {
    const vehicle = vehicles.find(v => firstNonEmpty(v["Vehicle ID"], v.vehicle_id) === getDriverVehicleId(driver));

    const vehicleMatchScore = calculateVehicleMatchScore(requiredVehicle, vehicle);
    const availabilityScore = calculateAvailabilityScore(driver);

    // Skip drivers that are a definite "no"
    if (vehicleMatchScore === 0 || availabilityScore === 0) {
      continue;
    }

    const distanceScore = await calculateDistanceScore(getDriverLocation(driver), pickup);
    const routeCompatibilityScore = calculateRouteCompatibilityScore(driver, pickup, dropOff);

    const weights = { vehicle: 0.3, availability: 0.3, distance: 0.25, route: 0.15 };
    const totalScore =
      vehicleMatchScore * weights.vehicle +
      availabilityScore * weights.availability +
      distanceScore * weights.distance +
      routeCompatibilityScore * weights.route;

    recommendations.push({
      driver,
      scores: {
        vehicle: vehicleMatchScore,
        availability: availabilityScore,
        distance: distanceScore,
        route: routeCompatibilityScore,
        total: totalScore,
      },
    });
  }

  if (recommendations.length === 0) {
    return null;
  }

  // Sort by total score descending
  recommendations.sort((a, b) => b.scores.total - a.scores.total);
  const best = recommendations[0];

  let reason = "Good overall match.";
  if (best.scores.total > 0.8) reason = "Excellent match: Vehicle, availability, and location are ideal.";
  else if (best.scores.distance < 0.5) reason = "Good match, but driver is not close to pickup.";

  return {
    "Ride ID": getRideId(ride),
    "Pickup": pickup,
    "Drop Off": dropOff,
    "Required Vehicle": requiredVehicle,
    "Recommended Driver": getDriverName(best.driver),
    "Vehicle Match Score": Math.round(best.scores.vehicle * 100),
    "Availability Score": Math.round(best.scores.availability * 100),
    "Calendar Score": 100,
    "Distance Score": Math.round(best.scores.distance * 100),
    "Route Compatibility Score": Math.round(best.scores.route * 100),
    "Total Score": Math.round(best.scores.total * 100),
    "Reason": reason,
  };
}

/**
 * Finds approved rides and generates recommendations.
 * @param {object} sheetsClient The authenticated Google Sheets client.
 * @param {string} spreadsheetId The ID of the spreadsheet.
 */
async function recommendDriversForApprovedRides({
  sheetsClient,
  spreadsheetId,
  finalBidWorksheetName = "Final Bid",
  recommendationsWorksheetName = RECOMMENDATION_WORKSHEET_NAME,
  driversWorksheetName = "Drivers",
  vehiclesWorksheetName = "Vehicles",
} = {}) {
  const finalBids = await getSheetData(sheetsClient, spreadsheetId, finalBidWorksheetName);
  const recommendations = await getSheetData(sheetsClient, spreadsheetId, recommendationsWorksheetName);
  const drivers = await getSheetData(sheetsClient, spreadsheetId, driversWorksheetName);
  const vehicles = await getSheetData(sheetsClient, spreadsheetId, vehiclesWorksheetName);

  const recommendedRideIds = new Set(recommendations.map(r => firstNonEmpty(r["Ride ID"], r.Refer)));

  const approvedRides = finalBids.filter(
    bid => bid["Status"] === "Approved" && !recommendedRideIds.has(getRideId(bid))
  );

  if (approvedRides.length === 0) {
    return;
  }

  console.log(`Found ${approvedRides.length} approved rides needing recommendations.`);

  for (const ride of approvedRides) {
    const recommendation = await generateRecommendation(ride, drivers, vehicles);
    if (recommendation) {
      const row = RECOMMENDATION_HEADERS.map((header) => recommendation[header] || "");
      await writeSheetData(sheetsClient, spreadsheetId, recommendationsWorksheetName, [row]);
      console.log(`Recommendation for Ride ID ${getRideId(ride)} added.`);
    } else {
      console.log(`No suitable driver found for Ride ID ${getRideId(ride)}.`);
    }
  }
}

module.exports = {
  recommendDriversForApprovedRides,
  generateRecommendation, // Exported for testing
  RECOMMENDATION_HEADERS,
  RECOMMENDATION_WORKSHEET_NAME,
};
