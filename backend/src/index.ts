import "express-async-errors";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import routes from "./routes.js";
import { HEADERS_DIR } from "./storage.js";
import { assertDbConnection, ensureDbSchema, pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "../../frontend/dist");
const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));



const frontendPath = path.join(__dirname, "../../frontend/dist");

console.log("Frontend path:", frontendPath);
console.log("¿Existe dist?:", fs.existsSync(frontendPath));
console.log(
  "¿Existe index.html?:",
  fs.existsSync(path.join(frontendPath, "index.html"))
);

// Archivos de cabeceras
app.use("/uploads/headers", express.static(HEADERS_DIR));

// API
app.use("/api", routes);

app.get("/api/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT current_database() AS db");
    res.json({ ok: true, service: "Minerva Timing", database: r.rows[0].db });
  } catch (err) {
    res.status(503).json({
      ok: false,
      service: "Minerva Timing",
      error: err instanceof Error ? err.message : "DB error",
    });
  }
});

if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) {
      return next();
    }
    return res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });
}
 
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    const message = err instanceof Error ? err.message : "Error interno";
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  }
);

async function main() {
  await assertDbConnection();
  await ensureDbSchema();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Minerva Timing API en http://localhost:${PORT} (LAN: 0.0.0.0:${PORT})`);
  });
}

main().catch((err) => {
  console.error("No se pudo iniciar la API:", err);
  process.exit(1);
});
