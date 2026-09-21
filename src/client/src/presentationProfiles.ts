import type { DensityStorage } from "./density";
import { applyInterfaceScale, readStoredInterfaceScale } from "./interfaceScale";

export const PRESENTATION_PROFILE_STORAGE_KEY = "pi-web-app-presentation-profile";
export type BuiltInPresentationProfileId = "comfortable" | "compact";

type PresentationToken = "--pi-control-min-size" | "--pi-control-padding-block" | "--pi-control-padding-inline" | "--pi-list-row-padding-block" | "--pi-list-row-padding-inline" | "--pi-panel-padding" | "--pi-toolbar-gap" | "--pi-message-padding" | "--pi-message-gap" | "--pi-content-max-width";

export interface ResolvedPresentationProfile {
  id: BuiltInPresentationProfileId;
  title: string;
  base: BuiltInPresentationProfileId;
  tokens: Record<PresentationToken, string>;
}

const tokens: Record<BuiltInPresentationProfileId, ResolvedPresentationProfile["tokens"]> = {
  comfortable: { "--pi-control-min-size": "32px", "--pi-control-padding-block": "6px", "--pi-control-padding-inline": "8px", "--pi-list-row-padding-block": "6px", "--pi-list-row-padding-inline": "8px", "--pi-panel-padding": "10px", "--pi-toolbar-gap": "6px", "--pi-message-padding": "10px", "--pi-message-gap": "10px", "--pi-content-max-width": "none" },
  compact: { "--pi-control-min-size": "26px", "--pi-control-padding-block": "3px", "--pi-control-padding-inline": "6px", "--pi-list-row-padding-block": "2px", "--pi-list-row-padding-inline": "5px", "--pi-panel-padding": "6px", "--pi-toolbar-gap": "3px", "--pi-message-padding": "6px", "--pi-message-gap": "6px", "--pi-content-max-width": "none" },
};

export function builtInPresentationProfile(id: BuiltInPresentationProfileId): ResolvedPresentationProfile {
  return { id, title: id === "comfortable" ? "Comfortable" : "Compact", base: id, tokens: { ...tokens[id] } };
}

export function readStoredPresentationProfile(storage: DensityStorage = window.localStorage): ResolvedPresentationProfile | undefined {
  try {
    const id = storage.getItem(PRESENTATION_PROFILE_STORAGE_KEY);
    return id === "comfortable" || id === "compact" ? builtInPresentationProfile(id) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredPresentationProfile(profile: ResolvedPresentationProfile, storage: DensityStorage = window.localStorage): void {
  try {
    storage.setItem(PRESENTATION_PROFILE_STORAGE_KEY, profile.id);
  } catch {
    // The selected profile remains active in this tab.
  }
}

export function applyPresentationProfile(profile: ResolvedPresentationProfile, root: { dataset: Record<string, string | undefined>; style: { setProperty(name: string, value: string): void } } = document.documentElement): void {
  root.dataset["piWebPresentationProfile"] = profile.id;
  root.dataset["piWebDensity"] = profile.base;
  for (const [name, value] of Object.entries(profile.tokens)) root.style.setProperty(name, value);
  applyInterfaceScale(readStoredInterfaceScale(), root);
}
