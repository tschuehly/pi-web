import { previewFromDetails } from "./chatMessages";
import type { ChatLine, ChatPart } from "./components/shared";

export type ChatGroupPresentation = "activity" | "thinking" | "history";

export type ChatGroup =
  | { kind: "message"; message: ChatLine; index: number }
  | { kind: "tool-image"; message: ChatLine; index: number; toolName?: string }
  | { kind: "group"; messages: ChatLine[]; startIndex: number; endIndex: number; presentation?: ChatGroupPresentation; messageIndices?: number[] };

export interface CurrentExchangeGroups {
  history: ChatGroup[];
  current: ChatGroup[];
  startsAt: number | undefined;
  startsOutsideLoadedPage: boolean;
}

export function currentExchangeGroups(messages: ChatLine[], groups: ChatGroup[], messageStart: number, hasMore: boolean): CurrentExchangeGroups {
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
  const split = groups.findIndex((group) => (group.kind === "group" ? group.endIndex : group.index) >= startsAt);
  if (split <= 0) return { history: [], current: groups, startsAt, startsOutsideLoadedPage: false };
  return { history: groups.slice(0, split), current: groups.slice(split), startsAt, startsOutsideLoadedPage: false };
}

export function groupChatMessages(messages: ChatLine[], indexOffset = 0): ChatGroup[] {
  const groups: ChatGroup[] = [];
  const groupIndices = new WeakMap<ChatGroup, number[]>();

  const pushGroup = (message: ChatLine, index: number, presentation?: ChatGroupPresentation) => {
    const previous = groups.at(-1);
    // Fold routine activity as it arrives: a later thinking/skill line must not reparent its live DOM node.
    if (previous?.kind === "group" && previous.presentation === "thinking" && (presentation === "activity" || message.parts.every((part) => part.type === "skillRead"))) {
      previous.messages.push(message);
      previous.messageIndices = [...(previous.messageIndices ?? groupIndices.get(previous) ?? []), index];
      previous.endIndex = index;
      return;
    }
    if (previous?.kind === "group" && previous.presentation === presentation) {
      previous.messages.push(message);
      if (previous.messageIndices !== undefined) previous.messageIndices.push(index);
      else groupIndices.get(previous)?.push(index);
      previous.endIndex = index;
      return;
    }
    const group: ChatGroup = { kind: "group", messages: [message], startIndex: index, endIndex: index, ...(presentation === undefined ? {} : { presentation }) };
    groups.push(group);
    groupIndices.set(group, [index]);
  };

  messages.forEach((message, localIndex) => {
    const index = indexOffset + localIndex;
    const metadata = { ...(message.entryId === undefined ? {} : { entryId: message.entryId }), ...(message.source === undefined ? {} : { source: message.source }), ...(message.severity === undefined ? {} : { severity: message.severity }), ...(message.meta === undefined ? {} : { meta: message.meta }) };
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
      if (kind === "thinking") pushGroup(splitMessage, index, "thinking");
      else if (kind === "activity") pushGroup(splitMessage, index, "activity");
      else if (kind === "history") pushGroup(splitMessage, index, "history");
      else if (kind === "event") pushGroup(splitMessage, index);
      else if (splitMessage.role === "skill" && skillContinuesThinking(groups)) pushGroup(splitMessage, index);
      else if (isToolImageMessage(splitMessage)) {
        const toolName = toolNameFromParts(message.parts);
        groups.push({ kind: "tool-image", message: splitMessage, index, ...(toolName === undefined ? {} : { toolName }) });
      } else groups.push({ kind: "message", message: splitMessage, index });
    };

    for (const part of message.parts) {
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
