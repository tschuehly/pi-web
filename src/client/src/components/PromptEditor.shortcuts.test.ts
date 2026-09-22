// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_SEND_DESKTOP, COMPOSER_SEND_MOBILE } from "../composerShortcuts";
import { machineSessionKey } from "../machineKeys";
import { saveDraft } from "../promptDraftStorage";
import { PROMPT_ENTER_PREFERENCE_STORAGE_KEY, type PromptEnterPreference } from "../promptEnterBehavior";
import { PromptEditor } from "./PromptEditor";
import { api, type SessionModel } from "../api";

beforeEach(() => {
  localStorage.clear();
});

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

const sonnet: SessionModel = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };

async function completionEditor(draft: string): Promise<PromptEditor> {
  const editor = await mount(undefined);
  editor.sessionId = "test-session";
  editor.cwd = "/repo";
  await editor.updateComplete;
  editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: draft }, selection: { anchor: draft.length } });
  await vi.waitFor(() => {
    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).toContain(sonnet.id);
  });
  return editor;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
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

  it.each<PromptEnterPreference>(["auto", "send", "newline"])("sends immediately with Cmd/Ctrl+Enter while idle for the %s preference", async (preference) => {
    localStorage.setItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY, preference);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const editor = await mount(undefined);
      editor.canSteer = false;
      editor.isCompacting = false;
      const globalStartSession = vi.fn();
      const capture = (event: KeyboardEvent) => { if (!editor.ownsKeyboardEvent(event)) globalStartSession(); };
      window.addEventListener("keydown", capture, true);
      try {
        press(editor, "Enter", modifier);
        expect(editor.onSend).toHaveBeenCalledWith("Hello", undefined, undefined, undefined, undefined);
        expect(globalStartSession).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("keydown", capture, true);
        editor.remove();
        vi.restoreAllMocks();
      }
    }
  });

  it.each<PromptEnterPreference>(["auto", "send", "newline"])("queues follow-ups with Cmd/Ctrl+Enter while streaming for the %s preference before global shortcuts", async (preference) => {
    localStorage.setItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY, preference);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const editor = await mount(undefined);
      editor.canSteer = true;
      editor.isCompacting = false;
      const globalStartSession = vi.fn();
      const capture = (event: KeyboardEvent) => { if (!editor.ownsKeyboardEvent(event)) globalStartSession(); };
      window.addEventListener("keydown", capture, true);
      try {
        press(editor, "Enter", modifier);
        expect(editor.onSend).toHaveBeenCalledWith("Hello", "followUp", undefined, undefined, undefined);
        expect(globalStartSession).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("keydown", capture, true);
        editor.remove();
        vi.restoreAllMocks();
      }
    }
  });

  it.each<PromptEnterPreference>(["auto", "send", "newline"])("queues follow-ups with Cmd/Ctrl+Enter while compacting for the %s preference before global shortcuts", async (preference) => {
    localStorage.setItem(PROMPT_ENTER_PREFERENCE_STORAGE_KEY, preference);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const editor = await mount(undefined);
      editor.canSteer = false;
      editor.isCompacting = true;
      const globalStartSession = vi.fn();
      const capture = (event: KeyboardEvent) => { if (!editor.ownsKeyboardEvent(event)) globalStartSession(); };
      window.addEventListener("keydown", capture, true);
      try {
        press(editor, "Enter", modifier);
        expect(editor.onSend).toHaveBeenCalledWith("Hello", "followUp", undefined, undefined, undefined);
        expect(globalStartSession).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("keydown", capture, true);
        editor.remove();
        vi.restoreAllMocks();
      }
    }
  });

  it("releases Cmd/Ctrl+Enter to global shortcuts when keyboard submission is None", async () => {
    const editor = await mount(null);
    const globalStartSession = vi.fn();
    const capture = (event: KeyboardEvent) => { if (!editor.ownsKeyboardEvent(event)) globalStartSession(); };
    window.addEventListener("keydown", capture, true);
    try {
      press(editor, "Enter", { ctrlKey: true });
      expect(editor.onSend).not.toHaveBeenCalled();
      expect(globalStartSession).toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", capture, true);
    }
  });

  it("reports ownsKeyboardEvent false for Cmd/Ctrl+Enter and releases to global shortcuts when keyboard submission is None", async () => {
    const editor = await mount(null);
    const ownership: { key: string; owns: boolean }[] = [];
    const capture = (event: KeyboardEvent) => { ownership.push({ key: `${event.ctrlKey ? "ctrl+" : ""}${event.metaKey ? "meta+" : ""}${event.key}`, owns: editor.ownsKeyboardEvent(event) }); };
    window.addEventListener("keydown", capture, true);
    try {
      press(editor, "Enter");
      press(editor, "Enter", { ctrlKey: true });
      press(editor, "Enter", { metaKey: true });
      press(editor, "a");
      const primaryModifierOwnerships = ownership.filter((e) => (e.key.includes("ctrl") || e.key.includes("meta")) && e.key.includes("Enter"));
      expect(primaryModifierOwnerships.every((e) => !e.owns)).toBe(true);
      const plainEnter = ownership.find((e) => e.key === "Enter");
      expect(plainEnter?.owns).toBe(true);
    } finally {
      window.removeEventListener("keydown", capture, true);
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

  it("clears a missed explicit Shift release on the next unshifted keydown", async () => {
    const editor = await mount(undefined, true);
    press(editor, "Shift", { shiftKey: true });
    press(editor, "a");
    press(editor, "Enter", { shiftKey: true });

    expect(editor.view?.state.doc.toString()).toBe("Hello\n");
    expect(editor.onSend).not.toHaveBeenCalled();
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

  it("awaits delivery when Enter sends a known slash command", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([{ name: "tree", source: "builtin" }]);
    const editor = await mount("enter");
    editor.sessionId = "test-session";
    editor.cwd = "/repo";
    await editor.updateComplete;
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "/tree now" }, selection: { anchor: 9 } });

    press(editor, "Enter");

    await vi.waitFor(() => {
      expect(editor.onSend).toHaveBeenCalledWith("/tree now", undefined, undefined, undefined, undefined);
    });
  });

  it("hides stale suggestions before Enter handles a changed query", async () => {
    const pending = deferred<{ models: SessionModel[] }>();
    vi.spyOn(api, "models")
      .mockResolvedValueOnce({ models: [sonnet] })
      .mockReturnValueOnce(pending.promise);
    const editor = await completionEditor("#cla");

    editor.view?.dispatch({ changes: { from: 4, insert: "u" }, selection: { anchor: 5 } });
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).not.toContain("#anthropic/claude-sonnet-4-5");
    press(editor, "ArrowDown");
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).not.toContain("#anthropic/claude-sonnet-4-5");
    press(editor, "Enter");
    expect(editor.onSend).toHaveBeenCalledWith("#clau", undefined, undefined, undefined, undefined);

    pending.resolve({ models: [sonnet] });
    await pending.promise;
  });

  it("hides and rejects a stale completion click while the current query loads", async () => {
    const pending = deferred<{ models: SessionModel[] }>();
    vi.spyOn(api, "models")
      .mockResolvedValueOnce({ models: [sonnet] })
      .mockReturnValueOnce(pending.promise);
    const editor = await completionEditor("#cla");
    const staleChoice = editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.querySelector<HTMLButtonElement>("button");

    editor.view?.dispatch({ changes: { from: 4, insert: "u" }, selection: { anchor: 5 } });
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).not.toContain("#anthropic/claude-sonnet-4-5");
    staleChoice?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(editor.view?.state.doc.toString()).toBe("#clau");

    pending.resolve({ models: [sonnet] });
    await pending.promise;
  });

  it("refreshes completions when only the cursor moves", async () => {
    vi.spyOn(api, "models").mockResolvedValue({ models: [sonnet] });
    const editor = await completionEditor("#cla");

    editor.view?.dispatch({ selection: { anchor: 0 } });
    await editor.updateComplete;

    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).not.toContain("#anthropic/claude-sonnet-4-5");
  });

  it("keeps Escape from allowing a late completion response to reopen the menu", async () => {
    const pending = deferred<{ models: SessionModel[] }>();
    vi.spyOn(api, "models").mockReturnValue(pending.promise);
    const editor = await mount(undefined);
    editor.sessionId = "test-session";
    editor.cwd = "/repo";
    await editor.updateComplete;
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "#cla" }, selection: { anchor: 4 } });
    await vi.waitFor(() => { expect(api.models).toHaveBeenCalledOnce(); });

    press(editor, "Escape");
    pending.resolve({ models: [sonnet] });
    await pending.promise;
    await Promise.resolve();
    await Promise.resolve();
    await editor.updateComplete;

    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).not.toContain("#anthropic/claude-sonnet-4-5");
  });

  it("invalidates an in-flight completion request when the session changes", async () => {
    const pending = deferred<{ models: SessionModel[] }>();
    vi.spyOn(api, "models").mockReturnValue(pending.promise);
    const editor = await mount(undefined);
    editor.sessionId = "session-1";
    editor.cwd = "/repo";
    await editor.updateComplete;
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: "#cla" }, selection: { anchor: 4 } });
    saveDraft(machineSessionKey("local", "session-2"), "#cla");
    await vi.waitFor(() => { expect(api.models).toHaveBeenCalledOnce(); });

    editor.sessionId = "session-2";
    await editor.updateComplete;
    pending.resolve({ models: [sonnet] });
    await pending.promise;
    await Promise.resolve();
    await Promise.resolve();
    await editor.updateComplete;
    expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).not.toContain("#anthropic/claude-sonnet-4-5");
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
