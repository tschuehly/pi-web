import { previewFromDetails } from "./chatMessages";
import type { ChatLine, ChatPart } from "./chatTypes";

/**
 * How a technical group renders: `thinking` stays open and folds routine tool calls,
 * `activity` collapses routine tool calls, `history` collapses compaction summaries;
 * no presentation means visible events (failures, material writes).
 */
export type ChatGroupPresentation = "activity" | "thinking" | "history";

export type ChatGroup =
  | { kind: "message"; message: ChatLine; index: number }
  | { kind: "tool-image"; message: ChatLine; index: number; toolName?: string }
  // Members keep their source indexes even when invisible entries are skipped.
  | { kind: "group"; messages: { message: ChatLine; index: number }[]; startIndex: number; endIndex: number; presentation?: ChatGroupPresentation };

export type ChatToolImageOutput = Extract<ChatGroup, { kind: "tool-image" }>;
export type ChatDisplayGroup = Exclude<ChatGroup, ChatToolImageOutput>
  | { kind: "tool-images"; outputs: [ChatToolImageOutput, ...ChatToolImageOutput[]] };

export interface CurrentExchangeGroups<T extends ChatGroup | ChatDisplayGroup> {
  history: T[];
  current: T[];
  startsAt: number | undefined;
  startsOutsideLoadedPage: boolean;
}

/** Split the transcript at the latest user message, so earlier conversation can fold away. */
export function currentExchangeGroups<T extends ChatGroup | ChatDisplayGroup>(messages: readonly ChatLine[], groups: T[], messageStart: number, hasMore: boolean): CurrentExchangeGroups<T> {
  let localStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.source !== "compaction" && message.source !== "branch_summary") {
      localStart = index;
      break;
    }
  }
  if (localStart < 0) return { history: [], current: groups, startsAt: undefined, startsOutsideLoadedPage: hasMore && messageStart > 0 };
  const startsAt = messageStart + localStart;
  const split = groups.findIndex((group) => chatDisplayGroupEndIndex(group) >= startsAt);
  if (split <= 0) return { history: [], current: groups, startsAt, startsOutsideLoadedPage: false };
  return { history: groups.slice(0, split), current: groups.slice(split), startsAt, startsOutsideLoadedPage: false };
}

function chatDisplayGroupEndIndex(group: ChatGroup | ChatDisplayGroup): number {
  if (group.kind === "group") return group.endIndex;
  if (group.kind === "tool-images") return group.outputs.at(-1)?.index ?? group.outputs[0].index;
  return group.index;
}

/** Combine only adjoining image outputs; conversation and activity remain boundaries. */
export function groupConsecutiveImageOutputs(groups: readonly ChatGroup[]): ChatDisplayGroup[] {
  const result: ChatDisplayGroup[] = [];
  for (const group of groups) {
    if (group.kind !== "tool-image") { result.push(group); continue; }
    const previous = result.at(-1);
    if (previous?.kind === "tool-images") previous.outputs.push(group);
    else result.push({ kind: "tool-images", outputs: [group] });
  }
  return result;
}

export function groupChatMessages(messages: ChatLine[], indexOffset = 0): ChatGroup[] {
  const groups: ChatGroup[] = [];

  const pushGroup = (message: ChatLine, index: number, presentation?: ChatGroupPresentation) => {
    const previous = groups.at(-1);
    // Fold routine activity as it arrives: a later thinking/skill line must not reparent its live DOM node.
    if (previous?.kind === "group" && previous.presentation === "thinking" && (presentation === "activity" || message.parts.every((part) => part.type === "skillRead"))) {
      previous.messages.push({ message, index });
      previous.endIndex = index;
      return;
    }
    if (previous?.kind === "group" && previous.presentation === presentation) {
      previous.messages.push({ message, index });
      previous.endIndex = index;
      return;
    }
    groups.push({ kind: "group", messages: [{ message, index }], startIndex: index, endIndex: index, ...(presentation === undefined ? {} : { presentation }) });
  };

  messages.forEach((message, localIndex) => {
    const index = indexOffset + localIndex;
    const metadata = { ...(message.streamId === undefined ? {} : { streamId: message.streamId }), ...(message.entryId === undefined ? {} : { entryId: message.entryId }), ...(message.source === undefined ? {} : { source: message.source }), ...(message.severity === undefined ? {} : { severity: message.severity }), ...(message.meta === undefined ? {} : { meta: message.meta }) };
    let run: ChatPart[] = [];
    let runKind: ChatGroupPresentation | "event" | "readable" | undefined;

    const flush = () => {
      if (runKind === undefined || run.length === 0) return;
      const parts = run;
      const kind = runKind;
      run = [];
      runKind = undefined;
      const role = parts.every((part) => part.type === "skillRead") ? "skill" : message.role;
      const splitMessage: ChatLine = { role, parts, ...metadata };
      if (kind === "thinking" || kind === "activity" || kind === "history") pushGroup(splitMessage, index, kind);
      else if (kind === "event") pushGroup(splitMessage, index);
      else if (splitMessage.role === "skill" && skillContinuesThinking(groups)) pushGroup(splitMessage, index);
      else if (isToolImageMessage(splitMessage)) {
        const toolName = toolNameFromParts(message.parts);
        groups.push({ kind: "tool-image", message: splitMessage, index, ...(toolName === undefined ? {} : { toolName }) });
      } else groups.push({ kind: "message", message: splitMessage, index });
    };

    for (const part of message.parts) {
      // Ordering markers affect the conversation tail, not visual grouping.
      if (part.type === "toolResultBoundary" || part.type === "empty") continue;
      // A Markdown transformer hid this reasoning; keep it out of the thinking group.
      if (part.type === "thinking" && part.displayText === "") continue;
      const kind = chatPartKind(message, part);
      if (kind !== runKind) flush();
      runKind = kind;
      run.push(part);
    }
    flush();
  });
  return groups;
}

