const { createAllowedGroupMatcher } = require("./messageHandler");

function finitePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function messageTimestampMs(message) {
  const seconds = Number(message?.timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function backfillWhatsAppMessages(options = {}) {
  const client = options.client;
  const onMessage = options.onMessage;
  const logger = options.logger || console;
  if (!client || typeof client.getChats !== "function" || typeof onMessage !== "function") {
    return { groups: 0, examined: 0, dispatched: 0 };
  }

  const matcher = createAllowedGroupMatcher({
    allowedGroups: options.allowedGroups,
    allowedGroupIds: options.allowedGroupIds,
    allowedGroupNames: options.allowedGroupNames
  });
  if (matcher.isEmpty()) return { groups: 0, examined: 0, dispatched: 0 };

  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
  const lookbackHours = finitePositive(options.lookbackHours, 24);
  const perGroupLimit = Math.min(500, Math.trunc(finitePositive(options.perGroupLimit, 100)));
  const cutoffMs = nowMs - lookbackHours * 60 * 60 * 1000;
  const chats = await client.getChats();
  const groups = (Array.isArray(chats) ? chats : []).filter((chat) => {
    const groupId = String(chat?.id?._serialized || "").trim();
    const groupName = String(chat?.name || chat?.formattedTitle || "").trim();
    return chat?.isGroup === true && matcher.matches({ groupId, groupName });
  });

  let examined = 0;
  let dispatched = 0;
  for (const chat of groups) {
    if (typeof chat.fetchMessages !== "function") continue;
    const messages = await chat.fetchMessages({ limit: perGroupLimit });
    const recent = (Array.isArray(messages) ? messages : [])
      .filter((message) => messageTimestampMs(message) >= cutoffMs)
      .sort((left, right) => messageTimestampMs(left) - messageTimestampMs(right));
    examined += recent.length;
    for (const message of recent) {
      await onMessage(message);
      dispatched += 1;
    }
  }

  logger.info("WhatsApp reconnect backfill complete", {
    stage: "whatsapp_backfill",
    fallbackUsed: false,
    reason: `groups=${groups.length} examined=${examined} dispatched=${dispatched}`
  });
  return { groups: groups.length, examined, dispatched };
}

function createWhatsAppBackfillRunner(options = {}) {
  let activeRun = null;
  return {
    run() {
      if (activeRun) return activeRun;
      activeRun = backfillWhatsAppMessages(options).finally(() => {
        activeRun = null;
      });
      return activeRun;
    },
    isRunning() {
      return Boolean(activeRun);
    }
  };
}

module.exports = {
  backfillWhatsAppMessages,
  createWhatsAppBackfillRunner,
  messageTimestampMs
};
