const path = require("node:path");
const {
  acknowledgeOtsDispatchImport,
  hasPendingDispatchImport,
  loadFormattedRows,
  mapOtsRowToRide,
  runOtsPipeline
} = require("../ots/integration");

async function syncOtsMaster(options = {}) {
  const projectPath = path.resolve(String(options.projectPath || ""));
  const formattedRowsPath = path.resolve(String(options.formattedRowsPath || ""));
  const pipeline = await runOtsPipeline(projectPath, {
    env: {
      DISPATCH_MANAGED_PIPELINE: "true",
      OTS_OPENAI_FORMATTING_ENABLED: "false",
      ...(options.pipelineEnv || {})
    }
  });
  if (pipeline.code !== 0) {
    throw new Error(pipeline.error?.message || `OTS pipeline failed: exit_code=${pipeline.code}`);
  }
  if (!hasPendingDispatchImport(projectPath)) {
    return { ok: true, seen: 0, imported: 0, pending: false };
  }

  const rows = loadFormattedRows(formattedRowsPath);
  const jobs = rows.map((row) => mapOtsRowToRide(row, {
    groupName: options.groupName || "OTS",
    sourceName: options.sourceName || "OTS Supplier Portal"
  }));
  const imported = await options.repository.syncSourceJobs(jobs, "OTS");
  const acknowledgement = await acknowledgeOtsDispatchImport(projectPath, formattedRowsPath);
  if (acknowledgement.code !== 0) {
    throw new Error(acknowledgement.error?.message || `OTS acknowledgement failed: exit_code=${acknowledgement.code}`);
  }
  return { ok: true, seen: rows.length, imported: imported.count, pending: true };
}

module.exports = { syncOtsMaster };
