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

  it("puts text typed right after a collapsed quote on its own paragraph, visible and outside the quote", async () => {
    const editor = await mount();
    const long = { entryId: "m9", excerpt: "A quoted sentence that is clearly longer than the sixty character label" };
    const quote = "> [msg m9](#entry:m9) A quoted sentence that is clearly longer than the sixty character label";
    editor.insertReplyQuote(long);
    view(editor).dispatch({ selection: EditorSelection.cursor(quote.length) });

    view(editor).dispatch({ changes: { from: quote.length, insert: "W" }, selection: EditorSelection.cursor(quote.length + 1), userEvent: "input.type" });
    view(editor).dispatch({ changes: { from: view(editor).state.selection.main.head, insert: "hy?" }, selection: EditorSelection.cursor(view(editor).state.selection.main.head + 3), userEvent: "input.type" });

    expect(view(editor).state.doc.toString()).toBe(`${quote}\n\nWhy?\n\n`);
    expect(view(editor).state.selection.main.head).toBe(quote.length + 6);
    expect(view(editor).contentDOM.textContent).toContain("Why?");
    expect(toggles(editor).map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false"]);

    view(editor).dispatch({ changes: { from: 0, insert: "Hi" }, selection: EditorSelection.cursor(2), userEvent: "input.type" });
    expect(view(editor).state.doc.toString()).toBe(`Hi\n\n${quote}\n\nWhy?\n\n`);
    expect(view(editor).state.selection.main.head).toBe(2);
  });

  it("expands a collapsed quote when any other edit changes its text", async () => {
    const editor = await mount();
    editor.insertReplyQuote(cache);

    view(editor).dispatch({ changes: { from: Q1.length, insert: " tail" } });

    expect(view(editor).contentDOM.textContent).toContain("Use the cache tail");
    expect(toggles(editor).map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["true"]);
  });

  it("keeps image placeholders inside quotes when sending without attachments and across a reload", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    const first = await mount();
    first.insertReplyQuote({ entryId: "m4", excerpt: "Compare [PIC_1] with [PIC_2]" });
    view(first).dispatch({ changes: { from: view(first).state.doc.length, insert: "See [PIC_3]" } });
    first.remove();

    const reloaded = await mount(onSend);
    const quote = "> [msg m4](#entry:m4) Compare [PIC_1] with [PIC_2]";
    expect(view(reloaded).state.doc.toString()).toBe(`${quote}\n\nSee`);
    reloaded.shadowRoot?.querySelector<HTMLButtonElement>(".send-button")?.click();
    expect(onSend).toHaveBeenCalledWith(`${quote}\n\nSee`, undefined, undefined, undefined, undefined);
  });

  it("restores the caret at the end of a reloaded draft so Enter sends instead of expanding a quote", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    const first = await mount();
    first.insertReplyQuote(cache);
    view(first).dispatch({ changes: { from: view(first).state.doc.length, insert: "Why?" } });
    first.remove();

    const reloaded = await mount(onSend);
    expect(view(reloaded).state.selection.main.head).toBe(view(reloaded).state.doc.length);
    view(reloaded).contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(onSend).toHaveBeenCalledWith(`${Q1}\n\nWhy?`, undefined, undefined, undefined, undefined);
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

