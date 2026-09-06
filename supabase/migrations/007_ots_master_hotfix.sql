alter table rides add column if not exists luggage_details text;
alter table rides add column if not exists guide_price_min numeric(12,2);
alter table rides add column if not exists guide_price_max numeric(12,2);
alter table rides add column if not exists guide_price_text text;
alter table rides add column if not exists source_metadata jsonb not null default '{}'::jsonb;

-- Bid history must retain its source ride even after the live OTS card expires.
update rides r
set is_protected = true
where exists (
  select 1
  from bids b
  where b.ride_id = r.ride_id
    and b.deleted_at is null
);
