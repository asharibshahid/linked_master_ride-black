# ACE OTS Supplier - Developer Handoff

Last updated: 2026-10-21

This document describes the current system, not the older dashboard shown in some files under `docs/`. Read `PROJECT_CONTEXT.md` alongside this file for the concise production snapshot. The repository currently has substantial uncommitted production work; see **Known risks and technical debt** before changing or deploying anything.

## 1. Project overview

ACE OTS Supplier is an internal taxi-operations application for ACE operators. It consolidates live OTS quotation requests, confirmed pre-bookings, selected WhatsApp jobs, bid history, automatic bidding rules, and return-job suggestions into one dashboard.

The customer-facing dashboard is `https://ots-chat.vercel.app`. Its six operational tabs are:

1. **Master**: current live OTS quotation requests.
2. **Bid**: persisted manual and Auto Bid attempts and their provider outcomes.
3. **PreBook**: confirmed future bookings used as Linker anchors.
4. **Groups**: current jobs from the Google Sheet tab `Upcoming Jobs >79`.
5. **Linker**: strict return matches, manual-review possible returns, and archived suggestions.
6. **Settings**: matching criteria, Auto Bid settings, source health, sync controls, and Trash recovery.

The dashboard is used by dispatch/operations staff. It is not a public marketplace. The system must preserve exact ride references, dates, route endpoints, OTS guide prices, and provider submission evidence because incorrect matching or bidding can create real operational and financial problems.

## 2. Production topology

Production is intentionally split across several processes:

- **Static dashboard**: `dashboard/`, deployed to Vercel and aliased to `ots-chat.vercel.app`.
- **Main API/backend**: VPS path `/opt/taxi-dispatch-v2`, PM2 process `taxi-dispatch-v2`, port `3001`.
- **Primary database**: Supabase PostgreSQL.
- **WhatsApp collector**: separate VPS path `/opt/groups-dt`, PM2 process `ride-bot`, port `3000`. It owns the only WhatsApp session.
- **OTS scraper/submission worker**: separate path `/opt/ride-management-worker` with its own saved OTS browser session.
- **Google Sheets**: source/backup integration for ride ingestion, PreBook, and selected Groups jobs.

Critical rule: the main backend has `WHATSAPP_ENABLED=false` in production. Do not enable it while `ride-bot` is active, or two processes will compete for the same WhatsApp account/session.

## 3. Tech stack

- Node.js 20+, CommonJS modules.
- Express 5 API server.
- PostgreSQL through `pg`; Supabase is the production database.
- Vanilla HTML/CSS/JavaScript frontend in `dashboard/`.
- Vercel static hosting for the dashboard.
- Google Sheets and Calendar through `googleapis`.
- `whatsapp-web.js` and Puppeteer for WhatsApp Web.
- External OTS worker invoked as a child process for scraping and bid submission.
- Nominatim/postcodes.io-style geocoding plus OSRM road routing.
- Optional OpenAI normalization/review modules; production ride formatting is deterministic and OpenAI features are normally disabled.
- Node's built-in `node:test` runner.
- PM2 on the VPS; Nginx can proxy the backend.

## 4. Install, run, test, and deploy

### Local installation

```powershell
npm.cmd ci
```

Use `npm.cmd` on this Windows machine because PowerShell may block `npm.ps1`.

Create/configure `.env` locally. Never commit `.env`, `credentials.json`, WhatsApp auth folders, OTS browser state, or Supabase secrets.

### Run locally

```powershell
npm.cmd start
npm.cmd run dev
```

- `npm start` runs `node src/app.js`.
- `npm run dev` uses Nodemon.
- Default HTTP endpoints include `/health`, `/qr`, `/dashboard`, and `/api/job-linker`.
- A local full backend run can start pollers and external integrations. Disable integrations not being tested through environment flags.

