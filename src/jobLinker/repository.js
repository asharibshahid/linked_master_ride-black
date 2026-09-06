const { createDatabaseClient } = require("../database/client");
const { evaluateJob, normalizeCriteria, DEFAULT_JOB_LINKER_CRITERIA } = require("./criteria");
const { parsePickupDateTime } = require("../sheets/upcomingJobs");
const { JobLinkerBidError, normalizeBusinessReference, validateManualBidRide } = require("./bids");

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function mapJob(row = {}) {
  return {
    rideId: text(row.ride_id),
    sourceType: text(row.source_type),
    sourceName: text(row.source_name),
    sourceTime: row.source_time ? new Date(row.source_time).toISOString() : "",
    pickupDayDate: text(row.pickup_day_date),
    startingTiming: text(row.starting_timing),
    pickup: text(row.pickup),
    dropOff: text(row.drop_off),
    distance: text(row.distance),
    fare: row.fare === null || row.fare === undefined ? null : Number(row.fare),
    requiredVehicle: text(row.required_vehicle),
    passengerCount: text(row.passenger_count),
    luggageDetails: text(row.luggage_details),
    guidePriceMin: row.guide_price_min === null || row.guide_price_min === undefined ? null : Number(row.guide_price_min),
    guidePriceMax: row.guide_price_max === null || row.guide_price_max === undefined ? null : Number(row.guide_price_max),
    guidePriceText: text(row.guide_price_text),
    sourceMetadata: row.source_metadata && typeof row.source_metadata === "object" ? row.source_metadata : {},
    pickupAt: row.pickup_at ? new Date(row.pickup_at).toISOString() : null,
    expiresAt: row.source_expires_at ? new Date(row.source_expires_at).toISOString() : null,
    status: text(row.status),
    isDemo: Boolean(row.is_demo),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : "",
    trashedAt: row.trashed_at ? new Date(row.trashed_at).toISOString() : null,
    trashDeleteAt: row.trash_delete_at ? new Date(row.trash_delete_at).toISOString() : null
  };
}

function submissionState(row = {}, payload = {}) {
  if (payload.submission?.state) return text(payload.submission.state);
  const status = text(row.bid_status).toLowerCase();
  if (status === "confirmed") return "confirmed";
  if (status === "submitted") return "submitted";
  if (status === "submitting") return "attempting";
  if (status === "submission failed") return "failed";
  return status === "created" ? "created" : "pending";
}

function mapWorkspaceBid(row = {}) {
  const payload = row.pricing_payload && typeof row.pricing_payload === "object" ? row.pricing_payload : {};
  const submission = payload.submission && typeof payload.submission === "object" ? payload.submission : {};
  return {
    bidId: text(row.bid_id),
    rideId: text(row.ride_id),
    otsReference: text(payload.sourceReference || row.ride_refer || row.ride_id),
    source: text(payload.sourceType || row.source_type || "OTS"),
    sourceName: text(row.source_name),
    pickupDayDate: text(row.pickup_day_date),
    startingTiming: text(row.starting_timing),
    pickupAt: row.pickup_at ? new Date(row.pickup_at).toISOString() : null,
    pickup: text(row.pickup),
    dropOff: text(row.drop_off),
    requiredVehicle: text(row.required_vehicle),
    distance: text(row.distance),
    originalFare: row.fare === null || row.fare === undefined ? null : Number(row.fare),
    passengerCount: text(row.passenger_count),
    luggageDetails: text(row.luggage_details),
    guidePriceMin: row.guide_price_min === null || row.guide_price_min === undefined ? null : Number(row.guide_price_min),
    guidePriceMax: row.guide_price_max === null || row.guide_price_max === undefined ? null : Number(row.guide_price_max),
    guidePriceText: text(row.guide_price_text),
    bidAmount: row.bid_amount === null || row.bid_amount === undefined ? null : Number(row.bid_amount),
    reason: text(row.reason),
    bidStatus: text(row.bid_status),
    adminStatus: text(row.admin_status),
    submissionState: submissionState(row, payload),
    submissionResult: text(submission.message),
    providerReference: text(submission.providerReference),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : ""
  };
}

