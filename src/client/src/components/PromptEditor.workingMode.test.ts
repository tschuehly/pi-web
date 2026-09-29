// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionModel, SessionStatus } from "../api";
import { WORKING_MODE_STATUS_KEY, type WorkingModeAxis } from "../extensionStatusSnapshots";
import { ModelEffortPicker, modelPickerGroups } from "./ModelEffortPicker";
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
    extensionStatuses: { [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 2, phase: "selected", selected: { alignment: "Align", attention: "Default", checking: "Test", orchestration: "Main" }, applied: { alignment: "Align", attention: "Default", checking: "Test", orchestration: "Main" } }) },
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected test value");
  return value;
}

describe("PromptEditor Working Mode controls", () => {
  it("renders the model picker, usage, Working Mode trigger, and actions in one row", async () => {
    const editor = new PromptEditor();
    editor.showUsage = true;
    editor.status = status();
    document.body.append(editor);
    await editor.updateComplete;

    const actions = required(editor.shadowRoot?.querySelector(".actions"));
    const order = [...actions.children].map((child) => child.classList.contains("usage") ? "usage" : child.classList.contains("composer-actions") ? "composer-actions" : child.localName);
    expect(order).toEqual(["model-effort-picker", "usage", "working-mode-controls", "composer-actions"]);
    expect(getComputedStyle(actions).flexWrap).toBe("wrap");
    const composerActions = required(actions.querySelector<HTMLElement>(".composer-actions"));
    expect(getComputedStyle(composerActions).flexShrink).toBe("0");
    expect([...composerActions.children].map((child) => child.getAttribute("aria-label"))).toEqual(["Attach files", "Send message", "Stop current work"]);

    const controls = await workingMode(editor);
    // Axes at their default show only an icon; a changed axis also writes out its value at every
    // width except a narrow composer, which keeps icons only.
    expect(axisIcon(controls, "alignment").className).toBe("axis alignment changed");
    expect(axisIcon(controls, "alignment").textContent).toBe("Align");
    expect(axisIcon(controls, "attention").className).toBe("axis attention");
    expect(axisIcon(controls, "attention").textContent).toBe("");
    expect(trigger(controls).title).toBe("Alignment: Align, Attention: Default, Checking: Test, Orchestration: Main");
    expect(WorkingModeControls.styles.cssText).toMatch(/@container composer \(max-width: 560px\)\s*\{\s*\.axis > \.value\s*\{\s*display:\s*none/);
  });

  it("opens one Working Mode pane that applies several changes and stays open", async () => {
    const run = vi.fn();
    const editor = new PromptEditor();
    editor.status = status();
    editor.onRunCommand = run;
    document.body.append(editor);
    const controls = await workingMode(editor);

    expect(pane(controls)).toBeNull();
    trigger(controls).click();
    await controls.updateComplete;
    expect(trigger(controls).getAttribute("aria-expanded")).toBe("true");
    const groups = [...required(pane(controls)).querySelectorAll('[role="radiogroup"]')];
    expect(groups.map((group) => controls.shadowRoot?.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent)).toEqual(["Alignment", "Attention", "Checking", "Orchestration"]);
    expect(radio(controls, "attention", "Phone").textContent.trim()).toBe("Phone");
    expect(radio(controls, "attention", "Phone").querySelector("svg")).not.toBeNull();
    expect(radio(controls, "alignment", "Align").getAttribute("aria-checked")).toBe("true");
    expect(radio(controls, "alignment", "Align").tabIndex).toBe(0);
    expect(radio(controls, "alignment", "Plan").tabIndex).toBe(-1);
    expect(controls.shadowRoot?.activeElement).toBe(radio(controls, "alignment", "Align"));

    radio(controls, "alignment", "Plan").click();
    radio(controls, "attention", "Phone").click();
    radio(controls, "orchestration", "Workers").click();
    await controls.updateComplete;
    expect(run.mock.calls).toEqual([["/mode alignment plan"], ["/mode attention phone"], ["/mode orchestration workers"]]);
    expect(pane(controls)).not.toBeNull();

    // The reported selection stays authoritative and re-renders the open pane.
    editor.status = withModes({ alignment: "Plan", attention: "Phone", checking: "Test", orchestration: "Workers" });
    await editor.updateComplete;
    await controls.updateComplete;
    expect(radio(controls, "alignment", "Plan").getAttribute("aria-checked")).toBe("true");
    expect(radio(controls, "alignment", "Align").getAttribute("aria-checked")).toBe("false");

    trigger(controls).click();
    await controls.updateComplete;
    expect(pane(controls)).toBeNull();
  });

  it("supports keyboard use and closes the Working Mode pane on Esc or an outside click", async () => {
    const run = vi.fn();
    const editor = new PromptEditor();
    editor.status = status();
    editor.onRunCommand = run;
    document.body.append(editor);
    const controls = await workingMode(editor);

    trigger(controls).click();
    await controls.updateComplete;
    radio(controls, "attention", "Default").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true }));
    expect(run).toHaveBeenLastCalledWith("/mode attention focused");
    expect(controls.shadowRoot?.activeElement).toBe(radio(controls, "attention", "Focused"));
    expect([radio(controls, "attention", "Default").tabIndex, radio(controls, "attention", "Focused").tabIndex]).toEqual([-1, 0]);
    radio(controls, "attention", "Default").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, composed: true }));
    expect(run).toHaveBeenLastCalledWith("/mode attention afk");
    radio(controls, "checking", "Test").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, composed: true }));
    expect(run).toHaveBeenLastCalledWith("/mode checking default");
    expect(pane(controls)).not.toBeNull();

    radio(controls, "checking", "Test").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await controls.updateComplete;
    await controls.updateComplete;
    expect(pane(controls)).toBeNull();
    expect(controls.shadowRoot?.activeElement).toBe(trigger(controls));

    trigger(controls).click();
    await controls.updateComplete;
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    await controls.updateComplete;
    expect(pane(controls)).toBeNull();
  });

  it("rerenders the Working Mode trigger when only its extension status changes", async () => {
    const editor = new PromptEditor();
    editor.status = status();
    document.body.append(editor);
    const controls = await workingMode(editor);
    expect(axisIcon(controls, "attention").className).toBe("axis attention");

    editor.status = withModes({ alignment: "Plan", attention: "Phone", checking: "Challenge", orchestration: "Main" });
    await editor.updateComplete;
    await controls.updateComplete;

    expect(axisIcon(controls, "alignment").textContent).toBe("Plan");
    expect(axisIcon(controls, "attention").textContent).toBe("Phone");
    expect(axisIcon(controls, "checking").textContent).toBe("Challenge");
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

  it("shows model and effort as one button whose popover puts effort first and stays open for effort", async () => {
    const onSetThinkingLevel = vi.fn();
    const onSetModel = vi.fn();
    const editor = modelEditor(onSetModel, onSetThinkingLevel);
    document.body.append(editor);
    const picker = await modelPicker(editor);

    const button = modelTrigger(picker);
    expect(button.textContent.replace(/\s+/g, "")).toBe("claude-opus-5-5·high");
    expect(button.getAttribute("aria-label")).toBe("Model: anthropic/claude-opus-5-5, thinking high. Change model or thinking");
    button.click();
    await vi.waitFor(() => { expect(picker.shadowRoot?.querySelectorAll('[role="option"]').length).toBe(4); });

    const popover = required(picker.shadowRoot?.querySelector('[role="dialog"]'));
    expect([...popover.children].map((child) => child.getAttribute("role") ?? child.localName)).toEqual(["radiogroup", "combobox", "listbox"]);
    expect([...popover.querySelectorAll('[role="radio"]')].map((radio) => `${radio.textContent}:${radio.getAttribute("aria-checked") ?? ""}`)).toEqual(["off:false", "low:false", "high:true"]);
    expect([...popover.querySelectorAll(".provider")].map((provider) => provider.textContent)).toEqual(["anthropic", "openai"]);
    expect(popover.querySelector('[aria-selected="true"]')?.textContent.trim()).toBe("claude-opus-5-5");
    expect(picker.shadowRoot?.activeElement).toBe(search(picker));

    required(popover.querySelector<HTMLButtonElement>('[data-level="low"]')).click();
    expect(onSetThinkingLevel).toHaveBeenCalledWith("low");
    await picker.updateComplete;
    expect(picker.shadowRoot?.querySelector('[role="dialog"]')).not.toBeNull();

    required(popover.querySelector<HTMLButtonElement>('[data-level="high"]')).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, composed: true }));
    expect(onSetThinkingLevel).toHaveBeenLastCalledWith("low");

    required(popover.querySelector<HTMLElement>('[role="option"]:not([aria-selected="true"])')).click();
    await picker.updateComplete;
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-5");
    expect(picker.shadowRoot?.querySelector('[role="dialog"]')).toBeNull();
    expect(onSetModel).toHaveBeenCalledOnce();
  });

  it("filters models by typing, moves with arrows, selects with Enter, and closes on Esc", async () => {
    const onSetModel = vi.fn();
    const editor = modelEditor(onSetModel, vi.fn());
    document.body.append(editor);
    const picker = await modelPicker(editor);

    modelTrigger(picker).click();
    await vi.waitFor(() => { expect(picker.shadowRoot?.querySelectorAll('[role="option"]').length).toBe(4); });
    const input = search(picker);
    expect(input.getAttribute("aria-activedescendant")).toBe(required(picker.shadowRoot?.querySelector('[aria-selected="true"]')).id);
    input.value = "gpt";
    input.dispatchEvent(new Event("input"));
    await picker.updateComplete;
    expect([...(picker.shadowRoot?.querySelectorAll('[role="option"]') ?? [])].map((option) => option.textContent.trim())).toEqual(["gpt-6", "gpt-6-mini"]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true }));
    await picker.updateComplete;
    expect(input.getAttribute("aria-activedescendant")).toBe(required(picker.shadowRoot?.querySelector(".model.active")).id);
    expect(picker.shadowRoot?.querySelector(".model.active")?.textContent.trim()).toBe("gpt-6-mini");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await picker.updateComplete;
    expect(onSetModel).toHaveBeenCalledWith("openai", "gpt-6-mini");
    expect(picker.shadowRoot?.querySelector('[role="dialog"]')).toBeNull();

    modelTrigger(picker).click();
    await picker.updateComplete;
    search(picker).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await picker.updateComplete;
    await picker.updateComplete;
    expect(picker.shadowRoot?.querySelector('[role="dialog"]')).toBeNull();
    expect(picker.shadowRoot?.activeElement).toBe(modelTrigger(picker));

    modelTrigger(picker).click();
    await picker.updateComplete;
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    await picker.updateComplete;
    expect(picker.shadowRoot?.querySelector('[role="dialog"]')).toBeNull();
  });

  it("groups models by provider and matches the search against id, provider, and name", () => {
    const groups = modelPickerGroups([...MODELS, { provider: "", id: "anonymous" }], "");
    expect(groups.map((group) => [group.provider, group.models.map((model) => model.id)])).toEqual([["anthropic", ["claude-opus-5-5", "claude-sonnet-5"]], ["openai", ["gpt-6", "gpt-6-mini"]]]);
    expect(modelPickerGroups(MODELS, "OPENAI/").flatMap((group) => group.models.map((model) => model.id))).toEqual(["gpt-6", "gpt-6-mini"]);
    expect(modelPickerGroups(MODELS, "sonnet").flatMap((group) => group.models.map((model) => model.id))).toEqual(["claude-sonnet-5"]);
  });

  it("leaves usage metrics hidden by default for legacy PromptEditor hosts", async () => {
    const editor = new PromptEditor();
    editor.status = status();
    document.body.append(editor);
    await editor.updateComplete;

    expect(editor.shadowRoot?.querySelector(".usage")).toBeNull();
  });
});