### Validation

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:unit
npm.cmd run test:smoke
npm.cmd run test:integration
```

- `check` verifies that `src/app.js` can load.
- Unit and smoke tests are safe and do not intentionally place a real OTS bid.
- The integration suite may require configured dependencies; inspect `test/integration/` first.
- The last full verified run passed 343 unit tests and 7 smoke tests. A later focused Linker run passed 77 tests after adding Possible Return archive coverage, so the next full run may report one additional unit test.

### Database setup

```powershell
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run db:retention
```

- Migrations are ordered in `supabase/migrations/001_*.sql` through `007_*.sql`.
- `db:seed` is demo data. Do not run it casually against production.
- Migration and retention details are in `docs/supabase_migration.md`, but current production behavior should be checked against `PROJECT_CONTEXT.md` and source.

### Dashboard deployment

Use only:

```powershell
npm.cmd run dashboard:deploy
```

This runs `scripts/deploy-ots-dashboard.ps1`, creates a Vercel production deployment, moves the `ots-chat.vercel.app` alias, checks the live HTML/JS hashes, and verifies no-store caching. Vercel needs only `DASHBOARD_API_BASE_URL`; backend/database credentials must never be placed there.

### Backend deployment

There is no equivalent end-to-end backend deployment script. Current production deployment is manual and must be conservative:

1. Run focused tests, then the full test suite.
2. Compare local target files against `/opt/taxi-dispatch-v2` before copying; production has historically drifted from the worktree.
3. Create a timestamped backup under `/opt/taxi-dispatch-backups/`.
4. Copy only the intended files.
5. Run `node --check` and require/load checks on the VPS.
6. Run migrations only when a reviewed migration requires them.
7. Restart only `taxi-dispatch-v2` with PM2.
8. Verify `/health`, authenticated `/api/job-linker`, source counts/errors, and PM2 logs.
9. Do not restart or reset `ride-bot` unless the change specifically targets the collector.

The checked-in `deploy/ecosystem.config.cjs` uses the older process name `taxi-dispatch`; production currently uses `taxi-dispatch-v2`. Do not blindly run it over production.

### WhatsApp collector deployment

The collector is deployed separately at `/opt/groups-dt`. Its session must be preserved. QR/recovery UI is on port `3000` at `/qr`. A healthy PM2 process or WhatsApp `ready` event alone is not proof of successful delivery: also inspect recent Sheet appends, direct-ingest acknowledgements, durable queue state, and errors.

### OTS credentials/session

OTS browser login state belongs to `/opt/ride-management-worker`, not this repository's WhatsApp session. When credentials change, perform a manual OTS login and replace the worker's browser storage state using the worker's documented pending/swap procedure. Never delete the WhatsApp session while fixing OTS.

## 5. Folder structure

### Root

- `src/app.js`: application composition root. Creates Express, clients, repositories, pollers, Job Linker services, bidding services, and shutdown handlers.
- `package.json`: commands and runtime dependencies.
- `PROJECT_CONTEXT.md`: concise current production state and operational decisions.
- `README.md`: original WhatsApp ingestion documentation. Useful for collector internals, but incomplete/stale for the final six-tab product.
- `Dockerfile`: backend/collector-oriented Node image. It does not package the Vercel dashboard, Supabase migrations, or all deployment scripts.
- `sample.txt`: accepted/rejected Linker examples used to shape regression behavior.
- `.env`: local secrets/configuration. Never include values in documentation or commits.

### Frontend

- `dashboard/index.html`: final six-tab dashboard structure.
- `dashboard/app.js`: API client, state, filtering, rendering, actions, polling, theme behavior, Linker archive actions, and report triggers.
- `dashboard/styles.css`: dark/light themes, responsive tables/cards, and operational layout.
- `dashboard/report.js`: client-side formatted PDF operations report.
- `dashboard/vercel.json`: static hosting and no-store/security headers.
- `dashboard/README.md`: dashboard-specific notes; verify against the code before relying on it.

### Current operational backend

- `src/jobLinker/routes.js`: authenticated Job Linker API endpoints.
- `src/jobLinker/service.js`: source synchronization, snapshots, Linker recalculation, Groups sync, archive state, and timer orchestration.
- `src/jobLinker/repository.js`: Supabase/PostgreSQL persistence for rides, criteria, links, archives, bids, Trash, and source reconciliation.
- `src/jobLinker/linker.js`: strict and possible return matching, routing, timing, direction checks, scoring, and stable link IDs.
- `src/jobLinker/criteria.js`: shared job eligibility and vehicle/area normalization.
- `src/jobLinker/prebook.js`: Google Sheet PreBook loading, date-order inference, duration handling, cancellation/expiry filtering.
- `src/jobLinker/whatsappSheets.js`: reads and normalizes `Upcoming Jobs >79` for Groups/Linker.
- `src/jobLinker/otsMaster.js`: imports complete OTS inventory into Master.
- `src/jobLinker/bids.js`: durable manual bid reservation/queue/status flow.
- `src/jobLinker/autoBid.js`: current Auto Bid date scopes and eligibility rules.
- `src/jobLinker/detailFormatter.js`: operator-facing OTS copy detail text.

### Bidding and OTS

- `src/bids/otsSubmitter.js`: safe child-process adapter to OTS worker V2; passes only normalized reference and amount.
- `src/bids/autoBid.js`: older/general approved-bid runner retained for compatibility.
- `src/bids/finalBid.js`, `tracker.js`, `pricingEngine.js`, `aiReview.js`: preserved legacy dispatch/bid modules.
- `src/ots/integration.js`: formatted OTS-row importer and polling adapter.

### WhatsApp and extraction

- `src/whatsapp/client.js`: WhatsApp Web lifecycle and startup state machine.
- `src/whatsapp/messageHandler.js`: allowlist, dedupe, extraction, enrichment, Sheets/direct-ingest pipeline.
- `src/whatsapp/directSink.js`: protected backend delivery plus durable retry queue.
- `src/whatsapp/backfill.js`: reconnect backfill, limited by time and message count.
- `src/whatsapp/groups.js`: group discovery and allowlist management.
- `src/whatsapp/session.js`: persistent auth/session path handling.
- `src/extraction/localExtractor.js`: deterministic multi-format ride parsing.
- `src/extraction/rideCleanup.js`: route/location shortening and Special Instructions separation.
- `src/extraction/openaiNormalizer.js`: optional cleanup fallback, never trusted to invent protected values.
- `src/extraction/schemas.js`: canonical fields and Sheet header mapping.
- `src/extraction/tesseractOcr.js`: optional image OCR.

### Routing and Sheets

- `src/routing/geocode.js`: UK-only airport/postcode/address resolution and foreign-result rejection.
- `src/routing/osrm.js`: road distance/duration.
- `src/routing/fare.js`: deterministic fare calculation for collector flows.
- `src/sheets/sheetsClient.js`: Google service-account loading and Sheets client.
- `src/sheets/upcomingJobs.js`: date parsing, high-value eligibility, dedupe, append, and sorting.
- `src/sheets/expiredRideCleanup.js`: Sheet row expiry logic.
- `src/sheets/mutationQueue.js`: serializes mutations to avoid append/sort/delete races.
- `src/sheets/appendRow.js`: schema-aware Sheet appends and header validation.

### Database, legacy dispatch, and support

- `src/database/client.js`, `repository.js`, `retention.js`: shared Supabase client/repository and retention support.
- `src/dashboard/`, `src/drivers/`, `src/calendar/`, `src/operations/`, `src/engine.js`: older fleet/dispatch backend still retained for compatibility but not exposed by the final client UI.
- `src/config/env.js`: all environment parsing, defaults, path resolution, and safety bounds.
- `src/utils/`: date, text, logging, retry, dedupe, and reference helpers.
- `supabase/migrations/`: canonical database schema history.
- `scripts/`: deployment, Sheet maintenance, and expired-row cleanup utilities.
- `test/unit/`, `test/smoke/`, `test/integration/`: automated coverage.
- `deploy/`: example PM2 and Nginx configuration; production names/ports may differ.
- `data/`: local durable dedupe/queue data. Treat as runtime state.
- `.deploy-work/`, `.playwright-mcp/`, `.tmp/`, `output/`: generated/operator working artifacts, not canonical source.

## 6. Core data flows

### Dashboard read flow

1. `dashboard/app.js` calls authenticated `GET /api/job-linker`.
2. `src/jobLinker/routes.js` authorizes the request using dashboard auth.
3. `src/jobLinker/service.js#snapshot()` loads criteria, active jobs, strict links, archived links, Trash, and bids from `src/jobLinker/repository.js`.
4. OTS, PreBook, and Groups jobs are separated by `sourceType` and group name.
5. The API adds source health and Auto Bid runtime state.
6. The browser filters, sorts, paginates, and renders the data. Frontend filters must not redefine backend eligibility.

