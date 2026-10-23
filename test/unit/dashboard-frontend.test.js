const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const dashboardDir = path.resolve(__dirname, "../../dashboard");
const html = fs.readFileSync(path.join(dashboardDir, "index.html"), "utf8");
const script = fs.readFileSync(path.join(dashboardDir, "app.js"), "utf8");
const reportScript = fs.readFileSync(path.join(dashboardDir, "report.js"), "utf8");
const styles = fs.readFileSync(path.join(dashboardDir, "styles.css"), "utf8");
const vercelConfig = JSON.parse(fs.readFileSync(path.join(dashboardDir, "vercel.json"), "utf8"));
const deployScript = fs.readFileSync(path.resolve(__dirname, "../../scripts/deploy-ots-dashboard.ps1"), "utf8");

test("dashboard deployment always promotes the customer-facing alias and disables static cache", () => {
  assert.match(deployScript, /vercel\.cmd deploy --prod --yes --format json/);
  assert.match(deployScript, /ots-chat\.vercel\.app/);
  assert.match(deployScript, /vercel\.cmd alias set/);
  const cacheRules = new Map(vercelConfig.headers.map((rule) => [rule.source, rule.headers?.[0]?.value]));
  for (const asset of ["/", "/app.js", "/report.js", "/styles.css", "/qr.css"]) {
    assert.equal(cacheRules.get(asset), "no-store, max-age=0, must-revalidate");
  }
});

test("client dashboard exposes only the final operational navigation", () => {
  const tabs = [...html.matchAll(/class="nav-item(?: active)?" data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["master", "bid", "prebook", "groups", "linker", "settings"]);
  assert.doesNotMatch(html, /data-tab="(?:driver|fleet|guide)"/i);
  assert.doesNotMatch(html, /live GPS|EV recommendation/i);
  assert.match(html, /id="auto-bid-toggle"/);
  assert.match(html, /id="auto-bid-form"/);
  assert.match(html, /Future months \(exclude current\)/);
  assert.match(html, /Custom range/);
  assert.match(html, /role="switch"/);
  assert.match(html, /ACE OTS Supplier/);
  assert.doesNotMatch(html, /ACE Job Linker/);
  assert.doesNotMatch(html.match(/data-view="master"[\s\S]*?data-view="bid"/)?.[0] || "", /auto-bid-toggle/);
  assert.match(script, /Executive People Carrier/);
  assert.match(script, /Fleet Bus/);
  assert.match(script, /\/api\/job-linker\/auto-bid\/settings/);
  assert.match(script, /ENABLE AUTO BID/);
});

test("dashboard offers a persistent accessible light and dark theme toggle", () => {
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /id="theme-icon"/);
  assert.match(html, /aceDashboardTheme/);
  assert.match(script, /const THEME_KEY = "aceDashboardTheme"/);
  assert.match(script, /function applyTheme\(theme\)/);
  assert.match(script, /document\.documentElement\.dataset\.theme/);
  assert.match(script, /Use light theme/);
  assert.match(script, /Use dark theme/);
  assert.match(styles, /html\[data-theme="light"\]/);
  assert.match(styles, /\.theme-toggle/);
  assert.match(styles, /color-scheme: light/);
});

test("dashboard uses real Job Linker and protected control endpoints", () => {
  assert.match(script, /request\("\/api\/job-linker"\)/);
  assert.match(script, /\/api\/job-linker\/criteria/);
  assert.match(script, /\/api\/job-linker\/trash/);
  assert.match(script, /\/api\/job-linker\/restore/);
  assert.match(script, /\/api\/whatsapp\/session/);
  assert.match(script, /\/api\/whatsapp\/allowed-groups/);
  assert.doesNotMatch(script, /const\s+(?:jobsData|groupsJobsData|fleetData|driverData)\s*=/);
});

