create table if not exists system_settings (
  setting_key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists job_source_tombstones (
  ride_id text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

insert into system_settings (setting_key, value)
values (
  'job_linker_criteria',
  '{
    "minFare": 80,
    "allowedVehicles": ["Saloon", "MPV", "6 Seater"],
    "allowedAreaCodes": ["AL","B","BA","BH","BL","BN","BR","BS","CB","CF","CM","CO","CR","CT","CV","DE","DN","DT","DY","E","EC","EN","EX","GL","GU","HA","HP","HR","HU","IP","KT","L","LE","LL","LN","LU","M","ME","MK","N","NE","NG","NN","NP","NR","NW","OX","PE","PL","PO","RG","RH","RM","S","SA","SE","SG","SK","SL","SN","SO","SP","ST","SW","TA","TN","TQ","TR","TS","TW","UB","W","WC","WR","WS","LHR","LGW","STN","LTN","LCY","SEN","BHX","MAN"],
    "areaMatchMode": "either",
    "maxLinkGapHours": 24,
    "minimumTurnaroundMinutes": 30,
    "expireAfterPickupHours": 12,
    "trashRetentionHours": 24
  }'::jsonb
)
on conflict (setting_key) do nothing;

alter table rides add column if not exists is_demo boolean not null default false;
alter table rides add column if not exists source_expires_at timestamptz;
alter table rides add column if not exists trashed_at timestamptz;
alter table rides add column if not exists trash_delete_at timestamptz;

alter table linked_rides add column if not exists anchor_ride_id text references rides(ride_id);
alter table linked_rides add column if not exists candidate_ride_id text references rides(ride_id);
alter table linked_rides add column if not exists candidate_source text;
alter table linked_rides add column if not exists direction text;
alter table linked_rides add column if not exists time_gap_minutes integer;
alter table linked_rides add column if not exists distance_miles numeric(10, 2);
alter table linked_rides add column if not exists match_score numeric(5, 2);
alter table linked_rides add column if not exists score_breakdown jsonb not null default '{}'::jsonb;
alter table linked_rides add column if not exists match_reason text;

create index if not exists idx_rides_source_active
  on rides (source_type, created_at desc) where deleted_at is null;
create index if not exists idx_rides_source_expiry
  on rides (source_expires_at) where deleted_at is null and is_protected = false;
create index if not exists idx_rides_trash_expiry
  on rides (trash_delete_at) where trashed_at is not null;
create index if not exists idx_linker_matches
  on linked_rides (anchor_ride_id, match_score desc) where status = 'Linker Opportunity';

drop trigger if exists trg_system_settings_updated_at on system_settings;
create trigger trg_system_settings_updated_at before update on system_settings
for each row execute function touch_updated_at();

create or replace function set_ride_source_expiry()
returns trigger
language plpgsql
as $$
declare
  expiry_hours numeric;
begin
  if new.pickup_at is not null
     and new.source_type in ('OTS', 'WhatsApp', 'PreBook')
     and new.source_expires_at is null then
    select coalesce((value->>'expireAfterPickupHours')::numeric, 12)
      into expiry_hours
      from system_settings
      where setting_key = 'job_linker_criteria';
    new.source_expires_at := new.pickup_at + (coalesce(expiry_hours, 12)::text || ' hours')::interval;
  end if;
  if exists (
    select 1 from job_source_tombstones
    where ride_id = new.ride_id and expires_at > now()
  ) then
    new.deleted_at := coalesce(new.deleted_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_rides_source_expiry on rides;
create trigger trg_rides_source_expiry before insert or update of pickup_at, source_type on rides
for each row execute function set_ride_source_expiry();

update rides
set source_expires_at = pickup_at + interval '12 hours'
where source_expires_at is null
  and pickup_at is not null
  and source_type in ('OTS', 'WhatsApp', 'PreBook');

create or replace function archive_expired_dispatch_data(p_now timestamptz default now())
returns table(table_name text, affected integer)
language plpgsql
as $$
declare
  affected_count integer;
  expired_ids text[];
begin
  select coalesce(array_agg(ride_id), array[]::text[])
    into expired_ids
    from rides
    where (
      deleted_at is null and is_protected = false and source_expires_at <= p_now
    ) or (
      trashed_at is not null and trash_delete_at <= p_now
    );

  if cardinality(expired_ids) > 0 then
    update raw_messages set ride_id = null where ride_id = any(expired_ids);
    delete from driver_recommendations where ride_id = any(expired_ids);
    delete from bids where ride_id = any(expired_ids);
    delete from vehicle_schedule where ride_id = any(expired_ids);
    delete from driver_schedule
      where ride_id = any(expired_ids)
         or previous_ride_id = any(expired_ids)
         or next_ride_id = any(expired_ids);
    delete from linked_rides
      where first_ride_id = any(expired_ids)
         or second_ride_id = any(expired_ids)
         or anchor_ride_id = any(expired_ids)
         or candidate_ride_id = any(expired_ids);
    delete from rides where ride_id = any(expired_ids);
    get diagnostics affected_count = row_count;
    table_name := 'source_jobs_deleted'; affected := affected_count; return next;
  end if;

  update raw_messages
    set deleted_at = p_now
    where deleted_at is null and is_protected = false
      and (expires_at <= p_now or (retention_class in ('temporary', 'noise') and created_at < p_now - interval '10 days'));
  get diagnostics affected_count = row_count;
  table_name := 'raw_messages_archived'; affected := affected_count; return next;

  update driver_recommendations
    set deleted_at = p_now
    where deleted_at is null and is_protected = false
      and status in ('Assigned', 'Failed', 'Rejected', 'Expired')
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'driver_recommendations_archived'; affected := affected_count; return next;

  update linked_rides
    set deleted_at = p_now
    where deleted_at is null and is_protected = false
      and status in ('Assigned', 'Closed', 'Expired', 'Failed', 'Rejected')
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'linked_rides_archived'; affected := affected_count; return next;

  update bids
    set deleted_at = p_now
    where deleted_at is null and is_protected = false
      and (bid_status in ('Bid Done', 'Bid Failed', 'Skipped') or admin_status in ('Rejected', 'Failed', 'Completed'))
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'bids_archived'; affected := affected_count; return next;

  update audit_logs
    set deleted_at = p_now
    where deleted_at is null and is_protected = false
      and coalesce(expires_at, created_at + interval '90 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'audit_logs_archived'; affected := affected_count; return next;

  delete from raw_messages
    where deleted_at is not null and is_protected = false
      and deleted_at < p_now - interval '30 days';
  get diagnostics affected_count = row_count;
  table_name := 'raw_messages_deleted'; affected := affected_count; return next;

  delete from job_source_tombstones where expires_at <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'job_tombstones_deleted'; affected := affected_count; return next;
end;
$$;

alter table system_settings enable row level security;
alter table job_source_tombstones enable row level security;