### OTS source flow

1. The external worker in `/opt/ride-management-worker` publishes a complete formatted OTS inventory.
2. `src/ots/integration.js` and `src/jobLinker/otsMaster.js` import it.
3. A complete sync reconciles additions, updates, and removals in Supabase.
4. Master displays every valid current OTS request, even if it fails Linker criteria.
5. Stored source guide prices are authoritative for display and bidding; OSRM estimates must never be presented as OTS guide prices.

### WhatsApp and Groups flow

1. The separate `ride-bot` receives an allowed group message.
2. It deduplicates, extracts deterministically, optionally normalizes, geocodes within the UK, routes through OSRM, and separates instructions from route endpoints.
3. It writes Google Sheets and posts the normalized ride to `POST /api/job-linker/whatsapp-ingest` through `src/whatsapp/directSink.js`.
4. Direct-ingested WhatsApp rows are currently persisted but deliberately hidden from Groups and Linker.
5. The backend independently reloads only Google Sheet tab `Upcoming Jobs >79` every five minutes through `src/jobLinker/whatsappSheets.js`.
6. Groups displays those future rows. Pickup times in the past disappear immediately; the collector cleanup permanently deletes rows one hour after pickup.

### PreBook flow

1. `src/jobLinker/prebook.js` reads the configured spreadsheet/tab.
2. It infers numeric date order and uses raw duration values where Google displays misleading clock times such as `29:00` as `5:00`.
3. Cancelled and expired bookings are excluded.
4. PreBook jobs become confirmed Linker anchors and may also be confirmed return candidates.

