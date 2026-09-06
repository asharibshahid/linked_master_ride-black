const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { safeTrim } = require("../utils/text");

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function resolveNodeExecutable(value) {
  return safeTrim(value) || process.execPath;
}

function normalizeOtsReference(value) {
  return toCell(value).replace(/\s+/g, "").toUpperCase();
}

function buildV2WorkerArgs(scriptPath, bid = {}) {
  const reference = normalizeOtsReference(bid.sourceReference || bid.rideId);
  if (!reference || !reference.startsWith("OTS-")) {
    throw new Error("A valid OTS source reference is required before starting the bid worker");
  }
  const amount = toCell(bid.bidAmount || bid.fare);
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new Error("A finite positive bid amount is required before starting the bid worker");
  }
  return [path.resolve(scriptPath), "--reference", reference, "--amount", amount];
}

function buildSubmitPayload(bid = {}) {
  return {
    rideId: toCell(bid.rideId),
    sourceReference: toCell(bid.sourceReference || bid.rideId),
    source: toCell(bid.source),
    pickup: toCell(bid.pickup),
    dropOff: toCell(bid.dropOff),
    fare: toCell(bid.fare),
    requiredVehicle: toCell(bid.requiredVehicle),
    bidType: toCell(bid.bidType),
    bidAmount: toCell(bid.bidAmount || bid.fare)
  };
}

function parseSubmitterOutput(text) {
  const lines = String(text || "").trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      return {
        state: toCell(parsed.state || (parsed.success ? "confirmed" : "failed")).toLowerCase(),
        success: Boolean(parsed.success || (parsed.ok && parsed.state === "confirmed")),
        bidAmount: toCell(parsed.bidAmount || parsed.amount),
        providerReference: toCell(parsed.providerReference || parsed.reference),
        reason: toCell(parsed.reason || parsed.message)
      };
    } catch {
      // Continue looking for a JSON summary line.
    }
  }

  return {
    state: "failed",
    success: false,
    reason: safeTrim(text) || "OTS submitter returned no JSON result"
  };
}

function createTempPayloadFile(payload) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ots-bid-"));
  const filePath = path.join(directory, "bid.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return {
    filePath,
    cleanup() {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best effort cleanup only.
      }
    }
  };
}

function createOtsWorkerSubmitter(options = {}) {
  const scriptPath = safeTrim(options.scriptPath);
  const projectPath = safeTrim(options.projectPath);
  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 120000;
  const nodeExecutable = resolveNodeExecutable(options.nodeExecutable);

  return async function submitBidToOtsWorker(bid = {}) {
    if (!scriptPath) {
      throw new Error("OTS bid submit script is not configured");
    }
    const resolvedScriptPath = path.resolve(scriptPath);
    if (!fs.existsSync(resolvedScriptPath)) {
      throw new Error(`OTS bid submit script not found: ${resolvedScriptPath}`);
    }

    const payload = buildSubmitPayload(bid);
    const isV2 = path.basename(resolvedScriptPath).toLowerCase() === "submit_bid_v2.js";
    const payloadFile = isV2 ? null : createTempPayloadFile(payload);
    try {
      return await new Promise((resolve, reject) => {
        const args = isV2
          ? buildV2WorkerArgs(resolvedScriptPath, payload)
          : [resolvedScriptPath, "--input", payloadFile.filePath];
        const child = (options.spawn || spawn)(nodeExecutable, args, {
          cwd: projectPath ? path.resolve(projectPath) : path.dirname(resolvedScriptPath),
          env: { ...process.env, ...(options.env || {}) },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`OTS bid submitter timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          const result = parseSubmitterOutput(stdout);
          if (code === 0) {
            resolve(result);
            return;
          }
          reject(
            new Error(
              result.reason ||
                safeTrim(stderr) ||
                `OTS bid submitter exited with code ${Number(code || 0)}`
            )
          );
        });
      });
    } finally {
      if (payloadFile) payloadFile.cleanup();
    }
  };
}

module.exports = {
  buildSubmitPayload,
  buildV2WorkerArgs,
  normalizeOtsReference,
  parseSubmitterOutput,
  createOtsWorkerSubmitter
};
