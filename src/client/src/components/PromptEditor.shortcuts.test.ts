// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE } from "../composerShortcuts";
import { PROMPT_ENTER_PREFERENCE_STORAGE_KEY } from "../promptEnterBehavior";
import { PromptEditor } from "./PromptEditor";
import { api, type SlashCommand } from "../api";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mount(shortcut: string | null | undefined, coarsePointer = false, width = 1200) {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const media = matchMedia(query);
    Object.defineProperty(media, "matches", { value: coarsePointer || (query.includes("max-width") && width <= 760) });
    return media;
  });
  const editor = new PromptEditor();
  editor.shortcuts = shortcut === undefined ? {} : { [COMPOSER_SEND_DESKTOP]: shortcut, [COMPOSER_SEND_MOBILE]: shortcut };
  editor.onSend = vi.fn();
  document.body.append(editor);
  await editor.updateComplete;
  editor.replaceText("Hello");
  return editor;
}

function press(editor: PromptEditor, key: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...modifiers });
  editor.view?.contentDOM.dispatchEvent(event);
  return event;
}

describe("composer keyboard handling", () => {
  it.each([500, 1200])("keeps fine-pointer auto Enter behavior at %ipx", async (width) => {
    const editor = await mount(undefined, false, width);
    press(editor, "Enter", { shiftKey: true });
    expect(editor.view?.state.doc.toString()).toBe("Hello\n");
    expect(editor.onSend).not.toHaveBeenCalled();

    press(editor, "Enter");
    expect(editor.onSend).toHaveBeenCalledWith("Hello", undefined, undefined, undefined, undefined);
  });

  it.each([
    { canSteer: false, isCompacting: false, expected: undefined },
    { canSteer: true, isCompacting: false, expected: "steer" },
    { canSteer: false, isCompacting: true, expected: "followUp" },
  ] as const)("uses the primary $expected action on fine-pointer plain Enter", async ({ canSteer, isCompacting, expected }) => {
    const editor = await mount(undefined);
    editor.canSteer = canSteer;
    editor.isCompacting = isCompacting;
    press(editor, "Enter");
    expect(editor.onSend).toHaveBeenCalledWith("Hello", expected, undefined, undefined, undefined);
  });

  it("queues follow-ups with Cmd/Ctrl+Enter in auto", async () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const editor = await mount(undefined);
      editor.canSteer = true;
      press(editor, "Enter", modifier);
      expect(editor.onSend).toHaveBeenCalledWith("Hello", "followUp", undefined, undefined, undefined);
      editor.remove();
      vi.restoreAllMocks();
    }
  });

  it("keeps the coarse-pointer auto fallback and held Shift through unrelated keydowns", async () => {
    const editor = await mount(undefined, true, 1200);
    press(editor, "Enter");
    expect(editor.view?.state.doc.toString()).toBe("Hello\n");
    expect(editor.onSend).not.toHaveBeenCalled();

    press(editor, "Shift", { shiftKey: true });
    press(editor, "a", { shiftKey: true });
    press(editor, "Enter", { shiftKey: true });
    expect(editor.onSend).toHaveBeenCalledWith("Hello", undefined, undefined, undefined, undefined);
  });

  it("preserves explicit send, newline, and None preferences", async () => {
    localStorage.setItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY, "send");
    const sendEditor = await mount(undefined, true);
    press(sendEditor, "Enter");
    expect(sendEditor.onSend).toHaveBeenCalledOnce();
    sendEditor.remove();
    vi.restoreAllMocks();

    localStorage.setItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY, "newline");
    const newlineEditor = await mount(undefined, false);
    press(newlineEditor, "Enter");
    expect(newlineEditor.view?.state.doc.toString()).toBe("Hello\n");
    expect(newlineEditor.onSend).not.toHaveBeenCalled();
    press(newlineEditor, "Enter", { shiftKey: true });
    expect(newlineEditor.onSend).toHaveBeenCalledOnce();
    newlineEditor.remove();
    vi.restoreAllMocks();

    const noneEditor = await mount(null);
    noneEditor.canSteer = true;
    press(noneEditor, "Enter", { ctrlKey: true });
    expect(noneEditor.onSend).not.toHaveBeenCalled();
  });

  it("inserts newlines with Enter/Shift+Enter and sends with the configured combination", async () => {
    const editor = await mount("mod+enter");
    press(editor, "Enter");
    press(editor, "Enter", { shiftKey: true });
    expect(editor.view?.state.doc.toString()).toBe("Hello\n\n");
    expect(editor.onSend).not.toHaveBeenCalled();
    press(editor, "Enter", { ctrlKey: true });
    expect(editor.onSend).toHaveBeenCalledOnce();
  });

  it("claims send keys before global dispatch even when sending is unavailable", async () => {
    const editor = await mount("mod+enter");
    const ownership: boolean[] = [];
    const capture = (event: KeyboardEvent) => { ownership.push(editor.ownsKeyboardEvent(event)); };
    window.addEventListener("keydown", capture, true);
    try {
      editor.replaceText("");
      press(editor, "Enter", { ctrlKey: true });
      editor.disabled = true;
      await editor.updateComplete;
      press(editor, "Enter", { metaKey: true });
      press(editor, "k", { ctrlKey: true });
      expect(ownership).toEqual([true, true, false]);
      expect(editor.onSend).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", capture, true);
    }
  });

  it("keeps keyboard submission disabled with None while the send button works", async () => {
    const editor = await mount(null);
    press(editor, "Enter");
    press(editor, "Enter", { shiftKey: true });
    expect(editor.onSend).not.toHaveBeenCalled();
    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    expect(editor.onSend).toHaveBeenCalledOnce();
  });

  it("accepts a completion before sending on plain Enter", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([{ name: "tree", source: "builtin" }]);
    const editor = await mount("enter");
    editor.sessionId = "test-session";
    editor.cwd = "/repo";
    await editor.updateComplete;
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "/tr" }, selection: { anchor: 3 } });
    await vi.waitFor(() => {
      const menu = editor.shadowRoot?.querySelector("autocomplete-menu");
      expect(menu?.shadowRoot?.textContent).toContain("/tree");
    });
    press(editor, "Enter");
    expect(editor.view?.state.doc.toString()).toBe("/tree ");
    expect(editor.onSend).not.toHaveBeenCalled();
  });

  it("clears stale suggestions before Enter handles a new query", async () => {
    let resolveLookup: ((commands: SlashCommand[]) => void) | undefined;
    const pendingLookup = new Promise<SlashCommand[]>((resolve) => { resolveLookup = resolve; });
    vi.spyOn(api, "commands")
      .mockResolvedValueOnce([{ name: "tree", source: "builtin" }])
      .mockReturnValueOnce(pendingLookup);
    const editor = await mount(undefined);
    editor.sessionId = "test-session";
    editor.cwd = "/repo";
    await editor.updateComplete;
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "/tr" }, selection: { anchor: 3 } });
    await vi.waitFor(() => {
      expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).toContain("/tree");
    });

    editor.view?.dispatch({ changes: { from: 3, insert: "e" }, selection: { anchor: 4 } });
    press(editor, "Enter");
    expect(editor.onSend).toHaveBeenCalledWith("/tre", undefined, undefined, undefined, undefined);

    resolveLookup?.([{ name: "tree", source: "builtin" }]);
    await pendingLookup;
  });

  it("does not submit while composing", async () => {
    const editor = await mount(undefined);
    press(editor, "Enter", { isComposing: true });
    expect(editor.onSend).not.toHaveBeenCalled();
  });

  it("ignores touch autocapitalization but accepts explicit Shift+Enter", async () => {
    const editor = await mount("shift+enter", true);
    press(editor, "Enter", { shiftKey: true });
    expect(editor.onSend).not.toHaveBeenCalled();
    press(editor, "Shift", { shiftKey: true });
    press(editor, "Enter", { shiftKey: true });
    expect(editor.onSend).toHaveBeenCalledOnce();
  });
});
