const DEFAULT_LIMIT = 100;
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

/** The limit is hard: a page never starts on a tool result orphaned from its call; those results go to the earlier page. */
export function shrinkStartPastToolResults(messages: unknown[], requestedStart: number, before: number): number {
  let start = requestedStart;
  while (start < before && getString(messages[start], "role") === "toolResult") start += 1;
  return start < before ? start : requestedStart;
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
