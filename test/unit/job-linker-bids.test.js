const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  createJobLinkerBidService,
  normalizeBusinessReference,
  publicProviderFailure,
  validateBidAmount,
  validateManualBidRide
} = require("../../src/jobLinker/bids");
const { JobLinkerRepository, mapWorkspaceBid, submissionTiming } = require("../../src/jobLinker/repository");
const { registerJobLinkerRoutes } = require("../../src/jobLinker/routes");

function trustedReservation(overrides = {}) {
  return {
    bidId: "bid-1",
    bid: { bidId: "bid-1", rideId: "OTS-1", bidStatus: "Created", submissionState: "created" },
    trustedBid: {
      rideId: "OTS-1",
      sourceReference: "OTS-1",
      source: "OTS",
      pickup: "Heathrow",
      dropOff: "Chelsea",
      fare: "120",
      requiredVehicle: "MPV",
      bidType: "Job Linker Manual Bid",
      bidAmount: "110"
    },
    ...overrides
  };
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for asynchronous bid processing");
}

function serviceRepository(overrides = {}) {
  return {
    reserveManualBid: async () => trustedReservation(),
    markManualBidSubmitting: async () => ({ ok: true }),
    completeManualBid: async ({ success, message }) => ({
      bidId: "bid-1",
      rideId: "OTS-1",
      bidStatus: success ? "Submitted" : "Submission Failed",
      submissionState: success ? "submitted" : "failed",
      submissionResult: message
    }),
    ...overrides
  };
}

test("manual Job Linker bid returns a durable queued state before provider completion", async () => {
  const submitted = [];
  const completions = [];
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const repository = serviceRepository({
    completeManualBid: async (value) => {
      completions.push(value);
      return { bidId: "bid-1", rideId: "OTS-1", bidStatus: "Submitted", submissionState: "submitted" };
    }
  });
  const service = createJobLinkerBidService({
    repository,
    submitBid: async (bid) => {
      submitted.push(bid);
      await providerGate;
      return { success: true, bidAmount: "110", providerReference: "OTS-1" };
    },
    autoStart: false
  });

  const result = await service.submitManualBid({
    rideId: "OTS-1",
    bidAmount: 110,
    reason: "Operator decision",
    pickup: "Untrusted browser pickup"
  });

  assert.equal(result.ok, true);
  assert.equal(result.bid.bidStatus, "Created");
  assert.equal(completions.length, 0);
  await waitFor(() => submitted.length === 1);
  assert.equal(submitted[0].pickup, "Heathrow");
  assert.equal(submitted[0].sourceReference, "OTS-1");
  releaseProvider();
  await waitFor(() => completions.length === 1);
  assert.equal(completions[0].success, true);
  service.stop();
});

test("manual Job Linker bid persists submitter failure without claiming success", async () => {
  const completions = [];
  const repository = serviceRepository({
    completeManualBid: async (value) => {
      completions.push(value);
      return { bidId: "bid-1", rideId: "OTS-1", bidStatus: "Submission Failed", submissionState: "failed" };
    }
  });
  const service = createJobLinkerBidService({
    repository,
    submitBid: async () => { throw new Error("provider page unavailable"); },
    autoStart: false
  });

  const result = await service.submitManualBid({ rideId: "OTS-1", bidAmount: 110 });
  assert.equal(result.bid.bidStatus, "Created");
  await waitFor(() => completions.length === 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].success, false);
  assert.equal(completions[0].message, "provider page unavailable");
  service.stop();
});

test("manual Job Linker bid preserves an unconfirmed provider outcome", async () => {
  const completions = [];
  const repository = serviceRepository({
    completeManualBid: async (value) => { completions.push(value); return { bidStatus: "Submission Unconfirmed", submissionState: "unconfirmed" }; }
  });
  const service = createJobLinkerBidService({
    repository,
    submitBid: async () => ({ ok: false, state: "unconfirmed", reason: "bid form remained visible" }),
    autoStart: false
  });
  await service.submitManualBid({ rideId: "OTS-1", bidAmount: 110 });
  await waitFor(() => completions.length === 1);
  assert.equal(completions[0].success, false);
  assert.equal(completions[0].state, "unconfirmed");
  service.stop();
});

