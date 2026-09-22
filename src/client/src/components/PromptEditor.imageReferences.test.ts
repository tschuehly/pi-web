// @vitest-environment happy-dom
import { isolateHistory, undo } from "@codemirror/commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("PromptEditor image attachment accessibility", () => {
  it.each([
    ["send", false, false, ".send-button", undefined],
    ["steer", true, false, ".send-button", "steer"],
    ["queue", true, false, ".queue-button", "followUp"],
    ["compacting queue", true, true, ".send-button", "followUp"],
  ] as const)("strips an undone removal's orphan token on %s without shifting surviving images", async (_name, canSteer, isCompacting, selector, behavior) => {
    const editor = new PromptEditor();
    const onSend = vi.fn();
    editor.canSteer = canSteer;
    editor.isCompacting = isCompacting;
    editor.onSend = onSend;
    document.body.append(editor);
    await editor.updateComplete;
    const removed = { id: "attachment-1", kind: "image" as const, reference: "[PIC_1]", name: "removed.png", mimeType: "image/png", data: "UE5H", size: 3 };
    const surviving = { ...removed, id: "attachment-2", reference: "[PIC_2]", name: "surviving.png" };
    Reflect.set(editor, "attachments", [removed, surviving]);
    if (editor.view === undefined) throw new Error("CodeMirror editor missing");
    editor.view.dispatch({ changes: { from: 0, insert: "compare [PIC_1] with [PIC_2]" }, annotations: isolateHistory.of("after") });
    await editor.updateComplete;

    editor.shadowRoot?.querySelector<HTMLButtonElement>('.attachment-remove[aria-label="Remove [PIC_1] image removed.png"]')?.click();
    await editor.updateComplete;
    expect(editor.view.state.doc.toString()).not.toContain("[PIC_1]");
    expect(undo(editor.view)).toBe(true);
    expect(editor.view.state.doc.toString()).toContain("[PIC_1]");

    editor.shadowRoot?.querySelector<HTMLButtonElement>(selector)?.click();
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("compare with [PIC_2]", behavior, [expect.objectContaining({ reference: "[PIC_2]", data: "UE5H" })], "inline", undefined);
  });

  it("shows the stable reference in the preview and accessible remove label", async () => {
    const editor = new PromptEditor();
    document.body.append(editor);
    await editor.updateComplete;
    Reflect.set(editor, "attachments", [{
      id: "attachment-1",
      kind: "image",
      reference: "[PIC_4]",
      name: "duplicate.png",
      mimeType: "image/png",
      data: "UE5H",
      size: 3,
    }]);
    editor.requestUpdate();
    await editor.updateComplete;

    expect(editor.shadowRoot?.querySelector(".attachment-image-reference")?.textContent).toBe("[PIC_4]");
    expect(editor.shadowRoot?.querySelector(".attachment-chip img")?.getAttribute("alt")).toBe("[PIC_4] image duplicate.png");
    expect(editor.shadowRoot?.querySelector(".attachment-remove")?.getAttribute("aria-label")).toBe("Remove [PIC_4] image duplicate.png");
  });

  it("restores the complete composer and cursor when attachment delivery fails", async () => {
    const editor = new PromptEditor();
    editor.sessionId = "retry-session";
    editor.onSend = () => Promise.resolve(false);
    document.body.append(editor);
    await editor.updateComplete;
    editor.replaceText("before [PIC_4] after");
    editor.view?.dispatch({ selection: { anchor: 7 } });
    const attachments = [{
      id: "attachment-1",
      kind: "image" as const,
      reference: "[PIC_4]",
      name: "retry.png",
      mimeType: "image/png",
      data: "UE5H",
      size: 3,
    }];
    Reflect.set(editor, "attachments", attachments);
    Reflect.set(editor, "nextImageReference", 5);
    const send: unknown = Reflect.get(editor, "send");
    if (typeof send !== "function") throw new Error("PromptEditor send unavailable");

    Reflect.apply(send, editor, []);
    for (let remaining = 0; remaining < 5; remaining += 1) await Promise.resolve();
    await editor.updateComplete;

    expect(editor.view?.state.doc.toString()).toBe("before [PIC_4] after");
    expect(editor.view?.state.selection.main.head).toBe(7);
    expect(Reflect.get(editor, "attachments")).toEqual(attachments);
    expect(Reflect.get(editor, "nextImageReference")).toBe(5);
    expect(Reflect.get(editor, "draftGeneration")).toBe(0);
    expect(editor.shadowRoot?.querySelector(".attachment-error")?.textContent).toContain("restored for retry");
  });
});
