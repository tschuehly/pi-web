// @vitest-environment happy-dom

import { highlightingFor } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
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

const DRAFT = "# Plan\n\n- use `cache`\n\n```ts\nconst ready = true;\n```\n\nShip /skill:review @src";

/** The class the Files editor's highlight style gives a tag. */
function filesClass(tag: Parameters<typeof highlightingFor>[1][number]): string {
  const cls = highlightingFor(EditorState.create({ extensions: filesHighlighting }), [tag]);
  if (cls === null) throw new Error("tag not highlighted by the Files editor");
  return cls;
}

describe("composer Markdown formatting", () => {
  it("highlights headings and fenced code like the Files editor, and still completes and sends", async () => {
    vi.spyOn(api, "files").mockResolvedValue([{ path: "src/main.ts", kind: "tracked" }]);
    const onSend = vi.fn(() => Promise.resolve(true));
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.projectId = "project-1";
    editor.workspaceId = "workspace-1";
    editor.onSend = onSend;
    document.body.append(editor);
    await editor.updateComplete;
    const view = editor.view;
    if (view === undefined) throw new Error("no editor view");

    view.dispatch({ changes: { from: 0, insert: DRAFT }, selection: { anchor: DRAFT.length } });

    const text = (cls: string) => Array.from(view.contentDOM.querySelectorAll(`.${cls.split(" ")[0] ?? ""}`), (span) => span.textContent).join("|");
    expect(text(filesClass(tags.heading))).toBe("#| Plan");
    expect(text(filesClass(tags.keyword))).toContain("const");
    expect(text(filesClass(tags.bool))).toContain("true");

    await vi.waitFor(() => { expect(editor.shadowRoot?.querySelector("autocomplete-menu")?.shadowRoot?.textContent).toContain("src/main.ts"); });
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe(`${DRAFT.slice(0, -"@src".length)}@src/main.ts `);

    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onSend).toHaveBeenCalledWith(`${DRAFT.slice(0, -"@src".length)}@src/main.ts`, undefined, undefined, undefined, undefined);
  });
});
