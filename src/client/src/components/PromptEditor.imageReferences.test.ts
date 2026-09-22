// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("PromptEditor image attachment accessibility", () => {
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
