// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

async function mount(dense: boolean, showUsage: boolean): Promise<ShadowRoot> {
  const editor = new PromptEditor();
  editor.dense = dense;
  editor.showUsage = showUsage;
  document.body.append(editor);
  await editor.updateComplete;
  if (editor.shadowRoot === null) throw new Error("no shadow root");
  return editor.shadowRoot;
}

describe("dense composer", () => {
  it("puts the input and its send controls on one row, and drops the meta row without usage", async () => {
    const root = await mount(true, false);

    expect(root.querySelector(".input-row > .editor-wrap + .composer-actions .send-button")).not.toBeNull();
    expect(root.querySelector(".actions")).toBeNull();
    expect(root.querySelector(".cm-placeholder")?.textContent).toBe("Message…");
  });

  it("keeps a meta row with usage, and the regular composer otherwise", async () => {
    expect((await mount(true, true)).querySelector(".input-row + .actions working-mode-controls")).not.toBeNull();
    const regular = await mount(false, true);
    expect(regular.querySelector(".input-row > .composer-actions")).toBeNull();
    expect(regular.querySelector("footer > .input-row > .editor-wrap")).not.toBeNull();
    expect(regular.querySelector("footer > .input-row + .actions > .composer-actions .send-button")).not.toBeNull();
  });
});

describe("dense toggle", () => {
  it("keeps the live editor and its draft when the layout switches between dense and regular", async () => {
    const editor = new PromptEditor();
    editor.dense = true;
    document.body.append(editor);
    await editor.updateComplete;
    const view = editor.view;
    if (view === undefined) throw new Error("no editor view");
    view.dispatch({ changes: { from: 0, insert: "draft" } });

    editor.dense = false;
    await editor.updateComplete;

    const root = editor.shadowRoot;
    expect(root?.querySelector(".markdown-editor .cm-editor")).toBe(view.dom);
    expect(editor.view?.state.doc.toString()).toBe("draft");
    expect(root?.querySelector(".cm-placeholder")?.textContent).not.toBe("Message…");
  });
});
