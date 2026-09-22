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
      { kind: "group", presentation: "thinking", startIndex: 10, endIndex: 10, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "plan" }] }] },
      { kind: "group", presentation: "activity", startIndex: 10, endIndex: 10, messages: [{ role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "file" }] }] },
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
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "plan" }] }] },
      { kind: "message", index: 0, message: { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] } },
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

  it("keeps successful diffs visible regardless of the tool name", () => {
    const actualDiff: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "patch", summary: "file", status: "success", details: { diff: "+changed" } }] };
    const previewDiff: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "replace", summary: "file", status: "success", preview: { diff: "+preview" } }] };
    const resultDiff: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "apply", text: "ok", isError: false, details: { diff: "+applied" } }] };

    expect(groupChatMessages([actualDiff, previewDiff, resultDiff])).toEqual([
      { kind: "group", startIndex: 0, endIndex: 2, messages: [actualDiff, previewDiff, resultDiff] },
    ]);
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

  it("treats compaction and branch summaries as grouped events", () => {
    const messages: ChatLine[] = [
      { ...text("assistant", "summary"), source: "compaction" },
      { ...text("assistant", "branch"), source: "branch_summary" },
    ];

    const groups = groupChatMessages(messages);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "group", startIndex: 0, endIndex: 1 });
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
  });

  it("summarizes mixed groups by role counts", () => {
    expect(summarizeChatGroup([text("tool", "a"), text("system", "b"), text("tool", "c")])).toBe("3 events · 2 tool · 1 system");
  });
});
