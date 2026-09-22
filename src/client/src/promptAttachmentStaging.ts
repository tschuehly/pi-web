import type { CapturedAttachment } from "./promptAttachmentCapture";

export type PendingAttachment = (CapturedAttachment & { id: string }) & ({ kind: "image"; reference: string } | { kind: "file" });

export interface StagedAttachmentDraft {
  attachments: readonly PendingAttachment[];
  nextImageReference: number;
  pendingImageReferences: readonly string[];
  generation: number;
}

export type StagedAttachmentStore = Map<string, StagedAttachmentDraft>;

/**
 * Attachment bytes, reference counters, and in-flight mappings intentionally
 * live only for this app lifetime. Draft text remains persisted separately;
 * after a full reload PromptEditor removes `[PIC_n]` tokens that no longer have
 * an in-memory attachment mapping. Key aliases keep reads started under a
 * temporary session id attached after that id moves to its real session.
 */
const sharedStore: StagedAttachmentStore = new Map();
const movedKeys = new WeakMap<StagedAttachmentStore, Map<string, string>>();

function defaultStore(): StagedAttachmentStore {
  return sharedStore;
}

export function emptyStagedAttachmentDraft(generation = 0): StagedAttachmentDraft {
  return { attachments: [], nextImageReference: 1, pendingImageReferences: [], generation };
}

export function loadStagedAttachmentDraft(key: string, store: StagedAttachmentStore = defaultStore()): StagedAttachmentDraft {
  return store.get(key) ?? emptyStagedAttachmentDraft();
}

export function loadStagedAttachments(key: string, store: StagedAttachmentStore = defaultStore()): readonly PendingAttachment[] {
  return loadStagedAttachmentDraft(key, store).attachments;
}

export function saveStagedAttachments(key: string, draft: StagedAttachmentDraft, store: StagedAttachmentStore = defaultStore()): void {
  const resolvedKey = resolveStagedAttachmentKey(key, store);
  if (draft.attachments.length > 0 || draft.nextImageReference > 1 || draft.pendingImageReferences.length > 0 || draft.generation > 0) store.set(resolvedKey, draft);
  else store.delete(resolvedKey);
  if (resolvedKey !== key) store.delete(key);
}

export function clearStagedAttachments(key: string, store: StagedAttachmentStore = defaultStore()): void {
  store.delete(key);
}

export function resolveStagedAttachmentKey(key: string, store: StagedAttachmentStore = defaultStore()): string {
  const aliases = movedKeys.get(store);
  if (aliases === undefined) return key;
  let resolved = key;
  const visited = new Set<string>();
  while (!visited.has(resolved)) {
    visited.add(resolved);
    const next = aliases.get(resolved);
    if (next === undefined) break;
    resolved = next;
  }
  return resolved;
}

export function moveStagedAttachments(fromKey: string, toKey: string, store: StagedAttachmentStore = defaultStore()): void {
  const resolvedFrom = resolveStagedAttachmentKey(fromKey, store);
  const resolvedTo = resolveStagedAttachmentKey(toKey, store);
  let aliases = movedKeys.get(store);
  if (aliases === undefined) {
    aliases = new Map();
    movedKeys.set(store, aliases);
  }
  aliases.set(fromKey, resolvedTo);
  aliases.set(resolvedFrom, resolvedTo);
  if (resolvedFrom === resolvedTo) return;
  const draft = store.get(resolvedFrom);
  if (draft !== undefined) store.set(resolvedTo, draft);
  store.delete(resolvedFrom);
}
