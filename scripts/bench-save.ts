import { getEvent, saveEvent } from "../backend/src/storage.js";
import { pool } from "../backend/src/db.js";

async function main() {
  const id = "6a9e489b-d0c2-4127-93d2-afe1ef448990";
  const t0 = Date.now();
  const event = await getEvent(id);
  if (!event) throw new Error("event not found");
  console.log(`load ${Date.now() - t0}ms pilots=${event.pilots.length}`);

  const test = event.tests.find((t) => (t.penalties || []).length >= 0) || event.tests[0];
  if (!test) throw new Error("no test");
  test.penalties = test.penalties || [];
  // touch updatedAt only via save
  const t1 = Date.now();
  await saveEvent(event);
  console.log(`save (no csv rewrite) ${Date.now() - t1}ms`);

  // verify passages still there
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM csv_passages`);
  console.log(`csv_passages still in DB: ${r.rows[0].n}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
