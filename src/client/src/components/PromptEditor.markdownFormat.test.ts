// @vitest-environment happy-dom

import { highlightingFor } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { PromptEditor } from "./PromptEditor";
import { filesHighlighting } from "./workbenchFilesEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

const DRAFT = "# Plan\n\n- use `cache`\n\n```ts\nconst ready = true;\n```\n\nShip /skill:rev";

/** The class the Files editor's highlight style gives a tag. */
function filesClass(tag: Parameters<typeof highlightingFor>[1][number]): string {
  const cls = highlightingFor(EditorState.create({ extensions: filesHighlighting }), [tag]);
  if (cls === null) throw new Error("tag not highlighted by the Files editor");
  return cls;
}

describe("composer Markdown formatting", () => {
  it("highlights headings and fenced code like the Files editor, and still completes and sends", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([{ name: "skill:review", source: "skill" }]);
    const onSend = vi.fn(() => Promise.resolve(true));
    const view = await mount(onSend);

    view.dispatch({ changes: { from: 0, insert: DRAFT }, selection: { anchor: DRAFT.length } });

    const text = (cls: string) => Array.from(view.contentDOM.querySelectorAll(`.${cls.split(" ")[0] ?? ""}`), (span) => span.textContent).join("|");
    expect(text(filesClass(tags.heading))).toBe("#| Plan");
    expect(text(filesClass(tags.keyword))).toContain("const");
    expect(text(filesClass(tags.bool))).toContain("true");

    await vi.waitFor(() => { expect(menuText()).toContain("/skill:review"); });
    enter(view);
    expect(view.state.doc.toString()).toBe(`${DRAFT}iew `);

    enter(view);
    expect(onSend).toHaveBeenCalledWith(`${DRAFT}iew`, undefined, undefined, undefined, undefined);
  });

  it("types @ and # as plain text, so a # heading sends as written", async () => {
    const models = vi.spyOn(api, "models").mockResolvedValue({ models: [] });
    const onSend = vi.fn(() => Promise.resolve(true));
    const view = await mount(onSend);

    for (const text of ["#", " Title\n\nsee @src and #claude"]) view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(models).not.toHaveBeenCalled();
    expect(menuText()).toBe("");
    enter(view);
    expect(onSend).toHaveBeenCalledWith("# Title\n\nsee @src and #claude", undefined, undefined, undefined, undefined);
  });
});

async function mount(onSend: NonNullable<PromptEditor["onSend"]>) {
  const editor = new PromptEditor();
  editor.sessionId = "session-1";
  editor.cwd = "/repo";
  editor.onSend = onSend;
  document.body.append(editor);
  await editor.updateComplete;
  if (editor.view === undefined) throw new Error("no editor view");
  return editor.view;
}

function menuText(): string {
  return (document.querySelector("prompt-editor")?.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent ?? "").trim();
}

function enter(view: EditorView): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}
