import { ASK_USER_ANSWERS_CUSTOM_TYPE, type AskUserOutcome, type PendingAskUser } from "../../shared/apiTypes.js";
import { ASK_USER_CLOSED_CUSTOM_TYPE } from "./pendingAskStore.js";
import { isRecord } from "./sessionFileFormat.js";

/** What a branch says about a session's asks. */
export interface TranscriptAsks {
  /** Asks posted by this session on the branch and not closed on it. */
  open: PendingAskUser[];
  /** Recorded closes whose answers message never reached the branch, e.g. a queued follow-up lost to a daemon restart. */
  undelivered: AskUserOutcome[];
}

/**
 * Rebuild a session's open asks from its current branch (root to leaf), so they
 * survive a daemon restart without a store of their own.
 *
 * `ask_user` tool results carry each posted or revised ask (`details.ask`, with
 * the posting `details.sessionId`) and each withdrawal (`details.withdrawn`);
 * close records and answer messages carry each submit or cancel. Only asks this
 * session posted count, so a fork does not inherit its parent's asks, and only
 * the branch counts, so a rewind past an ask leaves it behind.
 *
 * `turnsSinceUpdate` counts the assistant messages after the last update: one
 * per agent turn, as the live store counts `turn_start`.
 */
export function openAsksFromTranscript(branch: readonly unknown[], sessionId: string): TranscriptAsks {
  const open = new Map<string, PendingAskUser>();
  const undelivered = new Map<string, AskUserOutcome>();
  for (const entry of branch) {
    if (!isRecord(entry)) continue;
    const message = entry["type"] === "message" ? entry["message"] : undefined;
    if (isRecord(message) && message["role"] === "assistant") {
      for (const ask of open.values()) ask.turnsSinceUpdate += 1;
    } else if (isRecord(message) && message["role"] === "toolResult" && message["toolName"] === "ask_user" && message["isError"] !== true) {
      const details = message["details"];
      if (!isRecord(details)) continue;
      const ask = details["sessionId"] === sessionId ? parseAsk(details["ask"]) : undefined;
      if (ask !== undefined) open.set(ask.askId, ask);
      const withdrawn = details["withdrawn"];
      if (isRecord(withdrawn) && typeof withdrawn["askId"] === "string") open.delete(withdrawn["askId"]);
    } else if (entry["type"] === "custom" && entry["customType"] === ASK_USER_CLOSED_CUSTOM_TYPE) {
      const outcome = entry["data"];
      if (isOutcome(outcome) && open.delete(outcome.askId)) undelivered.set(outcome.askId, outcome);
    } else if (entry["type"] === "custom_message" && entry["customType"] === ASK_USER_ANSWERS_CUSTOM_TYPE) {
      const details = entry["details"];
      if (isRecord(details) && typeof details["askId"] === "string") {
        open.delete(details["askId"]);
        undelivered.delete(details["askId"]);
      }
    }
  }
  return { open: [...open.values()], undelivered: [...undelivered.values()] };
}

// Shape checks only: PI WEB itself wrote these entries.
function isPendingAsk(value: unknown): value is PendingAskUser {
  return isRecord(value) && typeof value["askId"] === "string" && typeof value["askedAt"] === "string" && typeof value["updatedAt"] === "string"
    && typeof value["revision"] === "string" && Array.isArray(value["questions"]);
}

function isOutcome(value: unknown): value is AskUserOutcome {
  return isRecord(value) && typeof value["askId"] === "string" && typeof value["reason"] === "string" && Array.isArray(value["questions"]);
}

function parseAsk(value: unknown): PendingAskUser | undefined {
  return isPendingAsk(value) ? { ...value, turnsSinceUpdate: 0 } : undefined;
}
