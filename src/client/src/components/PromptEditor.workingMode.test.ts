// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { WORKING_MODE_STATUS_KEY } from "../extensionStatusSnapshots";
import { PromptEditor } from "./PromptEditor";
import { WorkingModeControls } from "./WorkingModeControls";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function status(): SessionStatus {
  return {
    sessionId: "session-1", isStreaming: false, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    extensionStatuses: { [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, phase: "selected", selected: { alignment: "Align", checking: "tests" }, applied: null }) },
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected test value");
  return value;
}

describe("PromptEditor Working Mode controls", () => {
  it("renders the Working Mode controls between the model selector and Send, and runs their commands", async () => {
    const run = vi.fn();
    const editor = new PromptEditor();
    editor.status = status();
    editor.onRunCommand = run;
    document.body.append(editor);
    await editor.updateComplete;

    const actions = required(editor.shadowRoot?.querySelector(".actions"));
    const order = [...actions.children].map((child) => child.classList.contains("compact-status") ? "status" : child.classList.contains("usage") ? "usage" : child.classList.contains("send-button") ? "send" : child.localName);
    expect(order.slice(0, 4)).toEqual(["status", "usage", "working-mode-controls", "send"]);

    const controls = required(actions.querySelector<WorkingModeControls>("working-mode-controls"));
    await controls.updateComplete;
    expect(controls.hasAttribute("compact")).toBe(true);
    const buttons = [...required(controls.shadowRoot).querySelectorAll("button")];
    expect(required(buttons.find((button) => button.textContent === "Align")).getAttribute("aria-pressed")).toBe("true");
    required(buttons.find((button) => button.textContent === "Plan")).click();
    expect(run).toHaveBeenCalledWith("/mode alignment plan");
  });

  it("renders accessible usage metrics and updates them when only status usage changes", async () => {
    const editor = new PromptEditor();
    editor.warningCount = 2;
    editor.status = {
      ...status(),
      pendingMessageCount: 3,
      tokens: { input: 434_000, output: 34_000, cacheRead: 0, cacheWrite: 0, total: 468_000 },
      contextUsage: { tokens: 212_704, contextWindow: 272_000, percent: 78.2 },
      cost: 12.42,
    };
    document.body.append(editor);
    await editor.updateComplete;

    expect(metric(editor, "input")).toMatchObject({ textContent: "Input 434k", title: "Input tokens: 434000" });
    expect(metric(editor, "output")).toMatchObject({ textContent: "Output 34k", title: "Output tokens: 34000" });
    expect(metric(editor, "context")).toMatchObject({ textContent: "Context 78.2%", title: "Context: 212704 of 272000 tokens used (78.2%)" });
    expect(metric(editor, "cost")).toMatchObject({ textContent: "Cost $12.42", title: "Session cost: $12.42" });
    expect(metric(editor, "warnings").textContent).toBe("Warnings 2");
    expect(metric(editor, "queued").textContent).toBe("Queued 3");
    for (const element of editor.shadowRoot?.querySelectorAll<HTMLElement>(".usage [data-usage]") ?? []) expect(element.getAttribute("aria-label")).toBe(element.title);

    const currentStatus = required(editor.status);
    editor.status = {
      ...currentStatus,
      pendingMessageCount: 1,
      tokens: { input: 500_000, output: 40_000, cacheRead: 0, cacheWrite: 0, total: 540_000 },
      contextUsage: { tokens: 217_600, contextWindow: 272_000, percent: 80 },
      cost: 12.5,
    };
    await editor.updateComplete;

    expect(metric(editor, "input").textContent).toBe("Input 500k");
    expect(metric(editor, "context").title).toBe("Context: 217600 of 272000 tokens used (80%)");
    expect(metric(editor, "cost").textContent).toBe("Cost $12.50");
    expect(metric(editor, "queued").textContent).toBe("Queued 1");
  });
});

function metric(editor: PromptEditor, name: string): HTMLElement {
  return required(editor.shadowRoot?.querySelector<HTMLElement>(`[data-usage="${name}"]`));
}
