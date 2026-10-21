import { describe, expect, it } from "vitest";
import { canonicalEntryActionHeaders, groupChatMessages, groupConsecutiveImageOutputs, summarizeChatGroup, type ChatGroup } from "./chatGroups";
import type { ChatLine } from "./chatTypes";

const text = (role: ChatLine["role"], value: string): ChatLine => ({ role, parts: [{ type: "text", text: value }] });

describe("groupChatMessages", () => {
  it("groups technical parts until a readable message is encountered", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "toolCall", toolName: "read", summary: "file" }] },
      text("assistant", "visible answer"),
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }] },
    ];

    expect(legacyGroups(groupChatMessages(messages, 10))).toEqual([
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

    expect(legacyGroups(groupChatMessages(messages))).toEqual([
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "hidden" }] }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }] } },
    ]);
  });

  it("keeps skill reads visible after thinking", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
    ];

    expect(legacyGroups(groupChatMessages(messages))).toEqual([
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

    expect(legacyGroups(groupChatMessages([readCall, readSuccess, editDiff, writeDiff, error]))).toEqual([
      { kind: "group", presentation: "activity", startIndex: 0, endIndex: 1, messages: [readCall, readSuccess] },
      { kind: "group", startIndex: 2, endIndex: 4, messages: [editDiff, writeDiff, error] },
    ]);
  });

  it("keeps executions with preview errors outside routine Activity", () => {
    const routine: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "success", resultText: "contents" }] };
    const previewError: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "edit", summary: "file", status: "success", resultText: "unchanged", preview: { error: "Preview failed" } }] };

    expect(legacyGroups(groupChatMessages([routine, previewError, routine]))).toEqual([
      { kind: "group", presentation: "activity", startIndex: 0, endIndex: 0, messages: [routine] },
      { kind: "group", startIndex: 1, endIndex: 1, messages: [previewError] },
      { kind: "group", presentation: "activity", startIndex: 2, endIndex: 2, messages: [routine] },
    ]);
  });

  it("keeps orphan successful results with preview errors outside routine Activity at a page boundary", () => {
    const routine: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "contents", isError: false }] };
    const orphan: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolCallId: "edit-before-page", toolName: "edit", text: "Applied edit", isError: false, details: { preview: { error: "Preview failed" } } }] };

    expect(legacyGroups(groupChatMessages([routine, orphan, routine], 40))).toEqual([
      { kind: "group", presentation: "activity", startIndex: 40, endIndex: 40, messages: [routine] },
      { kind: "group", startIndex: 41, endIndex: 41, messages: [orphan] },
      { kind: "group", presentation: "activity", startIndex: 42, endIndex: 42, messages: [routine] },
    ]);
  });

  it("keeps orphan applied and preview-only diffs outside Activity at a page boundary", () => {
    const routine: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "contents", isError: false }] };
    const applied: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolCallId: "patch-before-page", toolName: "patch", text: "Applied", isError: false, details: { diff: "+applied" } }] };
    const preview: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolCallId: "edit-before-page", toolName: "edit", text: "Previewed", isError: false, details: { preview: { diff: "+preview" } } }] };

    expect(legacyGroups(groupChatMessages([routine, applied, preview, routine], 40))).toEqual([
      { kind: "group", presentation: "activity", startIndex: 40, endIndex: 40, messages: [routine] },
      { kind: "group", startIndex: 41, endIndex: 42, messages: [applied, preview] },
      { kind: "group", presentation: "activity", startIndex: 43, endIndex: 43, messages: [routine] },
    ]);
  });

  it("keeps successful diffs visible regardless of the tool name", () => {
    const actualDiff: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "patch", summary: "file", status: "success", details: { diff: "+changed" } }] };
    const previewDiff: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "replace", summary: "file", status: "success", preview: { diff: "+preview" } }] };
    const resultDiff: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "apply", text: "ok", isError: false, details: { diff: "+applied" } }] };

    expect(legacyGroups(groupChatMessages([actualDiff, previewDiff, resultDiff]))).toEqual([
      { kind: "group", startIndex: 0, endIndex: 2, messages: [actualDiff, previewDiff, resultDiff] },
    ]);
  });

  it("keeps successful write/create/overwrite results individually visible even without diffs", () => {
    for (const toolName of ["write", "create", "overwrite"]) {
      const call: ChatLine = { role: "assistant", parts: [{ type: "toolCall", toolName, summary: "file" }] };
      const execution: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName, summary: "file", status: "success", resultText: "Wrote file" }] };
      const orphan: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName, text: "Wrote file", isError: false }] };
      const groups = legacyGroups(groupChatMessages([call, execution, orphan]));
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
    const groups = legacyGroups(groupChatMessages([first, tool, second, text("assistant", "visible answer"), third, write, second]));
    expect(groups[0]).toEqual({ kind: "group", presentation: "thinking", startIndex: 0, endIndex: 2, messages: [first, tool, second], messageIndices: [0, 1, 2] });
    expect(groups[1]).toEqual({ kind: "message", index: 3, message: text("assistant", "visible answer") });
    expect(groups[2]).toMatchObject({ kind: "group", presentation: "thinking", messages: [third] });
    expect(groups[3]).toMatchObject({ kind: "group", messages: [write] });
    expect(groups[4]).toMatchObject({ kind: "group", presentation: "thinking", messages: [second] });

    const error: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "error", resultText: "failed" }] };
    const afterError = legacyGroups(groupChatMessages([first, tool, second, error, third]));
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
      const groups = legacyGroups(groupChatMessages([before, thinking, routine(status), after, text("assistant", "answer")]));
      expect(groups.map((group) => group.kind === "group" ? group.presentation : group.message.parts[0]?.type)).toEqual(["text", "thinking", "text"]);
      expect(groups[1]).toMatchObject({ messages: [thinking, routine(status), after], messageIndices: [1, 2, 3] });
    }
    for (const toolName of ["write", "create", "overwrite"]) {
      expect(legacyGroups(groupChatMessages([routine("pending"), { role: "tool", parts: [{ type: "toolExecution", toolName, summary: "file", status: "running" }] }]))[1]).toMatchObject({ kind: "group", messages: [{ role: "tool" }] });
    }
    expect(legacyGroups(groupChatMessages([{ role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "running", preview: { diff: "+change" } }] }]))[0]).not.toHaveProperty("presentation");
  });

  it("keeps skill lines inside thinking without collapsing or reordering speech", () => {
    const thinking = { role: "assistant" as const, parts: [{ type: "thinking" as const, text: "before" }] };
    const skill = { role: "skill" as const, parts: [{ type: "skillRead" as const, name: "guide", path: "/skills/guide/SKILL.md" }] };
    const after = { role: "assistant" as const, parts: [{ type: "thinking" as const, text: "after" }] };
    expect(legacyGroups(groupChatMessages([thinking, skill, after, text("assistant", "answer")]))).toEqual([
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 2, messages: [thinking, skill, after], messageIndices: [0, 1, 2] },
      { kind: "message", index: 3, message: text("assistant", "answer") },
    ]);
    const tool: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "bash", summary: "ls", status: "running" }] };
    expect(legacyGroups(groupChatMessages([thinking, tool, skill, after]))[0]).toEqual({
      kind: "group", presentation: "thinking", startIndex: 0, endIndex: 3,
      messages: [thinking, tool, skill, after], messageIndices: [0, 1, 2, 3],
    });
  });

  it("merges adjacent thinking but lets assistant speech separate thinking blocks", () => {
    expect(legacyGroups(groupChatMessages([
      { role: "assistant", parts: [{ type: "thinking", text: "first" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "second" }, { type: "text", text: "visible" }, { type: "thinking", text: "third" }] },
    ]))).toEqual([
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

    expect(legacyGroups(groupChatMessages(messages))).toEqual([
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

    expect(legacyGroups(groupChatMessages([message]))).toEqual([
      { kind: "group", presentation: "activity", startIndex: 0, endIndex: 0, messages: [{ role: "tool", parts: [message.parts[0]], meta }] },
      { kind: "tool-image", index: 0, message: { role: "tool", parts: [image], meta }, toolName: "read" },
    ]);
  });

  it("keeps user images as ordinary messages", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
    const message: ChatLine = { role: "user", parts: [image] };

    expect(legacyGroups(groupChatMessages([message]))).toEqual([
      { kind: "message", index: 0, message },
    ]);
  });

  it("preserves message metadata when grouping", () => {
    const message: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "shown" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "test", id: "model" } } };

    expect(legacyGroups(groupChatMessages([message]))).toEqual([
      { kind: "group", presentation: "thinking", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "hidden" }], meta: message.meta }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }], meta: message.meta } },
    ]);
  });

  it("preserves the entry id across split fragments", () => {
    const message: ChatLine = { role: "assistant", parts: [{ type: "text", text: "before" }, { type: "thinking", text: "thought" }, { type: "text", text: "after" }], entryId: "entry-1" };

    expect(legacyGroups(groupChatMessages([message]))).toEqual([
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

    const raw = groupChatMessages([aborted, compaction, modelChange, user]);
    const groups = legacyGroups(raw);

    expect(groups).toEqual([
      { kind: "message", index: 0, message: aborted },
      { kind: "group", presentation: "history", startIndex: 1, endIndex: 1, messages: [compaction] },
      { kind: "message", index: 2, message: modelChange },
      { kind: "message", index: 3, message: user },
    ]);
    expect(raw[1]?.kind === "group" ? raw[1].messages[0]?.message.parts[0] : undefined).toEqual({ type: "text", text: summary });
  });

  it("keeps adjacent compaction and branch summaries in one history group", () => {
    const messages: ChatLine[] = [
      { ...text("assistant", "summary"), source: "compaction" },
      { ...text("assistant", "branch"), source: "branch_summary" },
    ];

    expect(legacyGroups(groupChatMessages(messages))).toEqual([
      { kind: "group", presentation: "history", startIndex: 0, endIndex: 1, messages },
    ]);
  });

  it("keeps a stable group end index when older events are prepended into a group", () => {
    expect(legacyGroups(groupChatMessages([
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "older", isError: false }] },
      { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "newer" }] },
      text("assistant", "answer"),
    ], 8))[0]).toMatchObject({ kind: "group", startIndex: 8, endIndex: 9 });
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

