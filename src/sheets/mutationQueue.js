const pending = new Map();

function withSheetMutation(spreadsheetId, worksheetName, task) {
  const key = `${spreadsheetId}|${worksheetName}`;
  const previous = pending.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const settled = run.catch(() => {});
  pending.set(key, settled);
  settled.finally(() => {
    if (pending.get(key) === settled) pending.delete(key);
  });
  return run;
}

module.exports = { withSheetMutation };