test("Bid tab renders persisted bids and Master uses the guarded endpoint", () => {
  assert.match(html, /data-view="bid"/);
  assert.match(html, /id="bid-list"/);
  assert.match(script, /request\("\/api\/job-linker\/bids"/);
  assert.match(script, /state\.data\?\.bids/);
  assert.match(script, /function renderBids\(\)/);
  assert.doesNotMatch(script, /fake|mock bid|bidTabData/i);
  assert.match(script, /pollBidStatus\(rideId\)/);
  assert.match(script, /BID_POLL_TIMEOUT_MS/);
  assert.match(script, /terminalBidStatus/);
  assert.match(html, /id="bid-search"/);
  assert.match(script, /state\.bidQuery/);
  assert.match(html, /class="bid-table-head"/);
  assert.match(html, /class="bid-list" id="bid-list"/);
  assert.match(styles, /\.bid-table-head, \.bid-card/);
  assert.doesNotMatch(script, /page\.page === 1 \? "featured"/);
  assert.match(script, /function bidTimingLine\(bid/);
  assert.match(script, /Bid sent/);
  assert.match(script, /OTS worker/);
  assert.match(styles, /\.bid-timing/);
});

test("manual bidding stays on Master and hides only active persisted attempts", () => {
  const submitBlock = script.slice(script.indexOf("async function submitManualBid"), script.indexOf("function renderTrash"));
  assert.doesNotMatch(submitBlock, /setTab\("bid"\)/);
  assert.match(script, /bidBlocksSubmission\(bidForRide\(job\.rideId\)\)/);
});

test("Bid tab downloads a selected-range PDF operations report with source, bid and Linker facts", () => {
  assert.match(html, /id="report-from"/);
  assert.match(html, /id="report-to"/);
  assert.match(html, /id="download-report"/);
  assert.match(html, /data-report-preset="2"/);
  assert.match(html, /data-report-preset="4"/);
  assert.match(html, /data-report-preset="month"/);
  assert.match(script, /function downloadOperationsReport\(\)/);
  assert.match(script, /OTS rides received/);
  assert.match(script, /WhatsApp rides received/);
  assert.match(script, /Manual bids/);
  assert.match(script, /Auto bids/);
  assert.match(script, /window\.OtsSupplierReport\.download/);
  assert.match(reportScript, /Why suggested/);
  assert.match(reportScript, /application\/pdf/);
  assert.match(reportScript, /ace-ots-supplier-report-/);
});

test("Auto Bid offers the protected current-month scope and editable OTS maximum deduction", () => {
  assert.match(html, /value="futureExcludingTodayTomorrow">Future \(exclude today and tomorrow\)/);
  assert.match(html, /value="currentMonthExcludingTodayTomorrow"/);
  assert.match(html, /value="customFrom">From date onward \(future\)/);
  assert.match(html, /name="priceDeduction" type="number"/);
  assert.match(script, /deductionValue === "" \? null : Number\(deductionValue\)/);
  assert.match(script, /values\.dateScope === "customFrom" && !values\.dateFrom/);
});

test("OTS demo mode keeps live OTS and Auto Bid controls functional while hiding other UI", () => {
  assert.match(script, /new URLSearchParams\(window\.location\.search\)\.get\("demo"\) === "ots"/);
  assert.match(script, /button\.dataset\.tab === "master" \|\| button\.dataset\.tab === "settings"/);
  assert.match(html, /id="auto-bid-panel"/);
  assert.match(html, /data-demo-hidden/);
  assert.match(styles, /body\.ots-demo \[data-demo-hidden\]/);
  assert.match(script, /\/api\/job-linker\/auto-bid\/settings/);
});

test("Master displays source guide prices and both copy actions use backend copyDetail", () => {
  assert.match(script, /function guidePrice\(job/);
  assert.match(script, /function defaultBidAmount\(job/);
  assert.match(script, /function positiveNumeric\(value\)/);
  assert.match(script, /function distanceLabel\(value\)/);
  assert.match(script, /Math\.round\(\(maximum - 5\) \* 100\) \/ 100/);
  assert.match(script, /job\.guidePriceMin/);
  assert.match(script, /guideLine = key === "master" && job\.guidePriceText/);
  assert.match(script, /if \(job\.copyDetail\) return job\.copyDetail/);
  assert.match(script, /return amount !== null && amount > 0 \? amount : null/);
  assert.match(script, /return miles === null \? "Distance missing"/);
  assert.doesNotMatch(script, /const bidValue = existingBid\?\.bidAmount \?\? numeric\(job\.fare\)/);
});

test("Master recommendation renders only persisted Linker facts", () => {
  assert.match(script, /function linkedRecommendation\(link\)/);
  assert.match(script, /link\.distanceBetween/);
  assert.match(script, /link\.timeGap/);
  assert.match(script, /link\.savingEstimate/);
  assert.match(script, /link\.reason/);
  assert.doesNotMatch(script, /driver recommendation|live gps|EV recommendation/i);
});

test("every filtered job view clears its controls and Linker can archive and unarchive suggestions", () => {
  for (const view of ["master", "bid", "prebook", "groups"]) {
    assert.match(html, new RegExp(`id="${view}-clear-filters"`));
    assert.match(script, new RegExp(`\\$\\("#${view}-clear-filters"\\)\\.addEventListener`));
  }
  assert.match(html, /id="archived-links"/);
  assert.match(script, /data-archive-link/);
  assert.match(script, /\/api\/job-linker\/links\/\$\{encodeURIComponent\(archiveButton\.dataset\.archiveLink\)\}\/archive/);
  assert.match(script, /data-unarchive-link/);
  assert.match(script, /\/api\/job-linker\/links\/\$\{encodeURIComponent\(unarchiveButton\.dataset\.unarchiveLink\)\}\/unarchive/);
});

test("dashboard includes responsive cards and has no broken legacy encoding", () => {
  assert.match(styles, /\.job-columns\s*\{/);
  assert.match(styles, /@media \(max-width: 820px\)/);
  assert.match(styles, /@media \(max-width: 560px\)/);
  assert.doesNotMatch(`${html}\n${script}`, /Â|â|ðŸ|\uFFFD/);
});

test("each live source exposes a truthful loading or failure state", () => {
  assert.match(html, /id="master-source-banner"/);
  assert.match(html, /id="prebook-banner"/);
  assert.match(html, /id="groups-banner"/);
  assert.match(html, /id="linker-source-message"/);
  assert.match(script, /Loading live workspace/);
  assert.match(script, /source\.otsLastError/);
  assert.match(script, /source\.prebookLastError/);
  assert.match(script, /source\.whatsappSheetLastError/);
  assert.match(script, /source\.linkerLastError/);
  assert.doesNotMatch(script, /silently use demo|fallback fake/i);
});

test("Bid summary does not count confirmed bids as submitted and unconfirmed", () => {
  assert.match(script, /\["submitted", "unconfirmed"\]\.includes\(String\(bid\.bidStatus\)/);
  assert.doesNotMatch(script, /String\(bid\.submissionState\)\.toLowerCase\(\) === "submitted"/);
});

test("Linker keeps possible returns visibly separate and review-only", () => {
  assert.match(html, /id="possible-links"/);
  assert.match(script, /possibleLinks/);
  assert.match(script, /Manual review only/);
  assert.match(script, /They never trigger Auto Bid/);
  assert.match(styles, /\.link-card\.possible/);
  assert.match(script, /No reviewed return suggestion passed the current route checks/);
  const possibleBlock = script.slice(script.indexOf('class="link-card possible"'), script.indexOf("No reviewed return suggestion passed"));
  assert.match(possibleBlock, /data-archive-link/);
});

test("terminal unconfirmed bids stop polling instead of showing still processing", () => {
  const block = script.slice(script.indexOf("function terminalBidStatus"), script.indexOf("async function pollBidStatus"));
  assert.match(block, /status === "submission unconfirmed"/);
});

test("failed and unconfirmed submission attempts remain retryable from Master", () => {
  const block = script.slice(script.indexOf("function bidBlocksSubmission"), script.indexOf("function jobFromBid"));
  assert.match(block, /"submission failed"/);
  assert.match(block, /"submission unconfirmed"/);
  assert.doesNotMatch(block, /"submitted"/);
});

test("Master shows OTS freshness, additions and removals", () => {
  assert.match(script, /function otsSyncSummary\(source/);
  assert.match(script, /Last OTS update/);
  assert.match(script, /source\.otsRowsAdded/);
  assert.match(script, /source\.otsRowsRemoved/);
  assert.match(script, /New OTS rides last sync/);
  assert.match(script, /Removed\/deleted last sync/);
});

test("Master and Groups expose matching mileage and job filters", () => {
  assert.match(html, /data-mileage-scope="master" data-mileage-value="49\+"/);
  assert.match(html, /data-mileage-scope="master" data-mileage-value="99\+"/);
  assert.match(html, /data-mileage-scope="groups" data-mileage-value="49\+"/);
  assert.match(html, /data-mileage-scope="groups" data-mileage-value="99\+"/);
  assert.match(html, /id="groups-date-from"/);
  assert.match(html, /id="groups-mileage"/);
  assert.match(html, /id="groups-fare"/);
  assert.match(html, /id="groups-clear-filters"/);
  assert.match(script, /state\.groups = \{ preset: "all", mileage: "all", vehicle: "all", location: "all", fare: "all"/);
  assert.match(script, /filter\.preset === "upcoming"/);
  assert.match(script, /state\.groups\.mileage/);
  assert.match(script, /dataset\.mileageScope/);
});

test("every operational tab can filter and label Inside or Outside London", () => {
  for (const id of ["master-location", "bid-location", "prebook-location", "groups-location", "linker-location"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="linker-clear-filters"/);
  assert.match(script, /LONDON_POSTCODE_AREAS = new Set\(\["E", "EC", "N", "NW", "SE", "SW", "W", "WC"\]\)/);
  assert.match(script, /function locationClassForValues/);
  assert.match(script, /function locationClassForLink/);
  assert.match(script, /locationMatches\(locationClassForJob\(job\), filter\.location\)/);
  assert.match(script, /locationMatches\(locationClassForJob\(bid\), state\.bidLocation\)/);
  assert.match(script, /locationMatches\(locationClassForLink\(link\), state\.linkerLocation\)/);
  assert.match(script, /Inside London/);
  assert.match(script, /Outside London/);
  assert.match(styles, /\.location-pill\.inside/);
  assert.match(styles, /\.location-pill\.outside/);
});
