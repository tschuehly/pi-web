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
    expect([...composerActions.children].map((child) => child.getAttribute("aria-label"))).toEqual(["Attach files", "Send message", "Stop current work"]);

    const controls = required(actions.querySelector<WorkingModeControls>("working-mode-controls"));
    await controls.updateComplete;
    const alignment = required(select(controls, "Alignment"));
    expect(alignment.value).toBe("Align");
    expect(alignment.selectedOptions[0]?.textContent).toBe("Alignment: Align");
    // Axes at their default show only an icon; a changed axis also writes out its value;
    // a wide composer expands every axis to its name and value.
    expect(axisLabel(controls, "Alignment").title).toBe("Alignment: Align");
    expect(axisLabel(controls, "Alignment").className).toBe("changed");
    expect(axisLabel(controls, "Alignment").querySelector(".value")?.textContent).toBe("Align");
    expect(axisLabel(controls, "Attention").className).toBe("");
    expect(axisLabel(controls, "Attention").querySelector(".name")?.textContent).toBe("Attention");
    expect(axisLabel(controls, "Attention").querySelector(".value")?.textContent).toBe("Default");
    const styles = WorkingModeControls.styles.cssText;
    expect(styles).toMatch(/label:not\(\.changed\) > \.value\s*\{\s*display:\s*none/);
    expect(styles).toMatch(/@container composer \(min-width: 1240px\)\s*\{\s*label > \.name, label:not\(\.changed\) > \.value\s*\{\s*display:\s*inline/);
    expect(styles).toMatch(/@container composer \(max-width: 560px\)\s*\{\s*label > span\s*\{\s*display:\s*none/);
    expect(axisLabel(controls, "Orchestration").title).toBe("Orchestration: Main");
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
    expectHiddenMetric(editor, "input", "Input tokens: 434000");
    expectHiddenMetric(editor, "output", "Output tokens: 34000");
    expectMetric(editor, "context", "213k / 272k", "Context: 212704 of 272000 tokens used (78.234567%)", "Context: 212704 of 272000 tokens used (78.234567%)\nInput tokens: 434000\nOutput tokens: 34000");
    expect(metric(editor, "context").querySelector(".context-meter")?.classList.contains("context-warning")).toBe(true);
    expect(metric(editor, "context").querySelector(".context-ring-used")?.getAttribute("stroke-dasharray")).toBe("78.234567 100");
    expectMetric(editor, "cost", "$12.42", "Session cost: $12.42");
    expectMetric(editor, "warnings", "Warnings 2", "Session warnings: 2");
    expectMetric(editor, "queued", "Queued 3", "Queued messages: 3");

    const currentStatus = required(editor.status);
    editor.status = {
      ...currentStatus,
      pendingMessageCount: 1,
      tokens: { input: 500_000, output: 40_000, cacheRead: 0, cacheWrite: 0, total: 540_000 },
      contextUsage: { tokens: 250_000, contextWindow: 272_000, percent: 91.9 },
      cost: 12.5,
    };
    await editor.updateComplete;

    expect(accessibleMetricText(editor, "input")).toBe("Input tokens: 500000");
    expect(visibleMetricText(editor, "context")).toBe("250k / 272k");
    expect(accessibleMetricText(editor, "context")).toBe("Context: 250000 of 272000 tokens used (91.9%)");
    expect(metric(editor, "context").querySelector(".context-meter")?.classList.contains("context-danger")).toBe(true);
    expect(visibleMetricText(editor, "cost")).toBe("$12.50");
    expect(visibleMetricText(editor, "queued")).toBe("Queued 1");

    editor.status = { ...currentStatus, contextUsage: { tokens: null, contextWindow: 200_000, percent: null } };
    await editor.updateComplete;
    expect(visibleMetricText(editor, "context")).toBe("? / 200k");
    expect(accessibleMetricText(editor, "context")).toBe("Context used tokens unavailable; window: 200000 tokens");
  });

  it("shows the thinking level as text that opens the thinking selector", async () => {
    const onSelectThinking = vi.fn();
    const onSelectModel = vi.fn();
    const editor = new PromptEditor();
    editor.status = { ...status(), model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high" };
    editor.onSelectThinking = onSelectThinking;
    editor.onSelectModel = onSelectModel;
    document.body.append(editor);
    await editor.updateComplete;

    const thinking = required(editor.shadowRoot?.querySelector<HTMLButtonElement>(".select-thinking"));
    expect(thinking.textContent).toBe("high");
    expect(thinking.getAttribute("aria-label")).toBe("Thinking level: high");
    thinking.click();
    expect(onSelectThinking).toHaveBeenCalledOnce();

    const model = required(editor.shadowRoot?.querySelector<HTMLButtonElement>(".select-model"));
    expect(model.textContent).toBe("anthropic/claude-opus-5-5");
    expect(model.getAttribute("aria-label")).toBe("Model: anthropic/claude-opus-5-5. Select model");
    model.click();
    expect(onSelectModel).toHaveBeenCalledOnce();

    editor.status = { ...required(editor.status), thinkingLevel: "" };
    await editor.updateComplete;
    expect(thinking.textContent).toBe("off");
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

function axisLabel(controls: WorkingModeControls, label: string): HTMLLabelElement {
  return required(select(controls, label)?.closest("label"));
}

function metric(editor: PromptEditor, name: string): HTMLElement {
  return required(editor.shadowRoot?.querySelector<HTMLElement>(`[data-usage="${name}"]`));
}

function visibleMetricText(editor: PromptEditor, name: string): string | null {
  return metric(editor, name).querySelector('[aria-hidden="true"]')?.textContent.trim() ?? null;
}

function accessibleMetricText(editor: PromptEditor, name: string): string | null {
  return accessibleMetricTextOrOwn(editor, name);
}

function expectHiddenMetric(editor: PromptEditor, name: string, accessible: string): void {
  const item = metric(editor, name);
  expect(item.localName).toBe("li");
  expect(item.textContent).toBe(accessible);
  expect(getComputedStyle(item).position).toBe("absolute");
}

function accessibleMetricTextOrOwn(editor: PromptEditor, name: string): string | null {
  const item = metric(editor, name);
  return item.querySelector(".visually-hidden")?.textContent ?? item.textContent;
}

function expectMetric(editor: PromptEditor, name: string, visible: string, accessible: string, title = accessible): void {
  const item = metric(editor, name);
  const visibleText = required(item.querySelector<HTMLElement>('[aria-hidden="true"]'));
  const accessibleText = required(item.querySelector<HTMLElement>(".visually-hidden"));
  expect(item.localName).toBe("li");
  expect(item.getAttribute("aria-label")).toBeNull();
  expect(visibleText.textContent.trim()).toBe(visible);
  expect(accessibleText.textContent).toBe(accessible);
  expect(getComputedStyle(accessibleText).position).toBe("absolute");
  expect(item.title).toBe(title);
}
