const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSubmitPayload,
  buildV2WorkerArgs,
  createOtsWorkerSubmitter,
  parseSubmitterOutput
} = require("../../src/bids/otsSubmitter");

test("V2 argv uses named reference and amount flags", () => {
  const args = buildV2WorkerArgs("scripts/submit_bid_v2.js", {
    sourceReference: " ots-06092026160817-258-1 ",
    bidAmount: 87.5
  });
  assert.deepEqual(args.slice(1), ["--reference", "OTS-06092026160817-258-1", "--amount", "87.5"]);
  assert.notEqual(args[1], "OTS-06092026160817-258-1");
});

test("V2 argv rejects missing, empty and malformed references before spawn", () => {
  for (const sourceReference of [undefined, "", "RID-123"] ) {
    assert.throws(() => buildV2WorkerArgs("scripts/submit_bid_v2.js", { sourceReference, rideId: sourceReference, bidAmount: 90 }), /valid OTS source reference/);
  }
});

test("V2 argv rejects invalid amounts", () => {
  for (const bidAmount of [undefined, "", 0, -1, "invalid"]) {
    assert.throws(() => buildV2WorkerArgs("scripts/submit_bid_v2.js", { sourceReference: "OTS-1", bidAmount }), /finite positive bid amount/);
  }
});

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
    sourceReference: "RID-1",
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

test("parseSubmitterOutput accepts the V2 confirmed result contract", () => {
  const result = parseSubmitterOutput(JSON.stringify({
    ok: true,
    state: "confirmed",
    reference: "OTS-1",
    amount: "110",
    reason: "price_and_submit_absent_for_3_seconds"
  }));
  assert.equal(result.success, true);
  assert.equal(result.state, "confirmed");
  assert.equal(result.providerReference, "OTS-1");
  assert.equal(result.bidAmount, "110");
});

test("parseSubmitterOutput preserves V2 unconfirmed state", () => {
  const result = parseSubmitterOutput(JSON.stringify({
    ok: false,
    state: "unconfirmed",
    reference: "OTS-1",
    amount: "110",
    reason: "bid_form_returned_during_stability_window"
  }));
  assert.equal(result.success, false);
  assert.equal(result.state, "unconfirmed");
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

test("createOtsWorkerSubmitter passes only reference and amount to V2", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "submitter-v2-test-"));
  const scriptPath = path.join(tempDir, "submit_bid_v2.js");
  fs.writeFileSync(scriptPath, [
    "const args = process.argv.slice(2);",
    "if (args.join(' ') !== '--reference OTS-1 --amount 110') process.exit(2);",
    "console.log(JSON.stringify({ ok: true, state: 'confirmed', reference: 'OTS-1', amount: '110' }));"
  ].join("\n"), "utf8");
  try {
    const submitter = createOtsWorkerSubmitter({ scriptPath, projectPath: tempDir, timeoutMs: 10000 });
    const result = await submitter({ rideId: "internal-1", sourceReference: "OTS-1", bidAmount: "110" });
    assert.equal(result.success, true);
    assert.equal(result.providerReference, "OTS-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("one V2 submission creates exactly one child with no old worker argv", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "submitter-v2-spawn-"));
  const scriptPath = path.join(tempDir, "submit_bid_v2.js");
  fs.writeFileSync(scriptPath, "// test worker", "utf8");
  const calls = [];
  const fakeSpawn = (_node, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({ ok: true, state: "confirmed", reference: "OTS-1", amount: "90" })));
      child.emit("exit", 0);
    });
    return child;
  };
  try {
    const submitter = createOtsWorkerSubmitter({ scriptPath, projectPath: tempDir, timeoutMs: 10000, spawn: fakeSpawn });
    await submitter({ sourceReference: "OTS-1", bidAmount: 90 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [path.resolve(scriptPath), "--reference", "OTS-1", "--amount", "90"]);
    assert.equal(calls[0].includes("--input"), false);
    assert.equal(calls[0].some((value) => /submit_bid\.js$/i.test(value)), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production default resolves to V2 worker", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/config/env.js"), "utf8");
  assert.match(source, /ride_Managment_Worker\/scripts\/submit_bid_v2\.js/);
});

test("createOtsWorkerSubmitter fails clearly when script is missing", async () => {
  const submitter = createOtsWorkerSubmitter({
    scriptPath: path.join(os.tmpdir(), "missing-submit-bid.js")
  });

  await assert.rejects(() => submitter({ rideId: "RID-1" }), /not found/);
});
