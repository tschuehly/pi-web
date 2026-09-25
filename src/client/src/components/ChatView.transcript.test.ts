// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMessages } from "../chatMessages";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
import { chatStyles } from "./shared";
import type { ToolExecutionView } from "./ToolExecutionView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ChatView transcript density", () => {
  it("keeps thinking expanded and exceptional events individually visible", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messageStart = 40;
    view.isSendingPrompt = true;
    view.messages = [
      { role: "assistant", parts: [{ type: "thinking", text: "## Inspecting the transcript\nMore detail follows." }] },
      {
        role: "tool",
        parts: [{
          type: "toolExecution",
          toolName: "read",
          summary: "/repo/src/file.ts",
          args: { path: "/repo/src/file.ts" },
          status: "error",
          resultText: "read failed",
        }],
      },
      { role: "tool", parts: [{ type: "text", text: "watcher heartbeat" }] },
      { role: "system", parts: [{ type: "text", text: "watcher connected" }] },
      { role: "system", severity: "error", parts: [{ type: "text", text: "session failed" }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: "Done" }],
        meta: { timestamp: "2026-07-10T19:15:30.000Z", model: { provider: "provider", id: "model" }, thinkingLevel: "high" },
      },
    ];

    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const thinking = root.querySelector<HTMLDetailsElement>("details.thinking-group");
    expect(thinking?.open).toBe(true);
    expect(root.querySelector("details.activity-group")).toBeNull();
    expect(root.textContent).not.toContain("No Pi message metadata available");
    expect(root.textContent).not.toContain("provider/model");
    expect(root.textContent).not.toContain("high");

    expect(thinking?.querySelector("summary")?.textContent).toContain("Thinking");
    const thinkingText = thinking?.querySelector<FormattedText>("formatted-text");
    if (thinkingText === undefined || thinkingText === null) throw new Error("Expected visible thinking text");
    await thinkingText.updateComplete;
    expect(thinkingText.shadowRoot?.textContent).toContain("Inspecting the transcript");
    expect(thinkingText.shadowRoot?.textContent).toContain("More detail follows.");

    expect(root.querySelector('[data-scroll-anchor-id="g:40"]')).not.toBeNull();
    expect(root.querySelector('[data-scroll-anchor-id="e:41"]')).not.toBeNull();
    expect(root.querySelector('[data-scroll-anchor-id="e:42"]')).not.toBeNull();

    expect(root.querySelector('[data-scroll-anchor-id="e:42"]')?.classList.contains("error")).toBe(false);
    expect(root.querySelector('[data-scroll-anchor-id="m:43"]')?.classList.contains("error")).toBe(false);
    expect(root.querySelector('[data-scroll-anchor-id="m:44"]')?.classList.contains("error")).toBe(true);

    const timestamp = root.querySelector<HTMLTimeElement>('[data-scroll-anchor-id="m:45"] time.msg-meta');
    expect(timestamp?.dateTime).toBe("2026-07-10T19:15:30.000Z");
    expect(timestamp?.textContent).toBe(new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(timestamp?.dateTime ?? "")));
    expect(timestamp?.getAttribute("aria-label")).toBe(timestamp?.title);

    const tool = root.querySelector<ToolExecutionView>("tool-execution-view");
    if (tool === null) throw new Error("Expected tool execution row");
    await tool.updateComplete;
    const executionDetails = tool.shadowRoot?.querySelector<HTMLDetailsElement>(".tool-card.error");
    expect(executionDetails?.open).toBe(false);
    expect(executionDetails?.querySelector("summary")?.textContent).toContain("✖");
    expect(tool.shadowRoot?.querySelector(".error-text")?.textContent).toBe("read failed");
  });

  it("keeps tool activity between thinking segments in one expanded block and write results outside it", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [
      { role: "assistant", parts: [{ type: "thinking", text: "Before read" }] },
      { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "success", resultText: "contents" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "After read" }] },
      { role: "tool", parts: [{ type: "toolExecution", toolName: "write", summary: "file", status: "success", resultText: "Wrote file" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "After write" }, { type: "text", text: "Done" }] },
    ];
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const thinking = root.querySelectorAll<HTMLDetailsElement>(".thinking-group");
    expect(thinking).toHaveLength(2);
    expect(thinking[0]?.open).toBe(true);
    const nestedActivity = thinking[0]?.querySelector<HTMLDetailsElement>(".activity-group");
    expect(nestedActivity?.open).toBe(false);
    expect(nestedActivity?.querySelector("tool-execution-view")).not.toBeNull();
    const ordered = Array.from(thinking[0]?.querySelectorAll("formatted-text, .activity-group") ?? [], (element) => element.localName);
    expect(ordered).toEqual(["formatted-text", "details", "formatted-text"]);
    expect(root.querySelectorAll(".activity-group")).toHaveLength(1);
    expect(root.querySelectorAll(".event-group:not(.thinking-group):not(.activity-group)")).toHaveLength(1);
    expect(thinking[1]?.querySelector<FormattedText>("formatted-text")?.text).toBe("After write");
    expect(root.querySelector<FormattedText>("article.msg.assistant formatted-text")?.text).toBe("Done");
  });

  it("renders preview errors outside closed Activity even when execution succeeds", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [
      { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "file", status: "success", resultText: "contents" }] },
      { role: "tool", parts: [{ type: "toolExecution", toolName: "edit", summary: "file", status: "success", resultText: "Applied edit", details: { diff: "-before\n+after" }, preview: { error: "Preview failed" } }] },
    ];
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    expect(root.querySelector<HTMLDetailsElement>(".activity-group")?.open).toBe(false);
    const tool = root.querySelector<ToolExecutionView>(".event-group:not(.activity-group) tool-execution-view");
    expect(tool).not.toBeNull();
    expect(root.querySelectorAll(".activity-group tool-execution-view")).toHaveLength(1);
    await tool?.updateComplete;
    const details = tool?.shadowRoot?.querySelector<HTMLDetailsElement>(".tool-card.success");
    expect(details?.open).toBe(true);
    expect(details?.querySelector(".status-icon")?.textContent).toBe("✓");
    expect(details?.querySelector(".tool-row strong")?.textContent).toBe("edit");
    expect(details?.querySelector(".tool-row")?.textContent).toContain("2 lines");
    expect(details?.querySelector(".status-label")?.textContent).toBe("done");
    expect(details?.querySelector(".tool-body > .detail-label")?.textContent).toBe("Preview error");
    expect(details?.querySelector(".error-text")?.textContent).toBe("Preview failed");
    expect(details?.querySelector(".detail-result pre")?.textContent).toBe("Applied edit");
    expect(details?.querySelector(".diff-heading")?.textContent).toContain("Applied diff");
  });

  it("shows an orphan result's preview error outside Activity at a page boundary", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messageStart = 40;
    view.hasMore = true;
    view.messages = normalizeMessages([
      { role: "toolResult", toolCallId: "read-before-page", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false },
      { role: "toolResult", toolCallId: "edit-before-page", toolName: "edit", content: [{ type: "text", text: "Applied edit" }], isError: false, details: { preview: { error: "Preview failed" } } },
    ]);
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    expect(root.querySelector<HTMLDetailsElement>(".activity-group")?.open).toBe(false);
    expect(root.querySelectorAll(".activity-group .tool-result")).toHaveLength(1);
    const result = root.querySelector<HTMLDetailsElement>(".event-group:not(.activity-group) .tool-result");
    expect(result?.open).toBe(true);
    expect(result?.querySelector("summary")?.textContent).toContain("✓ edit result");
    expect(result?.querySelector(".orphan-tool-result")?.textContent).toBe("Applied edit");
    expect(result?.querySelector(".orphan-preview-error")?.textContent).toContain("Preview failed");
  });

  it.each([
    { label: "applied", details: { diff: "-before\n+after" }, isError: true, result: "Patch failed", heading: "Applied diff", status: "failed", icon: "✖" },
    { label: "preview-only", details: { preview: { diff: "-before\n+after", error: "Preview failed" } }, isError: false, result: "Applied edit", heading: "Preview diff", status: "done", icon: "✓" },
  ])("shows an orphan $label diff and result outside Activity at a page boundary", async ({ details, isError, result, heading, status, icon }) => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messageStart = 40;
    view.hasMore = true;
    view.messages = normalizeMessages([
      { role: "toolResult", toolCallId: "read-before-page", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false },
      { role: "toolResult", toolCallId: "edit-before-page", toolName: "edit", content: [{ type: "text", text: result }], isError, details },
    ]);
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    expect(root.querySelectorAll(".activity-group .tool-result")).toHaveLength(1);
    const tool = root.querySelector<ToolExecutionView>(".event-group:not(.activity-group) tool-execution-view");
    expect(tool).not.toBeNull();
    await tool?.updateComplete;
    const card = tool?.shadowRoot?.querySelector<HTMLDetailsElement>(`.tool-card.${isError ? "error" : "success"}`);
    expect(card?.open).toBe(true);
    expect(card?.querySelector(".status-icon")?.textContent).toBe(icon);
    expect(card?.querySelector(".status-label")?.textContent).toBe(status);
    expect(card?.querySelector(".diff-heading")?.textContent).toContain(heading);
    expect(card?.querySelector("pre.diff")?.textContent).toContain("+after");
    expect(card?.querySelector(isError ? ".error-text" : ".detail-result pre")?.textContent).toBe(result);
    if ("preview" in details) expect(card?.querySelector(".error-text")?.textContent).toBe("Preview failed");
  });

  it("keeps execution failure separate from a preview error", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [{ role: "tool", parts: [{ type: "toolExecution", toolName: "edit", summary: "file", status: "error", resultText: "Edit failed", preview: { error: "Preview failed" } }] }];
    document.body.append(view);
    await view.updateComplete;

    const tool = requireShadowRoot(view).querySelector<ToolExecutionView>("tool-execution-view");
    await tool?.updateComplete;
    const details = tool?.shadowRoot?.querySelector<HTMLDetailsElement>(".tool-card.error");
    expect(details?.open).toBe(true);
    expect(details?.querySelector(".status-label")?.textContent).toBe("failed");
    expect(Array.from(details?.querySelectorAll(".error-text") ?? [], (error) => error.textContent)).toEqual(["Edit failed", "Preview failed"]);
    expect(details?.querySelector(".tool-body > .detail-label")?.textContent).toBe("Preview error");
  });

  it("keeps a pending routine tool in the same collapsed Activity on success", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const execution = { type: "toolExecution" as const, toolCallId: "read-1", toolName: "read", summary: "file", status: "pending" as const };
    view.messages = [
      { role: "assistant", parts: [{ type: "thinking", text: "before" }] },
      { role: "tool", parts: [execution] },
      { role: "assistant", parts: [{ type: "thinking", text: "after" }] },
    ];
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const thinking = root.querySelector<HTMLDetailsElement>(".thinking-group");
    const activity = thinking?.querySelector<HTMLDetailsElement>(".activity-group");
    expect(activity?.open).toBe(false);
    expect(activity?.querySelector("summary")?.textContent).toContain("1 step");
    view.messages = [
      { role: "assistant", parts: [{ type: "thinking", text: "before" }] },
      { role: "tool", parts: [{ ...execution, status: "success", resultText: "contents" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "after" }] },
    ];
    await view.updateComplete;
    expect(root.querySelector(".thinking-group")).toBe(thinking);
    expect(thinking?.querySelector(".activity-group")).toBe(activity);
    expect(root.querySelectorAll(".activity-group")).toHaveLength(1);
  });

  it("folds live pending/running Activity before trailing thinking without moving or resetting its disclosure", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    const first = { role: "assistant" as const, parts: [{ type: "thinking" as const, text: "before" }] };
    const tool = (status: "pending" | "running") => ({ role: "tool" as const, parts: [{ type: "toolExecution" as const, toolCallId: "read-1", toolName: "read", summary: "file", status }] });
    const last = { role: "assistant" as const, parts: [{ type: "thinking" as const, text: "after" }] };
    view.messages = [first];
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const thinking = root.querySelector<HTMLDetailsElement>(".thinking-group");
    view.messages = [first, tool("pending")];
    await view.updateComplete;
    const activity = thinking?.querySelector<HTMLDetailsElement>(".activity-group");
    expect(activity).not.toBeNull();
    expect(root.querySelectorAll(".activity-group")).toHaveLength(1);
    activity?.querySelector("summary")?.click();
    expect(activity?.open).toBe(true);

    view.messages = [first, tool("running")];
    await view.updateComplete;
    expect(root.querySelector(".thinking-group")).toBe(thinking);
    expect(thinking?.querySelector(".activity-group")).toBe(activity);
    expect(activity?.open).toBe(true);

    view.messages = [first, tool("running"), last];
    await view.updateComplete;
    expect(root.querySelectorAll(".thinking-group")).toHaveLength(1);
    expect(root.querySelector(".thinking-group")).toBe(thinking);
    expect(thinking?.querySelector(".activity-group")).toBe(activity);
    expect(activity?.open).toBe(true);
    expect(Array.from(thinking?.querySelectorAll("formatted-text, .activity-group") ?? [], (element) => element.localName)).toEqual(["formatted-text", "details", "formatted-text"]);
  });

  it("renders skill lines between thinking segments once and without a separate header", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [
      { role: "assistant", parts: [{ type: "thinking", text: "before" }] },
      { role: "skill", parts: [{ type: "skillRead", toolCallId: "skill-1", name: "guide", path: "/skills/guide/SKILL.md" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "after" }, { type: "text", text: "answer" }] },
    ];
    document.body.append(view);
    await view.updateComplete;
    const root = requireShadowRoot(view);
    const thinking = root.querySelector<HTMLDetailsElement>(".thinking-group");
    expect(root.querySelectorAll(".thinking-group")).toHaveLength(1);
    expect(thinking?.querySelectorAll(".skill-read")).toHaveLength(1);
    expect(thinking?.querySelector(".skill-read-shell")?.textContent.trim()).toBe("Skill: guide");
    expect(thinking?.querySelector(".skill-read-shell .msg-header")).toBeNull();
    expect(root.querySelector<FormattedText>("article.msg.assistant formatted-text")?.text).toBe("answer");
  });

  it("renders only the normal child completion as a collapsed disclosure with the full instruction", async () => {
    const content = "Background children finished. Call `subagent_collect` without an executionId once, then resume the run.\nDo not publish.";
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = normalizeMessages([
      { role: "custom", customType: "pi-workbench:child-completion", content, details: { attention: "terminal-results" } },
      { role: "custom", customType: "pi-workbench:child-completion", content: "Receipt failed; inspect worker_status", details: { receiptStatus: "failed" } },
      { role: "system", content: "Other system notice" },
    ]);
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const card = root.querySelector<HTMLDetailsElement>("details.subagent-completion");
    expect(card?.open).toBe(false);
    expect(card?.querySelector("summary")?.textContent).toBe("Subagents finished");
    expect(card?.closest("article")?.querySelector(".msg-header")).toBeNull();
    expect(card?.querySelector(".subagent-completion-instruction")?.textContent).toBe(content);
    expect(root.querySelectorAll("article.msg.system")).toHaveLength(2);
    expect(Array.from(root.querySelectorAll<FormattedText>("article.msg.system formatted-text"), (text) => text.text)).toEqual([
      "Receipt failed; inspect worker_status", "Other system notice",
    ]);
    card?.querySelector("summary")?.click();
    expect(card?.open).toBe(true);
  });

  it("renders a validated Goal lifecycle as one collapsed accessible card without model-only text", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = normalizeMessages([{ role: "custom", customType: "pi-goal.lifecycle", content: "[pi-goal] automated lifecycle status, not a user instruction: Goal blocked.", details: {
      schemaVersion: 1, goalId: "goal-1", transition: "block", state: "blocked", reason: "Owner approval required", summary: "Checked twice",
    } }]);
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const card = root.querySelector<HTMLDetailsElement>("details.goal-lifecycle");
    expect(card).not.toBeNull();
    expect(card?.open).toBe(false);
    expect(card?.querySelector("summary")?.textContent).toContain("Goal blocked");
    expect(card?.textContent).toContain("Owner approval required");
    expect(card?.textContent).toContain("Checked twice");
    expect(card?.textContent).not.toContain("[pi-goal]");
    expect(root.querySelector("article.msg.system")).toBeNull();
    card?.querySelector("summary")?.click();
    expect(card?.open).toBe(true);
  });

  it("renders a long compaction summary once behind an accessible history boundary", async () => {
    const summary = `## Goal\n${"x".repeat(19_732 - "## Goal\n".length)}`;
    const sourceText = `Compacted history:\n\n${summary}`;
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [
      { role: "system", severity: "error", parts: [{ type: "text", text: "Request aborted" }] },
      { role: "system", source: "compaction", parts: [{ type: "text", text: sourceText }] },
      { role: "system", parts: [{ type: "text", text: "Model changed to openai-codex/gpt-5.6-sol" }] },
      { role: "user", parts: [{ type: "text", text: "Continue" }] },
    ];

    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const boundary = root.querySelector<HTMLDetailsElement>("details.history-summary-group");
    if (boundary === null) throw new Error("Expected history summary disclosure");
    const toggle = boundary.querySelector<HTMLElement>("summary");
    const formatted = boundary.querySelectorAll<FormattedText>("formatted-text");
    expect(boundary.open).toBe(false);
    expect(toggle?.textContent).toContain("1 history compaction summary");
    expect(toggle?.textContent).toContain("Context compacted");
    expect(toggle?.tagName).toBe("SUMMARY");
    toggle?.focus();
    expect(root.activeElement).toBe(toggle);
    expect(formatted).toHaveLength(1);
    expect(formatted[0]?.text).toBe(sourceText);
    expect(root.querySelectorAll(".history-summary-group")).toHaveLength(1);
    expect(root.querySelectorAll("article.msg.system")).toHaveLength(2);
    expect(root.querySelectorAll("article.msg.user")).toHaveLength(1);
    expect(styleText(ChatView.styles)).toMatch(/\.history-summary-group\s*\{[^}]*border-left:\s*3px solid var\(--pi-accent\)/u);

    toggle?.click();
    expect(boundary.open).toBe(true);
    await formatted[0]?.updateComplete;
    expect(formatted[0]?.shadowRoot?.textContent).toContain("Goal");
    expect(formatted[0]?.shadowRoot?.textContent).toContain("x".repeat(200));
  });

  it("uses the same collapsed history disclosure for branch summaries", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [{ role: "system", source: "branch_summary", parts: [{ type: "text", text: "Branch summary:\n\nKeep this branch context." }] }];

    document.body.append(view);
    await view.updateComplete;

    const boundary = requireShadowRoot(view).querySelector<HTMLDetailsElement>("details.history-summary-group");
    expect(boundary?.open).toBe(false);
    expect(boundary?.querySelector("summary")?.textContent).toContain("1 branch summary");
    expect(boundary?.querySelectorAll("formatted-text")).toHaveLength(1);
  });

  it("keeps tool call and error result details closed by default", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [
      { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "src/file.ts", args: { path: "src/file.ts" } }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "read failed", isError: true }] },
    ];

    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const toolCall = root.querySelector<HTMLDetailsElement>("details.tool-line");
    const toolResult = root.querySelector<HTMLDetailsElement>("details.tool-result.error");
    expect(toolCall?.open).toBe(false);
    expect(toolCall?.querySelector("summary")?.textContent).toContain("read");
    expect(toolResult?.open).toBe(false);
    expect(toolResult?.querySelector("summary")?.textContent).toContain("✖ read result");
  });

  it("gives split groups unique anchors and markers and counts executions once", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [{
      role: "assistant",
      parts: [
        { type: "thinking", text: "before" },
        { type: "toolCall", toolCallId: "call-1", toolName: "bash", summary: "echo hi" },
        { type: "toolResult", toolCallId: "call-1", toolName: "bash", text: "hi", isError: false },
        { type: "thinking", text: "after" },
      ],
    }];

    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const groups = Array.from(root.querySelectorAll<HTMLElement>(".event-group"));
    const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"), (element) => element.dataset["scrollAnchorId"]);
    const markers = Array.from(root.querySelectorAll<HTMLElement>(".scroll-marker"), (marker) => marker.dataset["markerId"]);
    expect(groups).toHaveLength(1);
    expect(root.querySelector('.thinking-group [data-scroll-anchor-id="e:0"][data-index="0"]')).not.toBeNull();
    expect(root.querySelectorAll(".thinking-group")).toHaveLength(1);
    expect(root.querySelector(".thinking-group > .activity-group summary")?.textContent).toContain("1 step");
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(new Set(markers).size).toBe(markers.length);
    expect(root.querySelector(".activity-group summary")?.textContent).toContain("1 step");
  });

  it("namespaces every anchor for text-thinking-text fragments", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [{
      role: "assistant",
      parts: [
        { type: "text", text: "before" },
        { type: "thinking", text: "thought" },
        { type: "text", text: "after" },
      ],
    }];

    document.body.append(view);
    await view.updateComplete;

    const anchors = Array.from(requireShadowRoot(view).querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"), (element) => element.dataset["scrollAnchorId"]);
    expect(anchors).toHaveLength(3);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("namespaces every anchor for activity-thinking-activity fragments", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [{
      role: "assistant",
      parts: [
        { type: "toolCall", toolCallId: "first", toolName: "read", summary: "first" },
        { type: "thinking", text: "thought" },
        { type: "toolCall", toolCallId: "second", toolName: "read", summary: "second" },
      ],
    }];

    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"), (element) => element.dataset["scrollAnchorId"]);
    expect(anchors).toHaveLength(4);
    expect(new Set(anchors).size).toBe(anchors.length);
    const markers = Array.from(root.querySelectorAll<HTMLElement>(".scroll-marker"), (element) => element.dataset["markerId"]);
    expect(new Set(markers).size).toBe(markers.length);
  });

  it("keeps the thinking anchor mounted while collapsed activity appends", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messageStart = 8;
    view.messages = [{ role: "assistant", parts: [{ type: "thinking", text: "working" }] }];
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const group = root.querySelector('[data-scroll-anchor-id="g:8"]');
    expect(group).not.toBeNull();

    view.messages = [
      ...view.messages,
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "done", isError: false }] },
    ];
    await view.updateComplete;

    expect(root.querySelector('[data-scroll-anchor-id="g:8"]')).toBe(group);
    const activity = group?.querySelector<HTMLDetailsElement>(".activity-group");
    expect(root.querySelectorAll(".activity-group")).toHaveLength(1);
    expect(activity).not.toBeNull();
    expect(activity?.open).toBe(false);
    expect(activity?.querySelector(".tool-result")?.textContent).toContain("read result");
  });

  it("renders user and assistant messages as distinct chat bubbles with muted thinking parts", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [
      { role: "user", parts: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        parts: [
          { type: "thinking", text: "pondering" },
          { type: "thinking", text: "still pondering" },
          { type: "text", text: "answer" },
          { type: "thinking", text: "after speech" },
        ],
      },
    ];

    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const userBubble = root.querySelector<HTMLElement>("article.msg.user");
    const assistantBubble = root.querySelector<HTMLElement>("article.msg.assistant");
    if (userBubble === null || assistantBubble === null) throw new Error("Expected user and assistant bubbles");

    expect(getComputedStyle(userBubble).borderRadius).toBe("14px");
    expect(getComputedStyle(assistantBubble).borderRadius).toBe("14px");
    // happy-dom cannot resolve color-mix(), so the distinct bubble backgrounds
    // are asserted against the stylesheet source rather than computed color.
    expect(chatStyles.cssText).toMatch(/\.msg\.assistant\s*\{[^}]*background:\s*var\(--pi-surface\)/);
    expect(chatStyles.cssText).toMatch(/\.msg\.user\s*\{[^}]*background:\s*color-mix/);

    // Thinking parts are technical events, so they render outside the assistant
    // bubble as a distinct, muted row rather than as assistant speech.
    const thinking = Array.from(root.querySelectorAll<HTMLElement>(".thinking-group"));
    expect(thinking).toHaveLength(2);
    expect(thinking[0]?.querySelector<FormattedText>("formatted-text")?.text).toBe("pondering\n\nstill pondering");
    expect(thinking[1]?.querySelector<FormattedText>("formatted-text")?.text).toBe("after speech");
    expect(thinking[0]?.closest("article.msg.assistant")).toBeNull();
    expect(getComputedStyle(thinking[0] ?? document.body).fontStyle).toBe("italic");
  });

  it("renders skill loading as one small line without metadata or a path", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [{
      role: "assistant",
      parts: [{ type: "skillRead", name: "testing-guide", path: "/repo/.agents/skills/testing-guide/SKILL.md" }],
      meta: { timestamp: "2026-07-10T19:15:30.000Z" },
    }];

    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const line = root.querySelector(".skill-read-shell");
    expect(line?.textContent.trim()).toBe("Skill: testing-guide");
    expect(line?.querySelector(".msg-header")).toBeNull();
    expect(root.textContent).not.toContain("/repo/.agents");
  });

  it("filters normalized message content without thinking, calls, results or skill activity while retaining raw boundaries", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messageStart = 40;
    view.messageEnd = 44;
    view.messageTotal = 60;
    view.hasMore = true;
    view.workspaceContext = { machineId: "remote", projectId: "p", workspaceId: "w", root: "/work" };
    view.messages = normalizeMessages([
      { role: "user", content: [{ type: "text", text: "human one" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }, { type: "text", text: "answer one [file](result.zip)" }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "secret-file" } }] },
      { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "secret result" }] },
      { role: "system", content: "system line" },
    ]);
    document.body.append(view);
    await view.updateComplete;
    const root = requireShadowRoot(view);
    const toggle = root.querySelector<HTMLButtonElement>(".filter-toggle");
    expect(toggle?.getAttribute("aria-label")).toBe("Filter transcript: Everything");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".filter-options")).toBeNull();
    expect(root.querySelector("tool-execution-view")).not.toBeNull();
    await selectFilter(view, "Human only");
    expect(transcriptText(root)).toContain("human one");
    expect(transcriptText(root)).not.toContain("answer one");
    expect(transcriptText(root)).not.toContain("secret result");
    expect(root.textContent).toContain("Showing messages 41–44 of 60");
    expect(root.querySelector<HTMLButtonElement>(".history-load-button")).not.toBeNull();
    view.messages = [...view.messages, ...normalizeMessages([{ role: "assistant", content: [{ type: "thinking", thinking: "live thought" }, { type: "toolCall", id: "skill-1", name: "read", arguments: { path: "/skills/review/SKILL.md" } }, { type: "text", text: "live answer" }] }])];
    view.messageEnd = 45; await view.updateComplete;
    expect(transcriptText(root)).not.toContain("live answer");
    await selectFilter(view, "Assistant only");
    expect(transcriptText(root)).toContain("answer one");
    expect(transcriptText(root)).toContain("live answer");
    const formatted = root.querySelector<FormattedText>('article.msg.assistant formatted-text');
    await formatted?.updateComplete;
    expect(formatted?.renderRoot.querySelector<HTMLAnchorElement>('a[href*="result.zip"]')?.href).toContain("/machines/remote/projects/p/workspaces/w/file/preview");
    for (const hidden of ["private thought", "live thought", "Skill: review", "secret-file", "secret result", "system line"]) expect(transcriptText(root)).not.toContain(hidden);
    expect(root.querySelector("tool-execution-view, .tool-result, .thinking-group, .skill-read")).toBeNull();
    expect(root.querySelector('[data-scroll-anchor-id="m:41"]')).not.toBeNull();
    await selectFilter(view, "Human + Assistant");
    expect(transcriptText(root)).toContain("human one");
    expect(transcriptText(root)).toContain("live answer");
    for (const hidden of ["private thought", "live thought", "Skill: review", "secret-file", "secret result", "system line"]) expect(transcriptText(root)).not.toContain(hidden);
    expect(root.querySelector("tool-execution-view, .tool-result, .thinking-group, .skill-read")).toBeNull();
    view.messageStart = 39;
    view.messages = [{ role: "user", parts: [{ type: "text", text: "earlier human" }] }, ...view.messages];
    await view.updateComplete;
    expect(root.querySelector('[data-scroll-anchor-id="m:41"]')).not.toBeNull();
    await selectFilter(view, "Human only");
    expect(transcriptText(root)).toContain("earlier human");
    view.sessionId = "session-2"; await view.updateComplete;
    expect(toggle?.getAttribute("aria-label")).toBe("Filter transcript: Everything");
    expect(root.querySelector("tool-execution-view")).not.toBeNull();
  });

  it("explains empty loaded matches and keeps manual history loading available", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [{ role: "tool", parts: [{ type: "text", text: "tool" }] }];
    view.messageStart = 40; view.messageTotal = 41; view.hasMore = true;
    view.onLoadMore = vi.fn();
    document.body.append(view); await view.updateComplete;
    const root = requireShadowRoot(view);
    await selectFilter(view, "Human only");
    expect(root.querySelector(".filter-empty")?.textContent).toContain("No messages matching Human only in loaded history. Load earlier messages");
    root.querySelector<HTMLButtonElement>(".history-load-button")?.click();
    expect(view.onLoadMore).toHaveBeenCalledOnce();
  });

  it("retains the reading position when switching filters and follows new messages only while pinned", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [{ role: "user", parts: [{ type: "text", text: "hello" }] }, { role: "assistant", parts: [{ type: "text", text: "answer" }] }];
    document.body.append(view); await view.updateComplete;
    const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
    if (!chat) throw new Error("Missing transcript scroller");
    Object.defineProperty(chat, "scrollHeight", { configurable: true, value: 400 });
    chat.scrollTop = 100;
    Reflect.set(view, "pinnedToBottom", false);
    const scrollToBottom = vi.fn(); Reflect.set(view, "scrollToBottom", scrollToBottom);
    await selectFilter(view, "Human only");
    expect(chat.scrollTop).toBe(100);
    view.messages = [...view.messages, { role: "assistant", parts: [{ type: "text", text: "new answer" }] }];
    await view.updateComplete;
    expect(scrollToBottom).not.toHaveBeenCalled();
    Reflect.set(view, "pinnedToBottom", true);
    await selectFilter(view, "Assistant only");
    expect(scrollToBottom).toHaveBeenCalled();
    scrollToBottom.mockClear();
    chat.scrollTop = 400;
    view.messages = [...view.messages, { role: "assistant", parts: [{ type: "text", text: "newer answer" }] }];
    await view.updateComplete;
    expect(scrollToBottom).toHaveBeenCalled();
  });

  it("anchors Human-to-Assistant switches by the nearest raw index, even without a shared DOM marker", async () => {
    const view = new ChatView();
    view.sessionId = "session-filter-anchor";
    view.messages = [{ role: "user", parts: [{ type: "text", text: "question" }] }, { role: "assistant", parts: [{ type: "text", text: "answer" }] }];
    document.body.append(view); await view.updateComplete;
    const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
    if (!chat) throw new Error("Missing transcript scroller");
    Object.defineProperty(chat, "scrollHeight", { configurable: true, value: 500 });
    chat.scrollTop = 100;
    Reflect.set(view, "pinnedToBottom", false);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === chat) return DOMRect.fromRect({ y: 0, width: 200, height: 200 });
      const index = this.dataset["index"] ?? this.dataset["markerId"]?.match(/^m:(\d+)/u)?.[1];
      const top = (index === "1" ? 180 : 50) - (chat.scrollTop - 100);
      return DOMRect.fromRect({ y: top, width: 100, height: 20 });
    });
    await selectFilter(view, "Human only");
    expect(chat.scrollTop).toBe(100);
    await selectFilter(view, "Assistant only");
    expect(chat.scrollTop).toBe(230);
  });

  it("does not resume a pending raw-history restore after entering a filtered view", async () => {
    const view = new ChatView();
    view.sessionId = "session-restore-filter";
    view.messages = [{ role: "user", parts: [{ type: "text", text: "latest" }] }];
    view.hasMore = true;
    view.onLoadMore = vi.fn();
    document.body.append(view); await view.updateComplete;
    await selectFilter(view, "Human only");
    Reflect.set(view, "pendingScrollRestoreSessionId", view.sessionId);
    Reflect.set(view, "pendingScrollRestorePosition", { mode: "anchor", anchorId: "e:0", offset: 5 });
    view.messages = [...view.messages]; await view.updateComplete;
    expect(view.onLoadMore).not.toHaveBeenCalled();
  });

  it("exposes three keyboard-operable non-default choices and a way back to Everything", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    document.body.append(view); await view.updateComplete;
    const root = requireShadowRoot(view);
    const toggle = root.querySelector<HTMLButtonElement>(".filter-toggle");
    toggle?.focus();
    expect(root.activeElement).toBe(toggle);
    toggle?.click(); await view.updateComplete;
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-controls")).toBe("transcript-filter-options");
    expect(Array.from(root.querySelectorAll(".filter-options button"), (button) => button.textContent.trim())).toEqual(["Human only", "Assistant only", "Human + Assistant"]);
    await selectFilter(view, "Assistant only");
    expect(toggle?.getAttribute("data-filter-active")).toBe("true");
    expect(toggle?.hasAttribute("aria-pressed")).toBe(false);
    expect(styleText(ChatView.styles)).toMatch(/\.filter-toggle\[data-filter-active="true"\]\s*\{[^}]*border-color:\s*var\(--pi-accent\)/);
    expect(root.activeElement).toBe(toggle);
    toggle?.click(); await view.updateComplete;
    expect(root.querySelector('.filter-options button[aria-pressed="true"]')?.textContent).toBe("Assistant only");
    root.querySelector<HTMLButtonElement>(".filter-options button")?.click(); await view.updateComplete;
    expect(toggle?.getAttribute("aria-label")).toBe("Filter transcript: Everything");
  });

  it("keeps earlier conversation expanded by default", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messageStart = 40;
    view.messages = [
      { role: "user", parts: [{ type: "text", text: "earlier message" }] },
      { role: "assistant", parts: [{ type: "text", text: "earlier response" }] },
      { role: "user", parts: [{ type: "text", text: "current message" }] },
    ];

    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const exchangeHistory = root.querySelector<HTMLDetailsElement>("details.exchange-history");
    expect(exchangeHistory).not.toBeNull();
    expect(exchangeHistory?.open).toBe(true);
  });
});

async function selectFilter(view: ChatView, label: string): Promise<void> {
  const root = requireShadowRoot(view);
  const toggle = root.querySelector<HTMLButtonElement>(".filter-toggle");
  if (toggle?.getAttribute("aria-expanded") !== "true") { toggle?.click(); await view.updateComplete; }
  const option = Array.from(root.querySelectorAll<HTMLButtonElement>(".filter-options button")).find((button) => button.textContent.trim() === label);
  if (!option) throw new Error(`Missing transcript filter option: ${label}`);
  option.click(); await view.updateComplete;
}

function transcriptText(root: ShadowRoot): string {
  return `${root.textContent} ${Array.from(root.querySelectorAll<FormattedText>("formatted-text"), (element) => element.text).join(" ")}`;
}

function requireShadowRoot(view: ChatView): ShadowRoot {
  const root = view.shadowRoot;
  if (root === null) throw new Error("Expected ChatView shadow root");
  return root;
}

function styleText(styles: unknown): string {
  if (Array.isArray(styles)) return styles.map(styleText).join("\n");
  if (typeof styles === "object" && styles !== null && "cssText" in styles && typeof styles.cssText === "string") return styles.cssText;
  return "";
}
