/** WCAG 2.x contrast arithmetic for theme tokens (hex colors, 3/6/8-digit forms; alpha is dropped). */

interface Rgb { r: number; g: number; b: number }

function hexToRgb(hex: string): Rgb {
  let value = hex.replace("#", "");
  if (value.length === 3) value = value.split("").map((digit) => digit + digit).join("");
  if (value.length === 8) value = value.slice(0, 6);
  const n = Number.parseInt(value, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two colors, from 1 (no contrast) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
