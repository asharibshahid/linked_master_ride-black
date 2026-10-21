# Taxi OTS Supplier Current State

## Production

- Client dashboard: `https://ots-chat.vercel.app` (the previous `taxi-dispatch-dashboard.vercel.app` alias remains available).
- Backend: VPS PM2 service `taxi-dispatch-v2` on port `3001`.
- Primary data store: Supabase.
- Production backup created before the Job Linker migration:
  `/opt/taxi-dispatch-backups/pre-job-linker-1788091077322.json`.
- Linker runtime files were backed up before the 2026-10-19 relevance release at
  `/opt/taxi-dispatch-backups/20261019-linker-relevance/`.
- The separate PM2 service named `ride-bot` at `/opt/groups-dt` on port `3000` is the single WhatsApp collector. It sends eligible rides directly to the backend through a protected localhost endpoint and continues writing Google Sheets as a backup.
- `ride-bot` QR recovery is available at `http://194.163.163.37:3000/qr`; it auto-refreshes the QR image and exposes manual Restart and Reset Session controls. It now stays online during QR/session recovery instead of repeatedly crashing while waiting for a scan.
- The main `taxi-dispatch-v2` backend has `WHATSAPP_ENABLED=false`; it does not launch a competing WhatsApp browser/session.

## Final Client UI

The dashboard is one dark charcoal/amber operational UI with six tabs:

1. `Master`: all valid, currently live OTS quotation requests; Linker criteria do not filter this inventory.
2. `Bid`: persisted manual and Auto Bid OTS attempts with truthful submission and confirmation states.
3. `PreBook`: confirmed booked jobs used as linker anchors.
4. `Groups`: current rows from the `Upcoming Jobs >79` Google Sheet tab only; direct WhatsApp ingestion remains active but is hidden here.
5. `Linker`: strict confirmed PreBook return pairs and realistic PreBook-to-OTS/Sheet return opportunities, with an operator Archive section.
6. `Settings`: shared rules, source health, manual sync, WhatsApp controls, and Trash recovery.

The client frontend is a clean static Vercel app in `dashboard/` and reads real data from `GET /api/job-linker`. It has no Driver, Fleet, Guide, fake OTS account, or in-memory demo screens. Lists are searchable, selectable, grouped by vehicle, and paginated at 24 rows. Source lists default to pickup date ascending and then pickup time ascending. Operational datetimes display as `Fri, 03 Sept 2027, 05:00 am`. Master supports Upcoming (current UK week), Future, GBP 100+, custom/quick date ranges, mileage, vehicle, fare, and alternate sorting. Manual deletion moves jobs to Trash for 24 hours before permanent deletion. Deploy the dashboard only with `npm run dashboard:deploy`; it promotes `ots-chat.vercel.app` to the new Vercel production deployment, verifies live HTML/JS hashes against local release files, and serves dashboard assets with no-store cache headers.

The header sun/moon control switches between the original dark theme and a high-contrast light theme. The selected theme is saved per browser and restored before the dashboard renders.

Bid search covers reference, route, status, type, amount, and reason. Bids use a compact line-wise desktop table and responsive mobile rows. The PDF operations report supports the last 2, 4, or 7 days, the current month, or a custom inclusive date range and records OTS/WhatsApp ride counts, manual/Auto Bid activity, and Linker suggestions with their reasons.
Master, Bid, PreBook, and Groups each have a Clear filters control.

Master, Bid, PreBook, Groups, and Linker expose an `All areas`, `Inside London`, or `Outside London` filter and show the classification on each job/link. Inside London is determined only from the verified postcode prefixes `E`, `EC`, `N`, `NW`, `SE`, `SW`, `W`, and `WC` found in either route endpoint. Other recognized UK postcode areas are Outside London; missing/unrecognized postcodes remain `Area unknown` instead of being guessed. Linker applies the same filter to strict, possible, and archived opportunities.

