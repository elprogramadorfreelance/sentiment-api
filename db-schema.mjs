import pkg from "pg";
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function cols(table) {
  const r = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  console.log(`\n--- ${table} ---`);
  for (const row of r.rows) console.log(row.column_name, row.data_type);
}

async function main() {
  for (const t of ["projects", "mentions", "narratives", "alerts", "amplifiers", "analyses"]) {
    await cols(t);
  }
  const sample = await pool.query("SELECT * FROM mentions ORDER BY id DESC LIMIT 2");
  console.log("\n--- sample mentions ---");
  console.log(JSON.stringify(sample.rows, null, 2));
  const distinctSentiment = await pool.query("SELECT DISTINCT sentiment FROM mentions");
  console.log("\n--- distinct sentiment values ---", distinctSentiment.rows);
  const distinctSourceType = await pool.query("SELECT DISTINCT source_type FROM mentions");
  console.log("\n--- distinct source_type values ---", distinctSourceType.rows);
  await pool.end();
}

main().catch((e) => {
  console.error("DB_ERROR:", e.message);
  process.exit(1);
});
