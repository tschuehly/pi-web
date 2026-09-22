// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERFACE_SCALE_CSS_PROPERTY } from "../interfaceScale";
import { PROMPT_EDITOR_MAX_HEIGHT, PROMPT_EDITOR_MIN_HEIGHT, PromptEditor, promptEditorDragHeight, promptEditorMaximumHeight } from "./PromptEditor";
import { chatStyles, promptEditorStyles } from "./shared";

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
    expect(handle.getAttribute("aria-valuetext")).toBe("54 pixels, automatic height");
    expect(handle.getAttribute("aria-label")).toContain("Enter to reset");
    expect(handle.getAttribute("title")).toContain("Press Enter to reset");

    key(handle, "ArrowUp");
    await editor.updateComplete;
    expect(handle.getAttribute("aria-valuenow")).toBe("78");
    expect(handle.getAttribute("aria-valuetext")).toBe("78 pixels, manual height");
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
    expect(editor.shadowRoot?.activeElement).toBe(handle);
    pointer(handle, "pointermove", 240, 1, "mouse");
    pointer(handle, "pointerup", 240, 1, "mouse");
    await editor.updateComplete;
    expect(handle.getAttribute("aria-valuenow")).toBe("94");

    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".markdown-editor-manual-height")).toBeNull();

    key(handle, "ArrowUp");
    await editor.updateComplete;
    pointer(handle, "pointerdown", 200, 2, "touch");
    pointer(handle, "pointerup", 200, 2, "touch");
    pointer(handle, "pointerdown", 200, 3, "touch");
    pointer(handle, "pointermove", 180, 3, "touch");
    pointer(handle, "pointerup", 180, 3, "touch");
    pointer(handle, "pointerdown", 200, 4, "touch");
    pointer(handle, "pointerup", 200, 4, "touch");
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".markdown-editor-manual-height")).not.toBeNull();

    for (const id of [5, 6]) {
      pointer(handle, "pointerdown", 200, id, "touch");
      pointer(handle, "pointerup", 200, id, "touch");
    }
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector(".markdown-editor-manual-height")).toBeNull();
  });

  it("does not focus the separator on touch and restores editor focus after a mouse resize", async () => {
    const editor = await mountEditor();
    const handle = resizeHandle(editor);
    stubPointerCapture(handle);
    editor.focusInput();
    const editorView: unknown = Reflect.get(editor, "editor");
    if (typeof editorView !== "object" || editorView === null || !("hasFocus" in editorView)) throw new Error("CodeMirror editor was not created");

    pointer(handle, "pointerdown", 200, 20, "touch");
    expect(editor.shadowRoot?.activeElement).not.toBe(handle);
    pointer(handle, "pointerup", 200, 20, "touch");

    editor.focusInput();
    pointer(handle, "pointerdown", 200, 21, "mouse");
    expect(editor.shadowRoot?.activeElement).toBe(handle);
    pointer(handle, "pointerup", 200, 21, "mouse");
    expect(Reflect.get(editorView, "hasFocus")).toBe(true);
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

  it("re-clamps manual height when measured composer chrome or interface scale changes", async () => {
    const observer = installResizeObserverStub();
    try {
      const editor = await mountEditor();
      Reflect.set(editor, "attachments", [{ id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "bm90ZXM=", size: 5 }]);
      editor.requestUpdate();
      await editor.updateComplete;
      expect(editor.shadowRoot?.querySelector(".attachments")).not.toBeNull();
      const footer = editor.shadowRoot?.querySelector<HTMLElement>("footer");
      const codeMirror = editor.shadowRoot?.querySelector<HTMLElement>(".cm-editor");
      if (footer === null || footer === undefined || codeMirror === null || codeMirror === undefined) throw new Error("Prompt editor geometry was not rendered");
      vi.spyOn(footer, "offsetHeight", "get").mockReturnValue(220);
      vi.spyOn(codeMirror, "offsetHeight", "get").mockReturnValue(54);

      observer.notify(editor);
      await editor.updateComplete;
      const expectedInitialMax = Math.round(promptEditorMaximumHeight(window.innerHeight, 1, 166));
      const automaticHandle = resizeHandle(editor);
      const markdownEditor = editor.shadowRoot?.querySelector<HTMLElement>(".markdown-editor");
      expect(markdownEditor?.style.getPropertyValue("--prompt-editor-maximum-height")).toBe(`${String(expectedInitialMax)}px`);
      expect(promptEditorStyles.cssText).toMatch(/max-height:\s*min\(220px, var\(--prompt-editor-maximum-height, 220px\)\)/);
      expect(automaticHandle.getAttribute("aria-valuenow")).toBe("54");
      expect(automaticHandle.getAttribute("aria-valuemax")).toBe(String(expectedInitialMax));

      key(automaticHandle, "End");
      await editor.updateComplete;
      expect(resizeHandle(editor).getAttribute("aria-valuenow")).toBe(String(expectedInitialMax));

      document.documentElement.style.setProperty(INTERFACE_SCALE_CSS_PROPERTY, "2");
      observer.notify(editor);
      await editor.updateComplete;
      const handle = resizeHandle(editor);
      expect(handle.getAttribute("aria-valuemax")).toBe("54");
      expect(handle.getAttribute("aria-valuenow")).toBe("54");
      expect(Number(handle.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(Number(handle.getAttribute("aria-valuemax")));
    } finally {
      observer.restore();
    }
  });

  it("keeps fine and coarse targets fully inside composer padding and clear of adjacent controls", () => {
    const promptCss = promptEditorStyles.cssText;
    expect(promptCss).toMatch(/footer\s*\{[^}]*padding:\s*24px 12px 12px/);
    expect(promptCss).toMatch(/\.editor-resize-handle\s*\{[^}]*top:\s*0;[^}]*height:\s*20px/);
    expect(promptCss).toMatch(/@media \(pointer: coarse\)[\s\S]*footer\s*\{[^}]*padding-top:\s*48px/);
    expect(promptCss).toMatch(/@media \(pointer: coarse\)[\s\S]*\.editor-resize-handle\s*\{[^}]*top:\s*0;[^}]*height:\s*44px/);
    expect(promptCss).toMatch(/@media \(pointer: coarse\)[\s\S]*\.editor-resize-handle::after\s*\{[^}]*top:\s*21px/);
    expect(20).toBeLessThanOrEqual(24);
    expect(44).toBeLessThanOrEqual(48);
    expect(chatStyles.cssText).toMatch(/\.scroll-to-bottom\s*\{[^}]*bottom:\s*12px/);
  });

  it("clamps pure drag geometry to the zoom-compensated viewport bounds", () => {
    expect(promptEditorMaximumHeight(1600, 1)).toBe(PROMPT_EDITOR_MAX_HEIGHT);
    expect(promptEditorMaximumHeight(600, 1.5)).toBe(200);
    expect(promptEditorMaximumHeight(600, 1.5, 80)).toBe(120);
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

function installResizeObserverStub(): { notify: (editor: PromptEditor) => void; restore: () => void } {
  const hadResizeObserver = Reflect.has(globalThis, "ResizeObserver");
  const previousResizeObserver: unknown = Reflect.get(globalThis, "ResizeObserver");
  let callback: ResizeObserverCallback | undefined;
  class ResizeObserverStub implements ResizeObserver {
    constructor(next: ResizeObserverCallback) { callback = next; }
    observe = vi.fn((target: Element) => { if (!(target instanceof Element)) throw new TypeError("ResizeObserver target must be an Element"); });
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = (): ResizeObserverEntry[] => [];
  }
  Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
  return {
    notify: (editor) => {
      const observer: unknown = Reflect.get(editor, "editorHeightObserver");
      if (callback === undefined || !(observer instanceof ResizeObserverStub)) throw new Error("Prompt editor resize observer was not installed");
      callback([], observer);
    },
    restore: () => {
      if (hadResizeObserver) Reflect.set(globalThis, "ResizeObserver", previousResizeObserver);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    },
  };
}
