import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INTERFACE_SCALE,
  INTERFACE_SCALE_STORAGE_KEY,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
  applyInterfaceScale,
  clampInterfaceScale,
  parseInterfaceScale,
  readStoredInterfaceScale,
  writeStoredInterfaceScale,
} from "./interfaceScale";
import type { DensityStorage } from "./density";

describe("PI WEB interface scale preference", () => {
  it("clamps out-of-range values to the supported bounds", () => {
    expect(clampInterfaceScale(0.1)).toBe(MIN_INTERFACE_SCALE);
    expect(clampInterfaceScale(10)).toBe(MAX_INTERFACE_SCALE);
    expect(clampInterfaceScale(1.1)).toBe(1.1);
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
    expect(readStoredInterfaceScale(storage)).toBe(MAX_INTERFACE_SCALE);
    expect(() => { writeStoredInterfaceScale(1.1, throwingStorage()); }).not.toThrow();
  });

  it("applies the scale as a zoom style property on the provided root", () => {
    const setProperty = vi.fn();
    applyInterfaceScale(1.25, { style: { setProperty } });
    expect(setProperty).toHaveBeenCalledWith("zoom", "1.25");
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
