const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AUDIT_LOG_HEADERS,
  buildAuditEntriesFromActionResult,
  buildAuditId,
  buildAuditLogRowObject,
  buildAuditLogSheetRow
} = require("../../src/audit/log");

test("buildAuditId creates stable dashboard audit ids", () => {
  const id = buildAuditId({
    action: "Driver Status Updated",
    targetId: "D-001",
    createdTime: "2026-08-12T10:20:30.000Z"
  });

  assert.equal(id, "AUD-20260812102030-DriverStatusUpdated-D-001");
});

test("buildAuditLogSheetRow maps audit entries to sheet headers", () => {
  const record = buildAuditLogRowObject({
    action: "Driver Status Updated",
    targetType: "Driver",
    targetId: "D-001",
    field: "Status",
    oldValue: "Offline",
    newValue: "Available",
    actor: "Dashboard",
    status: "Success",
    reason: "operator update",
    createdTime: "2026-08-12T10:20:30.000Z"
  });

  const row = buildAuditLogSheetRow(record);

  assert.equal(row.length, AUDIT_LOG_HEADERS.length);
  assert.deepEqual(row.slice(1, 8), [
    "Driver Status Updated",
    "Driver",
    "D-001",
    "Status",
    "Offline",
    "Available",
    "Dashboard"
  ]);
});

test("buildAuditEntriesFromActionResult creates entries from single and multi update results", () => {
  const single = buildAuditEntriesFromActionResult({
    action: "Final Bid Status Updated",
    targetType: "Final Bid",
    targetId: "RID-1",
    result: {
      header: "Status",
      oldValue: "Pending",
      value: "Approved"
    }
  });

  assert.equal(single.length, 1);
  assert.equal(single[0]["Target ID"], "RID-1");
  assert.equal(single[0].Field, "Status");
  assert.equal(single[0]["Old Value"], "Pending");
  assert.equal(single[0]["New Value"], "Approved");

  const multiple = buildAuditEntriesFromActionResult({
    action: "Bid Admin Status Updated",
    targetType: "Bid",
    targetId: "RID-2",
    result: {
      updates: [
        { header: "Admin Status", oldValue: "Pending", value: "Approved" },
        { header: "Bid Status", oldValue: "Suggested", value: "Approved" }
      ]
    }
  });

  assert.equal(multiple.length, 2);
  assert.deepEqual(
    multiple.map((entry) => entry.Field),
    ["Admin Status", "Bid Status"]
  );
});
