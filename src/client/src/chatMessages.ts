import { ASK_USER_ANSWERS_CUSTOM_TYPE } from "../../shared/apiTypes";
import { parseAskUserOutcome } from "./api/parsers";
import { isSessionMediaId } from "../../shared/sessionMedia";
import type { ChatLine, ChatPart, GoalLifecycleDetails, ToolExecutionPart, ToolPreview, WorkingModeDial } from "./components/shared";
import { validGoalId, WORKING_MODE_AXES as WORKING_MODE_VALUES, WORKING_MODE_AXIS_NAMES, workingModeState, type WorkingModeState } from "./extensionStatusSnapshots";

export function normalizeMessages(messages: unknown[]): ChatLine[] {
  return coalesceToolExecutions(messages.flatMap(normalizeMessage)).filter((message) => message.parts.length > 0);
}

export function textMessage(role: ChatLine["role"], text: string): ChatLine {
  return { role, parts: [{ type: "text", text }] };
}

export function withMessageMeta(line: ChatLine, rawMessage: unknown): ChatLine {
  const meta = normalizeMeta(rawMessage);
  const entryId = getString(rawMessage, "entryId");
  if (meta === undefined && (entryId === undefined || entryId === "")) return line;
  return {
    ...line,
    ...(meta === undefined ? {} : { meta }),
    ...(entryId === undefined || entryId === "" ? {} : { entryId }),
  };
}

export function appendText(messages: ChatLine[], role: ChatLine["role"], text: string): ChatLine[] {
  if (text === "") return messages;
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role === role && !last.parts.some((part) => part.type === "skillRead") && lastPart?.type === "text") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), { type: "text", text: lastPart.text + text }] },
    ];
  }
  if (last?.role === role && !last.parts.some((part) => part.type === "skillRead")) return [...messages.slice(0, -1), { ...last, parts: [...last.parts, { type: "text", text }] }];
  return [...messages, textMessage(role, text)];
}

export function appendThinking(messages: ChatLine[], text: string): ChatLine[] {
  if (text === "") return messages;
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role === "assistant" && !last.parts.some((part) => part.type === "skillRead") && lastPart?.type === "thinking") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), { type: "thinking", text: lastPart.text + text }] },
    ];
  }
  if (last?.role === "assistant" && !last.parts.some((part) => part.type === "skillRead")) return [...messages.slice(0, -1), { ...last, parts: [...last.parts, { type: "thinking", text }] }];
  return [...messages, { role: "assistant", parts: [{ type: "thinking", text }] }];
}

export function normalizeMessage(message: unknown): ChatLine[] {
  if (isChatLine(message)) {
    if (!message.parts.some((part) => getString(part, "type") === "image")) return [message];
    return [{ ...message, parts: message.parts.flatMap((part) => getString(part, "type") === "image" ? normalizeImage(part) : [part]) }];
  }
  const lifecycle = goalLifecycleDetails(message);
  if (lifecycle !== undefined) return [withMessageMeta({ role: "system", parts: [{ type: "goalLifecycle", details: lifecycle }] }, message)];
  const dials = workingModeDials(message);
  if (dials !== undefined) return [withMessageMeta({ role: "system", parts: [{ type: "workingMode", dials }] }, message)];
  const completion = subagentCompletionText(message);
  if (completion !== undefined) return [withMessageMeta({ role: "system", parts: [{ type: "subagentCompletion", text: completion }] }, message)];
  const backgroundBash = backgroundBashPart(message);
  if (backgroundBash !== undefined) return [withMessageMeta({ role: "system", parts: [backgroundBash] }, message)];
  if (getString(message, "role") === "bashExecution") return [withMessageMeta(normalizeBashExecution(message), message)];
  const rawRole = getString(message, "role");
  const role = normalizeRole(rawRole);
  const contentParts = normalizeContent(getProperty(message, "content"), message);
  const supersededRecord = rawRole === "toolResult"
    ? askUserRecordFromToolDetails(getString(message, "toolName") ?? "", getProperty(message, "details"))
    : undefined;
  const parts = supersededRecord === undefined ? contentParts : [...contentParts, supersededRecord];
  const skillLines = role === "user" ? normalizeSkillInvocation(parts) : undefined;
  if (skillLines !== undefined) return skillLines.map((line) => withMessageMeta(line, message));
  const source = normalizeSource(message);
  if (role === "tool") return [withMessageMeta({ role, parts, ...(source === undefined ? {} : { source }) }, message)];

  const visible = parts.filter((part) => part.type !== "empty");
  const displayRole = role === "assistant" && visible.length > 0 && visible.every((part) => part.type === "skillRead") ? "skill" : role;
  const lines = visible.length > 0 ? [withMessageMeta({ role: displayRole, parts: visible, ...(source === undefined ? {} : { source }) }, message)] : [];
  const errorLine = assistantErrorLine(message);
  return errorLine === undefined ? lines : [...lines, withMessageMeta(errorLine, message)];
}

