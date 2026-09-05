function registerJobLinkerRoutes(app, options = {}) {
  const getService = options.getService;
  const getBidService = options.getBidService;
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
      response.json(await service.snapshot());
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
