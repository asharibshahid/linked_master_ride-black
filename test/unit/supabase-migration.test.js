const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { getDatabaseUrl, getPgClientConfig } = require("../../scripts/db/client");

const migrationSql = fs.readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/001_dispatch_core.sql"),
  "utf8"
);
const dbPrimaryMigrationSql = fs.readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/002_dispatch_db_primary_fields.sql"),
  "utf8"
);
const retentionPolicyMigrationSql = fs.readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/004_operational_retention_policy.sql"),
  "utf8"
);
const closedScheduleMigrationSql = fs.readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/005_release_closed_schedule_retention.sql"),
  "utf8"
);
const jobLinkerMigrationSql = fs.readFileSync(
  path.resolve(__dirname, "../../supabase/migrations/006_job_linker_system.sql"),
  "utf8"
);
const seedSql = fs.readFileSync(path.resolve(__dirname, "../../supabase/seed.sql"), "utf8");
const packageJson = require("../../package.json");

test("Supabase migration creates core dispatch tables and views", () => {
  [
    "drivers",
    "vehicles",
    "rides",
    "raw_messages",
    "driver_schedule",
    "vehicle_schedule",
    "driver_recommendations",
    "linked_rides",
    "bids",
    "audit_logs"
  ].forEach((tableName) => {
    assert.match(migrationSql, new RegExp(`create table if not exists ${tableName}`));
  });

  assert.match(migrationSql, /create or replace view active_rides/);
  assert.match(migrationSql, /create or replace view active_drivers/);
  assert.match(migrationSql, /create or replace view active_vehicles/);
});

test("Supabase migration protects important data and archives temporary data", () => {
  assert.match(migrationSql, /is_protected boolean not null default true/);
  assert.match(migrationSql, /retention_class text not null default 'temporary'/);
  assert.match(migrationSql, /archive_expired_dispatch_data/);
  assert.match(migrationSql, /raw_messages_archived/);
  assert.match(migrationSql, /raw_messages_deleted/);
  assert.match(migrationSql, /created_at < p_now - interval '10 days'/);
});

test("Supabase DB-primary migration adds Final Bid runtime fields", () => {
  assert.match(dbPrimaryMigrationSql, /bid_score/);
  assert.match(dbPrimaryMigrationSql, /final_bid_reason/);
  assert.match(dbPrimaryMigrationSql, /calendar_error/);
  assert.match(dbPrimaryMigrationSql, /idx_rides_final_bid_status/);
});

test("operational retention archives closed work without touching active or protected rides", () => {
  assert.match(retentionPolicyMigrationSql, /lower\(status\) in \('completed', 'rejected', 'cancelled', 'canceled', 'failed'\)/);
  assert.match(retentionPolicyMigrationSql, /and is_protected = false/);
  assert.match(retentionPolicyMigrationSql, /interval '30 days'/);
  assert.match(retentionPolicyMigrationSql, /raw_messages_deleted/);
  assert.match(retentionPolicyMigrationSql, /alter table driver_schedule alter column is_protected set default false/);
  assert.match(closedScheduleMigrationSql, /update driver_schedule/);
  assert.match(closedScheduleMigrationSql, /lower\(status\) in \('completed', 'rejected', 'cancelled', 'canceled', 'failed'\)/);
});

test("Supabase seed creates demo linked dispatch scenario", () => {
  assert.match(seedSql, /'D-001'/);
  assert.match(seedSql, /'V-001'/);
  assert.match(seedSql, /'RID-DEMO-001'/);
  assert.match(seedSql, /'RID-DEMO-002'/);
  assert.match(seedSql, /'LINK-DEMO-001'/);
  assert.match(seedSql, /Heathrow Terminal 5/);
  assert.match(seedSql, /Chelsea London/);
  assert.match(seedSql, /Gatwick Airport/);
});

test("database scripts are exposed and reject placeholder connection strings", () => {
  assert.equal(packageJson.scripts["db:migrate"], "node scripts/db/migrate.js");
  assert.equal(packageJson.scripts["db:seed"], "node scripts/db/seed.js");
  assert.equal(packageJson.scripts["db:retention"], "node scripts/db/retention.js");

  assert.equal(getDatabaseUrl({ DATABASE_URL: "postgresql://example" }), "postgresql://example");
  assert.throws(
    () =>
      getPgClientConfig({
        DATABASE_URL:
          "postgresql://postgres.jufsojdhrhhhprhgimkj:YOUR_PASSWORD@YOUR_POOLER_HOST:5432/postgres"
      }),
    /DATABASE_URL is missing/
  );
});

test("job linker migration adds shared criteria, recoverable trash and source expiry", () => {
  assert.match(jobLinkerMigrationSql, /create table if not exists system_settings/);
  assert.match(jobLinkerMigrationSql, /create table if not exists job_source_tombstones/);
  assert.match(jobLinkerMigrationSql, /source_expires_at/);
  assert.match(jobLinkerMigrationSql, /trash_delete_at/);
  assert.match(jobLinkerMigrationSql, /interval '12 hours'/);
  assert.match(jobLinkerMigrationSql, /source_jobs_deleted/);
  assert.match(jobLinkerMigrationSql, /status = 'Linker Opportunity'/);
});
