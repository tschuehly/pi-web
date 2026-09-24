import { describe, expect, it } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE, type AskUserOutcome } from "../../shared/apiTypes";
import { groupChatMessages } from "./chatGroups";
import { appendText, appendThinking, normalizeMessage, normalizeMessages, textMessage } from "./chatMessages";

const askUserOutcome: AskUserOutcome = {
  askId: "ask-1",
  reason: "submitted",
  askedAt: "2026-07-20T10:00:00.000Z",
  closedAt: "2026-07-20T10:05:00.000Z",
  questions: [
    {
      question: { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] },
      answered: true,
      values: ["pg"],
    },
    {
      question: { id: "cache", question: "Which cache?", options: [{ value: "redis", label: "Redis" }] },
      answered: false,
      values: [],
    },
  ],
  answeredCount: 1,
  unansweredIds: ["cache"],
  summary: "Answered 1 of 2; unanswered: cache",
};

const supersededAskUserOutcome: AskUserOutcome = {
  ...askUserOutcome,
  reason: "superseded",
  questions: askUserOutcome.questions.map((record) => ({ question: record.question, answered: false, values: [] })),
  answeredCount: 0,
  unansweredIds: ["db", "cache"],
  summary: "Answered 0 of 2; unanswered: db, cache",
};

describe("chat message normalization", () => {
  it("normalizes simple text messages and drops empty content", () => {
    expect(normalizeMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "unknown", content: "system text" },
    ])).toEqual([
      textMessage("user", "hello"),
      textMessage("system", "system text"),
    ]);
  });

  it("preserves already-normalized chat lines", () => {
    const line = { role: "assistant" as const, parts: [{ type: "text" as const, text: "cached" }] };

    expect(normalizeMessage(line)).toEqual([line]);
    expect(normalizeMessages([{ role: "user", content: "raw" }, line])).toEqual([textMessage("user", "raw"), line]);
  });

  it("projects only the normal child completion notice in live and history normalization", () => {
    const content = "Background children finished. Call `subagent_collect` without an executionId once, then resume.";
    const notice = { role: "custom", customType: "pi-workbench:child-completion", content, details: { attention: "terminal-results" }, entryId: "wake-1" };
    const projected = { role: "system", entryId: "wake-1", parts: [{ type: "subagentCompletion", text: content }] };
    expect(normalizeMessage(notice)).toEqual([projected]);
    expect(normalizeMessages([notice])).toEqual([projected]);
    for (const other of [
      { ...notice, role: "system" },
      { ...notice, customType: "other" },
      { ...notice, details: { attention: "receipt-failure" } },
      { ...notice, details: { attention: "terminal-results", receiptStatus: "failed" } },
      { ...notice, details: undefined },
    ]) expect(normalizeMessages([other])).toEqual([{ role: "system", entryId: "wake-1", parts: [{ type: "text", text: content }] }]);
  });

  it("projects ask_user answer messages into visible read-only record parts", () => {
    const normalized = normalizeMessage({
      role: "custom",
      customType: ASK_USER_ANSWERS_CUSTOM_TYPE,
      content: "model-facing answer text",
      details: askUserOutcome,
    });
    const recordLine = { role: "system" as const, parts: [{ type: "askUserRecord" as const, outcome: askUserOutcome }] };

    expect(normalized).toEqual([recordLine]);
    expect(groupChatMessages(normalized)).toEqual([{ kind: "message", index: 0, message: recordLine }]);
  });

  it("projects the upstream Goal lifecycle schema instead of its model-facing fallback text", () => {
    const details = { schemaVersion: 1, goalId: "goal-1", transition: "block", state: "blocked", reason: "Owner approval required", summary: "Checked twice" };
    const message = { role: "custom", customType: "pi-goal.lifecycle", content: "[pi-goal] automated lifecycle status, not a user instruction: Goal blocked.", details, entryId: "entry-1" };
    expect(normalizeMessage(message)).toEqual([{ role: "system", entryId: "entry-1", parts: [{ type: "goalLifecycle", details }] }]);

    for (const [transition, state] of Object.entries({ start: "active", resume: "active", pause: "paused", wait: "waiting", block: "blocked", usage_limit: "usage_limited", budget_limit: "budget_limited", complete: "complete", clear: "cleared" })) {
      expect(normalizeMessage({ ...message, details: { schemaVersion: 1, goalId: "goal-1", transition, state } })[0]?.parts[0]).toMatchObject({ type: "goalLifecycle", details: { transition, state } });
    }
  });

  it("rejects malformed Goal lifecycle details without trusting partial fields", () => {
    const content = "[pi-goal] automated lifecycle status, not a user instruction: Goal blocked.";
    const valid = { schemaVersion: 1, goalId: "goal-1", transition: "block", state: "blocked" };
    for (const details of [
      { ...valid, schemaVersion: 2 }, { ...valid, state: "active" }, { ...valid, transition: "resumed" },
      { ...valid, kind: "blocked" }, { ...valid, eventId: "event-1" }, { ...valid, objective: "private" },
      { ...valid, goalId: " goal-1" }, { ...valid, goalId: "goal\u200d-1" },
      { ...valid, reason: " " }, { ...valid, summary: "x".repeat(401) },
      { ...valid, reason: "bad\u001b[31m" }, { ...valid, summary: "two  spaces" },
      { ...valid, goalId: "🚀".repeat(128), reason: "🚀".repeat(400), summary: "🚀".repeat(400) },
    ]) expect(normalizeMessage({ role: "custom", customType: "pi-goal.lifecycle", content, details })).toEqual([textMessage("system", content)]);
    expect(normalizeMessage({ role: "custom", customType: "other.lifecycle", content, details: valid })).toEqual([textMessage("system", content)]);
  });

  it("falls back to model-facing text when an ask_user answer record is malformed", () => {
    expect(normalizeMessage({
      role: "custom",
      customType: ASK_USER_ANSWERS_CUSTOM_TYPE,
      content: "Answered 0 of 1; unanswered: db",
      details: { askId: "missing-the-rest" },
    })).toEqual([textMessage("system", "Answered 0 of 1; unanswered: db")]);
  });

  it("projects a superseded ask from the later ask_user tool result", () => {
    const normalized = normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask_user", arguments: { questions: [] } }] },
      {
        role: "toolResult",
        toolCallId: "ask-call",
        toolName: "ask_user",
        content: [{ type: "text", text: "Posted a newer question set." }],
        details: { ask: { askId: "ask-2" }, superseded: supersededAskUserOutcome },
        isError: false,
      },
    ]);

    expect(normalized[1]).toEqual({ role: "tool", parts: [{ type: "askUserRecord", outcome: supersededAskUserOutcome }] });
    expect(groupChatMessages(normalized).map((group) => group.kind)).toEqual(["group", "message"]);
  });

  it("normalizes tool calls and tool results", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "toolCall", name: "topic_post", arguments: { topicId: "focus", text: "hi" } }] })).toEqual([]);
    expect(normalizeMessage({ role: "toolResult", toolName: "topic_post", content: [{ type: "text", text: "Posted to focused topic" }] })).toEqual([]);
    expect(normalizeMessage({ role: "toolResult", toolName: "topic_open", details: { topicId: "files", title: "Files" }, content: [{ type: "text", text: "Opened topic files" }] })).toEqual([
      { role: "system", parts: [{ type: "topicLink", topicId: "files", title: "Files" }] },
    ]);
    expect(normalizeMessage({ role: "assistant", content: [{ type: "text", text: "Orchestrator update" }, { type: "toolCall", name: "topic_post", arguments: { topicId: "focus", text: "hi" } }] })).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "Orchestrator update" }] },
    ]);
    expect(normalizeMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] })).toEqual([
      { role: "assistant", parts: [{ type: "toolCall", toolName: "bash", summary: "npm test", args: { command: "npm test" } }] },
    ]);
    expect(normalizeMessage({ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "failed" }] })).toEqual([
      { role: "tool", parts: [{ type: "toolResult", toolName: "bash", text: "failed", content: [{ type: "text", text: "failed" }], isError: true }] },
    ]);
  });

  it("normalizes image content into image parts", () => {
    expect(normalizeMessage({ role: "user", content: [{ type: "text", text: "see this" }, { type: "image", mimeType: "image/png", data: "QUJD" }] })).toEqual([
      { role: "user", parts: [{ type: "text", text: "see this" }, { type: "image", mimeType: "image/png", data: "QUJD" }] },
    ]);
  });

  it("falls back to a placeholder for image content without data", () => {
    expect(normalizeMessage({ role: "user", content: [{ type: "image", mimeType: "image/png" }] })).toEqual([
      { role: "user", parts: [{ type: "text", text: "[image]" }] },
    ]);
  });

  it("carries the thinking level into assistant message metadata", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], provider: "openai", model: "gpt-4.1", timestamp: "2026-05-09T12:00:00.000Z", thinkingLevel: "max" })).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "hi" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "openai", id: "gpt-4.1" }, thinkingLevel: "max" } },
    ]);
  });

  it("carries the server-stamped entry id through normalization", () => {
    expect(normalizeMessage({ role: "user", content: [{ type: "text", text: "hi" }], entryId: "entry-1" })).toEqual([
      { role: "user", parts: [{ type: "text", text: "hi" }], entryId: "entry-1" },
    ]);
  });

  it("shows assistant model errors as system chat messages", () => {
    expect(normalizeMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit", timestamp: "2026-05-09T12:00:00.000Z", provider: "openai", model: "gpt-4.1" })).toEqual([
      { role: "system", parts: [{ type: "text", text: "Model response failed: 429 rate limit" }], severity: "error", meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "openai", id: "gpt-4.1" } } },
    ]);
  });

  it("keeps partial assistant content and adds a visible error line", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: "error", errorMessage: "connection lost" })).toEqual([
      textMessage("assistant", "partial answer"),
      { ...textMessage("system", "Model response failed: connection lost"), severity: "error" },
    ]);
  });

  it("extracts skill invocation blocks into dedicated skill and user messages", () => {
    expect(normalizeMessage({ role: "user", content: "<skill name=\"playwright\" location=\"/skills/playwright\">\nUse browser\n</skill>\n\nNow test the UI" })).toEqual([
      { role: "user", parts: [{ type: "skillInvocation", name: "playwright", location: "/skills/playwright", content: "Use browser" }] },
      textMessage("user", "Now test the UI"),
    ]);
  });

  it("preserves ordered inline skills and surrounding text in one user message", () => {
    const block = (name: string) => `<skill name="${name}" location="/skills/${name}">\nUse <${name}>\n</skill>`;
    const content = `Before <unsafe>\n${block("a")} middle\n${block("b")} after`;
    expect(normalizeMessage({ role: "user", content, entryId: "entry-1" })).toEqual([{
      role: "user", entryId: "entry-1", parts: [
        { type: "text", text: "Before <unsafe>\n" },
        { type: "skillInvocation", name: "a", location: "/skills/a", content: "Use <a>" },
        { type: "text", text: " middle\n" },
        { type: "skillInvocation", name: "b", location: "/skills/b", content: "Use <b>" },
        { type: "text", text: " after" },
      ],
    }]);
    expect(normalizeMessage({ role: "user", content: `${block("a")}\n<skill broken>` })).toEqual([{
      role: "user", parts: [
        { type: "skillInvocation", name: "a", location: "/skills/a", content: "Use <a>" },
        { type: "text", text: "\n<skill broken>" },
      ],
    }]);
  });

  it("normalizes skill reads into skill chat lines", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/home/user/.agents/skills/playwright/SKILL.md" } }] })).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/home/user/.agents/skills/playwright/SKILL.md" }] },
    ]);
  });

  it("keeps the call's entry id on a merged tool execution line", () => {
    expect(normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } }], entryId: "call-entry" },
      { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "ok" }], details: {}, isError: false, entryId: "result-entry" },
    ])).toEqual([
      expect.objectContaining({ entryId: "call-entry" }),
    ]);
  });

  it("pairs tool calls and results into execution cards when normalizing history", () => {
    expect(normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
      { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new" }, isError: false },
    ])).toEqual([
      {
        role: "tool",
        parts: [{
          type: "toolExecution",
          toolCallId: "edit-1",
          toolName: "edit",
          summary: "src/app.ts",
          args: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] },
          status: "success",
          resultText: "ok",
          content: [{ type: "text", text: "ok" }],
          details: { diff: "-1 old\n+1 new" },
        }],
      },
    ]);
  });

  it("formats bash execution records as bash chat lines", () => {
    expect(normalizeMessage({
      role: "bashExecution",
      command: "npm test",
      excludeFromContext: true,
      output: "ok",
      exitCode: 0,
      truncated: true,
      fullOutputPath: "/tmp/out.log",
    })).toEqual([
      textMessage("bash", "excluded from context\n\n$ npm test\n\nok\n\nexit 0\n\noutput truncated\n\nfull output: /tmp/out.log"),
    ]);
  });
});

describe("appendText", () => {
  it("appends to the previous same-role text message", () => {
    expect(appendText([textMessage("assistant", "hello")], "assistant", " world")).toEqual([
      textMessage("assistant", "hello world"),
    ]);
  });

  it("starts a new message when role does not match", () => {
    expect(appendText([textMessage("user", "hello")], "assistant", "hi")).toEqual([
      textMessage("user", "hello"),
      textMessage("assistant", "hi"),
    ]);
  });

  it("adds a text part to the previous same-role non-text message", () => {
    expect(appendText([{ role: "assistant", parts: [{ type: "thinking", text: "plan" }] }], "assistant", "answer")).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }] },
    ]);
  });
});

describe("appendThinking", () => {
  it("appends thinking deltas to the previous assistant thinking part", () => {
    expect(appendThinking([{ role: "assistant", parts: [{ type: "thinking", text: "pla" }] }], "n")).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }] },
    ]);
  });

  it("adds a thinking part to the previous assistant message", () => {
    expect(appendThinking([textMessage("assistant", "answer")], "plan")).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "answer" }, { type: "thinking", text: "plan" }] },
    ]);
  });
});
