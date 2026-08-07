import { describe, expect, it, vi } from "vitest";
import { executeServiceActionPlan, planRestartServiceAction } from "./serviceActionPlan.js";

describe("component-scoped native-service restart planning", () => {
  it("restarts installed UI services without touching the session daemon", () => {
    const plan = planRestartServiceAction(["sessiond", "web", "uiDev"], "ui");
    const restart = vi.fn();

    executeServiceActionPlan(plan, { restart });

    expect(plan.serviceIds).toEqual(["web", "uiDev"]);
    expect(restart.mock.calls).toEqual([["web"], ["uiDev"]]);
    expect(restart).not.toHaveBeenCalledWith("sessiond");
    expect(plan.warnings.join("\n")).toContain("session daemon was not restarted");
    expect(plan.warnings.join("\n")).toContain("--component sessiond");
  });

  it("offers an explicit session-daemon-only restart path", () => {
    const plan = planRestartServiceAction(["sessiond", "uiDev"], "sessiond");
    const restart = vi.fn();

    executeServiceActionPlan(plan, { restart });

    expect(restart.mock.calls).toEqual([["sessiond"]]);
    expect(plan.warnings.join("\n")).toContain("in-flight turns, asks, and terminals may be aborted");
  });
});
