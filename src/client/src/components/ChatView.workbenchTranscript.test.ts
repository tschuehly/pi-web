// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { PendingAskUser } from "../api";
import type { ChatLine, ToolExecutionPart } from "../chatTypes";
import { ChatView, conversationMeterPosition, filterChatGroups } from "./ChatView";
import { groupChatMessages } from "../chatGroups";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

const tool = (id: string, status: ToolExecutionPart["status"], toolName = "read"): ChatLine => ({
  role: "tool", entryId: `tool-${id}`, parts: [{ type: "toolExecution", toolCallId: id, toolName, summary: id, status, args: { path: `${id}.ts` } }],
});

async function mount(messages: ChatLine[], setup: (view: ChatView) => void = () => undefined): Promise<ShadowRoot> {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = messages;
  setup(view);
  document.body.append(view);
  await view.updateComplete;
  if (view.shadowRoot === null) throw new Error("Expected shadow root");
  return view.shadowRoot;
}

// Workbench transcript features carried onto upstream's chat templates.
describe("Workbench transcript on the upstream chat surface", () => {
  it("keeps reasoning open, folds routine tools between it to one line, and leaves a failed tool visible", async () => {
    const root = await mount([
      { role: "user", entryId: "u", parts: [{ type: "text", text: "Go" }] },
      { role: "assistant", entryId: "t1", parts: [{ type: "thinking", text: "first thought" }] },
      tool("a", "success"),
      tool("b", "running"),
      { role: "assistant", entryId: "t2", parts: [{ type: "thinking", text: "second thought" }] },
      tool("c", "error", "bash"),
      { role: "assistant", entryId: "r", parts: [{ type: "text", text: "Done" }] },
    ]);
    const thinking = root.querySelector<HTMLDetailsElement>("details.thinking-group");
    expect(thinking?.open).toBe(true);
    expect([...(thinking?.querySelectorAll(".tool-fold > summary") ?? [])].map((summary) => summary.textContent.replace(/\s+/gu, " ").trim())).toEqual(["2 tool calls · running"]);
    expect(thinking?.querySelectorAll(".thinking-text")).toHaveLength(2);
    const failed = root.querySelector(".visible-events tool-execution-view");
    expect(failed).not.toBeNull();
  });

  it("folds compacted history and routine activity away", async () => {
    const root = await mount([
      { role: "system", entryId: "c", source: "compaction", parts: [{ type: "text", text: "Compacted history:\n\nsummary" }] },
      tool("a", "success"),
      { role: "assistant", entryId: "r", parts: [{ type: "text", text: "Answer" }] },
    ]);
    expect(root.querySelector<HTMLDetailsElement>("details.history-group")?.open).toBe(false);
    expect(root.querySelector("details.history-group summary")?.textContent).toContain("Context compacted");
    expect(root.querySelector("details.activity-group")).toBeNull();
    expect(root.querySelector(".visible-events tool-execution-view")).not.toBeNull();
  });

  it("folds two or more routine steps into Activity", async () => {
    const root = await mount([tool("a", "success"), tool("b", "success"), { role: "assistant", entryId: "r", parts: [{ type: "text", text: "Answer" }] }]);
    expect(root.querySelector<HTMLDetailsElement>("details.activity-group")?.open).toBe(false);
    expect(root.querySelector("details.activity-group summary")?.textContent).toContain("2 steps");
  });

  it("filters the transcript to human and assistant text", () => {
    const messages: ChatLine[] = [
      { role: "user", entryId: "u", parts: [{ type: "text", text: "Hi" }] },
      { role: "assistant", entryId: "a", parts: [{ type: "thinking", text: "hm" }, { type: "text", text: "Hello" }] },
      tool("x", "success"),
    ];
    const groups = groupChatMessages(messages);
    expect(filterChatGroups(groups, "human").map((group) => group.kind === "message" ? group.message.role : group.kind)).toEqual(["user"]);
    expect(filterChatGroups(groups, "human-assistant").map((group) => group.kind === "message" ? group.message.parts.map((part) => part.type).join() : group.kind)).toEqual(["text", "text"]);
  });

  it("renders Working Mode, Goal, background bash and subagent cards without message headers", async () => {
    const root = await mount([
      { role: "system", entryId: "w", parts: [{ type: "workingMode", dials: [{ label: "Pace", value: "fast", guidance: "Move quickly." }] }] },
      { role: "system", entryId: "g", parts: [{ type: "goalLifecycle", details: { schemaVersion: 1, goalId: "goal-1", transition: "start", state: "active" } }] },
      { role: "system", entryId: "b", parts: [{ type: "backgroundBash", details: { id: "job", command: "npm test", state: "failed", elapsedSeconds: 3, logPath: "/tmp/job.log", exitCode: 1 }, output: "boom" }] },
      { role: "system", entryId: "s", parts: [{ type: "subagentCompletion", text: "Collect results" }] },
    ]);
    expect(root.querySelector(".working-mode-card dt")?.textContent).toContain("Pace — fast");
    // The summary leads with the chevron icon, whose template whitespace is text.
    expect(root.querySelector(".goal-lifecycle summary")?.textContent.trim()).toBe("Goal started");
    expect(root.querySelector(".background-bash-card summary")?.textContent).toContain("failed · exit 1 · 3s");
    expect(root.querySelector(".background-bash-card bash-log-button")).toHaveProperty("logPath", "/tmp/job.log");
    expect(root.querySelector(".subagent-completion summary")?.textContent.trim()).toBe("Subagents finished");
    expect(root.querySelectorAll(".msg-header")).toHaveLength(0);
  });

  it("renders every open ask_user set as its own card and reflects the dense tile", async () => {
    const ask = (askId: string): PendingAskUser => ({ askId, askedAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", revision: "", turnsSinceUpdate: 0, questions: [{ id: "q", question: "Which?", options: [] }] });
    let host: ChatView | undefined;
    const root = await mount([], (view) => { view.pendingAsks = [ask("one"), ask("two")]; view.dense = true; host = view; });
    expect([...root.querySelectorAll(".chat > ask-user-card.open-question-card")].map((card) => card.getAttribute("data-scroll-anchor-id"))).toEqual(["ask:one", "ask:two"]);
    expect(host?.hasAttribute("dense")).toBe(true);
  });

  it("presents Workbench bubbles with role and time, the conversation meter and one scroll-to-bottom button", async () => {
    const at = "2026-10-22T09:41:00.000Z";
    const messages: ChatLine[] = [
      { role: "user", entryId: "u", meta: { timestamp: at }, parts: [{ type: "text", text: "Go" }] },
      { role: "assistant", entryId: "a", parts: [{ type: "text", text: "Done" }] },
    ];
    const root = await mount(messages, (view) => { view.workbench = true; view.messageTotal = 2; view.messageEnd = 2; });
    const heading = root.querySelector(".msg.user .conversation-body > .msg-heading");
    expect(heading?.querySelector(".msg-role")?.textContent).toBe("user");
    expect(heading?.querySelector("time")?.getAttribute("datetime")).toBe(at);
    expect(heading?.querySelector("time")?.textContent).toBe(new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(at)));
    expect(root.querySelector(".msg.assistant .msg-heading time")).toBeNull();
    expect(root.querySelector("conversation-meter")).not.toBeNull();
    expect(root.querySelector(".chat-jumps")).toBeNull();
    expect(root.querySelectorAll('button[aria-label="Scroll to bottom"]').length).toBeLessThanOrEqual(1);

    const upstream = await mount(messages);
    expect(upstream.querySelector("conversation-meter")).toBeNull();
    expect(upstream.querySelector(".scroll-to-bottom")).toBeNull();
    expect(upstream.querySelector(".chat-jumps")).not.toBeNull();
  });

  it("places the meter by the first visible message, at the end while following, and reports how much is loaded", () => {
    const base = { messageStart: 50, loaded: 50, total: 101, hasMore: true, following: false };
    expect(conversationMeterPosition({ ...base, firstVisibleIndex: () => 75 })).toEqual({ positionPercent: 75, loadedPercent: 50 / 101 * 100 });
    expect(conversationMeterPosition({ ...base, following: true, firstVisibleIndex: () => 75 }).positionPercent).toBe(100);
    expect(conversationMeterPosition({ ...base, firstVisibleIndex: () => undefined }).positionPercent).toBe(50);
    expect(conversationMeterPosition({ messageStart: 0, loaded: 1, total: 1, hasMore: false, following: false, firstVisibleIndex: () => 0 })).toEqual({ positionPercent: 100, loadedPercent: 100 });
  });
});
