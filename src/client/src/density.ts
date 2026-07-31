export const PI_WEB_DENSITIES = ["comfortable", "compact"] as const;
export type PiWebDensity = (typeof PI_WEB_DENSITIES)[number];

export const DEFAULT_PI_WEB_DENSITY: PiWebDensity = "comfortable";
export const DENSITY_STORAGE_KEY = "pi-web-app-density";

export interface DensityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parsePiWebDensity(value: string | null | undefined): PiWebDensity | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "comfortable" || trimmed === "compact") return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed === "comfortable" || parsed === "compact" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readStoredPiWebDensity(storage: DensityStorage = window.localStorage): PiWebDensity {
  try {
    return parsePiWebDensity(storage.getItem(DENSITY_STORAGE_KEY)) ?? DEFAULT_PI_WEB_DENSITY;
  } catch {
    return DEFAULT_PI_WEB_DENSITY;
  }
}

export function writeStoredPiWebDensity(density: PiWebDensity, storage: DensityStorage = window.localStorage): void {
  try {
    storage.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts. The
    // active tab still keeps the selected density.
  }
}

export function applyPiWebDensity(density: PiWebDensity, root: Pick<HTMLElement, "dataset"> = document.documentElement): void {
  root.dataset["piWebDensity"] = density;
}
