import { Prec, StateEffect, StateField, type Text } from "@codemirror/state";
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
    if (!this.expanded) toggle.append(this.label);
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

function quoteFolds(doc: Text, requested: readonly number[]): QuoteFolds {
  const blocks = quoteBlocks(doc);
  const expanded = requested.filter((from) => blocks.some((block) => block.from === from));
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
    return quoteFolds(tr.state.doc, expanded);
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

/** Reply quotes render collapsed by default; their text in the document is unchanged either way. */
export const replyQuoteFolding = [quoteFoldField, Prec.highest(keymap.of([{ key: "Enter", run: expandQuoteAtCursor }]))];
