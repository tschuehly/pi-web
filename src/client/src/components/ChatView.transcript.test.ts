// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMessages } from "../chatMessages";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";


import type { BashLogButton } from "./BashLogButton";
import { api } from "../api";
import { hasRenderedModal } from "./modalLayerRegistry";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ChatView transcript density", () => {
  it("shows a polite activity chip during work but not while idle", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.activity = { sessionId: "session-1", phase: "idle", label: "idle", at: "2026-07-20T00:00:00.000Z" };
    document.body.append(view);
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".activity-dock")).toBeNull();

    view.activity = { sessionId: "session-1", phase: "active", label: "Receiving response", at: "2026-07-20T00:00:01.000Z" };
    await view.updateComplete;
    const chip = view.shadowRoot?.querySelector(".activity-dock");
    expect(chip?.textContent).toContain("Receiving response");
    expect(chip?.getAttribute("aria-live")).toBe("polite");

    view.activity = { sessionId: "session-1", phase: "idle", label: "tool complete", at: "2026-07-20T00:00:02.000Z" };
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".activity-dock")).toBeNull();

    view.activity = { sessionId: "session-1", phase: "error", label: "Session failed", at: "2026-07-20T00:00:03.000Z" };
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".activity-dock")?.textContent).toContain("Session failed");
  });

  it("says when a folded tool call is running and keeps a failed call visible outside the fold", async () => {
    const view = new ChatView();
    view.messages = [
      { role: "assistant", parts: [{ type: "thinking", text: "Before" }] },
      { role: "tool", parts: [{ type: "toolExecution", toolCallId: "b", toolName: "bash", summary: "sleep", status: "running" }] },
      { role: "tool", parts: [{ type: "toolExecution", toolCallId: "c", toolName: "read", summary: "x", status: "success", resultText: "ok" }] },
      { role: "tool", parts: [{ type: "toolExecution", toolCallId: "a", toolName: "bash", summary: "ls", status: "error", resultText: "boom" }] },
      { role: "assistant", parts: [{ type: "thinking", text: "After" }] },
    ];
    document.body.append(view);
    await view.updateComplete;
    const root = requireShadowRoot(view);
    const folds = [...root.querySelectorAll(".thinking-group details.tool-fold")];
    expect(folds.map((fold) => fold.querySelector("summary")?.textContent.replace(/\s+/g, " ").trim())).toEqual(["2 tool calls · running"]);
    const failed = [...root.querySelectorAll("tool-execution-view")].find((row) => row.closest("details.tool-fold") === null);
    expect(failed).toBeDefined();
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

  it("renders separate collapsed background bash cards with output and a copyable log path", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = normalizeMessages([0, 1].map((index) => ({ role: "custom", customType: "background-bash",
      content: `Background bash job-${String(index)} complete (exit 0).\nFull output (available until session shutdown): /tmp/job-${String(index)}.log\nresult ${String(index)}`,
      details: { id: `job-${String(index)}`, command: `npm test ${String(index)}`, state: "complete", exitCode: 0, elapsedSeconds: 9, bytes: 8, logPath: `/tmp/job-${String(index)}.log` },
    })));
    document.body.append(view);
    await view.updateComplete;
    const cards = view.shadowRoot?.querySelectorAll<HTMLDetailsElement>("details.background-bash-card");
    expect(cards).toHaveLength(2);
    expect(view.shadowRoot?.querySelectorAll("article.msg.system")).toHaveLength(0);
    expect(cards?.[0]?.open).toBe(false);
    expect(cards?.[0]?.querySelector("summary")?.textContent).toContain("npm test 0");
    expect(cards?.[0]?.querySelector("summary")?.textContent).toContain("9s");
    expect(cards?.[0]?.querySelector("summary")?.textContent).toContain("exit 0");
    expect(cards?.[0]?.querySelector("pre")?.textContent).toBe("result 0");
    const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    try {
      const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
      cards?.[0]?.querySelector("summary")?.click();
      expect(cards?.[0]?.open).toBe(true);
      cards?.[0]?.querySelector<HTMLButtonElement>('button[aria-label="Copy log path"]')?.click();
      await vi.waitFor(() => { expect(copy).toHaveBeenCalledWith("/tmp/job-0.log"); });
    } finally {
      if (secure === undefined) Reflect.deleteProperty(window, "isSecureContext");
      else Object.defineProperty(window, "isSecureContext", secure);
    }
  });

  it("shows a background bash description instead of its command and opens the full log in a modal", async () => {
    const logPath = "/Users/me/.pi-workbench/background-bash/jobs/job-3/output.log";
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValue({ path: "output.log", encoding: "utf8", size: 12, modifiedAt: "2026-09-01T00:00:00.000Z", content: "line 1\nline 2", truncated: false, binary: false });
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = normalizeMessages([{ role: "custom", customType: "background-bash",
      content: `Background bash job-3 complete (exit 0).\nFull output: ${logPath}\nok`,
      details: { id: "job-3", command: "npm run build -- --mode production", description: "Build the production bundle", state: "complete", exitCode: 0, elapsedSeconds: 3, bytes: 2, logPath },
    }]);
    document.body.append(view);
    await view.updateComplete;
    const card = view.shadowRoot?.querySelector<HTMLDetailsElement>("details.background-bash-card");
    const summary = card?.querySelector("summary");
    expect(summary?.textContent).toContain("Build the production bundle");
    expect(summary?.textContent).not.toContain("npm run build");
    expect(card?.querySelector(".background-bash-full-command")?.textContent).toBe("npm run build -- --mode production");

    const button = summary?.querySelector<BashLogButton>("bash-log-button");
    await button?.updateComplete;
    const inspect = button?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Show full log"]');
    inspect?.focus();
    inspect?.click();
    expect(card?.open).toBe(false);
    expect(read).toHaveBeenCalledWith("folder", "folder:/Users/me/.pi-workbench/background-bash/jobs/job-3", "output.log", "local");
    await vi.waitFor(() => { expect(button?.shadowRoot?.querySelector("pre")?.textContent).toBe("line 1\nline 2"); });
    const dialog = button?.shadowRoot?.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    expect(hasRenderedModal(document)).toBe(true);
    expect(button?.shadowRoot?.activeElement).toBe(button?.shadowRoot?.querySelector(".close"));
    dialog?.dispatchEvent(new Event("cancel", { cancelable: true }));
    await button?.updateComplete;
    expect(dialog?.open).toBe(false);
    expect(hasRenderedModal(document)).toBe(false);
    expect(button?.shadowRoot?.activeElement).toBe(inspect);
  });

  it("renders each Working Mode block as one collapsed line of what changed, with the full guidance on expand", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = normalizeMessages([{ role: "custom", customType: "working-mode", content: `<working-mode seq="1">\nThomas selected Working Mode Alignment: Align · Attention: Switching · Checking: Default · Orchestration: Workers.
This is behavior guidance, not permission; explicit owner direction and repository instructions still apply.

Alignment — Align: Check shared understanding.

Attention — Switching: Batch questions.

Orchestration — Workers: Use a scope-owning worker.

This block replaces every earlier <working-mode> block.
</working-mode>`, details: { schemaVersion: 2, seq: 1, selection: { alignment: "Align", attention: "Switching", checking: "Default", orchestration: "Workers" } } },
    { role: "user", content: "next" },
    { role: "custom", customType: "working-mode", content: "<working-mode seq=\"2\">\nAttention — Focused: Stay here.\n\nChecking — Exercise: Run it.\n</working-mode>", details: { schemaVersion: 2, seq: 2, selection: { alignment: "Align", attention: "Focused", checking: "Exercise", orchestration: "Workers" } } },
    { role: "custom", customType: "working-mode", content: "<working-mode seq=\"3\">\n</working-mode>", details: { schemaVersion: 2, seq: 3, selection: { alignment: "Default", attention: "Default", checking: "Default", orchestration: "Main" } } }]);
    document.body.append(view);
    await view.updateComplete;

    const root = requireShadowRoot(view);
    const cards = [...root.querySelectorAll<HTMLDetailsElement>("details.working-mode-card")];
    expect(cards.map((card) => card.querySelector("summary")?.textContent.trim())).toEqual([
      "Working Mode: Alignment Align · Attention Switching · Orchestration Workers",
      "Working Mode: Attention Switching → Focused · Checking Default → Exercise",
      "Working Mode reset to defaults",
    ]);
    const card = cards[0];
    expect(card?.open).toBe(false);
    expect(card?.querySelectorAll("dt")).toHaveLength(4);
    expect(card?.textContent).toContain("Batch questions.");
    expect(root.textContent).not.toContain("<working-mode");
    expect(root.querySelector("article.msg.system")).toBeNull();
    expect([...root.querySelectorAll(".msg-header .label")].map((label) => label.textContent)).not.toContain("system");
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
