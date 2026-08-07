import type { NativeServiceId } from "./servicePlan.js";

export type RestartComponent = "ui" | "sessiond";

export interface ServiceActionPlan {
  action: "restart";
  serviceIds: readonly NativeServiceId[];
  warnings: readonly string[];
}

export function planRestartServiceAction(
  installedServiceIds: readonly NativeServiceId[],
  component?: RestartComponent,
): ServiceActionPlan {
  const installed = new Set(installedServiceIds);
  const selected = component === "ui"
    ? (["web", "uiDev"] as const)
    : component === "sessiond"
      ? (["sessiond"] as const)
      : (["web", "uiDev", "sessiond"] as const);
  const serviceIds = selected.filter((id) => installed.has(id));
  return {
    action: "restart",
    serviceIds,
    warnings: component === "ui"
      ? ["The session daemon was not restarted. Restart it separately with `pi-web restart --component sessiond` when session runtime code changes."]
      : component === "sessiond"
        ? ["Restarting the session daemon interrupts its runtime ownership; in-flight turns, asks, and terminals may be aborted."]
        : [],
  };
}

export function executeServiceActionPlan(
  plan: ServiceActionPlan,
  executor: { restart(serviceId: NativeServiceId): void },
): void {
  for (const serviceId of plan.serviceIds) executor.restart(serviceId);
}