const MODELS: SessionModel[] = [
  { provider: "anthropic", id: "claude-opus-5-5" },
  { provider: "openai", id: "gpt-6" },
  { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { provider: "openai", id: "gpt-6-mini" },
];

function modelEditor(onSetModel: (provider: string, id: string) => void, onSetThinkingLevel: (level: string) => void): PromptEditor {
  const editor = new PromptEditor();
  editor.status = { ...status(), model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high" };
  editor.thinkingLevels = ["off", "low", "high"];
  editor.loadModels = () => Promise.resolve(MODELS);
  editor.onSetModel = onSetModel;
  editor.onSetThinkingLevel = onSetThinkingLevel;
  return editor;
}

async function modelPicker(editor: PromptEditor): Promise<ModelEffortPicker> {
  await editor.updateComplete;
  const picker = required(editor.shadowRoot?.querySelector<ModelEffortPicker>("model-effort-picker"));
  await picker.updateComplete;
  return picker;
}

function modelTrigger(picker: ModelEffortPicker): HTMLButtonElement {
  return required(picker.shadowRoot?.querySelector<HTMLButtonElement>(".trigger"));
}

function search(picker: ModelEffortPicker): HTMLInputElement {
  return required(picker.shadowRoot?.querySelector<HTMLInputElement>(".search"));
}

function withModes(selected: Record<WorkingModeAxis, string>): SessionStatus {
  return { ...status(), extensionStatuses: { [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 2, phase: "selected", selected, applied: null }) } };
}

async function workingMode(editor: PromptEditor): Promise<WorkingModeControls> {
  await editor.updateComplete;
  const controls = required(editor.shadowRoot?.querySelector<WorkingModeControls>("working-mode-controls"));
  await controls.updateComplete;
  return controls;
}

function trigger(controls: WorkingModeControls): HTMLButtonElement {
  return required(controls.shadowRoot?.querySelector<HTMLButtonElement>(".trigger"));
}

function axisIcon(controls: WorkingModeControls, axis: WorkingModeAxis): HTMLElement {
  return required(controls.shadowRoot?.querySelector<HTMLElement>(`.axis[data-axis="${axis}"]`));
}

function pane(controls: WorkingModeControls): HTMLElement | null | undefined {
  return controls.shadowRoot?.querySelector<HTMLElement>('.pane[role="dialog"]');
}

function radio(controls: WorkingModeControls, axis: WorkingModeAxis, value: string): HTMLButtonElement {
  return required(controls.shadowRoot?.querySelector<HTMLButtonElement>(`.values.${axis} [role="radio"][data-value="${value}"]`));
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