test("bid validation rejects invalid amount and non-actionable ride states", () => {
  assert.throws(() => validateBidAmount(0), (error) => error.code === "INVALID_BID_AMOUNT");
  assert.throws(() => validateBidAmount("not-money"), (error) => error.code === "INVALID_BID_AMOUNT");
  assert.throws(() => validateManualBidRide(null), (error) => error.code === "RIDE_NOT_FOUND");
  assert.throws(() => validateManualBidRide({ source_type: "WhatsApp" }), (error) => error.code === "NON_OTS_RIDE");
  assert.throws(() => validateManualBidRide({ source_type: "OTS", trashed_at: new Date() }), (error) => error.code === "RIDE_TRASHED");
  assert.throws(
    () => validateManualBidRide({ source_type: "OTS", pickup_at: "2026-09-01T10:00:00Z" }, new Date("2026-09-01T11:00:00Z")),
    (error) => error.code === "RIDE_EXPIRED"
  );
});

test("OTS business references normalize case and whitespace without changing punctuation", () => {
  assert.equal(normalizeBusinessReference("  ots-0509  -1 \n"), "OTS-0509-1");
});

test("provider failures preserve useful messages but hide server paths", () => {
  assert.equal(publicProviderFailure("provider page unavailable"), "provider page unavailable");
  assert.equal(
    publicProviderFailure("worker failed at /opt/private/submit.js"),
    "OTS provider submission failed. Check backend logs."
  );
});

async function withServer(authorize, bidService, run, workspaceService = null, repository = {}) {
  const app = express();
  app.use(express.json());
  registerJobLinkerRoutes(app, {
    authorize,
    getService: () => workspaceService || ({ snapshot: async () => ({ ok: true, bids: [] }) }),
    getBidService: () => bidService,
    repository
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("manual bid route requires dashboard authentication", async () => {
  await withServer((_request, response) => {
    response.status(401).json({ ok: false, message: "Dashboard token required" });
    return false;
  }, { submitManualBid: async () => ({ ok: true }) }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/job-linker/bids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rideId: "OTS-1", bidAmount: 110 })
    });
    assert.equal(response.status, 401);
  });
});

test("repository duplicate guard locks the ride and rejects a repeated persisted bid", async () => {
  const queries = [];
  const repository = new JobLinkerRepository();
  repository.withClient = async (run) => run({
    query: async (sql) => {
      const statement = String(sql);
      queries.push(statement);
      if (statement.includes("select * from rides")) {
        return {
          rowCount: 1,
          rows: [{
            ride_id: "OTS-DUP",
            source_type: "OTS",
            pickup_at: "2026-09-06T10:00:00.000Z",
            source_expires_at: "2026-09-06T09:00:00.000Z"
          }]
        };
      }
      if (statement.includes("select * from bids")) {
        return {
          rowCount: 1,
          rows: [{ bid_id: "bid-existing", ride_id: "OTS-DUP", bid_status: "Submitted" }]
        };
      }
      return { rowCount: 0, rows: [] };
    }
  });

  await assert.rejects(
    () => repository.reserveManualBid({
      rideId: "OTS-DUP",
      bidAmount: 90,
      now: new Date("2026-09-05T10:00:00.000Z")
    }),
    (error) => error.code === "DUPLICATE_BID" && error.statusCode === 409
  );
  const lockIndex = queries.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
  const existingIndex = queries.findIndex((sql) => sql.includes("select * from bids"));
  assert.ok(lockIndex >= 0 && lockIndex < existingIndex);
  assert.equal(queries.some((sql) => sql === "rollback"), true);
});

test("bid timing exposes queued, worker, provider activation and completion durations", () => {
  const submission = {
    createdAt: "2026-09-26T10:00:00.000Z",
    attemptedAt: "2026-09-26T10:00:00.400Z",
    submitActivatedAt: "2026-09-26T10:00:12.000Z",
    completedAt: "2026-09-26T10:00:16.500Z",
    workerTiming: { prepareMs: 11000, confirmationMs: 4500, totalMs: 16100 }
  };
  assert.deepEqual(submissionTiming(submission), {
    queuedAt: submission.createdAt,
    attemptedAt: submission.attemptedAt,
    submitActivatedAt: submission.submitActivatedAt,
    completedAt: submission.completedAt,
    queueDurationMs: 400,
    processingDurationMs: 16100,
    totalDurationMs: 16500,
    workerTiming: submission.workerTiming
  });
  const mapped = mapWorkspaceBid({
    bid_id: "bid-timing",
    ride_id: "OTS-TIMING",
    pricing_payload: { submission },
    created_at: submission.createdAt,
    updated_at: submission.completedAt
  });
  assert.equal(mapped.processingDurationMs, 16100);
  assert.equal(mapped.workerTiming.prepareMs, 11000);
});

