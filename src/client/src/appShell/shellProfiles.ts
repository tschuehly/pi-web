import type { QualifiedContributionId } from "../plugins/types";

export const CORE_SHELL_PROFILE_ID = "core:shell.default";
export const CORE_CONVERSATION_VIEW_ID = "core:conversation";
export const SHELL_PROFILE_STORAGE_KEY = "pi-web:shell-profile:v1";
export const SHELL_REGION_LOCATIONS = ["context-bar", "status", "surface-strip", "contextual-actions"] as const;

export const SHELL_PROFILE_PANEL_BOUNDS = {
  navigation: { min: 180, max: 640 },
  workspace: { min: 240, max: 960 },
} as const;

export type ShellProfileStorage = Pick<Storage, "getItem" | "setItem">;

interface StoredShellProfileSelection {
  version: 1;
  profileId: string;
}

export type ShellProfileActivationResult<T> =
  | { ok: true; profile: T }
  | { ok: false; profile: T; error: string };

export function transactShellProfileActivation<T, ProfileId extends string>(current: T, profileId: ProfileId, resolve: (profileId: ProfileId) => T): ShellProfileActivationResult<T> {
  try {
    return { ok: true, profile: resolve(profileId) };
  } catch (error) {
    return { ok: false, profile: current, error: errorMessage(error) };
  }
}

export function readStoredShellProfileId(storage: ShellProfileStorage | undefined = browserShellProfileStorage()): QualifiedContributionId | undefined {
  try {
    const raw = storage?.getItem(SHELL_PROFILE_STORAGE_KEY);
    if (raw === undefined || raw === null || raw === "") return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed["version"] !== 1 || !isQualifiedContributionId(parsed["profileId"])) return undefined;
    return parsed["profileId"];
  } catch {
    return undefined;
  }
}

export function writeStoredShellProfileId(profileId: string, storage: ShellProfileStorage | undefined = browserShellProfileStorage()): void {
  if (storage === undefined) return;
  try {
    const selection: StoredShellProfileSelection = { version: 1, profileId };
    storage.setItem(SHELL_PROFILE_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // The selected profile remains active for this tab when browser storage is unavailable.
  }
}

function browserShellProfileStorage(): ShellProfileStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQualifiedContributionId(value: unknown): value is QualifiedContributionId {
  return typeof value === "string" && /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
