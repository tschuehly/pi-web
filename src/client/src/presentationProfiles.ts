import type { PiWebPresentationProfileConfigMap } from "../../shared/apiTypes";
import type { DensityStorage } from "./density";

export const PRESENTATION_PROFILE_STORAGE_KEY = "pi-web-app-presentation-profile";
export const PRESENTATION_PROFILE_IDS = ["comfortable", "compact"] as const;
export type BuiltInPresentationProfileId = (typeof PRESENTATION_PROFILE_IDS)[number];

export const PRESENTATION_TOKENS = [
  "--pi-control-min-size",
  "--pi-control-padding-block",
  "--pi-control-padding-inline",
  "--pi-list-row-padding-block",
  "--pi-list-row-padding-inline",
  "--pi-panel-padding",
  "--pi-toolbar-gap",
  "--pi-message-padding",
  "--pi-message-gap",
  "--pi-content-max-width",
] as const;
export type PresentationToken = (typeof PRESENTATION_TOKENS)[number];
export type ResolvedPresentationTokens = Record<PresentationToken, string>;

export interface PresentationProfileDefinition {
  id: string;
  version: 1;
  title: string;
  description: string;
  extends: BuiltInPresentationProfileId;
  tokens: Partial<ResolvedPresentationTokens>;
  origin: "global-config";
}

export interface ResolvedPresentationProfile {
  id: string;
  title: string;
  description: string;
  base: BuiltInPresentationProfileId;
  tokens: ResolvedPresentationTokens;
  revision: string;
  origin: "built-in" | "global-config" | "stored";
}

export interface PresentationStyleRoot {
  dataset: Record<string, string | undefined>;
  style: { setProperty(name: string, value: string): void };
}

export interface PresentationProfileInspection {
  profiles: PresentationProfileDefinition[];
  errors: Record<string, string>;
}

interface StoredPresentationSelection {
  version: 1;
  profile: ResolvedPresentationProfile;
}

interface TokenConstraint {
  min: number;
  max: number;
  allowNone?: boolean;
}

const profileIdPattern = /^[a-z][a-z0-9.-]*$/u;
const presentationTokenSet = new Set<string>(PRESENTATION_TOKENS);
const profileKeys = new Set(["version", "title", "description", "extends", "tokens"]);
const tokenConstraints: Record<PresentationToken, TokenConstraint> = {
  "--pi-control-min-size": { min: 24, max: 64 },
  "--pi-control-padding-block": { min: 0, max: 24 },
  "--pi-control-padding-inline": { min: 0, max: 32 },
  "--pi-list-row-padding-block": { min: 0, max: 24 },
  "--pi-list-row-padding-inline": { min: 0, max: 32 },
  "--pi-panel-padding": { min: 0, max: 48 },
  "--pi-toolbar-gap": { min: 0, max: 32 },
  "--pi-message-padding": { min: 0, max: 48 },
  "--pi-message-gap": { min: 0, max: 48 },
  "--pi-content-max-width": { min: 320, max: 2400, allowNone: true },
};

const builtInTokens: Record<BuiltInPresentationProfileId, ResolvedPresentationTokens> = {
  comfortable: {
    "--pi-control-min-size": "32px",
    "--pi-control-padding-block": "6px",
    "--pi-control-padding-inline": "8px",
    "--pi-list-row-padding-block": "6px",
    "--pi-list-row-padding-inline": "8px",
    "--pi-panel-padding": "10px",
    "--pi-toolbar-gap": "6px",
    "--pi-message-padding": "10px",
    "--pi-message-gap": "10px",
    "--pi-content-max-width": "none",
  },
  compact: {
    "--pi-control-min-size": "26px",
    "--pi-control-padding-block": "3px",
    "--pi-control-padding-inline": "6px",
    "--pi-list-row-padding-block": "2px",
    "--pi-list-row-padding-inline": "5px",
    "--pi-panel-padding": "6px",
    "--pi-toolbar-gap": "3px",
    "--pi-message-padding": "6px",
    "--pi-message-gap": "6px",
    "--pi-content-max-width": "none",
  },
};

export function inspectPresentationProfiles(value: PiWebPresentationProfileConfigMap | undefined): PresentationProfileInspection {
  const profiles: PresentationProfileDefinition[] = [];
  const errors: Record<string, string> = {};
  for (const [id, candidate] of Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    try {
      profiles.push(parsePresentationProfile(id, candidate));
    } catch (error) {
      errors[id] = errorMessage(error);
    }
  }
  return { profiles, errors };
}

export function builtInPresentationProfile(id: BuiltInPresentationProfileId): ResolvedPresentationProfile {
  const title = id === "comfortable" ? "Comfortable" : "Compact";
  const description = id === "comfortable" ? "More breathing room for everyday use." : "More navigation and conversation context in the same viewport.";
  const tokens = { ...builtInTokens[id] };
  return {
    id,
    title,
    description,
    base: id,
    tokens,
    revision: presentationRevision({ id, title, description, base: id, tokens }),
    origin: "built-in",
  };
}

export function resolvePresentationProfile(id: string, profiles: readonly PresentationProfileDefinition[]): ResolvedPresentationProfile | undefined {
  if (isBuiltInProfileId(id)) return builtInPresentationProfile(id);
  const profile = profiles.find((candidate) => candidate.id === id);
  if (profile === undefined) return undefined;
  const tokens = { ...builtInTokens[profile.extends], ...profile.tokens };
  return {
    id: profile.id,
    title: profile.title,
    description: profile.description,
    base: profile.extends,
    tokens,
    revision: presentationRevision({ id: profile.id, title: profile.title, description: profile.description, base: profile.extends, tokens }),
    origin: "global-config",
  };
}

