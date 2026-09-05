const test = require("node:test");
const assert = require("node:assert/strict");
const { DispatchDatabaseRepository } = require("../../src/database/repository");

test("completeRideSchedules closes database schedules and restores driver and vehicle availability", async () => {
  const calls = [];
  const repository = new DispatchDatabaseRepository({ databaseUrl: "postgresql://test" });
  repository.withClient = async (fn) =>
    fn({
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes("update driver_schedule")) {
          return { rows: [{ driver_id: "D-001", drop_off: "Chelsea", current_location: "Heathrow" }] };
        }
        if (sql.includes("update vehicle_schedule")) return { rows: [{ vehicle_id: "V-001", driver_id: "D-001" }] };
        return { rows: [] };
      }
    });

  const result = await repository.completeRideSchedules({ rideId: "RID-001" });

  assert.deepEqual(result, {
    ok: true,
    rideId: "RID-001",
    driverId: "D-001",
    vehicleId: "V-001",
    currentLocation: "Chelsea"
  });
  assert.ok(calls.some((call) => call.sql.includes("update rides") && call.values[0] === "RID-001"));
  assert.ok(calls.some((call) => call.sql.includes("update drivers") && call.values[0] === "D-001"));
  assert.ok(calls.some((call) => call.sql.includes("update vehicles") && call.values[0] === "V-001"));
});
