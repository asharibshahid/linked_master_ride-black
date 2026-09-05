const { createDatabaseClient } = require("./client");
const { parsePickupDateTime } = require("../sheets/upcomingJobs");
const { buildSheetRowObject } = require("../extraction/schemas");
const { parseNumericCell } = require("../bids/finalBid");
const { safeString } = require("../config/env");

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeStatus(value) {
  return toCell(value).toLowerCase();
}

function toNumber(value) {
  const parsed = parseNumericCell(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(value) {
  const text = toCell(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function resolveRideId(record = {}) {
  return toCell(record.Refer || record.refer || record["Ride ID"] || record.ride_id);
}

function resolvePickupAt(record = {}, timeZone = "Europe/London") {
  const date = toCell(record["Pickup Day & Date"] || record.pickup_day_date || record.Date);
  const time = toCell(record["Starting Timing"] || record.starting_timing || record.Time);
  const parsed = parsePickupDateTime(date, time, { timeZone });
  return parsed ? parsed.toISOString() : null;
}

function mapRideInput(record = {}, options = {}) {
  const sheetRecord = buildSheetRowObject(record);
  const rideId = resolveRideId(sheetRecord);
  const pickupAt = resolvePickupAt(sheetRecord, options.timeZone);
  return {
    ride_id: rideId,
    refer: rideId,
    source_type: options.sourceType || (toCell(sheetRecord["Group Name"]).toLowerCase().includes("ots") ? "OTS" : "WhatsApp"),
    group_name: sheetRecord["Group Name"],
    source_name: sheetRecord["Source Name"],
    source_time: toIsoOrNull(record.source_time || record.sourceTime || sheetRecord["Source Time"]),
    pickup_day_date: sheetRecord["Pickup Day & Date"],
    starting_timing: sheetRecord["Starting Timing"],
    pickup: sheetRecord.Pickup,
    drop_off: sheetRecord["Drop Off"],
    distance: sheetRecord.Distance,
    fare: toNumber(sheetRecord.Fare),
    required_vehicle: sheetRecord["Required Vehicle"],
    payment_status: sheetRecord["Payment Status"],
    pickup_at: pickupAt,
    status: options.status || "New",
    retention_class: options.retentionClass || "operational",
    review_reason: options.reviewReason || "",
    original_message: options.originalMessage || ""
  };
}

function rideDbToSheet(row = {}) {
  return {
    Refer: toCell(row.refer || row.ride_id),
    "Group Name": toCell(row.group_name),
    "Source Name": toCell(row.source_name),
    "Source Time": row.source_time ? new Date(row.source_time).toISOString() : "",
    "Pickup Day & Date": toCell(row.pickup_day_date),
    "Starting Timing": toCell(row.starting_timing),
    Pickup: toCell(row.pickup),
    "Drop Off": toCell(row.drop_off),
    Distance: toCell(row.distance),
    Fare: row.fare === null || row.fare === undefined ? "" : String(row.fare),
    "Required Vehicle": toCell(row.required_vehicle),
    "Payment Status": toCell(row.payment_status),
    Status: toCell(row.status),
    "Assigned Driver": toCell(row.assigned_driver_id),
    "Assigned Vehicle": toCell(row.assigned_vehicle_id),
    "Bid Score": row.bid_score === null || row.bid_score === undefined ? "" : String(row.bid_score),
    Reason: toCell(row.final_bid_reason || row.review_reason),
    "Passenger Count": toCell(row.passenger_count),
    "Calendar Status": toCell(row.calendar_status),
    "Calendar Event ID": toCell(row.calendar_event_id),
    "Calendar Created Time": row.calendar_created_time ? new Date(row.calendar_created_time).toISOString() : "",
    "Calendar Error": toCell(row.calendar_error),
    "Created Time": row.created_at ? new Date(row.created_at).toISOString() : ""
  };
}

function driverDbToSheet(row = {}) {
  return {
    "Driver ID": toCell(row.driver_id),
    "Driver Name": toCell(row.driver_name),
    "WhatsApp Number": toCell(row.whatsapp_number),
    Status: toCell(row.status),
    "Current Location": toCell(row.current_location),
    "Working Hours": toCell(row.working_hours),
    "Vehicle ID": ""
  };
}

function vehicleDbToSheet(row = {}) {
  return {
    "Vehicle ID": toCell(row.vehicle_id),
    "Vehicle Type": toCell(row.vehicle_type),
    Seats: row.seats === null || row.seats === undefined ? "" : String(row.seats),
    Registration: toCell(row.registration),
    "Driver ID": "",
    Status: toCell(row.status)
  };
}

function recommendationDbToSheet(row = {}) {
  return {
    "Ride ID": toCell(row.ride_id),
    Pickup: toCell(row.pickup),
    "Drop Off": toCell(row.drop_off),
    "Required Vehicle": toCell(row.required_vehicle),
    "Recommended Driver": toCell(row.recommended_driver_id),
    "Recommended Vehicle": toCell(row.recommended_vehicle_id),
    "Linked Ride ID": toCell(row.linked_ride_id),
    "Previous Ride": toCell(row.previous_ride),
    "Next Ride": toCell(row.next_ride),
    "Time Gap": toCell(row.time_gap),
    "Distance Between": toCell(row.distance_between),
    "Estimated Saving": row.estimated_saving === null || row.estimated_saving === undefined ? "" : String(row.estimated_saving),
    Score: row.score === null || row.score === undefined ? "" : String(row.score),
    Reason: toCell(row.reason),
    "Created Time": row.created_at ? new Date(row.created_at).toISOString() : "",
    Status: toCell(row.status),
    "Assignment Status": toCell(row.assignment_status)
  };
}

function driverScheduleDbToSheet(row = {}) {
  return {
    "Assignment ID": toCell(row.assignment_id),
    "Driver ID": toCell(row.driver_id),
    "Ride ID": toCell(row.ride_id),
    Pickup: toCell(row.pickup),
    "Drop Off": toCell(row.drop_off),
    "Start Time": row.start_time ? new Date(row.start_time).toISOString() : "",
    "End Time": row.end_time ? new Date(row.end_time).toISOString() : "",
    Status: toCell(row.status),
    "Next Available Time": row.next_available_time ? new Date(row.next_available_time).toISOString() : "",
    "Current Location": toCell(row.current_location),
    "Previous Ride ID": toCell(row.previous_ride_id),
    "Next Ride ID": toCell(row.next_ride_id)
  };
}

function vehicleScheduleDbToSheet(row = {}) {
  return {
    "Vehicle ID": toCell(row.vehicle_id),
    "Ride ID": toCell(row.ride_id),
    "Driver ID": toCell(row.driver_id),
    "Start Time": row.start_time ? new Date(row.start_time).toISOString() : "",
    "End Time": row.end_time ? new Date(row.end_time).toISOString() : "",
    Status: toCell(row.status)
  };
}

function linkedRideDbToSheet(row = {}) {
  return {
    "Link ID": toCell(row.link_id),
    "First Ride ID": toCell(row.first_ride_id),
    "Second Ride ID": toCell(row.second_ride_id),
    "Driver ID": toCell(row.driver_id),
    "Vehicle ID": toCell(row.vehicle_id),
    "Previous Drop": toCell(row.previous_drop),
    "Next Pickup": toCell(row.next_pickup),
    "Time Gap": toCell(row.time_gap),
    "Distance Between": toCell(row.distance_between),
    "Saving Estimate": row.saving_estimate === null || row.saving_estimate === undefined ? "" : String(row.saving_estimate),
    Status: toCell(row.status),
    "Created Time": row.created_at ? new Date(row.created_at).toISOString() : ""
  };
}

function detectBidSource(row = {}) {
  const text = `${toCell(row.source)} ${toCell(row.group_name)} ${toCell(row.source_name)}`.toLowerCase();
  if (text.includes("ots")) return "OTS";
  if (text.includes("whatsapp") || toCell(row.group_name)) return "WhatsApp";
  return "Other";
}

function bidDbToSheet(row = {}) {
  return {
    "Ride ID": toCell(row.ride_id),
    Source: detectBidSource(row),
    "Bid Type": toCell(row.bid_type),
    Pickup: toCell(row.pickup),
    "Drop Off": toCell(row.drop_off),
    Fare: row.fare === null || row.fare === undefined ? "" : String(row.fare),
    "Required Vehicle": toCell(row.required_vehicle),
    "Bid Amount": row.bid_amount === null || row.bid_amount === undefined ? "" : String(row.bid_amount),
    Reason: toCell(row.reason),
    "Estimated Cost": row.estimated_cost === null || row.estimated_cost === undefined ? "" : String(row.estimated_cost),
    "Estimated Profit": row.estimated_profit === null || row.estimated_profit === undefined ? "" : String(row.estimated_profit),
    "Margin %": row.margin_percent === null || row.margin_percent === undefined ? "" : String(row.margin_percent),
    "Linked Saving": row.linked_saving === null || row.linked_saving === undefined ? "" : String(row.linked_saving),
    "AI Decision": toCell(row.ai_decision),
    "Pricing Confidence": toCell(row.pricing_confidence),
    "Bid Status": toCell(row.bid_status),
    "Admin Status": toCell(row.admin_status),
    "Created Time": row.created_at ? new Date(row.created_at).toISOString() : "",
    "Updated Time": row.updated_at ? new Date(row.updated_at).toISOString() : ""
  };
}

class DispatchDatabaseRepository {
  constructor(options = {}) {
    this.databaseUrl = safeString(options.databaseUrl);
    this.ssl = options.ssl;
    this.timeZone = options.timeZone || "Europe/London";
  }

  async withClient(fn) {
    const client = createDatabaseClient({
      databaseUrl: this.databaseUrl,
      ssl: this.ssl
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async resolveNextId(client, tableName, columnName, prefix) {
    const result = await client.query(
      `select ${columnName} as id from ${tableName} where deleted_at is null`
    );
    const maxId = result.rows.reduce((max, row) => {
      const match = toCell(row.id).match(/(\d+)$/);
      if (!match) return max;
      return Math.max(max, Number(match[1]));
    }, 0);
    return `${prefix}${String(maxId + 1).padStart(3, "0")}`;
  }

  async resolveExistingRideLink(client, rideId) {
    const cleanRideId = toCell(rideId);
    if (!cleanRideId) return null;
    const result = await client.query(
      "select ride_id from rides where ride_id = $1 and deleted_at is null limit 1",
      [cleanRideId]
    );
    return result.rows.length > 0 ? cleanRideId : null;
  }

  async upsertRide(record = {}, options = {}) {
    const ride = mapRideInput(record, { ...options, timeZone: this.timeZone });
    if (!ride.ride_id) throw new Error("DB ride_id is missing");

    return this.withClient(async (client) => {
      await client.query(
        `
          insert into rides (
            ride_id, refer, source_type, group_name, source_name, source_time,
            pickup_day_date, starting_timing, pickup, drop_off, distance, fare,
            required_vehicle, payment_status, status, retention_class, review_reason,
            original_message, pickup_at
          ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
          )
          on conflict (ride_id) do update set
            group_name = excluded.group_name,
            source_name = excluded.source_name,
            source_time = coalesce(excluded.source_time, rides.source_time),
            pickup_day_date = excluded.pickup_day_date,
            starting_timing = excluded.starting_timing,
            pickup = excluded.pickup,
            drop_off = excluded.drop_off,
            distance = excluded.distance,
            fare = excluded.fare,
            required_vehicle = excluded.required_vehicle,
            payment_status = excluded.payment_status,
            status = case
              when rides.status in ('Approved', 'Assigned', 'Completed', 'Rejected') then rides.status
              else excluded.status
            end,
            retention_class = excluded.retention_class,
            review_reason = coalesce(nullif(excluded.review_reason, ''), rides.review_reason),
            original_message = coalesce(nullif(excluded.original_message, ''), rides.original_message),
            pickup_at = coalesce(excluded.pickup_at, rides.pickup_at),
            deleted_at = null
        `,
        [
          ride.ride_id,
          ride.refer,
          ride.source_type,
          ride.group_name,
          ride.source_name,
          ride.source_time,
          ride.pickup_day_date,
          ride.starting_timing,
          ride.pickup,
          ride.drop_off,
          ride.distance,
          ride.fare,
          ride.required_vehicle,
          ride.payment_status,
          ride.status,
          ride.retention_class,
          ride.review_reason,
          ride.original_message,
          ride.pickup_at
        ]
      );
      return { ok: true, rideId: ride.ride_id };
    });
  }

  async markNeedsReview(record = {}, reason = "") {
    return this.upsertRide(record, {
      status: "Needs Review",
      retentionClass: "operational",
      reviewReason: reason
    });
  }

  async markFinalBid(record = {}) {
    const rideId = resolveRideId(record);
    if (!rideId) throw new Error("DB Final Bid ride_id is missing");
    const base = mapRideInput(record, { status: "Final Bid", timeZone: this.timeZone });
    return this.withClient(async (client) => {
      await client.query(
        `
          insert into rides (
            ride_id, refer, source_type, group_name, source_name,
            pickup_day_date, starting_timing, pickup, drop_off, distance, fare,
            required_vehicle, payment_status, status, final_bid_status, bid_score,
            final_bid_reason, passenger_count, calendar_status, calendar_event_id,
            calendar_created_time, calendar_error, pickup_at
          ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Final Bid',$14,$15,$16,$17,$18,$19,$20,$21,$22
          )
          on conflict (ride_id) do update set
            final_bid_status = coalesce(nullif(excluded.final_bid_status, ''), rides.final_bid_status, 'Pending'),
            status = case
              when rides.status in ('Assigned', 'Completed', 'Rejected') then rides.status
              else 'Final Bid'
            end,
            bid_score = excluded.bid_score,
            final_bid_reason = excluded.final_bid_reason,
            passenger_count = excluded.passenger_count,
            calendar_status = coalesce(nullif(excluded.calendar_status, ''), rides.calendar_status),
            calendar_event_id = coalesce(nullif(excluded.calendar_event_id, ''), rides.calendar_event_id),
            calendar_created_time = coalesce(excluded.calendar_created_time, rides.calendar_created_time),
            calendar_error = coalesce(nullif(excluded.calendar_error, ''), rides.calendar_error),
            pickup_at = coalesce(excluded.pickup_at, rides.pickup_at),
            deleted_at = null
        `,
        [
          rideId,
          rideId,
          base.source_type,
          base.group_name,
          base.source_name,
          base.pickup_day_date,
          base.starting_timing,
          base.pickup,
          base.drop_off,
          base.distance,
          base.fare,
          base.required_vehicle,
          base.payment_status,
          toCell(record.Status || "Pending"),
          toNumber(record["Bid Score"]),
          toCell(record.Reason),
          toCell(record["Passenger Count"]),
          toCell(record["Calendar Status"]),
          toCell(record["Calendar Event ID"]),
          toIsoOrNull(record["Calendar Created Time"]),
          toCell(record["Calendar Error"]),
          base.pickup_at
        ]
      );
      return { ok: true, rideId };
    });
  }

  async upsertDriver(record = {}) {
    const requestedDriverId = toCell(record.driverId || record.driver_id || record["Driver ID"]);
    const driverName = toCell(record.driverName || record.driver_name || record["Driver Name"]);
    if (!driverName) throw new Error("Driver Name is required");
    return this.withClient(async (client) => {
      const driverId = requestedDriverId || await this.resolveNextId(client, "drivers", "driver_id", "D-");
      await client.query(
        `
          insert into drivers (
            driver_id, driver_name, whatsapp_number, status, current_location, working_hours
          ) values ($1,$2,$3,$4,$5,$6)
          on conflict (driver_id) do update set
            driver_name = excluded.driver_name,
            whatsapp_number = excluded.whatsapp_number,
            status = excluded.status,
            current_location = excluded.current_location,
            working_hours = excluded.working_hours,
            deleted_at = null
        `,
        [
          driverId,
          driverName,
          toCell(record.whatsappNumber || record.whatsapp_number || record["WhatsApp Number"]),
          toCell(record.status || record.Status || "Available"),
          toCell(record.currentLocation || record.current_location || record["Current Location"]),
          toCell(record.workingHours || record.working_hours || record["Working Hours"] || "Any")
        ]
      );
      return { ok: true, key: driverId, value: toCell(record.status || record.Status || "Available") };
    });
  }

  async upsertVehicle(record = {}) {
    const requestedVehicleId = toCell(record.vehicleId || record.vehicle_id || record["Vehicle ID"]);
    const vehicleType = toCell(record.vehicleType || record.vehicle_type || record["Vehicle Type"]);
    if (!vehicleType) throw new Error("Vehicle Type is required");
    return this.withClient(async (client) => {
      const vehicleId = requestedVehicleId || await this.resolveNextId(client, "vehicles", "vehicle_id", "V-");
      await client.query(
        `
          insert into vehicles (
            vehicle_id, vehicle_type, seats, registration, status, current_location
          ) values ($1,$2,$3,$4,$5,$6)
          on conflict (vehicle_id) do update set
            vehicle_type = excluded.vehicle_type,
            seats = excluded.seats,
            registration = excluded.registration,
            status = excluded.status,
            current_location = excluded.current_location,
            deleted_at = null
        `,
        [
          vehicleId,
          vehicleType,
          toNumber(record.seats || record.Seats),
          toCell(record.registration || record.Registration),
          toCell(record.status || record.Status || "Available"),
          toCell(record.currentLocation || record.current_location || record["Current Location"])
        ]
      );
      return { ok: true, key: vehicleId, value: toCell(record.status || record.Status || "Available") };
    });
  }

  async updateDriverStatus(driverId, status) {
    return this.withClient(async (client) => {
      await client.query(
        "update drivers set status = $2 where driver_id = $1 and deleted_at is null",
        [toCell(driverId), toCell(status)]
      );
      return { ok: true, key: toCell(driverId), value: toCell(status) };
    });
  }

  async updateVehicleStatus(vehicleId, status) {
    return this.withClient(async (client) => {
      await client.query(
        "update vehicles set status = $2 where vehicle_id = $1 and deleted_at is null",
        [toCell(vehicleId), toCell(status)]
      );
      return { ok: true, key: toCell(vehicleId), value: toCell(status) };
    });
  }

  async upsertBid(record = {}) {
    const rideId = toCell(record["Ride ID"] || record.rideId || record.ride_id);
    if (!rideId) throw new Error("DB bid ride_id is missing");
    const bidType = toCell(record["Bid Type"] || record.bidType || record.bid_type || "Manual Bid Review");
    const bidStatus = toCell(record["Bid Status"] || record.bidStatus || record.bid_status || "Suggested");
    const adminStatus = toCell(record["Admin Status"] || record.adminStatus || record.admin_status || "Pending");
    const bidAmount = toNumber(record["Bid Amount"] || record.bidAmount || record.bid_amount);
    const reason = toCell(record.Reason || record.reason);
    const estimatedCost = toNumber(record["Estimated Cost"] || record.estimatedCost || record.estimated_cost);
    const estimatedProfit = toNumber(record["Estimated Profit"] || record.estimatedProfit || record.estimated_profit);
    const marginPercent = toNumber(record["Margin %"] || record.marginPercent || record.margin_percent);
    const linkedSaving = toNumber(record["Linked Saving"] || record.linkedSaving || record.linked_saving);
    const aiDecision = toCell(record["AI Decision"] || record.aiDecision || record.ai_decision);
    const pricingConfidence = toCell(record["Pricing Confidence"] || record.pricingConfidence || record.pricing_confidence);
    const pricingPayload = record.pricingPayload || record.pricing_payload || null;

    return this.withClient(async (client) => {
      const update = await client.query(
        `
          update bids
          set bid_type = $2,
              bid_status = $3,
              admin_status = $4,
              bid_amount = $5,
              reason = $6,
              estimated_cost = $7,
              estimated_profit = $8,
              margin_percent = $9,
              linked_saving = $10,
              ai_decision = $11,
              pricing_confidence = $12,
              pricing_payload = $13::jsonb,
              updated_at = now(),
              deleted_at = null
          where ride_id = $1
            and deleted_at is null
        `,
        [rideId, bidType, bidStatus, adminStatus, bidAmount, reason, estimatedCost, estimatedProfit, marginPercent, linkedSaving, aiDecision, pricingConfidence, pricingPayload ? JSON.stringify(pricingPayload) : null]
      );

      if (update.rowCount === 0) {
        await client.query(
          `
            insert into bids (
              ride_id, bid_type, bid_status, admin_status, bid_amount, reason,
              estimated_cost, estimated_profit, margin_percent, linked_saving,
              ai_decision, pricing_confidence, pricing_payload
            ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
          `,
          [rideId, bidType, bidStatus, adminStatus, bidAmount, reason, estimatedCost, estimatedProfit, marginPercent, linkedSaving, aiDecision, pricingConfidence, pricingPayload ? JSON.stringify(pricingPayload) : null]
        );
      }

      return {
        ok: true,
        header: "Bid Status",
        key: rideId,
        oldValue: "",
        value: bidStatus,
        record
      };
    });
  }

  async updateBidAdminStatus({ rideId, adminStatus, bidAmount, reason } = {}) {
    const cleanRideId = toCell(rideId);
    const cleanAdminStatus = toCell(adminStatus || "Pending");
    const nextBidStatus = cleanAdminStatus === "Approved" ? "Approved" : undefined;
    if (!cleanRideId) throw new Error("DB bid ride_id is missing");

    return this.withClient(async (client) => {
      const update = await client.query(
        `
          update bids
          set admin_status = $2,
              bid_status = coalesce($3, bid_status),
              bid_amount = coalesce($4, bid_amount),
              reason = coalesce(nullif($5, ''), reason),
              updated_at = now(),
              deleted_at = null
          where ride_id = $1
            and deleted_at is null
        `,
        [
          cleanRideId,
          cleanAdminStatus,
          nextBidStatus || null,
          bidAmount === undefined ? null : toNumber(bidAmount),
          reason === undefined ? "" : toCell(reason)
        ]
      );

      if (update.rowCount === 0) {
        await client.query(
          `
            insert into bids (
              ride_id, bid_type, bid_status, admin_status, bid_amount, reason
            ) values ($1,'OTS Bid Review',$2,$3,$4,$5)
          `,
          [
            cleanRideId,
            nextBidStatus || "Suggested",
            cleanAdminStatus,
            bidAmount === undefined ? null : toNumber(bidAmount),
            reason === undefined ? "" : toCell(reason)
          ]
        );
      }

      return {
        ok: true,
        updates: [
          {
            header: "Admin Status",
            key: cleanRideId,
            oldValue: "",
            value: cleanAdminStatus
          },
          ...(nextBidStatus
            ? [{
                header: "Bid Status",
                key: cleanRideId,
                oldValue: "",
                value: nextBidStatus
              }]
            : [])
        ]
      };
    });
  }

  async updateBidStatus({ rideId, bidStatus, bidAmount, reason } = {}) {
    const cleanRideId = toCell(rideId);
    const cleanBidStatus = toCell(bidStatus || "Suggested");
    if (!cleanRideId) throw new Error("DB bid ride_id is missing");

    return this.withClient(async (client) => {
      const update = await client.query(
        `
          update bids
          set bid_status = $2,
              bid_amount = coalesce($3, bid_amount),
              reason = coalesce(nullif($4, ''), reason),
              updated_at = now(),
              deleted_at = null
          where ride_id = $1
            and deleted_at is null
        `,
        [
          cleanRideId,
          cleanBidStatus,
          bidAmount === undefined ? null : toNumber(bidAmount),
          reason === undefined ? "" : toCell(reason)
        ]
      );

      if (update.rowCount === 0) {
        await client.query(
          `
            insert into bids (
              ride_id, bid_type, bid_status, admin_status, bid_amount, reason
            ) values ($1,'OTS Bid Review',$2,'Pending',$3,$4)
          `,
          [
            cleanRideId,
            cleanBidStatus,
            bidAmount === undefined ? null : toNumber(bidAmount),
            reason === undefined ? "" : toCell(reason)
          ]
        );
      }

      return {
        ok: true,
        updates: [{
          header: "Bid Status",
          key: cleanRideId,
          oldValue: "",
          value: cleanBidStatus
        }]
      };
    });
  }

  async loadApprovedBidRows() {
    return this.withClient(async (client) => {
      const result = await client.query(
        `
          select
            b.*,
            r.group_name,
            r.source_name,
            r.pickup,
            r.drop_off,
            r.fare,
            r.required_vehicle
          from bids b
          left join rides r on r.ride_id = b.ride_id and r.deleted_at is null
          where b.deleted_at is null
            and lower(b.admin_status) = 'approved'
            and lower(b.bid_status) in ('approved', 'suggested')
          order by b.updated_at asc
          limit 100
        `
      );
      return result.rows.map(bidDbToSheet);
    });
  }

  async getBidRecord(rideId) {
    const cleanRideId = toCell(rideId);
    if (!cleanRideId) throw new Error("DB bid ride_id is missing");
    return this.withClient(async (client) => {
      const result = await client.query(
        `
          select b.*, r.group_name, r.source_name, r.pickup, r.drop_off,
                 r.fare, r.required_vehicle, r.distance
          from bids b
          left join rides r on r.ride_id = b.ride_id and r.deleted_at is null
          where b.ride_id = $1 and b.deleted_at is null
          order by b.updated_at desc
          limit 1
        `,
        [cleanRideId]
      );
      if (result.rowCount === 0) throw new Error(`Bid not found: ${cleanRideId}`);
      const record = bidDbToSheet(result.rows[0]);
      record.Distance = toCell(result.rows[0].distance);
      record.pricingPayload = result.rows[0].pricing_payload || null;
      return record;
    });
  }

  async upsertRecommendation(record = {}) {
    const rideId = toCell(record["Ride ID"] || record.ride_id);
    if (!rideId) throw new Error("DB recommendation ride_id is missing");
    return this.withClient(async (client) => {
      await client.query(
        `
          delete from driver_recommendations
          where ride_id = $1
            and recommended_driver_id = $2
            and recommended_vehicle_id = $3
            and status in ('Pending', 'Suggested')
        `,
        [rideId, toCell(record["Recommended Driver"]), toCell(record["Recommended Vehicle"])]
      );
      await client.query(
        `
          insert into driver_recommendations (
            ride_id, pickup, drop_off, required_vehicle, recommended_driver_id,
            recommended_vehicle_id, linked_ride_id, previous_ride, next_ride,
            time_gap, distance_between, estimated_saving, score, reason,
            created_at, status, assignment_status
          ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,coalesce($15::timestamptz, now()),$16,$17
          )
        `,
        [
          rideId,
          toCell(record.Pickup),
          toCell(record["Drop Off"]),
          toCell(record["Required Vehicle"]),
          toCell(record["Recommended Driver"]),
          toCell(record["Recommended Vehicle"]),
          toCell(record["Linked Ride ID"]),
          toCell(record["Previous Ride"]),
          toCell(record["Next Ride"]),
          toCell(record["Time Gap"]),
          toCell(record["Distance Between"]),
          toNumber(record["Estimated Saving"]),
          toNumber(record.Score),
          toCell(record.Reason),
          toIsoOrNull(record["Created Time"]),
          toCell(record.Status || "Pending"),
          toCell(record["Assignment Status"] || "Pending")
        ]
      );
      return { ok: true, rideId };
    });
  }

  async upsertLinkedRide(record = {}) {
    const linkId = toCell(record["Link ID"] || record.link_id);
    if (!linkId) throw new Error("DB linked ride link_id is missing");
    return this.withClient(async (client) => {
      await client.query(
        `
          insert into linked_rides (
            link_id, first_ride_id, second_ride_id, driver_id, vehicle_id,
            previous_drop, next_pickup, time_gap, distance_between, saving_estimate, status
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          on conflict (link_id) do update set
            first_ride_id = excluded.first_ride_id,
            second_ride_id = excluded.second_ride_id,
            driver_id = excluded.driver_id,
            vehicle_id = excluded.vehicle_id,
            previous_drop = excluded.previous_drop,
            next_pickup = excluded.next_pickup,
            time_gap = excluded.time_gap,
            distance_between = excluded.distance_between,
            saving_estimate = excluded.saving_estimate,
            status = excluded.status,
            deleted_at = null
        `,
        [
          linkId,
          toCell(record["First Ride ID"]),
          toCell(record["Second Ride ID"]),
          toCell(record["Driver ID"]),
          toCell(record["Vehicle ID"]),
          toCell(record["Previous Drop"]),
          toCell(record["Next Pickup"]),
          toCell(record["Time Gap"]),
          toCell(record["Distance Between"]),
          toNumber(record["Saving Estimate"]),
          toCell(record.Status || "Open")
        ]
      );
      return { ok: true, linkId };
    });
  }

  async markRecommendationAssignmentStatus(rideId, status) {
    return this.withClient(async (client) => {
      await client.query(
        `
          update driver_recommendations
          set assignment_status = $2,
              status = case when $2 = 'Assigned' then 'Approved' else status end
          where ride_id = $1
            and deleted_at is null
        `,
        [toCell(rideId), toCell(status)]
      );
      return { ok: true, rideId: toCell(rideId), status: toCell(status) };
    });
  }

  async approveRecommendation(rideId) {
    return this.withClient(async (client) => {
      await client.query(
        `
          update driver_recommendations
          set status = 'Approved',
              assignment_status = case
                when assignment_status in ('Assigned', 'Failed') then assignment_status
                else 'Pending'
              end
          where ride_id = $1
            and deleted_at is null
        `,
        [toCell(rideId)]
      );
      return { ok: true, rideId: toCell(rideId) };
    });
  }

  async updateFinalBidStatus(rideId, status) {
    const cleanStatus = toCell(status || "Pending");
    return this.withClient(async (client) => {
      await client.query(
        `
          update rides
          set final_bid_status = $2,
              status = case
                when $2 = 'Approved' then 'Approved'
                when $2 = 'Rejected' then 'Rejected'
                else 'Final Bid'
              end
          where ride_id = $1
            and deleted_at is null
        `,
        [toCell(rideId), cleanStatus]
      );
      return { ok: true, rideId: toCell(rideId), status: cleanStatus };
    });
  }

  async assignRide({ rideId, driverId, vehicleId, driverSchedule, vehicleSchedule } = {}) {
    const cleanRideId = toCell(rideId);
    if (!cleanRideId) throw new Error("DB assignment ride_id is missing");
    return this.withClient(async (client) => {
      await client.query("begin");
      try {
        await client.query(
          `
            update rides
            set assigned_driver_id = $2,
                assigned_vehicle_id = $3,
                status = 'Assigned',
                final_bid_status = 'Approved'
            where ride_id = $1
              and deleted_at is null
          `,
          [cleanRideId, toCell(driverId), toCell(vehicleId)]
        );

        if (driverSchedule) {
          const previousRideId = await this.resolveExistingRideLink(
            client,
            driverSchedule["Previous Ride ID"]
          );
          const nextRideId = await this.resolveExistingRideLink(
            client,
            driverSchedule["Next Ride ID"]
          );

          await client.query(
            `
              insert into driver_schedule (
                assignment_id, driver_id, ride_id, pickup, drop_off, start_time, end_time,
                status, next_available_time, current_location, previous_ride_id, next_ride_id
              ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
              on conflict (assignment_id) do update set
                driver_id = excluded.driver_id,
                ride_id = excluded.ride_id,
                pickup = excluded.pickup,
                drop_off = excluded.drop_off,
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                status = excluded.status,
                next_available_time = excluded.next_available_time,
                current_location = excluded.current_location,
                previous_ride_id = excluded.previous_ride_id,
                next_ride_id = excluded.next_ride_id,
                deleted_at = null
            `,
            [
              toCell(driverSchedule["Assignment ID"]),
              toCell(driverSchedule["Driver ID"]),
              toCell(driverSchedule["Ride ID"]),
              toCell(driverSchedule.Pickup),
              toCell(driverSchedule["Drop Off"]),
              toIsoOrNull(driverSchedule["Start Time"]),
              toIsoOrNull(driverSchedule["End Time"]),
              toCell(driverSchedule.Status || "Assigned"),
              toIsoOrNull(driverSchedule["Next Available Time"]),
              toCell(driverSchedule["Current Location"]),
              previousRideId,
              nextRideId
            ]
          );
        }

        if (vehicleSchedule) {
          await client.query(
            `
              insert into vehicle_schedule (
                vehicle_id, ride_id, driver_id, start_time, end_time, status
              ) values ($1,$2,$3,$4,$5,$6)
              on conflict (vehicle_id, ride_id) do update set
                driver_id = excluded.driver_id,
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                status = excluded.status,
                deleted_at = null
            `,
            [
              toCell(vehicleSchedule["Vehicle ID"]),
              toCell(vehicleSchedule["Ride ID"]),
              toCell(vehicleSchedule["Driver ID"]),
              toIsoOrNull(vehicleSchedule["Start Time"]),
              toIsoOrNull(vehicleSchedule["End Time"]),
              toCell(vehicleSchedule.Status || "Assigned")
            ]
          );
        }

        if (driverId) {
          await client.query(
            "update drivers set current_location = coalesce($2, current_location), status = 'Busy' where driver_id = $1",
            [toCell(driverId), toCell(driverSchedule?.["Current Location"]) || null]
          );
        }
        if (vehicleId) {
          await client.query("update vehicles set status = 'Busy' where vehicle_id = $1", [toCell(vehicleId)]);
        }

        await client.query("commit");
        return { ok: true, rideId: cleanRideId };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async completeRideSchedules({ rideId, driverId, vehicleId, currentLocation } = {}) {
    const cleanRideId = toCell(rideId);
    if (!cleanRideId) throw new Error("DB schedule completion ride_id is missing");

    return this.withClient(async (client) => {
      await client.query("begin");
      try {
        const driverScheduleResult = await client.query(
          `
            update driver_schedule
            set status = 'Completed',
                is_protected = false
            where ride_id = $1
              and deleted_at is null
              and lower(coalesce(status, '')) not in ('completed', 'rejected', 'cancelled', 'canceled', 'failed')
            returning driver_id, drop_off, current_location
          `,
          [cleanRideId]
        );
        const vehicleScheduleResult = await client.query(
          `
            update vehicle_schedule
            set status = 'Completed',
                is_protected = false
            where ride_id = $1
              and deleted_at is null
              and lower(coalesce(status, '')) not in ('completed', 'rejected', 'cancelled', 'canceled', 'failed')
            returning vehicle_id, driver_id
          `,
          [cleanRideId]
        );

        const scheduledDriver = driverScheduleResult.rows[0] || {};
        const scheduledVehicle = vehicleScheduleResult.rows[0] || {};
        const resolvedDriverId = toCell(driverId || scheduledDriver.driver_id || scheduledVehicle.driver_id);
        const resolvedVehicleId = toCell(vehicleId || scheduledVehicle.vehicle_id);
        const resolvedLocation = toCell(currentLocation || scheduledDriver.drop_off || scheduledDriver.current_location);

        await client.query(
          `
            update rides
            set status = 'Completed',
                final_bid_status = case when final_bid_status is null then null else 'Completed' end
            where ride_id = $1
              and deleted_at is null
          `,
          [cleanRideId]
        );
        if (resolvedDriverId) {
          await client.query(
            "update drivers set status = 'Available', current_location = coalesce($2, current_location) where driver_id = $1 and deleted_at is null",
            [resolvedDriverId, resolvedLocation || null]
          );
        }
        if (resolvedVehicleId) {
          await client.query(
            "update vehicles set status = 'Available' where vehicle_id = $1 and deleted_at is null",
            [resolvedVehicleId]
          );
        }

        await client.query("commit");
        return {
          ok: true,
          rideId: cleanRideId,
          driverId: resolvedDriverId,
          vehicleId: resolvedVehicleId,
          currentLocation: resolvedLocation
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  async loadDashboardData() {
    return this.withClient(async (client) => {
      const rides = await client.query(
        "select * from rides where deleted_at is null order by created_at desc limit 500"
      );
      const drivers = await client.query("select * from drivers where deleted_at is null order by driver_id limit 500");
      const vehicles = await client.query("select * from vehicles where deleted_at is null order by vehicle_id limit 500");
      const recommendations = await client.query(
        "select * from driver_recommendations where deleted_at is null order by created_at desc limit 500"
      );
      const driverSchedule = await client.query(
        "select * from driver_schedule where deleted_at is null order by start_time limit 500"
      );
      const vehicleSchedule = await client.query(
        "select * from vehicle_schedule where deleted_at is null order by start_time limit 500"
      );
      const linkedRides = await client.query("select * from linked_rides where deleted_at is null order by created_at desc limit 500");
      const bids = await client.query(
        `
          select
            b.*,
            r.group_name,
            r.source_name,
            r.pickup,
            r.drop_off,
            r.fare,
            r.required_vehicle
          from bids b
          left join rides r on r.ride_id = b.ride_id and r.deleted_at is null
          where b.deleted_at is null
          order by b.updated_at desc
          limit 500
        `
      );
      const auditLogs = await client.query("select * from audit_logs where deleted_at is null order by created_at desc limit 200");

      const allRides = rides.rows.map(rideDbToSheet);
      const finalBid = rides.rows
        .filter((row) => toCell(row.final_bid_status) || ["Final Bid", "Approved", "Assigned", "Rejected"].includes(toCell(row.status)))
        .map((row) => ({
          ...rideDbToSheet(row),
          Status: toCell(row.final_bid_status || row.status || "Pending")
        }));
      const needsReview = rides.rows
        .filter((row) => normalizeStatus(row.status) === "needs review")
        .map((row) => ({
          ...rideDbToSheet(row),
          Reason: toCell(row.review_reason)
        }));
      const upcomingJobs = rides.rows
        .filter((row) => row.pickup_at && new Date(row.pickup_at).getTime() > Date.now())
        .map(rideDbToSheet);

      return {
        rides: allRides,
        needsReview,
        upcomingJobs,
        finalBid,
        recommendations: recommendations.rows.map(recommendationDbToSheet),
        drivers: drivers.rows.map(driverDbToSheet),
        vehicles: vehicles.rows.map(vehicleDbToSheet),
        driverSchedule: driverSchedule.rows.map(driverScheduleDbToSheet),
        vehicleSchedule: vehicleSchedule.rows.map(vehicleScheduleDbToSheet),
        linkedRides: linkedRides.rows.map(linkedRideDbToSheet),
        bidTracker: bids.rows.map(bidDbToSheet),
        auditLog: auditLogs.rows.map((row) => ({
          "Audit ID": toCell(row.audit_id),
          Action: toCell(row.action),
          "Target Type": toCell(row.target_type),
          "Target ID": toCell(row.target_id),
          Field: toCell(row.field),
          "Old Value": toCell(row.old_value),
          "New Value": toCell(row.new_value),
          Actor: toCell(row.actor),
          Status: toCell(row.status),
          "Created Time": row.created_at ? new Date(row.created_at).toISOString() : ""
        }))
      };
    });
  }
}

module.exports = {
  DispatchDatabaseRepository,
  mapRideInput,
  rideDbToSheet
};
