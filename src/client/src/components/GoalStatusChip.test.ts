// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import { GOAL_STATUS_KEY, GOAL_STATUS_STATE_VALUES, type GoalStatusState } from "../extensionStatusSnapshots";
import { GoalStatusChip } from "./GoalStatusChip";

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

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

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

  it("hides absent, cleared, and invalid Goal status", async () => {
    const element = await mount(sessionStatus());
    expect(element.hidden).toBe(true);
    expect(element.shadowRoot?.querySelector("details")).toBeNull();

    element.status = sessionStatus("legacy Goal text");
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("details")).toBeNull();

    element.status = sessionStatus(JSON.stringify({ schemaVersion: 1, goalId: "goal-1", state: "complete", objective: "Done" }));
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("details")).toBeNull();

    element.status = sessionStatus();
    await element.updateComplete;
    expect(element.hidden).toBe(true);
    expect(element.shadowRoot?.querySelector("details")).toBeNull();
  });

  it("renders live and reload-shaped SessionStatus through the same path", async () => {
    const json = snapshot("waiting");
    const live = await mount(sessionStatus(json));
    const liveText = live.shadowRoot?.textContent;
    live.remove();

    const reloadStatus = { ...sessionStatus(json), persisted: true, messageCount: 12 };
    const reloaded = await mount(reloadStatus);
    expect(reloaded.shadowRoot?.textContent).toBe(liveText);
  });

  it("keeps state and short ID fixed while the objective truncates at narrow widths", () => {
    expect(GoalStatusChip.styles.cssText).toMatch(/:host\s*\{[^}]*min-width:\s*0[^}]*max-width:/);
    expect(GoalStatusChip.styles.cssText).toMatch(/\.identity, \.state, \.short-id\s*\{[^}]*flex:\s*0 0 auto/);
    expect(GoalStatusChip.styles.cssText).toMatch(/\.objective\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
    expect(GoalStatusChip.styles.cssText).toMatch(/@media \(max-width: 700px\)/);
  });
});
