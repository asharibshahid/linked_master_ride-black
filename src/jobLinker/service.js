const { evaluateJob, evaluatePrebookJob } = require("./criteria");
const { createRoutingResolver, findLinkedRideOpportunities } = require("./linker");
const { loadPrebookJobs } = require("./prebook");
const { syncOtsMaster } = require("./otsMaster");
const { loadWhatsAppSheetJobs } = require("./whatsappSheets");

function newestFirst(left, right) {
  const leftTime = new Date(left.sourceTime || left.createdAt || 0).getTime();
  const rightTime = new Date(right.sourceTime || right.createdAt || 0).getTime();
  return rightTime - leftTime;
}

function createJobLinkerService(options = {}) {
  const repository = options.repository;
  const logger = options.logger || console;
  const state = {
    running: false,
    lastSyncAt: null,
    lastError: "",
    prebookMode: "demo",
    prebookMessage: "PreBook sync has not run yet.",
    prebookLastError: "",
    prebookCount: 0,
    linkCount: 0,
    linkerLastError: "",
    otsLastSyncAt: null,
    otsEnabled: Boolean(options.otsEnabled),
    otsLastError: "",
    otsRowsImported: 0,
    whatsappSheetMode: "off",
    whatsappSheetEnabled: Boolean(options.whatsappSheetsClient && options.whatsappSpreadsheetId),
    whatsappSheetMessage: "WhatsApp source sheets are not configured.",
    whatsappSheetCount: 0,
    whatsappSheetLastError: ""
  };
  let activeRun = null;
  let timer = null;
  const routingResolver = options.routingResolver || createRoutingResolver({
    geocoder: options.geocoder,
    osrmClient: options.osrmClient
  });

  if (!repository) throw new Error("Job linker repository is required");

  async function refreshLinks(criteria) {
    try {
      const jobs = await repository.listJobs();
      const evaluated = jobs.map((job) => ({
        ...job,
        evaluation: job.sourceType === "PreBook" ? evaluatePrebookJob(job) : evaluateJob(job, criteria)
      }));
      const ineligibleSourceIds = evaluated
        .filter((job) => ["OTS", "WhatsApp"].includes(job.sourceType) && !job.evaluation.eligible)
        .map((job) => job.rideId);
      if (typeof repository.expireSourceJobs === "function") {
        await repository.expireSourceJobs(ineligibleSourceIds);
      }
      const prebook = evaluated.filter((job) => job.sourceType === "PreBook" && job.evaluation.eligible);
      const candidates = evaluated.filter((job) => ["OTS", "WhatsApp"].includes(job.sourceType) && job.evaluation.eligible);
      const links = await findLinkedRideOpportunities(prebook, candidates, criteria, {
        resolver: routingResolver
      });
      await repository.replaceLinks(links);
      state.linkerLastError = "";
      return links;
    } catch (error) {
      state.linkerLastError = "Linker refresh is unavailable. Check backend logs.";
      throw error;
    }
  }

  async function sync() {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      state.running = true;
      try {
        const criteria = await repository.getCriteria();
        if (options.otsEnabled) {
          try {
            const ots = await syncOtsMaster({
              repository,
              projectPath: options.otsProjectPath,
              formattedRowsPath: options.otsFormattedRowsPath,
              groupName: options.otsGroupName,
              sourceName: options.otsSourceName
            });
            state.otsLastSyncAt = new Date().toISOString();
            state.otsLastError = "";
            state.otsRowsImported = ots.imported;
            if (ots.imported > 0) {
              logger.info("OTS Master synchronized", {
                stage: "ots_master",
                reason: `rows=${ots.imported}`
              });
            }
          } catch (error) {
            const nextError = error?.message || "OTS Master sync failed";
            const publicError = "OTS worker synchronization is unavailable. Check backend logs.";
            if (state.otsLastError !== publicError) {
              logger.warn("OTS Master synchronization failed", {
                stage: "ots_master",
                fallbackUsed: true,
                reason: nextError
              });
            }
            state.otsLastError = publicError;
          }
        }
        if (options.whatsappSheetsClient && options.whatsappSpreadsheetId) {
          try {
            const source = await loadWhatsAppSheetJobs({
              sheetsClient: options.whatsappSheetsClient,
              spreadsheetId: options.whatsappSpreadsheetId,
              worksheetNames: options.whatsappWorksheetNames,
              timeZone: options.timeZone,
              expireAfterPickupHours: criteria.expireAfterPickupHours
            });
            const imported = await repository.syncSourceJobs(source.jobs, "WhatsApp");
            state.whatsappSheetMode = source.mode;
            state.whatsappSheetMessage = source.message;
            state.whatsappSheetCount = imported.count;
            state.whatsappSheetLastError = "";
          } catch (error) {
            const sourceError = error?.message || "WhatsApp source sheet sync failed";
            state.whatsappSheetLastError = "WhatsApp source synchronization is unavailable. Check backend logs.";
            logger.warn("WhatsApp source sheets synchronization failed", {
              stage: "job_linker",
              fallbackUsed: true,
              reason: sourceError
            });
          }
        }
        let prebook;
        try {
          prebook = await loadPrebookJobs({
            sheetsClient: options.sheetsClient,
            spreadsheetId: options.prebookSpreadsheetId,
            worksheetName: options.prebookWorksheetName,
            timeZone: options.timeZone,
            expireAfterPickupHours: criteria.expireAfterPickupHours
          });
          state.prebookLastError = "";
        } catch (error) {
          state.prebookLastError = "PreBook synchronization is unavailable. Check backend logs.";
          throw error;
        }
        await repository.syncPrebookJobs(prebook.jobs, { mode: prebook.mode, criteria });
        if (typeof repository.reconcileConfirmedBids === "function") {
          await repository.reconcileConfirmedBids();
        }
        const links = await refreshLinks(criteria);
        state.lastSyncAt = new Date().toISOString();
        state.lastError = "";
        state.prebookMode = prebook.mode;
        state.prebookMessage = prebook.message;
        if (state.prebookCount !== prebook.jobs.length || state.linkCount !== links.length) {
          logger.info("Job sources synchronized", {
            stage: "job_linker",
            reason: `prebook=${prebook.jobs.length} links=${links.length} mode=${prebook.mode}`
          });
        }
        state.prebookCount = prebook.jobs.length;
        state.linkCount = links.length;
        return { ok: true, prebook: prebook.jobs.length, links: links.length };
      } catch (error) {
        const errorDetail = error?.message || "Job linker sync failed";
        state.lastError = "Job Linker synchronization failed. Check backend logs.";
        logger.warn("Job source synchronization failed", {
          stage: "job_linker",
          fallbackUsed: true,
          reason: errorDetail
        });
        return { ok: false, message: state.lastError };
      } finally {
        state.running = false;
        activeRun = null;
      }
    })();
    return activeRun;
  }

  async function snapshot() {
    const [criteria, jobs, links, trash, bids] = await Promise.all([
      repository.getCriteria(),
      repository.listJobs(),
      repository.listLinks(),
      repository.listJobs({ includeTrash: true }),
      typeof repository.listBids === "function" ? repository.listBids() : []
    ]);
    const enriched = jobs.map((job) => ({
      ...job,
      ...(job.sourceType === "PreBook" ? evaluatePrebookJob(job) : evaluateJob(job, criteria))
    }));
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      timeZone: options.timeZone || "Europe/London",
      criteria,
      master: enriched.filter((job) => job.sourceType === "OTS").sort(newestFirst),
      prebook: enriched.filter((job) => job.sourceType === "PreBook").sort(newestFirst),
      groups: enriched.filter((job) => job.sourceType === "WhatsApp").sort(newestFirst),
      links,
      bids,
      trash,
      sourceStatus: { ...state }
    };
  }

  async function updateCriteria(value) {
    const criteria = await repository.saveCriteria(value);
    await refreshLinks(criteria);
    return criteria;
  }

  function start(intervalMs = 60000) {
    const interval = Math.max(60000, Number(intervalMs) || 60000);
    if (timer) return;
    timer = setInterval(sync, interval);
    if (typeof timer.unref === "function") timer.unref();
    setImmediate(sync);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { snapshot, sync, updateCriteria, start, stop, refreshLinks, state };
}

module.exports = { createJobLinkerService };
