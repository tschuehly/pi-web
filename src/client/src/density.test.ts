import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PI_WEB_DENSITY, DENSITY_STORAGE_KEY, applyPiWebDensity, parsePiWebDensity, readStoredPiWebDensity, writeStoredPiWebDensity, type DensityStorage } from "./density";

describe("PI WEB density preference", () => {
  it("parses supported values and rejects unknown ones", () => {
    expect(parsePiWebDensity("comfortable")).toBe("comfortable");
    expect(parsePiWebDensity(" compact ")).toBe("compact");
    expect(parsePiWebDensity('"compact"')).toBe("compact");
    expect(parsePiWebDensity("dense")).toBeUndefined();
  });

  it("falls back when storage is invalid or unavailable", () => {
    expect(readStoredPiWebDensity(storageWith("dense"))).toBe(DEFAULT_PI_WEB_DENSITY);
    expect(readStoredPiWebDensity(throwingStorage())).toBe(DEFAULT_PI_WEB_DENSITY);
  });

  it("persists and applies density", () => {
    const setItem = vi.fn();
    writeStoredPiWebDensity("compact", { getItem: () => null, setItem });
    expect(setItem).toHaveBeenCalledWith(DENSITY_STORAGE_KEY, "compact");
    const root: Pick<HTMLElement, "dataset"> = { dataset: {} };
    applyPiWebDensity("compact", root);
    expect(root.dataset["piWebDensity"]).toBe("compact");
  });
});

function storageWith(value: string | null): DensityStorage {
  return { getItem: () => value, setItem: () => undefined };
}

function throwingStorage(): DensityStorage {
  return { getItem: () => { throw new Error("storage unavailable"); }, setItem: () => { throw new Error("storage unavailable"); } };
}
