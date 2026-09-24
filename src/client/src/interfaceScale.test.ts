import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INTERFACE_SCALE,
  INTERFACE_SCALE_CSS_PROPERTY,
  INTERFACE_SCALE_STEPS,
  INTERFACE_SCALE_STORAGE_KEY,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
  applyInterfaceScale,
  clampInterfaceScale,
  parseInterfaceScale,
  readStoredInterfaceScale,
  stepInterfaceScale,
  writeStoredInterfaceScale,
} from "./interfaceScale";
import type { DensityStorage } from "./density";

describe("PI WEB interface scale preference", () => {
  it("clamps out-of-range values to the supported bounds", () => {
    expect(clampInterfaceScale(0.1)).toBe(MIN_INTERFACE_SCALE);
    expect(clampInterfaceScale(10)).toBe(MAX_INTERFACE_SCALE);
    expect(clampInterfaceScale(1.1)).toBe(1.1);
    expect(clampInterfaceScale(2)).toBe(2);
  });

  it("parses numeric strings and rejects non-numeric junk", () => {
    expect(parseInterfaceScale("1.25")).toBe(1.25);
    expect(parseInterfaceScale("3")).toBe(MAX_INTERFACE_SCALE);
    expect(parseInterfaceScale("not-a-number")).toBeUndefined();
    expect(parseInterfaceScale(null)).toBeUndefined();
    expect(parseInterfaceScale(undefined)).toBeUndefined();
  });

  it("falls back to the default when storage is missing, invalid, or unavailable", () => {
    expect(readStoredInterfaceScale(storageWith(null))).toBe(DEFAULT_INTERFACE_SCALE);
    expect(readStoredInterfaceScale(storageWith("banana"))).toBe(DEFAULT_INTERFACE_SCALE);
    expect(readStoredInterfaceScale(throwingStorage())).toBe(DEFAULT_INTERFACE_SCALE);
  });

  it("round-trips a persisted value, clamped on write", () => {
    const setItem = vi.fn();
    const store = new Map<string, string>();
    const storage: DensityStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); setItem(key, value); },
    };
    writeStoredInterfaceScale(2, storage);
    expect(setItem).toHaveBeenCalledWith(INTERFACE_SCALE_STORAGE_KEY, String(MAX_INTERFACE_SCALE));
    expect(readStoredInterfaceScale(storage)).toBe(2);
    expect(() => { writeStoredInterfaceScale(1.1, throwingStorage()); }).not.toThrow();
  });

  it.each([0.8, 1, 1.25, 1.5, 2])("applies zoom and the shared active-scale property at %s", (scale) => {
    const setProperty = vi.fn();
    applyInterfaceScale(scale, { style: { setProperty } });
    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(setProperty).toHaveBeenCalledWith("zoom", String(scale));
    expect(setProperty).toHaveBeenCalledWith(INTERFACE_SCALE_CSS_PROPERTY, String(scale));
  });

  it("steps up through the supported sizes and clamps at the maximum", () => {
    expect(stepInterfaceScale(1, 1)).toBe(1.1);
    const max = INTERFACE_SCALE_STEPS.at(-1) ?? DEFAULT_INTERFACE_SCALE;
    expect(max).toBe(2);
    expect(stepInterfaceScale(1.5, 1)).toBe(2);
    expect(stepInterfaceScale(max, 1)).toBe(max);
  });

  it("steps down through the supported sizes and clamps at the minimum", () => {
    expect(stepInterfaceScale(1, -1)).toBe(0.9);
    const min = INTERFACE_SCALE_STEPS.at(0) ?? DEFAULT_INTERFACE_SCALE;
    expect(stepInterfaceScale(min, -1)).toBe(min);
  });

  it("resets by stepping toward the default from either side", () => {
    expect(DEFAULT_INTERFACE_SCALE).toBe(1);
    expect(INTERFACE_SCALE_STEPS.includes(DEFAULT_INTERFACE_SCALE)).toBe(true);
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