async function loadWorkspaceBidById(client, bidId) {
  const result = await client.query(
    `select b.*, r.refer as ride_refer, r.source_type, r.source_name, r.pickup_day_date, r.starting_timing,
            r.pickup_at, r.pickup, r.drop_off, r.required_vehicle, r.distance, r.fare,
            r.passenger_count, r.luggage_details, r.guide_price_min, r.guide_price_max, r.guide_price_text
       from bids b
       left join rides r on r.ride_id = b.ride_id
      where b.bid_id = $1 and b.deleted_at is null
      limit 1`,
    [bidId]
  );
  return result.rowCount ? mapWorkspaceBid(result.rows[0]) : null;
}

function mapLink(row = {}) {
  return {
    linkId: text(row.link_id),
    anchorRideId: text(row.anchor_ride_id),
    candidateRideId: text(row.candidate_ride_id),
    firstRideId: text(row.first_ride_id),
    secondRideId: text(row.second_ride_id),
    candidateSource: text(row.candidate_source),
    direction: text(row.direction),
    previousDrop: text(row.previous_drop),
    nextPickup: text(row.next_pickup),
    timeGapMinutes: Number(row.time_gap_minutes || 0),
    timeGap: text(row.time_gap),
    distanceMiles: row.distance_miles === null || row.distance_miles === undefined ? null : Number(row.distance_miles),
    distanceBetween: text(row.distance_between),
    savingEstimate: row.saving_estimate === null || row.saving_estimate === undefined ? null : Number(row.saving_estimate),
    score: Number(row.match_score || 0),
    scoreBreakdown: row.score_breakdown || {},
    reason: text(row.match_reason),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : ""
  };
}

function prepareSourceJob(job = {}, sourceType = "OTS", rawCriteria = {}, now = new Date()) {
  const cleanSource = sourceType === "WhatsApp" ? "WhatsApp" : "OTS";
  const criteria = normalizeCriteria(rawCriteria);
  const rideId = text(job.refer || job.rideId || job.ride_id);
  if (!rideId) return null;

  const pickupDayDate = text(job.pickup_day_date || job.pickupDayDate);
  const startingTiming = text(job.starting_timing || job.startingTiming);
  const parsed = parsePickupDateTime(pickupDayDate, startingTiming, { timeZone: "Europe/London" });
  if (!parsed) return null;

  const pickupAt = parsed.toISOString();
  const retentionExpiry = new Date(parsed.getTime() + criteria.expireAfterPickupHours * 60 * 60 * 1000);
  const sourceExpiryValue = text(job.source_expires_at || job.sourceExpiresAt || job.offerExpiresAt);
  const sourceExpiry = sourceExpiryValue ? new Date(sourceExpiryValue) : null;
  const hasSourceExpiry = sourceExpiry && !Number.isNaN(sourceExpiry.getTime());
  const expiresAt = hasSourceExpiry && sourceExpiry.getTime() < retentionExpiry.getTime()
    ? sourceExpiry
    : retentionExpiry;
  if (expiresAt.getTime() <= now.getTime()) return null;

  const prepared = {
    rideId,
    sourceType: cleanSource,
    groupName: text(job.group_name || cleanSource),
    sourceName: text(job.source_name || (cleanSource === "OTS" ? "OTS Supplier Portal" : "WhatsApp")),
    pickupDayDate,
    startingTiming,
    pickup: text(job.pickup),
    dropOff: text(job.drop_off || job.dropOff),
    distance: text(job.distance),
    fare: job.fare === "" || job.fare === null || job.fare === undefined ? null : Number(job.fare),
    requiredVehicle: text(job.required_vehicle || job.requiredVehicle),
    passengerCount: text(job.passenger_count || job.passengerCount),
    luggageDetails: text(job.luggage_details || job.luggageDetails),
    guidePriceMin: job.guide_price_min === null || job.guide_price_min === undefined ? null : Number(job.guide_price_min),
    guidePriceMax: job.guide_price_max === null || job.guide_price_max === undefined ? null : Number(job.guide_price_max),
    guidePriceText: text(job.guide_price_text || job.guidePriceText),
    sourceMetadata: job.source_metadata && typeof job.source_metadata === "object" ? job.source_metadata : {},
    paymentStatus: text(job.payment_status),
    pickupAt,
    expiresAt: expiresAt.toISOString()
  };
  if (!prepared.pickup || !prepared.dropOff) return null;
  return cleanSource === "OTS" || evaluateJob(prepared, criteria).eligible ? prepared : null;
}

