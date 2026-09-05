insert into drivers (
  driver_id,
  driver_name,
  whatsapp_number,
  status,
  current_location,
  working_hours
) values
  ('D-001', 'Ali Khan', '+447700000001', 'Available', 'Heathrow', 'Any'),
  ('D-002', 'Sara Ahmed', '+447700000002', 'Available', 'Chelsea', 'Any'),
  ('D-003', 'Test Offline Driver', '+447700000003', 'Offline', 'Gatwick', 'Any')
on conflict (driver_id) do update set
  driver_name = excluded.driver_name,
  whatsapp_number = excluded.whatsapp_number,
  status = excluded.status,
  current_location = excluded.current_location,
  working_hours = excluded.working_hours,
  deleted_at = null;

insert into vehicles (
  vehicle_id,
  vehicle_type,
  seats,
  registration,
  status,
  current_location
) values
  ('V-001', 'MPV', 8, 'MPV001', 'Available', 'Heathrow'),
  ('V-002', 'Saloon', 4, 'SAL002', 'Available', 'Chelsea'),
  ('V-003', '6 Seater', 6, 'SIX003', 'Available', 'Heathrow')
on conflict (vehicle_id) do update set
  vehicle_type = excluded.vehicle_type,
  seats = excluded.seats,
  registration = excluded.registration,
  status = excluded.status,
  current_location = excluded.current_location,
  deleted_at = null;

insert into rides (
  ride_id,
  refer,
  source_type,
  group_name,
  source_name,
  pickup_day_date,
  starting_timing,
  pickup,
  drop_off,
  fare,
  required_vehicle,
  payment_status,
  status,
  final_bid_status,
  assigned_driver_id,
  assigned_vehicle_id,
  calendar_status,
  pickup_at,
  dropoff_eta_at,
  is_protected,
  retention_class
) values
  (
    'RID-DEMO-001',
    'RID-DEMO-001',
    'WhatsApp',
    'Demo WhatsApp Group',
    'Demo Supplier',
    'Monday 20th July 2026',
    '10:00',
    'Heathrow Terminal 5',
    'Chelsea London',
    120,
    'MPV',
    'Pending',
    'Approved',
    'Approved',
    'D-001',
    'V-001',
    'Created',
    '2026-07-20 10:00:00+01',
    '2026-07-20 11:15:00+01',
    true,
    'important'
  ),
  (
    'RID-DEMO-002',
    'RID-DEMO-002',
    'WhatsApp',
    'Demo WhatsApp Group',
    'Demo Supplier',
    'Monday 20th July 2026',
    '13:00',
    'Chelsea London',
    'Gatwick Airport',
    100,
    'MPV',
    'Pending',
    'Final Bid',
    'Pending',
    null,
    null,
    'Pending',
    '2026-07-20 13:00:00+01',
    '2026-07-20 14:20:00+01',
    false,
    'operational'
  )
on conflict (ride_id) do update set
  pickup_day_date = excluded.pickup_day_date,
  starting_timing = excluded.starting_timing,
  pickup = excluded.pickup,
  drop_off = excluded.drop_off,
  fare = excluded.fare,
  required_vehicle = excluded.required_vehicle,
  status = excluded.status,
  final_bid_status = excluded.final_bid_status,
  assigned_driver_id = excluded.assigned_driver_id,
  assigned_vehicle_id = excluded.assigned_vehicle_id,
  calendar_status = excluded.calendar_status,
  pickup_at = excluded.pickup_at,
  dropoff_eta_at = excluded.dropoff_eta_at,
  is_protected = excluded.is_protected,
  retention_class = excluded.retention_class,
  deleted_at = null;

insert into driver_schedule (
  assignment_id,
  driver_id,
  ride_id,
  pickup,
  drop_off,
  start_time,
  end_time,
  status,
  next_available_time,
  current_location,
  next_ride_id
) values (
  'ASG-DEMO-001',
  'D-001',
  'RID-DEMO-001',
  'Heathrow Terminal 5',
  'Chelsea London',
  '2026-07-20 10:00:00+01',
  '2026-07-20 11:15:00+01',
  'Assigned',
  '2026-07-20 11:45:00+01',
  'Chelsea London',
  'RID-DEMO-002'
)
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
  next_ride_id = excluded.next_ride_id,
  deleted_at = null;

insert into vehicle_schedule (
  vehicle_id,
  ride_id,
  driver_id,
  start_time,
  end_time,
  status
) values (
  'V-001',
  'RID-DEMO-001',
  'D-001',
  '2026-07-20 10:00:00+01',
  '2026-07-20 11:15:00+01',
  'Assigned'
)
on conflict (vehicle_id, ride_id) do update set
  driver_id = excluded.driver_id,
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  status = excluded.status,
  deleted_at = null;

insert into linked_rides (
  link_id,
  first_ride_id,
  second_ride_id,
  driver_id,
  vehicle_id,
  previous_drop,
  next_pickup,
  time_gap,
  distance_between,
  saving_estimate,
  status
) values (
  'LINK-DEMO-001',
  'RID-DEMO-001',
  'RID-DEMO-002',
  'D-001',
  'V-001',
  'Chelsea London',
  'Chelsea London',
  '1h 45m',
  '0 mi',
  35,
  'Open'
)
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
  deleted_at = null;

delete from driver_recommendations
where ride_id = 'RID-DEMO-002'
  and recommended_driver_id = 'D-001'
  and recommended_vehicle_id = 'V-001';

insert into driver_recommendations (
  ride_id,
  pickup,
  drop_off,
  required_vehicle,
  recommended_driver_id,
  recommended_vehicle_id,
  linked_ride_id,
  previous_ride,
  next_ride,
  time_gap,
  distance_between,
  estimated_saving,
  score,
  reason,
  status,
  assignment_status
) values (
  'RID-DEMO-002',
  'Chelsea London',
  'Gatwick Airport',
  'MPV',
  'D-001',
  'V-001',
  'LINK-DEMO-001',
  'RID-DEMO-001',
  'RID-DEMO-002',
  '1h 45m',
  '0 mi',
  35,
  94,
  'Vehicle compatible, driver available after previous Heathrow to Chelsea ride, linked route saves empty driving',
  'Pending',
  'Pending'
);

insert into raw_messages (
  message_id,
  ride_id,
  chat_id,
  group_name,
  payload,
  parsed,
  retention_class,
  expires_at
) values (
  'MSG-DEMO-001',
  'RID-DEMO-002',
  'demo@g.us',
  'Demo WhatsApp Group',
  'MPV ride Pickup Chelsea London Drop Gatwick Airport Time 13:00 Fare GBP100',
  true,
  'temporary',
  now() + interval '10 days'
)
on conflict (message_id) do update set
  ride_id = excluded.ride_id,
  payload = excluded.payload,
  parsed = excluded.parsed,
  retention_class = excluded.retention_class,
  expires_at = excluded.expires_at,
  deleted_at = null;