function subagentCompletionText(message: unknown): string | undefined {
  const details = getProperty(message, "details");
  if (getString(message, "role") !== "custom" || getString(message, "customType") !== "pi-workbench:child-completion"
    || !isRecord(details) || Array.isArray(details) || Object.keys(details).length !== 1
    || details["attention"] !== "terminal-results") return undefined;
  const content = getString(message, "content");
  return content === "" ? undefined : content;
}

function backgroundBashPart(message: unknown): Extract<ChatPart, { type: "backgroundBash" }> | undefined {
  if (getString(message, "role") !== "custom" || getString(message, "customType") !== "background-bash") return undefined;
  const details = getProperty(message, "details");
  const id = getString(details, "id");
  const command = getString(details, "command");
  const state = getString(details, "state");
  const elapsedSeconds = getNumber(details, "elapsedSeconds");
  const logPath = getString(details, "logPath");
  const exitCode = getProperty(details, "exitCode");
  const content = getString(message, "content");
  if (id === undefined || id === "" || command === undefined || command === "" || logPath === undefined || logPath === ""
    || elapsedSeconds === undefined || !Number.isInteger(elapsedSeconds) || elapsedSeconds < 0
    || (state !== "complete" && state !== "failed" && state !== "cancelled")
    || (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) || content === undefined) return undefined;
  // Durable jobs write `Full output:`; older persisted completions carry the session-shutdown wording.
  const marker = [`\nFull output: ${logPath}\n`, `\nFull output (available until session shutdown): ${logPath}\n`].find((text) => content.includes(text));
  if (marker === undefined) return undefined;
  const output = content.slice(content.indexOf(marker) + marker.length).replace(/^\[showing recent output only\]\n/, "");
  return { type: "backgroundBash", details: { id, command, state, elapsedSeconds, logPath, ...(typeof exitCode === "number" ? { exitCode } : {}) }, output };
}

function assistantErrorLine(message: unknown): ChatLine | undefined {
  if (getString(message, "role") !== "assistant" || getString(message, "stopReason") !== "error") return undefined;
  const errorMessage = getString(message, "errorMessage")?.trim();
  const detail = errorMessage === undefined || errorMessage === "" ? "The model returned an error." : errorMessage;
  return { ...textMessage("system", `Model response failed: ${detail}`), severity: "error" };
}

function isChatLine(message: unknown): message is ChatLine {
  const role = getString(message, "role");
  return (role === "user" || role === "assistant" || role === "tool" || role === "system" || role === "bash" || role === "skill")
    && Array.isArray(getProperty(message, "parts"));
}

function normalizeSkillInvocation(parts: ChatPart[]): ChatLine[] | undefined {
  if (parts.length !== 1 || parts[0]?.type !== "text") return undefined;
  const text = parts[0].text;
  const skill = parseSkillBlock(text);
  if (skill !== undefined) return [
    { role: "user", parts: [{ type: "skillInvocation", name: skill.name, location: skill.location, content: skill.content }] },
    ...(skill.userMessage === undefined ? [] : [{ role: "user" as const, parts: [{ type: "text" as const, text: skill.userMessage }] }]),
  ];
  const segments: ChatPart[] = [];
  const pattern = /<skill name="([^"\r\n]+)" location="([^"\r\n]+)">\n([\s\S]*?)\n<\/skill>/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) segments.push({ type: "text", text: text.slice(cursor, match.index) });
    segments.push({ type: "skillInvocation", name: match[1] ?? "skill", location: match[2] ?? "", content: match[3] ?? "" });
    cursor = match.index + match[0].length;
  }
  if (segments.length === 0) return undefined;
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return [{ role: "user", parts: segments }];
}

