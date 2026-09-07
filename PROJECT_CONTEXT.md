# Taxi Job Linker Current State

## Production

- Client dashboard: `https://taxi-dispatch-dashboard.vercel.app`.
- Backend: VPS PM2 service `taxi-dispatch-v2` on port `3001`.
- Primary data store: Supabase.
- Production backup created before the Job Linker migration:
  `/opt/taxi-dispatch-backups/pre-job-linker-1788091077322.json`.
- The separate PM2 service named `ride-bot` was not changed or removed.

## Final Client UI

The dashboard is one dark charcoal/amber operational UI with six tabs:

1. `Master`: all valid, currently live OTS quotation requests; Linker criteria do not filter this inventory.
2. `Bid`: persisted manual OTS submissions with truthful submission and confirmation states.
3. `PreBook`: confirmed booked jobs used as linker anchors.
4. `Groups`: eligible WhatsApp group jobs only.
5. `Linker`: realistic PreBook-to-OTS/WhatsApp return opportunities.
6. `Settings`: shared rules, source health, manual sync, WhatsApp controls, and Trash recovery.

The client frontend is a clean static Vercel app in `dashboard/` and reads real data from `GET /api/job-linker`. It has no Driver, Fleet, Guide, fake OTS account, or in-memory demo screens. Lists are searchable, selectable, grouped by vehicle, and paginated at 24 rows. Source lists default to pickup date ascending and then pickup time ascending. Operational datetimes display as `Fri, 03 Sept 2027, 05:00 am`. Master supports Upcoming (current UK week), Future, GBP 100+, custom/quick date ranges, mileage, vehicle, fare, and alternate sorting. Manual deletion moves jobs to Trash for 24 hours before permanent deletion.

Master, PreBook, Groups, and Linker show their own backend source state. Master shows the last OTS update time plus source-loaded, newly-added, updated, and removed/deleted counts from the last complete sync. A failed or still-starting source is never labelled live, and client responses do not expose raw server paths or stack traces.

## Manual Bid Flow

- `GET /api/job-linker` includes persisted `bids` joined to trusted ride data.
- Master submits only `rideId`, `bidAmount`, and an optional reason to authenticated `POST /api/job-linker/bids`.
- The server reloads the OTS ride from Supabase, validates that it is active, and reserves the bid under a per-ride PostgreSQL transaction lock. The POST then returns immediately while a durable server queue invokes `src/bids/otsSubmitter.js`, which calls the OTS worker V2 script with only `--reference` and `--amount`.
- Status progresses through `Created`, `Submitting`, and then `Submitted`, `Submission Unconfirmed`, or `Submission Failed`.
- The dashboard polls persisted status with a fixed timeout. Provider submission requires an exact visible OTS reference, a successful natural provider acceptance response, and Price/Submit form disappearance for a continuous 3 seconds. A browser refresh or transient frontend failure cannot create a second bid.
- A successful browser submission is not treated as a won job. At bid reservation time the server stores normalized OTS `rides.refer` as `pricing_payload.sourceReferenceKey`. `Confirmed` requires that exact normalized business reference to equal booked PreBook `rides.refer`, sourced from the sheet `Booking ID` column. `ACE ID` and internal Supabase `ride_id` are not confirmation identifiers. Matching ignores case and whitespace only. An expired submitted offer without that signal becomes `Unconfirmed`; the system never fabricates `Lost`.
- Repeated submission is blocked by persisted status checks and the server-side advisory lock. Failed and unconfirmed attempts are retryable from Master when the OTS job is still active. Master and Bid reload their state from the API, so browser refresh does not lose bid history.
- Auto Bid remains disabled. Multi-account OTS sessions are outside the current delivery.

## Source Flow

- OTS runs independently of WhatsApp through `/opt/ride-management-worker`.
- OTS pipeline and Job Linker sync run automatically every 60 seconds.
- OTS production formatting is deterministic and does not use OpenAI.
- Every complete scrape publishes the full current OTS inventory. Master displays the exact source guide minimum/maximum and source sentence; OSRM estimates remain internal and are never presented as the OTS guide fare.
- The OTS scraper waits for each selected detail panel to finish loading before it captures the guide range, passenger count, and luggage wording. A loading placeholder is never imported as source detail.
- WhatsApp ingestion continues through the existing parser. The external WhatsApp source spreadsheet `1a3iA7ze74SIDU2uCFlfFL2OfUAkZBkuHIghnsjHmGj4` is also synchronized from its `Saloon` and `MPV` tabs. Only jobs passing the shared Job Linker formula appear in `Groups`; the source tab determines the normalized vehicle category.
- `Groups` can be filtered by `All vehicles`, `Saloon`, or `MPV`.
- WhatsApp currently requires a QR scan when no valid LocalAuth session exists. Settings renders and refreshes the protected QR image directly. The operator can load connected groups, add/remove allowed groups with checkboxes, save the selection, or clear all groups to disable group ingestion.
- PreBook is connected to spreadsheet `1u21VzELr3jkNsWswUitNOXmNvDVKTx_fugm-4pMRKOk`, tab `Bookings`. Cancelled and expired bookings are excluded.

