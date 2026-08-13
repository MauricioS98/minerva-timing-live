import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load repo-root .env then backend/.env
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  database: process.env.PGDATABASE || "minerva_timing_live",
  max: 10,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
) {
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function assertDbConnection(): Promise<void> {
  const r = await pool.query<{ ok: number; db: string }>(
    "SELECT 1 AS ok, current_database() AS db"
  );
  console.log(`PostgreSQL OK → ${r.rows[0].db}`);
}

/** Initialize a newly provisioned database on the first application start. */
export async function ensureDbSchema(): Promise<void> {
  const existing = await pool.query<{ events_table: string | null }>(
    "SELECT to_regclass('public.events')::text AS events_table"
  );
  if (!existing.rows[0]?.events_table) {
    const schemaPath = path.resolve(__dirname, "../../db/01_schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    await pool.query(schema);
    console.log("Esquema PostgreSQL inicializado");
    return;
  }

  // Incremental migrations for existing databases
  const col = await pool.query<{ attname: string }>(
    `SELECT a.attname
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public' AND c.relname = 'events'
       AND a.attname = 'overlay_variant' AND NOT a.attisdropped`
  );
  if (!col.rows[0]) {
    const migPath = path.resolve(__dirname, "../../db/03_overlay_variant.sql");
    await pool.query(fs.readFileSync(migPath, "utf8"));
    console.log("Migración overlay_variant aplicada");
  }

  const timingCol = await pool.query<{ attname: string }>(
    `SELECT a.attname
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public' AND c.relname = 'events'
       AND a.attname = 'overlay_timing' AND NOT a.attisdropped`
  );
  if (!timingCol.rows[0]) {
    const migPath = path.resolve(__dirname, "../../db/04_overlay_timing.sql");
    await pool.query(fs.readFileSync(migPath, "utf8"));
    console.log("Migración overlay_timing aplicada");
  }

  const vsCol = await pool.query<{ attname: string }>(
    `SELECT a.attname
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public' AND c.relname = 'test_parts'
       AND a.attname = 'start_order_vs' AND NOT a.attisdropped`
  );
  if (!vsCol.rows[0]) {
    const migPath = path.resolve(__dirname, "../../db/05_start_order_vs.sql");
    await pool.query(fs.readFileSync(migPath, "utf8"));
    console.log("Migración start_order_vs aplicada");
  }

  const pubSoCol = await pool.query<{ attname: string }>(
    `SELECT a.attname
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public' AND c.relname = 'events'
       AND a.attname = 'published_start_order_part_id' AND NOT a.attisdropped`
  );
  if (!pubSoCol.rows[0]) {
    const migPath = path.resolve(__dirname, "../../db/06_published_start_order.sql");
    await pool.query(fs.readFileSync(migPath, "utf8"));
    console.log("Migración published_start_order aplicada");
  }

  const csvSourceCol = await pool.query<{ attname: string }>(
    `SELECT a.attname
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public' AND c.relname = 'events'
       AND a.attname = 'csv_source' AND NOT a.attisdropped`
  );
  if (!csvSourceCol.rows[0]) {
    const migPath = path.resolve(__dirname, "../../db/07_csv_source.sql");
    await pool.query(fs.readFileSync(migPath, "utf8"));
    console.log("Migración csv_source aplicada");
  }
}