function parseSkillBlock(text: string): { name: string; location: string; content: string; userMessage?: string } | undefined {
  const match = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
  if (match === null) return undefined;
  const userMessage = match[4]?.trim();
  return {
    name: match[1] ?? "skill",
    location: match[2] ?? "",
    content: match[3] ?? "",
    ...(userMessage === undefined || userMessage === "" ? {} : { userMessage }),
  };
}

function normalizeSource(message: unknown): ChatLine["source"] | undefined {
  const source = getString(message, "source");
  if (source === "compaction" || source === "branch_summary") return source;
  return undefined;
}

function normalizeMeta(message: unknown): ChatLine["meta"] | undefined {
  const timestamp = normalizeTimestamp(getProperty(message, "timestamp"));
  const model = normalizeModel(message);
  const thinkingLevel = getString(message, "thinkingLevel");
  if (timestamp === undefined && model === undefined && (thinkingLevel === undefined || thinkingLevel === "")) return undefined;
  return {
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined || thinkingLevel === "" ? {} : { thinkingLevel }),
  };
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== "string" || value === "") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function normalizeModel(message: unknown): NonNullable<ChatLine["meta"]>["model"] | undefined {
  if (getString(message, "role") !== "assistant") return undefined;
  const provider = getString(message, "provider");
  const id = getString(message, "model");
  const responseId = getString(message, "responseModel");
  if ((provider === undefined || provider === "") && (id === undefined || id === "") && (responseId === undefined || responseId === "")) return undefined;
  return {
    ...(provider === undefined || provider === "" ? {} : { provider }),
    ...(id === undefined || id === "" ? {} : { id }),
    ...(responseId === undefined || responseId === "" ? {} : { responseId }),
  };
}

function normalizeBashExecution(message: unknown): ChatLine {
  const command = getString(message, "command") ?? "";
  const lines = getBoolean(message, "excludeFromContext") === true ? ["excluded from context", "", `$ ${command}`] : [`$ ${command}`];
  const output = getProperty(message, "output");
  if (output != null) lines.push("", stringifyPrimitive(output));
  const exitCode = getProperty(message, "exitCode");
  if (exitCode != null) lines.push("", `exit ${stringifyPrimitive(exitCode)}`);
  if (getBoolean(message, "cancelled") === true) lines.push("", "cancelled");
  if (getBoolean(message, "truncated") === true) lines.push("", "output truncated");
  const fullOutputPath = getString(message, "fullOutputPath");
  if (fullOutputPath !== undefined && fullOutputPath !== "") lines.push("", `full output: ${fullOutputPath}`);
  return { role: "bash", parts: [{ type: "text", text: lines.join("\n") }] };
}

function normalizeRole(role: unknown): ChatLine["role"] {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "toolResult") return "tool";
  return "system";
}

function normalizeContent(content: unknown, message: unknown): ChatPart[] {
  const askUserRecord = askUserRecordPart(message);
  if (askUserRecord !== undefined) return [askUserRecord];
  if (typeof content === "string") {
    const displayText = getString(message, "displayText");
    return content !== "" ? [{ type: "text", text: content, ...(displayText === undefined ? {} : { displayText }) }] : [];
  }
  if (!Array.isArray(content)) return objectFallback(content);

  return content.flatMap((part): ChatPart[] => {
    const type = getString(part, "type");
    const text = getString(part, "text");
    const displayText = getString(part, "displayText");
    const display = displayText === undefined ? {} : { displayText };
    if (type === "text") return text !== undefined && text !== "" ? [{ type: "text", text, ...display }] : [];
    if (type === "thinking") {
      const thinking = getString(part, "thinking") ?? text;
      return thinking !== undefined && thinking !== "" ? [{ type: "thinking", text: thinking, ...display }] : [];
    }
    if (type === "toolCall") {
      const toolName = getString(part, "name") ?? "tool";
      const args = getProperty(part, "arguments");
      const toolCallId = getString(part, "id");
      const skillRead = toolName === "read" ? parseSkillReadPath(getString(args, "path")) : undefined;
      if (skillRead !== undefined) return [{ type: "skillRead", ...skillRead, ...(toolCallId === undefined ? {} : { toolCallId }) }];
      return [{ type: "toolCall", ...(toolCallId === undefined ? {} : { toolCallId }), toolName, summary: summarizeArgs(args), ...(args === undefined ? {} : { args }) }];
    }
    if (type === "image") return normalizeImage(part);
    return objectFallback(part);
  }).map((part) => part.type === "text" && getString(message, "role") === "toolResult"
    ? toolResultPartFromText(part.text, message)
    : part);
}

