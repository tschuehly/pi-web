// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { machineSessionKey } from "../machineKeys";
import { clearStagedAttachments, loadStagedAttachmentDraft } from "../promptAttachmentStaging";
import { loadDraft, ownedDraftStorage, saveDraft } from "../promptDraftStorage";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("r6: preserves a delayed image read and composition transactions across a Chat switch", async () => {
  const key = machineSessionKey("local", "r6-paste");
  let finish: (() => void) | undefined;
  class DeferredReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL() { finish = () => { this.result = "data:image/png;base64,UE5H"; this.onload?.(); }; }
  }
  vi.stubGlobal("FileReader", DeferredReader);
  const editor = new PromptEditor();
  editor.sessionId = "r6-paste";
  document.body.append(editor);
  await editor.updateComplete;
  editor.replaceText("describe");
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Reflect.set(paste, "clipboardData", { files: [new File(["png"], "image.png", { type: "image/png" })] });
  editor.shadowRoot?.querySelector("footer")?.dispatchEvent(paste);
  expect(loadDraft(key)).toContain("[PIC_1]");
  expect(loadStagedAttachmentDraft(key).pendingImageReferences).toEqual(["[PIC_1]"]);
  editor.sessionId = "r6-other";
  await editor.updateComplete;
  if (finish === undefined) throw new Error("Image read did not start");
  finish();
  await vi.waitFor(() => { expect(loadStagedAttachmentDraft(key).attachments).toHaveLength(1); });
  editor.sessionId = "r6-paste";
  await editor.updateComplete;
  expect(editor.view?.state.doc.toString()).toContain("[PIC_1]");
  expect(editor.shadowRoot?.querySelectorAll(".attachment-chip")).toHaveLength(1);
  const view = editor.view;
  if (view === undefined) throw new Error("Composer not mounted");
  view.dispatch({ changes: { from: view.state.doc.length, insert: "日本語" }, userEvent: "input.type.compose" });
  const composed = view.state.doc.toString();
  expect(loadDraft(key)).toBe(composed);
  editor.sessionId = "r6-other";
  await editor.updateComplete;
  editor.sessionId = "r6-paste";
  await editor.updateComplete;
  expect(editor.view?.state.doc.toString()).toBe(composed);
  expect(editor.shadowRoot?.querySelectorAll(".attachment-chip")).toHaveLength(1);
  clearStagedAttachments(key);
});

it("a retired composer cannot overwrite or clear the new owner's draft", async () => {
  let owns = true;
  const editor = new PromptEditor();
  editor.sessionId = "moved";
  editor.draftStorage = ownedDraftStorage(() => owns);
  document.body.append(editor);
  await editor.updateComplete;
  editor.replaceText("original draft");
  const key = machineSessionKey("local", "moved");
  expect(loadDraft(key)).toBe("original draft");
  owns = false;
  editor.remove();
  saveDraft(key, "new owner");
  editor.replaceText("late callback");
  editor.replaceText("");
  expect(loadDraft(key)).toBe("new owner");
});
