// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { diskChangeSpec, hunkActionSpec, hunkField, lineChunks, lineRangeHighlight, lineRangeSpec, livePreview, wordChanges } from "./workbenchFilesEditor";

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
});

describe("live preview and line ranges", () => {
  it("renders a document with tables, lists, tasks and code without throwing", () => {
    const doc = "# Plan\n\n- [ ] open\n- [x] done\n  - nested *item* with `code`\n1. first\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n> quote\n\n---\n\n![img](a.png) [link](b.md)\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), livePreview((md) => `<table><tr><td>${md.length.toString()}</td></tr></table>`), lineRangeHighlight] }) });
    expect(view.contentDOM.querySelector(".lp-table")).not.toBeNull();
    expect(view.contentDOM.querySelectorAll(".lp-check")).toHaveLength(2);
    view.dispatch(lineRangeSpec(view.state, 3, 4));
    expect(view.contentDOM.querySelectorAll(".cm-range")).toHaveLength(2);
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(view.contentDOM.querySelectorAll(".cm-range")).toHaveLength(0);
    view.destroy();
  });
});
