// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { WORKING_MODE_STATUS_KEY } from "../extensionStatusSnapshots";
import { WorkingModeControls } from "./WorkingModeControls";

function status(extensionStatuses: Record<string, string>): SessionStatus {
  return {
    sessionId: "session-1", isStreaming: false, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    extensionStatuses,
  };
}

function root(element: WorkingModeControls): ShadowRoot {
  if (element.shadowRoot === null) throw new Error("Component shadow root is unavailable");
  return element.shadowRoot;
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected test value");
  return value;
}

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

describe("WorkingModeControls", () => {
  it("offers Reset alignment only while aligned, running /mode unalign", async () => {
    const run = vi.fn();
    const element = new WorkingModeControls();
    const selected = { alignment: "Align", attention: "Default", checking: "Default", orchestration: "Main" } as const;
    const snapshot = (aligned: boolean) => status({ [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 2, phase: "applied", selected, applied: selected, aligned }) });
    element.status = snapshot(false);
    element.onRunCommand = run;
    document.body.append(element);
    await element.updateComplete;
    required(root(element).querySelector<HTMLButtonElement>(".trigger")).click();
    await element.updateComplete;
    expect(root(element).querySelector(".pane .unalign")).toBeNull();

    element.status = snapshot(true);
    await element.updateComplete;
    required(root(element).querySelector<HTMLButtonElement>(".pane .unalign")).click();
    await element.updateComplete;
    expect(run).toHaveBeenCalledExactlyOnceWith("/mode unalign");
    expect(root(element).querySelector(".pane")).toBeNull();
  });

  it("marks an unsent selection and sends it from the pane with /mode send", async () => {
    const run = vi.fn();
    const element = new WorkingModeControls();
    const defaults = { alignment: "Default", attention: "Default", checking: "Default", orchestration: "Main" } as const;
    const snapshot = (applied: unknown) => status({ [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 2, phase: "selected", selected: { ...defaults, attention: "Focused" }, applied }) });
    element.status = snapshot({ ...defaults, attention: "Focused" });
    element.onRunCommand = run;
    document.body.append(element);
    await element.updateComplete;
    const trigger = required(root(element).querySelector<HTMLButtonElement>(".trigger"));
    expect(root(element).querySelector(".pending-dot")).toBeNull();
    trigger.click();
    await element.updateComplete;
    const send = () => required(root(element).querySelector<HTMLButtonElement>(".pane .send"));
    expect(send().disabled).toBe(true);
    send().click();
    expect(run).not.toHaveBeenCalled();

    // Before the first turn `applied` is null: the latest transcript block is the baseline.
    element.status = snapshot(null);
    element.transcriptSelection = defaults;
    await element.updateComplete;
    expect(root(element).querySelector(".pending-dot")?.getAttribute("title")).toBe("Working Mode change not sent yet");
    expect(trigger.getAttribute("aria-label")).toContain("Working Mode change not sent yet");
    expect(send().disabled).toBe(false);
    expect(send().textContent.trim()).toBe("Send");
    send().click();
    await element.updateComplete;
    expect(run).toHaveBeenCalledExactlyOnceWith("/mode send");
    expect(root(element).querySelector(".pane")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists every axis value in the pane and waits for status before changing state", async () => {
    const run = vi.fn();
    const element = new WorkingModeControls();
    element.status = status({ [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 2, phase: "selected", selected: { alignment: "Align", attention: "Default", checking: "Test", orchestration: "Main" }, applied: null }) });
    element.onRunCommand = run;
    document.body.append(element);
    await element.updateComplete;

    required(root(element).querySelector<HTMLButtonElement>(".trigger")).click();
    await element.updateComplete;
    const groups = [...root(element).querySelectorAll('[role="radiogroup"]')];
    expect(groups.map((group) => [...group.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent))).toEqual([
      ["", "Align", "Plan", "Spec"],
      ["", "Focused", "Switching", "Phone", "AFK"],
      ["", "Exercise", "Test", "Challenge"],
      ["", "Subagents", "Workers"],
    ]);
    // Each axis default shows only its icon; its name stays as the accessible name and tooltip.
    expect(groups.map((group) => { const radio = required(group.querySelector('[role="radio"]')); return [radio.getAttribute("aria-label"), radio.getAttribute("title"), radio.querySelector("svg")?.getAttribute("aria-hidden")]; })).toEqual([
      ["Default", "Default", "true"], ["Default", "Default", "true"], ["Default", "Default", "true"], ["Main", "Main", "true"],
    ]);
    expect(root(element).querySelector('[data-value="Subagents"]')?.hasAttribute("aria-label")).toBe(false);
    expect([...root(element).querySelectorAll('[aria-checked="true"]')].map((radio) => radio.getAttribute("data-value"))).toEqual(["Align", "Default", "Test", "Main"]);
    expect(WorkingModeControls.styles.cssText).toMatch(/\.values > button\s*\{\s*flex:\s*1 1 auto/);
    expect(WorkingModeControls.styles.cssText).toMatch(/\.values > button\.icon-only\s*\{\s*flex:\s*0 0 auto/);
    required(root(element).querySelector<HTMLButtonElement>('.alignment [data-value="Plan"]')).click();
    await element.updateComplete;
    expect(run).toHaveBeenCalledWith("/mode alignment plan");
    expect(root(element).querySelector('.alignment [aria-checked="true"]')?.textContent).toBe("Align");
  });

  it("disables the trigger until a current snapshot arrives", async () => {
    const element = new WorkingModeControls();
    element.status = status({ [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, phase: "selected", selected: { alignment: "Align", checking: "tests" }, applied: null }) });
    document.body.append(element);
    await element.updateComplete;
    const trigger = required(root(element).querySelector<HTMLButtonElement>(".trigger"));
    expect(trigger.disabled).toBe(true);
    trigger.click();
    await element.updateComplete;
    expect(root(element).querySelector(".pane")).toBeNull();
  });

  it("shows each value's icon, colouring only changed axes, and the default icon when unavailable", async () => {
    const element = new WorkingModeControls();
    element.status = status({ [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 2, phase: "selected", selected: { alignment: "Plan", attention: "Default", checking: "Challenge", orchestration: "Workers" }, applied: null }) });
    document.body.append(element);
    await element.updateComplete;
    const labels = () => [...root(element).querySelectorAll(".trigger > .axis")];
    const icons = () => labels().map((label) => label.querySelector("svg")?.innerHTML.replace(/<!--.*?-->/g, "") ?? "");
    const selectedIcons = icons();
    expect(labels().map((label) => label.className)).toEqual(["axis alignment changed", "axis attention", "axis checking changed", "axis orchestration changed"]);
    expect(selectedIcons[0]).toContain("M13 5h8"); // list-checks
    expect(selectedIcons[1]).toContain("M2.062 12.348"); // eye
    expect(selectedIcons[2]).toContain("m13 19 6-6"); // swords
    expect(selectedIcons[3]).toContain("M16 3.128"); // users

    element.status = status({});
    await element.updateComplete;
    const defaultIcons = icons();
    expect(labels().every((label) => !label.classList.contains("changed"))).toBe(true);
    expect(defaultIcons[0]).toContain("<line"); // crosshair
    expect(defaultIcons[1]).toBe(selectedIcons[1]);
    expect(defaultIcons[2]).toContain("M20 13c0 5"); // shield
    expect(defaultIcons[3]).toContain("M19 21v-2"); // user
    expect(WorkingModeControls.styles.cssText).toMatch(/\.axis\.changed[^{]*\{\s*color:\s*var\(--axis-color\)/);
  });
});
