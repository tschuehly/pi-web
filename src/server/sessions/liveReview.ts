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
const MAX_LINE = 20_000;
/** The pending buffer and so each digest, marker and file list included (the list is kept whole). */
const MAX_DIGEST = 60_000;
const UNREDACTED = "[redaction unavailable: omitted]";
/** The main Chat host's redactor over one whole field; it rejects when the host cannot redact. */
export type Redact = (text: string) => Promise<string>;

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
const omitted = (calls: number) => `[… ${String(calls)} earlier tool calls omitted; read the files listed]`;

/** One field, redacted whole before anything cuts or escapes it (a cut key or an escaped backslash hides a secret). */
const clean = (text: string, redact: Redact) => redact(text).then((result) => (typeof result === "string" ? result : UNREDACTED), () => UNREDACTED);
/** Every string in an argument value, each redacted whole, so JSON escaping comes after. */
async function cleanDeep(value: unknown, redact: Redact): Promise<unknown> {
  if (typeof value === "string") return clean(value, redact);
  if (Array.isArray(value)) return Promise.all(value.map((item) => cleanDeep(item, redact)));
  if (!isRecord(value)) return value;
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await cleanDeep(item, redact)] as const)));
}

interface ReviewedEvent { type: string; message?: unknown; toolName?: string; isError?: boolean; text?: string }
interface Line { text: string; call: boolean }
/** A digest taken for delivery; `putBack` returns it when the reviewer did not take it. */
export interface LiveReviewDigest { text: string; lines: Line[]; files: string[]; omitted: number }

/**
 * The main Chat's work since the last digest: owner and assistant text, reasoning, tool calls with their arguments as they
 * are (an edit's arguments are its diff), error text from tool output and the files edit and write touched, each field
 * through the main Chat host's redactor first. Tool output is left out: the reviewer reads files itself. `due` says a
 * trigger fired; `take` empties it, so a digest taken after the reviewer was busy covers everything since the last one.
 * The buffer keeps the newest {@link MAX_DIGEST} characters and every touched file. A turn the reviewer's own message
 * started (it started the run, or a queued one opened the next turn) fires no trigger, so the pair never runs without
 * the owner; its work waits for the owner's next digest. An owner message joining that turn makes it the owner's again.
 */
export class LiveReviewCollector {
  #lines: Line[] = [];
  #size = 0;
  #files = new Set<string>();
  #omitted = 0;
  #calls = 0;
  #reviewerTurn = false;
  /** Owner-turn lines no trigger has covered yet, so the owner's part is due when a reviewer turn follows it. */
  #fresh = false;
  due = false;

  constructor(readonly trigger: LiveReviewTrigger) {}

  /** Serialize calls: each awaits its redaction before the next event may change `due`. */
  async add(event: ReviewedEvent, redact: Redact): Promise<void> {
    if (event.type === "agent.end") {
      if (!this.#reviewerTurn) this.#fire();
      this.#reviewerTurn = false;
      this.#calls = 0;
    }
    if (event.type === "tool.end") {
      if (event.isError === true) this.#push(`Tool error ${event.toolName ?? "tool"}: ${await clean(event.text ?? "", redact)}`);
      if (!this.#reviewerTurn) {
        this.#calls += 1;
        if (this.trigger === "edits" && EDIT_TOOLS.has(event.toolName ?? "")) this.#fire();
        if (this.trigger === "turn5" && this.#calls >= 5) this.#fire();
      }
    }
    if (event.type !== "message.end" || !isRecord(event.message)) return;
    const { role, content, customType, details } = event.message;
    if (role === "custom" && customType === "workbench:chat-message" && isRecord(details) && isRecord(details["liveReview"]) && details["liveReview"]["kind"] === "reviewer"
      && (details["delivery"] === "started" || details["delivery"] === "queued") && !this.#reviewerTurn) {
      // The owner's turn ended at the boundary this message opened: its part is due, as at a turn end.
      if (this.#fresh) this.#fire();
      [this.#reviewerTurn, this.#calls] = [true, 0];
    }
    if (role === "user") {
      this.#reviewerTurn = false;
      const text = textOf(content).trim();
      if (text !== "") this.#push(`Owner: ${await clean(text, redact)}`);
    }
    if (role !== "assistant" || !Array.isArray(content)) return;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part["type"] === "thinking" && typeof part["thinking"] === "string" && part["thinking"].trim() !== "") this.#push(`Reasoning: ${await clean(part["thinking"].trim(), redact)}`);
      if (part["type"] === "text" && typeof part["text"] === "string" && part["text"].trim() !== "") this.#push(`Assistant: ${await clean(part["text"].trim(), redact)}`);
      if (part["type"] === "toolCall" && typeof part["name"] === "string") {
        const args = await cleanDeep(part["arguments"] ?? {}, redact);
        this.#push(`Tool call ${part["name"]} ${JSON.stringify(args)}`, true);
        const path = isRecord(args) ? args["path"] : undefined;
        if (FILE_TOOLS.has(part["name"]) && typeof path === "string") this.#files.add(path);
        this.#trim();
      }
    }
  }

  /** The digest of everything collected, or nothing when there is nothing new; clears `due` either way. */
  take(): LiveReviewDigest | undefined {
    this.due = false;
    if (this.#lines.length === 0) return undefined;
    const taken = { lines: this.#lines, files: [...this.#files], omitted: this.#omitted };
    [this.#lines, this.#size, this.#files, this.#omitted] = [[], 0, new Set(), 0];
    return { ...taken, text: digestText(taken) };
  }

  /** A digest the reviewer did not take: it goes first in the next one, capped again with it. */
  putBack(digest: LiveReviewDigest): void {
    this.#lines = [...digest.lines, ...this.#lines];
    this.#size = this.#lines.reduce((size, line) => size + line.text.length + 1, 0);
    this.#files = new Set([...digest.files, ...this.#files]);
    this.#omitted += digest.omitted;
    this.#trim();
  }

  #fire(): void {
    [this.due, this.#calls, this.#fresh] = [true, 0, false];
  }

  #push(text: string, call = false): void {
    const line = { text: cut(text), call };
    this.#lines.push(line);
    this.#size += line.text.length + 1;
    if (!this.#reviewerTurn) this.#fresh = true;
    this.#trim();
  }

  /** Drop the oldest lines past the cap, counting the tool calls among them for the marker. */
  #trim(): void {
    // shortcut: the touched-file list is kept whole outside the cap; a turn touching thousands of files makes a longer digest.
    const reserve = omitted(Number.MAX_SAFE_INTEGER).length + 1 + `Files touched: ${[...this.#files].join(", ")}`.length + 1;
    while (this.#lines.length > 1 && this.#size + reserve > MAX_DIGEST) {
      const dropped = this.#lines.shift();
      this.#size -= (dropped?.text.length ?? 0) + 1;
      if (dropped?.call === true) this.#omitted += 1;
    }
  }
}

function digestText({ lines, files, omitted: calls }: Omit<LiveReviewDigest, "text">): string {
  return [...(calls === 0 ? [] : [omitted(calls)]), ...lines.map((line) => line.text), ...(files.length === 0 ? [] : [`Files touched: ${files.join(", ")}`])].join("\n");
}
