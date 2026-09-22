import { describe, expect, it } from "vitest";
import { clearStagedAttachments, emptyStagedAttachmentDraft, loadStagedAttachmentDraft, moveStagedAttachments, resolveStagedAttachmentKey, saveStagedAttachments, type PendingAttachment, type StagedAttachmentStore } from "./promptAttachmentStaging";

const attachment: PendingAttachment = { id: "attachment-1", kind: "image", reference: "[PIC_3]", name: "shot.png", mimeType: "image/png", data: "aGVsbG8=", size: 5 };

describe("promptAttachmentStaging", () => {
  it("defaults an unstaged draft to its first image reference", () => {
    expect(loadStagedAttachmentDraft("local:session-a", new Map())).toEqual(emptyStagedAttachmentDraft());
  });

  it("saves one explicit staging state", () => {
    const store: StagedAttachmentStore = new Map();
    const draft = { attachments: [attachment], nextImageReference: 5, pendingImageReferences: ["[PIC_4]"], generation: 2 };
    saveStagedAttachments("local:session-a", draft, store);
    expect(loadStagedAttachmentDraft("local:session-a", store)).toEqual(draft);
  });

  it("keeps a generation tombstone after reset", () => {
    const store: StagedAttachmentStore = new Map();
    saveStagedAttachments("local:session-a", emptyStagedAttachmentDraft(3), store);
    expect(loadStagedAttachmentDraft("local:session-a", store)).toEqual(emptyStagedAttachmentDraft(3));
  });

  it("clears all staged draft state", () => {
    const store: StagedAttachmentStore = new Map();
    saveStagedAttachments("local:session-a", { attachments: [attachment], nextImageReference: 4, pendingImageReferences: [], generation: 0 }, store);
    clearStagedAttachments("local:session-a", store);
    expect(loadStagedAttachmentDraft("local:session-a", store)).toEqual(emptyStagedAttachmentDraft());
  });

  it("moves staging and resolves in-flight writes to the replacement key", () => {
    const store: StagedAttachmentStore = new Map();
    const draft = { attachments: [attachment], nextImageReference: 5, pendingImageReferences: ["[PIC_4]"], generation: 2 };
    saveStagedAttachments("local:temp-1", draft, store);
    moveStagedAttachments("local:temp-1", "local:session-a", store);
    expect(loadStagedAttachmentDraft("local:temp-1", store)).toEqual(emptyStagedAttachmentDraft());
    expect(loadStagedAttachmentDraft("local:session-a", store)).toEqual(draft);
    expect(resolveStagedAttachmentKey("local:temp-1", store)).toBe("local:session-a");
  });

  it("records an empty move so a later async read lands on the real key", () => {
    const store: StagedAttachmentStore = new Map();
    moveStagedAttachments("local:temp-1", "local:session-a", store);
    expect(resolveStagedAttachmentKey("local:temp-1", store)).toBe("local:session-a");
  });
});
