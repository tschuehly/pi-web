const draftStoragePrefix = "pi-web:prompt-draft:";
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** All writers in a Workbench window share this boundary, including late async composer/controller callbacks. */
export function ownedDraftStorage(owns: (sessionKey: string) => boolean, storage: DraftStorage | undefined = browserStorage()): DraftStorage {
  const check = (key: string) => {
    if (!key.startsWith(draftStoragePrefix) || !owns(key.slice(draftStoragePrefix.length))) throw new Error("Only the Chat's owning window may write its draft");
  };
  return {
    getItem: (key) => storage?.getItem(key) ?? null,
    setItem: (key, value) => { check(key); storage?.setItem(key, value); },
    removeItem: (key) => { check(key); storage?.removeItem(key); },
  };
}

function draftStorageKey(sessionId: string): string {
  return `${draftStoragePrefix}${sessionId}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadDraft(sessionId: string, storage: DraftStorage | undefined = browserStorage()): string {
  try {
    return storage?.getItem(draftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(sessionId: string, draft: string, storage: DraftStorage | undefined = browserStorage()): boolean {
  try {
    if (draft) storage?.setItem(draftStorageKey(sessionId), draft);
    else storage?.removeItem(draftStorageKey(sessionId));
    return storage !== undefined;
  } catch {
    return false;
  }
}

export function clearDraft(sessionId: string, storage: DraftStorage | undefined = browserStorage()): void {
  try {
    storage?.removeItem(draftStorageKey(sessionId));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

export function moveDraft(fromSessionId: string, toSessionId: string, storage: DraftStorage | undefined = browserStorage()): void {
  const draft = loadDraft(fromSessionId, storage);
  if (draft === "") return;
  if (saveDraft(toSessionId, draft, storage)) clearDraft(fromSessionId, storage);
}
