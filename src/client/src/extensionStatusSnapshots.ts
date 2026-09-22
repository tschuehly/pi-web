export const WORKING_MODE_STATUS_KEY = "working-mode";
export const ACTIVITY_STATUS_KEY = "pi-workbench:activity";
export const GOAL_STATUS_KEY = "goal";
const GOAL_STATUS_RAW_MAX_BYTES = 8_192;
const GOAL_TEXT_MAX_CHARACTERS = 240;
const CONTROL = /\p{Cc}/gu;
const INVISIBLE_SPOOF = /(?:(?!\u200d)\p{Cf})|[\u115f\u2800\u3164\uffa0]/u;
const INVISIBLE_SPOOF_GLOBAL = /(?:(?!\u200d)\p{Cf})|[\u115f\u2800\u3164\uffa0]/gu;

export const GOAL_STATUS_STATE_VALUES = ["active", "waiting", "paused", "blocked", "usage_limited", "budget_limited"] as const;
export type GoalStatusState = typeof GOAL_STATUS_STATE_VALUES[number];
export interface GoalStatusSnapshot {
  schemaVersion: 1;
  goalId: string;
  state: GoalStatusState;
  objective: string;
}

export const ALIGNMENT_VALUES = ["Vibe", "Align", "Plan", "Spec"] as const;
export const CHECKING_VALUES = ["unset", "light", "tests", "adversarial"] as const;
export type Alignment = typeof ALIGNMENT_VALUES[number];
export type Checking = typeof CHECKING_VALUES[number];
export interface WorkingModeState { alignment: Alignment; checking: Checking }
export interface WorkingModeSnapshot {
  schemaVersion: 1;
  phase: "selected" | "applied";
  selected: WorkingModeState;
  applied: WorkingModeState | null;
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
  if (INVISIBLE_SPOOF.test(rawGoalId)) return undefined;
  const goalId = rawGoalId.trim();
  const objective = normalizeGoalText(rawObjective);
  if (goalId === "" || goalId.search(CONTROL) >= 0 || Array.from(goalId).length > 128 || objective === "" || Array.from(objective).length > GOAL_TEXT_MAX_CHARACTERS) return undefined;
  return { schemaVersion: 1, goalId, state: value["state"], objective };
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

function isAlignment(value: unknown): value is Alignment {
  return typeof value === "string" && ALIGNMENT_VALUES.some((candidate) => candidate === value);
}

function isChecking(value: unknown): value is Checking {
  return typeof value === "string" && CHECKING_VALUES.some((candidate) => candidate === value);
}

function workingModeState(value: unknown): WorkingModeState | undefined {
  if (!record(value) || !isAlignment(value["alignment"]) || !isChecking(value["checking"])) return undefined;
  return { alignment: value["alignment"], checking: value["checking"] };
}

export function parseWorkingModeSnapshot(text: string | undefined): WorkingModeSnapshot | undefined {
  const value = parseJson(text);
  if (!record(value) || value["schemaVersion"] !== 1 || (value["phase"] !== "selected" && value["phase"] !== "applied")) return undefined;
  const selected = workingModeState(value["selected"]);
  const applied = value["applied"] === null ? null : workingModeState(value["applied"]);
  if (selected === undefined || applied === undefined) return undefined;
  return { schemaVersion: 1, phase: value["phase"], selected, applied };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseDelegateActivitySnapshot(text: string | undefined): DelegateActivityItem[] {
  const value = parseJson(text);
  if (!record(value) || value["schemaVersion"] !== 1 || !Array.isArray(value["items"]) || value["items"].length > 64) return [];
  const items: DelegateActivityItem[] = [];
  for (const candidate of value["items"]) {
    if (!record(candidate) || typeof candidate["id"] !== "string" || (candidate["kind"] !== "subagent" && candidate["kind"] !== "worker")) return [];
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
