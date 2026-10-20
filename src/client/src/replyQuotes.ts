import { EditorState, Prec, StateEffect, StateField, Text, type ChangeSet, type ChangeSpec } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import { render } from "lit";
import { renderBuiltinTabIcon } from "./components/tabIcons";

/** Text selected inside one Chat message, identified by its durable session entry id. */
export interface ReplyQuote {
  readonly entryId: string;
  readonly excerpt: string;
}

const LABEL_LENGTH = 60;
// A reply quote is a blockquote led by its source link; hand-typed `>` quotes stay plain text.
const SOURCE_LINE = /^> \[msg [^\]]*\]\(#entry:[^)]*\) ?/;

/**
 * `> [msg <entryId>](#entry:<entryId>) first line`; ChatView reveals the source from that leading link.
 * Excerpt lines starting with `>` or `[` are escaped so they cannot open a nested quote or a look-alike link.
 */
export function formatReplyQuote({ entryId, excerpt }: ReplyQuote): string {
  return excerpt.trim().split(/\r?\n/).map((line, index) => `>${index === 0 ? ` [msg ${entryId}](#entry:${entryId})` : ""}${line === "" ? "" : ` ${line.replace(/^(\s*)([>[])/, "$1\\$2")}`}`).join("\n");
}

/** The quote as its own paragraph after `textBefore`, plus a blank line so text typed after it is not pulled into the quote. */
export function replyQuoteInsertion(textBefore: string, quote: ReplyQuote): string {
  const separator = textBefore === "" || textBefore.endsWith("\n\n") ? "" : textBefore.endsWith("\n") ? "\n" : "\n\n";
  return `${separator}${formatReplyQuote(quote)}\n\n`;
}

interface QuoteBlock { readonly from: number; readonly to: number; readonly label: string }

function quoteBlocks(doc: Text): QuoteBlock[] {
  const blocks: QuoteBlock[] = [];
  for (let number = 1; number <= doc.lines; number += 1) {
    const start = doc.line(number);
    if (!SOURCE_LINE.test(start.text)) continue;
    const lines = [start.text.replace(SOURCE_LINE, "")];
    let end = start;
    while (end.number < doc.lines) {
      const next = doc.line(end.number + 1);
      if (!next.text.startsWith(">") || SOURCE_LINE.test(next.text)) break;
      lines.push(next.text.replace(/^> ?/, ""));
      end = next;
    }
    const words = lines.join(" ").replace(/\\([>[])/g, "$1").replace(/\s+/g, " ").trim();
    blocks.push({ from: start.from, to: end.to, label: `> ${words.length > LABEL_LENGTH ? `${words.slice(0, LABEL_LENGTH - 1).trimEnd()}…` : words}` });
    number = end.number;
  }
  return blocks;
}

const toggleReplyQuote = StateEffect.define<number>();

/** Collapsed: a one-line chevron + label replacing the block. Expanded: a chevron before the editable text. */
class QuoteToggle extends WidgetType {
  constructor(readonly expanded: boolean, readonly label: string) { super(); }

  override eq(other: QuoteToggle): boolean { return other.expanded === this.expanded && other.label === this.label; }

  toDOM(view: EditorView): HTMLElement {
    const toggle = document.createElement("span");
    toggle.className = `cm-reply-quote${this.expanded ? " cm-reply-quote-open" : ""}`;
    toggle.setAttribute("role", "button");
    toggle.setAttribute("aria-expanded", String(this.expanded));
    toggle.title = this.expanded ? "Collapse quote" : "Expand quote";
    render(renderBuiltinTabIcon("chevron"), toggle);
    if (!this.expanded) {
      const label = document.createElement("span");
      label.className = "cm-reply-quote-label";
      label.textContent = this.label;
      toggle.append(label);
    }
    toggle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const at = view.posAtDOM(toggle);
      const block = quoteBlocks(view.state.doc).find((candidate) => at >= candidate.from && at <= candidate.to);
      if (block !== undefined) view.dispatch({ effects: toggleReplyQuote.of(block.from) });
    });
    return toggle;
  }
}

interface QuoteFolds { readonly expanded: readonly number[]; readonly collapsed: DecorationSet; readonly toggles: DecorationSet }

/** Whether `changes` edited the block's own text, as opposed to inserting the whole block or text beside it. */
function editsInside(changes: ChangeSet | undefined, block: QuoteBlock): boolean {
  let edited = false;
  changes?.iterChangedRanges((_fromA, _toA, from, to) => {
    if (from === to ? from > block.from && from < block.to : from < block.to && to > block.from && (from > block.from || to < block.to)) edited = true;
  }, true);
  return edited;
}

function quoteFolds(doc: Text, requested: readonly number[], changes?: ChangeSet): QuoteFolds {
  const blocks = quoteBlocks(doc);
  // An edit to a collapsed quote's text opens it, so a change is never hidden inside the fold.
  const expanded = blocks.filter((block) => requested.includes(block.from) || editsInside(changes, block)).map((block) => block.from);
  const collapsed = blocks.filter((block) => !expanded.includes(block.from));
  return {
    expanded,
    collapsed: Decoration.set(collapsed.map((block) => Decoration.replace({ widget: new QuoteToggle(false, block.label) }).range(block.from, block.to))),
    toggles: Decoration.set(blocks.filter((block) => expanded.includes(block.from)).map((block) => Decoration.widget({ widget: new QuoteToggle(true, block.label), side: -1 }).range(block.from))),
  };
}

const quoteFoldField = StateField.define<QuoteFolds>({
  create: (state) => quoteFolds(state.doc, []),
  update(folds, tr) {
    // Associate forward so text inserted right before an expanded quote does not inherit its expansion.
    let expanded = folds.expanded.map((from) => tr.changes.mapPos(from, 1));
    for (const effect of tr.effects) {
      if (effect.is(toggleReplyQuote)) expanded = expanded.includes(effect.value) ? expanded.filter((from) => from !== effect.value) : [...expanded, effect.value];
    }
    if (!tr.docChanged && expanded.length === folds.expanded.length && expanded.every((from, index) => from === folds.expanded[index])) return folds;
    return quoteFolds(tr.state.doc, expanded, tr.changes);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (folds) => folds.collapsed),
    EditorView.decorations.from(field, (folds) => folds.toggles),
    EditorView.atomicRanges.of((view) => view.state.field(field).collapsed),
  ],
});

/** Enter at either edge of a collapsed quote expands it. */
function expandQuoteAtCursor(view: EditorView): boolean {
  const { main } = view.state.selection;
  if (!main.empty) return false;
  let from: number | undefined;
  view.state.field(quoteFoldField).collapsed.between(main.head, main.head, (start) => { from = start; return false; });
  if (from === undefined) return false;
  view.dispatch({ effects: toggleReplyQuote.of(from) });
  return true;
}

/**
 * Text typed at a collapsed quote's edge goes into its own paragraph beside the quote: visible, and not quoted
 * (a single line break would still continue the blockquote in Markdown). Line breaks pass through; IME composition is handled when it starts.
 */
const typeBesideCollapsedQuotes = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("input") || tr.isUserEvent("input.type.compose")) return tr;
  const starts = new Set<number>();
  const ends = new Set<number>();
  tr.startState.field(quoteFoldField).collapsed.between(0, tr.startState.doc.length, (from, to) => { starts.add(from); ends.add(to); });
  const breaks: ChangeSpec[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (fromA !== toA || inserted.length === 0) return;
    if (ends.has(fromA) && inserted.sliceString(0, 1) !== "\n") breaks.push({ from: fromB, insert: "\n\n" });
    else if (starts.has(fromA) && inserted.sliceString(inserted.length - 1) !== "\n") breaks.push({ from: toB, insert: "\n\n" });
  });
  return breaks.length === 0 ? tr : [tr, { changes: breaks, sequential: true }];
});

