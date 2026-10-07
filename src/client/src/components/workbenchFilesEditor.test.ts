// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { highlightingFor } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { undo } from "@codemirror/commands";
import { applyDiskChange, diskChangeSpec, editHistory, filesHighlighting, hunkActionSpec, hunkField, lineChunks, lineRangeHighlight, lineRangeSpec, livePreview, wordChanges } from "./workbenchFilesEditor";

const slices = (a: string, b: string) => wordChanges(a, b)?.map((w) => [a.slice(w.oF, w.oT), b.slice(w.nF, w.nT)]) ?? null;

describe("wordChanges", () => {
  it("keeps a small replacement inline, snapped to whole words", () => {
    expect(slices("Ship the release on Friday.", "Ship the release on Monday.")).toEqual([["Friday", "Monday"]]);
    expect(slices("the quick brown fox jumps over the lazy dog", "the quick red fox jumps over the lazy dog")).toEqual([["brown", "red"]]);
  });

  it("keeps a pure append inline however long", () => {
    const a = "Short.";
    const b = "Short. Confirm the numbers with Thomas first, then publish the release notes.";
    expect(slices(a, b)).toEqual([["", b.slice(a.length)]]);
  });

  it("returns null when much of the text is replaced", () => {
    expect(wordChanges("alpha beta gamma", "one two three")).toBeNull();
    expect(wordChanges("line one\nline two", "line one\nsomething\nelse")).toBeNull();
  });
});

describe("lineChunks", () => {
  it("merges several character chunks on one line and keeps the later end", () => {
    const a = "keep\nthe cat sat on the mat\nkeep";
    const b = "keep\nthe dog sat on the rug\nkeep";
    const chunks = lineChunks(a, b);
    expect(chunks).toHaveLength(1);
    const [c] = chunks;
    expect(c && a.slice(c.fA, c.tA)).toBe("the cat sat on the mat");
    expect(c && b.slice(c.fB, c.tB)).toBe("the dog sat on the rug");
  });

  it("ends a merged chunk where the later chunk ends when it reaches into the next line", () => {
    const a = "keep\nthe cat sat y\nz end\nkeep";
    const b = "keep\nthe dog sat Q end\nkeep";
    const chunks = lineChunks(a, b);
    expect(chunks.map((c) => [a.slice(c.fA, c.tA), b.slice(c.fB, c.tB)])).toEqual([["the cat sat y\nz end", "the dog sat Q end"]]);
  });
});

describe("agent hunks", () => {
  const base = "# Title\n\nFirst paragraph stays.\n\nThe launch is on Friday.\n";
  const apply = (state: EditorState, from: string, to: string) => state.update(diskChangeSpec(state, from, to).spec).state;
  const fresh = () => EditorState.create({ doc: base, extensions: [hunkField] });

  it("merges repeated agent edits on the same lines into one hunk whose old text is the original", () => {
    const once = base.replace("Friday", "Monday");
    const twice = once.replace("Monday", "Tuesday");
    let state = apply(fresh(), base, once);
    expect(state.field(hunkField)).toHaveLength(1);
    state = apply(state, once, twice);
    const hunks = state.field(hunkField);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.old).toBe("Friday");
    expect(state.doc.sliceString(hunks[0]?.from ?? 0, hunks[0]?.to ?? 0)).toBe("Tuesday");
    const reject = hunkActionSpec(state, hunks[0]?.id ?? -1, "reject");
    if (!reject) throw new Error("Missing hunk");
    state = state.update(reject).state;
    expect(state.doc.toString()).toBe(base);
    expect(state.field(hunkField)).toHaveLength(0);
  });

  it("shows a substantial change as a line hunk and flags overlap with unsaved edits", () => {
    let state = fresh();
    state = state.update({ changes: { from: base.indexOf("Friday"), to: base.indexOf("Friday") + 6, insert: "Saturday" } }).state;
    const disk = base.replace("The launch is on Friday.", "Everything about the plan changed completely.");
    const { spec, overlaps } = diskChangeSpec(state, base, disk);
    expect(overlaps).toBe(true);
    state = state.update(spec).state;
    expect(state.doc.toString()).toBe(disk);
    const [hunk] = state.field(hunkField);
    expect(hunk?.inline).toBe(false);
    expect(hunk?.old).toContain("Saturday");
    const merge = hunkActionSpec(state, hunk?.id ?? -1, "merge");
    if (!merge) throw new Error("Missing hunk");
    state = state.update(merge).state;
    expect(state.doc.toString()).toContain("Everything about the plan changed completely.\nThe launch is on Saturday.");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toContain("Saturday");
  });

  const rejectAll = (start: EditorState) => {
    let state = start;
    for (const h of [...state.field(hunkField)].sort((a, b) => b.from - a.from)) {
      const spec = hunkActionSpec(state, h.id, "reject");
      if (spec) state = state.update(spec).state;
    }
    return state;
  };

  it("applies disk chunks that land on the same local edit once, so Reject all restores the edit once", () => {
    let state = EditorState.create({ doc: "X", extensions: [hunkField] }); // base "a\nb", the user replaced it with "X"
    state = apply(state, "a\nb", "\n");
    expect(state.doc.toString()).toBe("\n");
    expect(rejectAll(state).doc.toString()).toBe("X");
  });

  it("merges incoming regions that an absorbed hunk joins, so Reject all restores the original", () => {
    let state = EditorState.create({ doc: "", extensions: [hunkField] });
    state = apply(state, "", "alpha\nbeta");
    state = apply(state, "alpha\nbeta", "\n");
    expect(state.doc.toString()).toBe("\n");
    expect(rejectAll(state).doc.toString()).toBe("");
  });

  it("never undoes into a mix of the user's and the agent's text after an overlapping agent edit", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: "Friday", extensions: [hunkField, editHistory()] }) });
    view.dispatch({ changes: { from: 0, to: 6, insert: "Saturday" } });
    expect(applyDiskChange(view, "Friday", "Monday")).toBe(true);
    expect(view.state.doc.toString()).toBe("Monday");
    undo(view);
    expect(["Monday", "Saturday", "Friday"]).toContain(view.state.doc.toString());
    view.destroy();
  });
});