function skillContinuesThinking(groups: ChatGroup[]): boolean {
  const previous = groups.at(-1);
  return previous?.kind === "group" && previous.presentation === "thinking";
}

const headerlessPartTypes: ReadonlySet<ChatPart["type"]> = new Set(["askUserRecord", "goalLifecycle", "subagentCompletion", "backgroundBash", "workingMode"]);

/** Whether this slice renders a message header rather than a headerless shell. */
export function chatMessageHasHeader(message: ChatLine): boolean {
  return !(message.parts.length > 0 && (
    (message.role === "tool" && message.parts.every((part) => part.type === "toolExecution"))
    || message.parts.every((part) => headerlessPartTypes.has(part.type))
  ));
}

/** Select rendered slice identities, independent of disclosure and plugin policy. */
export function canonicalEntryActionHeaders(groups: readonly ChatGroup[]): ReadonlySet<ChatLine> {
  const entries = new Map<string, { message: ChatLine; priority: number }>();
  for (const group of groups) {
    for (const message of group.kind === "group" ? group.messages.map((event) => event.message) : [group.message]) {
      if (message.entryId === undefined || !chatMessageHasHeader(message)) continue;
      // A normal reply wins over attached events. Conversation headers also
      // outrank skill-only slices, so thinking retains history when no reply exists.
      const conversation = message.role === "user" || message.role === "assistant";
      const reply = group.kind !== "group" && message.parts.some((part) => part.type === "text" || part.type === "image");
      const priority = conversation ? (reply ? 3 : 2) : (group.kind !== "group" ? 1 : 0);
      const previous = entries.get(message.entryId);
      if (previous === undefined || priority > previous.priority) entries.set(message.entryId, { message, priority });
    }
  }
  return new Set(Array.from(entries.values(), ({ message }) => message));
}

export function summarizeChatGroup(messages: ChatLine[]): string {
  if (messages.every((message) => message.source === "compaction")) return `${String(messages.length)} history compaction ${messages.length === 1 ? "summary" : "summaries"}`;
  if (messages.every((message) => message.source === "branch_summary")) return `${String(messages.length)} branch ${messages.length === 1 ? "summary" : "summaries"}`;
  if (messages.every((message) => message.source === "compaction" || message.source === "branch_summary")) return `${String(messages.length)} history summaries`;
  const counts = messages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] ?? 0) + 1;
    return acc;
  }, {});
  const details = Object.entries(counts).map(([role, count]) => `${String(count)} ${role}`).join(" · ");
  return `${String(messages.length)} ${messages.length === 1 ? "event" : "events"}${details !== "" ? ` · ${details}` : ""}`;
}

function isToolImageMessage(message: ChatLine): boolean {
  return message.role === "tool" && message.parts.length > 0 && message.parts.every((part) => part.type === "image");
}

function toolNameFromParts(parts: ChatPart[]): string | undefined {
  for (const part of parts) {
    if ((part.type === "toolCall" || part.type === "toolExecution" || part.type === "toolResult") && part.toolName !== "") return part.toolName;
  }
  return undefined;
}

function chatPartKind(message: ChatLine, part: ChatPart): ChatGroupPresentation | "event" | "readable" {
  if (message.source === "compaction" || message.source === "branch_summary") return "history";
  if (part.type === "thinking") return "thinking";
  if (part.type === "toolCall" && message.severity !== "error") return "activity";
  if (part.type === "toolExecution" && part.status !== "error" && part.preview?.error === undefined && message.severity !== "error" && !isMaterialWrite(part.toolName) && !hasMaterialFileDiff(part.details, part.preview?.diff)) return "activity";
  if (part.type === "toolResult" && !part.isError && previewFromDetails(part.details)?.error === undefined && message.severity !== "error" && !isMaterialWrite(part.toolName) && !hasMaterialFileDiff(part.details, previewFromDetails(part.details)?.diff)) return "activity";
  if (part.type === "skillInvocation" || part.type === "skillRead" || part.type === "image" || part.type === "askUserRecord" || part.type === "goalLifecycle" || part.type === "subagentCompletion" || part.type === "backgroundBash") return "readable";
  if (part.type === "text" && (message.role === "user" || message.role === "assistant" || message.role === "system" || message.role === "bash")) return "readable";
  return "event";
}

function isMaterialWrite(toolName: string): boolean {
  return toolName === "write" || toolName === "create" || toolName === "overwrite";
}

function hasMaterialFileDiff(details: unknown, previewDiff?: string): boolean {
  return previewDiff !== undefined || (typeof details === "object" && details !== null && typeof Reflect.get(details, "diff") === "string");
}
