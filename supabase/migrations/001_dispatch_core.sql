create extension if not exists pgcrypto;

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists drivers (
  driver_id text primary key,
  driver_name text not null,
  whatsapp_number text,
  status text not null default 'Available'
    check (status in ('Available', 'Busy', 'Offline', 'Unavailable')),
  current_location text,
  working_hours text not null default 'Any',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists vehicles (
  vehicle_id text primary key,
  vehicle_type text not null,
  seats integer,
  registration text unique,
  status text not null default 'Available'
    check (status in ('Available', 'Busy', 'Offline', 'Unavailable', 'Maintenance')),
  current_location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists rides (
  ride_id text primary key,
  refer text unique,
  source_type text not null default 'WhatsApp',
  group_name text,
  source_name text,
  source_time timestamptz,
  pickup_day_date text,
  starting_timing text,
  pickup text,
  drop_off text,
  distance text,
  fare numeric(10, 2),
  required_vehicle text,
  payment_status text,
  status text not null default 'New',
  final_bid_status text,
  assigned_driver_id text references drivers(driver_id),
  assigned_vehicle_id text references vehicles(vehicle_id),
  calendar_status text,
  calendar_event_id text,
  extraction_confidence numeric(5, 2),
  review_reason text,
  original_message text,
  pickup_at timestamptz,
  dropoff_eta_at timestamptz,
  is_protected boolean not null default false,
  retention_class text not null default 'operational'
    check (retention_class in ('operational', 'important', 'temporary', 'noise')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists raw_messages (
  message_id text primary key,
  ride_id text references rides(ride_id) on delete set null,
  chat_id text,
  group_name text,
  source_time timestamptz,
  payload text not null,
  parsed boolean not null default false,
  parse_reason text,
  retention_class text not null default 'temporary'
    check (retention_class in ('important', 'temporary', 'noise')),
  is_protected boolean not null default false,
  expires_at timestamptz not null default (now() + interval '10 days'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists driver_schedule (
  assignment_id text primary key,
  driver_id text not null references drivers(driver_id),
  ride_id text not null references rides(ride_id),
  pickup text,
  drop_off text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  status text not null default 'Assigned',
  next_available_time timestamptz,
  current_location text,
  previous_ride_id text references rides(ride_id),
  next_ride_id text references rides(ride_id),
  is_protected boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (end_time > start_time)
);

create table if not exists vehicle_schedule (
  vehicle_id text not null references vehicles(vehicle_id),
  ride_id text not null references rides(ride_id),
  driver_id text not null references drivers(driver_id),
  start_time timestamptz not null,
  end_time timestamptz not null,
  status text not null default 'Assigned',
  is_protected boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (vehicle_id, ride_id),
  check (end_time > start_time)
);

create table if not exists driver_recommendations (
  recommendation_id uuid primary key default gen_random_uuid(),
  ride_id text not null references rides(ride_id),
  pickup text,
  drop_off text,
  required_vehicle text,
  recommended_driver_id text references drivers(driver_id),
  recommended_vehicle_id text references vehicles(vehicle_id),
  linked_ride_id text,
  previous_ride text,
  next_ride text,
  time_gap text,
  distance_between text,
  estimated_saving numeric(10, 2),
  score numeric(5, 2),
  reason text,
  status text not null default 'Pending',
  assignment_status text not null default 'Pending',
  is_protected boolean not null default false,
  expires_at timestamptz default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists linked_rides (
  link_id text primary key,
  first_ride_id text not null references rides(ride_id),
  second_ride_id text not null references rides(ride_id),
  driver_id text references drivers(driver_id),
  vehicle_id text references vehicles(vehicle_id),
  previous_drop text,
  next_pickup text,
  time_gap text,
  distance_between text,
  saving_estimate numeric(10, 2),
  status text not null default 'Open',
  is_protected boolean not null default false,
  expires_at timestamptz default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists bids (
  bid_id uuid primary key default gen_random_uuid(),
  ride_id text not null references rides(ride_id),
  bid_type text,
  bid_status text not null default 'Suggested',
  admin_status text not null default 'Pending',
  bid_amount numeric(10, 2),
  reason text,
  is_protected boolean not null default false,
  expires_at timestamptz default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists audit_logs (
  audit_id text primary key,
  actor text,
  action text not null,
  target_type text,
  target_id text,
  field text,
  old_value text,
  new_value text,
  status text not null default 'Success',
  reason text,
  is_protected boolean not null default false,
  expires_at timestamptz default (now() + interval '90 days'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_rides_pickup_at on rides (pickup_at) where deleted_at is null;
create index if not exists idx_rides_status on rides (status, final_bid_status) where deleted_at is null;
create index if not exists idx_driver_schedule_driver_time on driver_schedule (driver_id, start_time, end_time) where deleted_at is null;
create index if not exists idx_vehicle_schedule_vehicle_time on vehicle_schedule (vehicle_id, start_time, end_time) where deleted_at is null;
create index if not exists idx_recommendations_ride_status on driver_recommendations (ride_id, status, assignment_status) where deleted_at is null;
create index if not exists idx_linked_rides_status on linked_rides (status) where deleted_at is null;
create index if not exists idx_raw_messages_expiry on raw_messages (expires_at) where deleted_at is null;

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_drivers_updated_at on drivers;
create trigger trg_drivers_updated_at before update on drivers
for each row execute function touch_updated_at();

drop trigger if exists trg_vehicles_updated_at on vehicles;
create trigger trg_vehicles_updated_at before update on vehicles
for each row execute function touch_updated_at();

drop trigger if exists trg_rides_updated_at on rides;
create trigger trg_rides_updated_at before update on rides
for each row execute function touch_updated_at();

drop trigger if exists trg_driver_schedule_updated_at on driver_schedule;
create trigger trg_driver_schedule_updated_at before update on driver_schedule
for each row execute function touch_updated_at();

drop trigger if exists trg_vehicle_schedule_updated_at on vehicle_schedule;
create trigger trg_vehicle_schedule_updated_at before update on vehicle_schedule
for each row execute function touch_updated_at();

drop trigger if exists trg_recommendations_updated_at on driver_recommendations;
create trigger trg_recommendations_updated_at before update on driver_recommendations
for each row execute function touch_updated_at();

drop trigger if exists trg_linked_rides_updated_at on linked_rides;
create trigger trg_linked_rides_updated_at before update on linked_rides
for each row execute function touch_updated_at();

drop trigger if exists trg_bids_updated_at on bids;
create trigger trg_bids_updated_at before update on bids
for each row execute function touch_updated_at();

create or replace view active_rides as
select * from rides where deleted_at is null;

create or replace view active_drivers as
select * from drivers where deleted_at is null;

create or replace view active_vehicles as
select * from vehicles where deleted_at is null;

create or replace function archive_expired_dispatch_data(p_now timestamptz default now())
returns table(table_name text, affected integer)
language plpgsql
as $$
declare
  affected_count integer;
begin
  update raw_messages
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and (
        expires_at <= p_now
        or (retention_class in ('temporary', 'noise') and created_at < p_now - interval '10 days')
      );
  get diagnostics affected_count = row_count;
  table_name := 'raw_messages_archived';
  affected := affected_count;
  return next;

  update driver_recommendations
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and status in ('Assigned', 'Failed', 'Rejected', 'Expired')
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'driver_recommendations_archived';
  affected := affected_count;
  return next;

  update linked_rides
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and status in ('Assigned', 'Closed', 'Expired', 'Failed', 'Rejected')
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'linked_rides_archived';
  affected := affected_count;
  return next;

  update bids
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and bid_status in ('Bid Done', 'Bid Failed', 'Skipped')
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'bids_archived';
  affected := affected_count;
  return next;

  update audit_logs
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and coalesce(expires_at, created_at + interval '90 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'audit_logs_archived';
  affected := affected_count;
  return next;

  delete from raw_messages
    where deleted_at is not null
      and is_protected = false
      and deleted_at < p_now - interval '30 days';
  get diagnostics affected_count = row_count;
  table_name := 'raw_messages_deleted';
  affected := affected_count;
  return next;
end;
$$;

alter table drivers enable row level security;
alter table vehicles enable row level security;
alter table rides enable row level security;
alter table raw_messages enable row level security;
alter table driver_schedule enable row level security;
alter table vehicle_schedule enable row level security;
alter table driver_recommendations enable row level security;
alter table linked_rides enable row level security;
alter table bids enable row level security;
alter table audit_logs enable row level security;
