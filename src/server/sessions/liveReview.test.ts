import { describe, expect, it } from "vitest";
import { LiveReviewCollector, parsePairCommand } from "./liveReview.js";

const assistant = (...content: object[]) => ({ type: "message.end" as const, message: { role: "assistant", content } });
const same = (text: string) => Promise.resolve(text);
const toolEnd = (toolName: string, isError = false, text = "") => ({ type: "tool.end" as const, toolName, toolCallId: toolName, text, isError });

describe("parsePairCommand", () => {
  it("defaults to Sol, turn5 and silent; takes a model and both knobs in any order; stop ends it", () => {
    expect(parsePairCommand("")).toEqual({ model: "openai/gpt-6.2-sol", trigger: "turn5", brief: "silent" });
    expect(parsePairCommand("anthropic/claude-x --brief coach --trigger edits")).toEqual({ model: "anthropic/claude-x", trigger: "edits", brief: "coach" });
    expect(parsePairCommand("--trigger turn")).toEqual({ model: "openai/gpt-6.2-sol", trigger: "turn", brief: "silent" });
    expect(parsePairCommand("stop")).toEqual({ stop: true });
  });

  it("refuses an unknown knob value, a bad model and a stray word with the usage", () => {
    for (const args of ["--trigger often", "--brief loud", "--trigger", "sol", "a/b c/d", "--fast"])
      expect(() => parsePairCommand(args)).toThrow(/^Usage: \/pair /);
  });
});

