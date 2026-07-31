import { describe, expect, it, vi } from "vitest";
import type { DensityStorage } from "./density";
import {
  PRESENTATION_PROFILE_STORAGE_KEY,
  PRESENTATION_TOKENS,
  applyPresentationProfile,
  builtInPresentationProfile,
  inspectPresentationProfiles,
  presentationProfileChanged,
  readStoredPresentationProfile,
  resolvePresentationProfile,
  writeStoredPresentationProfile,
  type PresentationStyleRoot,
} from "./presentationProfiles";

const allTokenOverrides = {
  "--pi-control-min-size": "30px",
  "--pi-control-padding-block": "4px",
  "--pi-control-padding-inline": "6px",
  "--pi-list-row-padding-block": "3px",
  "--pi-list-row-padding-inline": "6px",
  "--pi-panel-padding": "6px",
  "--pi-toolbar-gap": "3px",
  "--pi-message-padding": "7px",
  "--pi-message-gap": "5px",
  "--pi-content-max-width": "1100px",
};

function customProfile(tokens: Record<string, string> = allTokenOverrides) {
  return {
    version: 1,
    title: "Agent compact",
    description: "Dense review layout",
    extends: "compact",
    tokens,
  };
}

describe("presentation profiles", () => {
  it("validates and resolves every published semantic token over a built-in profile", () => {
    const inspection = inspectPresentationProfiles({ "agent-compact": customProfile() });
    const resolved = resolvePresentationProfile("agent-compact", inspection.profiles);

    expect(inspection.errors).toEqual({});
    expect(Object.keys(resolved?.tokens ?? {})).toEqual(PRESENTATION_TOKENS);
    expect(resolved?.tokens).toEqual(allTokenOverrides);
    expect(resolved).toMatchObject({ id: "agent-compact", base: "compact", origin: "global-config" });
  });

  it("isolates invalid profiles without hiding valid siblings", () => {
    const inspection = inspectPresentationProfiles({
      valid: customProfile({ "--pi-panel-padding": "10px" }),
      "unknown-token": customProfile({ "--pi-private-gap": "1px" }),
      unsafe: customProfile({ "--pi-panel-padding": "url(https://example.test)" }),
      "unsafe-control": customProfile({ "--pi-control-min-size": "12px" }),
      comfortable: customProfile(),
    });

    expect(inspection.profiles.map((profile) => profile.id)).toEqual(["valid"]);
    expect(inspection.errors["unknown-token"]).toContain("Unknown presentation token");
    expect(inspection.errors["unsafe"]).toContain("must be between");
    expect(inspection.errors["unsafe-control"]).toContain("24px");
    expect(inspection.errors["comfortable"]).toContain("reserved");
  });

  it("uses deterministic revisions and detects pending changes", () => {
    const first = inspectPresentationProfiles({ review: customProfile({ "--pi-panel-padding": "8px" }) });
    const second = inspectPresentationProfiles({ review: customProfile({ "--pi-panel-padding": "9px" }) });
    const active = resolvePresentationProfile("review", first.profiles);
    const changed = resolvePresentationProfile("review", second.profiles);

    expect(active).toBeDefined();
    expect(changed).toBeDefined();
    if (active === undefined || changed === undefined) return;
    expect(resolvePresentationProfile("review", first.profiles)?.revision).toBe(active.revision);
    expect(presentationProfileChanged(active, changed)).toBe(true);
    expect(presentationProfileChanged(active, undefined)).toBe(false);
  });

  it("persists the complete last-valid resolution independently per browser storage", () => {
    const firstStorage = memoryStorage();
    const secondStorage = memoryStorage();
    const compact = builtInPresentationProfile("compact");

    writeStoredPresentationProfile(compact, firstStorage.storage);

    expect(readStoredPresentationProfile(firstStorage.storage)).toMatchObject({ id: "compact", base: "compact", origin: "stored" });
    expect(readStoredPresentationProfile(secondStorage.storage)).toBeUndefined();
    expect(firstStorage.values.get(PRESENTATION_PROFILE_STORAGE_KEY)).toContain('"profile"');
  });

  it("falls back safely for malformed or unsafe stored resolutions", () => {
    expect(readStoredPresentationProfile(storageWith("{"))).toBeUndefined();
    expect(readStoredPresentationProfile(storageWith(JSON.stringify({
      version: 1,
      profile: { ...builtInPresentationProfile("comfortable"), tokens: { ...builtInPresentationProfile("comfortable").tokens, "--pi-control-min-size": "1px" } },
    })))).toBeUndefined();
    expect(readStoredPresentationProfile(throwingStorage())).toBeUndefined();
  });

  it("applies the resolved profile and all semantic tokens at the provided root", () => {
    const setProperty = vi.fn();
    const root: PresentationStyleRoot = { dataset: {}, style: { setProperty } };
    const profile = builtInPresentationProfile("compact");

    applyPresentationProfile(profile, root);

    expect(root.dataset).toEqual({ piWebPresentationProfile: "compact", piWebDensity: "compact" });
    expect(setProperty).toHaveBeenCalledTimes(PRESENTATION_TOKENS.length);
    expect(setProperty).toHaveBeenCalledWith("--pi-control-min-size", "26px");
  });
});

function memoryStorage(): { storage: DensityStorage; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    },
  };
}

function storageWith(value: string): DensityStorage {
  return { getItem: () => value, setItem: () => { /* Test storage accepts writes. */ } };
}

function throwingStorage(): DensityStorage {
  return {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); },
  };
}
