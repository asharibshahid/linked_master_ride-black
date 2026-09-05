const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  listWhatsAppGroups,
  loadLiveWhatsAppGroups,
  normalizeGroupIds,
  persistAllowedGroups
} = require("../../src/whatsapp/groups");

test("listWhatsAppGroups returns only valid group chats in name order", () => {
  const groups = listWhatsAppGroups([
    { isGroup: false, id: { _serialized: "447700900001@c.us" }, name: "Direct" },
    { isGroup: true, id: { _serialized: "120363400000000002@g.us" }, name: "Zulu Jobs" },
    { isGroup: true, id: { _serialized: "120363400000000001@g.us" }, name: "Alpha Jobs" }
  ]);

  assert.deepEqual(groups, [
    { id: "120363400000000001@g.us", name: "Alpha Jobs" },
    { id: "120363400000000002@g.us", name: "Zulu Jobs" }
  ]);
});

test("loadLiveWhatsAppGroups falls back to the WhatsApp chat store", async () => {
  const groups = await loadLiveWhatsAppGroups({
    getChats: async () => {
      throw new Error("library chat list unavailable");
    },
    pupPage: {
      evaluate: async () => [
        { isGroup: true, id: { _serialized: "120363400000000003@g.us" }, name: "Fallback Jobs" },
        { isGroup: false, id: { _serialized: "447700900001@c.us" }, name: "Direct" }
      ]
    }
  });

  assert.deepEqual(groups, [{ id: "120363400000000003@g.us", name: "Fallback Jobs" }]);
});

test("normalizeGroupIds rejects invalid entries and removes duplicates", () => {
  assert.deepEqual(normalizeGroupIds([]), []);
  assert.deepEqual(normalizeGroupIds(["120363400000000001@g.us", "120363400000000001@g.us"]), [
    "120363400000000001@g.us"
  ]);
  assert.throws(() => normalizeGroupIds(["not-a-group"]), /Invalid WhatsApp group ID/);
});

test("persistAllowedGroups replaces ALLOWED_GROUPS without changing other env values", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-groups-"));
  const envFilePath = path.join(directory, ".env");
  fs.writeFileSync(envFilePath, "PORT=3001\nALLOWED_GROUPS=old@g.us\nOPENAI_ENABLED=false\n");

  const groupIds = persistAllowedGroups({
    envFilePath,
    groupIds: ["120363400000000001@g.us", "120363400000000002@g.us"]
  });

  assert.deepEqual(groupIds, ["120363400000000001@g.us", "120363400000000002@g.us"]);
  assert.equal(
    fs.readFileSync(envFilePath, "utf8"),
    "PORT=3001\nALLOWED_GROUPS=120363400000000001@g.us,120363400000000002@g.us\nOPENAI_ENABLED=false\n"
  );
  fs.rmSync(directory, { recursive: true, force: true });
});
