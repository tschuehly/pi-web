// CodeMirror pieces of the Files pane: Markdown live preview, inline agent hunks, highlighted line ranges.
import { ChangeSet, StateEffect, StateField, Text, Transaction, type EditorState, type Extension, type Range, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { diff } from "@codemirror/merge";
import { HighlightStyle, LanguageSupport, StreamLanguage, syntaxTree } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { tags } from "@lezer/highlight";

const sh = new LanguageSupport(StreamLanguage.define(shell));
const yml = new LanguageSupport(StreamLanguage.define(yaml));
const js = javascript(), jsx = javascript({ jsx: true }), ts = javascript({ typescript: true }), tsx = javascript({ typescript: true, jsx: true });
const py = python(), jsonLang = json(), cssLang = css(), htmlLang = html(), rs = rust(), golang = go();
const languages: Record<string, LanguageSupport> = {
  js, mjs: js, cjs: js, jsx, javascript: js, ts, mts: ts, cts: ts, typescript: ts, tsx,
  py: py, python: py, json: jsonLang, jsonl: jsonLang, jsonc: jsonLang, css: cssLang, html: htmlLang, htm: htmlLang,
  rs, rust: rs, go: golang, sh, bash: sh, zsh: sh, shell: sh, yml, yaml: yml,
};

/** Syntax support for a file extension or a fenced-code info string. */
export function languageFor(name: string | undefined): LanguageSupport | undefined {
  return name === undefined ? undefined : languages[name.trim().toLowerCase()];
}

// ---------------- live preview ----------------
class Widget extends WidgetType {
  constructor(readonly key: string, readonly build: (view: EditorView) => HTMLElement) { super(); }
  override eq(other: Widget): boolean { return other.key === this.key; }
  toDOM(view: EditorView): HTMLElement { return this.build(view); }
  override ignoreEvent(): boolean { return false; }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const bullet = (depth: number) => new Widget(`b${String(depth)}`, () => el("span", "lp-marker lp-bullet", depth % 2 === 1 ? "◦" : "•"));
const rule = new Widget("hr", () => el("span", "lp-hr"));
const checkbox = (checked: boolean) => new Widget(`cb${String(checked)}`, (view) => {
  const wrap = el("span", "lp-marker");
  const box = document.createElement("input");
  box.className = "lp-check";
  box.type = "checkbox";
  box.checked = checked;
  box.setAttribute("aria-label", checked ? "Done" : "Not done");
  wrap.append(box);
  box.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const pos = view.posAtDOM(wrap);
    const match = /\[( |x|X)\]/.exec(view.state.doc.sliceString(pos, pos + 8));
    if (match) view.dispatch({ changes: { from: pos + match.index + 1, to: pos + match.index + 2, insert: checked ? " " : "x" } });
  });
  return wrap;
});
/** `render` turns Markdown into sanitized HTML (tables and images only). */
const rendered = (kind: "tbl" | "img", source: string, render: (markdown: string) => string) => new Widget(kind + source, (view) => {
  const box = el(kind === "tbl" ? "div" : "span", kind === "tbl" ? "lp-table" : "lp-img");
  box.innerHTML = render(source);
  box.addEventListener("mousedown", (event) => {
    if (event.target instanceof Element && event.target.closest("a") !== null) return;
    event.preventDefault();
    view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
    view.focus();
  });
  return box;
});

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];
const LIST_NAMES = new Set(["BulletList", "OrderedList"]);
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark", "LinkMark", "URL", "LinkTitle"]);

