const fs = require("node:fs");
const path = require("node:path");

function safeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeGroupIds(values) {
  const seen = new Set();
  const output = [];

  for (const value of Array.isArray(values) ? values : []) {
    const id = safeString(value);
    if (!/^[0-9-]+@g\.us$/i.test(id)) {
      throw new Error(`Invalid WhatsApp group ID: ${id || "blank"}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  }

  if (output.length > 100) throw new Error("A maximum of 100 WhatsApp groups can be configured");
  return output;
}

function groupIdFromChat(chat) {
  return safeString(chat?.id?._serialized || chat?.id?.user || chat?.id);
}

function listWhatsAppGroups(chats) {
  return (Array.isArray(chats) ? chats : [])
    .filter((chat) => chat?.isGroup && /^[0-9-]+@g\.us$/i.test(groupIdFromChat(chat)))
    .map((chat) => ({
      id: groupIdFromChat(chat),
      name: safeString(chat?.name || chat?.formattedTitle || "Unnamed group")
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

async function loadLiveWhatsAppGroups(client) {
  if (!client || typeof client.getChats !== "function") {
    throw new Error("WhatsApp client is not ready. Connect WhatsApp first.");
  }

  try {
    return listWhatsAppGroups(await client.getChats());
  } catch (primaryError) {
    if (!client.pupPage || typeof client.pupPage.evaluate !== "function") {
      throw new Error("Could not load WhatsApp groups. Restart WhatsApp and try again.");
    }

    try {
      const chats = await client.pupPage.evaluate(() => {
        const collection = window.Store?.Chat;
        if (!collection || typeof collection.getModelsArray !== "function") {
          throw new Error("WhatsApp chat list is not ready");
        }

        return collection.getModelsArray().map((chat) => {
          const id = chat?.id?._serialized || "";
          return {
            isGroup: Boolean(chat?.isGroup || chat?.groupMetadata),
            id: { _serialized: id },
            name: chat?.name || chat?.formattedTitle || "Unnamed group"
          };
        });
      });
      return listWhatsAppGroups(chats);
    } catch (fallbackError) {
      throw new Error("WhatsApp group list is still loading. Wait 20 seconds, then try again.");
    }
  }
}

function replaceEnvValue(source, key, value) {
  const line = `${key}=${value}`;
  const expression = new RegExp(`^${key}=.*$`, "m");
  return expression.test(source) ? source.replace(expression, line) : `${source.replace(/\s*$/, "")}\n${line}\n`;
}

function persistAllowedGroups({ envFilePath, groupIds }) {
  const ids = normalizeGroupIds(groupIds);
  const target = path.resolve(safeString(envFilePath));
  if (!target || !fs.existsSync(target)) throw new Error("Project .env file was not found");

  const current = fs.readFileSync(target, "utf8");
  const updated = replaceEnvValue(current, "ALLOWED_GROUPS", ids.join(","));
  const temporary = `${target}.${process.pid}.tmp`;

  fs.writeFileSync(temporary, updated, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return ids;
}

module.exports = {
  listWhatsAppGroups,
  loadLiveWhatsAppGroups,
  normalizeGroupIds,
  persistAllowedGroups,
  replaceEnvValue
};