const WORKING_MODE_AXES = [["alignment", "Alignment"], ["attention", "Attention"], ["checking", "Checking"], ["orchestration", "Orchestration"]] as const;

/** Pi Workbench Working Mode block: values from details, per-dial guidance from the model-facing text. */
function workingModeDials(message: unknown): WorkingModeDial[] | undefined {
  if (getString(message, "role") !== "custom" || getString(message, "customType") !== "working-mode") return undefined;
  const selection = getProperty(getProperty(message, "details"), "selection");
  if (!WORKING_MODE_AXES.every(([key]) => typeof getProperty(selection, key) === "string")) return undefined;
  const content = getProperty(message, "content");
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => getString(part, "text") ?? "").join("\n") : "";
  return WORKING_MODE_AXES.map(([key, label]) => {
    const value = getString(selection, key) ?? "";
    const guidance = text.split("\n").find((line) => line.startsWith(`${label} — ${value}: `))?.slice(`${label} — ${value}: `.length).trim();
    return guidance !== undefined && guidance !== "" ? { label, value, guidance } : { label, value };
  });
}

/** Dials of the latest Working Mode block among `lines[0..end)`. */
export function latestWorkingModeDials(lines: readonly ChatLine[], end = lines.length): WorkingModeDial[] | undefined {
  for (let index = Math.min(end, lines.length) - 1; index >= 0; index--) {
    const part = lines[index]?.parts.find((candidate) => candidate.type === "workingMode");
    if (part !== undefined) return part.dials;
  }
  return undefined;
}

export function latestWorkingModeSelection(lines: readonly ChatLine[]): WorkingModeState | undefined {
  const dials = latestWorkingModeDials(lines);
  return dials === undefined ? undefined : workingModeState(Object.fromEntries(WORKING_MODE_AXIS_NAMES.map((axis, index) => [axis, dials[index]?.value])));
}

/** One line for a Working Mode block: what changed since the previous block, else its non-default values. */
export function workingModeSummary(dials: readonly WorkingModeDial[], previous: readonly WorkingModeDial[] | undefined): string {
  const isDefault = (dial: WorkingModeDial, index: number) => dial.value === WORKING_MODE_VALUES[WORKING_MODE_AXIS_NAMES[index] ?? "alignment"][0];
  if (dials.every(isDefault)) return "Working Mode reset to defaults";
  const changes = dials.flatMap((dial, index) => {
    const before = previous?.[index]?.value;
    return before === undefined || before === dial.value ? [] : [`${dial.label} ${before} → ${dial.value}`];
  });
  const items = changes.length > 0 ? changes : dials.filter((dial, index) => !isDefault(dial, index)).map((dial) => `${dial.label} ${dial.value}`);
  return `Working Mode: ${items.join(" · ")}`;
}

const GOAL_LIFECYCLE_STATES = {
  start: "active", resume: "active", pause: "paused", wait: "waiting", block: "blocked",
  usage_limit: "usage_limited", budget_limit: "budget_limited", complete: "complete", clear: "cleared",
} as const;

function goalLifecycleDetails(message: unknown): GoalLifecycleDetails | undefined {
  if (getString(message, "role") !== "custom" || getString(message, "customType") !== "pi-goal.lifecycle") return undefined;
  const details = getProperty(message, "details");
  if (!isRecord(details) || Array.isArray(details)) return undefined;
  const keys = Object.keys(details);
  if (!["schemaVersion", "goalId", "transition", "state"].every((key) => Object.hasOwn(details, key))
    || keys.some((key) => !["schemaVersion", "goalId", "transition", "state", "reason", "summary"].includes(key))
    || details["schemaVersion"] !== 1 || !validGoalId(details["goalId"])) return undefined;
  const transition = details["transition"];
  if (!isGoalLifecycleTransition(transition) || details["state"] !== GOAL_LIFECYCLE_STATES[transition]) return undefined;
  const reason = Object.hasOwn(details, "reason") ? details["reason"] : undefined;
  const summary = Object.hasOwn(details, "summary") ? details["summary"] : undefined;
  if ((Object.hasOwn(details, "reason") && !validLifecycleText(reason))
    || (Object.hasOwn(details, "summary") && !validLifecycleText(summary))) return undefined;
  try {
    if (new TextEncoder().encode(JSON.stringify(details)).byteLength > 3_500) return undefined;
  } catch { return undefined; }
  return { schemaVersion: 1, goalId: details["goalId"], transition, state: GOAL_LIFECYCLE_STATES[transition],
    ...(typeof reason === "string" ? { reason } : {}), ...(typeof summary === "string" ? { summary } : {}) };
}

