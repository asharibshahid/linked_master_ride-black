const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanAddressForGeocoding,
  createGeocoder,
  buildGeocodeCandidates,
  extractOutcode,
  isWithinUkBounds
} = require("../../src/routing/geocode");
const { createSilentLogger } = require("../helpers");

test("cleanAddressForGeocoding removes bullets and pickup/drop labels", () => {
  const raw = "â€¢ Pick Up:   Heathrow Airport,\n   Terminal 4   ";
  const cleaned = cleanAddressForGeocoding(raw);
  assert.equal(cleaned, "Heathrow Airport, Terminal 4");
});
test("cleanAddressForGeocoding does not merge pickup and drop blocks", () => {
  const raw =
    "• Pick Up: Heathrow Airport, Terminal 4\n• Drop Off: 12, Woodlands Close, Dibden Purlieu, Southampton";
  const cleaned = cleanAddressForGeocoding(raw);
  assert.equal(cleaned, "Heathrow Airport, Terminal 4");
});

test("geocoder sends Nominatim jsonv2 contract with cleaned q value", async () => {
  const calls = [];
  const httpClient = {
    get: async (url, config) => {
      calls.push({ url, config });
      return {
        data: [
          {
            lat: "51.469",
            lon: "-0.4543",
            display_name: "Buckingham Palace, London, United Kingdom",
            address: { country_code: "gb" }
          }
        ]
      };
    }
  };

  const geocoder = createGeocoder({
    provider: "nominatim",
    baseUrl: "https://nominatim.openstreetmap.org/search",
    userAgent: "ride-bot-test/1.0",
    timeoutMs: 4321,
    httpClient,
    logger: createSilentLogger()
  });

  const result = await geocoder.geocodeAddress("â€¢ Pick-up: Buckingham Palace, London");
  assert.ok(result);
  assert.equal(result.lat, 51.469);
  assert.equal(result.lng, -0.4543);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.params.q, "Buckingham Palace, London");
  assert.equal(calls[0].config.params.format, "jsonv2");
  assert.equal(calls[0].config.params.limit, 5);
  assert.equal(calls[0].config.params.countrycodes, "gb");
  assert.equal(calls[0].config.params.bounded, 1);
  assert.equal(calls[0].config.params.addressdetails, 1);
  assert.equal(calls[0].config.headers["User-Agent"], "ride-bot-test/1.0");
  assert.equal(calls[0].config.timeout, 4321);
});

test("geocoder returns null when provider returns no results", async () => {
  const geocoder = createGeocoder({
    provider: "nominatim",
    httpClient: {
      get: async () => ({ data: [] })
    },
    logger: createSilentLogger()
  });

  const result = await geocoder.geocodeAddress("Drop Off: Unknown place");
  assert.equal(result, null);
});

test("buildGeocodeCandidates includes exact, postcode, and simplified fallbacks in order", () => {
  const candidates = buildGeocodeCandidates(
    "10 Oakland Villas, Hay-on-Wye, Hereford, HR3 5PH"
  );

  assert.deepEqual(candidates, [
    {
      attemptType: "exact",
      query: "10 Oakland Villas, Hay-on-Wye, Hereford, HR3 5PH"
    },
    {
      attemptType: "postcode",
      query: "HR3 5PH"
    },
    {
      attemptType: "simplified",
      query: "Oakland Villas, Hay-on-Wye, Hereford"
    }
  ]);
});

test("geocoder retries postcode and simplified address after exact match misses", async () => {
  const calls = [];
  const geocoder = createGeocoder({
    provider: "nominatim",
    httpClient: {
      get: async (_url, config) => {
        if (!config.params) return { data: { status: 404, result: null } };
        const query = config.params.q;
        calls.push(query);

        if (query === "Oakland Villas, Hay-on-Wye, Hereford") {
          return {
            data: [
              {
                lat: "52.0808",
                lon: "-3.1279",
                display_name: "Oakland Villas, Hay-on-Wye, Hereford",
                address: { country_code: "gb" }
              }
            ]
          };
        }

        return { data: [] };
      }
    },
    logger: createSilentLogger()
  });

  const result = await geocoder.geocodeAddress(
    "10 Oakland Villas, Hay-on-Wye, Hereford, HR3 5PH"
  );

  assert.ok(result);
  assert.equal(result.lat, 52.0808);
  assert.equal(result.lng, -3.1279);
  assert.deepEqual(calls, [
    "10 Oakland Villas, Hay-on-Wye, Hereford, HR3 5PH",
    "HR3 5PH",
    "Oakland Villas, Hay-on-Wye, Hereford"
  ]);
});

test("geocoder resolves known UK airport aliases without a global lookup", async () => {
  let calls = 0;
  const geocoder = createGeocoder({
    provider: "nominatim",
    httpClient: { get: async () => { calls += 1; return { data: [] }; } },
    logger: createSilentLogger()
  });

  const result = await geocoder.geocodeAddress("LHR T5");
  assert.deepEqual(result, {
    lat: 51.47,
    lng: -0.4543,
    formatted_address: "Heathrow Airport, UK"
  });
  assert.equal(calls, 0);
});

test("geocoder resolves full and outward UK postcodes through postcodes.io", async () => {
  const urls = [];
  const geocoder = createGeocoder({
    provider: "nominatim",
    httpClient: {
      get: async (url) => {
        urls.push(url);
        return { data: { result: { latitude: 52.24, longitude: 0.15, admin_district: "Cambridge" } } };
      }
    },
    logger: createSilentLogger()
  });

  assert.ok(await geocoder.geocodeAddress("CB5"));
  assert.match(urls[0], /\/outcodes\/CB5$/);
  assert.equal(extractOutcode("Oxford OX2"), "OX2");
});

test("geocoder rejects non-GB and out-of-bounds provider results", async () => {
  const geocoder = createGeocoder({
    provider: "nominatim",
    httpClient: {
      get: async () => ({
        data: [{ lat: "40.7", lon: "-74", display_name: "New York", address: { country_code: "us" } }]
      })
    },
    logger: createSilentLogger()
  });

  assert.equal(await geocoder.geocodeAddress("Similar place name"), null);
  assert.equal(isWithinUkBounds(51.5, -0.1), true);
  assert.equal(isWithinUkBounds(40.7, -74), false);
});

