const crypto = require("node:crypto");
const { safeTrim } = require("../utils/text");

function normalizeToken(value) {
  return safeTrim(value);
}

function isDashboardAuthEnabled(config = {}) {
  return Boolean(normalizeToken(config.token || config.dashboardToken));
}

function timingSafeTokenEqual(left, right) {
  const leftToken = normalizeToken(left);
  const rightToken = normalizeToken(right);
  if (!leftToken || !rightToken) return false;

  const leftBuffer = Buffer.from(leftToken, "utf8");
  const rightBuffer = Buffer.from(rightToken, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readDashboardTokenFromRequest(request = {}) {
  const headerToken = safeTrim(
    request.headers?.["x-dashboard-token"] ||
      request.headers?.["X-Dashboard-Token"] ||
      request.get?.("x-dashboard-token")
  );
  if (headerToken) return headerToken;

  const authorization = safeTrim(
    request.headers?.authorization ||
      request.headers?.Authorization ||
      request.get?.("authorization")
  );
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeToken(match[1]) : "";
}

function readDashboardActorFromRequest(request = {}, fallback = "Dashboard") {
  const actor = safeTrim(
    request.headers?.["x-dashboard-actor"] ||
      request.headers?.["X-Dashboard-Actor"] ||
      request.get?.("x-dashboard-actor")
  );
  return actor.slice(0, 80) || safeTrim(fallback) || "Dashboard";
}

function verifyDashboardRequest(request = {}, config = {}) {
  const expectedToken = normalizeToken(config.token || config.dashboardToken);
  if (!expectedToken) {
    if (config.requireToken) {
      return {
        ok: false,
        authRequired: true,
        actor: "",
        reason: "dashboard_token_not_configured"
      };
    }
    return {
      ok: true,
      authRequired: false,
      actor: readDashboardActorFromRequest(request, config.defaultActor)
    };
  }

  const providedToken = readDashboardTokenFromRequest(request);
  const ok = timingSafeTokenEqual(providedToken, expectedToken);
  return {
    ok,
    authRequired: true,
    actor: ok ? readDashboardActorFromRequest(request, config.defaultActor) : "",
    reason: ok ? "" : "invalid_dashboard_token"
  };
}

module.exports = {
  normalizeToken,
  isDashboardAuthEnabled,
  readDashboardTokenFromRequest,
  readDashboardActorFromRequest,
  timingSafeTokenEqual,
  verifyDashboardRequest
};
