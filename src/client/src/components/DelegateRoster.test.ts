// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY, BACKGROUND_BASH_STATUS_KEY, WATCHER_STATUS_KEY } from "../extensionStatusSnapshots";
import { DelegateRoster } from "./DelegateRoster";

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

function status(extensionStatuses: Record<string, string>, activeToolExecutions?: SessionStatus["activeToolExecutions"]): SessionStatus {
  return {
    sessionId: "s", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    extensionStatuses, ...(activeToolExecutions === undefined ? {} : { activeToolExecutions }),
  };
}

const delegates = (items: unknown[]) => ({ [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items }) });

async function mount(value: SessionStatus, setup?: (element: DelegateRoster) => void): Promise<{ element: DelegateRoster; shadow: ShadowRoot }> {
  const element = new DelegateRoster();
  element.status = value;
  setup?.(element);
  document.body.append(element);
  await element.updateComplete;
  if (element.shadowRoot === null) throw new Error("missing shadow root");
  return { element, shadow: element.shadowRoot };
}

function row(shadow: ShadowRoot, key: string): HTMLElement {
  const found = shadow.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
  if (found === null) throw new Error(`missing row ${key}`);
  return found;
}

/** Visible text only: screen-reader prefixes are asserted separately. */
function visibleText(element: Element | null): string {
  return [...(element?.childNodes ?? [])]
    .filter((node) => !(node instanceof Comment) && !(node instanceof HTMLElement && node.classList.contains("visually-hidden")))
    .map((node) => node.textContent ?? "").join("").trim();
}

