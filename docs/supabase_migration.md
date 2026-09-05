# Supabase Production Database Plan

This project still keeps Google Sheets working. Supabase is added as the production database foundation so the app can move safely in phases:

1. Create schema and seed demo data.
2. Mirror new rides from Sheets flow into Supabase.
3. Read dashboard from Supabase.
4. Keep Google Sheets as export/backup.

## Required Environment

Do not hardcode keys in source files.

```env
NEXT_PUBLIC_SUPABASE_URL=https://jufsojdhrhhhprhgimkj.supabase.co
SUPABASE_URL=https://jufsojdhrhhhprhgimkj.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=
DATABASE_SSL=true
DATABASE_RETENTION_ENABLED=false
```

Use the full Supabase database connection string from:

Supabase Dashboard -> Project Settings -> Database -> Connection string

The placeholder string with `YOUR_PASSWORD` or `YOUR_POOLER_HOST` will not work.

## Commands

```bash
npm run db:migrate
npm run db:seed
npm run db:retention
```

`db:migrate` creates tables, indexes, views, triggers, RLS, and retention functions.

`db:seed` inserts demo drivers, vehicles, rides, linked ride opportunity, schedules, and recommendation data.

`db:retention` runs the database retention cleanup function.

## Core Tables

- `rides`
- `raw_messages`
- `drivers`
- `vehicles`
- `driver_schedule`
- `vehicle_schedule`
- `driver_recommendations`
- `linked_rides`
- `bids`
- `audit_logs`

## Retention Rules

Important data is protected by `is_protected = true` and is kept until an admin deletes it.

Auto archived:

- temporary/noisy raw WhatsApp messages after 10 days
- closed recommendations after 30 days
- closed linked ride opportunities after 30 days
- closed bid rows after 30 days
- audit logs after 90 days

Hard deleted:

- only already-archived, unprotected raw messages older than 30 days after archive

Future rides and protected operational records are not auto-deleted.

## Demo Data

The seed creates:

- `D-001` Available at Heathrow
- `D-002` Available at Chelsea
- `D-003` Offline
- `V-001` MPV
- `V-002` Saloon
- `V-003` 6 Seater
- `RID-DEMO-001` Heathrow Terminal 5 to Chelsea London
- `RID-DEMO-002` Chelsea London to Gatwick Airport
- `LINK-DEMO-001` linking the two rides

## Security Note

If a service role key was pasted into chat or sent through an unsafe channel, rotate it in Supabase before production use.