test("persisted bid guide snapshot survives a missing or expired ride guide", () => {
  const mapped = mapWorkspaceBid({
    bid_id: "bid-guide",
    ride_id: "OTS-GUIDE",
    guide_price_min: null,
    guide_price_max: null,
    guide_price_text: "",
    pricing_payload: {
      guidePriceMin: 76,
      guidePriceMax: 89,
      guidePriceText: "As a guide, we are expecting prices between £76.00 and £89.00."
    }
  });
  assert.equal(mapped.guidePriceMin, 76);
  assert.equal(mapped.guidePriceMax, 89);
  assert.match(mapped.guidePriceText, /between £76\.00 and £89\.00/);
});

test("bid status transitions preserve the existing nested submission timeline", async () => {
  const queries = [];
  const repository = new JobLinkerRepository();
  repository.withClient = async (run) => run({
    query: async (sql, params = []) => {
      const statement = String(sql);
      queries.push({ sql: statement, params });
      if (statement.includes("bid_status = 'Submitting'")) return { rowCount: 1, rows: [] };
      if (statement.includes("where b.bid_id")) return { rowCount: 1, rows: [{ bid_id: "bid-1", bid_status: "Submitted", pricing_payload: {} }] };
      if (statement.includes("set bid_status = $2")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    }
  });
  await repository.markManualBidSubmitting("bid-1");
  await repository.completeManualBid({ bidId: "bid-1", success: true, timing: { totalMs: 18000 } });
  const transitions = queries.filter((entry) => /update bids/.test(entry.sql));
  assert.equal(transitions.length, 2);
  assert.ok(transitions.every((entry) => /jsonb_set/.test(entry.sql)));
  assert.ok(transitions.every((entry) => /pricing_payload->'submission'/.test(entry.sql)));
  assert.equal(JSON.parse(transitions[0].params[1]).state, "attempting");
  assert.equal(JSON.parse(transitions[1].params[3]).workerTiming.totalMs, 18000);
});

test("repository lets failed manual bid attempts be retried for an active OTS ride", async () => {
  let updateParams = null;
  const repository = new JobLinkerRepository();
  repository.withClient = async (run) => run({
    query: async (sql, params = []) => {
      const statement = String(sql);
      if (statement.includes("select * from rides")) {
        return {
          rowCount: 1,
          rows: [{
            ride_id: "OTS-RETRY",
            refer: "OTS-RETRY",
            source_type: "OTS",
            pickup_at: "2026-09-06T10:00:00.000Z",
            source_expires_at: "2026-09-06T09:00:00.000Z"
          }]
        };
      }
      if (statement.includes("select * from bids")) {
        return {
          rowCount: 1,
          rows: [{ bid_id: "bid-failed", ride_id: "OTS-RETRY", bid_status: "Submission Failed" }]
        };
      }
      if (statement.includes("update bids") && statement.includes("bid_status = 'Created'")) {
        updateParams = params;
        return { rowCount: 1, rows: [{ bid_id: "bid-failed", ride_id: "OTS-RETRY", bid_status: "Created" }] };
      }
      return { rowCount: 0, rows: [] };
    }
  });

  const result = await repository.reserveManualBid({
    rideId: "OTS-RETRY",
    bidAmount: 125,
    now: new Date("2026-09-05T10:00:00.000Z")
  });

  assert.equal(result.bidId, "bid-failed");
  assert.equal(result.trustedBid.sourceReference, "OTS-RETRY");
  assert.equal(updateParams[1], 125);
});

test("GET Job Linker includes persisted bids on initial load and refresh", async () => {
  const persisted = {
    bidId: "bid-persisted",
    rideId: "OTS-PERSISTED",
    bidAmount: 95,
    bidStatus: "Submitted",
    submissionState: "submitted"
  };
  let snapshots = 0;
  const workspaceService = {
    snapshot: async () => {
      snapshots += 1;
      return { ok: true, master: [], prebook: [], groups: [], links: [], trash: [], bids: [persisted] };
    }
  };
  await withServer(() => true, { submitManualBid: async () => ({ ok: true }) }, async (baseUrl) => {
    const first = await (await fetch(`${baseUrl}/api/job-linker`)).json();
    const refreshed = await (await fetch(`${baseUrl}/api/job-linker`)).json();
    assert.deepEqual(first.bids, [persisted]);
    assert.deepEqual(refreshed.bids, [persisted]);
    assert.equal(snapshots, 2);
  }, workspaceService);
});

test("bid outcome reconciliation confirms only exact PreBook references and never fabricates Lost", async () => {
  const queries = [];
  const repository = new JobLinkerRepository();
  repository.withClient = async (run) => run({
    query: async (sql) => {
      queries.push(String(sql));
      return { rowCount: 1, rows: [] };
    }
  });

  const result = await repository.reconcileConfirmedBids();
  assert.deepEqual(result, { ok: true, confirmed: 1, unconfirmed: 1 });
  assert.match(queries[0], /r\.source_type = 'PreBook'/);
  assert.match(queries[0], /r\.refer/);
  assert.match(queries[0], /sourceReferenceKey/);
  assert.match(queries[0], /lower\(r\.status\) = 'booked'/);
  assert.match(queries[1], /bid_status = 'Unconfirmed'/);
  assert.doesNotMatch(queries.join("\n"), /Lost/);
});

test("manual bid route returns structured success and duplicate errors", async () => {
  const submitted = { ok: true, message: "Bid submitted", bid: { rideId: "OTS-1", bidStatus: "Submitted" } };
  await withServer((request) => { request.dashboardActor = "Operator"; return true; }, {
    submitManualBid: async ({ rideId }) => {
      if (rideId === "OTS-DUP") {
        const error = new Error("A persisted bid already exists for this OTS job.");
        error.code = "DUPLICATE_BID";
        error.statusCode = 409;
        throw error;
      }
      return submitted;
    }
  }, async (baseUrl) => {
    const success = await fetch(`${baseUrl}/api/job-linker/bids`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rideId: "OTS-1", bidAmount: 110 })
    });
    assert.equal(success.status, 201);
    assert.deepEqual(await success.json(), submitted);

    const duplicate = await fetch(`${baseUrl}/api/job-linker/bids`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rideId: "OTS-DUP", bidAmount: 110 })
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, "DUPLICATE_BID");
  });
});

