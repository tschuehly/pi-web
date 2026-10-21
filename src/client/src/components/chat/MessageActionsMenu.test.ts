// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { MessageActionsMenu } from "./MessageActionsMenu";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mount() {
  const menu = new MessageActionsMenu();
  const content = document.createElement("div");
  content.className = "msg-actions-strip";
  const action = document.createElement("button");
  action.textContent = "Copy message";
  content.append(action);
  menu.append(content);
  document.body.append(menu);
  await menu.updateComplete;
  const trigger = menu.shadowRoot?.querySelector("button");
  const panel = menu.shadowRoot?.querySelector<HTMLDivElement>("[popover]");
  const slot = menu.shadowRoot?.querySelector("slot");
  if (!trigger || !panel || !slot) throw new Error("Missing message actions controls");
  return { menu, content, action, trigger, panel, slot };
}

// happy-dom does not implement native popover activation/dismissal. Model only
// its toggle notification; native keyboard/focus and placement need a browser.
function nativeToggle(panel: HTMLElement, newState: "open" | "closed") {
  panel.dispatchEvent(Object.assign(new Event("toggle"), { newState }));
}

it("exposes a named native popover trigger and leaves action content parent-owned", async () => {
  const { menu, content, action, trigger, panel, slot } = await mount();
  expect(customElements.get("pi-message-actions-menu")).toBe(MessageActionsMenu);
  expect(trigger.type).toBe("button");
  expect(trigger.getAttribute("aria-label")).toBe("Message actions");
  expect(trigger.classList.contains("ui-button")).toBe(true);
  expect(trigger.classList.contains("ui-button--small")).toBe(true);
  expect(trigger.classList.contains("ui-button--icon")).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
  expect(trigger.getAttribute("popovertarget")).toBe(panel.id);
  expect(panel.getAttribute("popover")).toBe("auto");
  expect(menu.hasAttribute("open")).toBe(false);
  expect(slot.assignedElements()).toEqual([content]);
  const copy = vi.fn();
  action.addEventListener("click", copy);
  action.click();
  expect(copy).toHaveBeenCalledOnce();
});

it("synchronizes native open and dismissal notifications with trigger and host state", async () => {
  const { menu, trigger, panel } = await mount();
  nativeToggle(panel, "open");
  await menu.updateComplete;
  expect(menu.hasAttribute("open")).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  nativeToggle(panel, "closed");
  await menu.updateComplete;
  expect(menu.hasAttribute("open")).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("closes on request and returns focus to its trigger", async () => {
  const { menu, trigger, panel } = await mount();
  const hide = vi.fn(() => { nativeToggle(panel, "closed"); });
  Object.defineProperty(panel, "hidePopover", { value: hide, configurable: true });
  menu.close();
  expect(hide).not.toHaveBeenCalled();
  nativeToggle(panel, "open");
  menu.close();
  expect(hide).toHaveBeenCalledOnce();
  expect(menu.hasAttribute("open")).toBe(false);
  expect(menu.shadowRoot?.activeElement).toBe(trigger);
});

it("repositions on viewport changes only while open and cleans up on removal", async () => {
  const { menu, trigger, panel } = await mount();
  const measure = vi.spyOn(trigger, "getBoundingClientRect");
  nativeToggle(panel, "open");
  measure.mockClear();
  window.dispatchEvent(new Event("resize"));
  document.dispatchEvent(new Event("scroll"));
  expect(measure).toHaveBeenCalledTimes(2);

  nativeToggle(panel, "closed");
  measure.mockClear();
  window.dispatchEvent(new Event("resize"));
  document.dispatchEvent(new Event("scroll"));
  expect(measure).not.toHaveBeenCalled();

  nativeToggle(panel, "open");
  menu.remove();
  measure.mockClear();
  window.dispatchEvent(new Event("resize"));
  document.dispatchEvent(new Event("scroll"));
  // A queued native notification after disconnection must not leak listeners.
  nativeToggle(panel, "open");
  window.dispatchEvent(new Event("resize"));
  expect(measure).not.toHaveBeenCalled();
  expect(menu.hasAttribute("open")).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
