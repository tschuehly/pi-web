import type { SessionStatus } from "./apiTypes.js";

/** The parts of a Chat's status that say whether closing it would end running work. */
export type CloseBusyStatus = Pick<
  SessionStatus,
  "isStreaming" | "isCompacting" | "isBashRunning" | "pendingMessageCount" | "pendingAsks" | "activeToolExecutions" | "extensionStatuses"
>;

/**
 * Why a family is not quiet, from its host's status; undefined when nothing runs or waits. The legacy idle-unload rule
 * (`isIdleForUnload`, `hasExtensionBackgroundWork`): a running turn, queued input, an open question, a running tool,
 * children, background bash or a watcher. Atelier Pages do not count: they end with the host, and reopening the Chat
 * serves them again. An unparseable status line counts as busy.
 */
export function familyBusy(status: CloseBusyStatus): string | undefined {
  if (status.isStreaming || status.isCompacting || status.isBashRunning) return "a turn is running";
  if (status.pendingMessageCount > 0) return "input is queued";
  if ((status.pendingAsks?.length ?? 0) > 0) return "a question is open";
  if ((status.activeToolExecutions?.length ?? 0) > 0) return "a tool is running";
  const list = (key: string, field: string) => statusList(status, key, field);
  if (childrenRunning(status)) return "children are running";
  if (list("pi-workbench:background-bash", "jobs")?.length !== 0) return "background bash is running";
  if (list("pi-process-monitor:watchers", "watchers")?.length !== 0) return "a watcher is running";
  return undefined;
}

/**
 * The warning before closing a busy family, shared by the browser's check and the server's refusal: its background bash
 * jobs and running Subagents and Workers counted ("2 background bash jobs and 1 subagent are running; closing ends
 * them."), else why it is not quiet ("A turn is running; closing ends it.").
 */
export function runningWork(status: CloseBusyStatus): string | undefined {
  const reason = familyBusy(status);
  if (reason === undefined) return undefined;
  const jobs = statusList(status, "pi-workbench:background-bash", "jobs")?.length ?? 0;
  const children = (statusList(status, "pi-workbench:activity", "items") ?? []).filter((item) => isRecord(item) && item["endedAt"] === undefined);
  const subagents = children.filter((item) => isRecord(item) && item["kind"] === "subagent").length;
  const counted = (count: number, noun: string) => (count === 0 ? [] : [`${String(count)} ${noun}${count === 1 ? "" : "s"}`]);
  const parts = [...counted(jobs, "background bash job"), ...counted(subagents, "subagent"), ...counted(children.length - subagents, "worker")];
  if (parts.length === 0) return `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}; closing ends it.`;
  const one = jobs + children.length === 1;
  return `${parts.length === 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`} ${one ? "is" : "are"} running; closing ends ${one ? "it" : "them"}.`;
}

/** A delegate roster row not yet ended (Subagents, Workers); an unparseable roster counts as running. */
export function childrenRunning(status: CloseBusyStatus): boolean {
  const delegates = statusList(status, "pi-workbench:activity", "items");
  return delegates === undefined || delegates.some((item) => !isRecord(item) || item["endedAt"] === undefined);
}

/** A JSON list in one of the host's extension status lines: none when the line is absent, undefined when unparseable. */
function statusList(status: CloseBusyStatus, key: string, field: string): unknown[] | undefined {
  const text = status.extensionStatuses?.[key];
  if (text === undefined) return [];
  try {
    const value: unknown = JSON.parse(text);
    const items = isRecord(value) ? value[field] : undefined;
    return Array.isArray(items) ? items : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
