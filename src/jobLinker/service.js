const { evaluateJob, evaluatePrebookJob } = require("./criteria");
const { createRoutingResolver, findLinkedRideOpportunities, findPossibleReturnOpportunities } = require("./linker");
const { loadPrebookJobs } = require("./prebook");
const { syncOtsMaster } = require("./otsMaster");
const { loadWhatsAppSheetJobs } = require("./whatsappSheets");
const { formatOtsCopyDetail } = require("./detailFormatter");

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
    possibleLinkCount: 0,
    linkerLastError: "",
    otsLastSyncAt: null,
    otsEnabled: Boolean(options.otsEnabled),
    otsLastError: "",
    otsRowsImported: 0,
    otsRowsAdded: 0,
    otsRowsUpdated: 0,
    otsRowsSeen: 0,
    otsRowsExcluded: 0,
    otsExclusionReasons: {},
    otsRowsRemoved: 0,
    otsSourceComplete: false,
    whatsappSheetMode: "off",
    whatsappSheetEnabled: Boolean(options.whatsappSheetsClient && options.whatsappSpreadsheetId),
    whatsappSheetMessage: "WhatsApp source sheets are not configured.",
    whatsappSheetCount: 0,
    whatsappSheetLastSyncAt: null,
    whatsappSheetLastError: ""
  };
  let activeRun = null;
  let timer = null;
  let groupsRun = null;
  let groupsTimer = null;
  let activeLinkRefresh = Promise.resolve();
  const routingResolver = options.routingResolver || createRoutingResolver({
    geocoder: options.geocoder,
    osrmClient: options.osrmClient
  });

  if (!repository) throw new Error("Job linker repository is required");

  async function computeLinks(criteria) {
    try {
      const now = typeof options.now === "function" ? options.now() : new Date();
      const jobs = await repository.listJobs();
      const evaluated = jobs.map((job) => ({
        ...job,
        evaluation: job.sourceType === "PreBook" ? evaluatePrebookJob(job) : evaluateJob(job, criteria)
      }));
      const ineligibleSourceIds = evaluated
        .filter((job) => job.sourceType === "WhatsApp" && job.groupName !== "WhatsApp Sheet: Upcoming Jobs >79" && !job.evaluation.eligible)
        .map((job) => job.rideId);
      if (typeof repository.expireSourceJobs === "function") {
        await repository.expireSourceJobs(ineligibleSourceIds);
      }
      const prebook = evaluated.filter((job) => job.sourceType === "PreBook" && job.evaluation.eligible);
      const candidates = evaluated.filter((job) => ["OTS", "WhatsApp"].includes(job.sourceType) && job.evaluation.eligible
        && (job.sourceType !== "WhatsApp" || job.groupName === "WhatsApp Sheet: Upcoming Jobs >79"));
      const futureCandidates = candidates.filter((job) => new Date(job.pickupAt).getTime() > now.getTime());
      const groupsAnchors = futureCandidates.filter((job) =>
        job.sourceType === "WhatsApp" && job.groupName === "WhatsApp Sheet: Upcoming Jobs >79");
      const anchors = [...prebook, ...groupsAnchors];
      const futurePrebook = prebook.filter((job) => new Date(job.pickupAt).getTime() > now.getTime());
      const linkCandidates = [...futurePrebook, ...futureCandidates];
      const futureRideIds = new Set(evaluated.filter((job) => new Date(job.pickupAt).getTime() > now.getTime()).map((job) => job.rideId));
      const matches = await findLinkedRideOpportunities(anchors, linkCandidates, criteria, {
        resolver: routingResolver
      });
      const links = matches.filter((link) => futureRideIds.has(link.secondRideId));
      const strictPairs = new Set(links.map((link) => `${link.anchorRideId}|${link.candidateRideId}`));
      const possibleLinks = (await findPossibleReturnOpportunities(anchors, linkCandidates, criteria, {
        resolver: routingResolver
      }))
        .filter((link) => !strictPairs.has(`${link.anchorRideId}|${link.candidateRideId}`))
        .slice(0, 3);
      await repository.replaceLinks([...links, ...possibleLinks]);
      const [activeLinks, activePossibleLinks] = await Promise.all([
        typeof repository.listLinks === "function" ? repository.listLinks() : Promise.resolve(links),
        typeof repository.listReviewLinks === "function" ? repository.listReviewLinks() : Promise.resolve(possibleLinks)
      ]);
      state.possibleLinks = activePossibleLinks;
      state.possibleLinkCount = activePossibleLinks.length;
      state.linkerLastError = "";
      return activeLinks;
    } catch (error) {
      state.linkerLastError = "Linker refresh is unavailable. Check backend logs.";
      throw error;
    }
  }

  function refreshLinks(criteria) {
    const run = activeLinkRefresh.then(() => computeLinks(criteria));
    activeLinkRefresh = run.catch(() => {});
    return run;
  }

  function syncGroupsSheet() {
    if (groupsRun) return groupsRun;
    groupsRun = (async () => {
      try {
        const criteria = await repository.getCriteria();
        const source = await loadWhatsAppSheetJobs({
          sheetsClient: options.whatsappSheetsClient,
          spreadsheetId: options.whatsappSpreadsheetId,
          worksheetNames: options.whatsappWorksheetNames,
          timeZone: options.timeZone,
          expireAfterPickupHours: criteria.expireAfterPickupHours,
          now: typeof options.now === "function" ? options.now() : new Date()
        });
        const imported = await repository.syncSourceJobs(source.jobs, "WhatsApp");
        if (options.whatsappWorksheetNames?.length === 1 && options.whatsappWorksheetNames[0] === "Upcoming Jobs >79" && typeof repository.expireMissingSheetJobs === "function") {
          await repository.expireMissingSheetJobs(imported.acceptedRideIds, "Upcoming Jobs >79");
        }
        state.whatsappSheetMode = source.mode;
        state.whatsappSheetMessage = source.message;
        state.whatsappSheetCount = imported.count;
        state.whatsappSheetLastSyncAt = new Date().toISOString();
        state.whatsappSheetLastError = "";
        try {
          await refreshLinks(criteria);
        } catch (error) {
          logger.warn("Linker refresh after Groups sheet sync failed", {
            stage: "job_linker",
            reason: error?.message || "linker_refresh_failed"
          });
        }
        return { ok: true, count: imported.count };
      } catch (error) {
        state.whatsappSheetLastError = "Groups sheet synchronization is unavailable. Check backend logs.";
        logger.warn("Groups sheet synchronization failed", {
          stage: "job_linker",
          fallbackUsed: true,
          reason: error?.message || "groups_sheet_sync_failed"
        });
        return { ok: false, message: state.whatsappSheetLastError };
      } finally {
        groupsRun = null;
      }
    })();
    return groupsRun;
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
            state.otsRowsAdded = ots.added || 0;
            state.otsRowsUpdated = ots.updated || Math.max(0, (ots.imported || 0) - state.otsRowsAdded);
            state.otsRowsSeen = ots.seen;
            state.otsRowsExcluded = ots.excluded || 0;
            state.otsExclusionReasons = ots.exclusionReasons || {};
            state.otsRowsRemoved = ots.removed || 0;
            state.otsSourceComplete = ots.sourceComplete === true;
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
        if (typeof options.onSyncComplete === "function") {
          setImmediate(() => Promise.resolve(options.onSyncComplete({ ...state })).catch((error) => {
            logger.warn("Post-sync action failed", {
              stage: "job_linker",
              fallbackUsed: true,
              reason: error?.message || "post_sync_action_failed"
            });
          }));
        }
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
    const [criteria, jobs, links, archivedLinks, trash, bids] = await Promise.all([
      repository.getCriteria(),
      repository.listJobs(),
      repository.listLinks(),
      typeof repository.listArchivedLinks === "function" ? repository.listArchivedLinks() : Promise.resolve([]),
      repository.listJobs({ includeTrash: true }),
      typeof repository.listBids === "function" ? repository.listBids() : []
    ]);
    const enriched = jobs.map((job) => {
      const evaluation = job.sourceType === "PreBook" ? evaluatePrebookJob(job) : evaluateJob(job, criteria);
      if (job.sourceType !== "OTS") return { ...job, ...evaluation };
      return {
        ...job,
        eligible: true,
        reason: "Live OTS quotation",
        linkerEligible: evaluation.eligible,
        linkerReason: evaluation.reason,
        copyDetail: formatOtsCopyDetail(job, { timeZone: options.timeZone || "Europe/London" })
      };
    });
    const decoratedBids = bids.map((bid) => ({
      ...bid,
      copyDetail: formatOtsCopyDetail(bid, { timeZone: options.timeZone || "Europe/London" })
    }));
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      timeZone: options.timeZone || "Europe/London",
      criteria,
      master: enriched.filter((job) => job.sourceType === "OTS").sort(newestFirst),
      prebook: enriched.filter((job) => job.sourceType === "PreBook").sort(newestFirst),
      groups: enriched.filter((job) => job.sourceType === "WhatsApp" && job.groupName === "WhatsApp Sheet: Upcoming Jobs >79").sort(newestFirst),
      links,
      archivedLinks,
      possibleLinks: (state.possibleLinks || []).filter((link) => {
        const candidate = jobs.find((job) => job.rideId === link.secondRideId);
        return candidate && new Date(candidate.pickupAt).getTime() > Date.now();
      }),
      bids: decoratedBids,
      trash,
      sourceStatus: { ...state }
    };
  }

  async function updateCriteria(value) {
    const criteria = await repository.saveCriteria(value);
    await refreshLinks(criteria);
    return criteria;
  }

  async function archiveLink(linkId) {
    const result = await repository.archiveLink(linkId);
    if (result.ok && typeof repository.listReviewLinks === "function") {
      state.possibleLinks = await repository.listReviewLinks();
      state.possibleLinkCount = state.possibleLinks.length;
    }
    return result;
  }

  async function unarchiveLink(linkId) {
    const result = await repository.unarchiveLink(linkId);
    if (result.ok && typeof repository.listReviewLinks === "function") {
      state.possibleLinks = await repository.listReviewLinks();
      state.possibleLinkCount = state.possibleLinks.length;
    }
    return result;
  }

  function start(intervalMs = 60000) {
    const interval = Math.max(60000, Number(intervalMs) || 60000);
    if (timer) return;
    timer = setInterval(sync, interval);
    if (typeof timer.unref === "function") timer.unref();
    setImmediate(sync);
    if (options.whatsappSheetsClient && options.whatsappSpreadsheetId) {
      groupsTimer = setInterval(syncGroupsSheet, 5 * 60 * 1000);
      if (typeof groupsTimer.unref === "function") groupsTimer.unref();
      setImmediate(syncGroupsSheet);
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (groupsTimer) clearInterval(groupsTimer);
    groupsTimer = null;
  }

  return { snapshot, sync, syncGroupsSheet, updateCriteria, archiveLink, unarchiveLink, start, stop, refreshLinks, state };
}

module.exports = { createJobLinkerService };