// ponytail: rebuilds over the whole doc per transaction; split into a visibleRanges ViewPlugin + block field for huge files.
function buildPreview(state: EditorState, render: (markdown: string) => string): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const doc = state.doc;
  const sel = state.selection.ranges;
  const touched = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (from: number, to: number) => touched(doc.lineAt(from).from, doc.lineAt(to).to);
  const hide = (from: number, to: number) => { if (from < to) deco.push(Decoration.replace({}).range(from, to)); };
  const afterSpace = (pos: number) => doc.sliceString(pos, pos + 1) === " " ? pos + 1 : pos;
  const lines = (from: number, to: number, cls: string) => {
    for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
      deco.push(Decoration.line({ class: cls }).range(line.from));
      if (line.to >= to || line.number === doc.lines) break;
    }
  };
  const listDepth = (node: SyntaxNode | null) => {
    let depth = -1;
    for (let n = node; n !== null; n = n.parent) if (LIST_NAMES.has(n.name)) depth++;
    return depth;
  };
  const tree = syntaxTree(state);
  tree.iterate({
    enter(n) {
      const { name, from, to } = n;
      const parent = n.node.parent;
      const heading = /^ATXHeading(\d)$/.exec(name);
      if (heading) { lines(from, to, `lp-h lp-h${heading[1] ?? "1"}`); return; }
      switch (name) {
        case "HeaderMark":
        case "QuoteMark":
          if (!lineTouched(from, to)) hide(from, afterSpace(to));
          return;
        case "Emphasis": case "StrongEmphasis": case "Strikethrough": case "InlineCode": case "Link": {
          if (name === "InlineCode") deco.push(Decoration.mark({ class: "lp-inline-code" }).range(from, to));
          if (name === "Link") deco.push(Decoration.mark({ class: "lp-link" }).range(from, to));
          if (touched(from, to)) return;
          for (let child = n.node.firstChild; child !== null; child = child.nextSibling) if (INLINE_MARKS.has(child.name)) hide(child.from, child.to);
          return;
        }
        case "Image":
          if (!touched(from, to)) deco.push(Decoration.replace({ widget: rendered("img", doc.sliceString(from, to), render) }).range(from, to));
          return false;
        case "Blockquote": lines(from, to, "lp-quote"); return;
        case "FencedCode": {
          lines(from, to, "lp-code");
          const first = doc.lineAt(from), last = doc.lineAt(to);
          deco.push(Decoration.line({ class: "lp-code-first" }).range(first.from));
          deco.push(Decoration.line({ class: "lp-code-last" }).range(last.from));
          if (!touched(from, to)) {
            deco.push(Decoration.mark({ class: "lp-fence" }).range(first.from, first.to));
            if (last.number !== first.number) deco.push(Decoration.mark({ class: "lp-fence" }).range(last.from, last.to));
          }
          return;
        }
        case "ListItem": {
          // Hanging indent: hide leading spaces, indent via padding so wrapped lines align with the text.
          const depth = listDepth(n.node);
          const line = doc.lineAt(from);
          const style = `--depth:${String(depth)}`;
          if (doc.sliceString(line.from, from).trim() === "") hide(line.from, from);
          deco.push(Decoration.line({ class: "lp-li", attributes: { style } }).range(line.from));
          // continuation lines of the same item (soft-wrapped in source) get the same text column
          for (let number = line.number + 1; number <= doc.lineAt(to).number; number++) {
            const cont = doc.line(number);
            const lead = /^\s*/.exec(cont.text)?.[0].length ?? 0;
            if (cont.text.trim() === "") continue;
            let owner: SyntaxNode | null = tree.resolveInner(cont.from + lead, 1);
            while (owner !== null && owner.name !== "ListItem") owner = owner.parent;
            if (owner?.from !== from) continue;
            hide(cont.from, cont.from + lead);
            deco.push(Decoration.line({ class: "lp-li lp-li-cont", attributes: { style } }).range(cont.from));
          }
          return;
        }
        case "ListMark": {
          const marker = parent?.getChild("Task")?.getChild("TaskMarker");
          if (marker) {
            if (touched(from, marker.to)) return;
            const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
            const end = afterSpace(marker.to);
            deco.push(Decoration.replace({ widget: checkbox(checked) }).range(from, end));
            if (checked && end < doc.lineAt(end).to) deco.push(Decoration.mark({ class: "lp-done" }).range(end, doc.lineAt(end).to));
          } else if (parent?.parent?.name === "BulletList" && !touched(from, to)) {
            deco.push(Decoration.replace({ widget: bullet(listDepth(parent)) }).range(from, afterSpace(to)));
          } else if (parent?.parent?.name === "OrderedList") {
            deco.push(Decoration.mark({ class: "lp-marker lp-num" }).range(from, afterSpace(to)));
          }
          return;
        }
        case "HorizontalRule":
          if (!lineTouched(from, to)) deco.push(Decoration.replace({ widget: rule }).range(from, to));
          return;
        case "Table":
          if (touched(from, to)) { lines(from, to, "lp-table-src"); return false; }
          deco.push(Decoration.replace({ widget: rendered("tbl", doc.sliceString(from, to), render), block: true }).range(from, to));
          return false;
        default:
          return;
      }
    },
  });
  return Decoration.set(deco, true);
}