Each new bid records queue, worker-start, provider-Submit, and completion timestamps plus worker/total duration. The Bid row displays the provider Submit time and elapsed seconds. Fresh successful source synchronization wakes Auto Bid immediately; the periodic runner remains as a fallback. V2 keeps exact-reference and one-activation safety while limiting the first stale-card view to 15 seconds before its single clean reload.

OTS detail extraction waits for the guide-price line, not only the initial Details heading. A transient source row without guide fields cannot erase an already stored valid guide range. Bid Copy Detail includes the persisted submitted bid price independently of source guide availability.
Every new persisted bid also snapshots its OTS guide minimum, maximum, and original guide text. Bid Copy Detail reconstructs a full range from numeric fields, reports a recovered maximum/minimum honestly when only one bound exists, and explicitly says when the source snapshot had no guide data instead of silently omitting the line.

Master, PreBook, Groups, and Linker show their own backend source state. Master shows the last OTS update time plus source-loaded, newly-added, updated, and removed/deleted counts from the last complete sync. A failed or still-starting source is never labelled live, and client responses do not expose raw server paths or stack traces.

## Manual Bid Flow

- `GET /api/job-linker` includes persisted `bids` joined to trusted ride data.
- Master submits only `rideId`, `bidAmount`, and an optional reason to authenticated `POST /api/job-linker/bids`.
- The server reloads the OTS ride from Supabase, validates that it is active, and reserves the bid under a per-ride PostgreSQL transaction lock. The POST then returns immediately while a durable server queue invokes `src/bids/otsSubmitter.js`, which calls the OTS worker V2 script with only `--reference` and `--amount`.
- Status progresses through `Created`, `Submitting`, and then `Submitted`, `Submission Unconfirmed`, or `Submission Failed`.
- The dashboard polls persisted status with a fixed timeout. Provider submission requires an exact visible OTS reference, a successful natural provider acceptance response, and Price/Submit form disappearance for a continuous 3 seconds. A browser refresh or transient frontend failure cannot create a second bid.
- A successful browser submission is not treated as a won job. At bid reservation time the server stores normalized OTS `rides.refer` as `pricing_payload.sourceReferenceKey`. `Confirmed` requires that exact normalized business reference to equal booked PreBook `rides.refer`, sourced from the sheet `Booking ID` column. `ACE ID` and internal Supabase `ride_id` are not confirmation identifiers. Matching ignores case and whitespace only. An expired submitted offer without that signal becomes `Unconfirmed`; the system never fabricates `Lost`.
- Repeated submission is blocked by persisted status checks and the server-side advisory lock. Failed and unconfirmed attempts are retryable from Master when the OTS job is still active. Master and Bid reload their state from the API, so browser refresh does not lose bid history.
- Auto Bid is available only in Settings and defaults to OFF. Its date scope supports Today, Tomorrow, Current Month, Current Month excluding Today and Tomorrow, Future Months excluding the current month, Next Month, an inclusive custom UK-date range, or a custom start date onward with no end date. Mileage, selected OTS vehicle types, OTS guide maximum deduction, and minimum expiry are configurable. Deduction `0` explicitly bids the OTS maximum; a blank deduction is rejected by the dashboard and normalizes to the safe default server-side. It queues one job at a time through the same V2 submitter and never automatically retries a ride with bid history.
- Auto Bid revalidates the persisted rule set immediately before reserving a bid. If rules change while an inventory evaluation is running, the old-scope candidate is discarded and the next cycle uses the new rules. Runtime messages name the selected date scope instead of assuming Tomorrow.

## Source Flow