test("manual bid HTTP response does not wait for the Playwright provider lifecycle", async () => {
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const completions = [];
  const service = createJobLinkerBidService({
    repository: serviceRepository({
      completeManualBid: async (value) => {
        completions.push(value);
        return { bidId: "bid-1", rideId: "OTS-1", bidStatus: "Submitted" };
      }
    }),
    submitBid: async () => {
      await providerGate;
      return { success: true, bidAmount: "110", providerReference: "OTS-1" };
    },
    autoStart: false
  });

  await withServer((request) => { request.dashboardActor = "Operator"; return true; }, service, async (baseUrl) => {
    const response = await Promise.race([
      fetch(`${baseUrl}/api/job-linker/bids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rideId: "OTS-1", bidAmount: 110 })
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("POST waited for provider")), 500))
    ]);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).bid.bidStatus, "Created");
    assert.equal(completions.length, 0);
    releaseProvider();
    await waitFor(() => completions.length === 1);
  });
  service.stop();
});

test("manual bid reservation persists the normalized OTS business reference", async () => {
  let storedMetadata = null;
  const repository = new JobLinkerRepository();
  repository.withClient = async (run) => run({
    query: async (sql, params = []) => {
      const statement = String(sql);
      if (statement.includes("select * from rides")) {
        return { rowCount: 1, rows: [{
          ride_id: "internal-ride-1",
          refer: " ots-0509  -1 ",
          source_type: "OTS",
          pickup_at: "2026-09-06T10:00:00.000Z",
          source_expires_at: "2026-09-06T09:00:00.000Z",
          pickup: "Heathrow",
          drop_off: "Chelsea",
          guide_price_min: 76,
          guide_price_max: 89,
          guide_price_text: "As a guide, we are expecting prices between £76.00 and £89.00."
        }] };
      }
      if (statement.includes("select * from bids")) return { rowCount: 0, rows: [] };
      if (statement.includes("insert into bids")) {
        storedMetadata = JSON.parse(params[3]);
        return { rowCount: 1, rows: [{ bid_id: "bid-reference", ride_id: "internal-ride-1" }] };
      }
      return { rowCount: 0, rows: [] };
    }
  });

  await repository.reserveManualBid({
    rideId: "internal-ride-1",
    bidAmount: 90,
    now: new Date("2026-09-05T10:00:00.000Z")
  });

  assert.equal(storedMetadata.sourceReference, "ots-0509  -1");
  assert.equal(storedMetadata.sourceReferenceKey, "OTS-0509-1");
  assert.equal(storedMetadata.guidePriceMin, 76);
  assert.equal(storedMetadata.guidePriceMax, 89);
  assert.match(storedMetadata.guidePriceText, /between £76\.00 and £89\.00/);
});

test("Trash and Restore routes execute repository actions and refresh the workspace", async () => {
  const calls = [];
  const repository = {
    getCriteria: async () => ({ trashRetentionHours: 24 }),
    trashJobs: async (ids, hours) => { calls.push(["trash", ids, hours]); return { ok: true, affected: ids.length }; },
    restoreJobs: async (ids) => { calls.push(["restore", ids]); return { ok: true, affected: ids.length }; }
  };
  const workspaceService = {
    snapshot: async () => ({ ok: true }),
    sync: async () => { calls.push(["sync"]); return { ok: true }; }
  };
  await withServer(() => true, { submitManualBid: async () => ({ ok: true }) }, async (baseUrl) => {
    const trash = await fetch(`${baseUrl}/api/job-linker/trash`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rideIds: ["OTS-1"] })
    });
    assert.equal(trash.status, 200);
    assert.deepEqual(await trash.json(), { ok: true, affected: 1 });

    const restore = await fetch(`${baseUrl}/api/job-linker/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rideIds: ["OTS-1"] })
    });
    assert.equal(restore.status, 200);
    assert.deepEqual(await restore.json(), { ok: true, affected: 1 });
  }, workspaceService, repository);
  assert.deepEqual(calls, [
    ["trash", ["OTS-1"], 24], ["sync"],
    ["restore", ["OTS-1"]], ["sync"]
  ]);
});

