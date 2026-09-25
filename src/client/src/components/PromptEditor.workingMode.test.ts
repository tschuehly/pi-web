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
    extensionStatuses: { [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 2, phase: "selected", selected: { alignment: "Align", attention: "Default", checking: "Test", orchestration: "Main" }, applied: null }) },
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
    editor.showUsage = true;
    editor.status = status();
    editor.onRunCommand = run;
    document.body.append(editor);
    await editor.updateComplete;

    const actions = required(editor.shadowRoot?.querySelector(".actions"));
    const order = [...actions.children].map((child) => child.classList.contains("compact-status") ? "status" : child.classList.contains("usage") ? "usage" : child.classList.contains("composer-actions") ? "composer-actions" : child.localName);
    expect(order).toEqual(["status", "usage", "working-mode-controls", "composer-actions"]);
    expect(getComputedStyle(actions).flexWrap).toBe("wrap");
    const composerActions = required(actions.querySelector<HTMLElement>(".composer-actions"));
    expect(getComputedStyle(composerActions).flexShrink).toBe("0");
    expect([...composerActions.children].every((child) => child instanceof HTMLButtonElement)).toBe(true);

    const controls = required(actions.querySelector<WorkingModeControls>("working-mode-controls"));
    await controls.updateComplete;
    expect(controls.hasAttribute("compact")).toBe(true);
    const alignment = required(select(controls, "Alignment"));
    expect(alignment.value).toBe("Align");
    expect(alignment.selectedOptions[0]?.textContent).toBe("Alignment: Align");
    alignment.value = "Plan";
    alignment.dispatchEvent(new Event("change"));
    expect(run).toHaveBeenCalledWith("/mode alignment plan");
  });

  it("rerenders Working Mode controls when only their extension status changes", async () => {
    const editor = new PromptEditor();
    editor.status = status();
    document.body.append(editor);
    await editor.updateComplete;

    const controls = required(editor.shadowRoot?.querySelector<WorkingModeControls>("working-mode-controls"));
    await controls.updateComplete;
    expect(select(controls, "Alignment")?.value).toBe("Align");

    editor.status = {
      ...required(editor.status),
      extensionStatuses: { [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 2, phase: "selected", selected: { alignment: "Plan", attention: "Phone", checking: "Challenge", orchestration: "Main" }, applied: null }) },
    };
    await editor.updateComplete;
    await controls.updateComplete;

    expect(select(controls, "Alignment")?.value).toBe("Plan");
    expect(select(controls, "Attention")?.value).toBe("Phone");
    expect(select(controls, "Checking")?.value).toBe("Challenge");
  });

  it("renders compact usage with exact values exposed through semantic list items", async () => {
    const editor = new PromptEditor();
    editor.showUsage = true;
    editor.warningCount = 2;
    editor.status = {
      ...status(),
      pendingMessageCount: 3,
      tokens: { input: 434_000, output: 34_000, cacheRead: 0, cacheWrite: 0, total: 468_000 },
      contextUsage: { tokens: 212_704, contextWindow: 272_000, percent: 78.234567 },
      cost: 12.42,
    };
    document.body.append(editor);
    await editor.updateComplete;

    expect(editor.shadowRoot?.querySelector(".usage")?.localName).toBe("ul");
    expectMetric(editor, "input", "Input 434k", "Input tokens: 434000");
    expectMetric(editor, "output", "Output 34k", "Output tokens: 34000");
    expectMetric(editor, "context", "Context 78.2%", "Context: 212704 of 272000 tokens used (78.234567%)");
    expectMetric(editor, "cost", "Cost $12.42", "Session cost: $12.42");
    expectMetric(editor, "warnings", "Warnings 2", "Session warnings: 2");
    expectMetric(editor, "queued", "Queued 3", "Queued messages: 3");

    const currentStatus = required(editor.status);
    editor.status = {
      ...currentStatus,
      pendingMessageCount: 1,
      tokens: { input: 500_000, output: 40_000, cacheRead: 0, cacheWrite: 0, total: 540_000 },
      contextUsage: { tokens: 217_600, contextWindow: 272_000, percent: 80 },
      cost: 12.5,
    };
    await editor.updateComplete;

    expect(visibleMetricText(editor, "input")).toBe("Input 500k");
    expect(visibleMetricText(editor, "context")).toBe("Context 80.0%");
    expect(accessibleMetricText(editor, "context")).toBe("Context: 217600 of 272000 tokens used (80%)");
    expect(visibleMetricText(editor, "cost")).toBe("Cost $12.50");
    expect(visibleMetricText(editor, "queued")).toBe("Queued 1");
  });

  it("leaves usage metrics hidden by default for legacy PromptEditor hosts", async () => {
    const editor = new PromptEditor();
    editor.status = status();
    document.body.append(editor);
    await editor.updateComplete;

    expect(editor.shadowRoot?.querySelector(".usage")).toBeNull();
  });
});

function select(controls: WorkingModeControls, label: string): HTMLSelectElement | null | undefined {
  return controls.shadowRoot?.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
}

function metric(editor: PromptEditor, name: string): HTMLElement {
  return required(editor.shadowRoot?.querySelector<HTMLElement>(`[data-usage="${name}"]`));
}

function visibleMetricText(editor: PromptEditor, name: string): string | null {
  return metric(editor, name).querySelector('[aria-hidden="true"]')?.textContent ?? null;
}

function accessibleMetricText(editor: PromptEditor, name: string): string | null {
  return metric(editor, name).querySelector(".visually-hidden")?.textContent ?? null;
}

function expectMetric(editor: PromptEditor, name: string, visible: string, accessible: string): void {
  const item = metric(editor, name);
  const visibleText = required(item.querySelector<HTMLElement>('[aria-hidden="true"]'));
  const accessibleText = required(item.querySelector<HTMLElement>(".visually-hidden"));
  expect(item.localName).toBe("li");
  expect(item.getAttribute("aria-label")).toBeNull();
  expect(visibleText.textContent).toBe(visible);
  expect(accessibleText.textContent).toBe(accessible);
  expect(getComputedStyle(accessibleText).position).toBe("absolute");
  expect(item.title).toBe(accessible);
}
