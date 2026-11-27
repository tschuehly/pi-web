const CACHE_PREFIX = "pi-web:chat-history:v2:";
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface RawMessagePage {
  messages: unknown[];
  start: number;
  total: number;
}

export interface CachedChatHistory extends RawMessagePage {
  savedAt: number;
}

export function readChatHistoryCache(sessionId: string): RawMessagePage | undefined {
  try {
    const raw = sessionStorage.getItem(cacheKey(sessionId));
    if (raw === null || raw === "") return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedHistory(parsed)) return undefined;
    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) {
      sessionStorage.removeItem(cacheKey(sessionId));
      return undefined;
    }
    return { messages: parsed.messages, start: parsed.start, total: parsed.total };
  } catch {
    return undefined;
  }
}

export function writeChatHistoryCache(sessionId: string, page: RawMessagePage): void {
  try {
    sessionStorage.setItem(cacheKey(sessionId), JSON.stringify({ ...page, savedAt: Date.now() }));
  } catch {
    // Ignore quota/private-mode failures; history paging still works without cache.
  }
}

export function removeChatHistoryCache(sessionId: string): void {
  try {
    sessionStorage.removeItem(cacheKey(sessionId));
  } catch {
    // Ignore storage access errors; cache may simply be unavailable.
  }
}

function cacheKey(sessionId: string): string {
  return `${CACHE_PREFIX}${sessionId}`;
}

function isCachedHistory(value: unknown): value is CachedChatHistory {
  if (typeof value !== "object" || value === null) return false;
  if (!("messages" in value) || !("start" in value) || !("total" in value) || !("savedAt" in value)) return false;
  const { messages, start, total, savedAt } = value;
  return Array.isArray(messages)
    && typeof start === "number"
    && typeof total === "number"
    && typeof savedAt === "number"
    && isValidMessagePage({ messages, start, total });
}

function isValidMessagePage(page: RawMessagePage): boolean {
  return Number.isInteger(page.start)
    && Number.isInteger(page.total)
    && page.start >= 0
    && page.total >= page.start
    && page.messages.length <= page.total - page.start
    && !page.messages.some(isNormalizedChatLine);
}

function isNormalizedChatLine(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "role" in value
    && "parts" in value
    && !("content" in value)
    && typeof value.role === "string"
    && Array.isArray(value.parts);
}
