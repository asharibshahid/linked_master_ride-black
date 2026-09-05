const fs = require("node:fs/promises");
const path = require("node:path");
const { createClient } = require("./client");

const SEED_FILE = path.resolve(__dirname, "../../supabase/seed.sql");

async function seedDatabase() {
  const client = createClient();
  await client.connect();

  try {
    const sql = await fs.readFile(SEED_FILE, "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    console.log(JSON.stringify({ ok: true, seeded: path.basename(SEED_FILE) }, null, 2));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  seedDatabase().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  SEED_FILE,
  seedDatabase
};
