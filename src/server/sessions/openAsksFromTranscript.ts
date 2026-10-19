import { ASK_USER_ANSWERS_CUSTOM_TYPE, type PendingAskUser } from "../../shared/apiTypes.js";
import { isRecord } from "./sessionFileFormat.js";

interface OpenAskTrace {
  ask: PendingAskUser;
  /** Branch index of the entry that first posted the ask. */
  openedAt: number;
}

/**
 * Rebuild a session's open asks from its transcript, so they survive a daemon
 * restart without a store of their own.
 *
 * `ask_user` tool results carry each posted or revised ask (`details.ask`) and
 * each withdrawal (`details.withdrawn`); answer messages carry each close. A
 * tree rewind closes asks without writing anything, but it leaves a sibling
 * branch behind: an ask is treated as rewound when any branch entry from its
 * post onwards has a child outside the branch.
 *
 * `turnsSinceUpdate` is approximated by the user messages after the last update.
 */
export function openAsksFromTranscript(branch: readonly unknown[], allEntries: readonly unknown[]): PendingAskUser[] {
  const open = new Map<string, OpenAskTrace>();
  branch.forEach((entry, index) => {
    const message = isRecord(entry) && entry["type"] === "message" ? entry["message"] : undefined;
    if (isRecord(message) && message["role"] === "user") {
      for (const trace of open.values()) trace.ask.turnsSinceUpdate += 1;
      return;
    }
    if (isRecord(message) && message["role"] === "toolResult" && message["toolName"] === "ask_user" && message["isError"] !== true) {
      const details = message["details"];
      if (!isRecord(details)) return;
      const ask = parseAsk(details["ask"]);
      if (ask !== undefined) open.set(ask.askId, { ask, openedAt: open.get(ask.askId)?.openedAt ?? index });
      for (const closed of [details["withdrawn"], details["superseded"]]) {
        if (isRecord(closed) && typeof closed["askId"] === "string") open.delete(closed["askId"]);
      }
      return;
    }
    if (isRecord(entry) && entry["type"] === "custom_message" && entry["customType"] === ASK_USER_ANSWERS_CUSTOM_TYPE) {
      const details = entry["details"];
      if (isRecord(details) && typeof details["askId"] === "string") open.delete(details["askId"]);
    }
  });
  const branchIds = new Set(branch.map(entryId));
  const leftBranches = new Set(allEntries.filter((entry) => !branchIds.has(entryId(entry))).map((entry) => isRecord(entry) ? entry["parentId"] : undefined));
  return [...open.values()]
    .filter(({ openedAt }) => !branch.slice(openedAt).some((entry) => leftBranches.has(entryId(entry))))
    .map(({ ask }) => ask);
}

function entryId(entry: unknown): unknown {
  return isRecord(entry) ? entry["id"] : undefined;
}

type PostedAsk = Omit<PendingAskUser, "updatedAt" | "turnsSinceUpdate"> & { updatedAt?: unknown };

/** Shape check only: the details were written by PI WEB's own `ask_user` tool. */
function isPostedAsk(value: unknown): value is PostedAsk {
  return isRecord(value) && typeof value["askId"] === "string" && typeof value["askedAt"] === "string" && Array.isArray(value["questions"]);
}

function parseAsk(value: unknown): PendingAskUser | undefined {
  if (!isPostedAsk(value)) return undefined;
  const { askId, askedAt, updatedAt, context, questions } = value;
  return { askId, askedAt, updatedAt: typeof updatedAt === "string" ? updatedAt : askedAt, turnsSinceUpdate: 0, ...(typeof context === "string" ? { context } : {}), questions };
}