export function presentationProfileChanged(active: ResolvedPresentationProfile, available: ResolvedPresentationProfile | undefined): boolean {
  return active.id === available?.id && active.revision !== available.revision;
}

export function readStoredPresentationProfile(storage: DensityStorage = window.localStorage): ResolvedPresentationProfile | undefined {
  try {
    const raw = storage.getItem(PRESENTATION_PROFILE_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed["version"] !== 1) return undefined;
    return parseStoredProfile(parsed["profile"]);
  } catch {
    return undefined;
  }
}

export function writeStoredPresentationProfile(profile: ResolvedPresentationProfile, storage: DensityStorage = window.localStorage): void {
  try {
    const selection: StoredPresentationSelection = { version: 1, profile };
    storage.setItem(PRESENTATION_PROFILE_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // The resolved profile remains active for this tab when browser storage is unavailable.
  }
}

export function applyPresentationProfile(profile: ResolvedPresentationProfile, root: PresentationStyleRoot = document.documentElement): void {
  root.dataset["piWebPresentationProfile"] = profile.id;
  root.dataset["piWebDensity"] = profile.base;
  for (const token of PRESENTATION_TOKENS) root.style.setProperty(token, profile.tokens[token]);
}

function parsePresentationProfile(id: string, value: unknown): PresentationProfileDefinition {
  if (!profileIdPattern.test(id) || isBuiltInProfileId(id)) throw new Error(`Profile id ${JSON.stringify(id)} is invalid or reserved.`);
  if (!isRecord(value)) throw new Error("Profile must be an object.");
  const unknownKey = Object.keys(value).find((key) => !profileKeys.has(key));
  if (unknownKey !== undefined) throw new Error(`Unknown profile key ${JSON.stringify(unknownKey)}.`);
  if (value["version"] !== 1) throw new Error("Profile version must be 1.");
  const title = boundedString(value["title"], "title", 80, false);
  const description = boundedString(value["description"], "description", 240, false);
  const base = value["extends"];
  if (!isBuiltInProfileId(base)) throw new Error("Profile extends must be comfortable or compact.");
  return {
    id,
    version: 1,
    title,
    description,
    extends: base,
    tokens: parseTokenOverrides(value["tokens"]),
    origin: "global-config",
  };
}

function parseTokenOverrides(value: unknown): Partial<ResolvedPresentationTokens> {
  if (!isRecord(value)) throw new Error("Profile tokens must be an object.");
  const result: Partial<ResolvedPresentationTokens> = {};
  for (const [token, rawValue] of Object.entries(value)) {
    if (!isPresentationToken(token)) throw new Error(`Unknown presentation token ${JSON.stringify(token)}.`);
    result[token] = parseTokenValue(token, rawValue);
  }
  return result;
}

function parseTokenValue(token: PresentationToken, value: unknown): string {
  const constraint = tokenConstraints[token];
  if (constraint.allowNone === true && value === "none") return "none";
  if (typeof value !== "string") throw new Error(`${token} must be a pixel value${constraint.allowNone === true ? " or none" : ""}.`);
  const match = /^([0-9]+(?:\.[0-9]+)?)px$/u.exec(value);
  const numberValue = match === null ? NaN : Number(match[1]);
  if (!Number.isFinite(numberValue) || numberValue < constraint.min || numberValue > constraint.max) {
    const allowed = constraint.allowNone === true ? `, or none` : "";
    throw new Error(`${token} must be between ${String(constraint.min)}px and ${String(constraint.max)}px${allowed}.`);
  }
  return `${String(numberValue)}px`;
}

function parseStoredProfile(value: unknown): ResolvedPresentationProfile | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const title = value["title"];
  const description = value["description"];
  const base = value["base"];
  const revision = value["revision"];
  const origin = value["origin"];
  const tokens = value["tokens"];
  if (typeof id !== "string" || !profileIdPattern.test(id)) return undefined;
  if (typeof title !== "string" || typeof description !== "string" || !isBuiltInProfileId(base) || typeof revision !== "string") return undefined;
  if (origin !== "built-in" && origin !== "global-config" && origin !== "stored") return undefined;
  if (!isRecord(tokens) || Object.keys(tokens).length !== PRESENTATION_TOKENS.length) return undefined;
  const resolvedTokens: ResolvedPresentationTokens = { ...builtInTokens[base] };
  for (const token of PRESENTATION_TOKENS) {
    try {
      resolvedTokens[token] = parseTokenValue(token, tokens[token]);
    } catch {
      return undefined;
    }
  }
  return { id, title, description, base, revision, tokens: resolvedTokens, origin: "stored" };
}

function presentationRevision(profile: { id: string; title: string; description: string; base: BuiltInPresentationProfileId; tokens: ResolvedPresentationTokens }): string {
  const canonical = JSON.stringify([profile.id, profile.title, profile.description, profile.base, ...PRESENTATION_TOKENS.map((token) => [token, profile.tokens[token]])]);
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function boundedString(value: unknown, label: string, maxLength: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.trim() === "")) {
    throw new Error(`Profile ${label} must be ${allowEmpty ? "a" : "a non-empty"} string no longer than ${String(maxLength)} characters.`);
  }
  return value;
}

function isPresentationToken(value: string): value is PresentationToken {
  return presentationTokenSet.has(value);
}

function isBuiltInProfileId(value: unknown): value is BuiltInPresentationProfileId {
  return value === "comfortable" || value === "compact";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