test("Job Linker operation errors do not expose server paths or stack details", async () => {
  const workspaceService = {
    snapshot: async () => { throw new Error("database failed at /opt/private/service.js"); },
    sync: async () => { throw new Error("worker failed at C:\\private\\worker.js"); }
  };
  await withServer(() => true, { submitManualBid: async () => ({ ok: true }) }, async (baseUrl) => {
    const workspace = await fetch(`${baseUrl}/api/job-linker`);
    assert.equal(workspace.status, 500);
    const workspaceBody = await workspace.json();
    assert.equal(workspaceBody.code, "JOB_LINKER_LOAD_FAILED");
    assert.doesNotMatch(JSON.stringify(workspaceBody), /\/opt\/private|C:\\\\private/);

    const sync = await fetch(`${baseUrl}/api/job-linker/sync`, { method: "POST" });
    assert.equal(sync.status, 500);
    const syncBody = await sync.json();
    assert.equal(syncBody.code, "JOB_LINKER_OPERATION_FAILED");
    assert.doesNotMatch(JSON.stringify(syncBody), /\/opt\/private|C:\\\\private/);
  }, workspaceService);
});

test("authenticated WhatsApp ingest stores one normalized ride through shared filtering", async () => {
  const calls = [];
  const repository = {
    async syncSourceJobs(jobs, sourceType) {
      calls.push({ jobs, sourceType });
      return { count: 1 };
    }
  };
  await withServer(() => true, { submitManualBid: async () => ({ ok: true }) }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/job-linker/whatsapp-ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ride: { refer: "WA-123", pickup: "Heathrow", drop_off: "Birmingham" } })
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, accepted: true, filtered: false });
  }, null, repository);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceType, "WhatsApp");
  assert.equal(calls[0].jobs[0].refer, "WA-123");
});

test("WhatsApp ingest requires dashboard authentication", async () => {
  await withServer((_request, response) => {
    response.status(401).json({ ok: false, message: "Dashboard token required" });
    return false;
  }, { submitManualBid: async () => ({ ok: true }) }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/job-linker/whatsapp-ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ride: { refer: "WA-123" } })
    });
    assert.equal(response.status, 401);
  }, null, { syncSourceJobs: async () => ({ count: 1 }) });
});

