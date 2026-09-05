module.exports = (request, response) => {
  const apiBaseUrl = String(process.env.DASHBOARD_API_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");

  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({
    ok: Boolean(apiBaseUrl),
    apiBaseUrl,
    message: apiBaseUrl ? "" : "DASHBOARD_API_BASE_URL is not configured in Vercel."
  });
};
