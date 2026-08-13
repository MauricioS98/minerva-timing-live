/**
 * Paleta Minerva Timing — tomada del carnet oficial:
 * rojo carmesí de bloques (#b90c12), rojo brillante de acentos (#f52832),
 * carbón de fondo (#1e1d1d) y blanco de tipografía (#ffffff).
 *
 * Orden: [acento, resaltado, fondo de paneles, texto]
 */
export const MINERVA_COLORS = ["#b90c12", "#f52832", "#1e1d1d", "#ffffff"] as const;

export type ThemeColors = [string, string, string, string];

export const THEME_COLOR_LABELS = [
  "Acento (líder, bordes)",
  "Resaltado (números, títulos)",
  "Fondo de paneles",
  "Texto",
] as const;

/** Devuelve los 4 colores del evento o la paleta Minerva si no hay personalización. */
export function resolveThemeColors(colors?: string[] | null): ThemeColors {
  if (colors && colors.length === 4 && colors.every((c) => /^#[0-9a-fA-F]{6}$/.test(c))) {
    return [colors[0], colors[1], colors[2], colors[3]];
  }
  return [...MINERVA_COLORS];
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
