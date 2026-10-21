const fs = require("node:fs");
const path = require("node:path");

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function rideReference(ride = {}) {
  return text(ride.refer || ride.Refer || ride.rideId || ride.ride_id);
}

function safeRidePayload(ride = {}) {
  return {
    refer: rideReference(ride),
    group_name: text(ride.group_name || ride["Group Name"]),
    source_name: text(ride.source_name || ride["Source Name"]),
    source_time: text(ride.source_time || ride["Source Time"]),
    pickup_day_date: text(ride.pickup_day_date || ride["Pickup Day & Date"]),
    starting_timing: text(ride.starting_timing || ride["Starting Timing"]),
    pickup: text(ride.pickup || ride.Pickup),
    drop_off: text(ride.drop_off || ride["Drop Off"]),
    distance: text(ride.distance || ride.Distance),
    fare: text(ride.fare || ride.Fare),
    required_vehicle: text(ride.required_vehicle || ride["Required Vehicle"]),
    payment_status: text(ride.payment_status || ride["Payment Status"]),
    source_metadata: { ingestion: "direct-whatsapp" }
  };
}

function createWhatsAppDirectSink(options = {}) {
  const endpoint = text(options.endpoint);
  const token = text(options.token);
  const queuePath = path.resolve(text(options.queuePath) || "data/whatsapp-direct-queue.json");
  const logger = options.logger || { info() {}, warn() {} };
  const request = options.fetch || global.fetch;
  const retryMs = Math.max(1000, Number(options.retryMs) || 60000);
  let queue = [];
  let activeDrain = null;
  let timer = null;

  function persist() {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    const temporaryPath = `${queuePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, jobs: queue }), "utf8");
    fs.renameSync(temporaryPath, queuePath);
  }

  function load() {
    try {
      if (!fs.existsSync(queuePath)) return;
      const parsed = JSON.parse(fs.readFileSync(queuePath, "utf8"));
      queue = Array.isArray(parsed?.jobs) ? parsed.jobs.filter((ride) => rideReference(ride)) : [];
    } catch (error) {
      logger.warn("WhatsApp direct queue could not be loaded", {
        stage: "whatsapp_direct_ingest",
        fallbackUsed: true,
        reason: error?.message || "queue_load_failed"
      });
      queue = [];
    }
  }

  async function send(ride) {
    if (!endpoint || !token || typeof request !== "function") {
      throw new Error("WhatsApp direct ingest endpoint is not configured");
    }
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dashboard-Token": token,
        "X-Dashboard-Actor": "WhatsApp Collector"
      },
      body: JSON.stringify({ ride }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Direct ingest returned HTTP ${response.status}`);
    return response.json();
  }

  function enqueue(ride) {
    const payload = safeRidePayload(ride);
    if (!payload.refer) throw new Error("WhatsApp direct ingest reference is missing");
    const index = queue.findIndex((item) => rideReference(item) === payload.refer);
    if (index >= 0) queue[index] = payload;
    else queue.push(payload);
    persist();
    return payload;
  }

  function drain() {
    if (activeDrain) return activeDrain;
    activeDrain = (async () => {
      let delivered = 0;
      for (const ride of [...queue]) {
        try {
          await send(ride);
          queue = queue.filter((item) => rideReference(item) !== rideReference(ride));
          persist();
          delivered += 1;
        } catch (error) {
          logger.warn("WhatsApp ride queued for direct-ingest retry", {
            stage: "whatsapp_direct_ingest",
            fallbackUsed: true,
            reason: error?.message || "direct_ingest_failed",
            refer: rideReference(ride)
          });
        }
      }
      if (delivered > 0) {
        logger.info("Queued WhatsApp rides delivered to dashboard database", {
          stage: "whatsapp_direct_ingest",
          fallbackUsed: false,
          reason: `delivered=${delivered} pending=${queue.length}`
        });
      }
      return { delivered, pending: queue.length };
    })().finally(() => { activeDrain = null; });
    return activeDrain;
  }

  async function submit(ride) {
    enqueue(ride);
    const result = await drain();
    return { ok: result.pending === 0, queued: result.pending > 0, ...result };
  }

  function start() {
    if (timer || !endpoint || !token) return;
    timer = setInterval(() => { drain().catch(() => {}); }, retryMs);
    if (typeof timer.unref === "function") timer.unref();
    setImmediate(() => { drain().catch(() => {}); });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  load();
  return { submit, drain, start, stop, pending: () => queue.length };
}

module.exports = { createWhatsAppDirectSink, safeRidePayload, rideReference };
