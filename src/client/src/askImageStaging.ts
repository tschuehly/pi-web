import type { AskUserSubmissionImage } from "../../shared/apiTypes";

/** An unsent image of an ask answer or note; `id` tells two copies of one file apart. */
export interface StagedAskImage extends AskUserSubmissionImage {
  id: string;
}

/**
 * Unsent ask images, keyed `session:askId:target`. Memory only, as the composer's attachments are
 * (`promptAttachmentStaging.ts`): images would overrun askDrafts' localStorage quota, so a reload loses them.
 */
const staged = new Map<string, readonly StagedAskImage[]>();

export function askImageKey(sessionId: string, askId: string, target: string): string {
  return `${sessionId}:${askId}:${target}`;
}

export function loadAskImages(key: string): readonly StagedAskImage[] {
  return staged.get(key) ?? [];
}

export function saveAskImages(key: string, images: readonly StagedAskImage[]): void {
  if (images.length === 0) staged.delete(key);
  else staged.set(key, images);
}
