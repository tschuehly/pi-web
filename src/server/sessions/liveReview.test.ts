import { describe, expect, it } from "vitest";
import { LiveReviewCollector, parsePairCommand } from "./liveReview.js";

const assistant = (...content: object[]) => ({ type: "message.end" as const, message: { role: "assistant", content } });
const toolEnd = (toolName: string, isError = false, text = "") => ({ type: "tool.end" as const, toolName, toolCallId: toolName, text, isError });

describe("parsePairCommand", () => {
  it("defaults to Sol, turn5 and silent; takes a model and both knobs in any order; stop ends it", () => {
    expect(parsePairCommand("")).toEqual({ model: "openai/gpt-6.2-sol", trigger: "turn5", brief: "silent" });
    expect(parsePairCommand("anthropic/claude-x --brief coach --trigger edits")).toEqual({ model: "anthropic/claude-x", trigger: "edits", brief: "coach" });
    expect(parsePairCommand("--trigger turn")).toEqual({ model: "openai/gpt-6.2-sol", trigger: "turn", brief: "silent" });
    expect(parsePairCommand("stop")).toEqual({ stop: true });
  });

  it("refuses an unknown knob value, a bad model and a stray word with the usage", () => {
    for (const args of ["--trigger often", "--brief loud", "--trigger", "sol", "a/b c/d", "--fast"]) expect(() => parsePairCommand(args)).toThrow(/^Usage: \/pair /);
  });
});

describe("LiveReviewCollector", () => {
  it("turn: a digest is due at the main turn end only", () => {
    const review = new LiveReviewCollector("turn");
    for (let i = 0; i < 6; i++) review.add(toolEnd("edit"));
    expect(review.due).toBe(false);
    review.add({ type: "agent.end" });
    expect(review.due).toBe(true);
  });

  it("turn5: due at the 5th finished tool call, again 5 calls later, and at turn end", () => {
    const review = new LiveReviewCollector("turn5");
    for (let i = 0; i < 4; i++) review.add(toolEnd("read"));
    expect(review.due).toBe(false);
    review.add(toolEnd("read"));
    expect(review.due).toBe(true);
    review.take();
    for (let i = 0; i < 4; i++) review.add(toolEnd("bash"));
    expect(review.due).toBe(false);
    review.add({ type: "agent.end" });
    expect(review.due).toBe(true);
    review.take();
    // The turn end restarted the count.
    review.add(toolEnd("read"));
    expect(review.due).toBe(false);
  });

  it("edits: due after every edit, write or bash call and at turn end, not after a read", () => {
    const review = new LiveReviewCollector("edits");
    review.add(toolEnd("read"));
    expect(review.due).toBe(false);
    for (const tool of ["edit", "write", "bash"]) {
      review.add(toolEnd(tool));
      expect(review.due).toBe(true);
      review.take();
    }
    review.add({ type: "agent.end" });
    expect(review.due).toBe(true);
  });

  it("the digest holds owner and assistant text, reasoning, tool calls with their arguments, error text and the files touched; no tool output", () => {
    const review = new LiveReviewCollector("turn");
    review.add({ type: "message.end", message: { role: "user", content: [{ type: "text", text: "Sum the list" }] } });
    review.add(assistant(
      { type: "thinking", thinking: "The loop should run to n." },
      { type: "text", text: "Fixing the loop." },
      { type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/sum.ts", edits: [{ oldText: "i <= n", newText: "i < n - 1" }] } },
      { type: "toolCall", id: "c2", name: "write", arguments: { path: "notes.md", content: "x" } },
    ));
    review.add(toolEnd("edit", false, "Successfully replaced text in src/sum.ts. SECRET-OUTPUT"));
    review.add({ type: "message.end", message: { role: "toolResult", toolName: "edit", content: [{ type: "text", text: "SECRET-OUTPUT" }] } });
    review.add(toolEnd("bash", true, "npm test: 1 failing"));
    review.add({ type: "message.end", message: { role: "custom", customType: "workbench:chat-message", content: "Chat message · from the reviewer" } });
    expect(review.take()).toBe([
      "Owner: Sum the list",
      "Reasoning: The loop should run to n.",
      "Assistant: Fixing the loop.",
      'Tool call edit {"path":"src/sum.ts","edits":[{"oldText":"i <= n","newText":"i < n - 1"}]}',
      'Tool call write {"path":"notes.md","content":"x"}',
      "Tool error bash: npm test: 1 failing",
      "Files touched: src/sum.ts, notes.md",
    ].join("\n"));
    expect(review.take()).toBeUndefined();
  });

  it("while the reviewer is busy, the next digest merges everything since the last one", () => {
    const review = new LiveReviewCollector("edits");
    review.add(assistant({ type: "text", text: "one" }));
    review.add(toolEnd("edit"));
    review.add(assistant({ type: "text", text: "two" }));
    review.add(toolEnd("edit"));
    expect(review.take()).toBe("Assistant: one\nAssistant: two");
    expect(review.due).toBe(false);
  });

  it("a digest the reviewer did not take goes back before the newer work", () => {
    const review = new LiveReviewCollector("turn");
    review.add(assistant({ type: "text", text: "old" }));
    const taken = review.take() ?? "";
    review.add(assistant({ type: "text", text: "new" }));
    review.putBack(taken);
    expect(review.take()).toBe("Assistant: old\nAssistant: new");
  });

  it("a very long argument is cut", () => {
    const review = new LiveReviewCollector("turn");
    review.add(assistant({ type: "toolCall", id: "c", name: "write", arguments: { path: "big.txt", content: "x".repeat(50_000) } }));
    const digest = review.take() ?? "";
    expect(digest.length).toBeLessThan(21_000);
    expect(digest).toMatch(/… \(cut\)\nFiles touched: big\.txt$/);
  });
});
