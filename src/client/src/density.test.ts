import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PI_WEB_DENSITY,
  DENSITY_STORAGE_KEY,
  applyPiWebDensity,
  parsePiWebDensity,
  readStoredPiWebDensity,
  writeStoredPiWebDensity,
  type DensityStorage,
} from "./density";

describe("PI WEB density preference", () => {
  it("parses supported plain and legacy JSON string values", () => {
    expect(parsePiWebDensity("comfortable")).toBe("comfortable");
    expect(parsePiWebDensity(" compact ")).toBe("compact");
    expect(parsePiWebDensity('"compact"')).toBe("compact");
  });

  it("rejects malformed and unknown values", () => {
    expect(parsePiWebDensity(null)).toBeUndefined();
    expect(parsePiWebDensity("")).toBeUndefined();
    expect(parsePiWebDensity("dense")).toBeUndefined();
    expect(parsePiWebDensity("{")).toBeUndefined();
  });

  it("falls back safely when storage is missing, invalid, or unavailable", () => {
    expect(readStoredPiWebDensity(storageWith(null))).toBe(DEFAULT_PI_WEB_DENSITY);
    expect(readStoredPiWebDensity(storageWith("dense"))).toBe(DEFAULT_PI_WEB_DENSITY);
    expect(readStoredPiWebDensity(throwingStorage())).toBe(DEFAULT_PI_WEB_DENSITY);
  });

  it("persists the selected value and ignores write failures", () => {
    const setItem = vi.fn();
    writeStoredPiWebDensity("compact", { getItem: () => null, setItem });
    expect(setItem).toHaveBeenCalledWith(DENSITY_STORAGE_KEY, "compact");
    expect(() => { writeStoredPiWebDensity("compact", throwingStorage()); }).not.toThrow();
  });

  it("applies density at the provided application root", () => {
    const root: Pick<HTMLElement, "dataset"> = { dataset: {} };
    applyPiWebDensity("compact", root);
    expect(root.dataset["piWebDensity"]).toBe("compact");
  });
});

function storageWith(value: string | null): DensityStorage {
  return { getItem: () => value, setItem: () => { /* Test storage accepts writes. */ } };
}

function throwingStorage(): DensityStorage {
  return {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); },
  };
}
