// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppPiMenu } from "./AppPiMenu";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("app-pi-menu", () => {
  it("keeps registered views and protected shell controls reachable", async () => {
    const menu = new AppPiMenu();
    const onSelectView = vi.fn();
    const onShowActions = vi.fn();
    const onConfigureAuth = vi.fn();
    const onRecover = vi.fn();
    const onOpenSettings = vi.fn();
    menu.entries = [{ id: "workbench:navigation", pluginId: "workbench", localId: "navigation", title: "Workstreams", primaryView: "workbench:view" }];
    menu.onSelectView = onSelectView;
    menu.onShowActions = onShowActions;
    menu.onConfigureAuth = onConfigureAuth;
    menu.onRecover = onRecover;
    menu.onOpenSettings = onOpenSettings;
    document.body.append(menu);
    await menu.updateComplete;
    const root = required(menu.shadowRoot);

    expect(button(root, "Conversation")).toBeDefined();
    button(root, "Workstreams").click();
    button(root, "Actions").click();
    button(root, "Authentication").click();
    button(root, "Recovery & refresh").click();
    button(root, "Settings").click();

    expect(onSelectView).toHaveBeenCalledWith("workbench:view");
    expect(onShowActions).toHaveBeenCalledOnce();
    expect(onConfigureAuth).toHaveBeenCalledOnce();
    expect(onRecover).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("omits the active plugin destination and keeps a generic default-shell escape", async () => {
    const menu = new AppPiMenu();
    const onSelectView = vi.fn();
    menu.entries = [
      { id: "workbench:navigation", pluginId: "workbench", localId: "navigation", title: "Workstreams", primaryView: "workbench:view" },
      { id: "other:navigation", pluginId: "other", localId: "navigation", title: "Other view", primaryView: "other:view" },
    ];
    menu.selectedView = "workbench:view";
    menu.onSelectView = onSelectView;
    document.body.append(menu);
    await menu.updateComplete;
    const root = required(menu.shadowRoot);

    expect([...root.querySelectorAll("button")].some((candidate) => candidate.textContent.trim() === "Workstreams")).toBe(false);
    expect(button(root, "Other view")).toBeDefined();
    button(root, "Open default PI WEB shell").click();
    expect(onSelectView).toHaveBeenCalledWith("chat");
  });

  it("announces open state and closes on Escape with focus returned to the trigger", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const menu = new AppPiMenu();
    document.body.append(menu);
    await menu.updateComplete;
    const root = required(menu.shadowRoot);
    const details = required(root.querySelector("details"));
    const summary = required(root.querySelector("summary"));

    expect(summary.getAttribute("aria-label")).toBe("Open Pi menu");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await menu.updateComplete;
    expect(summary.getAttribute("aria-label")).toBe("Close Pi menu");
    expect(summary.getAttribute("aria-expanded")).toBe("true");

    button(root, "Actions").focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    button(root, "Actions").dispatchEvent(escape);
    await menu.updateComplete;

    expect(escape.defaultPrevented).toBe(true);
    expect(details.open).toBe(false);
    expect(summary.getAttribute("aria-label")).toBe("Open Pi menu");
    expect(root.activeElement).toBe(summary);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value");
  return value;
}

function button(root: ShadowRoot, text: string): HTMLButtonElement {
  const value = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === text);
  if (!(value instanceof HTMLButtonElement)) throw new Error(`Expected button ${text}`);
  return value;
}
