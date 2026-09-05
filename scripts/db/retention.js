const { createClient } = require("./client");

async function runDatabaseRetention() {
  const client = createClient();
  await client.connect();

  try {
    const result = await client.query("select * from archive_expired_dispatch_data(now())");
    console.log(
      JSON.stringify(
        {
          ok: true,
          retention: result.rows
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
  runDatabaseRetention().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  runDatabaseRetention
};
