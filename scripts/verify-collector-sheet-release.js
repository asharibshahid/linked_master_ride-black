const assert = require("node:assert/strict");
const { createLocalExtractor } = require("../src/extraction/localExtractor");
const { cleanupRide } = require("../src/extraction/rideCleanup");
const { buildRowFromRideObject } = require("../src/extraction/schemas");
const { DedupeStore } = require("../src/utils/dedupe");
const staged = process.argv.includes("--staged");
const { createMessageHandler } = require(staged
  ? "../src/whatsapp/messageHandler.next"
  : "../src/whatsapp/messageHandler");
const { buildGeocodeCandidates } = require(staged
  ? "../src/routing/geocode.next"
  : "../src/routing/geocode");
const { parsePickupDateTime } = require(staged
  ? "../src/sheets/upcomingJobs.next"
  : "../src/sheets/upcomingJobs");

async function main() {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const raw = "Tuesday 20th October 2026 10:00 am\nFrom: Heathrow Terminal 5\nTo: BN14 ORE\n2 Booster Seat\nFare: GBP 120";
  const extracted = createLocalExtractor().extract(raw, { received_at: "2026-10-14T10:00:00Z" });
  const cleaned = cleanupRide(extracted, raw).ride;
  assert.equal(cleaned.pickup_day_date, "Tue 20th Oct 26");
  assert.equal(cleaned.pickup, "LHR T5");
  assert.equal(cleaned.drop_off, "BN14 0RE");
  assert.equal(cleaned.special_instructions, "2 Booster Seats");
  assert.equal(buildRowFromRideObject(cleaned).length, 13);
  assert.ok(parsePickupDateTime(cleaned.pickup_day_date, cleaned.starting_timing));
  assert.equal(buildGeocodeCandidates("SEN")[0].query, "London Southend Airport, UK");

  const saved = [];
  const handler = createMessageHandler({
    env: { allowedGroups: ["release-check@g.us"], appTimeZone: "Europe/London" },
    logger,
    dedupe: new DedupeStore({ logger }),
    localExtractor: { extract: () => extracted },
    openaiNormalizer: { normalizeWithOpenAI: async ({ extracted: ride }) => ride },
    geocoder: { geocodeAddress: async () => ({ lat: 51.5, lng: -0.1 }) },
    osrmClient: { getRouteFromOSRM: async () => ({ distance_meters: 96561 }) },
    appendRideRow: async (ride) => saved.push(ride),
    appendReviewRow: async (ride) => saved.push(ride)
  });
  const message = (id) => ({
    body: raw,
    from: "release-check@g.us",
    fromMe: false,
    type: "chat",
    timestamp: 1791972000,
    id: { _serialized: id },
    getChat: async () => ({ isGroup: true, id: { _serialized: "release-check@g.us" }, name: "Release check" })
  });
  await handler(message("release-1"));
  await handler(message("release-2"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].pickup, "LHR T5");
  assert.equal(saved[0].drop_off, "BN14 0RE");
  assert.equal(saved[0].special_instructions, "2 Booster Seats");

  const reviewed = [];
  const badFareHandler = createMessageHandler({
    env: { allowedGroups: ["release-check@g.us"], appTimeZone: "Europe/London" },
    logger,
    dedupe: new DedupeStore({ logger }),
    localExtractor: { extract: () => ({ pickup: "LHR", drop_off: "BN14 0RE", fare: "5666.80" }) },
    openaiNormalizer: { normalizeWithOpenAI: async ({ extracted: ride }) => ride },
    geocoder: { geocodeAddress: async () => ({ lat: 51.5, lng: -0.1 }) },
    osrmClient: { getRouteFromOSRM: async () => ({ distance_meters: 56327 }) },
    appendRideRow: async () => { throw new Error("Bad fare must not reach Rides"); },
    appendReviewRow: async (ride) => reviewed.push(ride)
  });
  const badFareMessage = message("release-bad-fare");
  badFareMessage.body = "LHR to BN14 0RE, fare 5666.80";
  await badFareHandler(badFareMessage);
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0].fare, "");
  console.log("Collector sheet release preflight passed (no WhatsApp or Sheet writes)");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