describe("DelegateRoster delegate rows", () => {
  it("leads with the child's own report and keeps inferred activity, objectives and model details out of the row text", async () => {
    const { shadow } = await mount(status(delegates([
      { id: "a", kind: "subagent", name: "Composer", role: "implementation", model: "openai-codex/gpt-5.6-sol-20260921", effort: "medium", objective: "Implement the long assignment", activity: "reading src/a.ts", reportedStatus: "Setting up the worktree" },
      { id: "b", kind: "worker", name: "Rows", activity: "reading src/b.ts" },
      { id: "c", kind: "subagent", activity: "success" },
    ])));

    const report = row(shadow, "delegate:a").querySelector(".report");
    expect(visibleText(report)).toBe("Setting up the worktree");
    expect(report?.querySelector(".visually-hidden")?.textContent).toBe("Status: ");
    expect(report?.getAttribute("title"), "a truncated report stays readable in full").toBe("Setting up the worktree");
    const name = row(shadow, "delegate:a").querySelector(".name");
    expect(name?.textContent).toBe("Composer");
    expect(name?.getAttribute("title")).toBe("Subagent · implementation · gpt-5.6-sol · medium");
    expect(row(shadow, "delegate:a").textContent).not.toContain("gpt-5.6-sol");

    expect(row(shadow, "delegate:b").querySelector(".report.fallback")?.textContent).toBe("Waiting for its first status report");
    expect(row(shadow, "delegate:c").querySelector(".report.fallback")?.textContent).toBe("No status report received");
    expect(row(shadow, "delegate:c").querySelector(".name")?.textContent).toBe("Unnamed");
    for (const text of ["reading src/", "Implement the long assignment"]) expect(shadow.textContent).not.toContain(text);
  });

  it("puts failures and results to collect first and names every state in words, not colour alone", async () => {
    const { shadow } = await mount(status(delegates([
      { id: "run", kind: "worker", name: "Grid", activity: "editing" },
      { id: "done", kind: "subagent", name: "Review", activity: "success" },
      { id: "fail", kind: "subagent", name: "Spec", activity: "execution_failed" },
      { id: "late", kind: "subagent", name: "Slow", activity: "timed out" },
    ])));

    expect([...shadow.querySelectorAll(".row")].map((element) => element.getAttribute("data-row-key"))).toEqual(["delegate:fail", "delegate:late", "delegate:done", "delegate:run"]);
    const states = (key: string) => [row(shadow, key).querySelector(".kind")?.getAttribute("aria-label"), visibleText(row(shadow, key).querySelector(".status")), row(shadow, key).querySelector(".status")?.getAttribute("title")];
    expect(states("delegate:fail")).toEqual(["Subagent, failed", "Execution failed", "Failed: execution failed"]);
    expect(states("delegate:late")).toEqual(["Subagent, failed", "Timed out", "Failed: timed out"]);
    expect(states("delegate:done")).toEqual(["Subagent, to collect", "To collect", "Finished; its result is waiting to be collected"]);
    expect(states("delegate:run")[0]).toBe("Worker, running");
    expect(shadow.querySelector(".aggregate")?.textContent).toBe("2 failed · 1 to collect · 1 running");
  });

  it("shows how long each delegate has run and how fresh its report is, flags a quiet one, and stops counting when it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-21T10:20:00.000Z"));
    const { element, shadow } = await mount(status(delegates([
      { id: "fresh", kind: "subagent", name: "Fresh", reportedStatus: "Writing tests", startedAt: "2026-10-21T10:08:00.000Z", reportedAt: "2026-10-21T10:19:15.000Z" },
      { id: "quiet", kind: "worker", name: "Quiet", reportedStatus: "Running e2e", startedAt: "2026-10-21T09:00:00.000Z", reportedAt: "2026-10-21T10:05:00.000Z" },
      { id: "new", kind: "subagent", name: "New", startedAt: "2026-10-21T10:19:58.000Z" },
      { id: "done", kind: "subagent", name: "Done", activity: "success", startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:04:30.000Z" },
      { id: "legacy", kind: "subagent", name: "Legacy", reportedStatus: "Old Workbench" },
    ])), (roster) => { roster.collapsed = false; });
    const times = (key: string) => [visibleText(row(shadow, key).querySelector(".status")), visibleText(row(shadow, key).querySelector(".elapsed"))];

    expect([...shadow.querySelectorAll(".row")].map((element) => element.getAttribute("data-row-key")), "a quiet delegate rises above healthy ones")
      .toEqual(["delegate:done", "delegate:quiet", "delegate:fresh", "delegate:new", "delegate:legacy"]);
    expect(times("delegate:fresh")).toEqual(["45s ago", "12m"]);
    expect(row(shadow, "delegate:fresh").querySelector(".status .visually-hidden")?.textContent).toBe("Reported ");
    expect(row(shadow, "delegate:fresh").querySelector(".elapsed .visually-hidden")?.textContent).toBe("Running for ");
    expect(times("delegate:quiet"), "a quiet delegate says so in words").toEqual(["Quiet 15m", "1h 20m"]);
    const quiet = row(shadow, "delegate:quiet").querySelector(".status");
    expect(quiet?.classList.contains("quiet")).toBe(true);
    expect(quiet?.getAttribute("title")).toBe("No status report for 15m; it may be stuck");
    expect(quiet?.querySelector("svg"), "quiet carries a shape cue, not just a colour").not.toBeNull();
    expect(row(shadow, "delegate:fresh").querySelector(".status")?.classList.contains("quiet")).toBe(false);
    expect(times("delegate:new")).toEqual(["just now", "2s"]);
    expect(row(shadow, "delegate:new").querySelector(".status .visually-hidden")?.textContent).toBe("Started ");
    expect(times("delegate:done")).toEqual(["To collect", "4m"]);
    expect(row(shadow, "delegate:done").querySelector(".elapsed")?.getAttribute("title")).toBe("Ran for 4m");
    expect(times("delegate:legacy"), "payloads without times show no times").toEqual(["", ""]);

    vi.advanceTimersByTime(60_000);
    await element.updateComplete;
    expect(times("delegate:fresh"), "the clock ticks while the rows are visible").toEqual(["1m ago", "13m"]);
    expect(times("delegate:done"), "a finished delegate's run time is frozen").toEqual(["To collect", "4m"]);

    element.collapsed = true;
    await element.updateComplete;
    expect(vi.getTimerCount(), "no clock runs while collapsed").toBe(0);
    element.collapsed = false;
    await element.updateComplete;
    expect(vi.getTimerCount()).toBe(1);
    element.remove();
    expect(vi.getTimerCount(), "no clock runs once detached").toBe(0);
  });
});