describe("LiveReviewCollector", () => {
  it("turn: a digest is due at the main turn end only", async () => {
    const review = new LiveReviewCollector("turn");
    for (let i = 0; i < 6; i++) await review.add(toolEnd("edit"), same);
    expect(review.due).toBe(false);
    await review.add({ type: "agent.end" }, same);
    expect(review.due).toBe(true);
  });

  it("turn5: due at the 5th finished tool call, again 5 calls later, and at turn end", async () => {
    const review = new LiveReviewCollector("turn5");
    for (let i = 0; i < 4; i++) await review.add(toolEnd("read"), same);
    expect(review.due).toBe(false);
    await review.add(toolEnd("read"), same);
    expect(review.due).toBe(true);
    review.take();
    for (let i = 0; i < 4; i++) await review.add(toolEnd("bash"), same);
    expect(review.due).toBe(false);
    await review.add({ type: "agent.end" }, same);
    expect(review.due).toBe(true);
    review.take();
    // The turn end restarted the count.
    await review.add(toolEnd("read"), same);
    expect(review.due).toBe(false);
  });

  it("edits: due after every edit, write or bash call and at turn end, not after a read", async () => {
    const review = new LiveReviewCollector("edits");
    await review.add(toolEnd("read"), same);
    expect(review.due).toBe(false);
    for (const tool of ["edit", "write", "bash"]) {
      await review.add(toolEnd(tool), same);
      expect(review.due).toBe(true);
      review.take();
    }
    await review.add({ type: "agent.end" }, same);
    expect(review.due).toBe(true);
  });

  it("the digest holds owner and assistant text, reasoning, tool calls with their arguments, error text and the files touched; no tool output", async () => {
    const review = new LiveReviewCollector("turn");
    await review.add({ type: "message.end", message: { role: "user", content: [{ type: "text", text: "Sum the list" }] } }, same);
    await review.add(
      assistant(
        { type: "thinking", thinking: "The loop should run to n." },
        { type: "text", text: "Fixing the loop." },
        { type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/sum.ts", edits: [{ oldText: "i <= n", newText: "i < n - 1" }] } },
        { type: "toolCall", id: "c2", name: "write", arguments: { path: "notes.md", content: "x" } },
      ),
      same,
    );
    await review.add(toolEnd("edit", false, "Successfully replaced text in src/sum.ts. SECRET-OUTPUT"), same);
    await review.add({ type: "message.end", message: { role: "toolResult", toolName: "edit", content: [{ type: "text", text: "SECRET-OUTPUT" }] } }, same);
    await review.add(toolEnd("bash", true, "npm test: 1 failing"), same);
    await review.add(
      { type: "message.end", message: { role: "custom", customType: "workbench:chat-message", content: "Chat message · from the reviewer" } },
      same,
    );
    expect(review.take()?.text).toBe(
      [
        "Owner: Sum the list",
        "Reasoning: The loop should run to n.",
        "Assistant: Fixing the loop.",
        'Tool call edit {"path":"src/sum.ts","edits":[{"oldText":"i <= n","newText":"i < n - 1"}]}',
        'Tool call write {"path":"notes.md","content":"x"}',
        "Tool error bash: npm test: 1 failing",
        "Files touched: notes.md, src/sum.ts",
      ].join("\n"),
    );
    expect(review.take()).toBeUndefined();
  });

  it("while the reviewer is busy, the next digest merges everything since the last one", async () => {
    const review = new LiveReviewCollector("edits");
    await review.add(assistant({ type: "text", text: "one" }), same);
    await review.add(toolEnd("edit"), same);
    await review.add(assistant({ type: "text", text: "two" }), same);
    await review.add(toolEnd("edit"), same);
    expect(review.take()?.text).toBe("Assistant: one\nAssistant: two");
    expect(review.due).toBe(false);
  });

  it("a digest the reviewer did not take goes back before the newer work", async () => {
    const review = new LiveReviewCollector("turn");
    await review.add(assistant({ type: "text", text: "old" }), same);
    const taken = review.take();
    await review.add(assistant({ type: "text", text: "new" }), same);
    if (taken !== undefined) review.putBack(taken);
    expect(review.take()?.text).toBe("Assistant: old\nAssistant: new");
  });

  it("a very long argument is cut", async () => {
    const review = new LiveReviewCollector("turn");
    await review.add(assistant({ type: "toolCall", id: "c", name: "write", arguments: { path: "big.txt", content: "x".repeat(50_000) } }), same);
    const digest = review.take()?.text ?? "";
    expect(digest.length).toBeLessThan(21_000);
    expect(digest).toMatch(/… \(cut\)\nFiles touched: big\.txt$/);
  });

  const reviewerMessage = (delivery: string) => ({
    type: "message.end",
    message: {
      role: "custom",
      customType: "workbench:chat-message",
      content: "Chat message · live reviewer",
      details: { delivery, liveReview: { kind: "reviewer" } },
    },
  });
  const owner = (text: string) => ({ type: "message.end", message: { role: "user", content: [{ type: "text", text }] } });

  it("a turn the reviewer's message started produces no digest at any trigger; it is kept for the next owner digest", async () => {
    const review = new LiveReviewCollector("edits");
    await review.add({ type: "agent.start" }, same);
    await review.add(reviewerMessage("started"), same);
    await review.add(assistant({ type: "text", text: "Fixing what the reviewer found" }), same);
    for (let i = 0; i < 6; i++) await review.add(toolEnd("edit"), same);
    await review.add({ type: "agent.end" }, same);
    expect(review.due).toBe(false);
    await review.add(owner("Next task"), same);
    await review.add({ type: "agent.start" }, same);
    await review.add(toolEnd("edit"), same);
    expect(review.due).toBe(true);
    expect(review.take()?.text).toBe("Assistant: Fixing what the reviewer found\nOwner: Next task");
  });

  it("a queued reviewer message that starts a new turn after the owner's work: the owner's part is due, the reviewer's part never triggers", async () => {
    const review = new LiveReviewCollector("turn5");
    await review.add({ type: "agent.start" }, same);
    await review.add(owner("Sum the list"), same);
    await review.add(assistant({ type: "text", text: "Done." }), same);
    await review.add(toolEnd("read"), same);
    expect(review.due).toBe(false);
    await review.add(reviewerMessage("queued"), same);
    expect(review.due).toBe(true);
    expect(review.take()?.text).toBe("Owner: Sum the list\nAssistant: Done.");
    for (let i = 0; i < 10; i++) await review.add(toolEnd("read"), same);
    await review.add({ type: "agent.end" }, same);
    expect(review.due).toBe(false);
    // The next reviewer message queued into that reviewer turn: still nothing due.
    await review.add({ type: "agent.start" }, same);
    await review.add(reviewerMessage("started"), same);
    await review.add(reviewerMessage("queued"), same);
    await review.add({ type: "agent.end" }, same);
    expect(review.due).toBe(false);
  });

  it("a reviewer steer into an owner turn, or an owner message joining a reviewer turn, keeps the triggers", async () => {
    const steered = new LiveReviewCollector("turn5");
    await steered.add(owner("Sum the list"), same);
    await steered.add({ type: "agent.start" }, same);
    for (let i = 0; i < 2; i++) await steered.add(toolEnd("read"), same);
    await steered.add(reviewerMessage("steered"), same);
    for (let i = 0; i < 3; i++) await steered.add(toolEnd("read"), same);
    expect(steered.due).toBe(true);
    const joined = new LiveReviewCollector("turn");
    await joined.add(reviewerMessage("started"), same);
    await joined.add({ type: "agent.start" }, same);
    await joined.add(owner("Also check the tests"), same);
    await joined.add({ type: "agent.end" }, same);
    expect(joined.due).toBe(true);
  });

  it("the buffer and each digest stay under 60,000 characters: the newest work and every touched file stay, omissions are marked", async () => {
    const review = new LiveReviewCollector("turn");
    for (let i = 0; i < 200; i++)
      await review.add(
        assistant({
          type: "toolCall",
          id: `c${String(i)}`,
          name: "write",
          arguments: { path: `src/f${String(i)}.ts`, content: `// file ${String(i)}\n${"x".repeat(15_000)}` },
        }),
        same,
      );
    const taken = review.take();
    const text = taken?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(60_000);
    const omitted = /^\[… (\d+) earlier tool calls and 0 earlier lines omitted; read the files listed\]\n/u.exec(text);
    expect(omitted).not.toBeNull();
    expect(text).toContain("// file 199");
    expect(text).not.toContain("// file 0\\n");
    const calls = text.split("\n").filter((line) => line.startsWith("Tool call write")).length;
    expect(Number(omitted?.[1]) + calls).toBe(200);
    expect(text.endsWith(`Files touched: ${Array.from({ length: 200 }, (_, i) => `src/f${String(199 - i)}.ts`).join(", ")}`)).toBe(true);
    // Put back behind newer work, the merged digest is capped again and counts every omission.
    for (let i = 0; i < 5; i++)
      await review.add(
        assistant({
          type: "toolCall",
          id: `n${String(i)}`,
          name: "edit",
          arguments: { path: "src/new.ts", edits: [{ oldText: "a", newText: "y".repeat(15_000) }] },
        }),
        same,
      );
    if (taken !== undefined) review.putBack(taken);
    const merged = review.take()?.text ?? "";
    expect(merged.length).toBeLessThanOrEqual(60_000);
    const mergedOmitted = Number(/^\[… (\d+) earlier/u.exec(merged)?.[1]);
    expect(mergedOmitted + merged.split("\n").filter((line) => line.startsWith("Tool call")).length).toBe(205);
    expect(merged).toContain("Files touched: src/new.ts, src/f199.ts, ");
  });

  it("each field is redacted whole before it is cut or JSON-escaped; a field the host cannot redact is omitted", async () => {
    /** Built from parts, so the commit secret scanner sees no key block. */
    const pemEdge = (edge: string) => `-----${edge} ${["PRIVATE", "KEY"].join(" ")}-----`;
    const pem = `${pemEdge("BEGIN")}\n${"QUJD".repeat(10_000)}\n${pemEdge("END")}`;
    const secret = "tok\\en-s3cr3t";
    const keySecret = "k\\ey-s3cr3t";
    const redact = (text: string) =>
      Promise.resolve(
        text
          .replace(new RegExp(`${pemEdge("BEGIN")}[\\s\\S]*?${pemEdge("END")}`, "gu"), "[REDACTED:private-key]")
          .replaceAll(secret, "[REDACTED:token]")
          .replaceAll(keySecret, "[REDACTED:key]"),
      );
    const review = new LiveReviewCollector("turn");
    await review.add(
      assistant(
        { type: "thinking", thinking: `The key is ${secret}` },
        { type: "text", text: `Writing ${pem}` },
        { type: "toolCall", id: "c", name: "write", arguments: { path: "id_rsa", content: pem, env: { TOKEN: secret, [keySecret]: "1" } } },
      ),
      redact,
    );
    const text = review.take()?.text ?? "";
    expect(text).not.toContain("QUJD");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain("s3cr3t");
    expect(text).toBe(
      [
        "Reasoning: The key is [REDACTED:token]",
        "Assistant: Writing [REDACTED:private-key]",
        'Tool call write {"path":"id_rsa","content":"[REDACTED:private-key]","env":{"TOKEN":"[REDACTED:token]","[REDACTED:key]":"1"}}',
        "Files touched: id_rsa",
      ].join("\n"),
    );
    const blind = new LiveReviewCollector("turn");
    await blind.add(
      assistant(
        { type: "text", text: "secret" },
        { type: "toolCall", id: "c", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } },
      ),
      () => Promise.reject(new Error("no redact method")),
    );
    await blind.add(toolEnd("bash", true, "failed with tok"), () => Promise.reject(new Error("no redact method")));
    expect(blind.take()?.text).toBe(
      [
        "Assistant: [redaction unavailable: omitted]",
        'Tool call edit {"[redaction unavailable: omitted]":[{"[redaction unavailable: omitted]":"[redaction unavailable: omitted]"}]}',
        "Tool error bash: [redaction unavailable: omitted]",
      ].join("\n"),
    );
  });

  it("the file list stays inside the cap: newest paths first, the rest counted; dropped text lines count in the marker", async () => {
    const review = new LiveReviewCollector("turn");
    for (let i = 0; i < 1000; i++)
      await review.add(
        assistant({
          type: "toolCall",
          id: `c${String(i)}`,
          name: "edit",
          arguments: { path: `src/some/deep/module/path/file-number-${String(i)}.ts`, edits: [] },
        }),
        same,
      );
    for (let i = 0; i < 100; i++) await review.add(assistant({ type: "text", text: `note ${String(i)} ${"z".repeat(1_000)}` }), same);
    const text = review.take()?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(60_000);
    const files = text.split("\n").at(-1) ?? "";
    expect(files.startsWith("Files touched: src/some/deep/module/path/file-number-999.ts, src/some/deep/module/path/file-number-998.ts, ")).toBe(true);
    const listed = /, … and (\d+) more files$/u.exec(files);
    expect(Number(listed?.[1]) + files.split(", ").length - 1).toBe(1000);
    const marker = /^\[… (\d+) earlier tool calls and (\d+) earlier lines omitted; read the files listed\]\n/u.exec(text);
    const lines = text.split("\n");
    expect(Number(marker?.[1]) + lines.filter((line) => line.startsWith("Tool call")).length).toBe(1000);
    expect(Number(marker?.[2]) + lines.filter((line) => line.startsWith("Assistant: note")).length).toBe(100);
    expect(Number(marker?.[2])).toBeGreaterThan(0);
  });
});
