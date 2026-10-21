function registerJobLinkerRoutes(app, options = {}) {
  const getService = options.getService;
  const getBidService = options.getBidService;
  const getAutoBidRunner = options.getAutoBidRunner;
  const authorize = options.authorize;
  const logger = options.logger || { warn: () => {} };

  function serviceOrFail(response) {
    const service = typeof getService === "function" ? getService() : null;
    if (service) return service;
    response.status(503).json({ ok: false, message: "Job linker database service is not ready." });
    return null;
  }

  function secure(request, response) {
    return typeof authorize !== "function" || authorize(request, response);
  }

  function bidServiceOrFail(response) {
    const service = typeof getBidService === "function" ? getBidService() : null;
    if (service) return service;
    response.status(503).json({ ok: false, code: "BID_SERVICE_UNAVAILABLE", message: "Job Linker bid service is not ready." });
    return null;
  }

  function autoBidRunnerOrFail(response) {
    const runner = typeof getAutoBidRunner === "function" ? getAutoBidRunner() : null;
    if (runner) return runner;
    response.status(503).json({ ok: false, code: "AUTO_BID_UNAVAILABLE", message: "Auto Bid service is not ready." });
    return null;
  }

  async function auditBid(request, result) {
    if (typeof options.auditBid !== "function") return;
    try {
      await options.auditBid(request, result);
    } catch {
      // Bid completion must not be reversed by a secondary audit failure.
    }
  }

  function sendOperationError(response, error, fallback) {
    logger.warn("Job Linker operation failed", {
      stage: "job_linker_api",
      fallbackUsed: true,
      reason: error?.message || error?.code || "job_linker_operation_failed"
    });
    response.status(Number(error?.statusCode) || 500).json({
      ok: false,
      code: error?.code || "JOB_LINKER_OPERATION_FAILED",
      message: fallback
    });
  }

  app.get("/api/job-linker", async (request, response) => {
    if (!secure(request, response)) return;
    const service = serviceOrFail(response);
    if (!service) return;
    try {
      response.setHeader("Cache-Control", "no-store");
      const snapshot = await service.snapshot();
      const autoBidRunner = typeof getAutoBidRunner === "function" ? getAutoBidRunner() : null;
      if (autoBidRunner) snapshot.autoBid = await autoBidRunner.snapshot();
      response.json(snapshot);
    } catch (error) {
      logger.warn("Job Linker workspace load failed", {
        stage: "job_linker_api",
        fallbackUsed: true,
        reason: error?.message || "job_linker_load_failed"
      });
      response.status(500).json({ ok: false, code: "JOB_LINKER_LOAD_FAILED", message: "Job workspace could not be loaded. Check backend logs." });
    }
  });

  app.post("/api/job-linker/bids", async (request, response) => {
    if (!secure(request, response)) return;
    const service = bidServiceOrFail(response);
    if (!service) return;
    try {
      const result = await service.submitManualBid({
        rideId: request.body?.rideId,
        bidAmount: request.body?.bidAmount,
        reason: request.body?.reason,
        actor: request.dashboardActor
      });
      await auditBid(request, result);
      response.status(201).json(result);
    } catch (error) {
      const result = {
        ok: false,
        code: error?.code || "BID_REQUEST_FAILED",
        message: error?.message || "Bid request failed.",
        ...(error?.bid ? { bid: error.bid } : {})
      };
      await auditBid(request, result);
      response.status(Number(error?.statusCode) || 500).json(result);
    }
  });

  app.post("/api/job-linker/sync", async (request, response) => {
    if (!secure(request, response)) return;
    const service = serviceOrFail(response);
    if (!service) return;
    try {
      const result = await service.sync();
      response.status(result.ok ? 200 : 500).json(result);
    } catch (error) {
      sendOperationError(response, error, "Job source synchronization failed. Check backend logs.");
    }
  });

  app.post("/api/job-linker/links/:linkId/archive", async (request, response) => {
    if (!secure(request, response)) return;
    const service = serviceOrFail(response);
    if (!service) return;
    try {
      const result = await service.archiveLink(request.params.linkId);
      if (!result.ok) return response.status(404).json({ ok: false, message: "This link is no longer available." });
      response.json({ ok: true, message: "Link archived." });
    } catch (error) {
      sendOperationError(response, error, "Link could not be archived.");
    }
  });

  app.post("/api/job-linker/links/:linkId/unarchive", async (request, response) => {
    if (!secure(request, response)) return;
    const service = serviceOrFail(response);
    if (!service) return;
    try {
      const result = await service.unarchiveLink(request.params.linkId);
      if (!result.ok) return response.status(404).json({ ok: false, message: "This archived link is no longer available." });
      response.json({ ok: true, message: "Link restored." });
    } catch (error) {
      sendOperationError(response, error, "Link could not be restored.");
    }
  });

  app.post("/api/job-linker/auto-bid/settings", async (request, response) => {
    if (!secure(request, response)) return;
    const runner = autoBidRunnerOrFail(response);
    if (!runner) return;
    try {
      const enabling = request.body?.enabled === true || String(request.body?.enabled).toLowerCase() === "true";
      if (enabling && request.body?.confirmation !== "ENABLE AUTO BID") {
        response.status(400).json({ ok: false, code: "AUTO_BID_CONFIRMATION_REQUIRED", message: "Confirm Auto Bid before enabling it." });
        return;
      }
      response.json({ ok: true, autoBid: await runner.saveSettings(request.body || {}) });
    } catch (error) {
      sendOperationError(response, error, "Auto Bid settings could not be saved.");
    }
  });

  app.post("/api/job-linker/whatsapp-ingest", async (request, response) => {
    if (!secure(request, response)) return;
    try {
      const ride = request.body?.ride;
      if (!ride || typeof ride !== "object") {
        response.status(400).json({ ok: false, code: "RIDE_REQUIRED", message: "A normalized WhatsApp ride is required." });
        return;
      }
      const result = await options.repository.syncSourceJobs([ride], "WhatsApp");
      response.status(202).json({
        ok: true,
        accepted: result.count === 1,
        filtered: result.count === 0
      });
    } catch (error) {
      sendOperationError(response, error, "WhatsApp ride could not be ingested.");
    }
  });

  app.post("/api/job-linker/criteria", async (request, response) => {
    if (!secure(request, response)) return;
    const service = serviceOrFail(response);
    if (!service) return;
    try {
      response.json({ ok: true, criteria: await service.updateCriteria(request.body || {}) });
    } catch (error) {
      logger.warn("Job Linker criteria update failed", {
        stage: "job_linker_api",
        fallbackUsed: true,
        reason: error?.message || "criteria_update_failed"
      });
      response.status(400).json({ ok: false, code: "CRITERIA_UPDATE_FAILED", message: "Matching rules could not be saved. Check the values and backend logs." });
    }
  });

  app.post("/api/job-linker/trash", async (request, response) => {
    if (!secure(request, response)) return;
    const service = serviceOrFail(response);
    if (!service) return;
    try {
      const criteria = await options.repository.getCriteria();
      const result = await options.repository.trashJobs(
        Array.isArray(request.body?.rideIds) ? request.body.rideIds : [],
        criteria?.trashRetentionHours || 24
      );
      await service.sync();
      response.json(result);
    } catch (error) {
      sendOperationError(response, error, "Jobs could not be moved to Trash. Check backend logs.");
    }
  });

  app.post("/api/job-linker/restore", async (request, response) => {
    if (!secure(request, response)) return;
    const service = serviceOrFail(response);
    if (!service) return;
    try {
      const result = await options.repository.restoreJobs(
        Array.isArray(request.body?.rideIds) ? request.body.rideIds : []
      );
      await service.sync();
      response.json(result);
    } catch (error) {
      sendOperationError(response, error, "Jobs could not be restored. Check backend logs.");
    }
  });
}

module.exports = { registerJobLinkerRoutes };