### Linker flow

1. `src/jobLinker/service.js#computeLinks()` loads jobs and applies `criteria.js` eligibility.
2. Anchors are eligible PreBook jobs plus current Groups Sheet jobs.
3. Candidates are future PreBook, OTS, and selected Groups jobs.
4. `src/jobLinker/linker.js` allows only airport outbound to remote destination followed by a later remote pickup returning to an airport.
5. Vehicle type must match. The route must fit ride duration, road deadhead, turnaround, configured wait window, and return-direction requirements.
6. Geocoding resolves real endpoints; matching does not rely on exact postcode equality or postcode-prefix distance guesses.
7. Strict links and up to three manual-review possible returns receive stable hashed IDs and are persisted in `linked_rides`.
8. Possible returns may exceed only strict wait/deadhead thresholds, never trigger Auto Bid, and use `Review Opportunity` / `Archived Review` statuses.
9. Archive/unarchive is persisted and expires at the candidate pickup time.

### Manual bid flow

1. Master sends only `rideId`, `bidAmount`, and optional reason to `POST /api/job-linker/bids`.
2. The backend reloads the trusted OTS ride and validates it is still actionable.
3. `src/jobLinker/bids.js` reserves the bid under a per-ride PostgreSQL lock and returns a durable queued response.
4. `src/bids/otsSubmitter.js` invokes worker V2 using only `--reference` and `--amount`.
5. Worker V2 requires the exact visible reference, one provider activation, an acceptance response, and continuous form disappearance confirmation.
6. Persisted status progresses through Created, Submitting, Submitted, Submission Unconfirmed, or Submission Failed.
7. A submitted bid is not a won booking. Confirmation requires exact normalized OTS business reference equality with PreBook `Booking ID`; `ACE ID` and internal ride IDs do not count.

### Auto Bid flow

1. Settings are normalized in `src/jobLinker/autoBid.js` and stored through the repository.
2. Auto Bid defaults OFF and requires explicit confirmation text when enabling.
3. It evaluates UK date scope, minimum mileage, allowed OTS vehicle, guide maximum, deduction, and time before expiry.
4. Deduction `0` means bid the OTS guide maximum. Blank values normalize safely server-side and are rejected by the UI.
5. It rechecks the latest settings immediately before reservation and submits one job at a time through the same durable bid service.
6. Any previous persisted bid history blocks automatic retry.

### Trash and retention flow

- Dashboard deletion marks supported source jobs as trashed for 24 hours and writes tombstones so source sync cannot recreate them immediately.
- Restore removes the tombstone while the retention window is active.
- OTS jobs expire at provider expiry or the configured post-pickup boundary.
- Groups jobs expire at pickup.
- `/opt/groups-dt` runs `scripts/cleanup-expired-rides.js` every five minutes and permanently removes rows at least one hour past pickup from only `Rides`, `Needs Review`, and `Upcoming Jobs >79`.

## 7. Architecture decisions and rationale

### Separate static UI from privileged backend

Vercel serves only static assets and receives only `DASHBOARD_API_BASE_URL`. Supabase keys, Google credentials, OTS state, and WhatsApp state stay on the VPS. This limits secret exposure and avoids trying to run long-lived browser automation in serverless functions.

### One WhatsApp session owner

