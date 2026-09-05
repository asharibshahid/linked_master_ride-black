const fs = require("node:fs/promises");
const path = require("node:path");
const { createClient } = require("./client");

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");

async function readMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((entry) => path.join(MIGRATIONS_DIR, entry));
}

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function hasMigration(client, version) {
  const result = await client.query("select 1 from schema_migrations where version = $1", [version]);
  return result.rowCount > 0;
}

async function runMigrations() {
  const client = createClient();
  await client.connect();

  try {
    await ensureMigrationTable(client);
    const files = await readMigrationFiles();
    const applied = [];
    const skipped = [];

    for (const filePath of files) {
      const version = path.basename(filePath);
      if (await hasMigration(client, version)) {
        skipped.push(version);
        continue;
      }

      const sql = await fs.readFile(filePath, "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations(version) values ($1)", [version]);
        await client.query("commit");
        applied.push(version);
      } catch (error) {
        await client.query("rollback");
        error.message = `Migration ${version} failed: ${error.message}`;
        throw error;
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          applied,
          skipped
        },
        null,
        2
      )
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  MIGRATIONS_DIR,
  readMigrationFiles,
  runMigrations
};
