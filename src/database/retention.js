const { createDatabaseClient } = require("./client");
const { safeString } = require("../config/env");

async function runDatabaseRetentionOnce(options = {}) {
  const databaseUrl = safeString(options.databaseUrl);
  const client = createDatabaseClient({
    databaseUrl,
    ssl: options.ssl
  });

  try {
    await client.connect();
    const result = await client.query("select * from archive_expired_dispatch_data(now())");
    return {
      ok: true,
      retention: result.rows || []
    };
  } finally {
    await client.end();
  }
}

function startDatabaseRetentionPolling(options = {}) {
  const logger = options.logger || console;
  const intervalMs = Math.max(60 * 1000, Number(options.intervalMs) || 24 * 60 * 60 * 1000);
  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return null;
    running = true;
    try {
      const summary = await runDatabaseRetentionOnce(options);
      const affected = summary.retention.reduce((total, row) => total + Number(row.affected || 0), 0);
      if (affected > 0) {
        logger.info("Database retention cleanup completed", {
          stage: "database_retention",
          reason: `affected=${affected}`
        });
      }
      return summary;
    } catch (error) {
      logger.warn("Database retention cleanup failed", {
        stage: "database_retention",
        fallbackUsed: true,
        reason: safeString(error?.message || "database_retention_failed"),
        error
      });
      return {
        ok: false,
        reason: safeString(error?.message || "database_retention_failed")
      };
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  tick();

  logger.info("Database retention cleanup polling started", {
    stage: "database_retention",
    reason: `interval=${intervalMs}ms`
  });

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick
  };
}

module.exports = {
  runDatabaseRetentionOnce,
  startDatabaseRetentionPolling
};
