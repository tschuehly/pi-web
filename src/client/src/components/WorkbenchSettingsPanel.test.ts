// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyInterfaceScale, INTERFACE_SCALE_CSS_PROPERTY } from "../interfaceScale";
import { WorkbenchSettingsPanel } from "./WorkbenchSettingsPanel";

const scales = [0.8, 1, 1.25, 1.5, 2] as const;

afterEach(() => {
  delete window.piWebNative;
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("zoom");
  document.documentElement.style.removeProperty(INTERFACE_SCALE_CSS_PROPERTY);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("WorkbenchSettingsPanel sleep control", () => {
  it("hides the control without both native bridge methods", async () => {
    const panel = await mountPanel();
    trigger(panel).click();
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).not.toContain("System sleep (battery and AC)");
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: () => Promise.resolve(false) };
    trigger(panel).click();
    trigger(panel).click();
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).not.toContain("System sleep (battery and AC)");
  });

  it("reads real state on open, confirms explicit actions, and shows the actual result", async () => {
    let actual = false;
    const setter = vi.fn((disabled: boolean) => Promise.resolve(actual && disabled));
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: () => Promise.resolve(actual), setSleepDisabled: setter };
    const confirm = vi.fn().mockReturnValue(false);
    window.confirm = confirm;
    const panel = await mountPanel();
    trigger(panel).click();
    await settle(panel);
    expect(panel.shadowRoot?.textContent).toContain("System sleep enabled");
    sleepButton(panel).click();
    await settle(panel);
    expect(setter).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    sleepButton(panel).click();
    await settle(panel);
    expect(setter).toHaveBeenCalledExactlyOnceWith(true);
    expect(panel.shadowRoot?.textContent).toContain("System sleep enabled");
    actual = true;
    trigger(panel).click();
    trigger(panel).click();
    await settle(panel);
    expect(panel.shadowRoot?.textContent).toContain("System sleep disabled");
    expect(sleepButton(panel).textContent).toContain("Enable system sleep");
  });

  it("disables the action when the actual state cannot be read", async () => {
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: () => Promise.reject(new Error("SLEEP_CONTROL_READ_FAILED: fixture")), setSleepDisabled: vi.fn() };
    const panel = await mountPanel();
    trigger(panel).click();
    await settle(panel);
    expect(sleepButton(panel).disabled).toBe(true);
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("SLEEP_CONTROL_READ_FAILED:");
  });

  it("clears a read error when polling recovers", async () => {
    vi.useFakeTimers();
    const getter = vi.fn().mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce(false);
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: getter, setSleepDisabled: vi.fn() };
    const panel = await mountPanel();
    trigger(panel).click();
    await vi.advanceTimersByTimeAsync(0);
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("read failed");
    await vi.advanceTimersByTimeAsync(5000);
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    expect(panel.shadowRoot?.textContent).toContain("System sleep enabled");
  });

  it("polls external state while open without invoking the setter", async () => {
    vi.useFakeTimers();
    const setter = vi.fn();
    const getter = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: getter, setSleepDisabled: setter };
    const panel = await mountPanel();
    trigger(panel).click();
    await Promise.resolve();
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(5000);
    await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("System sleep disabled");
    expect(setter).not.toHaveBeenCalled();
    trigger(panel).click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getter).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed change actionable through successful 5s state polls", async () => {
    vi.useFakeTimers();
    let actual = false;
    const getter = vi.fn(() => Promise.resolve(actual));
    const setter = vi.fn(() => Promise.reject(new Error("SLEEP_CONTROL_CHANGE_FAILED: fixture")));
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: getter, setSleepDisabled: setter };
    window.confirm = vi.fn().mockReturnValue(true);
    const panel = await mountPanel();
    trigger(panel).click();
    await Promise.resolve();
    await panel.updateComplete;
    sleepButton(panel).click();
    await vi.advanceTimersByTimeAsync(0);
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("SLEEP_CONTROL_CHANGE_FAILED: fixture");
    actual = true;
    await vi.advanceTimersByTimeAsync(5000);
    await panel.updateComplete;
    expect(getter).toHaveBeenCalledTimes(3);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(panel.shadowRoot?.textContent).toContain("System sleep disabled");
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("SLEEP_CONTROL_CHANGE_FAILED: fixture");
  });

  it("serializes pending changes and displays the native result", async () => {
    let finish!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const setter = vi.fn(() => pending);
    const getter = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("SLEEP_CONTROL_READ_FAILED: unexpected reread"));
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: getter, setSleepDisabled: setter };
    window.confirm = vi.fn().mockReturnValue(true);
    const panel = await mountPanel();
    trigger(panel).click();
    await settle(panel);
    sleepButton(panel).click();
    await panel.updateComplete;
    expect(sleepButton(panel).disabled).toBe(true);
    expect(panel.shadowRoot?.textContent).toContain("Changing system sleep setting");
    sleepButton(panel).click();
    expect(setter).toHaveBeenCalledTimes(1);
    finish(true);
    await settle(panel);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(panel.shadowRoot?.textContent).toContain("System sleep disabled");
    expect(panel.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ["SLEEP_CONTROL_USER_CANCELLED:", "cancelled"],
    ["SLEEP_CONTROL_TIMEOUT:", "timed out"],
    ["SLEEP_CONTROL_STATE_UNVERIFIED:", "may have changed"],
    ["SLEEP_CONTROL_CHANGE_FAILED:", "failed"],
  ])("reports %s and rereads actual state", async (prefix, expected) => {
    const getter = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: getter, setSleepDisabled: () => Promise.reject(new Error(`${prefix} fixture`)) };
    window.confirm = vi.fn().mockReturnValue(true);
    const panel = await mountPanel();
    trigger(panel).click();
    await settle(panel);
    sleepButton(panel).click();
    await settle(panel);
    expect(getter).toHaveBeenCalledTimes(2);
    expect(panel.shadowRoot?.textContent).toContain("System sleep disabled");
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(expected);
  });
});

