import { describe, expect, it } from "vitest";
import { pageMessagesAtSafeBoundary } from "./messagePaging";
// Copied verbatim to pi-workbench packages/durable-pilot/test/transcript-paging.fixtures.json; both pagers must agree on it.
import fixtures from "./messagePaging.fixtures.json";

const user = (content: string) => ({ role: "user", content });
const assistantText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const thinking = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }] });
const toolCall = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name }] });
const toolResult = (text: string) => ({ role: "toolResult", content: text });

function page(start: number, total: number, messages: unknown[]) {
  return { start, total, messages };
}

describe("message paging", () => {
  it.each(fixtures)("shared fixture: $name", ({ messages, page: request, start, end }) => {
    expect(pageMessagesAtSafeBoundary<unknown>(messages, request ?? undefined)).toEqual(page(start, messages.length, messages.slice(start, end)));
  });

  it("chains pages of a call with 20 results, every message exactly once", () => {
    const messages = [user("prompt"), toolCall("read"), ...Array.from({ length: 20 }, (_, index) => toolResult(String(index))), assistantText("answer")];
    const seen: unknown[] = [];
    let before: number | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const result = pageMessagesAtSafeBoundary(messages, { ...(before === undefined ? {} : { before }), limit: 5 });
      expect(result.messages.length).toBeGreaterThan(0);
      expect((result.messages[0] as { role: string }).role).not.toBe("toolResult");
      seen.unshift(...result.messages);
      if (result.start === 0) break;
      before = result.start;
    }
    expect(seen).toEqual(messages);
  });

  it("wraps the full history in a page when paging is not requested", () => {
    const messages = [user("hello")];
    expect(pageMessagesAtSafeBoundary(messages)).toEqual(page(0, 1, messages));
  });

  it("uses normal bounded paging when the requested start is already a turn boundary", () => {
    const messages = [user("a"), assistantText("b"), user("c")];
    expect(pageMessagesAtSafeBoundary(messages, { limit: 1 })).toEqual(page(2, 3, messages.slice(2)));
  });

  it("never returns more than the limit, even mid-turn", () => {
    const messages = [user("prompt"), thinking("plan"), toolCall("read"), toolResult("ok"), thinking("next"), assistantText("answer")];
    expect(pageMessagesAtSafeBoundary(messages, { before: 5, limit: 2 })).toEqual(page(4, 6, messages.slice(4, 5)));
  });

  it("does not start a page on a tool result orphaned from its call", () => {
    const messages = [user("prompt"), toolCall("read"), toolResult("a"), toolResult("b"), assistantText("answer")];
    expect(pageMessagesAtSafeBoundary(messages, { limit: 3 })).toEqual(page(4, 5, messages.slice(4)));
    expect(pageMessagesAtSafeBoundary(messages, { before: 4, limit: 3 })).toEqual(page(1, 5, messages.slice(1, 4)));
  });

  it("pages a single 1,700-message turn within the limit and chains back to the start", () => {
    const messages: unknown[] = [user("prompt")];
    while (messages.length < 1_700) messages.push(...(messages.length % 3 === 1 ? [toolCall("read")] : messages.length % 3 === 2 ? [toolResult("ok")] : [thinking("next")]));
    const seen: unknown[] = [];
    let before: number | undefined;
    for (let guard = 0; guard < 1_700; guard += 1) {
      const result = pageMessagesAtSafeBoundary(messages, { ...(before === undefined ? {} : { before }), limit: 20 });
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages.length).toBeLessThanOrEqual(20);
      seen.unshift(...result.messages);
      if (result.start === 0) break;
      before = result.start;
    }
    expect(seen).toEqual(messages);
  });
});
