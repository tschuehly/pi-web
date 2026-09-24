// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("PromptEditor command completions", () => {
  it("maps slash commands, including argument hints, to completion items", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([
      { name: "pr", source: "prompt", description: "Review PRs from URLs", argumentHint: "<PR-URL>" },
      { name: "tree", source: "builtin", description: "Navigate session tree" },
    ]);
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";

    await refreshCompletions(editor, "/");

    expect(currentCompletions(editor)).toEqual([
      { kind: "command", replaceFrom: 0, replaceTo: 1, insertText: "/pr", detail: "prompt", description: "Review PRs from URLs", argumentHint: "<PR-URL>" },
      { kind: "command", replaceFrom: 0, replaceTo: 1, insertText: "/tree", detail: "builtin", description: "Navigate session tree" },
    ]);
  });

  it("keeps all matching skills beyond twelve and still filters by name", async () => {
    const skills = Array.from({ length: 40 }, (_, index) => ({
      name: `skill:example-${String(index + 1).padStart(2, "0")}`,
      source: "skill" as const,
    }));
    vi.spyOn(api, "commands").mockResolvedValue([
      { name: "tree", source: "builtin" },
      ...skills,
    ]);
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";

    await refreshCompletions(editor, "/skill:");

    expect(currentCompletions(editor)).toEqual(skills.map((skill) => ({
      kind: "command", replaceFrom: 0, replaceTo: 7,
      insertText: `/${skill.name}`, detail: "skill",
    })));

    await refreshCompletions(editor, "/skill:example-40");

    expect(currentCompletions(editor)).toEqual([
      { kind: "command", replaceFrom: 0, replaceTo: 17, insertText: "/skill:example-40", detail: "skill" },
    ]);
  });

  it("offers only skills after an earlier directive, and ignores late responses for a changed token", async () => {
    let resolve!: (commands: Awaited<ReturnType<typeof api.commands>>) => void;
    vi.spyOn(api, "commands").mockReturnValue(new Promise((settle) => { resolve = settle; }));
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";
    const pending = refreshCompletions(editor, "/template task /skill:re");
    await refreshCompletions(editor, "/template task done");
    resolve([{ name: "review", source: "prompt" }, { name: "skill:review", source: "skill" }]);
    await pending;
    expect(currentCompletions(editor)).toEqual([]);

    await refreshCompletions(editor, "/skill:a /skill:re");
    expect(currentCompletions(editor)).toEqual([
      { kind: "command", replaceFrom: 9, replaceTo: 18, insertText: "/skill:review", detail: "skill" },
    ]);
  });

  it.each(["Tab", "Enter"])("keeps punctuation attached to the active skill with %s, including a mid-token cursor", async (key) => {
    vi.spyOn(api, "commands").mockResolvedValue([{ name: "skill:Re_View", source: "skill" }]);
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";
    document.body.append(editor);
    await editor.updateComplete;
    const draft = "ask /skill:old /skill:Re_V, now";
    editor.view?.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: draft }, selection: { anchor: draft.indexOf(",") + 1 } });
    await vi.waitFor(() => { expect(currentCompletions(editor)).toHaveLength(1); });
    editor.view?.dispatch({ selection: { anchor: draft.indexOf("Re_V") + 2 } });
    await vi.waitFor(() => { expect(currentCompletions(editor)).toHaveLength(1); });
    editor.view?.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(editor.view?.state.doc.toString()).toBe("ask /skill:old /skill:Re_View, now");
  });

  it("retains legacy loaded mixed-case and underscore skill names, not other inline commands", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([
      { name: "skill:Mixed_Case", source: "skill" }, { name: "template", source: "prompt" }, { name: "extension", source: "extension" },
    ]);
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";
    await refreshCompletions(editor, "ask /skill:mixed_");
    expect(currentCompletions(editor)).toEqual([{ kind: "command", replaceFrom: 4, replaceTo: 17, insertText: "/skill:Mixed_Case", detail: "skill" }]);
    await refreshCompletions(editor, "/ex");
    expect(currentCompletions(editor)).toEqual([{ kind: "command", replaceFrom: 0, replaceTo: 3, insertText: "/extension", detail: "extension" }]);
  });

  it("filters commands by the typed query", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([
      { name: "pr", source: "prompt", argumentHint: "<PR-URL>" },
      { name: "tree", source: "builtin" },
    ]);
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";

    await refreshCompletions(editor, "/t");

    expect(currentCompletions(editor)).toEqual([
      { kind: "command", replaceFrom: 0, replaceTo: 2, insertText: "/tree", detail: "builtin" },
    ]);
  });
});

// refreshCompletions is private and driven by CodeMirror updates in production;
// invoking it through Reflect mirrors the PromptEditor.draft.test.ts seam and
// keeps the wiring test at the component boundary without a DOM harness.
async function refreshCompletions(editor: PromptEditor, draft: string): Promise<void> {
  Reflect.set(editor, "draft", draft);
  const refresh: unknown = Reflect.get(editor, "refreshCompletions");
  if (!isRefreshCompletions(refresh)) throw new Error("PromptEditor.refreshCompletions is not callable");
  await refresh.call(editor);
}

function isRefreshCompletions(value: unknown): value is (this: PromptEditor) => Promise<void> {
  return typeof value === "function";
}

function currentCompletions(editor: PromptEditor): unknown {
  return Reflect.get(editor, "completions");
}
