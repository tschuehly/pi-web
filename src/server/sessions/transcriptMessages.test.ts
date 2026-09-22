import { describe, expect, it } from "vitest";
import { historyMessagesFromEntries } from "./transcriptMessages.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import { projectBrowserMessageResponse } from "../browserMessageProjection.js";
import { parseMessagePage } from "../../client/src/api/parsers.js";
import { groupChatMessages } from "../../client/src/chatGroups.js";
import { normalizeMessages } from "../../client/src/chatMessages.js";

describe("durable transcript identity", () => {
  it("propagates entry IDs through paging, browser projection, API parsing and ChatLine mapping", () => {
    const entries = [
      { type: "message", id: "user-1", message: { role: "user", content: "hello" } },
      { type: "thinking_level_change", id: "level-1", thinkingLevel: "high" },
      { type: "message", id: "assistant-1", message: { role: "assistant", id: "provider-id", entryId: "not-authoritative", content: "answer" } },
      { type: "custom_message", id: "hidden", display: false, content: "hidden" },
      { type: "custom_message", id: "custom-1", display: true, content: "notice" },
      { type: "compaction", id: "compact-1", summary: "compact" },
      { type: "branch_summary", id: "branch-1", summary: "branch" },
      { type: "message", id: "user-2", message: { role: "user", content: "next" } },
      { type: "message", id: "bash-1", message: { role: "bashExecution", command: "pwd", output: "/repo" } },
    ];
    const original = structuredClone(entries);
    const messages = historyMessagesFromEntries(entries);
    const linesForPage = (before?: number, limit?: number) => normalizeMessages(parseMessagePage(
      projectBrowserMessageResponse(pageMessagesAtSafeBoundary(messages, { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) })),
    ).messages);

    expect(linesForPage().map((line) => line.entryId)).toEqual([
      "user-1", "assistant-1", "custom-1", "compact-1", "branch-1", "user-2", "bash-1",
    ]);
    expect(linesForPage(5, 1).map((line) => line.entryId)).toEqual([
      "user-1", "assistant-1", "custom-1", "compact-1", "branch-1",
    ]);
    expect(linesForPage()[1]?.meta?.thinkingLevel).toBe("high");
    expect(historyMessagesFromEntries(entries)).toEqual(messages);
    expect(entries).toEqual(original);
  });

  it("filters out aborted and model_change entries but preserves the compaction boundary with user entries", () => {
    const summary = `## Goal\n${"x".repeat(19_732 - "## Goal\n".length)}`;
    const lines = normalizeMessages(historyMessagesFromEntries([
      { type: "message", id: "aborted", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted" } },
      { type: "compaction", id: "compact", summary },
      { type: "model_change", id: "model", provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { type: "message", id: "user", message: { role: "user", content: "Continue" } },
    ]));

    expect(lines.map((line) => line.entryId)).toEqual(["compact", "user"]);
    expect(lines[0]?.parts).toEqual([{ type: "text", text: `Compacted history:\n\n${summary}` }]);
    expect(groupChatMessages(lines)).toEqual([
      { kind: "group", presentation: "history", startIndex: 0, endIndex: 0, messages: [lines[0]] },
      { kind: "message", index: 1, message: lines[1] },
    ]);
  });

  it("does not invent IDs for entries without durable identity", () => {
    const messages = historyMessagesFromEntries([
      { type: "message", message: { role: "user", id: "provider", entryId: "untrusted", content: "legacy" } },
      { type: "message", id: "", message: { role: "assistant", content: "answer" } },
    ]);
    expect(messages).toEqual([{ role: "user", id: "provider", content: "legacy" }, { role: "assistant", content: "answer" }]);
    expect(normalizeMessages(messages).every((line) => !("entryId" in line))).toBe(true);
  });
});
