export const WORKSTREAM_TINT_PERCENTAGES = {
  row: 12,
  rowHover: 18,
  rowSelected: 22,
  rowSelectedHover: 28,
  card: 9,
  mark: 30,
  drawer: 12,
  drawerActive: 18,
} as const;

/** A compact title-derived identity cue that remains distinct without colour. */
export function workstreamMonogram(title: string): string {
  const words = title.trim().split(/\s+/u).filter((word) => word !== "");
  if (words.length === 0) return "WS";
  const letters = words.length === 1
    ? Array.from(words[0] ?? "").slice(0, 2)
    : [Array.from(words[0] ?? "")[0], Array.from(words.at(-1) ?? "")[0]];
  return letters.filter((letter): letter is string => letter !== undefined).join("").toUpperCase();
}

/**
 * Deterministic accent colour per Workstream id, so the same Workstream reads
 * as the same colour everywhere it appears (chooser card, Chat drawer) without
 * a colour field in the Workstream store.
 *
 * Saturation and lightness are fixed constants tuned for both `color-scheme`
 * branches; `light-dark()` picks the legible one for the theme currently
 * applied to the document, so only the hue varies per id.
 */
export function workstreamHue(workstreamId: string): number {
  let hash = 0;
  for (let index = 0; index < workstreamId.length; index += 1) {
    hash = (hash * 31 + workstreamId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function workstreamAccentColor(workstreamId: string): string {
  const hue = workstreamHue(workstreamId);
  return `light-dark(hsl(${String(hue)}deg 70% 40%), hsl(${String(hue)}deg 65% 65%))`;
}