Only `/opt/groups-dt` runs WhatsApp. A single owner prevents LocalAuth corruption, repeated QR scans, duplicated messages, and competing browser locks.

### Supabase is operational state; Sheets remain source/backup

Bid locking, durable statuses, archives, Trash, and source reconciliation require transactions and stable IDs, so they live in PostgreSQL. Google Sheets remain useful as operator-managed input, audit/export, and collector backup.

### Deterministic parsing before AI

Taxi messages contain protected facts. Local parsing is primary; optional AI can clean ambiguous text but cannot invent distance, fare, passenger data, or route fields. Production OTS formatting does not depend on OpenAI.

### UK-only location resolution

Airport aliases and UK postcodes are preferred, and address fallback must validate country/bounds. Rejecting an unresolved location is safer than silently routing to a similarly named foreign place and creating absurd mileage/fare.

### Real road routing for Linker

The Linker compares the first ride's actual drop-off with the next ride's pickup using OSRM. Exact postcode equality was too brittle, while postcode-prefix guesses created irrelevant suggestions.

### Strict links and possible returns are separate

Strict matches satisfy all operational rules. Possible returns remain manual review only and never feed Auto Bid. This gives operators useful nearby suggestions without weakening automated safety.

### Persist before external side effects

Bids are reserved before the OTS worker runs. Database locks, stable business references, and persisted timelines prevent duplicate provider submissions and make browser refreshes harmless.

### Fail closed on auth and source health

Production without `DASHBOARD_AUTH_TOKEN` must not make APIs public. A failed or incomplete source sync is not reported as live and must not reconcile an empty inventory as authoritative.

### UK time for business rules, UTC for storage

Pickup-day filters and expiry decisions use `Europe/London`, including BST/GMT changes. Persisted timestamps are ISO/UTC. Do not use the VPS local timezone for business-date comparisons.

## 8. Coding conventions and patterns

- CommonJS: `require()` and `module.exports`.
- Prefer small pure normalizers/evaluators with injected clients, clocks, repositories, and resolvers for testing.
- Route handlers authenticate first, validate narrow inputs, call services, and return sanitized errors. Raw paths/stacks stay in server logs.
- Database access belongs in repository classes/functions, not frontend code or route templates.
- Use stable business IDs and deterministic hashes for rides/links. Never substitute an internal database ID for the OTS/Booking reference.
- Preserve source facts. Do not display synthetic estimates as OTS guide values.
- Use structured Google APIs and schema/header maps rather than positional ad hoc string writes.
- Date parsing must support UK textual dates, two/four-digit years, numeric date order, and Google duration rollover. Add regression tests for every new source format.
- Treat blank and zero separately for numeric settings.
- Source synchronization must distinguish complete empty inventory from failed/incomplete reads.
- Keep Auto Bid OFF by default and route manual/automatic submissions through the same guarded service.
- Use `src/utils/logger.js` structured fields such as `stage`, `reason`, and `fallbackUsed`.
- Add comments only for non-obvious safety or sequencing constraints.
- On Windows use `rg`, `npm.cmd`, and `vercel.cmd`; PowerShell script shims may be blocked.
- Preserve unrelated dirty-worktree changes. Never reset or overwrite broad areas to implement a narrow fix.

## 9. Feature status

### Complete and live

- Six-tab Vercel dashboard with dark/light themes and responsive operational views.
- OTS Master inventory with source freshness and reconciliation counts.
- Manual OTS bidding with durable queue/status/timing and exact-reference safety.
- Auto Bid settings and runner with UK date scopes, vehicle/mileage/deduction/expiry controls.
- PreBook Google Sheet integration.
- Groups integration from `Upcoming Jobs >79`.
- Strict Linker and bounded manual-review Possible Returns.
- Persistent archive/unarchive for strict and possible links.
- Search, filters, London inside/outside classification, pagination, and Clear Filters controls.
- Bid operations PDF for quick/custom date ranges.
- Recoverable Trash and retention rules.
- WhatsApp deterministic extraction, UK-only routing, Sheet backup, direct backend sink, retry queue, dedupe, backfill, and QR recovery.
- Supabase migrations through `007_ots_master_hotfix.sql`.

### Partially complete / intentionally limited

