const ASSET_BASE = "/overlays/redbull";

/** Normalize pilot name for slug matching (accents, spaces, punctuation). */
export function normalizePilotSlug(name: string): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * Roster art index from RedBull pack (filename number ↔ pilot).
 * Used when dorsal in timing doesn't match, or as secondary lookup by name.
 */
const NAME_TO_ART_NUMBER: Record<string, number> = {
  andrestoro: 1,
  benjaminherrera: 2,
  camiloherrera: 3,
  danielpalacio: 4,
  didiergoirand: 5,
  eduardobanvega: 6,
  edwargarzon: 7,
  johanbarreto: 8,
  juancamilodorado: 9,
  juandavidolaya: 10,
  martinchica: 11,
  martinvarela: 12,
  pabloancizar: 13,
  pachoalvarez: 14,
  cesarcorrea: 15,
  esarcorrea: 15,
  tomasjaramillo: 16,
  santiagosanchez: 17,
  samuelruiz: 18,
};

/** Dorsal / name → candidate PNG URLs (`{n}.png`). */
export function pilotArtCandidates(number: string, name: string): string[] {
  const dorsal = String(number || "").trim();
  const slug = normalizePilotSlug(name);
  const byName = NAME_TO_ART_NUMBER[slug];
  const out: string[] = [];

  const pushNum = (n: string | number) => {
    const s = String(n).trim();
    if (!s) return;
    out.push(`${ASSET_BASE}/pilots/${s}.png`);
  };

  if (dorsal) pushNum(dorsal);
  if (byName != null) pushNum(byName);
  if (dorsal && /^\d+$/.test(dorsal)) {
    pushNum(dorsal.padStart(2, "0"));
  }

  return [...new Set(out)];
}

export const RB_ASSETS = {
  fondo: `${ASSET_BASE}/fondo.png`,
  logo: `${ASSET_BASE}/logo.png`,
  logoRedbull: `${ASSET_BASE}/logo-redbull.png`,
  logoBase: `${ASSET_BASE}/logo-base.png`,
  logoMoto: `${ASSET_BASE}/logo-moto.png`,
  logoUrbano: `${ASSET_BASE}/logo-urbano.png`,
  title: `${ASSET_BASE}/title.png`,
  row: `${ASSET_BASE}/row.png`,
} as const;
