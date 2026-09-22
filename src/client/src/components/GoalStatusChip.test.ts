// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { parseSessionStatus } from "../api/parsers";
import { GOAL_STATUS_KEY, GOAL_STATUS_STATE_VALUES, type GoalStatusState } from "../extensionStatusSnapshots";
import { GoalStatusChip, goalSheetMaximumHeight } from "./GoalStatusChip";
import { autocompleteStyles, promptEditorStyles } from "./shared";

const STATE_LABELS: Record<GoalStatusState, string> = {
  active: "Active",
  waiting: "Waiting",
  paused: "Paused",
  blocked: "Blocked",
  usage_limited: "Usage limited",
  budget_limited: "Budget limited",
};

function sessionStatus(goal?: string): SessionStatus {
  return {
    sessionId: "session-1", isStreaming: false, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    ...(goal === undefined ? {} : { extensionStatuses: { [GOAL_STATUS_KEY]: goal } }),
  };
}

function snapshot(state: GoalStatusState = "active"): string {
  return JSON.stringify({
    schemaVersion: 1,
    goalId: "goal-1234567890",
    state,
    objective: "Keep the Workbench Goal visible on narrow screens",
  });
}

async function mount(status: SessionStatus): Promise<GoalStatusChip> {
  const element = new GoalStatusChip();
  element.status = status;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--pi-interface-scale");
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GoalStatusChip", () => {
  it("uses a native accessible disclosure with compact and expanded Goal details", async () => {
    const element = await mount(sessionStatus(snapshot()));
    const details = element.shadowRoot?.querySelector<HTMLDetailsElement>("details");
    const summary = details?.querySelector<HTMLElement>("summary");
    const objective = summary?.querySelector<HTMLElement>(".objective");

    expect(element.hidden).toBe(false);
    expect(details).not.toBeNull();
    expect(summary?.textContent).toContain("Goal");
    expect(summary?.textContent).toContain("Active");
    expect(summary?.getAttribute("aria-label")).toBeNull();
    expect(summary?.textContent).toContain("#goal-123…");
    expect(objective?.textContent).toBe("Keep the Workbench Goal visible on narrow screens");
    expect(objective?.title).toBe("Keep the Workbench Goal visible on narrow screens");
    expect(details?.querySelector(".full-id")?.textContent).toBe("goal-1234567890");
    expect(details?.querySelector(".sheet")?.textContent).toContain("Keep the Workbench Goal visible on narrow screens");

    summary?.click();
    expect(details?.open).toBe(true);
  });

  it("renders every Goal state with calm, explicit semantics", async () => {
    const element = await mount(sessionStatus(snapshot()));
    for (const state of GOAL_STATUS_STATE_VALUES) {
      element.status = sessionStatus(snapshot(state));
      await element.updateComplete;
      const details = element.shadowRoot?.querySelector("details");
      expect(details?.getAttribute("data-state")).toBe(state);
      expect(details?.querySelector(".state")?.textContent).toBe(STATE_LABELS[state]);
    }
  });

  it("renders bounded legacy status opaquely without inventing structured fields", async () => {
    const element = await mount(sessionStatus("  Goal 7634074f active\nwaiting for owner  "));
    const details = element.shadowRoot?.querySelector<HTMLDetailsElement>("details[data-legacy]");
    const summary = details?.querySelector("summary");
    expect(element.hidden).toBe(false);
    expect(summary?.textContent).toContain("Goal 7634074f active waiting for owner");
    expect(summary?.getAttribute("aria-label")).toBeNull();
    expect(details?.querySelector(".state")).toBeNull();
    expect(details?.querySelector(".short-id")).toBeNull();
    expect(details?.querySelector(".sheet")?.textContent).toContain("Legacy status");
  });

  it("hides absent, cleared, invalid, and unsupported JSON Goal status", async () => {
    const element = await mount(sessionStatus());
    expect(element.hidden).toBe(true);
    expect(element.shadowRoot?.querySelector("details")).toBeNull();

    element.status = sessionStatus(JSON.stringify({ schemaVersion: 1, goalId: "goal-1", state: "complete", objective: "Done" }));
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("details")).toBeNull();

    element.status = sessionStatus();
    await element.updateComplete;
    expect(element.hidden).toBe(true);
    expect(element.shadowRoot?.querySelector("details")).toBeNull();
  });

  it.each([snapshot("waiting"), "Goal 7634074f active"])("renders status restored through the session parser", async (value) => {
    const live = await mount(sessionStatus(value));
    const liveText = live.shadowRoot?.textContent;
    live.remove();

    const reloadWire: unknown = JSON.parse(JSON.stringify({ ...sessionStatus(value), persisted: true, messageCount: 12 }));
    const reloaded = await mount(parseSessionStatus(reloadWire));
    expect(reloaded.shadowRoot?.textContent).toBe(liveText);
  });

  it("normalizes measured physical space to zoomed CSS pixels without crossing the header", () => {
    expect(goalSheetMaximumHeight(60, 360, 1.5)).toBe(200);
    expect(goalSheetMaximumHeight(60, 360, 1.25)).toBe(240);
    expect(goalSheetMaximumHeight(80, 60, 1)).toBe(0);
    expect(goalSheetMaximumHeight(Number.NaN, 360, 1)).toBe(0);
  });

  it("measures the open sheet and tracks composer and viewport changes until close", async () => {
    let resize: ResizeObserverCallback | undefined;
    const observed: Element[] = [];
    const disconnect = vi.fn();
    class ResizeObserverStub implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe = vi.fn((target: Element) => { observed.push(target); });
      unobserve = vi.fn();
      disconnect = disconnect;
      takeRecords = (): ResizeObserverEntry[] => [];
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    document.documentElement.style.setProperty("--pi-interface-scale", "1.5");
    const header = document.createElement("header");
    const prompt = document.createElement("prompt-editor");
    const element = await mount(sessionStatus(snapshot()));
    document.body.prepend(header);
    document.body.append(prompt);
    const summary = element.shadowRoot?.querySelector<HTMLElement>("summary");
    const details = element.shadowRoot?.querySelector<HTMLDetailsElement>("details");
    if (summary === null || summary === undefined || details === null || details === undefined) throw new Error("Goal disclosure was not rendered");
    let summaryTop = 360;
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 60));
    vi.spyOn(summary, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, summaryTop, 360, 32));

    summary.click();
    await Promise.resolve();
    expect(details.open).toBe(true);
    expect(element.style.getPropertyValue("--goal-sheet-max-height")).toBe("200px");
    expect(observed).toEqual(expect.arrayContaining([header, prompt]));

    summaryTop = 330;
    const observer: unknown = Reflect.get(element, "sheetResizeObserver");
    if (resize === undefined || !(observer instanceof ResizeObserverStub)) throw new Error("Goal sheet resize observer was not installed");
    resize([], observer);
    expect(element.style.getPropertyValue("--goal-sheet-max-height")).toBe("180px");
    summaryTop = 300;
    window.dispatchEvent(new Event("resize"));
    expect(element.style.getPropertyValue("--goal-sheet-max-height")).toBe("160px");

    summary.click();
    await Promise.resolve();
    expect(details.open).toBe(false);
    expect(element.style.getPropertyValue("--goal-sheet-max-height")).toBe("");
    expect(disconnect).toHaveBeenCalled();
  });

  it("keeps the upward disclosure scrollable below the composer menu and clear of its resize handle", () => {
    expect(GoalStatusChip.styles.cssText).toMatch(/details\[open\]\s*\{[^}]*z-index:\s*4/);
    expect(promptEditorStyles.cssText).toMatch(/:host\s*\{[^}]*z-index:\s*5/);
    expect(autocompleteStyles.cssText).toMatch(/\.menu\s*\{[^}]*z-index:\s*10/);
    expect(GoalStatusChip.styles.cssText).toMatch(/:host\s*\{[^}]*margin:\s*0 12px 10px/);
    expect(promptEditorStyles.cssText).toMatch(/\.editor-resize-handle\s*\{[^}]*top:\s*0/);
    expect(GoalStatusChip.styles.cssText).toMatch(/\.sheet\s*\{[^}]*max-height:\s*var\(--goal-sheet-max-height, 0px\)[^}]*overflow:\s*auto[^}]*border-bottom:\s*3px solid var\(--goal-color\)[^}]*border-radius:\s*9px 9px 0 0/);
  });

  it("aligns with the 12px composer inset and prioritizes content at narrow widths", () => {
    expect(GoalStatusChip.styles.cssText).toMatch(/:host\s*\{[^}]*width:\s*min\(560px, calc\(100% - 24px\)\)[^}]*margin:\s*0 12px 10px/);
    expect(GoalStatusChip.styles.cssText).toMatch(/\.objective\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
    expect(GoalStatusChip.styles.cssText).toMatch(/@media \(max-width: 700px\)\s*\{[^}]*\.short-id\s*\{\s*display:\s*none/);
    expect(GoalStatusChip.styles.cssText).not.toMatch(/@media \(max-width: 430px\)\s*\{[^}]*\.identity\s*\{\s*display:\s*none/);
  });
});
