// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY, WATCHER_STATUS_KEY, WORKING_MODE_STATUS_KEY } from "../extensionStatusSnapshots";
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
  it("returns no roster for an empty activity snapshot", async () => {
    const element = new DelegateRoster();
    document.body.append(element);
    await element.updateComplete;

    expect(root(element).querySelector("section")).toBeNull();
  });

  it("renders a running subagent and a terminal uncollected row compactly", async () => {
    const element = new DelegateRoster();
    document.body.append(element);
    const longObjective = "Review the complete delegate roster implementation and every narrow-width layout edge case before reporting findings";
    element.status = status({ [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [
      { id: "one", kind: "subagent", name: "Roster implementation", role: "implementation", model: "openai-codex/gpt-5.6-sol-20260921", effort: "medium", objective: longObjective, activity: "running tests", reportedStatus: "Wiring the roster CSS" },
      { id: "two", kind: "subagent", name: "Review", role: "challenge", objective: "Check result", activity: "success" },
    ] }) });
    await element.updateComplete;
    const rows = [...root(element).querySelectorAll<HTMLElement>(".row")];
    expect(rows).toHaveLength(2);
    const toggle = required(root(element).querySelector<HTMLButtonElement>(".section-toggle"));
    expect(toggle.type).toBe("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(root(element).querySelector(".section-name")?.textContent).toContain("Activity");
    expect(root(element).querySelector(".section-count")?.textContent).toBe("2");
    expect(root(element).querySelector(".aggregate")?.textContent).toBe("1 running delegate · 1 uncollected · 0 watchers · 0 shells");
    expect(root(element).querySelector(".aggregate")?.hasAttribute("aria-live")).toBe(false);
    expect(root(element).querySelector("#delegate-roster-rows")?.hasAttribute("hidden")).toBe(false);
    const running = required(rows[0]);
    expect(running.querySelector(".kind")?.getAttribute("aria-label")).toBe("Subagent");
    expect(running.querySelector(".state")?.getAttribute("aria-label")).toBe("Running");
    expect(running.querySelector("strong")?.textContent).toBe("Roster implementation");
    expect(running.querySelector(".meta")?.textContent).toBe("implementation · gpt-5.6-sol · medium");
    expect(running.querySelector(".meta")?.getAttribute("title")).toContain("openai-codex/gpt-5.6-sol-20260921");
    expect(running.querySelector(".task")?.textContent).toBe(longObjective);
    expect(running.querySelector(".task")?.getAttribute("title")).toBe(longObjective);
    expect(running.querySelector(".activity")?.textContent).toBe("Wiring the roster CSS");
    expect(running.querySelector(".activity")?.getAttribute("title")).toBe("Wiring the roster CSS");
    expect(running.querySelector(".activity")?.getAttribute("aria-label")).toBe("Reported status: Wiring the roster CSS");
    expect(running.querySelector(".activity")?.textContent).not.toContain("running tests");
    const terminal = required(rows[1]);
    expect(terminal.classList.contains("terminal")).toBe(true);
    expect(terminal.querySelector(".state")?.getAttribute("aria-label")).toBe("Uncollected");
  });

  it("stays collapsed across live updates until its keyboard-focusable button is clicked again", async () => {
    const element = new DelegateRoster();
    element.onToggleCollapsed = () => { element.collapsed = !element.collapsed; };
    element.status = status({ [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [
      { id: "one", kind: "worker", activity: "running" },
      { id: "two", kind: "subagent", activity: "success" },
    ] }) });
    document.body.append(element);
    await element.updateComplete;

    let toggle = required(root(element).querySelector<HTMLButtonElement>(".section-toggle"));
    toggle.focus();
    expect(root(element).activeElement).toBe(toggle);
    toggle.click();
    await element.updateComplete;
    expect(element.collapsed).toBe(true);
    expect(element.hasAttribute("collapsed")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("delegate-roster-rows");
    expect(root(element).querySelector<HTMLElement>("#delegate-roster-rows")?.hidden).toBe(true);
    expect(root(element).querySelectorAll(".row")).toHaveLength(2);
    expect(root(element).querySelector(".aggregate")?.textContent).toBe("1 running delegate · 1 uncollected · 0 watchers · 0 shells");

    element.status = status({ [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [
      { id: "one", kind: "worker", activity: "running" },
      { id: "two", kind: "subagent", activity: "success" },
      { id: "three", kind: "subagent", activity: "running tests" },
    ] }) });
    await element.updateComplete;
    toggle = required(root(element).querySelector<HTMLButtonElement>(".section-toggle"));
    expect(element.collapsed).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(root(element).querySelector(".section-count")?.textContent).toBe("3");
    expect(root(element).querySelector(".aggregate")?.textContent).toBe("2 running delegates · 1 uncollected · 0 watchers · 0 shells");
    expect(root(element).querySelector<HTMLElement>("#delegate-roster-rows")?.hidden).toBe(true);
    expect(root(element).querySelectorAll(".row")).toHaveLength(3);

    toggle.click();
    await element.updateComplete;
    expect(element.collapsed).toBe(false);
    expect(root(element).querySelector<HTMLElement>("#delegate-roster-rows")?.hidden).toBe(false);
    expect(root(element).querySelectorAll(".row")).toHaveLength(3);
    expect(DelegateRoster.styles.cssText).toMatch(/@media \(max-width: 700px\)[\s\S]*\.aggregate\s*\{[^}]*order:\s*-1/);
  });

  it("merges sources across lifecycle and reconnect without stale rows or lost collapse", async () => {
    const element = new DelegateRoster();
    element.onToggleCollapsed = () => { element.collapsed = !element.collapsed; };
    const delegate = { schemaVersion: 1, items: [
      { id: "same", kind: "worker", name: "Agent", activity: "running" },
      { id: "done", kind: "subagent", name: "Result", activity: "success" },
    ] };
    const watcher = { logicalId: "same", handleId: "handle", label: "<script>not markup</script>", mode: "poll", scope: "[REDACTED]", state: "watching", consecutiveFailures: 0, startedAt: "2026-08-02T10:00:00.000Z" };
    const shell = { id: "same", kind: "shell", toolName: "bash", label: "Shell command" } as const;
    const sources = (watchers: unknown[] = [watcher], tools: SessionStatus["activeToolExecutions"] = [shell]): SessionStatus => ({
      ...status({ [ACTIVITY_STATUS_KEY]: JSON.stringify(delegate), [WATCHER_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, watchers }) }),
      activeToolExecutions: tools,
    });
    element.status = sources();
    document.body.append(element);
    await element.updateComplete;
    const shadow = root(element);
    expect(shadow.querySelector("section")?.getAttribute("aria-label")).toBe("Activity");
    expect([...shadow.querySelectorAll(".row")].map((row) => row.getAttribute("data-row-key"))).toEqual(["delegate:same", "delegate:done", "watcher:same", "shell:same"]);
    expect(shadow.querySelector(".aggregate")?.textContent).toBe("1 running delegate · 1 uncollected · 1 watcher · 1 shell");
    expect(shadow.querySelector(".section-count")?.getAttribute("aria-label")).toBe("4 total");
    expect(shadow.querySelector('[data-row-key="watcher:same"] .kind')?.getAttribute("aria-label")).toBe("Poll watcher");
    expect(shadow.querySelector('[data-row-key="watcher:same"] .state')?.getAttribute("aria-label")).toBe("Monitor: watching");
    expect(shadow.querySelector('[data-row-key="watcher:same"] .activity')?.textContent).toBe("Monitor: watching");
    expect(shadow.querySelector("script")).toBeNull();
    expect(shadow.querySelector('[data-row-key="watcher:same"] .meta')?.textContent).toBe("<script>not markup</script>");
    expect(shadow.querySelector('[data-row-key="watcher:same"] .task')?.textContent).toBe("Scope: [REDACTED]");
    expect(shadow.querySelector('[data-row-key="watcher:same"] .task')?.getAttribute("title")).toBe("Scope: [REDACTED]");
    expect(shadow.querySelector('[data-row-key="watcher:same"] .state')?.classList.contains("warning")).toBe(false);
    expect(shadow.querySelector('[data-row-key="shell:same"] .task')?.textContent).toBe("Built-in bash tool");

    const button = required(shadow.querySelector<HTMLButtonElement>(".section-toggle"));
    button.focus();
    button.click();
    await element.updateComplete;
    expect(shadow.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(shadow.querySelector<HTMLElement>("#delegate-roster-rows")?.hidden).toBe(true);
    const watcherRow = shadow.querySelector('[data-row-key="watcher:same"]');
    element.status = sources([{ ...watcher, handleId: "recovered", state: "suspended", consecutiveFailures: 3 }], [shell, { id: "two", kind: "shell", toolName: "shell", label: "Interactive shell", startedAt: "2026-08-02T10:00:01Z" }]);
    await element.updateComplete;
    expect(shadow.querySelector('[data-row-key="watcher:same"]')).toBe(watcherRow);
    expect(watcherRow?.querySelector("strong")?.textContent).toBe("recovered");
    expect(shadow.querySelector(".aggregate")?.textContent).toBe("1 running delegate · 1 uncollected · 1 watcher · 2 shells");
    expect(shadow.querySelector('[data-row-key="watcher:same"] .activity')?.textContent).toBe("Monitor: suspended · 3 consecutive failures");
    expect(watcherRow?.querySelector(".state")?.classList.contains("warning")).toBe(true);
    expect(watcherRow?.querySelector(".state")?.getAttribute("aria-label")).toBe("Monitor: suspended");
    expect(shadow.querySelector('[data-row-key="shell:two"] .task')?.textContent).toBe("Interactive ! shell");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // The daemon retains the interactive shell after agent abort until its own promise settles.
    element.status = sources([], [shell, { id: "two", kind: "shell", toolName: "shell", label: "Interactive shell" }]);
    await element.updateComplete;
    expect(shadow.querySelector('[data-row-key="watcher:same"]')).toBeNull();
    expect(shadow.querySelector('[data-row-key="shell:two"]')).not.toBeNull();
    element.status = { ...status({ [ACTIVITY_STATUS_KEY]: JSON.stringify(delegate) }), activeToolExecutions: [] }; // monitor clears its status key on last stop/expiry
    await element.updateComplete;
    expect(shadow.querySelector('[data-row-key="watcher:same"]')).toBeNull();
    element.status = sources([], []);
    await element.updateComplete;
    expect(shadow.querySelectorAll(".row")).toHaveLength(2);
    expect(shadow.querySelector('[data-row-key="delegate:done"] .state')?.getAttribute("aria-label")).toBe("Uncollected");
    expect(shadow.querySelector(".section-count")?.textContent).toBe("2");
    element.status = status({}); // reconnect/clear: no cached rows
    await element.updateComplete;
    expect(shadow.querySelector("section")).toBeNull();
    element.status = sources(); // fresh status, collapse remains parent-owned
    await element.updateComplete;
    expect(shadow.querySelectorAll(".row")).toHaveLength(4);
    expect(required(shadow.querySelector<HTMLButtonElement>(".section-toggle")).getAttribute("aria-expanded")).toBe("false");
  });

  it("renders watcher-only and shell-only status without inferring other activity", async () => {
    const element = new DelegateRoster();
    document.body.append(element);
    element.status = status({ [WATCHER_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, watchers: [
      { logicalId: "watch", handleId: "handle", mode: "file", scope: "", state: "quarantined", consecutiveFailures: 0, startedAt: "2026-08-02T10:00:00.000Z" },
    ] }) });
    await element.updateComplete;
    expect(root(element).querySelector(".aggregate")?.textContent).toBe("0 running delegates · 0 uncollected · 1 watcher · 0 shells");
    expect(root(element).querySelector(".kind")?.getAttribute("aria-label")).toBe("File watcher");
    expect(root(element).querySelector(".state")?.getAttribute("aria-label")).toBe("Monitor: quarantined");
    expect(root(element).querySelector(".state")?.classList.contains("warning")).toBe(true);
    expect(root(element).querySelector(".task")?.textContent).toBe("Scope: Not specified");
    expect(DelegateRoster.styles.cssText).toMatch(/\.state\.watcher-state\.warning\s*\{[^}]*var\(--pi-warning\)/);
    element.status = { ...status({}), activeToolExecutions: [{ id: "shell:old", kind: "shell", toolName: "shell", label: "Interactive shell" }] };
    await element.updateComplete;
    expect(root(element).querySelector(".section-count")?.textContent).toBe("1");
    expect(root(element).querySelector(".kind")?.getAttribute("aria-label")).toBe("Shell");
    expect(root(element).querySelector(".row")?.getAttribute("data-row-key")).toBe("shell:shell:old");
  });

  it("shows safe bounded watcher scopes without hiding other rows", async () => {
    const element = new DelegateRoster();
    const watcher = { logicalId: "one", handleId: "handle-1", mode: "poll", scope: "界\u200b\u202e\u0000 ready\n<path>", state: "retrying", consecutiveFailures: 1, startedAt: "2026-08-02T10:00:00.000Z" };
    element.status = status({ [WATCHER_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, watchers: [watcher, { ...watcher, logicalId: "two", handleId: "handle-2", scope: "log file", state: "watching" }] }) });
    document.body.append(element);
    await element.updateComplete;
    const shadow = root(element);
    expect(shadow.querySelectorAll(".row")).toHaveLength(2);
    expect(shadow.querySelector(".aggregate")?.textContent).toContain("2 watchers");
    const task = required(shadow.querySelector('[data-row-key="watcher:one"] .task'));
    expect(task.textContent).toBe("Scope: 界 ready <path>");
    expect(task.getAttribute("title")).toBe("Scope: 界 ready <path>");
    expect(shadow.querySelector("path")).toBeNull();
    expect(shadow.querySelector('[data-row-key="watcher:one"] .state')?.getAttribute("aria-label")).toBe("Monitor: retrying");
    expect(shadow.querySelector('[data-row-key="watcher:one"] .state')?.classList.contains("warning")).toBe(false);
    expect(shadow.querySelector('[data-row-key="watcher:two"] .task')?.textContent).toBe("Scope: log file");
  });

  it("renders normalized watcher labels as text without hiding sibling rows", async () => {
    const element = new DelegateRoster();
    const watcher = { logicalId: "one", handleId: "handle-1", label: "界\u200b\u00ad\u0000 ready\n<script>text</script>", mode: "poll", scope: "safe", state: "watching", consecutiveFailures: 0, startedAt: "2026-08-02T10:00:00.000Z" };
    element.status = status({ [WATCHER_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, watchers: [watcher, { ...watcher, logicalId: "two", handleId: "handle-2", label: "\u200b\u00ad\u0000" }] }) });
    document.body.append(element);
    await element.updateComplete;
    const shadow = root(element);
    expect(shadow.querySelectorAll(".row")).toHaveLength(2);
    expect(shadow.querySelector('[data-row-key="watcher:one"] .meta')?.textContent).toBe("界 ready <script>text</script>");
    expect(shadow.querySelector('[data-row-key="watcher:one"] .meta')?.getAttribute("title")).toBe("界 ready <script>text</script>");
    expect(shadow.querySelector('[data-row-key="watcher:two"] .meta')).toBeNull();
    expect(shadow.querySelector("script")).toBeNull();
  });

  it("keeps delegates and shells visible when monitor status is malformed", async () => {
    const element = new DelegateRoster();
    const activity = JSON.stringify({ schemaVersion: 1, items: [{ id: "one", kind: "worker" }] });
    element.status = { ...status({ [ACTIVITY_STATUS_KEY]: activity, [WATCHER_STATUS_KEY]: '{"schemaVersion":1,"watchers":[{}]}' }),
      activeToolExecutions: [{ id: "shell:one", kind: "shell", toolName: "shell", label: "Interactive shell" }] };
    document.body.append(element);
    await element.updateComplete;
    expect(root(element).querySelectorAll(".row")).toHaveLength(2);
    expect(root(element).querySelector(".aggregate")?.textContent).toBe("1 running delegate · 0 uncollected · 0 watchers · 1 shell");
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
    expect(row.querySelector(".activity")?.textContent).toBe("No status report · running bash");
    expect(row.querySelector(".activity")?.getAttribute("title")).toBe("No status report · running bash");
    expect(row.querySelector(".activity")?.getAttribute("aria-label")).toBe("No status report; inferred activity: running bash");
  });

  it("tolerates a snapshot without the reportedStatus field at all", async () => {
    const element = new DelegateRoster();
    document.body.append(element);
    element.status = status({ [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [
      { id: "one", kind: "worker", name: "UI", objective: "Build roster" },
    ] }) });
    await element.updateComplete;
    const row = required(root(element).querySelector(".row"));
    expect(row.querySelector(".activity")?.textContent).toBe("No status report · starting");
    expect(row.querySelector(".activity")?.getAttribute("aria-label")).toBe("No status report; inferred activity: starting");
  });
});
