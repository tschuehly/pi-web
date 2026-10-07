import { CACHE_TTL_MS, collectCacheMisses, detectCacheMiss, type CacheMiss, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

type ModelPrices = Parameters<typeof collectCacheMisses>[1];

/**
 * Pi's prompt cache-miss notice, as the interactive TUI words and thresholds it
 * (`InteractiveMode.addCacheMissNotice`). Detection is the SDK's own; only the
 * presentation lives here because the TUI does not export it.
 */
export function cacheMissNotice(miss: CacheMiss | undefined): string | undefined {
  if (miss === undefined || (miss.missedTokens < 20_000 && miss.missedCost < 0.1)) return undefined;
  const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
  const label = miss.modelChanged
    ? "Cache miss after model switch"
    : miss.idleMs >= CACHE_TTL_MS ? `Cache miss after ${String(Math.round(miss.idleMs / 60_000))}m idle` : "Cache miss";
  return `${label}: ${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
}

/** Notice for a just-ended assistant message. `entries` must not contain it yet (message_end precedes persistence). */
export function liveCacheMissNotice(entries: readonly unknown[], message: unknown, models: ModelPrices): string | undefined {
  if (!paidTurn(message) || !isEntryList(entries)) return undefined;
  try {
    return cacheMissNotice(detectCacheMiss(entries, message, models));
  } catch {
    return undefined; // Malformed history must never break the transcript.
  }
}

/** Notices re-derived from history, keyed by the entry id of the assistant message that paid for the miss. */
export function cacheMissNoticesByEntryId(entries: readonly unknown[], models: ModelPrices): Map<string, string> {
  const notices = new Map<string, string>();
  if (!isEntryList(entries)) return notices;
  let misses: Map<AssistantMessage, CacheMiss>;
  try {
    misses = collectCacheMisses(entries, models);
  } catch {
    return notices;
  }
  for (const entry of entries) {
    if (entry.type !== "message" || !paidTurn(entry.message)) continue;
    const notice = cacheMissNotice(misses.get(entry.message));
    if (notice !== undefined) notices.set(entry.id, notice);
  }
  return notices;
}

/** The TUI shows no notice for aborted or failed turns. */
function paidTurn(message: unknown): message is AssistantMessage {
  return isRecord(message) && message["role"] === "assistant" && isRecord(message["usage"])
    && message["stopReason"] !== "aborted" && message["stopReason"] !== "error";
}

/** Durable Pi session entries; the SDK scan tolerates any entry type it does not count. */
function isEntryList(entries: readonly unknown[]): entries is SessionEntry[] {
  return entries.every((entry) => isRecord(entry) && typeof entry["type"] === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pi footer `formatTokens` (not exported by the SDK). */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${String(Math.round(count / 1000))}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${String(Math.round(count / 1000000))}M`;
}
