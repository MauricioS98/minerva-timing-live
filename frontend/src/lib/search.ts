/** Lowercase + strip diacritics for accent/case-insensitive matching. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Match query against pilot number and/or name (accents and case ignored). */
export function matchesPilotSearch(
  query: string,
  number: string | null | undefined,
  name: string | null | undefined
): boolean {
  const q = normalizeSearchText(query);
  if (!q) return true;
  const num = normalizeSearchText(number || "");
  const nm = normalizeSearchText(name || "");
  return num.includes(q) || nm.includes(q);
}
