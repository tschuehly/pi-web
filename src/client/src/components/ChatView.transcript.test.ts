// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
import { chatStyles } from "./shared";
import type { ToolExecutionView } from "./ToolExecutionView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
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
    const activity = root.querySelector<HTMLDetailsElement>('[data-scroll-anchor-id="g:9"].activity-group');
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

function requireShadowRoot(view: ChatView): ShadowRoot {
  const root = view.shadowRoot;
  if (root === null) throw new Error("Expected ChatView shadow root");
  return root;
}
