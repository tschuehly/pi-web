// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { StatusBar, statusBarWarningControlContent } from "./StatusBar";
import { sessionStatusPresentation } from "./sessionStatusPresentation";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("statusBarWarningControlContent", () => {
  it("provides an action label for both states while keeping only the count visible", () => {
    expect(statusBarWarningControlContent(1, true)).toEqual({
      countText: "1",
      accessibleLabel: "Minimise 1 warning",
    });
    expect(statusBarWarningControlContent(3, false)).toEqual({
      countText: "3",
      accessibleLabel: "Show 3 warnings in the warning area",
    });
  });

  it("omits the control content when there are no warnings", () => {
    expect(statusBarWarningControlContent(0, false)).toBeUndefined();
  });
});

describe("sessionStatusPresentation", () => {
  it("shares compact context, token, cost, and queue formatting across status presentations", () => {
    expect(sessionStatusPresentation({
      ...status(),
      contextUsage: { tokens: 160_000, contextWindow: 200_000, percent: 80 },
      tokens: { input: 12_400, output: 987, cacheRead: 0, cacheWrite: 0, total: 13_387 },
      cost: 0.125,
      pendingMessageCount: 2,
    })).toEqual({
      contextText: "80.0%/200k",
      contextSummaryText: "⚠ 80.0% context",
      contextCompactText: "⚠ 80.0%",
      contextStatusText: "⚠ 80.0%/200k",
      contextAccessibleLabel: "High context usage: 80.0% of 200k context window",
      contextHighUsage: true,
      inputText: "↑12k",
      outputText: "↓987",
      costText: "$0.13",
      queuedText: "2 queued",
      detailText: "↑12k · ↓987 · $0.13 · 2 queued",
    });
  });

  it("does not flag context usage below 80 percent", () => {
    expect(sessionStatusPresentation({
      ...status(),
      contextUsage: { tokens: 159_800, contextWindow: 200_000, percent: 79.9 },
    }).contextHighUsage).toBe(false);
  });
});

describe("StatusBar default-shell presentation", () => {
  it("renders the same non-color high-context warning and invokes its warning toggle", async () => {
    const statusBar = new StatusBar();
    const onToggleWarnings = vi.fn();
    statusBar.status = { ...status(), contextUsage: { tokens: 160_000, contextWindow: 200_000, percent: 80 } };
    statusBar.warningCount = 2;
    statusBar.warningsExpanded = true;
    statusBar.onToggleWarnings = onToggleWarnings;
    document.body.append(statusBar);
    await statusBar.updateComplete;

    const context = statusBar.shadowRoot?.querySelector(".context");
    expect(context?.textContent).toBe("⚠ 80.0%/200k");
    expect(context?.getAttribute("aria-label")).toContain("High context usage");
    const toggle = statusBar.shadowRoot?.querySelector(".warning-toggle");
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("Expected warning toggle");
    toggle.click();
    expect(onToggleWarnings).toHaveBeenCalledOnce();
  });

  it.each([undefined, null])("renders unknown status for a %s value", async (nullishStatus) => {
    const statusBar = new StatusBar();
    statusBar.status = nullishStatus;
    document.body.append(statusBar);
    await statusBar.updateComplete;

    expect(statusBar.shadowRoot?.textContent).toContain("No session status yet");
  });
});

function status(): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}
