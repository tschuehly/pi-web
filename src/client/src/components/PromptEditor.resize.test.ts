// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERFACE_SCALE_CSS_PROPERTY } from "../interfaceScale";
import { PROMPT_EDITOR_MAX_HEIGHT, PROMPT_EDITOR_MIN_HEIGHT, PromptEditor, promptEditorDragHeight, promptEditorMaximumHeight } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty(INTERFACE_SCALE_CSS_PROPERTY);
  localStorage.clear();
});

describe("PromptEditor resize handle", () => {
  it("renders an accessible separator and supports bounded keyboard resizing and reset", async () => {
    const editor = await mountEditor();
    const handle = resizeHandle(editor);

    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("aria-valuemin")).toBe("54");
    expect(handle.getAttribute("aria-valuenow")).toBe("54");

    key(handle, "ArrowUp");
    await editor.updateComplete;
    expect(handle.getAttribute("aria-valuenow")).toBe("78");
    expect(editor.shadowRoot?.querySelector(".markdown-editor")?.getAttribute("style")).toContain("78px");

    key(handle, "ArrowUp", true);
    await editor.updateComplete;
    expect(handle.getAttribute("aria-valuenow")).toBe("150");

    key(handle, "Home");
    await editor.updateComplete;
    expect(handle.getAttribute("aria-valuenow")).toBe("54");

    key(handle, "End");
    await editor.updateComplete;
    expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemax"));

    key(handle, "Enter");
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".markdown-editor-manual-height")).toBeNull();
  });

  it("normalizes upward pointer drag by interface scale and resets on double-click and double-tap", async () => {
    document.documentElement.style.setProperty(INTERFACE_SCALE_CSS_PROPERTY, "1.5");
    const editor = await mountEditor();
    const handle = resizeHandle(editor);
    stubPointerCapture(handle);

    pointer(handle, "pointerdown", 300, 1, "mouse");
    pointer(handle, "pointermove", 240, 1, "mouse");
    pointer(handle, "pointerup", 240, 1, "mouse");
    await editor.updateComplete;
    expect(handle.getAttribute("aria-valuenow")).toBe("94");

    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".markdown-editor-manual-height")).toBeNull();

    key(handle, "ArrowUp");
    await editor.updateComplete;
    for (const id of [2, 3]) {
      pointer(handle, "pointerdown", 200, id, "touch");
      pointer(handle, "pointerup", 200, id, "touch");
    }
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".markdown-editor-manual-height")).toBeNull();
  });

  it("keeps manual height across sends and session changes but not a remount", async () => {
    const editor = await mountEditor();
    const handle = resizeHandle(editor);
    key(handle, "ArrowUp");
    await editor.updateComplete;

    editor.sessionId = "next-session";
    await editor.updateComplete;
    expect(resizeHandle(editor).getAttribute("aria-valuenow")).toBe("78");

    Reflect.set(editor, "draft", "send this");
    editor.onSend = vi.fn();
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    await editor.updateComplete;
    expect(resizeHandle(editor).getAttribute("aria-valuenow")).toBe("78");

    editor.remove();
    const remounted = await mountEditor();
    expect(resizeHandle(remounted).getAttribute("aria-valuenow")).toBe("54");
  });

  it("clamps pure drag geometry to the zoom-compensated viewport bounds", () => {
    expect(promptEditorMaximumHeight(1600, 1)).toBe(PROMPT_EDITOR_MAX_HEIGHT);
    expect(promptEditorMaximumHeight(600, 1.5)).toBe(200);
    expect(promptEditorDragHeight(100, 300, 240, 1.5, 200)).toBe(140);
    expect(promptEditorDragHeight(100, 300, -1000, 1, 200)).toBe(200);
    expect(promptEditorDragHeight(100, 300, 1000, 1, 200)).toBe(PROMPT_EDITOR_MIN_HEIGHT);
  });
});

async function mountEditor(): Promise<PromptEditor> {
  const editor = new PromptEditor();
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function resizeHandle(editor: PromptEditor): HTMLElement {
  const handle = editor.shadowRoot?.querySelector<HTMLElement>(".editor-resize-handle");
  if (handle === null || handle === undefined) throw new Error("Prompt editor resize handle was not rendered");
  return handle;
}

function key(handle: HTMLElement, keyName: string, shiftKey = false): void {
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, shiftKey, bubbles: true, cancelable: true }));
}

function stubPointerCapture(handle: HTMLElement): void {
  Reflect.set(handle, "setPointerCapture", vi.fn());
  Reflect.set(handle, "hasPointerCapture", () => true);
  Reflect.set(handle, "releasePointerCapture", vi.fn());
}

function pointer(handle: HTMLElement, type: string, clientY: number, pointerId: number, pointerType: string): void {
  handle.dispatchEvent(new PointerEvent(type, { button: 0, clientY, pointerId, pointerType, bubbles: true, cancelable: true }));
}
