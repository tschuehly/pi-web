// Live review (`/pair`): a reviewer Durable Chat watches a main Chat through digests of its work. This module parses the
// command and collects the main Chat's events into digests; DurableChatService owns the pairing, delivery and timing.

export type LiveReviewTrigger = "turn" | "turn5" | "edits";
export type LiveReviewBrief = "silent" | "coach";

/** The pairing as the main Chat's record holds it; the reviewer's record names the main Chat in `reviewing`. */
export interface LiveReviewPairing {
  reviewerId: string;
  model: string;
  thinking: "low";
  trigger: LiveReviewTrigger;
  brief: LiveReviewBrief;
  /** The main Chat's turns since the pairing started. */
  turn: number;
  /** Digests delivered, so each has its own request ID across daemon restarts. */
  digests: number;
  startedAt: string;
}

export function isLiveReviewPairing(value: unknown): value is LiveReviewPairing {
  if (!isRecord(value)) return false;
  const { reviewerId, model, thinking, trigger, brief, turn, digests, startedAt } = value;
  return typeof reviewerId === "string" && typeof model === "string" && thinking === "low" && TRIGGERS.some((name) => name === trigger) && BRIEFS.some((name) => name === brief)
    && Number.isInteger(turn) && Number.isInteger(digests) && typeof startedAt === "string";
}

export const LIVE_REVIEW_MODEL = "openai/gpt-6.2-sol";
export const PAIR_USAGE = "Usage: /pair [<provider/model>] [--trigger turn|turn5|edits] [--brief silent|coach], or /pair stop";
const TRIGGERS: readonly LiveReviewTrigger[] = ["turn", "turn5", "edits"];
const BRIEFS: readonly LiveReviewBrief[] = ["silent", "coach"];
/** Tool calls after which `edits` sends a digest. */
const EDIT_TOOLS = new Set(["edit", "write", "bash"]);
const FILE_TOOLS = new Set(["edit", "write"]);
// shortcut: one cut per line, so a turn of many large writes can still make a long digest; cap the total if that shows up.
const MAX_LINE = 20_000;

export function parsePairCommand(args: string): { stop: true } | { model: string; trigger: LiveReviewTrigger; brief: LiveReviewBrief } {
  const words = args.split(/\s+/u).filter((word) => word !== "");
  if (words.length === 1 && words[0] === "stop") return { stop: true };
  let model: string | undefined;
  let trigger: LiveReviewTrigger = "turn5";
  let brief: LiveReviewBrief = "silent";
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const value = words[i + 1] ?? "";
    const pickedTrigger = word === "--trigger" ? TRIGGERS.find((name) => name === value) : undefined;
    const pickedBrief = word === "--brief" ? BRIEFS.find((name) => name === value) : undefined;
    if (pickedTrigger !== undefined) [trigger, i] = [pickedTrigger, i + 1];
    else if (pickedBrief !== undefined) [brief, i] = [pickedBrief, i + 1];
    else if (model === undefined && /^[^/\s-][^/\s]*\/\S+$/u.test(word)) model = word;
    else throw new Error(PAIR_USAGE);
  }
  return { model: model ?? LIVE_REVIEW_MODEL, trigger, brief };
}

const cut = (line: string) => (line.length <= MAX_LINE ? line : `${line.slice(0, MAX_LINE)}… (cut)`);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content)
  ? content.flatMap((part: unknown) => (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : [])).join("\n")
  : "");

interface ReviewedEvent { type: string; message?: unknown; toolName?: string; isError?: boolean; text?: string }

/**
 * The main Chat's work since the last digest: owner and assistant text, reasoning, tool calls with their arguments as they
 * are (an edit's arguments are its diff), error text from tool output and the files edit and write touched. Tool output is
 * left out: the reviewer reads files itself. `due` says a trigger fired; `take` empties it, so a digest taken after the
 * reviewer was busy covers everything since the last one.
 */
export class LiveReviewCollector {
  #lines: string[] = [];
  #files = new Set<string>();
  #calls = 0;
  due = false;

  constructor(readonly trigger: LiveReviewTrigger) {}

  add(event: ReviewedEvent): void {
    if (event.type === "agent.end") {
      this.due = true;
      this.#calls = 0;
    }
    if (event.type === "tool.end") {
      if (event.isError === true) this.#lines.push(cut(`Tool error ${event.toolName ?? "tool"}: ${event.text ?? ""}`));
      this.#calls += 1;
      if (this.trigger === "edits" && EDIT_TOOLS.has(event.toolName ?? "")) this.due = true;
      if (this.trigger === "turn5" && this.#calls >= 5) [this.due, this.#calls] = [true, 0];
    }
    if (event.type !== "message.end" || !isRecord(event.message)) return;
    const { role, content } = event.message;
    if (role === "user") {
      const text = textOf(content).trim();
      if (text !== "") this.#lines.push(cut(`Owner: ${text}`));
    }
    if (role !== "assistant" || !Array.isArray(content)) return;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part["type"] === "thinking" && typeof part["thinking"] === "string" && part["thinking"].trim() !== "") this.#lines.push(cut(`Reasoning: ${part["thinking"].trim()}`));
      if (part["type"] === "text" && typeof part["text"] === "string" && part["text"].trim() !== "") this.#lines.push(cut(`Assistant: ${part["text"].trim()}`));
      if (part["type"] === "toolCall" && typeof part["name"] === "string") {
        this.#lines.push(cut(`Tool call ${part["name"]} ${JSON.stringify(part["arguments"] ?? {})}`));
        const path = isRecord(part["arguments"]) ? part["arguments"]["path"] : undefined;
        if (FILE_TOOLS.has(part["name"]) && typeof path === "string") this.#files.add(path);
      }
    }
  }

  /** The digest of everything collected, or nothing when there is nothing new; clears `due` either way. */
  take(): string | undefined {
    this.due = false;
    if (this.#lines.length === 0) return undefined;
    const digest = [...this.#lines, ...(this.#files.size === 0 ? [] : [`Files touched: ${[...this.#files].join(", ")}`])].join("\n");
    this.#lines = [];
    this.#files = new Set();
    return digest;
  }

  /** A digest the reviewer did not take: it goes first in the next one. */
  putBack(digest: string): void {
    this.#lines.unshift(digest);
  }
}