export const proseHighlight = HighlightStyle.define([
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.heading, fontWeight: "650" },
  { tag: [tags.processingInstruction, tags.meta, tags.url], color: "var(--pi-muted)" },
]);

/** Obsidian-style live preview: markup hides unless the cursor is inside its element. */
export function livePreview(render: (markdown: string) => string): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => buildPreview(state, render),
    update: (value, tr) => tr.docChanged || tr.selection !== undefined || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? buildPreview(tr.state, render) : value,
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field, EditorView.contentAttributes.of({ class: "lp-on" })];
}

// ---------------- agent hunks: inline diff of what the agent changed on disk ----------------
/** A range in the doc holding the agent's text, plus the text it replaced. */
export interface Hunk { id: number; from: number; to: number; old: string; overlaps: boolean; inline: boolean }
interface IncomingHunk { sFrom: number; sTo: number; overlaps: boolean }
export type HunkAction = "approve" | "reject" | "merge";

const addHunks = StateEffect.define<IncomingHunk[]>();
const dropHunk = StateEffect.define<number>();
const dropAllHunks = StateEffect.define();
let hunkSeq = 0;

// Lucide check, x and pencil.
const HUNK_ICONS: Record<HunkAction, string> = {
  approve: '<path d="M20 6 9 17l-5-5"/>',
  reject: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  merge: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
};

