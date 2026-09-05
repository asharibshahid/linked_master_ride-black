alter table rides
  add column if not exists bid_score numeric(5, 2),
  add column if not exists final_bid_reason text,
  add column if not exists passenger_count text,
  add column if not exists calendar_created_time timestamptz,
  add column if not exists calendar_error text;

create index if not exists idx_rides_final_bid_status on rides (final_bid_status) where deleted_at is null;