- Direct WhatsApp-ingested rides are stored but hidden from Groups and Linker; those views currently trust only `Upcoming Jobs >79`.
- Legacy driver/fleet/recommendation/calendar backend remains in source but is hidden from the final client dashboard.
- Google Sheets backup paths remain alongside Supabase. Some older docs still describe Sheets as the primary operational store.
- The Docker image runs the Node service but is not a complete deployment artifact for migrations, static dashboard, OTS worker, or maintenance scripts.
- Integration tests are separate from the default test command and may need configured external services.

### Planned / next sensible work

There is no formal issue tracker in this checkout. The clearest remaining work from current architecture is:

- Decide when direct WhatsApp jobs should be exposed in Groups/Linker instead of relying on the curated Sheet tab.
- Commit and tag the current production release after reviewing the large dirty worktree.
- Build a reproducible backend deployment script with hash verification and rollback, similar to the dashboard deploy script.
- Update or archive the stale fleet-oriented README/runbook material.
- Add production monitoring/alerts for source freshness, queue backlog, Sheet write failures, OTS scrape failures, and bid confirmation latency.
- Reconcile checked-in PM2/Nginx examples with actual production process names, ports, and TLS setup.

## 10. Known bugs, hacks, workarounds, and technical debt

1. **Large dirty worktree**: the last Git commit is `9022fb7`, but many live features are modified or untracked locally. Git history alone does not reconstruct production. Review `git status`, compare VPS files, then make a consolidation commit before handing off again.
2. **Backend deployment drift**: dashboard deployment is scripted; backend deployment is manual. A previous Groups outage happened because local support for `Tue 20th Oct 26` existed but the VPS parser was older.
3. **Stale documentation**: `README.md`, `docs/client_operator_runbook.md`, and parts of `docs/production-deployment.md` describe the older fleet dashboard or older process names. `PROJECT_CONTEXT.md`, this file, and source are newer.
4. **PM2 naming mismatch**: checked-in config says `taxi-dispatch`; production says `taxi-dispatch-v2`.
5. **Split repositories/runtime paths**: this checkout cannot by itself reproduce `/opt/groups-dt` or `/opt/ride-management-worker`. Changes must be applied to the correct process and path.
6. **Possible Returns cap**: only the top three bounded review candidates are exposed. This is intentional for usability and routing cost, but it can hide lower-ranked feasible pairs.
7. **External routing dependency**: Linker quality depends on geocoding and OSRM. Failures should remove uncertain suggestions, not fall back to guessed distance.
8. **Groups is curated Sheet data**: direct WhatsApp ingest success does not mean a job appears in Groups. Groups depends on a separate five-minute Sheet read and valid future pickup timestamp.
9. **Destructive Sheet cleanup**: expired collector rows are permanently deleted with no archive. The scope is deliberately limited to three ride tabs.
10. **No real-bid automated test**: automated tests mock the provider. Real OTS bid verification is an explicit operator-controlled test only.
11. **Browser sessions are fragile external state**: OTS and WhatsApp session folders must survive deployments. Do not delete/reset them while debugging unrelated code.
12. **VPS PM2 version warning**: production has previously reported an in-memory PM2 version different from the installed CLI. Processes were healthy, but this should be reconciled during maintenance, not during an incident.
13. **Generated files in repository root**: `.deploy-work/`, `.playwright-mcp/`, `.tmp/`, odd screenshot/debug artifacts, and `node_modules` changes add noise. Clean only files proven generated; do not delete unknown operator evidence blindly.
14. **Legacy APIs still mounted**: `src/app.js` exposes older driver, vehicle, recommendation, Final Bid, schedule, and criteria endpoints even though the current Vercel UI does not use them. Removing them needs an explicit compatibility audit.

## 11. Environment variables

Names only are listed below. Defaults and validation are centralized in `src/config/env.js`. Search that file before adding another variable.

### Core runtime and security

`NODE_ENV`, `PORT`, `APP_TIME_ZONE`, `LOG_LEVEL`, `LOG_MODE`, `DASHBOARD_AUTH_TOKEN`, `DASHBOARD_ALLOWED_ORIGINS`, `DASHBOARD_DEFAULT_ACTOR`, `DASHBOARD_API_BASE_URL`

### Supabase/PostgreSQL

`DATABASE_URL`, `POSTGRES_URL`, `SUPABASE_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_PRIMARY_ENABLED`, `DATABASE_SHEETS_BACKUP_ENABLED`, `DATABASE_RETENTION_ENABLED`, `DATABASE_RETENTION_POLL_MS`

### Google credentials and primary Sheets

