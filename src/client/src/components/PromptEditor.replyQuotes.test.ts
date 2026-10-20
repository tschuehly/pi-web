// @vitest-environment happy-dom

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

const cache = { entryId: "m1", excerpt: "Use the cache" };
const tests = { entryId: "m2", excerpt: "Run the tests\nthen ship" };
const Q1 = "> [msg m1](#entry:m1) Use the cache";
const Q2 = "> [msg m2](#entry:m2) Run the tests\n> then ship";

async function mount(onSend?: PromptEditor["onSend"]): Promise<PromptEditor> {
  const editor = new PromptEditor();
  editor.sessionId = "session-1";
  if (onSend !== undefined) editor.onSend = onSend;
  document.body.append(editor);
  await editor.updateComplete;
  return editor;
}

function view(editor: PromptEditor) {
  if (editor.view === undefined) throw new Error("no editor view");
  return editor.view;
}

function toggles(editor: PromptEditor): HTMLElement[] {
  return Array.from(editor.shadowRoot?.querySelectorAll<HTMLElement>(".cm-reply-quote") ?? []);
}

describe("inline reply quotes", () => {
  it("inserts the quote as its own blockquote at the cursor and leaves the cursor on a fresh line after it", async () => {
    const editor = await mount();
    view(editor).dispatch({ changes: { from: 0, insert: "Intro" }, selection: EditorSelection.cursor(5) });

    editor.insertReplyQuote(cache);

    expect(view(editor).state.doc.toString()).toBe(`Intro\n\n${Q1}\n\n`);
    expect(view(editor).state.selection.main.head).toBe(view(editor).state.doc.length);
  });

  it("keeps several replies as separate blocks in text order, wherever the cursor is", async () => {
    const editor = await mount();
    editor.insertReplyQuote(cache);
    editor.insertReplyQuote(tests);
    expect(view(editor).state.doc.toString()).toBe(`${Q1}\n\n${Q2}\n\n`);

    view(editor).dispatch({ selection: EditorSelection.cursor(0) });
    editor.insertReplyQuote({ entryId: "m3", excerpt: "first" });
    expect(view(editor).state.doc.toString()).toBe(`> [msg m3](#entry:m3) first\n\n${Q1}\n\n${Q2}\n\n`);
  });

  it("shows each quote collapsed to one atomic line by default and toggles it on click and Enter", async () => {
    const editor = await mount();
    editor.insertReplyQuote(cache);
    editor.insertReplyQuote(tests);
    await editor.updateComplete;

    const [first, second] = toggles(editor);
    expect(first?.getAttribute("aria-expanded")).toBe("false");
    expect(first?.textContent).toContain("> Use the cache");
    expect(second?.textContent).toContain("> Run the tests then ship");
    expect(view(editor).contentDOM.textContent).not.toContain("[msg m2]");
    const atoms = view(editor).state.facet(EditorView.atomicRanges).map((source) => source(view(editor)));
    const spans: [number, number][] = [];
    for (const set of atoms) set.between(0, view(editor).state.doc.length, (from, to) => { spans.push([from, to]); });
    expect(spans).toEqual([[0, Q1.length], [Q1.length + 2, Q1.length + 2 + Q2.length]]);

    second?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view(editor).contentDOM.textContent).toContain("[msg m2](#entry:m2) Run the tests");
    const open = toggles(editor).find((toggle) => toggle.getAttribute("aria-expanded") === "true");
    expect(open).toBeDefined();
    open?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(view(editor).contentDOM.textContent).not.toContain("[msg m2]");

    view(editor).dispatch({ selection: EditorSelection.cursor(Q1.length) });
    view(editor).contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(view(editor).contentDOM.textContent).toContain("[msg m1](#entry:m1) Use the cache");
    expect(view(editor).state.doc.toString()).toBe(`${Q1}\n\n${Q2}\n\n`);
  });

  it("sends the blockquotes as part of the text, with no separate quote context", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    const editor = await mount(onSend);
    editor.insertReplyQuote(cache);
    editor.insertReplyQuote(tests);
    view(editor).dispatch({ changes: { from: view(editor).state.doc.length, insert: "Why?" } });

    editor.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();

    expect(onSend).toHaveBeenCalledWith(`${Q1}\n\n${Q2}\n\nWhy?`, undefined, undefined, undefined, undefined);
  });

  it("keeps quotes in the draft across a reload, collapsed again", async () => {
    const first = await mount();
    first.insertReplyQuote(cache);
    first.remove();

    const reloaded = await mount();
    await reloaded.updateComplete;

    expect(view(reloaded).state.doc.toString()).toBe(`${Q1}\n\n`);
    expect(toggles(reloaded).map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false"]);
  });
});

