const crypto = require("node:crypto");
const axios = require("axios");
const { env } = require("../config/env");
const { createLogger, summarizeKnownError } = require("../utils/logger");
const { safeTrim } = require("../utils/text");
const { executeWithRetry, defaultShouldRetry } = require("../utils/retry");

const DEFAULT_TIMEOUT_MS = 12000;
const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/search";
const POSTCODES_IO_BASE_URL = "https://api.postcodes.io";
const DEFAULT_USER_AGENT = "ride-bot/1.0 (geocode)";
const BULLET_CHARS_PATTERN = /[\u2022\u00B7\u25AA\u25E6\u25CF\u25C6\u25BA]/g;
const MOJIBAKE_BULLET_PATTERN = /(â€¢|â—|â—¦)/g;
const LEADING_LABEL_PATTERN =
  /^\s*(pick(?:\s*|-)?up|drop(?:\s*|-)?off|dropoff)\s*[:\-]?\s*/i;
const ADDRESS_LABEL_PATTERN =
  /^\s*(?:[\u2022\u00B7\u25AA\u25E6\u25CF\u25C6\u25BA\-*]+\s*)?(pick(?:\s*|-)?up|drop(?:\s*|-)?off|dropoff)\s*[:\-]?\s*(.*)$/i;
const NON_ADDRESS_SECTION_PATTERN =
  /^(landing|route|head\s*passenger|mobile\s*number|flight|arriving\s*from|expires?)\b/i;
const UK_POSTCODE_PATTERN = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const UK_OUTCODE_AT_END_PATTERN = /(?:^|[\s,])([A-Z]{1,2}\d[A-Z\d]?)\s*$/i;
const UK_BOUNDS = Object.freeze({ minLat: 49.8, maxLat: 60.95, minLng: -8.7, maxLng: 1.8 });
const UK_VIEWBOX = "-8.7,60.95,1.8,49.8";
const UK_AIRPORTS = Object.freeze([
  { pattern: /\b(?:lhr|heathrow)\b/i, lat: 51.47, lng: -0.4543, name: "Heathrow Airport, UK" },
  { pattern: /\b(?:lgw|gatwick)\b/i, lat: 51.1537, lng: -0.1821, name: "Gatwick Airport, UK" },
  { pattern: /\b(?:stn|stansted)\b/i, lat: 51.885, lng: 0.235, name: "Stansted Airport, UK" },
  { pattern: /\b(?:ltn|luton airport)\b/i, lat: 51.8763, lng: -0.3717, name: "Luton Airport, UK" },
  { pattern: /\b(?:lcy|london city airport)\b/i, lat: 51.5053, lng: 0.0553, name: "London City Airport, UK" },
  { pattern: /\b(?:bhx|birmingham airport)\b/i, lat: 52.4524, lng: -1.7435, name: "Birmingham Airport, UK" },
  { pattern: /\b(?:man|manchester airport)\b/i, lat: 53.3537, lng: -2.275, name: "Manchester Airport, UK" }
]);

