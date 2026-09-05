-- Earlier schedule rows defaulted to protected. Closed history can use the normal retention policy.
update driver_schedule
  set is_protected = false
  where is_protected = true
    and lower(status) in ('completed', 'rejected', 'cancelled', 'canceled', 'failed');

update vehicle_schedule
  set is_protected = false
  where is_protected = true
    and lower(status) in ('completed', 'rejected', 'cancelled', 'canceled', 'failed');
