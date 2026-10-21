import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// ponytail: a copy of Pi's `core/cache-stats` (1.3.0), which Pi stopped exporting from its package root;
// import the SDK's again once it re-exports `collectCacheMisses`/`detectCacheMiss`.

/** Prompt-cache TTL: idle gaps longer than this are worth mentioning as the likely cause of a miss. */
export const CACHE_TTL_MS = 5 * 60 * 1000;
/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

/** A counted cache miss on a single assistant message. */
export interface CacheMiss {
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
}

/** Minimal pricing lookup. Cost is $/million tokens. */
export interface ModelPriceSource {
  getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

interface PreviousRequest { promptTokens: number; modelKey: string; timestamp: number; reportedCache: boolean }

function detectMiss(prev: PreviousRequest | undefined, message: AssistantMessage, models: ModelPriceSource): CacheMiss | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  // A zero-cache turn only counts when cache activity was reported before.
  if (prev === undefined || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) return undefined;
  const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;
  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
  const readPerToken = usage.cacheRead > 0
    ? usage.cost.cacheRead / usage.cacheRead
    : (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, message.timestamp - prev.timestamp),
    modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
  };
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) return undefined;
  return { promptTokens, modelKey: `${message.provider}/${message.model}`, timestamp: message.timestamp, reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0 };
}

function scan(entries: readonly SessionEntry[], models: ModelPriceSource): { prev: PreviousRequest | undefined; misses: Map<AssistantMessage, CacheMiss> } {
  let prev: PreviousRequest | undefined;
  const misses = new Map<AssistantMessage, CacheMiss>();
  for (const entry of entries) {
    // The context legitimately changed; model switches are not exempt.
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      prev = undefined;
      continue;
    }
    if (entry.type === "usage" && entry.kind === "cache_warm") {
      const { usage } = entry;
      const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      if (promptTokens > 0) prev = { promptTokens, modelKey: `${entry.provider}/${entry.model}`, timestamp: Date.parse(entry.timestamp), reportedCache: true };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      const miss = detectMiss(prev, entry.message, models);
      if (miss !== undefined) misses.set(entry.message, miss);
      prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
    }
  }
  return { prev, misses };
}

/** All counted cache misses across a session, keyed by the assistant message that paid for them. */
export function collectCacheMisses(entries: readonly SessionEntry[], models: ModelPriceSource): Map<AssistantMessage, CacheMiss> {
  return scan(entries, models).misses;
}

/** The cache miss of a just-completed assistant message; `entries` must not yet contain it. */
export function detectCacheMiss(entries: readonly SessionEntry[], message: AssistantMessage, models: ModelPriceSource): CacheMiss | undefined {
  return detectMiss(scan(entries, models).prev, message, models);
}