## Shared Formula

- Minimum fare: `GBP 80`.
- Vehicles: `Saloon`, `MPV`, `6 Seater` with supported aliases normalized.
- Area rule: pickup or drop must match the configured UK postcode/airport code list.
- A valid UK pickup date and time is required.
- This rule filters WhatsApp Groups and Linker candidates. It does not filter the OTS Master inventory.

## Linker

- Only PreBook jobs are matching anchors.
- Candidates come from eligible OTS and WhatsApp jobs.
- Numeric PreBook dates are parsed using the date order inferred from the sheet, including month-first Google Sheets exports; displayed dates remain UK-formatted.
- Vehicle category must match.
- Deadhead is always routed from the previous ride's dropoff to the next ride's pickup; postcode-prefix guesses are not used.
- Full UK postcodes resolve through postcodes.io, airport aliases use fixed verified coordinates, and other addresses use the configured geocoder fallback. OSRM supplies road distance and travel time.
- The next ride must fit after the previous road-route duration, deadhead travel time, and configured turnaround buffer.
- The next ride must make measurable progress back toward the previous ride's original pickup.
- Score: deadhead 35, availability 20, return direction 25, vehicle 20. Deadhead over 90 road miles is rejected.
- Output includes direction, gap, deadhead distance, estimated saving, reason, and score breakdown.

## Retention

- OTS jobs expire at the earlier of the portal offer expiry or 12 hours after pickup. This keeps Master aligned with references still searchable on OTS.
- WhatsApp and PreBook source jobs expire 12 hours after pickup.
- Expired jobs are permanently deleted with dependent temporary records, except rides and bid records protected by manual bid history.
- Ineligible and already-expired source rows are blocked from re-import.
- Operator-deleted jobs remain recoverable in Trash for 24 hours, protected by tombstones so source sync cannot immediately recreate them.
- Retention runs hourly; a manual production cleanup removed historical/ineligible source rows after backup.

## Preserved Backend

The prior ride extraction, Sheets backup, Final Bid, recommendation, schedules, bidding, and Calendar modules remain in the codebase for compatibility. They are hidden from the final client Job Linker UI and were not rewritten.

## Production Security

- The VPS owns Supabase, Google, WhatsApp, OTS, and filesystem credentials. Vercel receives only `DASHBOARD_API_BASE_URL`.
- Dashboard API calls accept `X-Dashboard-Token` and the supported Bearer form. With `NODE_ENV=production`, a missing `DASHBOARD_AUTH_TOKEN` fails closed instead of making dashboard APIs public.
- Browser CORS origins must be explicitly listed in `DASHBOARD_ALLOWED_ORIGINS`.
- OTS remains one real worker session. Auto Bid, multi-account OTS, Driver/Fleet planning, live GPS, and EV recommendations are not exposed in the client UI.
- `.env`, `credentials.json`, browser caches, and WhatsApp LocalAuth data are ignored and removed from current Git tracking while remaining on the local machine. Credentials that existed in earlier Git history must be rotated before the release is deployed.

## Verification

- Full automated suite: 274 unit tests and 5 smoke tests passing.
- `npm run check` passes.
- Eight frontend contract tests cover final navigation, real API wiring, persisted Bid polling, exact source guide/copy fields, backend Linker facts, source failure states, truthful Bid counters, responsive card structure, and encoding safety.
- The operator's separately controlled real OTS bid test passed through local OTS: exact reference `OTS-06092026155015-32030-1`, bid amount `GBP 125`, OTS displayed persistent `Price Sent` confirmation after reload. Automated tests never submit a real provider bid.
- OTS worker V2 has 28 local regression tests covering exact reference filtering, React keyboard amount entry, correct detail scroll container, overlay-safe keyboard Submit, one activation maximum, provider response observation, and 3-second form-disappearance confirmation.
- Link counts are live and may be zero when no current PreBook/source pair satisfies the independent Linker rules.
- Migration `007_ots_master_hotfix.sql` stores exact OTS guide/passenger/luggage metadata and protects existing bid source rides.
