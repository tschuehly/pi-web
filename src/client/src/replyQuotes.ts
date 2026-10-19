import type { PromptChipStore, PromptChipTarget } from "./promptChips";

/** Text selected inside one Chat message, identified by its durable session entry id. */
export interface ReplyQuote {
  readonly entryId: string;
  readonly excerpt: string;
}

const OWNER = "reply-quote";
const LABEL_LENGTH = 40;
let nextQuoteId = 0;

/** `> [msg <entryId>] first line`; the anchor lets a reader (or ChatView) find the source message. */
export function formatReplyQuote({ entryId, excerpt }: ReplyQuote): string {
  return excerpt.trim().split(/\r?\n/).map((line, index) => `>${index === 0 ? ` [msg ${entryId}]` : ""}${line === "" ? "" : ` ${line}`}`).join("\n");
}

/** The source entry id of a quote written by formatReplyQuote, if `text` starts with one. */
export function quotedEntryId(text: string): string | undefined {
  return /^\s*\[msg ([^\]\s]+)\]/.exec(text)?.[1];
}

export function addReplyQuote(store: PromptChipStore, target: PromptChipTarget, quote: ReplyQuote): void {
  const excerpt = quote.excerpt.trim().replace(/\s+/g, " ");
  const label = excerpt.length > LABEL_LENGTH ? `${excerpt.slice(0, LABEL_LENGTH - 1).trimEnd()}…` : excerpt;
  nextQuoteId += 1;
  store.set(OWNER, target, { id: String(nextQuoteId), label: `“${label}”`, text: formatReplyQuote(quote) });
}

/** Quotes lead, so the reply reads like an email answer. */
export function composeQuotedReply(text: string, quotes: readonly { readonly text: string }[]): string {
  return [...quotes.map((quote) => quote.text), ...(text === "" ? [] : [text])].join("\n\n");
}
