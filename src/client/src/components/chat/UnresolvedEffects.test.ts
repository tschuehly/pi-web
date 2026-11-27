// @vitest-environment happy-dom
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../../../shared/apiTypes";
import { renderDurableHostPin } from "./UnresolvedEffects";

const pin = { revision: "old1234", current: "new5678" };
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function mount(value: SessionStatus["durableHostPin"] = pin, onUpgrade?: (mode: "quiet" | "now" | "cancel") => void) {
  const root = document.createElement("div");
  document.body.append(root);
  render(renderDurableHostPin(value, onUpgrade), root);
  return root;
}

it("renders nothing without a host pin", () => {
  const root = document.createElement("div");
  render(renderDurableHostPin(undefined, vi.fn()), root);
  expect(root.textContent).toBe("");
});

it("defaults to a compact status and native Details disclosure", () => {
  const root = mount(pin, vi.fn());
  const disclosure = root.querySelector("details");
  expect(disclosure).not.toBeNull();
  expect(disclosure?.open).toBe(false);
  expect(root.querySelector("summary")?.textContent).toContain("Host upgrade available");
  expect(root.querySelector("summary")?.textContent).toContain("Details");
  expect(root.querySelector("summary code, summary button")).toBeNull();
  expect(root.querySelectorAll("details code")).toHaveLength(2);
  expect(root.textContent).toContain(pin.revision);
  expect(root.textContent).toContain(pin.current);
  expect(root.querySelectorAll("button")).toHaveLength(2);
  expect(root.textContent).toContain("Nothing repeats.");
});

it("shows pending status and preserves all three upgrade actions", () => {
  const onUpgrade = vi.fn();
  const root = mount({ ...pin, pending: true, repeats: ["running turn", "running children"] }, onUpgrade);
  expect(root.querySelector('[role="status"]')?.textContent).toBe("Host upgrade pending");
  expect(root.textContent).toContain("once no turn, tool or child runs");
  const buttons = [...root.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Upgrade host", "Upgrade now", "Cancel"]);
  expect(onUpgrade).not.toHaveBeenCalled();
  for (const button of buttons) button.click();
  expect(onUpgrade.mock.calls).toEqual([["quiet"], ["now"], ["cancel"]]);
  const warningId = buttons[1]?.getAttribute("aria-describedby");
  expect(warningId).toBeTruthy();
  const warning = root.querySelector(`#${warningId ?? "missing"}`);
  expect(warning?.textContent).toContain("Repeats: running turn; running children");
  expect(warning?.textContent).toContain("Open questions, queued input, background bash and Atelier Pages carry over.");
});

it("keeps status and recovery details without offering unavailable actions", () => {
  const root = mount({ ...pin, pending: true });
  expect(root.querySelector('[role="status"]')?.textContent).toBe("Host upgrade pending");
  expect(root.querySelector("details")?.textContent).toContain("Nothing repeats.");
  expect(root.querySelector("button")).toBeNull();
});

it("keeps Details open across status updates and removes Cancel when no longer pending", () => {
  const onUpgrade = vi.fn();
  const root = mount({ ...pin, pending: true }, onUpgrade);
  const disclosure = root.querySelector("details");
  if (!disclosure) throw new Error("Missing host upgrade disclosure");
  disclosure.open = true;
  render(renderDurableHostPin({ ...pin, pending: false, repeats: [] }, onUpgrade), root);
  expect(root.querySelector("details")).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(root.querySelector('[role="status"]')?.textContent).toBe("Host upgrade available");
  expect(root.querySelectorAll("button")).toHaveLength(2);
});
