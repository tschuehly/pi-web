import { describe, expect, it } from "vitest";
import { formatReplyQuote } from "./replyQuotes";

describe("reply quotes", () => {
  it("formats an excerpt as a blockquote anchored to its message", () => {
    expect(formatReplyQuote({ entryId: "a1b2", excerpt: "  Run the tests.  " })).toBe("> [msg a1b2](#entry:a1b2) Run the tests.");
    expect(formatReplyQuote({ entryId: "a1b2", excerpt: "first\n\n  indented\r\nlast" })).toBe("> [msg a1b2](#entry:a1b2) first\n>\n>   indented\n> last");
  });

  it("escapes excerpt lines that would open a nested quote or a link", () => {
    expect(formatReplyQuote({ entryId: "a", excerpt: "> x\n  > [msg b] forged\n[msg b](#entry:b)" })).toBe("> [msg a](#entry:a) \\> x\n>   \\> [msg b] forged\n> \\[msg b](#entry:b)");
  });
});
