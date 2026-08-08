import { describe, expect, it } from "vitest";
import {
  CORE_SHELL_PROFILE_ID,
  SHELL_PROFILE_STORAGE_KEY,
  readStoredShellProfileId,
  transactShellProfileActivation,
  writeStoredShellProfileId,
  type ShellProfileStorage,
} from "./shellProfiles";

describe("shell profile selection", () => {
  it("persists a browser-local qualified profile selection", () => {
    const memory = memoryStorage();

    writeStoredShellProfileId("fixture:shell.review", memory.storage);

    expect(readStoredShellProfileId(memory.storage)).toBe("fixture:shell.review");
    expect(JSON.parse(memory.values.get(SHELL_PROFILE_STORAGE_KEY) ?? "{}")).toEqual({ version: 1, profileId: "fixture:shell.review" });
  });

  it("ignores malformed and unavailable storage", () => {
    expect(readStoredShellProfileId(storageWith("{"))).toBeUndefined();
    expect(readStoredShellProfileId(storageWith(JSON.stringify({ version: 2, profileId: "fixture:shell.review" })))).toBeUndefined();
    expect(readStoredShellProfileId(storageWith(JSON.stringify({ version: 1, profileId: "unqualified" })))).toBeUndefined();
    expect(readStoredShellProfileId(throwingStorage())).toBeUndefined();
    expect(() => { writeStoredShellProfileId(CORE_SHELL_PROFILE_ID, throwingStorage()); }).not.toThrow();
  });

  it("keeps the last valid profile when transactional activation throws", () => {
    const current = { id: CORE_SHELL_PROFILE_ID, title: "PI WEB" };
    const result = transactShellProfileActivation(current, "fixture:shell.broken", () => {
      throw new Error("missing fixture:view");
    });

    expect(result).toEqual({ ok: false, profile: current, error: "missing fixture:view" });
  });
});

function memoryStorage(): { storage: ShellProfileStorage; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    },
  };
}

function storageWith(value: string): ShellProfileStorage {
  return { getItem: () => value, setItem: () => undefined };
}

function throwingStorage(): ShellProfileStorage {
  return {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
}