function cleanAddressLine(line) {
  return String(line || "")
    .replace(BULLET_CHARS_PATTERN, " ")
    .replace(MOJIBAKE_BULLET_PATTERN, " ")
    .replace(/^\s*[-*]+\s*/, "")
    .replace(LEADING_LABEL_PATTERN, "")
    .replace(/^[\s,;:.-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAddressForGeocoding(address) {
  const text = String(address || "");
  if (!text) return "";

  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ");

  const cleanedLines = [];
  let collectedAnyAddressPart = false;

  const lines = normalized.split("\n");
  for (const rawLine of lines) {
    const raw = String(rawLine || "").trim();
    if (!raw) continue;

    const labelMatch = raw.match(ADDRESS_LABEL_PATTERN);
    if (labelMatch) {
      const labeledValue = cleanAddressLine(labelMatch[2] || "");
      if (collectedAnyAddressPart) {
        // Stop if another labeled address block appears; this prevents mixing pickup/drop.
        break;
      }

      if (labeledValue) {
        cleanedLines.push(labeledValue);
        collectedAnyAddressPart = true;
      }
      continue;
    }

    const cleaned = cleanAddressLine(raw);
    if (!cleaned) continue;

    if (NON_ADDRESS_SECTION_PATTERN.test(cleaned)) {
      if (collectedAnyAddressPart) break;
      continue;
    }

    cleanedLines.push(cleaned);
    collectedAnyAddressPart = true;
  }

  const collapsed = cleanedLines
    .join(", ")
    .replace(/,\s*,+/g, ", ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s{2,}/g, " ");

  return safeTrim(collapsed);
}

function addressPreview(address, maxLength = 140) {
  const text = String(address || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function addressFingerprint(address) {
  if (!address) return "";
  return crypto.createHash("sha256").update(address).digest("hex").slice(0, 12);
}

function extractPostcode(address) {
  const match = String(address || "").match(UK_POSTCODE_PATTERN);
  return safeTrim(match?.[1] || "").toUpperCase();
}

function extractOutcode(address) {
  const fullPostcode = extractPostcode(address);
  if (fullPostcode) return fullPostcode.split(/\s+/)[0];
  const match = safeTrim(address).toUpperCase().match(UK_OUTCODE_AT_END_PATTERN);
  return safeTrim(match?.[1] || "");
}

function isWithinUkBounds(lat, lng) {
  return (
    isValidLatLng(lat, lng) &&
    lat >= UK_BOUNDS.minLat &&
    lat <= UK_BOUNDS.maxLat &&
    lng >= UK_BOUNDS.minLng &&
    lng <= UK_BOUNDS.maxLng
  );
}

function findKnownUkAirport(address) {
  const text = safeTrim(address);
  const airport = UK_AIRPORTS.find((entry) => entry.pattern.test(text));
  if (!airport) return null;
  return { lat: airport.lat, lng: airport.lng, formatted_address: airport.name };
}

async function resolveUkPostcode(address, { httpClient, timeoutMs, logger }) {
  const postcode = extractPostcode(address);
  const outcode = extractOutcode(address);
  if (!postcode && !outcode) return null;

  const path = postcode
    ? `/postcodes/${encodeURIComponent(postcode.replace(/\s+/g, ""))}`
    : `/outcodes/${encodeURIComponent(outcode)}`;

  try {
    const response = await httpClient.get(`${POSTCODES_IO_BASE_URL}${path}`, { timeout: timeoutMs });
    const result = response?.data?.result;
    const lat = Number(result?.latitude);
    const lng = Number(result?.longitude);
    if (!isWithinUkBounds(lat, lng)) return null;
    return {
      lat,
      lng,
      formatted_address: safeTrim(result?.admin_district || result?.region || postcode || outcode)
    };
  } catch (error) {
    logger.debug("UK postcode lookup missed; using bounded address search", {
      stage: "geocoding",
      reason: postcode ? "postcode_lookup_failed" : "outcode_lookup_failed",
      addressFingerprint: addressFingerprint(postcode || outcode)
    });
    return null;
  }
}

function simplifyAddress(address) {
  const text = safeTrim(String(address || ""));
  if (!text) return "";

  const withoutPostcode = safeTrim(
    text
      .replace(UK_POSTCODE_PATTERN, "")
      .replace(/,\s*,+/g, ", ")
      .replace(/[,\s]+$/, "")
  );
  if (!withoutPostcode) return "";

  const withoutLeadingNumber = safeTrim(
    withoutPostcode.replace(/^\d{1,5}[A-Za-z]?\s+/, "").replace(/[,\s]+$/, "")
  );
  return withoutLeadingNumber || withoutPostcode;
}

function buildGeocodeCandidates(address) {
  const exact = cleanAddressForGeocoding(address);
  const searchableExact = /^SEN$/i.test(exact) ? "London Southend Airport, UK" : exact;
  const postcode = extractPostcode(exact);
  const simplified = simplifyAddress(searchableExact);
  const seen = new Set();
  const candidates = [];

  for (const candidate of [
    { attemptType: "exact", query: searchableExact },
    { attemptType: "postcode", query: postcode },
    { attemptType: "simplified", query: simplified }
  ]) {
    const query = safeTrim(candidate.query);
    if (!query) continue;

    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      attemptType: candidate.attemptType,
      query
    });
  }

  return candidates;
}

function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function isRetryableGeocodeError(error) {
  return defaultShouldRetry(error);
}

async function geocodeWithNominatim({
  originalAddress,
  cleanedAddress,
  attemptType,
  logger,
  httpClient,
  baseUrl,
  userAgent,
  timeoutMs
}) {
  try {
    const requestParams = {
      q: cleanedAddress,
      format: "jsonv2",
      limit: 5,
      addressdetails: 1,
      countrycodes: "gb",
      bounded: 1,
      viewbox: UK_VIEWBOX
    };

    logger.debug("Geocoding request prepared", {
      stage: "geocoding",
      reason: `nominatim query ${attemptType || "exact"}`,
      originalAddressPreview: addressPreview(originalAddress),
      cleanedAddressPreview: addressPreview(cleanedAddress),
      cleanedAddressExact: cleanedAddress,
      requestParams,
      baseUrl,
      userAgent,
      timeoutMs,
      addressFingerprint: addressFingerprint(cleanedAddress)
    });

    const response = await executeWithRetry(
      async () =>
        httpClient.get(baseUrl, {
          params: requestParams,
          headers: {
            "User-Agent": userAgent,
            Accept: "application/json"
          },
          timeout: timeoutMs
        }),
      {
        maxAttempts: 3,
        initialDelayMs: 250,
        maxDelayMs: 2000,
        shouldRetry: isRetryableGeocodeError,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          const summary = summarizeKnownError(error, {
            provider: "nominatim",
            stage: "geocoding",
            defaultSummary: "Geocoding request failed, retrying",
            fallbackUsed: true
          });

          logger.warn(summary.summary, {
            stage: "geocoding",
            fallbackUsed: true,
            attempt,
            maxAttempts,
            delayMs,
            status: summary.status,
            code: summary.code,
            reason: summary.likelyCause || "Temporary geocoding service issue",
            addressFingerprint: addressFingerprint(cleanedAddress),
            error
          });
        }
      }
    );

    const first = Array.isArray(response.data)
      ? response.data.find((entry) => {
          const lat = Number(entry?.lat);
          const lng = Number(entry?.lon);
          return entry?.address?.country_code?.toLowerCase() === "gb" && isWithinUkBounds(lat, lng);
        })
      : null;
    if (!first) {
      const summary = summarizeKnownError(null, {
        stage: "geocoding",
        defaultSummary: "Geocoding failed: no match found for address",
        noResults: true,
        fallbackUsed: true
      });

      logger.warn(summary.summary, {
        stage: "geocoding",
        reason: `${attemptType || "exact"} api_empty_array q="${addressPreview(cleanedAddress, 90)}"`,
        fallbackUsed: true,
        originalAddress,
        cleanedAddress,
        requestParams,
        baseUrl,
        addressFingerprint: addressFingerprint(cleanedAddress)
      });
      return null;
    }

    const lat = Number(first.lat);
    const lng = Number(first.lon);

    if (!isValidLatLng(lat, lng)) {
      logger.warn("Geocoding failed: invalid coordinates returned", {
        stage: "geocoding",
        reason: "invalid_coordinates",
        fallbackUsed: true,
        addressFingerprint: addressFingerprint(cleanedAddress)
      });
      return null;
    }

    const formattedAddress = safeTrim(first.display_name || cleanedAddress);

    logger.debug("Geocoding completed", {
      stage: "geocoding",
      addressFingerprint: addressFingerprint(cleanedAddress)
    });

    return {
      lat,
      lng,
      formatted_address: formattedAddress
    };
  } catch (error) {
    const summary = summarizeKnownError(error, {
      stage: "geocoding",
      defaultSummary: "Geocoding failed for address",
      fallbackUsed: true
    });

    logger.warn(summary.summary, {
      stage: "geocoding",
      addressFingerprint: addressFingerprint(cleanedAddress),
      status: summary.status,
      code: summary.code,
      fallbackUsed: true,
      originalAddress,
      cleanedAddress,
      requestParams: {
        q: cleanedAddress,
        format: "jsonv2",
        limit: 1
      },
      baseUrl,
      reason: `request_failed q="${addressPreview(cleanedAddress, 90)}"`,
      error
    });
    return null;
  }
}

const PROVIDERS = {
  nominatim: geocodeWithNominatim
};

function createGeocoder(options = {}) {
  const provider = safeTrim(options.provider ?? env.geocodingProvider ?? "").toLowerCase();
  const apiKey = safeTrim(options.apiKey ?? env.geocodingApiKey ?? "");
  const baseUrl =
    safeTrim(options.baseUrl ?? env.geocodingBaseUrl ?? "") || NOMINATIM_BASE_URL;
  const userAgent =
    safeTrim(options.userAgent ?? env.geocodingUserAgent ?? "") || DEFAULT_USER_AGENT;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : env.geocodingTimeoutMs || DEFAULT_TIMEOUT_MS;
  const logger =
    options.logger ||
    createLogger(env.logLevel || "info", {
      mode: env.logMode,
      baseMeta: { component: "geocode" }
    });
  const httpClient = options.httpClient || axios;

  async function geocodeAddress(address) {
    try {
      const originalAddress = String(address || "");
      const candidates = buildGeocodeCandidates(originalAddress);
      if (candidates.length === 0) {
        logger.warn("Geocoding failed: address is empty", {
          stage: "geocoding",
          reason: "address_empty",
          fallbackUsed: true
        });
        return null;
      }

      if (!provider) {
        logger.warn("Geocoding skipped: provider not configured", {
          stage: "geocoding",
          fallbackUsed: true
        });
        return null;
      }

      const knownAirport = findKnownUkAirport(originalAddress);
      if (knownAirport) return knownAirport;

      const postcodeResult = await resolveUkPostcode(originalAddress, {
        httpClient,
        timeoutMs,
        logger
      });
      if (postcodeResult) return postcodeResult;

      const providerHandler = PROVIDERS[provider];
      if (!providerHandler) {
        logger.warn("Geocoding skipped: unsupported provider", {
          stage: "geocoding",
          reason: provider,
          fallbackUsed: true
        });
        return null;
      }

      for (const candidate of candidates) {
        logger.debug("Geocode retry attempt", {
          stage: "geocoding",
          fallbackUsed: candidate.attemptType !== "exact",
          reason: candidate.attemptType,
          query: candidate.query
        });

        const result = await providerHandler({
          originalAddress,
          cleanedAddress: candidate.query,
          attemptType: candidate.attemptType,
          apiKey,
          baseUrl,
          userAgent,
          timeoutMs,
          logger,
          httpClient
        });

        if (result) {
          return result;
        }
      }

      return null;
    } catch (error) {
      const summary = summarizeKnownError(error, {
        stage: "geocoding",
        defaultSummary: "Geocoding failed",
        fallbackUsed: true
      });

      logger.warn(summary.summary, {
        stage: "geocoding",
        reason: summary.likelyCause || provider || "Unexpected error",
        fallbackUsed: true,
        status: summary.status,
        code: summary.code,
        error
      });
      return null;
    }
  }

  return {
    geocodeAddress,
    // Backward-compatible alias used by earlier scaffold code.
    geocode: geocodeAddress
  };
}

const defaultGeocoder = createGeocoder();

async function geocodeAddress(address) {
  return defaultGeocoder.geocodeAddress(address);
}

module.exports = {
  geocodeAddress,
  createGeocoder,
  cleanAddressForGeocoding,
  buildGeocodeCandidates,
  extractOutcode,
  isWithinUkBounds,
  findKnownUkAirport
};

