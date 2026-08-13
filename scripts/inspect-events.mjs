import fs from "fs";
import path from "path";

const dir = "data/events";
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const summary = {
    file: f,
    id: e.id,
    name: e.name,
    date: e.date,
    location: e.location,
    password: e.password,
    headerImage: e.headerImage,
    footerText: e.footerText,
    themeColors: e.themeColors,
    boardPageSeconds: e.boardPageSeconds,
    timingPoints: e.timingPoints,
    pilots: (e.pilots || []).length,
    board: e.resultsBoard || [],
    fusions: (e.fusions || []).length,
    tests: (e.tests || []).map((t) => ({
      id: t.id,
      name: t.name,
      order: t.order,
      timingMode: t.timingMode,
      from: t.fromPointId,
      to: t.toPointId,
      sf: t.startFinishPointId,
      partials: t.partialPointIds,
      penalties: (t.penalties || []).length,
      parts: (t.parts || []).map((p) => ({
        id: p.id,
        name: p.name,
        combined: p.combinedMode,
        scoring: p.combinedScoring,
        expectedLaps: p.expectedLaps,
        csvs: (p.csvs || []).map((c) => ({
          tp: c.timingPointId,
          file: c.filename,
          passages: c.parsed?.passages?.length || 0,
          race: c.parsed?.racePassages?.length || 0,
          flags: c.parsed?.flags?.length || 0,
        })),
      })),
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log("---");
}
