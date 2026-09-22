// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyInterfaceScale, INTERFACE_SCALE_CSS_PROPERTY } from "../interfaceScale";
import { WorkbenchSettingsPanel } from "./WorkbenchSettingsPanel";

const scales = [0.8, 1, 1.25, 1.5, 2] as const;

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("zoom");
  document.documentElement.style.removeProperty(INTERFACE_SCALE_CSS_PROPERTY);
  localStorage.clear();
  vi.restoreAllMocks();
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
