// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { ChatView } from "./ChatView";
import type { ToolExecutionView } from "./ToolExecutionView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatView transcript disclosures", () => {
  it("renders thinking and tool previews without a separate Details disclosure", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
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
          status: "success",
          resultText: "first line\nsecond line",
        }],
      },
    ];

    document.body.append(view);
    await view.updateComplete;

    const root = view.shadowRoot;
    if (root === null) throw new Error("Expected ChatView shadow root");
    const thinkingSummary = Array.from(root.querySelectorAll("summary"))
      .find((summary) => summary.textContent.trim().startsWith("Thinking ·"));
    expect(thinkingSummary?.textContent).toContain("Thinking · Inspecting the transcript");

    const tool = root.querySelector<ToolExecutionView>("tool-execution-view");
    if (tool === null) throw new Error("Expected tool execution row");
    await tool.updateComplete;
    const toolRoot = tool.shadowRoot;
    if (toolRoot === null) throw new Error("Expected ToolExecutionView shadow root");
    const toolSummary = toolRoot.querySelector("summary");
    expect(toolSummary?.textContent).toContain("read");
    expect(toolSummary?.textContent).toContain("src/file.ts");
    expect(toolSummary?.textContent).toContain("2 lines");

    const summaryLabels = [
      ...Array.from(root.querySelectorAll("summary"), (summary) => summary.textContent.trim()),
      ...Array.from(toolRoot.querySelectorAll("summary"), (summary) => summary.textContent.trim()),
    ];
    expect(summaryLabels).not.toContain("Details");
  });
});
