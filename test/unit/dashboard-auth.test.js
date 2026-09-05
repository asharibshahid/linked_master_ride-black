const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isDashboardAuthEnabled,
  readDashboardActorFromRequest,
  readDashboardTokenFromRequest,
  timingSafeTokenEqual,
  verifyDashboardRequest
} = require("../../src/dashboard/auth");

test("dashboard auth is disabled when no token is configured", () => {
  assert.equal(isDashboardAuthEnabled({ token: "" }), false);

  const result = verifyDashboardRequest(
    { headers: { "x-dashboard-actor": "Operator A" } },
    { token: "" }
  );

  assert.equal(result.ok, true);
  assert.equal(result.authRequired, false);
  assert.equal(result.actor, "Operator A");
});

test("dashboard auth fails closed when production requires a token", () => {
  assert.deepEqual(
    verifyDashboardRequest({ headers: {} }, { token: "", requireToken: true }),
    {
      ok: false,
      authRequired: true,
      actor: "",
      reason: "dashboard_token_not_configured"
    }
  );
});

test("dashboard auth accepts header and bearer tokens", () => {
  assert.equal(readDashboardTokenFromRequest({ headers: { "x-dashboard-token": "abc" } }), "abc");
  assert.equal(
    readDashboardTokenFromRequest({ headers: { authorization: "Bearer secret-token" } }),
    "secret-token"
  );
  assert.equal(timingSafeTokenEqual("secret-token", "secret-token"), true);
  assert.equal(timingSafeTokenEqual("secret-token", "wrong"), false);
});

test("verifyDashboardRequest rejects missing or wrong tokens", () => {
  assert.deepEqual(
    verifyDashboardRequest({ headers: {} }, { token: "secret" }),
    {
      ok: false,
      authRequired: true,
      actor: "",
      reason: "invalid_dashboard_token"
    }
  );

  const result = verifyDashboardRequest(
    {
      headers: {
        "x-dashboard-token": "secret",
        "x-dashboard-actor": "Dispatcher 1"
      }
    },
    { token: "secret" }
  );

  assert.equal(result.ok, true);
  assert.equal(result.authRequired, true);
  assert.equal(result.actor, "Dispatcher 1");
});

test("readDashboardActorFromRequest applies safe fallback and length limit", () => {
  assert.equal(readDashboardActorFromRequest({ headers: {} }, "Default Operator"), "Default Operator");
  assert.equal(
    readDashboardActorFromRequest({ headers: { "x-dashboard-actor": "A".repeat(100) } }).length,
    80
  );
});
