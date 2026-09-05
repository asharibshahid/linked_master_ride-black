const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DRIVER_HEADERS,
  VEHICLE_HEADERS,
  formatDriverId,
  normalizeDriverRecord,
  normalizeVehicleRecord,
  isDriverAvailable,
  resolveNextDriverId,
  loadAvailableDrivers
} = require("../../src/drivers/management");

test("driver and vehicle headers match management sheet schemas", () => {
  assert.deepEqual(DRIVER_HEADERS, [
    "Driver ID",
    "Driver Name",
    "WhatsApp Number",
    "Status",
    "Current Location",
    "Working Hours",
    "Vehicle ID"
  ]);
  assert.deepEqual(VEHICLE_HEADERS, [
    "Vehicle ID",
    "Vehicle Type",
    "Seats",
    "Registration",
    "Driver ID",
    "Status"
  ]);
});

test("formatDriverId uses three-digit numeric IDs", () => {
  assert.equal(formatDriverId(1), "001");
  assert.equal(formatDriverId("2"), "002");
  assert.equal(formatDriverId("003"), "003");
  assert.equal(formatDriverId("DR-A"), "DR-A");
});

test("driver and vehicle records normalize sheet-style rows", () => {
  assert.deepEqual(
    normalizeDriverRecord({
      "Driver ID": "1",
      "Driver Name": "Ali",
      "WhatsApp Number": "+447700900123",
      Status: "Available",
      "Current Location": "Heathrow",
      "Working Hours": "Any",
      "Vehicle ID": "V-01"
    }),
    {
      driver_id: "001",
      driver_name: "Ali",
      whatsapp_number: "+447700900123",
      current_status: "Available",
      location: "Heathrow",
      working_hours: "Any",
      vehicle_id: "V-01"
    }
  );

  assert.deepEqual(
    normalizeVehicleRecord({
      "Vehicle ID": "V-01",
      "Vehicle Type": "Saloon",
      Seats: "4",
      Registration: "AB12 CDE",
      "Driver ID": "2",
      Status: "Available"
    }),
    {
      vehicle_id: "V-01",
      vehicle_type: "Saloon",
      seats: "4",
      registration: "AB12 CDE",
      driver_id: "002",
      status: "Available"
    }
  );
});

test("available driver filtering and next ID resolution use Drivers rows", async () => {
  const sheetsClient = {
    spreadsheets: {
      values: {
        get: async ({ range }) => {
          if (String(range).includes("!1:1")) {
            return {
              data: {
                values: [DRIVER_HEADERS]
              }
            };
          }

          return {
            data: {
              values: [
                DRIVER_HEADERS,
                ["001", "Ali", "+447700900123", "Available", "Heathrow", "Any", "V-01"],
                ["002", "Sara", "+447700900456", "Busy", "Gatwick", "Any", "V-02"],
                ["003", "Omar", "+447700900789", "available", "Luton", "Any", "V-03"]
              ]
            }
          };
        }
      }
    }
  };

  const availableDrivers = await loadAvailableDrivers({
    sheetsClient,
    spreadsheetId: "sheet-id",
    worksheetName: "Drivers",
    logger: { warn: () => {} }
  });

  assert.equal(availableDrivers.length, 2);
  assert.deepEqual(
    availableDrivers.map((driver) => driver.driver_id),
    ["001", "003"]
  );
  assert.equal(isDriverAvailable({ current_status: "Busy" }), false);
  assert.equal(resolveNextDriverId(availableDrivers), "004");
});
