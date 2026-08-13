import { assertDbConnection, pool } from "../backend/src/db.js";
import { loadAllEvents } from "../backend/src/eventsRepo.js";

async function main() {
  await assertDbConnection();
  const ev = await loadAllEvents();
  for (const e of ev) {
    const passages = e.tests.reduce(
      (n, t) =>
        n +
        t.parts.reduce(
          (m, p) => m + p.csvs.reduce((k, c) => k + c.parsed.passages.length, 0),
          0
        ),
      0
    );
    console.log(
      `- ${e.name}: pilots=${e.pilots.length} tests=${e.tests.length} passages=${passages} board=${(e.resultsBoard || []).length}`
    );
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
