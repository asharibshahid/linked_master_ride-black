const test = require("node:test");
const assert = require("node:assert/strict");
const {
  backfillWhatsAppMessages,
  createWhatsAppBackfillRunner
} = require("../../src/whatsapp/backfill");

function message(id, timestamp) {
  return { id: { _serialized: id }, timestamp, body: id };
}

test("backfill dispatches recent allowed-group messages oldest first", async () => {
  const now = new Date("2026-09-11T12:00:00.000Z");
  const seen = [];
  const client = {
    async getChats() {
      return [
        {
          isGroup: true,
          id: { _serialized: "allowed@g.us" },
          name: "Allowed",
          async fetchMessages() {
            return [
              message("new", now.getTime() / 1000 - 60),
              message("old", now.getTime() / 1000 - 3600),
              message("expired", now.getTime() / 1000 - 90000)
            ];
          }
        },
        {
          isGroup: true,
          id: { _serialized: "blocked@g.us" },
          name: "Blocked",
          async fetchMessages() {
            throw new Error("blocked group must not be read");
          }
        }
      ];
    }
  };

  const result = await backfillWhatsAppMessages({
    client,
    onMessage: async (item) => seen.push(item.id._serialized),
    allowedGroupIds: ["allowed@g.us"],
    lookbackHours: 24,
    perGroupLimit: 100,
    now,
    logger: { info() {} }
  });

  assert.deepEqual(seen, ["old", "new"]);
  assert.deepEqual(result, { groups: 1, examined: 2, dispatched: 2 });
});

test("backfill runner coalesces concurrent reconnect requests", async () => {
  let releases;
  let calls = 0;
  const blocker = new Promise((resolve) => { releases = resolve; });
  const runner = createWhatsAppBackfillRunner({
    client: { async getChats() { calls += 1; await blocker; return []; } },
    onMessage: async () => {},
    allowedGroupIds: ["allowed@g.us"],
    logger: { info() {} }
  });

  const first = runner.run();
  const second = runner.run();
  assert.equal(first, second);
  releases();
  await first;
  assert.equal(calls, 1);
  assert.equal(runner.isRunning(), false);
});