describe("WorkbenchSettingsPanel zoom geometry", () => {
  it.each(scales)("keeps its physical 6px gap and aligns with a trigger before trailing actions at scale %s", async (scale) => {
    const popover = await openPanelAt(scale, { bottom: 40 * scale, right: window.innerWidth - 76 });

    expect(Number.parseFloat(popover.style.top) * scale - 40 * scale).toBeCloseTo(6);
    expect(Number.parseFloat(popover.style.right) * scale).toBeCloseTo(76);
  });

  it.each(scales)("keeps an 8px physical viewport inset when the trigger is closer at scale %s", async (scale) => {
    const popover = await openPanelAt(scale, { bottom: 40 * scale, right: window.innerWidth - 3 });

    expect(Number.parseFloat(popover.style.right) * scale).toBeCloseTo(8);
  });

  it.each([1, 1.25, 1.5, 2])("bounds the panel below its anchor at 1000x600 and scale %s", async (scale) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    window.piWebNative = { pickDirectory: () => Promise.resolve(null), getSleepDisabled: () => Promise.resolve(false), setSleepDisabled: () => Promise.resolve(true) };
    const popover = await openPanelAt(scale, { bottom: 40 * scale, right: 924 });
    const top = Number.parseFloat(popover.style.top);
    const availableHeight = window.innerHeight / scale - top - 12;

    expect(top * scale).toBeCloseTo(40 * scale + 6);
    expect(Number.parseFloat(popover.style.right) * scale).toBeCloseTo(76);
    expect(popover.style.maxHeight).toBe(`calc(var(--pi-workbench-viewport-height, 100vh) - ${String(top)}px - 12px)`);
    expect(popover.querySelector("fieldset button")?.textContent).toContain("system sleep");
    expect(availableHeight * scale).toBeCloseTo(600 - 40 * scale - 6 - 12 * scale);
    expect(availableHeight).toBeGreaterThan(0);
    expect(WorkbenchSettingsPanel.styles.cssText).toMatch(/\.popover\s*\{[^}]*overflow-y:\s*auto/);
  });

  it.each([1.5, 2])("reanchors immediately when the open panel changes to scale %s", async (scale) => {
    const panel = await mountPanel();
    const opener = trigger(panel);
    vi.spyOn(opener, "getBoundingClientRect").mockImplementation(() => {
      const scale = Number(document.documentElement.style.getPropertyValue(INTERFACE_SCALE_CSS_PROPERTY)) || 1;
      return rect({ bottom: 40 * scale, right: window.innerWidth - 76 });
    });
    applyInterfaceScale(1);
    opener.click();
    await panel.updateComplete;

    const select = requiredElement(panel.shadowRoot?.querySelector<HTMLSelectElement>("#workbench-settings-scale"), "scale select");
    select.value = String(scale);
    select.dispatchEvent(new Event("change"));
    await panel.updateComplete;

    const popover = requiredElement(panel.shadowRoot?.querySelector<HTMLElement>(".popover"), "settings popover");
    expect(Number.parseFloat(popover.style.top) * scale - 40 * scale).toBeCloseTo(6);
    expect(Number.parseFloat(popover.style.right) * scale).toBeCloseTo(76);
    expect(popover.style.maxHeight).toContain(`- ${popover.style.top} - 12px`);
  });
});

async function openPanelAt(scale: number, openerRect: { bottom: number; right: number }): Promise<HTMLElement> {
  const panel = await mountPanel();
  const opener = trigger(panel);
  applyInterfaceScale(scale);
  vi.spyOn(opener, "getBoundingClientRect").mockReturnValue(rect(openerRect));
  opener.click();
  await panel.updateComplete;
  return requiredElement(panel.shadowRoot?.querySelector<HTMLElement>(".popover"), "settings popover");
}

async function mountPanel(): Promise<WorkbenchSettingsPanel> {
  const panel = new WorkbenchSettingsPanel();
  panel.themePreference = { themeId: "builtin:dark", auto: false };
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

async function settle(panel: WorkbenchSettingsPanel): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await panel.updateComplete;
}

function sleepButton(panel: WorkbenchSettingsPanel): HTMLButtonElement {
  return requiredElement(panel.shadowRoot?.querySelector<HTMLButtonElement>("fieldset button"), "sleep action");
}

function trigger(panel: WorkbenchSettingsPanel): HTMLButtonElement {
  return requiredElement(panel.shadowRoot?.querySelector<HTMLButtonElement>(".trigger"), "settings trigger");
}

function rect({ bottom, right }: { bottom: number; right: number }): DOMRect {
  return { x: right - 32, y: bottom - 32, top: bottom - 32, right, bottom, left: right - 32, width: 32, height: 32, toJSON: () => ({}) };
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
