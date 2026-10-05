// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY, BACKGROUND_BASH_STATUS_KEY } from "../extensionStatusSnapshots";
import { DelegateRoster } from "./DelegateRoster";

afterEach(() => { document.body.replaceChildren(); });

async function statusCells(items: unknown[]): Promise<HTMLElement[]> {
  const element = new DelegateRoster();
  element.status = {
    sessionId: "s", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    extensionStatuses: { [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items }) },
  } satisfies SessionStatus;
  document.body.append(element);
  await element.updateComplete;
  return [...(element.shadowRoot?.querySelectorAll<HTMLElement>(".delegate-status") ?? [])];
}

function visibleText(cell: HTMLElement | undefined): string | undefined {
  return [...(cell?.childNodes ?? [])]
    .filter((node) => !(node instanceof Comment) && !(node instanceof HTMLElement && node.classList.contains("visually-hidden")))
    .map((node) => node.textContent ?? "").join("").trim();
}

describe("DelegateRoster status cell", () => {
  it("shows the child's report as plain text, falls back distinctly, and never shows inferred activity", async () => {
    const [report, waiting, missing] = await statusCells([
      { id: "a", kind: "subagent", name: "Composer", activity: "reading src/a.ts", reportedStatus: "Setting up the worktree" },
      { id: "b", kind: "worker", name: "Rows", activity: "reading src/b.ts" },
      { id: "c", kind: "subagent", name: "Review", activity: "success" },
    ]);

    expect(visibleText(report)).toBe("Setting up the worktree");
    expect(report?.classList.contains("fallback")).toBe(false);
    expect(report?.querySelector(".visually-hidden")?.textContent).toBe("Self-report: ");
    expect(visibleText(waiting)).toBe("Waiting for status report");
    expect(waiting?.classList.contains("fallback")).toBe(true);
    expect(visibleText(missing)).toBe("No status report received");
    expect(missing?.classList.contains("fallback")).toBe(true);
    for (const cell of [report, waiting, missing]) {
      expect(cell?.textContent).not.toContain("Reported status:");
      expect(cell?.textContent).not.toContain("reading src/");
    }
    const css = DelegateRoster.styles.cssText;
    expect(css).toMatch(/\.delegate-status\.fallback\s*\{[^}]*font-style:\s*italic/);
    expect(css).toMatch(/\.rows\s*\{[^}]*grid-template-columns:\s*8px fit-content\(35%\)/);
    expect(css).toMatch(/\.row\s*\{[^}]*grid-template-columns:\s*subgrid/);
  });

  it("expands a background bash row to show its command, recent output, and log path", async () => {
    const element = new DelegateRoster();
    element.status = {
      sessionId: "s", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
      extensionStatuses: { [BACKGROUND_BASH_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, jobs: [{ id: "job-1", elapsedSeconds: 3, bytes: 9, command: "npm test", output: "passing\n", logPath: "/jobs/job-1/output.log" }] }) },
    } satisfies SessionStatus;
    document.body.append(element);
    await element.updateComplete;
    const toggle = element.shadowRoot?.querySelector<HTMLButtonElement>("button.expand");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(element.shadowRoot?.querySelector(".bash-log")).toBeNull();
    toggle?.click();
    await element.updateComplete;
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const log = element.shadowRoot?.querySelector(".bash-log");
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
