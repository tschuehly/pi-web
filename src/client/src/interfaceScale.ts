import type { DensityStorage } from "./density";

export const INTERFACE_SCALE_STORAGE_KEY = "pi-web-app-scale";
export const DEFAULT_INTERFACE_SCALE = 1;
export const MIN_INTERFACE_SCALE = 0.8;
export const MAX_INTERFACE_SCALE = 1.6;
export const INTERFACE_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

export interface InterfaceScaleRoot {
  style: { setProperty(name: string, value: string): void };
}

export function clampInterfaceScale(value: number): number {
  return Math.min(MAX_INTERFACE_SCALE, Math.max(MIN_INTERFACE_SCALE, value));
}

export function parseInterfaceScale(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampInterfaceScale(parsed) : undefined;
}

export function readStoredInterfaceScale(storage?: DensityStorage): number {
  try {
    const activeStorage = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (activeStorage === undefined) return DEFAULT_INTERFACE_SCALE;
    return parseInterfaceScale(activeStorage.getItem(INTERFACE_SCALE_STORAGE_KEY)) ?? DEFAULT_INTERFACE_SCALE;
  } catch {
    return DEFAULT_INTERFACE_SCALE;
  }
}

export function writeStoredInterfaceScale(scale: number, storage: DensityStorage = window.localStorage): void {
  try {
    storage.setItem(INTERFACE_SCALE_STORAGE_KEY, String(clampInterfaceScale(scale)));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts. The
    // active tab still keeps the selected scale.
  }
}

// ponytail: CSS zoom scales layout crisply but the xterm terminal (TerminalPanel.ts,
// canvas glyphs fixed at 13px) and CodeMirror (CodeViewer.ts, fixed 12px) render at
// native resolution underneath the zoom and will blur or mis-measure; upgrade path is
// tokenizing their font sizes and reacting to scale changes instead of relying on zoom.
export function applyInterfaceScale(scale: number, root: InterfaceScaleRoot = document.documentElement): void {
  root.style.setProperty("zoom", String(clampInterfaceScale(scale)));
}
