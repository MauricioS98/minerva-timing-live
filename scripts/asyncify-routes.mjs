/**
 * Patch routes.ts for async storage (use with express-async-errors).
 * node scripts/asyncify-routes.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../backend/src/routes.ts");
let src = fs.readFileSync(file, "utf8");

src = src.replace(/(?<!async )\((_?req), res\) =>/g, "async ($1, res) =>");
src = src.replace(/async async \(/g, "async (");

src = src.replace(/\bawait await /g, "await ");
src = src.replace(/(?<!await )(?<![\w.])getEvent\(/g, "await getEvent(");
src = src.replace(/(?<!await )(?<![\w.])saveEvent\(/g, "await saveEvent(");
src = src.replace(/(?<!await )(?<![\w.])listEvents\(/g, "await listEvents(");
src = src.replace(/(?<!await )(?<![\w.])deleteEvent\(/g, "await deleteEvent(");
src = src.replace(/\bawait await /g, "await ");
src = src.replace(/await listEvents\(\)\.map\(/g, "(await listEvents()).map(");

fs.writeFileSync(file, src);
console.log("Patched", file);
