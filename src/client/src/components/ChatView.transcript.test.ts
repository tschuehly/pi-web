// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
import type { ToolExecutionView } from "./ToolExecutionView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatView flat transcript", () => {
  it("renders event rows inline without group summaries or metadata fallback", async () => {
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
    expect(root.querySelector("details.event-group")).toBeNull();
    const summaryLabels = Array.from(root.querySelectorAll("summary"), (summary) => summary.textContent.trim().toLowerCase());
    expect(summaryLabels).not.toContain("events");
    expect(summaryLabels).not.toContain("live events");
    expect(root.textContent).not.toContain("No Pi message metadata available");
    expect(root.textContent).not.toContain("provider/model");
    expect(root.textContent).not.toContain("high");

    const thinking = root.querySelector(".thinking");
    expect(thinking?.tagName).toBe("DIV");
    expect(thinking?.querySelector("details")).toBeNull();
    expect(thinking?.querySelector(".thinking-label")?.textContent).toBe("Thinking");
    const thinkingText = thinking?.querySelector<FormattedText>("formatted-text");
    if (thinkingText === undefined || thinkingText === null) throw new Error("Expected visible thinking text");
    await thinkingText.updateComplete;
    expect(thinkingText.shadowRoot?.textContent).toContain("Inspecting the transcript");
    expect(thinkingText.shadowRoot?.textContent).toContain("More detail follows.");

    expect(root.querySelector('[data-scroll-anchor-id="g:40"]')).not.toBeNull();
    expect(root.querySelector('[data-scroll-anchor-id="e:40"]')).not.toBeNull();
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

  it("keeps the group anchor mounted while streaming rows append", async () => {
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
    expect(root.querySelector('[data-scroll-anchor-id="e:8"]')).not.toBeNull();
    expect(root.querySelector('[data-scroll-anchor-id="e:9"]')).not.toBeNull();
  });
});

function requireShadowRoot(view: ChatView): ShadowRoot {
  const root = view.shadowRoot;
  if (root === null) throw new Error("Expected ChatView shadow root");
  return root;
}