/**
 * IME composition can't be split by the filter above, so before it starts at a collapsed quote's edge, open the same
 * paragraph beside the quote and put the caret in it.
 */
const composeBesideCollapsedQuotes = EditorView.domEventHandlers({
  compositionstart: (_event, view) => {
    const { main } = view.state.selection;
    if (!main.empty) return false;
    let edge: "start" | "end" | undefined;
    view.state.field(quoteFoldField).collapsed.between(main.head, main.head, (from, to) => {
      edge = main.head === to ? "end" : main.head === from ? "start" : undefined;
      return false;
    });
    if (edge === undefined) return false;
    view.dispatch({ changes: { from: main.head, insert: "\n\n" }, selection: { anchor: edge === "end" ? main.head + 2 : main.head } });
    return false;
  },
});

/** Applies `edit` to the text between reply quotes, leaving each quote exactly as quoted. */
export function editOutsideReplyQuotes(text: string, edit: (outside: string) => string): string {
  let result = "";
  let at = 0;
  for (const block of quoteBlocks(Text.of(text.split("\n")))) {
    result += edit(text.slice(at, block.from)) + text.slice(block.from, block.to);
    at = block.to;
  }
  return result + edit(text.slice(at));
}

/** Reply quotes render collapsed by default; their text in the document is unchanged either way. */
export const replyQuoteFolding = [quoteFoldField, typeBesideCollapsedQuotes, composeBesideCollapsedQuotes, Prec.highest(keymap.of([{ key: "Enter", run: expandQuoteAtCursor }]))];