`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CREDENTIALS_JSON`, `GOOGLE_SHEETS_ID`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_WORKSHEET_NAME`, `GOOGLE_WORKSHEET_NAME`, `GOOGLE_SHEETS_RANGE`

### Sheet tab/range configuration

`GOOGLE_SHEETS_RIDES_WORKSHEET_NAME`, `GOOGLE_SHEETS_RIDES_RANGE`, `GOOGLE_SHEETS_NEEDS_REVIEW_WORKSHEET_NAME`, `GOOGLE_SHEETS_NEEDS_REVIEW_RANGE`, `GOOGLE_SHEETS_UPCOMING_JOBS_WORKSHEET_NAME`, `GOOGLE_SHEETS_UPCOMING_JOBS_RANGE`, `GOOGLE_SHEETS_FINAL_BID_WORKSHEET_NAME`, `GOOGLE_SHEETS_FINAL_BID_RANGE`, `GOOGLE_SHEETS_DRIVERS_WORKSHEET_NAME`, `GOOGLE_SHEETS_DRIVERS_RANGE`, `GOOGLE_SHEETS_VEHICLES_WORKSHEET_NAME`, `GOOGLE_SHEETS_VEHICLES_RANGE`, `GOOGLE_SHEETS_OPERATIONS_VIEW_WORKSHEET_NAME`, `GOOGLE_SHEETS_OPERATIONS_VIEW_RANGE`, `GOOGLE_SHEETS_DRIVER_SCHEDULE_WORKSHEET_NAME`, `GOOGLE_SHEETS_DRIVER_SCHEDULE_RANGE`, `GOOGLE_SHEETS_VEHICLE_SCHEDULE_WORKSHEET_NAME`, `GOOGLE_SHEETS_VEHICLE_SCHEDULE_RANGE`, `GOOGLE_SHEETS_LINKED_RIDES_WORKSHEET_NAME`, `GOOGLE_SHEETS_LINKED_RIDES_RANGE`, `GOOGLE_SHEETS_BID_TRACKER_WORKSHEET_NAME`, `GOOGLE_SHEETS_BID_TRACKER_RANGE`, `GOOGLE_SHEETS_DISPATCH_CRITERIA_WORKSHEET_NAME`, `GOOGLE_SHEETS_DISPATCH_CRITERIA_RANGE`, `GOOGLE_SHEETS_AUDIT_LOG_WORKSHEET_NAME`, `GOOGLE_SHEETS_AUDIT_LOG_RANGE`, `GOOGLE_SHEETS_ARCHIVE_WORKSHEET_NAME`, `GOOGLE_SHEETS_ARCHIVE_RANGE`

### PreBook and Groups Sheet sources

`PREBOOK_GOOGLE_SHEETS_ID`, `PREBOOK_WORKSHEET_NAME`, `WHATSAPP_SOURCE_GOOGLE_SHEETS_ID`, `WHATSAPP_SOURCE_WORKSHEET_NAMES`, `JOB_LINKER_ENABLED`, `JOB_LINKER_SYNC_MS`, `JOB_LINKER_OTS_ENABLED`

### WhatsApp

`WHATSAPP_ENABLED`, `WHATSAPP_CLIENT_ID`, `WHATSAPP_SESSION_PATH`, `WHATSAPP_SESSION_DIR`, `WHATSAPP_STARTUP_TIMEOUT_MS`, `WHATSAPP_AUTO_CLEAR_STALE_SESSION`, `ALLOWED_GROUPS`, `ALLOWED_GROUP_IDS`, `ALLOWED_GROUP_NAMES`, `ALLOW_FROM_ME_MESSAGES`, `WHATSAPP_ALLOW_FROM_ME_TEST_MESSAGES`, `WHATSAPP_BACKFILL_ENABLED`, `WHATSAPP_BACKFILL_HOURS`, `WHATSAPP_BACKFILL_PER_GROUP`, `WHATSAPP_DIRECT_DATABASE_ENABLED`, `WHATSAPP_DIRECT_INGEST_URL`, `WHATSAPP_DIRECT_INGEST_TOKEN`, `WHATSAPP_DIRECT_QUEUE_PATH`, `WHATSAPP_DIRECT_RETRY_MS`, `WHATSAPP_INGEST_DEBUG`, `INGEST_DEBUG`, `PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_NO_SANDBOX`

### OTS and bid submission

`OTS_INTEGRATION_ENABLED`, `OTS_PROJECT_PATH`, `OTS_FORMATTED_ROWS_PATH`, `OTS_GROUP_NAME`, `OTS_SOURCE_NAME`, `OTS_RUN_PIPELINE`, `OTS_POLL_MS`, `OTS_BID_SUBMIT_SCRIPT`, `OTS_BID_SUBMIT_TIMEOUT_MS`, `AUTO_BID_ENABLED`, `AUTO_BID_MODE`, `AUTO_BID_POLL_MS`

### Shared ride/bid criteria

`ALLOWED_AREA_CODES`, `AREA_CODE_MATCH_MODE`, `BID_ALLOWED_GROUPS`, `BID_ALLOWED_VEHICLES`, `BID_EXCLUDED_VEHICLES`, `BID_MIN_FARE`, `BID_MIN_DISTANCE`, `BID_MAX_DISTANCE`, `BID_MIN_SCORE`, `FINAL_BID_ENABLED`, `FINAL_BID_ALLOWED_GROUPS`, `FINAL_BID_ALLOWED_VEHICLES`, `FINAL_BID_EXCLUDED_VEHICLES`, `FINAL_BID_ALLOWED_AREA_CODES`, `FINAL_BID_AREA_MATCH_MODE`, `FINAL_BID_MIN_FARE`, `FINAL_BID_MIN_DISTANCE`, `FINAL_BID_MAX_DISTANCE`, `FINAL_BID_MIN_SCORE`, `FINAL_BID_REQUIRE_DISTANCE`, `FINAL_BID_REQUIRE_FARE`, `DEFAULT_CURRENCY`, `FARE_BASE`, `FARE_PER_KM`

### Routing, AI, OCR, and dedupe

`GEOCODING_PROVIDER`, `GEOCODING_BASE_URL`, `GEOCODING_USER_AGENT`, `GEOCODING_TIMEOUT_MS`, `GEOCODING_API_KEY`, `OSRM_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_ENABLED`, `OPENAI_EXTRACTION_ENABLED`, `BID_AI_REVIEW_ENABLED`, `OCR_TESSERACT_PATH`, `OCR_TIMEOUT_MS`, `OCR_TEMP_DIR`, `DEDUPE_STORE_PATH`, `DEDUPE_TTL_MS`, `DEDUPE_MAX_ENTRIES`

### Polling, Calendar, operations, and retention

`GOOGLE_CALENDAR_ID`, `CALENDAR_ENABLED`, `CALENDAR_COMPANY_CODE`, `CALENDAR_EVENT_DURATION_MINUTES`, `CALENDAR_APPROVAL_POLL_MS`, `OPERATIONS_VIEW_REFRESH_MS`, `RECOMMENDATION_POLL_MS`, `RETENTION_CLEANUP_ENABLED`, `RETENTION_CLEANUP_POLL_MS`, `RETENTION_COMPLETED_DAYS`, `RETENTION_REVIEW_DAYS`, `RETENTION_AUDIT_DAYS`, `EXPIRED_RIDE_CLEANUP_ENABLED`, `EXPIRED_RIDE_CLEANUP_POLL_MS`

## 12. Tricky details for a new developer

- The business timezone is Europe/London even if the developer/VPS is elsewhere.
- `Tue 20th Oct 26`, long textual dates, ISO dates, numeric dates, and Google duration values can all appear. Do not replace the parser with `new Date(sourceText)`.
- Master is an inventory view, not an eligibility view. A ride can appear in Master and be ineligible for Linker/Auto Bid.
- Groups does not show every WhatsApp ride. It shows only current `Upcoming Jobs >79` rows.
- `Booking ID` is the PreBook business reference. `ACE ID` is not used to confirm an OTS bid.
- OTS guide price and internally calculated route/fare are different concepts.
- `Submission Unconfirmed` is truthful and retryable; do not convert it to success/loss without provider evidence.
- Possible Returns are persisted but remain review-only. Their statuses differ from strict links.
- Archived opportunities should survive matching refreshes but disappear when the candidate pickup passes.
- Source health requires recent sync/read/write/error evidence. A process being `online` is not enough.
- Do not reset WhatsApp to fix Google Sheets, OTS, Linker, or dashboard problems.
- Use the production API snapshot and server logs to distinguish a frontend filter problem from a source/parser/backend problem.
- Before any production claim, recheck current code, PM2 state, source counts, last sync/error fields, and live Vercel assets. Historical screenshots and prior counts become stale quickly.
