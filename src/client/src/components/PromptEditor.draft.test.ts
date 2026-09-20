import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { machineSessionKey } from "../machineKeys";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { PromptEditor } from "./PromptEditor";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
});

describe("PromptEditor draft replacement", () => {
  it("replaces durable and CodeMirror text, moves the cursor, and resets completion state", () => {
    const editor = new PromptEditor();
    editor.machineId = "remote-a";
    editor.sessionId = "session-1";
    const dispatch = vi.fn<(transaction: unknown) => void>();
    Reflect.set(editor, "draft", "/old");
    Reflect.set(editor, "currentInputMode", { kind: "command" });
    Reflect.set(editor, "completions", [{ kind: "command", insertText: "/tree", replaceFrom: 0, replaceTo: 4 }]);
    Reflect.set(editor, "selectedIndex", 3);
    Reflect.set(editor, "requestVersion", 7);
    Reflect.set(editor, "editor", {
      state: { doc: { toString: () => "/old" } },
      dispatch,
    });

    editor.replaceText("!pwd");

    expect(Reflect.get(editor, "draft")).toBe("!pwd");
    expect(loadDraft(machineSessionKey("remote-a", "session-1"))).toBe("!pwd");
    expect(Reflect.get(editor, "currentInputMode")).toEqual({ kind: "shell", excludeFromContext: false });
    expect(Reflect.get(editor, "completions")).toEqual([]);
    expect(Reflect.get(editor, "selectedIndex")).toBe(0);
    expect(Reflect.get(editor, "requestVersion")).toBe(8);
    expect(dispatch).toHaveBeenCalledOnce();
    const transaction = dispatch.mock.calls[0]?.[0];
    if (!isRecord(transaction) || !isRecord(transaction["selection"])) throw new Error("Expected a CodeMirror replacement transaction");
    expect(transaction["changes"]).toEqual({ from: 0, to: 4, insert: "!pwd" });
    expect(transaction["selection"]["anchor"]).toBe(4);
    expect(transaction["selection"]["head"]).toBe(4);
  });

  it("routes plain Enter to steering and Command/Ctrl+Enter to a follow-up while a response is active", () => {
    const editor = new PromptEditor();
    const onSend = vi.fn();
    editor.canSteer = true;
    editor.onSend = onSend;
    const handleEditorKeyDown: unknown = Reflect.get(editor, "handleEditorKeyDown");
    if (!isEditorKeyDownHandler(handleEditorKeyDown)) throw new Error("Expected PromptEditor keydown handler");

    Reflect.set(editor, "draft", "Adjust the implementation");
    expect(handleEditorKeyDown.call(editor, enterEvent(), { composing: false })).toBe(true);
    expect(onSend).toHaveBeenLastCalledWith("Adjust the implementation", "steer", undefined, undefined, undefined);

    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      Reflect.set(editor, "draft", "Then summarize");
      expect(handleEditorKeyDown.call(editor, enterEvent(modifier), { composing: false })).toBe(true);
      expect(onSend).toHaveBeenLastCalledWith("Then summarize", "followUp", undefined, undefined, undefined);
    }
  });

  it("prepends restored text to an existing durable draft with a blank-line separator", () => {
    const editor = new PromptEditor();
    editor.machineId = "local";
    editor.sessionId = "session-2";
    Reflect.set(editor, "draft", "Unsent draft");

    editor.prependText("First queued\n\nSecond queued");

    expect(Reflect.get(editor, "draft")).toBe("First queued\n\nSecond queued\n\nUnsent draft");
    expect(loadDraft(machineSessionKey("local", "session-2"))).toBe("First queued\n\nSecond queued\n\nUnsent draft");
  });

  it("clears an existing durable draft and CodeMirror document", () => {
    const editor = new PromptEditor();
    editor.machineId = "local";
    editor.sessionId = "session-2";
    const key = machineSessionKey("local", "session-2");
    const dispatch = vi.fn<(transaction: unknown) => void>();
    Reflect.set(editor, "draft", "stale text");
    Reflect.set(editor, "editor", {
      state: { doc: { toString: () => "stale text" } },
      dispatch,
    });
    saveDraft(key, "stale text");

    editor.replaceText("");

    expect(loadDraft(key)).toBe("");
    const transaction = dispatch.mock.calls[0]?.[0];
    if (!isRecord(transaction) || !isRecord(transaction["selection"])) throw new Error("Expected a CodeMirror clearing transaction");
    expect(transaction["changes"]).toEqual({ from: 0, to: 10, insert: "" });
    expect(transaction["selection"]["anchor"]).toBe(0);
    expect(transaction["selection"]["head"]).toBe(0);
    expect(Reflect.get(editor, "currentInputMode")).toEqual({ kind: "normal" });
  });
});

function enterEvent(overrides: Partial<KeyboardEvent> = {}): Partial<KeyboardEvent> {
  return { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, ...overrides };
}

function isEditorKeyDownHandler(value: unknown): value is (event: Partial<KeyboardEvent>, view: { composing: boolean }) => boolean {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
