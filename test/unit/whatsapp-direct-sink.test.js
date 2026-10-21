const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWhatsAppDirectSink } = require("../../src/whatsapp/directSink");

function tempQueue() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-direct-")), "queue.json");
}

const ride = {
  refer: "WA-123",
  pickup: "Heathrow",
  drop_off: "Birmingham",
  fare: "120",
  required_vehicle: "Saloon"
};

test("direct sink delivers a normalized ride with authenticated request", async () => {
  const requests = [];
  const sink = createWhatsAppDirectSink({
    endpoint: "http://127.0.0.1/internal",
    token: "test-token",
    queuePath: tempQueue(),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 202, async json() { return { ok: true }; } };
    }
  });
  const result = await sink.submit(ride);
  assert.equal(result.ok, true);
  assert.equal(result.pending, 0);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body).ride.refer, "WA-123");
  assert.equal(requests[0].options.headers["X-Dashboard-Token"], "test-token");
});

test("direct sink persists failures and retries without duplicating a ride", async () => {
  const queuePath = tempQueue();
  let fail = true;
  const sink = createWhatsAppDirectSink({
    endpoint: "http://127.0.0.1/internal",
    token: "test-token",
    queuePath,
    fetch: async () => {
      if (fail) throw new Error("offline");
      return { ok: true, status: 202, async json() { return { ok: true }; } };
    }
  });
  await sink.submit(ride);
  await sink.submit({ ...ride, fare: "125" });
  assert.equal(sink.pending(), 1);
  assert.equal(JSON.parse(fs.readFileSync(queuePath, "utf8")).jobs.length, 1);
  fail = false;
  const result = await sink.drain();
  assert.deepEqual(result, { delivered: 1, pending: 0 });
});
