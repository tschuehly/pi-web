import { ACTIVE_TOOL_EXECUTION_LIMIT, type ActiveToolExecution } from "../../shared/apiTypes";

export const WORKING_MODE_STATUS_KEY = "working-mode";
export const ACTIVITY_STATUS_KEY = "pi-workbench:activity";
export const WATCHER_STATUS_KEY = "pi-process-monitor:watchers";
export const GOAL_STATUS_KEY = "goal";
const GOAL_STATUS_RAW_MAX_BYTES = 8_192;
const GOAL_TEXT_MAX_CHARACTERS = 240;
const CONTROL = /\p{Cc}/gu;
const INVISIBLE_SPOOF_GLOBAL = /(?:(?!\u200d)\p{Cf})|[\u115f\u2800\u3164\uffa0]/gu;
const GOAL_ID_DISALLOWED = /[\p{Cc}\p{Cf}\u115f\u2800\u3164\uffa0]/u;

export const GOAL_STATUS_STATE_VALUES = ["active", "waiting", "paused", "blocked", "usage_limited", "budget_limited"] as const;
export type GoalStatusState = typeof GOAL_STATUS_STATE_VALUES[number];
export interface GoalStatusSnapshot {
  schemaVersion: 1;
  goalId: string;
  state: GoalStatusState;
  objective: string;
}

export const WORKING_MODE_AXES = {
  alignment: ["Default", "Align", "Plan", "Spec"],
  attention: ["Default", "Focused", "Switching", "Phone", "AFK"],
  checking: ["Default", "Exercise", "Test", "Challenge"],
  orchestration: ["Main", "Subagents", "Workers"],
} as const;
export type WorkingModeAxis = keyof typeof WORKING_MODE_AXES;
export const WORKING_MODE_AXIS_NAMES: readonly WorkingModeAxis[] = ["alignment", "attention", "checking", "orchestration"];
export type WorkingModeState = { [A in WorkingModeAxis]: typeof WORKING_MODE_AXES[A][number] };
export interface WorkingModeSnapshot {
  schemaVersion: 2;
  phase: "selected" | "applied";
  selected: WorkingModeState;
  applied: WorkingModeState | null;
}

export interface WatcherStatusItem {
  logicalId: string;
  handleId: string;
  label?: string;
  mode: "spawn" | "poll" | "file";
  scope: string;
  state: "watching" | "retrying" | "suspended" | "quarantined";
  consecutiveFailures: number;
}

export function parseWatcherStatusSnapshot(text: string | undefined): WatcherStatusItem[] {
  if (text === undefined || text.length > 65_536) return [];
  const value = parseJson(text);
  if (!record(value) || value["schemaVersion"] !== 1 || !Array.isArray(value["watchers"]) || value["watchers"].length > 64) return [];
  const items: WatcherStatusItem[] = [];
  const ids = new Set<string>();
  for (const entry of value["watchers"]) {
    if (!record(entry)) return [];
    const { logicalId, handleId, label, mode, scope, state, consecutiveFailures, startedAt } = entry;
    if (!safeStatusId(logicalId, 256) || !safeStatusId(handleId, 64) || ids.has(logicalId)
      || (label !== undefined && (typeof label !== "string" || Array.from(label).length > 48)) || typeof scope !== "string" || Array.from(scope).length > 240
      || (mode !== "spawn" && mode !== "poll" && mode !== "file")
      || (state !== "watching" && state !== "retrying" && state !== "suspended" && state !== "quarantined")
      || typeof consecutiveFailures !== "number" || !Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 0
      || !validStatusTime(startedAt)) return [];
    ids.add(logicalId);
    const normalizedLabel = label === undefined ? "" : normalizeGoalText(label.replace(/\u200d/gu, ""));
    items.push({ logicalId, handleId, ...(normalizedLabel === "" ? {} : { label: normalizedLabel }), mode,
      scope: normalizeGoalText(scope.replace(/\u200d/gu, "")),
      state, consecutiveFailures });
  }
  return items;
}

function safeStatusId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\s\p{Cc}\p{Cf}\u115f\u2800\u3164\uffa0]/u.test(value);
}

function validStatusTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

export function visibleShellExecutions(value: unknown): ActiveToolExecution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ACTIVE_TOOL_EXECUTION_LIMIT) return [];
  const ids = new Set<string>();
  const shells: ActiveToolExecution[] = [];
  for (const entry of value) {
    if (!record(entry)) return [];
    if (entry["kind"] !== "shell" || !((entry["toolName"] === "bash" && entry["label"] === "Shell command")
      || (entry["toolName"] === "shell" && entry["label"] === "Interactive shell"))) continue;
    if (!safeStatusId(entry["id"], 256) || ids.has(entry["id"])
      || (entry["startedAt"] !== undefined && (typeof entry["startedAt"] !== "string" || entry["startedAt"].length === 0
        || entry["startedAt"].length > 64 || !Number.isFinite(Date.parse(entry["startedAt"]))))) return [];
    ids.add(entry["id"]);
    shells.push({ id: entry["id"], kind: "shell", toolName: entry["toolName"], label: entry["label"],
      ...(entry["startedAt"] === undefined ? {} : { startedAt: entry["startedAt"] }) });
  }
  return shells;
}