test("archive and unarchive link routes are authenticated and never invoke bidding", async () => {
  const calls = [];
  const workspaceService = {
    archiveLink: async (linkId) => { calls.push(`archive:${linkId}`); return { ok: true }; },
    unarchiveLink: async (linkId) => { calls.push(`unarchive:${linkId}`); return { ok: true }; }
  };
  await withServer(() => true, { submitManualBid: async () => { throw new Error("Bid must not run"); } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/job-linker/links/LINK-123/archive`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    const restore = await fetch(`${baseUrl}/api/job-linker/links/LINK-123/unarchive`, { method: "POST" });
    assert.equal(restore.status, 200);
    assert.equal((await restore.json()).ok, true);
  }, workspaceService);
  assert.deepEqual(calls, ["archive:LINK-123", "unarchive:LINK-123"]);
  await withServer((_request, response) => { response.status(401).json({ ok: false }); return false; }, {}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/job-linker/links/LINK-123/archive`, { method: "POST" });
    assert.equal(response.status, 401);
    const restore = await fetch(`${baseUrl}/api/job-linker/links/LINK-123/unarchive`, { method: "POST" });
    assert.equal(restore.status, 401);
  }, workspaceService);
  assert.deepEqual(calls, ["archive:LINK-123", "unarchive:LINK-123"]);
});

test("unarchive rejects links that are no longer active", async () => {
  const repository = new JobLinkerRepository();
  const queries = [];
  repository.withClient = async (run) => run({ query: async (sql, params) => {
    queries.push({ sql, params });
    return { rowCount: 0, rows: [] };
  } });
  assert.deepEqual(await repository.unarchiveLink("LINK-PAST"), { ok: false, linkId: "LINK-PAST" });
  assert.match(queries[0].sql, /l\.status in \('Archived', 'Archived Review'\)/);
  assert.match(queries[0].sql, /n\.pickup_at > now\(\)/);
  assert.match(queries[0].sql, /n\.source_expires_at > now\(\)/);
  assert.deepEqual(queries[0].params, ["LINK-PAST"]);
});

test("archived links survive recomputation but past returns and missing sheet rows are hidden", async () => {
  const queries = [];
  const repository = new JobLinkerRepository();
  repository.withClient = async (run) => run({ query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: sql.includes("returning l.link_id") ? 1 : 0 };
  } });
  await repository.replaceLinks([
    { linkId: "LINK-123", firstRideId: "PRE-1", secondRideId: "OTS-2", anchorRideId: "PRE-1", candidateRideId: "OTS-2", score: 75 },
    { linkId: "POSSIBLE-123", firstRideId: "PRE-1", secondRideId: "OTS-3", anchorRideId: "PRE-1", candidateRideId: "OTS-3", score: 55, reviewOnly: true }
  ]);
  assert.ok(queries.some(({ sql }) => sql.includes("status in ('Linker Opportunity', 'Review Opportunity')")));
  assert.ok(queries.some(({ sql }) => sql.includes("on conflict (link_id) do nothing")));
  const inserts = queries.filter(({ sql }) => sql.includes("insert into linked_rides"));
  assert.equal(inserts[0].params[8], "Linker Opportunity");
  assert.equal(inserts[1].params[8], "Review Opportunity");
  await repository.archiveLink("LINK-123");
  assert.ok(queries.some(({ sql }) => sql.includes("then 'Archived Review' else 'Archived'")));
  assert.deepEqual(await repository.unarchiveLink("LINK-123"), { ok: true, linkId: "LINK-123" });
  assert.ok(queries.some(({ sql }) => sql.includes("then 'Review Opportunity' else 'Linker Opportunity'")));
  await repository.listLinks();
  await repository.listReviewLinks();
  await repository.listArchivedLinks();
  assert.equal(queries.filter(({ sql }) => sql.includes("n.pickup_at > now()")).length, 5);
  await repository.expireMissingSheetJobs(["RID-KEEP"]);
  const expiration = queries.find(({ sql }) => sql.includes("ride_id <> all($1::text[])"));
  assert.deepEqual(expiration.params, [["RID-KEEP"], "WhatsApp Sheet: Upcoming Jobs >79"]);
});
