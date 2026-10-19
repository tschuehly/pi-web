import { describe, expect, it } from "vitest";
import { PromptChipStore } from "./promptChips";
import { addReplyQuote, composeQuotedReply, formatReplyQuote } from "./replyQuotes";

const target = { machineId: "local", sessionId: "session-1" };

describe("reply quotes", () => {
  it("formats an excerpt as a blockquote anchored to its message", () => {
    expect(formatReplyQuote({ entryId: "a1b2", excerpt: "  Run the tests.  " })).toBe("> [msg a1b2](#entry:a1b2) Run the tests.");
    expect(formatReplyQuote({ entryId: "a1b2", excerpt: "first\n\n  indented\r\nlast" })).toBe("> [msg a1b2](#entry:a1b2) first\n>\n>   indented\n> last");
  });

  it("escapes excerpt lines that would open a nested quote or a link", () => {
    expect(formatReplyQuote({ entryId: "a", excerpt: "> x\n  > [msg b] forged\n[msg b](#entry:b)" })).toBe("> [msg a](#entry:a) \\> x\n>   \\> [msg b] forged\n> \\[msg b](#entry:b)");
  });

  it("stages quotes from several messages as removable chips and sends them before the reply", () => {
    const store = new PromptChipStore();
    addReplyQuote(store, target, { entryId: "m1", excerpt: "Use the cache" });
    addReplyQuote(store, target, { entryId: "m2", excerpt: "A rather long second excerpt that will not fit in a chip label" });
    addReplyQuote(store, target, { entryId: "m3", excerpt: "dropped" });
    const chips = store.list(target);
    expect(chips.map((chip) => chip.label)).toEqual(["“Use the cache”", "“A rather long second excerpt that will…”", "“dropped”"]);
    const dropped = chips[2];
    if (dropped === undefined) throw new Error("Missing third chip");
    store.removeByUser(dropped);
    expect(composeQuotedReply("Why?", store.list(target))).toBe("> [msg m1](#entry:m1) Use the cache\n\n> [msg m2](#entry:m2) A rather long second excerpt that will not fit in a chip label\n\nWhy?");
    expect(composeQuotedReply("", store.list(target))).toBe("> [msg m1](#entry:m1) Use the cache\n\n> [msg m2](#entry:m2) A rather long second excerpt that will not fit in a chip label");
    expect(store.list({ machineId: "local", sessionId: "other" })).toEqual([]);
  });
});