/** Our assertions predate member indexes: flatten members, keeping indexes only where they skip. */
function legacyGroups(groups: ChatGroup[]): (Exclude<ChatGroup, { kind: "group" }> | (Omit<Extract<ChatGroup, { kind: "group" }>, "messages"> & { messages: ChatLine[]; messageIndices?: number[] }))[] {
  return groups.map((group) => {
    if (group.kind !== "group") return group;
    const { messages, ...rest } = group;
    const indices = messages.map((member) => member.index);
    return { ...rest, messages: messages.map((member) => member.message), ...(indices.every((index, offset) => index === group.startIndex + offset)
      && !(group.presentation === "thinking" && messages.some((member) => member.message.parts.some((part) => part.type !== "thinking"))) ? {} : { messageIndices: indices }) };
  });
}

describe("groupConsecutiveImageOutputs", () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };

  it("combines adjoining image outputs without losing source identities, metadata or absolute indexes", () => {
    const messages: ChatLine[] = [
      { role: "tool", entryId: "first", parts: [image, image], meta: { model: { id: "first-model" } } },
      { role: "tool", entryId: "second", parts: [image], meta: { model: { id: "second-model" } } },
      { role: "tool", entryId: "third", parts: [image] },
    ];
    const sourceGroups = groupChatMessages(messages, 20);
    const displayGroups = groupConsecutiveImageOutputs(sourceGroups);
    expect(displayGroups).toHaveLength(1);
    const gallery = displayGroups[0];
    if (gallery?.kind !== "tool-images") throw new Error("Expected combined image outputs");
    expect(gallery.outputs).toEqual(sourceGroups);
    expect(gallery.outputs.map((output) => output.index)).toEqual([20, 21, 22]);
    expect(gallery.outputs.map((output) => output.message.entryId)).toEqual(["first", "second", "third"]);
    expect(gallery.outputs[1]?.message.meta).toBe(messages[1]?.meta);
    expect(sourceGroups).toHaveLength(3);
    expect(sourceGroups[0]).toBe(gallery.outputs[0]);
  });

  it.each(["user", "assistant", "activity"] as const)("does not combine images across a %s boundary", (boundary) => {
    const between: ChatLine = boundary === "activity"
      ? { role: "assistant", parts: [{ type: "thinking", text: "Inspect another image" }] }
      : { role: boundary, parts: [image] };
    const displayGroups = groupConsecutiveImageOutputs(groupChatMessages([
      { role: "tool", entryId: "before", parts: [image] }, between,
      { role: "tool", entryId: "after", parts: [image] },
    ]));
    expect(displayGroups.map((group) => group.kind)).toEqual(["tool-images", boundary === "activity" ? "group" : "message", "tool-images"]);
  });
});

