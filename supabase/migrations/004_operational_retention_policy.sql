-- Keep operational views small without ever auto-removing active, future, or protected work.
alter table driver_schedule alter column is_protected set default false;
alter table vehicle_schedule alter column is_protected set default false;

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
  table_name := 'raw_messages_archived'; affected := affected_count; return next;

  update rides
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and lower(status) in ('completed', 'rejected', 'cancelled', 'canceled', 'failed')
      and coalesce(dropoff_eta_at, pickup_at, created_at) < p_now - interval '30 days';
  get diagnostics affected_count = row_count;
  table_name := 'rides_archived'; affected := affected_count; return next;

  update driver_schedule
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and lower(status) in ('completed', 'rejected', 'cancelled', 'canceled', 'failed')
      and end_time < p_now - interval '30 days';
  get diagnostics affected_count = row_count;
  table_name := 'driver_schedule_archived'; affected := affected_count; return next;

  update vehicle_schedule
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and lower(status) in ('completed', 'rejected', 'cancelled', 'canceled', 'failed')
      and end_time < p_now - interval '30 days';
  get diagnostics affected_count = row_count;
  table_name := 'vehicle_schedule_archived'; affected := affected_count; return next;

  update driver_recommendations
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and status in ('Assigned', 'Failed', 'Rejected', 'Expired')
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'driver_recommendations_archived'; affected := affected_count; return next;

  update linked_rides
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and status in ('Assigned', 'Closed', 'Expired', 'Failed', 'Rejected')
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'linked_rides_archived'; affected := affected_count; return next;

  update bids
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and (
        bid_status in ('Bid Done', 'Bid Failed', 'Skipped')
        or admin_status in ('Rejected', 'Failed', 'Completed')
      )
      and coalesce(expires_at, created_at + interval '30 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'bids_archived'; affected := affected_count; return next;

  update audit_logs
    set deleted_at = p_now
    where deleted_at is null
      and is_protected = false
      and coalesce(expires_at, created_at + interval '90 days') <= p_now;
  get diagnostics affected_count = row_count;
  table_name := 'audit_logs_archived'; affected := affected_count; return next;

  delete from raw_messages
    where deleted_at is not null
      and is_protected = false
      and deleted_at < p_now - interval '30 days';
  get diagnostics affected_count = row_count;
  table_name := 'raw_messages_deleted'; affected := affected_count; return next;
end;
$$;