function isGoalLifecycleTransition(value: unknown): value is keyof typeof GOAL_LIFECYCLE_STATES {
  return typeof value === "string" && Object.hasOwn(GOAL_LIFECYCLE_STATES, value);
}

function validLifecycleText(value: unknown): value is string {
  return typeof value === "string" && value !== "" && Array.from(value).length <= 400
    && value === value.replace(/(?:(?!\u200d)\p{Cf})|[\u115f\u2800\u3164\uffa0]/gu, "").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
}

function normalizeImage(part: unknown): ChatPart[] {
  const mimeType = getString(part, "mimeType");
  const mediaId = getProperty(part, "mediaId");
  if (mediaId !== undefined) {
    const byteSize = getNumber(part, "byteSize");
    if (isSessionMediaId(mediaId)
      && mimeType !== undefined && /^image\/[a-z0-9][a-z0-9.+-]*$/iu.test(mimeType)
      && byteSize !== undefined && Number.isSafeInteger(byteSize) && byteSize >= 0) {
      return [{ type: "image", mediaId, mimeType, byteSize }];
    }
  } else {
    const data = getString(part, "data");
    if (data !== undefined && data !== "" && mimeType !== undefined && mimeType !== "") return [{ type: "image", mimeType, data }];
  }
  return [{ type: "text", text: "[image]" }];
}

function askUserRecordPart(message: unknown): Extract<ChatPart, { type: "askUserRecord" }> | undefined {
  if (getString(message, "role") !== "custom" || getString(message, "customType") !== ASK_USER_ANSWERS_CUSTOM_TYPE) return undefined;
  return parsedAskUserRecord(getProperty(message, "details"));
}

/** Project the superseded ask carried by an `ask_user` tool result, if any. */
export function askUserRecordFromToolDetails(toolName: string, details: unknown): Extract<ChatPart, { type: "askUserRecord" }> | undefined {
  if (toolName !== "ask_user") return undefined;
  return parsedAskUserRecord(getProperty(details, "superseded"));
}

function parsedAskUserRecord(value: unknown): Extract<ChatPart, { type: "askUserRecord" }> | undefined {
  try {
    return { type: "askUserRecord", outcome: parseAskUserOutcome(value) };
  } catch {
    // A malformed legacy/session entry must not make the whole transcript fail.
    // Fall back to its model-facing text through the ordinary normalizer.
    return undefined;
  }
}

function toolResultPartFromText(text: string, message: unknown): Extract<ChatPart, { type: "toolResult" }> {
  const toolCallId = getString(message, "toolCallId");
  const content = getProperty(message, "content");
  const details = getProperty(message, "details");
  return {
    type: "toolResult",
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName: getString(message, "toolName") ?? "tool",
    text,
    ...(content === undefined ? {} : { content }),
    ...(details === undefined ? {} : { details }),
    isError: getBoolean(message, "isError") === true,
  };
}

function parseSkillReadPath(path: string | undefined): { name: string; path: string } | undefined {
  if (path === undefined || path === "") return undefined;
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.endsWith("/SKILL.md") && normalized !== "SKILL.md") return undefined;
  const name = normalized.split("/").at(-2);
  if (name === undefined || name === "") return undefined;
  return { name, path };
}