function renderedMessages(groups: readonly ChatGroup[]): ChatLine[] {
  return groups.flatMap((group) => group.kind === "group" ? group.messages.map((event) => event.message) : [group.message]);
}

describe("canonicalEntryActionHeaders", () => {
  it.each(["user", "assistant"] as const)("prefers the readable %s reply over attached technical parts using rendered identities", (role) => {
    const source: ChatLine = { role, entryId: "entry", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "reply" }] };
    const groups = groupChatMessages([source], 20);
    const slices = renderedMessages(groups);
    const selected = canonicalEntryActionHeaders(groups);

    expect(selected.size).toBe(1);
    expect([...selected][0]).toBe(slices[1]);
    expect(selected.has(source)).toBe(false);
    expect(groups).toHaveLength(2);
    expect(source.parts).toHaveLength(2);
  });

  it("retains a distinct thinking-only entry even when another entry has a reply", () => {
    const groups = groupChatMessages([
      { role: "assistant", entryId: "thinking", parts: [{ type: "thinking", text: "checkpoint" }] },
      { ...text("assistant", "answer"), entryId: "reply" },
    ]);
    const slices = renderedMessages(groups);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual(slices);
  });

  it.each([false, true])("prefers an assistant thinking header over a shared skill-only header (skill first: %s)", (skillFirst) => {
    const thinking: ChatLine = { role: "assistant", entryId: "shared", parts: [{ type: "thinking", text: "checkpoint" }] };
    const skill: ChatLine = { role: "assistant", entryId: "shared", parts: [{ type: "skillRead", name: "example", path: "/skills/example/SKILL.md" }] };
    const groups = groupChatMessages(skillFirst ? [skill, thinking] : [thinking, skill]);
    const slices = renderedMessages(groups);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual(slices.filter((message) => message.role === "assistant"));
    expect(slices.some((message) => message.role === "skill")).toBe(true);
  });

  it("selects a reply after shared skill/thinking slices and keeps stable first-header ties", () => {
    const groups = groupChatMessages([
      { role: "assistant", entryId: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "skillRead", name: "example", path: "/skills/example/SKILL.md" }] },
      { ...text("assistant", "reply"), entryId: "assistant" },
      { ...text("assistant", "another slice"), entryId: "assistant" },
      { role: "user", entryId: "user", parts: [{ type: "skillInvocation", name: "example", location: "/skills/example", content: "instructions" }] },
      { ...text("user", "request"), entryId: "user" },
      { ...text("user", "another request slice"), entryId: "user" },
      { role: "skill", entryId: "skill-only", parts: [{ type: "skillRead", name: "example", path: "/skills/example/SKILL.md" }] },
      { role: "assistant", entryId: "assistant", parts: [{ type: "thinking", text: "later technical slice" }] },
    ]);
    const slices = renderedMessages(groups);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual([
      slices.find((message) => message.parts.some((part) => part.type === "text" && part.text === "reply")),
      slices.find((message) => message.parts.some((part) => part.type === "text" && part.text === "request")),
      slices.find((message) => message.entryId === "skill-only"),
    ]);
  });

  it("selects the rendered tool-image header over its technical result", () => {
    const groups = groupChatMessages([{ role: "tool", entryId: "image", parts: [
      { type: "toolResult", toolName: "read", text: "image result", isError: false },
      { type: "image", mimeType: "image/png", data: "QUJD" },
    ] }]);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual([renderedMessages(groups)[1]]);
  });

  it("skips headerless tool/ask shells and entryless slices without letting them steal a shared entry", () => {
    const execution: ChatLine = { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "success" }] };
    const ask: ChatLine = { role: "tool", parts: [{ type: "askUserRecord", outcome: {
      askId: "ask", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:01:00.000Z",
      questions: [], answeredCount: 0, unansweredIds: [], summary: "No answers",
    } }] };
    const groups = groupChatMessages([
      { ...execution, entryId: "shared" },
      { ...ask, entryId: "shared" },
      { role: "tool", entryId: "shared", parts: [{ type: "toolResult", toolName: "read", text: "legacy result", isError: false }] },
      { ...execution, entryId: "tool-only" },
      { ...ask, entryId: "ask-only" },
      text("assistant", "streaming"),
    ]);
    const slices = renderedMessages(groups);

    expect([...canonicalEntryActionHeaders(groups)]).toEqual([slices[2]]);
    expect(canonicalEntryActionHeaders([]).size).toBe(0);
  });
});
