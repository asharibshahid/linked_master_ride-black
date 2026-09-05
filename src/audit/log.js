const { safeTrim } = require("../utils/text");

const AUDIT_LOG_WORKSHEET_NAME = "Audit Log";

const AUDIT_LOG_HEADERS = Object.freeze([
  "Audit ID",
  "Action",
  "Target Type",
  "Target ID",
  "Field",
  "Old Value",
  "New Value",
  "Actor",
  "Status",
  "Reason",
  "Created Time"
]);

function toCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function buildAuditId({ action = "", targetId = "", createdTime = "" } = {}) {
  const cleanAction = safeTrim(action).replace(/[^A-Za-z0-9-]/g, "") || "ACTION";
  const cleanTarget = safeTrim(targetId).replace(/[^A-Za-z0-9-]/g, "") || "TARGET";
  const stamp = safeTrim(createdTime) || new Date().toISOString();
  return `AUD-${stamp.replace(/[^0-9]/g, "").slice(0, 14)}-${cleanAction}-${cleanTarget}`;
}

function buildAuditLogRowObject({
  action = "",
  targetType = "",
  targetId = "",
  field = "",
  oldValue = "",
  newValue = "",
  actor = "Dashboard",
  status = "Success",
  reason = "",
  createdTime = ""
} = {}) {
  const timestamp = safeTrim(createdTime) || new Date().toISOString();
  return {
    "Audit ID": buildAuditId({ action, targetId, createdTime: timestamp }),
    Action: toCell(action),
    "Target Type": toCell(targetType),
    "Target ID": toCell(targetId),
    Field: toCell(field),
    "Old Value": toCell(oldValue),
    "New Value": toCell(newValue),
    Actor: toCell(actor) || "Dashboard",
    Status: toCell(status) || "Success",
    Reason: toCell(reason),
    "Created Time": timestamp
  };
}

function buildAuditLogSheetRow(record = {}, headers = AUDIT_LOG_HEADERS) {
  const safeHeaders = Array.isArray(headers) && headers.length > 0 ? headers : AUDIT_LOG_HEADERS;
  return safeHeaders.map((header) => toCell(record[header]));
}

function buildAuditEntriesFromActionResult({
  action,
  targetType,
  targetId,
  result,
  actor = "Dashboard",
  status = "Success",
  reason = ""
} = {}) {
  const updates = Array.isArray(result?.updates) ? result.updates : result ? [result] : [];
  return updates
    .filter((update) => update && update.header)
    .map((update) =>
      buildAuditLogRowObject({
        action,
        targetType,
        targetId: targetId || update.key,
        field: update.header,
        oldValue: update.oldValue,
        newValue: update.value,
        actor,
        status,
        reason
      })
    );
}

module.exports = {
  AUDIT_LOG_WORKSHEET_NAME,
  AUDIT_LOG_HEADERS,
  buildAuditId,
  buildAuditLogRowObject,
  buildAuditLogSheetRow,
  buildAuditEntriesFromActionResult
};
