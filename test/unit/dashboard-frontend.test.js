const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const dashboardDir = path.resolve(__dirname, "../../dashboard");
const html = fs.readFileSync(path.join(dashboardDir, "index.html"), "utf8");
const script = fs.readFileSync(path.join(dashboardDir, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(dashboardDir, "styles.css"), "utf8");

test("client dashboard exposes only the final operational navigation", () => {
  const tabs = [...html.matchAll(/class="nav-item(?: active)?" data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["master", "bid", "prebook", "groups", "linker", "settings"]);
  assert.doesNotMatch(html, /data-tab="(?:driver|fleet|guide)"/i);
  assert.doesNotMatch(html, /Auto Bid|live GPS|EV recommendation/i);
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
});

test("Master displays source guide prices and both copy actions use backend copyDetail", () => {
  assert.match(script, /function guidePrice\(job/);
  assert.match(script, /job\.guidePriceMin/);
  assert.match(script, /guideLine = key === "master" && job\.guidePriceText/);
  assert.match(script, /if \(job\.copyDetail\) return job\.copyDetail/);
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
