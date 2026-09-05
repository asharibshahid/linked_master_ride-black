const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSubmitPayload,
  createOtsWorkerSubmitter,
  parseSubmitterOutput
} = require("../../src/bids/otsSubmitter");

test("buildSubmitPayload maps bid record to external submitter contract", () => {
  const payload = buildSubmitPayload({
    rideId: "RID-1",
    source: "OTS",
    pickup: "Heathrow",
    dropOff: "Chelsea",
    fare: "120",
    requiredVehicle: "MPV"
  });

  assert.deepEqual(payload, {
    rideId: "RID-1",
    source: "OTS",
    pickup: "Heathrow",
    dropOff: "Chelsea",
    fare: "120",
    requiredVehicle: "MPV",
    bidType: "",
    bidAmount: "120"
  });
});

test("parseSubmitterOutput reads the last JSON summary line", () => {
  const result = parseSubmitterOutput(
    [
      "opening portal",
      JSON.stringify({
        success: true,
        bidAmount: "110",
        providerReference: "OTS-OK"
      })
    ].join("\n")
  );

  assert.equal(result.success, true);
  assert.equal(result.bidAmount, "110");
  assert.equal(result.providerReference, "OTS-OK");
});

test("createOtsWorkerSubmitter executes configured script and parses success", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "submitter-test-"));
  const scriptPath = path.join(tempDir, "submit.js");
  fs.writeFileSync(
    scriptPath,
    [
      "const fs = require('node:fs');",
      "const input = process.argv[process.argv.indexOf('--input') + 1];",
      "const payload = JSON.parse(fs.readFileSync(input, 'utf8'));",
      "console.log(JSON.stringify({ success: true, bidAmount: payload.bidAmount, providerReference: payload.rideId }));"
    ].join("\n"),
    "utf8"
  );

  try {
    const submitter = createOtsWorkerSubmitter({
      scriptPath,
      projectPath: tempDir,
      timeoutMs: 10000
    });
    const result = await submitter({
      rideId: "RID-1",
      fare: "120"
    });

    assert.equal(result.success, true);
    assert.equal(result.bidAmount, "120");
    assert.equal(result.providerReference, "RID-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createOtsWorkerSubmitter fails clearly when script is missing", async () => {
  const submitter = createOtsWorkerSubmitter({
    scriptPath: path.join(os.tmpdir(), "missing-submit-bid.js")
  });

  await assert.rejects(() => submitter({ rideId: "RID-1" }), /not found/);
});
