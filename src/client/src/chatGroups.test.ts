import { describe, expect, it } from "vitest";
import { groupChatMessages, summarizeChatGroup } from "./chatGroups";
import type { ChatLine } from "./components/shared";

const text = (role: ChatLine["role"], value: string): ChatLine => ({ role, parts: [{ type: "text", text: value }] });

describe("groupChatMessages", () => {
  it("groups technical parts until a readable message is encountered", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "toolCall", toolName: "read", summary: "file" }] },
      text("assistant", "visible answer"),
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }] },
    ];

    expect(groupChatMessages(messages, 10)).toEqual([
      { kind: "group", presentation: "thinking", startIndex: 10, endIndex: 10, messages: [
        { role: "assistant", parts: [{ type: "thinking", text: "plan" }] },
        { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "file" }] },
      ], messageIndices: [10, 10] },
      { kind: "message", index: 11, message: text("assistant", "visible answer") },
      { kind: "group", presentation: "activity", startIndex: 12, endIndex: 12, messages: [messages[2]] },
    ]);
  });

  it("splits mixed readable and technical parts from a single message", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "shown" }] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "hidden" }] }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }] } },
    ]);
  });

  it("keeps skill reads visible after thinking", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 0, messages: [
        { role: "assistant", parts: [{ type: "thinking", text: "plan" }] },
        { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
      ], messageIndices: [0, 0] },
    ]);
  });

  it("collapses adjacent successful tool activity but keeps errors and edit diffs separate", () => {
    const readCall: ChatLine = { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "file" }] };
    const readSuccess: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "success", resultText: "contents" }] };
    const editDiff: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "edit", summary: "file", status: "success", details: { diff: "+changed" } }] };
    const writeDiff: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "write", summary: "file", status: "success", preview: { diff: "+written" } }] };
    const error: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "bash", text: "failed", isError: true }] };

    expect(groupChatMessages([readCall, readSuccess, editDiff, writeDiff, error])).toEqual([
      { kind: "group", presentation: "activity", startIndex: 0, endIndex: 1, messages: [readCall, readSuccess] },
      { kind: "group", startIndex: 2, endIndex: 4, messages: [editDiff, writeDiff, error] },
    ]);
  });

  it("keeps executions with preview errors outside routine Activity", () => {
    const routine: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "success", resultText: "contents" }] };
    const previewError: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "edit", summary: "file", status: "success", resultText: "unchanged", preview: { error: "Preview failed" } }] };

    expect(groupChatMessages([routine, previewError, routine])).toEqual([
      { kind: "group", presentation: "activity", startIndex: 0, endIndex: 0, messages: [routine] },
      { kind: "group", startIndex: 1, endIndex: 1, messages: [previewError] },
      { kind: "group", presentation: "activity", startIndex: 2, endIndex: 2, messages: [routine] },
    ]);
  });

  it("keeps orphan successful results with preview errors outside routine Activity at a page boundary", () => {
    const routine: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "contents", isError: false }] };
    const orphan: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolCallId: "edit-before-page", toolName: "edit", text: "Applied edit", isError: false, details: { preview: { error: "Preview failed" } } }] };

    expect(groupChatMessages([routine, orphan, routine], 40)).toEqual([
      { kind: "group", presentation: "activity", startIndex: 40, endIndex: 40, messages: [routine] },
      { kind: "group", startIndex: 41, endIndex: 41, messages: [orphan] },
      { kind: "group", presentation: "activity", startIndex: 42, endIndex: 42, messages: [routine] },
    ]);
  });

  it("keeps orphan applied and preview-only diffs outside Activity at a page boundary", () => {
    const routine: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "contents", isError: false }] };
    const applied: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolCallId: "patch-before-page", toolName: "patch", text: "Applied", isError: false, details: { diff: "+applied" } }] };
    const preview: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolCallId: "edit-before-page", toolName: "edit", text: "Previewed", isError: false, details: { preview: { diff: "+preview" } } }] };

    expect(groupChatMessages([routine, applied, preview, routine], 40)).toEqual([
      { kind: "group", presentation: "activity", startIndex: 40, endIndex: 40, messages: [routine] },
      { kind: "group", startIndex: 41, endIndex: 42, messages: [applied, preview] },
      { kind: "group", presentation: "activity", startIndex: 43, endIndex: 43, messages: [routine] },
    ]);
  });

  it("keeps successful diffs visible regardless of the tool name", () => {
    const actualDiff: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "patch", summary: "file", status: "success", details: { diff: "+changed" } }] };
    const previewDiff: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "replace", summary: "file", status: "success", preview: { diff: "+preview" } }] };
    const resultDiff: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "apply", text: "ok", isError: false, details: { diff: "+applied" } }] };

    expect(groupChatMessages([actualDiff, previewDiff, resultDiff])).toEqual([
      { kind: "group", startIndex: 0, endIndex: 2, messages: [actualDiff, previewDiff, resultDiff] },
    ]);
  });

  it("keeps successful write/create/overwrite results individually visible even without diffs", () => {
    for (const toolName of ["write", "create", "overwrite"]) {
      const call: ChatLine = { role: "assistant", parts: [{ type: "toolCall", toolName, summary: "file" }] };
      const execution: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName, summary: "file", status: "success", resultText: "Wrote file" }] };
      const orphan: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName, text: "Wrote file", isError: false }] };
      const groups = groupChatMessages([call, execution, orphan]);
      expect(groups[0]).toMatchObject({ kind: "group", presentation: "activity" });
      expect(groups[1]).toMatchObject({ kind: "group", messages: [execution, orphan] });
      expect(groups[1]).not.toHaveProperty("presentation");
    }
  });

  it("merges thinking across routine tool activity without crossing speech or material output", () => {
    const first: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "first" }] };
    const tool: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "success", resultText: "contents" }] };
    const second: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "second" }] };
    const write: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "write", summary: "file", status: "success", resultText: "Wrote file" }] };
    const third: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "third" }] };
    const groups = groupChatMessages([first, tool, second, text("assistant", "visible answer"), third, write, second]);
    expect(groups[0]).toEqual({ kind: "group", presentation: "thinking", startIndex: 0, endIndex: 2, messages: [first, tool, second], messageIndices: [0, 1, 2] });
    expect(groups[1]).toEqual({ kind: "message", index: 3, message: text("assistant", "visible answer") });
    expect(groups[2]).toMatchObject({ kind: "group", presentation: "thinking", messages: [third] });
    expect(groups[3]).toMatchObject({ kind: "group", messages: [write] });
    expect(groups[4]).toMatchObject({ kind: "group", presentation: "thinking", messages: [second] });

    const error: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "error", resultText: "failed" }] };
    const afterError = groupChatMessages([first, tool, second, error, third]);
    expect(afterError[0]).toMatchObject({ presentation: "thinking", messages: [first, tool, second] });
    expect(afterError[1]).toMatchObject({ messages: [error] });
    expect(afterError[2]).toMatchObject({ presentation: "thinking", messages: [third] });
  });

  it("keeps pending and running routine tools compact through completion, without hiding exceptional tools", () => {
    const routine = (status: "pending" | "running" | "success"): ChatLine => ({ role: "tool", parts: [{ type: "toolExecution", toolCallId: "read-1", toolName: "read", summary: "file", status }] });
    const before = text("assistant", "speech");
    const thinking: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "before" }] };
    const after: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "after" }] };
    for (const status of ["pending", "running", "success"] as const) {
      const groups = groupChatMessages([before, thinking, routine(status), after, text("assistant", "answer")]);
      expect(groups.map((group) => group.kind === "group" ? group.presentation : group.message.parts[0]?.type)).toEqual(["text", "thinking", "text"]);
      expect(groups[1]).toMatchObject({ messages: [thinking, routine(status), after], messageIndices: [1, 2, 3] });
    }
    for (const toolName of ["write", "create", "overwrite"]) {
      expect(groupChatMessages([routine("pending"), { role: "tool", parts: [{ type: "toolExecution", toolName, summary: "file", status: "running" }] }])[1]).toMatchObject({ kind: "group", messages: [{ role: "tool" }] });
    }
    expect(groupChatMessages([{ role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "running", preview: { diff: "+change" } }] }])[0]).not.toHaveProperty("presentation");
  });

  it("keeps skill lines inside thinking without collapsing or reordering speech", () => {
    const thinking = { role: "assistant" as const, parts: [{ type: "thinking" as const, text: "before" }] };
    const skill = { role: "skill" as const, parts: [{ type: "skillRead" as const, name: "guide", path: "/skills/guide/SKILL.md" }] };
    const after = { role: "assistant" as const, parts: [{ type: "thinking" as const, text: "after" }] };
    expect(groupChatMessages([thinking, skill, after, text("assistant", "answer")])).toEqual([
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 2, messages: [thinking, skill, after], messageIndices: [0, 1, 2] },
      { kind: "message", index: 3, message: text("assistant", "answer") },
    ]);
    const tool: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "bash", summary: "ls", status: "running" }] };
    expect(groupChatMessages([thinking, tool, skill, after])[0]).toEqual({
      kind: "group", presentation: "thinking", startIndex: 0, endIndex: 3,
      messages: [thinking, tool, skill, after], messageIndices: [0, 1, 2, 3],
    });
  });

  it("merges adjacent thinking but lets assistant speech separate thinking blocks", () => {
    expect(groupChatMessages([
      { role: "assistant", parts: [{ type: "thinking", text: "first" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "second" }, { type: "text", text: "visible" }, { type: "thinking", text: "third" }] },
    ])).toEqual([
      {
        kind: "group",
        presentation: "thinking",
        startIndex: 0,
        endIndex: 1,
        messages: [
          { role: "assistant", parts: [{ type: "thinking", text: "first" }] },
          { role: "assistant", parts: [{ type: "thinking", text: "second" }] },
        ],
      },
      { kind: "message", index: 1, message: { role: "assistant", parts: [{ type: "text", text: "visible" }] } },
      { kind: "group", presentation: "thinking", startIndex: 1, endIndex: 1, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "third" }] }] },
    ]);
  });

  it("keeps image content visible outside collapsed event groups", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
    const messages: ChatLine[] = [
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "Read image file [image/png]", isError: false }, image] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      {
        kind: "group",
        presentation: "activity",
        startIndex: 0,
        endIndex: 0,
        messages: [{ role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "Read image file [image/png]", isError: false }] }],
      },
      { kind: "tool-image", index: 0, message: { role: "tool", parts: [image] }, toolName: "read" },
    ]);
  });

  it("preserves image metadata when splitting technical and readable parts", () => {
    const meta = { timestamp: "2026-07-13T22:00:00.000Z" };
    const image = { type: "image" as const, mimeType: "image/webp", data: "QUJD" };
    const message: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }, image], meta };

    expect(groupChatMessages([message])).toEqual([
      { kind: "group", presentation: "activity", startIndex: 0, endIndex: 0, messages: [{ role: "tool", parts: [message.parts[0]], meta }] },
      { kind: "tool-image", index: 0, message: { role: "tool", parts: [image], meta }, toolName: "read" },
    ]);
  });

  it("keeps user images as ordinary messages", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
    const message: ChatLine = { role: "user", parts: [image] };

    expect(groupChatMessages([message])).toEqual([
      { kind: "message", index: 0, message },
    ]);
  });

  it("preserves message metadata when grouping", () => {
    const message: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "shown" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "test", id: "model" } } };

    expect(groupChatMessages([message])).toEqual([
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "hidden" }], meta: message.meta }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }], meta: message.meta } },
    ]);
  });

  it("preserves the entry id across split fragments", () => {
    const message: ChatLine = { role: "assistant", parts: [{ type: "text", text: "before" }, { type: "thinking", text: "thought" }, { type: "text", text: "after" }], entryId: "entry-1" };

    expect(groupChatMessages([message])).toEqual([
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "before" }], entryId: "entry-1" } },
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "thought" }], entryId: "entry-1" }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "after" }], entryId: "entry-1" } },
    ]);
  });

  it("isolates long history summaries from adjacent technical and user events", () => {
    const summary = `## Goal\n${"preserve this history exactly\n".repeat(700)}`;
    const aborted: ChatLine = { role: "system", parts: [{ type: "text", text: "Request aborted" }], severity: "error" };
    const compaction: ChatLine = { ...text("system", summary), source: "compaction" };
    const modelChange: ChatLine = text("system", "Model changed to openai-codex/gpt-5.6-sol");
    const user = text("user", "Continue");

    const groups = groupChatMessages([aborted, compaction, modelChange, user]);

    expect(groups).toEqual([
      { kind: "message", index: 0, message: aborted },
      { kind: "group", presentation: "history", startIndex: 1, endIndex: 1, messages: [compaction] },
      { kind: "message", index: 2, message: modelChange },
      { kind: "message", index: 3, message: user },
    ]);
    expect((groups[1]?.kind === "group" ? groups[1].messages[0]?.parts[0] : undefined)).toEqual({ type: "text", text: summary });
  });

  it("keeps adjacent compaction and branch summaries in one history group", () => {
    const messages: ChatLine[] = [
      { ...text("assistant", "summary"), source: "compaction" },
      { ...text("assistant", "branch"), source: "branch_summary" },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", presentation: "history", startIndex: 0, endIndex: 1, messages },
    ]);
  });

  it("keeps a stable group end index when older events are prepended into a group", () => {
    expect(groupChatMessages([
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "older", isError: false }] },
      { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "newer" }] },
      text("assistant", "answer"),
    ], 8)[0]).toMatchObject({ kind: "group", startIndex: 8, endIndex: 9 });
  });
});

describe("summarizeChatGroup", () => {
  it("summarizes special event groups", () => {
    expect(summarizeChatGroup([{ ...text("assistant", "a"), source: "compaction" }])).toBe("1 history compaction summary");
    expect(summarizeChatGroup([
      { ...text("assistant", "a"), source: "branch_summary" },
      { ...text("assistant", "b"), source: "branch_summary" },
    ])).toBe("2 branch summaries");
    expect(summarizeChatGroup([
      { ...text("assistant", "a"), source: "compaction" },
      { ...text("assistant", "b"), source: "branch_summary" },
    ])).toBe("2 history summaries");
  });

  it("summarizes mixed groups by role counts", () => {
    expect(summarizeChatGroup([text("tool", "a"), text("system", "b"), text("tool", "c")])).toBe("3 events · 2 tool · 1 system");
  });
});