class JobLinkerRepository {
  constructor(options = {}) {
    this.databaseUrl = text(options.databaseUrl);
    this.ssl = options.ssl;
  }

  async withClient(fn) {
    const client = createDatabaseClient({ databaseUrl: this.databaseUrl, ssl: this.ssl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async getCriteria() {
    return this.withClient(async (client) => {
      const result = await client.query("select value from system_settings where setting_key = 'job_linker_criteria' limit 1");
      return normalizeCriteria(result.rows[0]?.value || DEFAULT_JOB_LINKER_CRITERIA);
    });
  }

  async saveCriteria(value = {}) {
    const criteria = normalizeCriteria(value);
    return this.withClient(async (client) => {
      await client.query(
        `insert into system_settings (setting_key, value)
         values ('job_linker_criteria', $1::jsonb)
         on conflict (setting_key) do update set value = excluded.value, updated_at = now()`,
        [JSON.stringify(criteria)]
      );
      await client.query(
        `update rides
         set source_expires_at = pickup_at + ($1::text || ' hours')::interval
         where deleted_at is null and is_protected = false and pickup_at is not null
           and source_type in ('WhatsApp', 'PreBook')`,
        [criteria.expireAfterPickupHours]
      );
      return criteria;
    });
  }

  async syncPrebookJobs(jobs = [], options = {}) {
    const mode = text(options.mode || "demo");
    const criteria = normalizeCriteria(options.criteria || DEFAULT_JOB_LINKER_CRITERIA);
    return this.withClient(async (client) => {
      await client.query("begin");
      try {
        const ids = [];
        for (const job of jobs) {
          ids.push(job.rideId);
          await client.query(
            `insert into rides (
               ride_id, refer, source_type, source_name, source_time, pickup_day_date,
               starting_timing, pickup, drop_off, distance, fare, required_vehicle, pickup_at,
               status, retention_class, is_demo, source_expires_at
             ) values ($1,$1,'PreBook',$2,now(),$3,$4,$5,$6,$7,$8,$9,$10,'Booked','operational',$11,
               $10::timestamptz + ($12::text || ' hours')::interval)
             on conflict (ride_id) do update set
               source_type = 'PreBook', source_name = excluded.source_name,
               pickup_day_date = excluded.pickup_day_date, starting_timing = excluded.starting_timing,
               pickup = excluded.pickup, drop_off = excluded.drop_off, distance = excluded.distance, fare = excluded.fare,
               required_vehicle = excluded.required_vehicle, pickup_at = excluded.pickup_at,
               status = 'Booked', is_demo = excluded.is_demo,
               source_expires_at = excluded.source_expires_at, deleted_at = null,
               trashed_at = null, trash_delete_at = null`,
            [
              job.rideId,
              job.sourceName || (mode === "demo" ? "Demo PreBook" : "PreBook Sheet"),
              job.pickupDayDate,
              job.startingTiming,
              job.pickup,
              job.dropOff,
              job.distance,
              job.fare === "" ? null : Number(job.fare),
              job.requiredVehicle,
              job.pickupAt,
              Boolean(job.isDemo),
              criteria.expireAfterPickupHours
            ]
          );
        }

        await client.query(
          `update rides set deleted_at = now()
           where source_type = 'PreBook' and deleted_at is null
             and not (ride_id = any($1::text[]))`,
          [ids]
        );
        await client.query("commit");
        return { ok: true, count: jobs.length, mode };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async syncSourceJobs(jobs = [], sourceType = "OTS") {
    const cleanSource = sourceType === "WhatsApp" ? "WhatsApp" : "OTS";
    return this.withClient(async (client) => {
      await client.query("begin");
      let count = 0;
      const exclusionReasons = {};
      try {
        const criteriaResult = await client.query(
          "select value from system_settings where setting_key = 'job_linker_criteria' limit 1"
        );
        const criteria = normalizeCriteria(criteriaResult.rows[0]?.value || DEFAULT_JOB_LINKER_CRITERIA);
        for (const job of jobs) {
          const prepared = prepareSourceJob(job, cleanSource, criteria);
          if (!prepared) {
            exclusionReasons.invalid_or_expired_core_record = (exclusionReasons.invalid_or_expired_core_record || 0) + 1;
            continue;
          }
          await client.query(
            `insert into rides (
               ride_id, refer, source_type, group_name, source_name, source_time,
               pickup_day_date, starting_timing, pickup, drop_off, distance, fare,
               required_vehicle, payment_status, pickup_at, status, retention_class, source_expires_at,
               passenger_count, luggage_details, guide_price_min, guide_price_max, guide_price_text, source_metadata
             ) values ($1,$1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,$12,$13,'New','operational',$14,$15,$16,$17,$18,$19,$20::jsonb)
             on conflict (ride_id) do update set
               source_type = excluded.source_type, group_name = excluded.group_name,
               source_name = excluded.source_name, source_time = excluded.source_time,
               pickup_day_date = excluded.pickup_day_date, starting_timing = excluded.starting_timing,
               pickup = excluded.pickup, drop_off = excluded.drop_off,
               distance = coalesce(nullif(excluded.distance, ''), rides.distance),
               fare = excluded.fare, required_vehicle = excluded.required_vehicle,
               payment_status = excluded.payment_status, pickup_at = excluded.pickup_at,
               source_expires_at = excluded.source_expires_at,
               passenger_count = excluded.passenger_count, luggage_details = excluded.luggage_details,
               guide_price_min = excluded.guide_price_min, guide_price_max = excluded.guide_price_max,
               guide_price_text = excluded.guide_price_text, source_metadata = excluded.source_metadata,
               deleted_at = null`,
            [
              prepared.rideId,
              prepared.sourceType,
              prepared.groupName,
              prepared.sourceName,
              prepared.pickupDayDate,
              prepared.startingTiming,
              prepared.pickup,
              prepared.dropOff,
              prepared.distance,
              prepared.fare,
              prepared.requiredVehicle,
              prepared.paymentStatus,
              prepared.pickupAt,
              prepared.expiresAt,
              prepared.passengerCount,
              prepared.luggageDetails,
              prepared.guidePriceMin,
              prepared.guidePriceMax,
              prepared.guidePriceText,
              JSON.stringify(prepared.sourceMetadata || {})
            ]
          );
          count += 1;
        }
        await client.query("commit");
        return { ok: true, seen: jobs.length, count, excluded: jobs.length - count, exclusionReasons };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async listJobs(options = {}) {
    const includeTrash = Boolean(options.includeTrash);
    return this.withClient(async (client) => {
      const result = await client.query(
        includeTrash
          ? `select * from rides where trashed_at is not null and trash_delete_at > now() order by trashed_at desc limit 1000`
          : `select * from rides where deleted_at is null and source_type in ('OTS','WhatsApp','PreBook')
             and (source_expires_at is null or source_expires_at > now()) order by created_at desc limit 2500`
      );
      return result.rows.map(mapJob);
    });
  }

  async expireMissingOtsJobs(activeRideIds = []) {
    const ids = [...new Set(activeRideIds.map(text).filter(Boolean))];
    return this.withClient(async (client) => {
      const result = await client.query(
        `update rides set source_expires_at = now()
          where source_type = 'OTS' and deleted_at is null
            and not (ride_id = any($1::text[]))
            and (source_expires_at is null or source_expires_at > now())`,
        [ids]
      );
      return { ok: true, affected: result.rowCount };
    });
  }

  async listBids() {
    return this.withClient(async (client) => {
      const result = await client.query(
        `select b.*, r.refer as ride_refer, r.source_type, r.source_name, r.pickup_day_date, r.starting_timing,
                r.pickup_at, r.pickup, r.drop_off, r.required_vehicle, r.distance, r.fare,
                r.passenger_count, r.luggage_details, r.guide_price_min, r.guide_price_max, r.guide_price_text
           from bids b
           left join rides r on r.ride_id = b.ride_id
          where b.deleted_at is null
          order by b.updated_at desc
          limit 1000`
      );
      return result.rows.map(mapWorkspaceBid);
    });
  }

  async listPendingManualBids(limit = 10) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
    return this.withClient(async (client) => {
      const result = await client.query(
        `select b.*, r.refer as ride_refer, r.source_type, r.source_name,
                r.pickup_day_date, r.starting_timing, r.pickup_at, r.pickup, r.drop_off,
                r.required_vehicle, r.distance, r.fare, r.passenger_count, r.luggage_details,
                r.guide_price_min, r.guide_price_max, r.guide_price_text
           from bids b
           join rides r on r.ride_id = b.ride_id
          where b.deleted_at is null and b.bid_status = 'Created'
            and coalesce(b.pricing_payload, '{}'::jsonb) @> '{"jobLinkerManualBid":true}'::jsonb
          order by b.created_at asc
          limit $1`,
        [safeLimit]
      );
      return result.rows.map((row) => ({
        bidId: text(row.bid_id),
        bid: mapWorkspaceBid(row),
        trustedBid: {
          rideId: text(row.ride_id),
          source: "OTS",
          pickup: text(row.pickup),
          dropOff: text(row.drop_off),
          fare: row.fare === null || row.fare === undefined ? "" : String(row.fare),
          requiredVehicle: text(row.required_vehicle),
          bidType: "Job Linker Manual Bid",
          bidAmount: row.bid_amount === null || row.bid_amount === undefined ? "" : String(row.bid_amount)
        }
      }));
    });
  }

  async failStaleSubmittingBids(maxAgeMs = 5 * 60 * 1000) {
    const seconds = Math.max(60, Math.ceil(Number(maxAgeMs) / 1000));
    return this.withClient(async (client) => {
      const completedAt = new Date().toISOString();
      const metadata = {
        submission: {
          state: "failed",
          completedAt,
          message: "Provider submission timed out before a confirmed result. No automatic retry was attempted."
        }
      };
      const result = await client.query(
        `update bids
            set bid_status = 'Submission Failed',
                pricing_payload = coalesce(pricing_payload, '{}'::jsonb) || $2::jsonb,
                updated_at = now()
          where deleted_at is null and bid_status = 'Submitting'
            and updated_at < now() - ($1::text || ' seconds')::interval`,
        [seconds, JSON.stringify(metadata)]
      );
      return { ok: true, affected: result.rowCount };
    });
  }

  async reserveManualBid({ rideId, bidAmount, reason = "", actor = "Dashboard", now = new Date() } = {}) {
    const cleanRideId = text(rideId);
    return this.withClient(async (client) => {
      await client.query("begin");
      try {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [cleanRideId]);
        const rideResult = await client.query("select * from rides where ride_id = $1 for update", [cleanRideId]);
        const ride = rideResult.rows[0] || null;
        validateManualBidRide(ride, now);

        const existing = await client.query(
          "select * from bids where ride_id = $1 and deleted_at is null order by updated_at desc limit 1 for update",
          [cleanRideId]
        );
        if (existing.rowCount) {
          const existingStatus = text(existing.rows[0].bid_status).toLowerCase();
          if (!["suggested", "approved"].includes(existingStatus)) {
            throw new JobLinkerBidError(
              "DUPLICATE_BID",
              "A persisted bid already exists for this OTS job.",
              409,
              { bid: mapWorkspaceBid({ ...ride, ...existing.rows[0] }) }
            );
          }
        }

        const createdAt = new Date(now).toISOString();
        const sourceReference = text(ride.refer || ride.ride_id);
        const metadata = {
          jobLinkerManualBid: true,
          sourceType: "OTS",
          sourceReference,
          sourceReferenceKey: normalizeBusinessReference(sourceReference),
          createdBy: text(actor) || "Dashboard",
          submission: { state: "created", createdAt }
        };
        const inserted = existing.rowCount
          ? await client.query(
              `update bids
                  set bid_type = 'Job Linker Manual Bid', bid_status = 'Created',
                      admin_status = 'Approved', bid_amount = $2, reason = $3,
                      pricing_payload = coalesce(pricing_payload, '{}'::jsonb) || $4::jsonb,
                      is_protected = true, updated_at = now()
                where bid_id = $1 returning *`,
              [existing.rows[0].bid_id, bidAmount, text(reason), JSON.stringify(metadata)]
            )
          : await client.query(
              `insert into bids (
                 ride_id, bid_type, bid_status, admin_status, bid_amount, reason,
                 pricing_payload, is_protected
               ) values ($1,'Job Linker Manual Bid','Created','Approved',$2,$3,$4::jsonb,true)
               returning *`,
              [cleanRideId, bidAmount, text(reason), JSON.stringify(metadata)]
            );
        await client.query("update rides set is_protected = true where ride_id = $1", [cleanRideId]);
        await client.query("commit");
        return {
          bidId: text(inserted.rows[0].bid_id),
          bid: mapWorkspaceBid({ ...ride, ...inserted.rows[0] }),
          trustedBid: {
            rideId: cleanRideId,
            source: "OTS",
            pickup: text(ride.pickup),
            dropOff: text(ride.drop_off),
            fare: ride.fare === null || ride.fare === undefined ? "" : String(ride.fare),
            requiredVehicle: text(ride.required_vehicle),
            bidType: "Job Linker Manual Bid",
            bidAmount: String(bidAmount)
          }
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async markManualBidSubmitting(bidId) {
    const cleanBidId = text(bidId);
    return this.withClient(async (client) => {
      const attemptedAt = new Date().toISOString();
      const result = await client.query(
        `update bids
            set bid_status = 'Submitting',
                pricing_payload = coalesce(pricing_payload, '{}'::jsonb) || $2::jsonb,
                updated_at = now()
          where bid_id = $1 and deleted_at is null and bid_status = 'Created'`,
        [cleanBidId, JSON.stringify({ submission: { state: "attempting", attemptedAt } })]
      );
      if (result.rowCount !== 1) {
        throw new JobLinkerBidError("BID_STATE_CONFLICT", "Bid is not in a submit-ready state.", 409);
      }
      return { ok: true, bidId: cleanBidId };
    });
  }

  async completeManualBid({ bidId, success, bidAmount, providerReference = "", message = "" } = {}) {
    const cleanBidId = text(bidId);
    return this.withClient(async (client) => {
      const completedAt = new Date().toISOString();
      const bidStatus = success ? "Submitted" : "Submission Failed";
      const metadata = {
        submission: {
          state: success ? "submitted" : "failed",
          completedAt,
          providerReference: text(providerReference),
          message: text(message)
        }
      };
      const result = await client.query(
        `update bids
            set bid_status = $2,
                bid_amount = coalesce($3, bid_amount),
                pricing_payload = coalesce(pricing_payload, '{}'::jsonb) || $4::jsonb,
                updated_at = now()
          where bid_id = $1 and deleted_at is null and bid_status = 'Submitting'`,
        [cleanBidId, bidStatus, bidAmount, JSON.stringify(metadata)]
      );
      if (result.rowCount !== 1) {
        throw new JobLinkerBidError("BID_STATE_CONFLICT", "Bid submission result could not be persisted.", 409);
      }
      const bid = await loadWorkspaceBidById(client, cleanBidId);
      if (!bid) throw new Error("Persisted bid could not be reloaded");
      return bid;
    });
  }

  async reconcileConfirmedBids() {
    return this.withClient(async (client) => {
      const confirmedAt = new Date().toISOString();
      const confirmed = await client.query(
        `update bids b
            set bid_status = 'Confirmed',
                pricing_payload = coalesce(b.pricing_payload, '{}'::jsonb) || $1::jsonb,
                updated_at = now()
           from rides r
          where r.source_type = 'PreBook'
            and upper(regexp_replace(trim(r.refer), '[[:space:]]+', '', 'g')) =
                coalesce(nullif(b.pricing_payload->>'sourceReferenceKey', ''),
                  upper(regexp_replace(trim(b.ride_id), '[[:space:]]+', '', 'g')))
            and r.deleted_at is null
            and lower(r.status) = 'booked'
            and b.deleted_at is null
            and b.bid_status in ('Submitted','Unconfirmed')`,
        [JSON.stringify({ confirmation: { state: "confirmed", signal: "exact_prebook_reference", confirmedAt } })]
      );
      const unconfirmedAt = new Date().toISOString();
      const unconfirmed = await client.query(
        `update bids b
            set bid_status = 'Unconfirmed',
                pricing_payload = coalesce(b.pricing_payload, '{}'::jsonb) || $1::jsonb,
                updated_at = now()
           from rides r
          where r.ride_id = b.ride_id
            and r.source_type = 'OTS'
            and coalesce(r.source_expires_at, r.pickup_at) <= now()
            and b.deleted_at is null
            and b.bid_status = 'Submitted'`,
        [JSON.stringify({ confirmation: { state: "unconfirmed", signal: "ots_job_expired_without_booking_signal", unconfirmedAt } })]
      );
      return { ok: true, confirmed: confirmed.rowCount, unconfirmed: unconfirmed.rowCount };
    });
  }

  async expireSourceJobs(rideIds = []) {
    const ids = [...new Set(rideIds.map(text).filter(Boolean))];
    if (ids.length === 0) return { ok: true, affected: 0 };
    return this.withClient(async (client) => {
      const result = await client.query(
        `update rides set source_expires_at = now()
         where ride_id = any($1::text[]) and source_type in ('OTS','WhatsApp')
           and deleted_at is null and is_protected = false`,
        [ids]
      );
      return { ok: true, affected: result.rowCount };
    });
  }

  async trashJobs(rideIds = [], retentionHours = 24) {
    const ids = [...new Set(rideIds.map(text).filter(Boolean))];
    if (ids.length === 0) return { ok: true, affected: 0 };
    return this.withClient(async (client) => {
      await client.query("begin");
      try {
        const result = await client.query(
          `update rides set deleted_at = now(), trashed_at = now(),
             trash_delete_at = now() + ($2::text || ' hours')::interval
           where ride_id = any($1::text[]) and source_type in ('OTS','WhatsApp','PreBook')
           returning ride_id, coalesce(source_expires_at, now() + interval '1 year') as tombstone_expires_at`,
          [ids, retentionHours]
        );
        for (const row of result.rows) {
          await client.query(
            `insert into job_source_tombstones (ride_id, expires_at) values ($1,$2)
             on conflict (ride_id) do update set expires_at = excluded.expires_at`,
            [row.ride_id, row.tombstone_expires_at]
          );
        }
        await client.query("commit");
        return { ok: true, affected: result.rowCount, rideIds: result.rows.map((row) => row.ride_id) };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async restoreJobs(rideIds = []) {
    const ids = [...new Set(rideIds.map(text).filter(Boolean))];
    if (ids.length === 0) return { ok: true, affected: 0 };
    return this.withClient(async (client) => {
      await client.query("begin");
      try {
        await client.query("delete from job_source_tombstones where ride_id = any($1::text[])", [ids]);
        const result = await client.query(
          `update rides set deleted_at = null, trashed_at = null, trash_delete_at = null
           where ride_id = any($1::text[]) and trash_delete_at > now() returning ride_id`,
          [ids]
        );
        await client.query("commit");
        return { ok: true, affected: result.rowCount, rideIds: result.rows.map((row) => row.ride_id) };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async replaceLinks(links = []) {
    return this.withClient(async (client) => {
      await client.query("begin");
      try {
        await client.query("delete from linked_rides where status = 'Linker Opportunity'");
        for (const link of links) {
          await client.query(
            `insert into linked_rides (
               link_id, first_ride_id, second_ride_id, previous_drop, next_pickup,
               time_gap, distance_between, saving_estimate, status, anchor_ride_id,
               candidate_ride_id, candidate_source, direction, time_gap_minutes,
               distance_miles, match_score, score_breakdown, match_reason, expires_at
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,'Linker Opportunity',$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,now() + interval '2 days')`,
            [
              link.linkId, link.firstRideId, link.secondRideId, link.previousDrop, link.nextPickup,
              link.timeGap, link.distanceBetween, link.savingEstimate, link.anchorRideId,
              link.candidateRideId, link.candidateSource, link.direction, link.timeGapMinutes,
              link.distanceMiles, link.score, JSON.stringify(link.scoreBreakdown), link.reason
            ]
          );
        }
        await client.query("commit");
        return { ok: true, count: links.length };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async listLinks() {
    return this.withClient(async (client) => {
      const result = await client.query(
        "select * from linked_rides where status = 'Linker Opportunity' and deleted_at is null order by match_score desc, time_gap_minutes asc limit 1000"
      );
      return result.rows.map(mapLink);
    });
  }
}

module.exports = { JobLinkerRepository, mapJob, mapLink, mapWorkspaceBid, prepareSourceJob };
