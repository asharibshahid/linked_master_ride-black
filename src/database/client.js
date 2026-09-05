const { Client } = require("pg");
const { safeString } = require("../config/env");

function getDatabaseUrl(env = process.env) {
  return safeString(env.DATABASE_URL || env.SUPABASE_DATABASE_URL || env.POSTGRES_URL);
}

function isPlaceholderDatabaseUrl(value) {
  const url = safeString(value).toLowerCase();
  return !url || url.includes("your_password") || url.includes("your-password") || url.includes("your_pooler_host");
}

function createDatabaseClient({ databaseUrl, ssl = true } = {}) {
  if (isPlaceholderDatabaseUrl(databaseUrl)) {
    const error = new Error("DATABASE_URL is missing or contains placeholders");
    error.code = "DATABASE_URL_MISSING";
    throw error;
  }

  return new Client({
    connectionString: databaseUrl,
    ssl: ssl === false ? false : { rejectUnauthorized: false }
  });
}

async function checkDatabaseConnection(options = {}) {
  const databaseUrl = safeString(options.databaseUrl || getDatabaseUrl());
  if (isPlaceholderDatabaseUrl(databaseUrl)) {
    return {
      ok: false,
      configured: false,
      reason: "DATABASE_URL missing"
    };
  }

  const client = createDatabaseClient({
    databaseUrl,
    ssl: options.ssl
  });

  try {
    await client.connect();
    const result = await client.query("select now() as now");
    return {
      ok: true,
      configured: true,
      checkedAt: result.rows?.[0]?.now ? new Date(result.rows[0].now).toISOString() : new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      reason: safeString(error?.message || "database connection failed")
    };
  } finally {
    try {
      await client.end();
    } catch (error) {
      // Ignore close errors from failed connection attempts.
    }
  }
}

module.exports = {
  checkDatabaseConnection,
  createDatabaseClient,
  getDatabaseUrl,
  isPlaceholderDatabaseUrl
};
