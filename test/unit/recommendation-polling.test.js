const assert = require("node:assert/strict");
const test = require("node:test");

test("recommendation polling reuses active run for concurrent manual ticks", async () => {
  const enginePath = require.resolve("../../src/engine");
  const pollingPath = require.resolve("../../src/polling");
  const engine = require(enginePath);
  const original = {
    processApprovedDriverRecommendations: engine.processApprovedDriverRecommendations,
    recommendDriversForApprovedRides: engine.recommendDriversForApprovedRides
  };

  let releaseAssignment;
  const assignmentGate = new Promise((resolve) => {
    releaseAssignment = resolve;
  });
  let assignmentCalls = 0;
  let recommendationCalls = 0;

  try {
    engine.processApprovedDriverRecommendations = async () => {
      assignmentCalls += 1;
      await assignmentGate;
      return { checked: 1, assigned: 0, skipped: 0, failed: 0 };
    };
    engine.recommendDriversForApprovedRides = async () => {
      recommendationCalls += 1;
      return { appended: 1, skipped: 0, recommendations: [{ "Ride ID": "RID-1" }] };
    };
    delete require.cache[pollingPath];
    const { startRecommendationPolling } = require(pollingPath);

    const poller = startRecommendationPolling({
      intervalMs: 600000,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
      }
    });

    const firstTick = poller.tick();
    const secondTick = poller.tick();
    releaseAssignment();
    const [firstResult, secondResult] = await Promise.all([firstTick, secondTick]);
    poller.stop();

    assert.equal(assignmentCalls, 1);
    assert.equal(recommendationCalls, 1);
    assert.deepEqual(firstResult, secondResult);
  } finally {
    engine.processApprovedDriverRecommendations = original.processApprovedDriverRecommendations;
    engine.recommendDriversForApprovedRides = original.recommendDriversForApprovedRides;
    delete require.cache[pollingPath];
  }
});
