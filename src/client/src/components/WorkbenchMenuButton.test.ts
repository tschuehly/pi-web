// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchMenuButton } from "./WorkbenchMenuButton";

afterEach(() => { document.body.replaceChildren(); });

async function mount(): Promise<{ menu: WorkbenchMenuButton; trigger: HTMLButtonElement; panel: HTMLElement; items: HTMLButtonElement[] }> {
  const menu = new WorkbenchMenuButton();
  menu.label = "Chat menu";
  menu.innerHTML = '<button class="go">Files</button><button class="stay" data-keep-open>Copy</button>';
  document.body.append(menu);
  await menu.updateComplete;
  const trigger = menu.shadowRoot?.querySelector<HTMLButtonElement>("button.trigger");
  const panel = menu.shadowRoot?.querySelector<HTMLElement>("#menu");
  if (trigger === null || trigger === undefined || panel === null || panel === undefined) throw new Error("menu not rendered");
  return { menu, trigger, panel, items: [...menu.querySelectorAll("button")] };
}

describe("workbench menu button", () => {
  it("discloses its items from a labelled burger and closes on an item, keeping it open for a keep-open item", async () => {
    const { menu, trigger, panel, items } = await mount();
    expect(trigger.getAttribute("aria-label")).toBe("Chat menu");
    expect(trigger.getAttribute("aria-controls")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);

    trigger.click();
    await menu.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);

    items[1]?.click();
    await menu.updateComplete;
    expect(panel.hidden).toBe(false);
    items[0]?.click();
    await menu.updateComplete;
    expect(panel.hidden).toBe(true);
    expect(menu.shadowRoot?.activeElement).toBe(trigger);
  });

  it("closes on Escape, handing focus back, and on a click outside", async () => {
    const { menu, trigger, panel } = await mount();
    trigger.click();
    await menu.updateComplete;
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    await menu.updateComplete;
    expect(panel.hidden).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(menu.shadowRoot?.activeElement).toBe(trigger);

    trigger.click();
    await menu.updateComplete;
    document.body.click();
    await menu.updateComplete;
    expect(panel.hidden).toBe(true);
    // Closed, it leaves Escape to others.
    const later = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });
});