describe("live preview and line ranges", () => {
  it("renders a document with tables, lists, tasks and code without throwing", () => {
    const doc = "# Plan\n\n- [ ] open\n- [x] done\n  - nested *item* with `code`\n1. first\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n> quote\n\n---\n\n![img](a.png) [link](b.md)\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), livePreview((md) => `<table><tr><td>${md.length.toString()}</td></tr></table>`, () => undefined), lineRangeHighlight] }) });
    expect(view.contentDOM.querySelector(".lp-table")).not.toBeNull();
    expect(view.contentDOM.querySelectorAll(".lp-check")).toHaveLength(2);
    view.dispatch(lineRangeSpec(view.state, 3, 4));
    expect(view.contentDOM.querySelectorAll(".cm-range")).toHaveLength(2);
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(view.contentDOM.querySelectorAll(".cm-range")).toHaveLength(0);
    view.destroy();
  });
});

describe("editor controls", () => {
  const mountView = (doc: string, extensions: Extension, anchor = doc.length) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    return new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor }, extensions }) });
  };
  const mousedown = (target: Element | null, init: MouseEventInit = {}) => target?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));

  it("toggles a task checkbox on click (also keyboard activation), not on mousedown alone", () => {
    const view = mountView("- [ ] open\n", [markdown({ base: markdownLanguage }), livePreview(() => "", () => undefined)]);
    mousedown(view.contentDOM.querySelector(".lp-check"));
    expect(view.state.doc.toString()).toBe("- [ ] open\n");
    view.contentDOM.querySelector<HTMLInputElement>(".lp-check")?.click();
    expect(view.state.doc.toString()).toBe("- [x] open\n");
    view.destroy();
  });

  it("runs hunk buttons on click (also keyboard activation), not on mousedown alone", () => {
    const view = mountView("The launch is on Friday.", [hunkField]);
    view.dispatch(diskChangeSpec(view.state, "The launch is on Friday.", "The launch is on Monday.").spec);
    mousedown(view.contentDOM.querySelector(".hunk-btn.reject"));
    expect(view.state.doc.toString()).toBe("The launch is on Monday.");
    view.contentDOM.querySelector<HTMLButtonElement>(".hunk-btn.reject")?.click();
    expect(view.state.doc.toString()).toBe("The launch is on Friday.");
    view.destroy();
  });

  it("opens a rendered link on click, and on ⌘/Ctrl-click while the cursor is inside it", () => {
    const opened: (string | null)[] = [];
    const render = (md: string) => `<p><a href="${/\]\((.*)\)/.exec(md)?.[1] ?? ""}">x</a></p>`;
    const doc = "See [notes](docs/b.md:4) and [site](https://example.com).";
    const view = mountView(doc, [markdown({ base: markdownLanguage }), livePreview(render, (a) => { opened.push(a.getAttribute("href")); })]);
    const links = () => view.contentDOM.querySelectorAll(".lp-link");
    mousedown(links()[0] ?? null);
    mousedown(links()[1] ?? null);
    expect(opened).toEqual(["docs/b.md:4", "https://example.com"]);
    view.dispatch({ selection: { anchor: doc.indexOf("notes") } });
    mousedown(links()[0] ?? null);
    expect(opened).toHaveLength(2); // editing the link text
    mousedown(links()[0] ?? null, { metaKey: true });
    expect(opened.at(-1)).toBe("docs/b.md:4");
    view.destroy();
  });

  it("colors code tokens even with prose styles on", () => {
    const state = EditorState.create({ extensions: [filesHighlighting] });
    for (const tag of [tags.keyword, tags.string, tags.comment, tags.number, tags.typeName, tags.heading]) expect(highlightingFor(state, [tag])).toBeTruthy();
  });
});