function hunkButtons(view: EditorView, id: number, compact: boolean): HTMLElement {
  const bar = el("span", compact ? "hunk-inline-btns" : "hunk-btns");
  for (const [act, label] of [["approve", "Approve"], ["reject", "Reject"], ["merge", "Merge & edit"]] as const) {
    const button = el("button", `hunk-btn ${act}`);
    button.title = act === "merge" ? "Keep both versions and edit" : label;
    button.setAttribute("aria-label", label);
    if (compact || act !== "merge") button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${HUNK_ICONS[act]}</svg>`;
    else button.textContent = label;
    button.addEventListener("mousedown", (event) => { event.preventDefault(); runHunkAction(view, id, act); });
    bar.append(button);
  }
  return bar;
}

class HunkBlock extends WidgetType {
  constructor(readonly hunk: Hunk) { super(); }
  override eq(other: HunkBlock): boolean { return other.hunk.id === this.hunk.id && other.hunk.old === this.hunk.old; }
  toDOM(view: EditorView): HTMLElement {
    const box = el("div", "hunk-box");
    if (this.hunk.old !== "") box.append(el("div", "hunk-old", this.hunk.old.replace(/\n$/, "")));
    const bar = el("div", "hunk-bar");
    bar.append(el("span", "hunk-who", this.hunk.overlaps ? "Agent · overlaps your edit" : "Agent"), hunkButtons(view, this.hunk.id, false));
    box.append(bar);
    return box;
  }
  override ignoreEvent(): boolean { return true; }
}
class InlineOld extends WidgetType {
  constructor(readonly text: string) { super(); }
  override eq(other: InlineOld): boolean { return other.text === this.text; }
  toDOM(): HTMLElement { return el("del", "hunk-del", this.text); }
}
class InlineButtons extends WidgetType {
  constructor(readonly id: number) { super(); }
  override eq(other: InlineButtons): boolean { return other.id === this.id; }
  toDOM(view: EditorView): HTMLElement { return hunkButtons(view, this.id, true); }
  override ignoreEvent(): boolean { return true; }
}

function hunkDecorations(state: EditorState, hunks: readonly Hunk[]): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const doc = state.doc;
  for (const h of hunks) {
    if (h.inline) {
      if (h.old !== "") deco.push(Decoration.widget({ widget: new InlineOld(h.old), side: -1 }).range(h.from));
      if (h.to > h.from) deco.push(Decoration.mark({ class: "hunk-ins" }).range(h.from, h.to));
      deco.push(Decoration.widget({ widget: new InlineButtons(h.id), side: 1 }).range(h.to));
      continue;
    }
    const first = doc.lineAt(h.from);
    deco.push(Decoration.widget({ widget: new HunkBlock(h), block: true, side: -1 }).range(first.from));
    // green = the agent's text now in the file (a range ending at a line start doesn't own that line)
    const lastPos = h.to > h.from && doc.lineAt(h.to).from === h.to ? h.to - 1 : h.to;
    if (h.to > h.from) for (let line = first; ; line = doc.line(line.number + 1)) {
      deco.push(Decoration.line({ class: "hunk-new" }).range(line.from));
      if (line.to >= lastPos || line.number === doc.lines) break;
    }
  }
  return Decoration.set(deco, true);
}

export const hunkField = StateField.define<readonly Hunk[]>({
  create: () => [],
  update(current, tr) {
    let hunks = current;
    // New agent changes arrive in start-doc coords; merge them with any unresolved hunk on the same lines
    // so "old" always means "before the agent touched it", then re-split into word or line hunks.
    const incoming = tr.effects.flatMap((e) => e.is(addHunks) ? e.value : []);
    const startDoc = tr.startState.doc;
    const lineSpan = (from: number, to: number) => [startDoc.lineAt(from).number, startDoc.lineAt(to).number] as const;
    const regions: (IncomingHunk & { absorbed: Hunk[] })[] = [];
    const absorbed = new Set<number>();
    for (const n of incoming) {
      const region: IncomingHunk & { absorbed: Hunk[] } = { ...n, absorbed: [] };
      const [nf, nt] = lineSpan(n.sFrom, n.sTo);
      for (const e of hunks) {
        if (absorbed.has(e.id)) continue;
        const [ef, et] = lineSpan(e.from, e.to);
        if (ef <= nt && nf <= et) {
          region.absorbed.push(e);
          absorbed.add(e.id);
          region.sFrom = Math.min(region.sFrom, e.from);
          region.sTo = Math.max(region.sTo, e.to);
          region.overlaps ||= e.overlaps;
        }
      }
      regions.push(region);
    }
    hunks = hunks.filter((h) => !absorbed.has(h.id));
    if (tr.docChanged) hunks = hunks.map((h) => {
      const from = tr.changes.mapPos(h.from, 1);
      return { ...h, from, to: Math.max(from, tr.changes.mapPos(h.to, -1)) };
    });
    const added: Hunk[] = [];
    for (const r of regions) {
      // original text of the region: start doc with absorbed hunks rolled back to their old text
      let old = startDoc.sliceString(r.sFrom, r.sTo);
      for (const e of [...r.absorbed].sort((a, b) => b.from - a.from)) old = old.slice(0, e.from - r.sFrom) + e.old + old.slice(e.to - r.sFrom);
      const from = tr.changes.mapPos(r.sFrom, -1), to = Math.max(from, tr.changes.mapPos(r.sTo, 1));
      const next = tr.state.doc.sliceString(from, to);
      if (old === next) continue; // agent changed it back
      const words = wordChanges(old, next);
      if (words === null) added.push({ id: ++hunkSeq, from, to, old, overlaps: r.overlaps, inline: false });
      else for (const w of words) added.push({ id: ++hunkSeq, from: from + w.nF, to: from + w.nT, old: old.slice(w.oF, w.oT), overlaps: r.overlaps, inline: true });
    }
    hunks = [...hunks, ...added];
    for (const e of tr.effects) {
      if (e.is(dropHunk)) hunks = hunks.filter((h) => h.id !== e.value);
      if (e.is(dropAllHunks)) hunks = [];
    }
    return hunks.length === 0 && current.length === 0 ? current : hunks;
  },
  provide: (f) => EditorView.decorations.compute([f], (state) => hunkDecorations(state, state.field(f))),
});

/** The transaction resolving one hunk, or undefined when it no longer exists. */
export function hunkActionSpec(state: EditorState, id: number, act: HunkAction): TransactionSpec | undefined {
  const h = state.field(hunkField).find((x) => x.id === id);
  if (h === undefined) return undefined;
  if (act === "approve") return { effects: dropHunk.of(id) };
  if (act === "reject") return { changes: { from: h.from, to: h.to, insert: h.old }, effects: dropHunk.of(id) };
  // put the old text right after the agent's, select it, and let the user combine them by hand
  const sep = h.inline ? " " : h.to > h.from && state.doc.sliceString(h.to - 1, h.to) !== "\n" && h.old !== "" ? "\n" : "";
  return { changes: { from: h.to, insert: sep + h.old }, selection: { anchor: h.to + sep.length, head: h.to + sep.length + h.old.length }, effects: dropHunk.of(id), scrollIntoView: true };
}

function runHunkAction(view: EditorView, id: number, act: HunkAction): void {
  const spec = hunkActionSpec(view.state, id, act);
  if (spec === undefined) return;
  view.dispatch(spec);
  if (act === "merge") view.focus();
}

/** Next / Approve all / Reject all from the hunk strip. */
export function bulkHunkAction(view: EditorView, act: "next" | "approve" | "reject"): void {
  const hunks = [...view.state.field(hunkField)].sort((a, b) => b.from - a.from);
  if (act === "next") {
    const head = view.state.selection.main.head;
    const next = [...hunks].reverse().find((x) => x.from > head) ?? hunks.at(-1);
    if (next) view.dispatch({ selection: { anchor: next.from }, effects: EditorView.scrollIntoView(next.from, { y: "center" }) });
    return;
  }
  for (const h of hunks) runHunkAction(view, h.id, act);
}

/** Clears hunks without touching the text (e.g. after a save, which approves them). */
export const clearHunks = (): TransactionSpec => ({ effects: dropAllHunks.of(null) });

/** diff(a, b) as line-aligned chunks, so hunks show whole old/new lines. */
export function lineChunks(a: string, b: string): { fA: number; tA: number; fB: number; tB: number }[] {
  const A = Text.of(a.split("\n")), B = Text.of(b.split("\n"));
  const out: { fA: number; tA: number; fB: number; tB: number }[] = [];
  for (const c of diff(a, b)) {
    const aligned = ([[A, c.fromA], [A, c.toA], [B, c.fromB], [B, c.toB]] as const).every(([T, p]) => T.lineAt(p).from === p);
    let fA = c.fromA, tA = c.toA, fB = c.fromB, tB = c.toB;
    if (!aligned) {
      const pre = fA - A.lineAt(fA).from, post = A.lineAt(tA).to - tA;
      fA -= pre; fB -= pre; tA += post; tB += post;
    }
    const last = out.at(-1);
    // merging chunks on the same line: the later chunk's end is the correct one
    if (last !== undefined && fA <= last.tA) { last.tA = tA; last.tB = tB; } else out.push({ fA, tA, fB, tB });
  }
  return out;
}

/** Word-level changes for a small edit (a few words), or null when the change is substantial. */
// ponytail: O(n·m) token LCS; fine for the few lines a hunk spans.
export function wordChanges(a: string, b: string): { oF: number; oT: number; nF: number; nT: number }[] | null {
  if (a === "" || b === "") return null;
  const tokens = (t: string) => t.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
  const A = tokens(a), B = tokens(b);
  if (A.length * B.length > 250000) return null;
  const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  const lcs = (i: number, j: number) => L[i]?.[j] ?? 0;
  for (let i = A.length - 1; i >= 0; i--) {
    const row = L[i];
    if (row === undefined) continue;
    for (let j = B.length - 1; j >= 0; j--) row[j] = A[i] === B[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
  }
  const out: { oF: number; oT: number; nF: number; nT: number }[] = [];
  let i = 0, j = 0, oPos = 0, nPos = 0;
  let cur: { oF: number; oT: number; nF: number; nT: number } | null = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  while (i < A.length || j < B.length) {
    const ai = A[i] ?? "", bj = B[j] ?? "";
    if (i < A.length && j < B.length && ai === bj) {
      // a lone space between two changes stays inside the change ("word word")
      if (cur && /^\s+$/.test(ai) && i + 1 < A.length && j + 1 < B.length && A[i + 1] !== B[j + 1]) { cur.oT += ai.length; cur.nT += bj.length; }
      else flush();
      oPos += ai.length; nPos += bj.length; i++; j++;
    } else {
      cur ??= { oF: oPos, oT: oPos, nF: nPos, nT: nPos };
      if (j < B.length && (i >= A.length || lcs(i, j + 1) >= lcs(i + 1, j))) { nPos += bj.length; j++; cur.nT = nPos; }
      else { oPos += ai.length; i++; cur.oT = oPos; }
    }
  }
  flush();
  // substantial = much of the existing text replaced; pure additions stay inline however long
  const changed = out.reduce((n, w) => n + (w.oT - w.oF), 0);
  const multiLine = out.some((w) => a.slice(w.oF, w.oT).includes("\n") || b.slice(w.nF, w.nT).includes("\n"));
  return multiLine || out.length > 4 || changed > 0.4 * a.length ? null : out;
}

const csDiff = (a: string, b: string) => ChangeSet.of(diff(a, b).map((c) => ({ from: c.fromA, to: c.toA, insert: b.slice(c.fromB, c.toB) })), a.length);

/**
 * Applies the agent's disk text over the editor (also over unsaved edits) and records the changes as hunks.
 * `base` is the last disk text the editor was in sync with.
 */
export function diskChangeSpec(state: EditorState, base: string, disk: string): { spec: TransactionSpec; overlaps: boolean } {
  const doc = state.doc.toString();
  const mine = csDiff(base, doc); // unsaved edits relative to base
  const baseDoc = Text.of(base.split("\n"));
  const myLines: [number, number][] = [];
  mine.iterChangedRanges((fA, tA) => { myLines.push([baseDoc.lineAt(fA).number, baseDoc.lineAt(tA).number]); });
  const changes: { from: number; to: number; insert: string }[] = [], hunks: IncomingHunk[] = [];
  for (const c of lineChunks(base, disk)) {
    const lf = baseDoc.lineAt(c.fA).number, lt = baseDoc.lineAt(Math.max(c.fA, c.tA - (c.tA > c.fA ? 1 : 0))).number;
    const overlaps = myLines.some(([f, t]) => lf <= t && f <= lt);
    // where this base range lives in the doc; when the user edited it, their version is what gets replaced (and kept as "old")
    const from = mine.mapPos(c.fA, -1), to = Math.max(from, mine.mapPos(c.tA, 1));
    changes.push({ from, to, insert: disk.slice(c.fB, c.tB) });
    hunks.push({ sFrom: from, sTo: to, overlaps });
  }
  return {
    spec: { changes: ChangeSet.of(changes, doc.length), effects: addHunks.of(hunks), annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)] },
    overlaps: hunks.some((h) => h.overlaps),
  };
}

// ---------------- highlighted line range (Chat links with #L40-L58) ----------------
const setLineRange = StateEffect.define<{ from: number; to: number }>();
export const lineRangeHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLineRange)) {
      const deco: Range<Decoration>[] = [];
      for (let n = e.value.from; n <= e.value.to; n++) deco.push(Decoration.line({ class: "cm-range" }).range(tr.state.doc.line(n).from));
      return Decoration.set(deco);
    }
    return tr.docChanged || tr.selection !== undefined ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Highlights lines start..end (1-based, clamped) and scrolls them to the center. */
export function lineRangeSpec(state: EditorState, start: number, end: number): TransactionSpec {
  const from = Math.min(Math.max(1, start), state.doc.lines), to = Math.min(Math.max(from, end), state.doc.lines);
  return { effects: [setLineRange.of({ from, to }), EditorView.scrollIntoView(state.doc.line(from).from, { y: "center" })] };
}