- OTS runs independently of WhatsApp through `/opt/ride-management-worker`.
- OTS pipeline and Job Linker sync run automatically every 60 seconds.
- OTS scrape timeout is configured at 20 minutes (`OTS_SCRAPE_TIMEOUT_MS=1200000`) because large live inventories can exceed the old 10-minute limit while extracting detail panels.
- OTS production formatting is deterministic and does not use OpenAI.
- Every complete scrape publishes the full current OTS inventory. Master displays the exact source guide minimum/maximum and source sentence; OSRM estimates remain internal and are never presented as the OTS guide fare.
- The OTS scraper waits for each selected detail panel to finish loading before it captures the guide range, passenger count, and luggage wording. A loading placeholder is never imported as source detail.
- WhatsApp ingestion uses one collector: `ride-bot` parses allowed groups, writes a durable local retry queue, and posts normalized rides to protected `POST /api/job-linker/whatsapp-ingest`; the dashboard temporarily excludes direct WhatsApp rows from Groups and Linker. The VPS collector now displays pickup dates as `Tue 13th Oct 26` (using each ride's actual date), accepts both old long and new short dates for Upcoming Jobs eligibility, shortens Sheet pickup/drop-off to verified UK postcodes or airport codes when present, moves seat requirements to trailing `Special Instructions`, sends implausible route/fare values to Needs Review, and dedupes identical group text for 10 minutes. The three Sheet headers gained only the trailing instructions column. The WhatsApp session was preserved and reused on the collector restart.
- WhatsApp ride locations are resolved UK-only: known UK airports use fixed coordinates, full/outward postcodes use postcodes.io, and address fallback uses a GB-bounded Nominatim query whose returned country and coordinates must validate as UK. Foreign/similar-name matches are rejected instead of producing false mileage and fare.
- The collector still writes spreadsheet `1a3iA7ze74SIDU2uCFlfFL2OfUAkZBkuHIghnsjHmGj4`. The backend independently syncs only its `Upcoming Jobs >79` tab every 5 minutes for Groups and eligible Linker candidates. Current Sheet rows are shown regardless of shared fare/vehicle criteria; past pickups and rows removed from that tab disappear from Groups. Sheet references are upserted, while direct WhatsApp references stay hidden.
- After a successful WhatsApp login/reconnect, the collector backfills up to 24 hours and 100 recent messages per allowed group. Processed references are deduplicated for 7 days.
- `Groups` can be filtered by `All vehicles`, `Saloon`, or `MPV`.
- WhatsApp currently requires a QR scan when no valid LocalAuth session exists. The operational QR/restart/reset page is the collector page at `http://194.163.163.37:3000/qr`; collector controls are not served by the disabled backend WhatsApp instance.
- PreBook is connected to spreadsheet `1Qnq-KLFfuEtAdHEIwXIO6qNPbN9gVjphIXliCaJcUoo`, tab `Bookings`. Cancelled and expired bookings are excluded. Raw Google Sheets duration values take precedence over formatted clock text, including misleading `5:00` displays for `29:00`; `24+` hours roll into the following UK calendar day. PreBook dashboard dates show the source Sheet date and day offset when a rollover occurs.

## Shared Formula

- Minimum fare: `GBP 80`.
- Vehicles: `Saloon`, `MPV`, `6 Seater` with supported aliases normalized.
- Area rule: pickup or drop must match the configured UK postcode/airport code list.
- A valid UK pickup date and time is required.
- This rule filters WhatsApp Groups and Linker candidates. It does not filter the OTS Master inventory.

## Linker

- Eligible PreBook jobs and current eligible rows from the Groups `Upcoming Jobs >79` sheet are matching anchors.
- Strict candidates include other eligible confirmed PreBook bookings plus eligible OTS and Groups-sheet jobs; a booking cannot link to itself. Confirmed PreBook pairs are labelled as booked returns, not new bid opportunities.
- A link must follow the strict return pattern: the booked ride starts at a supported airport and finishes remotely; the later candidate starts remotely and returns to a supported airport. Reverse/outward and airport-to-airport chains are rejected before scoring.
- Numeric PreBook dates are parsed using the date order inferred from the sheet, including month-first Google Sheets exports; displayed dates remain UK-formatted.
- Vehicle category must match.
- Deadhead is always routed from the previous ride's dropoff to the next ride's pickup; postcode-prefix guesses are not used.
- Full UK postcodes resolve through postcodes.io, airport aliases use fixed verified coordinates, and other addresses use the configured geocoder fallback. OSRM supplies road distance and travel time.
- The next ride must fit after the previous road-route duration, deadhead travel time, and configured turnaround buffer.
- The post-ride wait window is configurable in Settings (currently 4 hours in production); the next pickup, routed ride duration, deadhead, and turnaround must all fit.
- The next ride must make measurable progress back toward the previous ride's original pickup.
- Score: deadhead 35, availability 20, return direction 25, vehicle 20. Deadhead over 90 road miles is rejected.
- Output includes direction, gap, deadhead distance, estimated saving, reason, and score breakdown.
- Linker independently exposes up to three bounded, same-vehicle, time-feasible `Possible returns` for manual review, even when another pair has a strict match. Review candidates must still follow the exact airport-outbound then remote-pickup-to-airport-return topology and make measurable progress back toward the first airport. They are ranked by geocoded drop-to-pickup proximity before the bounded route checks, so nearby non-exact postcodes are not displaced by earlier distant rows. Review suggestions may exceed only the strict wait/deadhead thresholds, are not persisted as strict links, and never affect Auto Bid.
- The Possible returns area stays visible at zero and reports the current PreBook count and any unusable pickup times, so a legitimate no-match result does not resemble a missing frontend release.
- Links whose candidate pickup time has passed are excluded from active and possible opportunities. Archive moves either a strict link or a manual-review Possible Return into a separate section; archived links persist through recalculation, can be unarchived, and expire at the candidate pickup time.

## Retention

- The `/opt/groups-dt` VPS cron runs `scripts/cleanup-expired-rides.js` every 5 minutes with a lock. It permanently deletes rows from only WhatsApp Sheet tabs `Rides`, `Needs Review`, and `Upcoming Jobs >79` when a valid UK pickup timestamp is at least 1 hour old; no archive is kept. Unknown timestamps, PreBook, OTS, bids, and other tabs are untouched. The in-process poller is disabled by default to avoid duplicate cleanup alongside cron.
- OTS jobs expire at the earlier of the portal offer expiry or 12 hours after pickup. This keeps Master aligned with references still searchable on OTS.
- The selected Groups Sheet jobs expire at pickup; other WhatsApp and PreBook source jobs retain their existing expiry rules.
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
- OTS remains one real worker session. Multi-account OTS, Driver/Fleet planning, live GPS, and EV recommendations are not exposed in the client UI.
- `.env`, `credentials.json`, browser caches, and WhatsApp LocalAuth data are ignored and removed from current Git tracking while remaining on the local machine. Credentials that existed in earlier Git history must be rotated before the release is deployed.

## Verification

- Full automated suite: 343 unit tests and 7 smoke tests passing.
- `npm run check` passes.
- Frontend contract tests cover final navigation, real API wiring, persisted Bid polling, selected-range PDF reporting, line-wise responsive Bid rows, Auto Bid settings, exact source guide/copy fields, backend Linker facts, source failure states, truthful Bid counters, and encoding safety.
- The operator's separately controlled real OTS bid test passed through local OTS: exact reference `OTS-06092026155015-32030-1`, bid amount `GBP 125`, OTS displayed persistent `Price Sent` confirmation after reload. Automated tests never submit a real provider bid.
- OTS worker V2 has 28 local regression tests covering exact reference filtering, React keyboard amount entry, correct detail scroll container, overlay-safe keyboard Submit, one activation maximum, provider response observation, and 3-second form-disappearance confirmation.
- Linker regression coverage locks all six approved and all seven rejected pairs from `sample.txt`; link counts remain live and may be zero when no current pair satisfies every rule.
- Production Groups parsing accepts the collector's short UK date format such as `Tue 20th Oct 26`; verified on 2026-10-19 with 41 future rows loaded from 47 source rows and no Sheet error.
- Migration `007_ots_master_hotfix.sql` stores exact OTS guide/passenger/luggage metadata and protects existing bid source rides.
