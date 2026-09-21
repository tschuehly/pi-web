// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY, WORKING_MODE_STATUS_KEY } from "../extensionStatusSnapshots";
import { DelegateRoster } from "./DelegateRoster";
import { WorkingModeControls } from "./WorkingModeControls";

function status(extensionStatuses: Record<string, string>): SessionStatus {
  return {
    sessionId: "session-1", isStreaming: false, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    extensionStatuses,
  };
}

function root(element: WorkingModeControls | DelegateRoster): ShadowRoot {
  if (element.shadowRoot === null) throw new Error("Component shadow root is unavailable");
  return element.shadowRoot;
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected test value");
  return value;
}

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

describe("WorkingModeControls", () => {
  it("renders independent pressed segments and waits for status before changing state", async () => {
    const run = vi.fn();
    const element = new WorkingModeControls();
    element.status = status({ [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, phase: "selected", selected: { alignment: "Align", checking: "tests" }, applied: null }) });
    element.onRunCommand = run;
    document.body.append(element);
    await element.updateComplete;

    const buttons = [...root(element).querySelectorAll("button")];
    const plan = required(buttons.find((button) => button.textContent === "Plan"));
    expect(buttons.find((button) => button.textContent === "Align")?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons.find((button) => button.textContent === "tests")?.getAttribute("aria-pressed")).toBe("true");
    plan.click();
    await element.updateComplete;
    expect(run).toHaveBeenCalledWith("/mode alignment plan");
    expect(plan.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("DelegateRoster", () => {
  it("renders a running subagent and a terminal uncollected row compactly", async () => {
    const element = new DelegateRoster();
    document.body.append(element);
    await element.updateComplete;
    expect(root(element).querySelector("section")).toBeNull();

    const longObjective = "Review the complete delegate roster implementation and every narrow-width layout edge case before reporting findings";
    element.status = status({ [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [
      { id: "one", kind: "subagent", name: "Roster implementation", role: "implementation", model: "openai-codex/gpt-5.6-sol-20260921", effort: "medium", objective: longObjective, activity: "running tests", reportedStatus: "Wiring the roster CSS" },
      { id: "two", kind: "subagent", name: "Review", role: "challenge", objective: "Check result", activity: "success" },
    ] }) });
    await element.updateComplete;
    const rows = [...root(element).querySelectorAll<HTMLElement>(".row")];
    expect(rows).toHaveLength(2);
    const running = required(rows[0]);
    expect(running.querySelector(".kind")?.getAttribute("aria-label")).toBe("Subagent");
    expect(running.querySelector(".state")?.getAttribute("aria-label")).toBe("Running");
    expect(running.querySelector(".meta")?.textContent).toBe("implementation · gpt-5.6-sol · medium");
    expect(running.querySelector(".meta")?.getAttribute("title")).toContain("openai-codex/gpt-5.6-sol-20260921");
    expect(running.querySelector(".task")?.getAttribute("title")).toBe(longObjective);
    expect(running.querySelector(".activity")?.textContent).toBe("Wiring the roster CSS");
    const terminal = required(rows[1]);
    expect(terminal.classList.contains("terminal")).toBe(true);
    expect(terminal.querySelector(".state")?.getAttribute("aria-label")).toBe("Uncollected");
  });

  it("falls back to inferred activity when reportedStatus is absent", async () => {
    const element = new DelegateRoster();
    document.body.append(element);
    element.status = status({ [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [
      { id: "one", kind: "worker", name: "UI", objective: "Build roster", activity: "running bash" },
    ] }) });
    await element.updateComplete;
    const row = required(root(element).querySelector(".row"));
    expect(row.querySelector(".kind")?.getAttribute("aria-label")).toBe("Worker");
    expect(row.querySelector(".activity")?.textContent).toBe("running bash");
  });

  it("tolerates a snapshot without the reportedStatus field at all", async () => {
    const element = new DelegateRoster();
    document.body.append(element);
    element.status = status({ [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [
      { id: "one", kind: "worker", name: "UI", objective: "Build roster" },
    ] }) });
    await element.updateComplete;
    const row = required(root(element).querySelector(".row"));
    expect(row.textContent).toContain("starting");
  });
});