export interface DelegateActivityItem {
  id: string;
  kind: "subagent" | "worker";
  name?: string;
  role?: string;
  model?: string;
  effort?: string;
  objective?: string;
  activity?: string;
  reportedStatus?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function isGoalStatusState(value: unknown): value is GoalStatusState {
  return typeof value === "string" && GOAL_STATUS_STATE_VALUES.some((candidate) => candidate === value);
}

export function parseGoalStatusSnapshot(text: string | undefined): GoalStatusSnapshot | undefined {
  if (!boundedGoalStatusText(text)) return undefined;
  const value = parseJson(text);
  if (!record(value) || !["schemaVersion", "goalId", "state", "objective"].every((key) => Object.hasOwn(value, key))) return undefined;
  const rawGoalId = value["goalId"];
  const rawObjective = value["objective"];
  if (value["schemaVersion"] !== 1 || typeof rawGoalId !== "string" || !isGoalStatusState(value["state"]) || typeof rawObjective !== "string") return undefined;
  if (!validGoalId(rawGoalId)) return undefined;
  const objective = normalizeGoalText(rawObjective);
  if (objective === "" || Array.from(objective).length > GOAL_TEXT_MAX_CHARACTERS) return undefined;
  return { schemaVersion: 1, goalId: rawGoalId, state: value["state"], objective };
}

export function validGoalId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim()
    && !GOAL_ID_DISALLOWED.test(value) && Array.from(value).length <= 128;
}

export function parseLegacyGoalStatus(text: string | undefined): string | undefined {
  if (!boundedGoalStatusText(text)) return undefined;
  const trimmed = text.trim();
  if (parseJson(trimmed) !== undefined || trimmed.startsWith("{") || trimmed.startsWith("[")) return undefined;
  const value = normalizeGoalText(trimmed);
  return value !== "" && Array.from(value).length <= GOAL_TEXT_MAX_CHARACTERS ? value : undefined;
}

function boundedGoalStatusText(text: string | undefined): text is string {
  return text !== undefined && new TextEncoder().encode(text).byteLength <= GOAL_STATUS_RAW_MAX_BYTES;
}

function normalizeGoalText(value: string): string {
  return value.replace(INVISIBLE_SPOOF_GLOBAL, "").replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
}

function workingModeState(value: unknown): WorkingModeState | undefined {
  if (!record(value)) return undefined;
  const alignment = WORKING_MODE_AXES.alignment.find((candidate) => candidate === value["alignment"]);
  const attention = WORKING_MODE_AXES.attention.find((candidate) => candidate === value["attention"]);
  const checking = WORKING_MODE_AXES.checking.find((candidate) => candidate === value["checking"]);
  const orchestration = WORKING_MODE_AXES.orchestration.find((candidate) => candidate === value["orchestration"]);
  if (alignment === undefined || attention === undefined || checking === undefined || orchestration === undefined) return undefined;
  return { alignment, attention, checking, orchestration };
}

export function parseWorkingModeSnapshot(text: string | undefined): WorkingModeSnapshot | undefined {
  const value = parseJson(text);
  if (!record(value) || value["schemaVersion"] !== 2 || (value["phase"] !== "selected" && value["phase"] !== "applied")) return undefined;
  const selected = workingModeState(value["selected"]);
  const applied = value["applied"] === null ? null : workingModeState(value["applied"]);
  if (selected === undefined || applied === undefined) return undefined;
  return { schemaVersion: 2, phase: value["phase"], selected, applied };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseDelegateActivitySnapshot(text: string | undefined): DelegateActivityItem[] {
  const value = parseJson(text);
  if (!record(value) || value["schemaVersion"] !== 1 || !Array.isArray(value["items"]) || value["items"].length > 64) return [];
  const items: DelegateActivityItem[] = [];
  const ids = new Set<string>();
  for (const candidate of value["items"]) {
    if (!record(candidate) || !safeStatusId(candidate["id"], 128) || ids.has(candidate["id"])
      || (candidate["kind"] !== "subagent" && candidate["kind"] !== "worker")) return [];
    ids.add(candidate["id"]);
    const item: DelegateActivityItem = { id: candidate["id"], kind: candidate["kind"] };
    const name = optionalText(candidate["name"]); if (name !== undefined) item.name = name;
    const role = optionalText(candidate["role"]); if (role !== undefined) item.role = role;
    const model = optionalText(candidate["model"]); if (model !== undefined) item.model = model;
    const effort = optionalText(candidate["effort"]); if (effort !== undefined) item.effort = effort;
    const objective = optionalText(candidate["objective"]); if (objective !== undefined) item.objective = objective;
    const activity = optionalText(candidate["activity"]); if (activity !== undefined) item.activity = activity;
    const reportedStatus = optionalText(candidate["reportedStatus"]); if (reportedStatus !== undefined) item.reportedStatus = reportedStatus;
    items.push(item);
  }
  return items;
}

const TERMINAL_ACTIVITY = new Set(["success", "preflight failed", "launch failed", "execution failed", "cancelled", "outcome unknown", "finished", "timed out"]);
export function isTerminalDelegate(item: DelegateActivityItem): boolean {
  return TERMINAL_ACTIVITY.has(item.activity?.toLowerCase().replaceAll("_", " ") ?? "");
}