describe("DelegateRoster watcher and shell rows", () => {
  it("keeps every source in one stable grid across lifecycle updates and reconnects, rendering untrusted text as text", async () => {
    const watcher = { logicalId: "same", handleId: "handle", label: "<script>not markup</script>", mode: "poll", scope: "[REDACTED]", state: "watching", consecutiveFailures: 0, startedAt: "2026-08-02T10:00:00.000Z" };
    const shell = { id: "same", kind: "shell", toolName: "bash", label: "Shell command" } as const;
    const sources = (watchers: unknown[] = [watcher], tools: SessionStatus["activeToolExecutions"] = [shell]) => status({
      ...delegates([{ id: "same", kind: "worker", name: "Agent", activity: "running" }, { id: "done", kind: "subagent", name: "Result", activity: "success" }]),
      [WATCHER_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, watchers }),
    }, tools);
    const { element, shadow } = await mount(sources());

    expect([...shadow.querySelectorAll(".row")].map((element) => element.getAttribute("data-row-key"))).toEqual(["delegate:done", "delegate:same", "watcher:same", "shell:same"]);
    expect(shadow.querySelector(".aggregate")?.textContent).toBe("1 to collect · 1 running · 1 watcher · 1 shell");
    const watcherRow = row(shadow, "watcher:same");
    expect(watcherRow.querySelector(".kind")?.getAttribute("aria-label")).toBe("Poll watcher, watching");
    expect(watcherRow.querySelector(".name")?.textContent).toBe("<script>not markup</script>");
    expect(visibleText(watcherRow.querySelector(".report"))).toBe("[REDACTED]");
    expect(watcherRow.querySelector(".status")?.textContent).toBe("Watching");
    expect(shadow.querySelector("script")).toBeNull();
    expect(visibleText(row(shadow, "shell:same").querySelector(".report"))).toBe("Built-in bash tool");

    element.status = sources([{ ...watcher, handleId: "recovered", label: undefined, state: "suspended", consecutiveFailures: 3 }], [shell, { id: "two", kind: "shell", toolName: "shell", label: "Interactive shell", startedAt: "2026-08-02T10:00:01Z" }]);
    await element.updateComplete;
    expect(row(shadow, "watcher:same"), "a row keeps its element across updates").toBe(watcherRow);
    expect(watcherRow.querySelector(".name")?.textContent).toBe("recovered");
    expect(watcherRow.querySelector(".status")?.textContent).toBe("Suspended · 3 failures");
    expect(watcherRow.classList.contains("warning")).toBe(true);
    expect(visibleText(row(shadow, "shell:two").querySelector(".report"))).toBe("Interactive ! shell");
    expect(shadow.querySelector(".aggregate")?.textContent).toBe("1 to collect · 1 running · 1 watcher · 2 shells");

    element.status = status({}); // reconnect/clear: no cached rows
    await element.updateComplete;
    expect(shadow.querySelector("section")).toBeNull();
  });

  it("keeps delegates and shells visible when monitor status is malformed, and shows a watcher without scope plainly", async () => {
    const { element, shadow } = await mount(status({ ...delegates([{ id: "one", kind: "worker" }]), [WATCHER_STATUS_KEY]: '{"schemaVersion":1,"watchers":[{}]}' },
      [{ id: "shell:one", kind: "shell", toolName: "shell", label: "Interactive shell" }]));
    expect(shadow.querySelectorAll(".row")).toHaveLength(2);
    expect(shadow.querySelector(".aggregate")?.textContent).toBe("1 running · 1 shell");

    element.status = status({ [WATCHER_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, watchers: [
      { logicalId: "watch", handleId: "handle", mode: "file", scope: "", state: "quarantined", consecutiveFailures: 0, startedAt: "2026-08-02T10:00:00.000Z" },
    ] }) });
    await element.updateComplete;
    expect(shadow.querySelector(".kind")?.getAttribute("aria-label")).toBe("File watcher, quarantined");
    expect(shadow.querySelector(".report.fallback")?.textContent).toBe("No scope given");
    expect(shadow.querySelector(".row")?.classList.contains("warning")).toBe(true);
  });

  it("expands a background bash row to show its command, recent output, and log path", async () => {
    const { element, shadow } = await mount(status({ [BACKGROUND_BASH_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, jobs: [{ id: "job-1", elapsedSeconds: 84, bytes: 4096, command: "npm test", output: "passing\n", logPath: "/jobs/job-1/output.log" }] }) }));
    const jobRow = row(shadow, "background-bash:job-1");
    expect([visibleText(jobRow.querySelector(".report")), jobRow.querySelector(".status")?.textContent, visibleText(jobRow.querySelector(".elapsed"))]).toEqual(["npm test", "4.0 KB", "1m"]);
    const toggle = jobRow.querySelector<HTMLButtonElement>("button.expand");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(shadow.querySelector(".bash-log")).toBeNull();
    toggle?.click();
    await element.updateComplete;
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const log = shadow.querySelector(".bash-log");
    expect(log?.querySelector("code")?.textContent).toBe("$ npm test");
    expect(log?.querySelector("pre")?.textContent).toBe("passing\n");
    expect(log?.querySelector("small")?.textContent).toContain("/jobs/job-1/output.log");
    expect(log?.querySelector("small + pre"), "the log path stays above the scrolling output").not.toBeNull();
    const pre = log?.querySelector("pre");
    if (!(pre instanceof HTMLElement)) throw new Error("missing output");
    Object.defineProperty(pre, "scrollHeight", { configurable: true, value: 500 });
    element.requestUpdate();
    await element.updateComplete;
    expect(pre.scrollTop, "an open log follows its newest output").toBe(500);
    pre.dataset["pinned"] = "false";
    pre.scrollTop = 100;
    element.requestUpdate();
    await element.updateComplete;
    expect(pre.scrollTop, "a reader who scrolled up keeps their place").toBe(100);
  });
});

