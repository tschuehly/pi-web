// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { QualifiedShellRegionItem, ShellRegionActionDescriptor } from "../../plugins/types";
import { AppShellRegion } from "./AppShellRegion";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("app-shell-region", () => {
  it("renders generic descriptors and puts excess contextual actions in host-owned overflow", async () => {
    const invoked: string[] = [];
    const region = new AppShellRegion();
    region.location = "contextual-actions";
    region.items = ["One", "Two", "Three", "Four"].map((label, index) => action(`fixture:action.${String(index)}`, label, () => { invoked.push(label); }));
    document.body.append(region);
    await region.updateComplete;
    const root = required(region.shadowRoot);

    const directItems = required(root.querySelector(".region > .items"));
    expect([...directItems.querySelectorAll(":scope > button")].map((button) => button.textContent.trim())).toEqual(["One", "Two", "Three"]);
    expect(root.querySelector("details")).not.toBeNull();
    button(root, "Four").click();
    await vi.waitFor(() => { expect(invoked).toEqual(["Four"]); });
  });

  it("closes overflow on Escape and restores focus to its trigger", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const region = new AppShellRegion();
    region.location = "contextual-actions";
    region.items = ["One", "Two", "Three", "Four"].map((label, index) => action(`fixture:action.${String(index)}`, label, () => undefined));
    document.body.append(region);
    await region.updateComplete;
    const root = required(region.shadowRoot);
    const overflow = required(root.querySelector("details"));
    const trigger = required(overflow.querySelector("summary"));
    overflow.open = true;
    button(root, "Four").focus();
    button(root, "Four").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(overflow.open).toBe(false);
    expect(root.activeElement).toBe(trigger);
  });

  it("keeps disabled actions focusable with an accessible reason", async () => {
    const region = new AppShellRegion();
    const invoke = vi.fn();
    region.items = [{ ...action("fixture:disabled", "Retry", invoke), disabled: true, disabledReason: "Wait for reconnect" }];
    document.body.append(region);
    await region.updateComplete;
    const control = buttonStartingWith(required(region.shadowRoot), "Retry");

    control.focus();
    control.click();
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.getAttribute("aria-describedby")).not.toBeNull();
    expect(required(region.shadowRoot).getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Wait for reconnect");
    expect(invoke).not.toHaveBeenCalled();
    expect(required(region.shadowRoot).activeElement).toBe(control);
  });

  it("isolates rejected action callbacks inside the fixed region", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const region = new AppShellRegion();
    region.location = "status";
    region.items = [action("fixture:action", "Retry", () => Promise.reject(new Error("offline")))];
    document.body.append(region);
    await region.updateComplete;
    const root = required(region.shadowRoot);

    button(root, "Retry").click();
    await vi.waitFor(() => { expect(root.querySelector("[role=alert]")?.textContent).toContain("Retry is unavailable: offline"); });
    expect(root.querySelector("button")?.isConnected).toBe(true);
  });
});

function action(id: `${string}:${string}`, label: string, invoke: () => void | Promise<void>): QualifiedShellRegionItem & ShellRegionActionDescriptor {
  const [pluginId = "fixture", localId = "action"] = id.split(":");
  return { id, pluginId, localId, location: "contextual-actions", type: "action", label, invoke };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value");
  return value;
}

function button(root: ShadowRoot, text: string): HTMLButtonElement {
  const result = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === text);
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Expected button ${text}`);
  return result;
}

function buttonStartingWith(root: ShadowRoot, text: string): HTMLButtonElement {
  const result = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.trim().startsWith(text));
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Expected button starting with ${text}`);
  return result;
}
