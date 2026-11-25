const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

export interface MessagePageRequest {
  before?: number;
  limit?: number;
}

export interface MessagePageResult<T> {
  messages: T[];
  start: number;
  total: number;
}

export function pageMessagesAtSafeBoundary<T>(messages: T[], page?: MessagePageRequest): MessagePageResult<T> {
  const total = messages.length;
  if (page?.before === undefined && page?.limit === undefined) return { messages, start: 0, total };
  const before = clampInteger(page.before ?? total, 0, total);
  const limit = clampInteger(page.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const requestedStart = Math.max(0, before - limit);
  const start = shrinkStartPastToolResults(messages, requestedStart, before);
  return { messages: messages.slice(start, before), start, total };
}

/**
 * The limit is hard, with one exception: a page never starts on a tool result orphaned from its call. Leading results (and
 * displayed notices before them) go to the earlier page; a page of only those moves its start back to their call message,
 * across notices between the call and its results, exceeding the limit just to reach it.
 */
export function shrinkStartPastToolResults(messages: unknown[], requestedStart: number, before: number): number {
  const isResult = (index: number) => getString(messages[index], "role") === "toolResult";
  const isNotice = (index: number) => getString(messages[index], "role") === "custom";
  const orphan = (index: number) => { while (index < before && isNotice(index)) index += 1; return index < before && isResult(index); };
  let start = requestedStart;
  while (start < before && orphan(start)) start += 1;
  if (start < before) return start;
  start = requestedStart;
  while (start > 0 && (isResult(start - 1) || isNotice(start - 1))) start -= 1;
  return Math.max(0, start - 1);
}

function getProperty(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