describe("DelegateRoster disclosure", () => {
  it("stays collapsed across live updates until its button is clicked again", async () => {
    const items = [{ id: "one", kind: "worker", activity: "running" }, { id: "two", kind: "subagent", activity: "success" }];
    const { element, shadow } = await mount(status(delegates(items)), (roster) => { roster.onToggleCollapsed = () => { roster.collapsed = !roster.collapsed; }; });
    const toggle = shadow.querySelector<HTMLButtonElement>(".section-toggle");
    expect(toggle?.getAttribute("aria-controls")).toBe("delegate-roster-rows");
    toggle?.focus();
    toggle?.click();
    await element.updateComplete;
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(shadow.querySelector<HTMLElement>("#delegate-roster-rows")?.hidden).toBe(true);

    element.status = status(delegates([...items, { id: "three", kind: "subagent" }]));
    await element.updateComplete;
    expect(element.collapsed).toBe(true);
    expect(shadow.querySelector(".aggregate")?.textContent).toBe("1 to collect · 2 running");
    expect(shadow.activeElement).toBe(toggle);

    toggle?.click();
    await element.updateComplete;
    expect(shadow.querySelector<HTMLElement>("#delegate-roster-rows")?.hidden).toBe(false);
    expect(shadow.querySelectorAll(".row")).toHaveLength(3);
  });

  it("folds away entirely in a collapsed Grid tile, leaving the composer's badge, and shows as usual when expanded", async () => {
    const { element, shadow } = await mount(status(delegates([{ id: "a", kind: "subagent", name: "Review" }])), (roster) => { roster.compact = true; roster.collapsed = true; });
    expect(shadow.querySelector("section")).toBeNull();
    element.collapsed = false;
    await element.updateComplete;
    expect(shadow.querySelector(".aggregate")?.textContent).toBe("1 running");
    expect(shadow.querySelector(".section-toggle")?.getAttribute("aria-expanded")).toBe("true");
  });
});
