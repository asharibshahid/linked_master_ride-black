const path = require("node:path");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

function safeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getDatabaseUrl(env = process.env) {
  return safeString(env.DATABASE_URL || env.SUPABASE_DATABASE_URL || env.POSTGRES_URL);
}

function getPgClientConfig(env = process.env) {
  const connectionString = getDatabaseUrl(env);
  if (!connectionString || connectionString.includes("YOUR_PASSWORD") || connectionString.includes("YOUR_POOLER_HOST")) {
    const error = new Error(
      "DATABASE_URL is missing or still contains Supabase placeholders. Add the full Supabase connection string first."
    );
    error.code = "DATABASE_URL_MISSING";
    throw error;
  }

  const sslDisabled = safeString(env.DATABASE_SSL).toLowerCase() === "false";
  return {
    connectionString,
    ssl: sslDisabled ? false : { rejectUnauthorized: false }
  };
}

function createClient(env = process.env) {
  // Lazy require keeps app startup independent from DB tooling.
  // eslint-disable-next-line global-require
  const { Client } = require("pg");
  return new Client(getPgClientConfig(env));
}

module.exports = {
  createClient,
  getDatabaseUrl,
  getPgClientConfig
};