function coalesceToolExecutions(lines: ChatLine[]): ChatLine[] {
  const result: ChatLine[] = [];
  const pendingTools = new Map<string, { lineIndex: number; partIndex: number }>();
  const skillReadIds = new Set<string>();

  for (const line of lines) {
    let passthroughParts: ChatPart[] = [];
    const metadata = {
      ...(line.entryId === undefined ? {} : { entryId: line.entryId }),
      ...(line.source === undefined ? {} : { source: line.source }),
      ...(line.severity === undefined ? {} : { severity: line.severity }),
      ...(line.meta === undefined ? {} : { meta: line.meta }),
    };
    const flushPassthrough = () => {
      if (passthroughParts.length === 0) return;
      result.push({ role: line.role, parts: passthroughParts, ...metadata });
      passthroughParts = [];
    };

    for (const part of line.parts) {
      if (part.type === "skillRead" && part.toolCallId !== undefined) skillReadIds.add(part.toolCallId);
      if (part.type === "toolCall") {
        flushPassthrough();
        const execution = toolExecutionFromCall(part);
        const lineIndex = result.length;
        result.push({ role: "tool", parts: [execution], ...metadata });
        if (execution.toolCallId !== undefined) pendingTools.set(execution.toolCallId, { lineIndex, partIndex: 0 });
        continue;
      }

      if (part.type === "toolResult") {
        if (part.toolCallId !== undefined && part.toolName === "read" && skillReadIds.has(part.toolCallId) && !part.isError
          && getString(part.details, "diff") === undefined && previewFromDetails(part.details)?.diff === undefined
          && !line.parts.some((item) => item.type === "image" || item.type === "askUserRecord")) continue;
        const target = part.toolCallId === undefined ? undefined : pendingTools.get(part.toolCallId);
        if (target !== undefined && mergeToolResultInto(result, target, part)) {
          pendingTools.delete(part.toolCallId ?? "");
          continue;
        }
      }

      passthroughParts.push(part);
    }

    flushPassthrough();
  }

  return result;
}

function toolExecutionFromCall(part: Extract<ChatPart, { type: "toolCall" }>): ToolExecutionPart {
  return {
    type: "toolExecution",
    ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }),
    toolName: part.toolName,
    summary: part.summary,
    ...(part.args === undefined ? {} : { args: part.args }),
    status: "pending",
  };
}

function mergeToolResultInto(lines: ChatLine[], target: { lineIndex: number; partIndex: number }, result: Extract<ChatPart, { type: "toolResult" }>): boolean {
  const line = lines[target.lineIndex];
  const current = line?.parts[target.partIndex];
  if (line === undefined || current?.type !== "toolExecution") return false;
  const preview = previewFromDetails(result.details) ?? current.preview;
  const next: ToolExecutionPart = {
    ...current,
    status: result.isError ? "error" : "success",
    resultText: result.text,
    ...(result.content === undefined ? {} : { content: result.content }),
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(preview === undefined ? {} : { preview }),
  };
  lines[target.lineIndex] = { ...line, parts: [...line.parts.slice(0, target.partIndex), next, ...line.parts.slice(target.partIndex + 1)] };
  return true;
}

export function previewFromDetails(details: unknown): ToolPreview | undefined {
  const preview = getProperty(details, "preview");
  if (!isRecord(preview)) return undefined;
  const diff = getString(preview, "diff");
  const error = getString(preview, "error");
  const firstChangedLine = getNumber(preview, "firstChangedLine");
  if (diff === undefined && error === undefined && firstChangedLine === undefined) return undefined;
  return {
    ...(diff === undefined ? {} : { diff }),
    ...(error === undefined ? {} : { error }),
    ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
  };
}

function objectFallback(value: unknown): ChatPart[] {
  if (value == null) return [];
  if (typeof value === "object") return [{ type: "text", text: summarizeArgs(value) }];
  return [{ type: "text", text: stringifyPrimitive(value) }];
}

export function summarizeArgs(args: unknown): string {
  if (!isRecord(args)) return stringifyPrimitive(args);
  const command = getString(args, "command");
  if (command !== undefined) return command;
  const path = getString(args, "path");
  if (path !== undefined) return path;
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") return "edit text replacement";
  const edits = args["edits"];
  if (Array.isArray(edits)) return `${String(edits.length)} edit${edits.length === 1 ? "" : "s"}`;
  const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortValue(value)}`).join(" · ");
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object" && value !== null) return "object";
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  const property = getProperty(value, key);
  return typeof property === "boolean" ? property : undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  const property = getProperty(value, key);
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function stringifyPrimitive(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}
