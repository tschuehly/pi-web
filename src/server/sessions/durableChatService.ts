import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { AskUserCloseResponse, AskUserOutcome, AskUserSubmission, PendingAskUser, SessionAttentionEvent, SessionAttentionRequest, SessionStatus, SessionUiEvent } from "../../shared/apiTypes.js";
import type { ClientCommand, ClientCommandResult, ClientMessagePage, ClientSession, ClientSessionModel, ClientSessionModelCatalogEntry, ClientSessionStatus, SessionStreamSnapshot, SessionTranscriptSnapshot } from "../types.js";
import type { DurableChatResourceSet } from "./durableChatResources.js";
import { expandSkills } from "./durableChatResources.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import { PendingAskStore, renderAskUserAnswersText, renderOpenAsksReminder, type PendingAskCloseResult } from "./pendingAskStore.js";
import type { DurableChatRecord, SessionRuntimeLocator } from "./sessionRuntimeLocator.js";
import type { SessionRouteRef } from "./sessionService.js";

/** The session-host protocol version this daemon speaks (Workbench `chat-session.ts` `PROTOCOL`). */
export const DURABLE_HOST_PROTOCOL = 2;

/** How the owner resolves an interrupted unsafe tool call that may have run. */
export type DurableEffectResolution = "done" | "not-done" | "retry";

/** The part of a child process a host connection uses; tests pass a fake. */
export interface DurableHostProcess {
  send(message: unknown): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Starts the host process that owns one Chat family's store. */
export type DurableHostLauncher = (record: DurableChatRecord, storeDir: string) => DurableHostProcess;

/**
 * Fork the Workbench Durable host (`chat-host-main.ts`) for one family store, with an IPC channel, the agent-visible
 * environment and the daemon's Pi agent directory, so it reads the same Claude subscription login. Host output goes
 * to `host.log` in the store directory.
 */
export function forkDurableHost(options: { entry: string; model: string; agentDir: string; scripted?: boolean }): DurableHostLauncher {
  return (record, storeDir) => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(storeDir, "host.log"), "a", 0o600);
    try {
      // No inherited loader flags (tsx): the host is plain Node with type stripping and its own pinned dependencies.
      const args = ["--store", storeDir, "--cwd", record.cwd, "--model", options.model, "--session-id", record.id, ...(options.scripted === true ? ["--scripted"] : [])];
      return fork(options.entry, args, {
        execArgv: [],
        stdio: ["ignore", log, log, "ipc"],
        env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
      });
    } finally {
      closeSync(log);
    }
  };
}

interface HostEvents {
  publish(sessionId: string, event: SessionUiEvent, mediaScope?: { id: string; cwd: string }): void;
  publishGlobal(event: { type: "status.update"; status: SessionStatus } | { type: "activity.update"; activity: { sessionId: string; phase: "active" | "idle" | "error"; label: string; at: string } } | SessionAttentionEvent): void;
  currentSeq(sessionId: string): number;
}

interface HostTranscript {
  messages: unknown[];
  partial: unknown;
  status: Omit<ClientSessionStatus, "sessionId">;
}

export class DurableChatUnavailable extends Error {
  constructor(operation: string) {
    super(`${operation} is not available in Durable Chats yet`);
    this.name = "DurableChatUnavailable";
  }
}

/**
 * One host connection: JSON requests and replies over the host's IPC channel, plus the PI WEB session events it
 * pushes. A reply carries the event watermark at its arrival: every event the host sent before the reply is published.
 */
class DurableHostConnection {
  readonly ready: Promise<void>;
  /** Optional operations the host reported (Workbench `chat-session.ts` `CAPABILITIES`); absent ones stay blocked. */
  capabilities: ReadonlySet<string> = new Set();
  /** Resolves when the host process has exited, so its store lock is released. */
  readonly exited: Promise<void>;
  #markExited!: () => void;
  #next = 1;
  #exited: Error | undefined;
  readonly #pending = new Map<number, { resolve: (reply: { result: unknown; seq: number }) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly process: DurableHostProcess,
    onEvent: (event: SessionUiEvent | HostAttentionEvent) => void,
    watermark: () => number,
    onExit: (error: Error) => void,
  ) {
    this.exited = new Promise((resolve) => { this.#markExited = resolve; });
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject; });
    process.on("message", (message) => {
      if (!isRecord(message)) return;
      if (isRecord(message["ready"])) {
        const protocol = message["ready"]["protocol"];
        if (protocol === DURABLE_HOST_PROTOCOL) {
          const reported = message["ready"]["capabilities"];
          this.capabilities = new Set(Array.isArray(reported) ? reported.filter((name): name is string => typeof name === "string") : []);
          markReady();
        }
        else {
          failReady(new Error(`Durable host speaks protocol ${String(protocol)}, this daemon ${String(DURABLE_HOST_PROTOCOL)}`));
          process.kill("SIGTERM");
        }
        return;
      }
      if (isSessionUiEvent(message["event"])) {
        onEvent(message["event"]);
        return;
      }
      const id = message["id"];
      if (typeof id !== "number") return;
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      const error = message["error"];
      if (isRecord(error)) pending?.reject(new Error(typeof error["message"] === "string" ? error["message"] : "Durable host request failed"));
      else pending?.resolve({ result: message["result"], seq: watermark() });
    });
    process.on("exit", (code, signal) => {
      this.#exited = new Error(`Durable host exited (${signal ?? String(code)})`);
      failReady(this.#exited);
      for (const pending of this.#pending.values()) pending.reject(this.#exited);
      this.#pending.clear();
      this.#markExited();
      onExit(this.#exited);
    });
  }

  get alive(): boolean {
    return this.#exited === undefined;
  }

  async request(method: string, params?: object): Promise<{ result: unknown; seq: number }> {
    await this.ready;
    if (this.#exited !== undefined) throw this.#exited;
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.process.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /**
   * Graceful close: the host closes its store and exits; a host that does not exit in time is terminated. Resolves
   * only once the process is gone, so a host opened next for the same store never meets its lock.
   */
  async close(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return;
    const timer = setTimeout(() => { this.process.kill("SIGTERM"); }, timeoutMs);
    try {
      await this.request("close");
    } catch {
      // Already gone, or terminated by the timer.
    }
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Durable Chats behind PI WEB's session routes: creates them, starts each one's own host on demand, forwards its
 * events, and answers the route operations slice 1 supports. Status and transcript reads never resume work: a
 * reopened store stays paused until the next prompt.
 */
export class DurableChatService {
  readonly #connections = new Map<string, Promise<DurableHostConnection>>();

  constructor(private readonly deps: {
    locator: SessionRuntimeLocator;
    events: HostEvents;
    launch: DurableHostLauncher;
    /** `<data dir>/durable`: one directory per family store. */
    storesDir: string;
    /** AGENTS.md, APPEND_SYSTEM.md and skills for a workspace, from Pi's loader; sent to each host as it opens. */
    resources?: (cwd: string) => Promise<DurableChatResourceSet>;
    logger?: { warn(object: object, message: string): void };
  }) {}

  readonly #skills = new Map<string, DurableChatResourceSet["skillList"]>();

  owns(sessionId: string): boolean {
    return this.deps.locator.durable(sessionId) !== undefined;
  }

  async start(cwd: string, startupToken?: string): Promise<ClientSession> {
    const record = this.deps.locator.create(cwd);
    try {
      await this.#connection(record);
    } catch (error) {
      this.deps.locator.remove(record.id);
      throw error;
    }
    return { ...this.info(record), ...(startupToken === undefined ? {} : { startupToken }) };
  }

  info(record: DurableChatRecord): ClientSession {
    return {
      id: record.id,
      cwd: record.cwd,
      // Not a filesystem path: browsers never receive store locations.
      path: `durable:${record.id}`,
      persisted: true,
      name: record.firstMessage === "" ? "Durable Chat" : `Durable · ${record.firstMessage.slice(0, 60)}`,
      created: record.created,
      modified: record.modified,
      messageCount: record.messageCount,
      firstMessage: record.firstMessage,
    };
  }

  list(cwd: string, sessionId?: string): ClientSession[] {
    return this.deps.locator.all()
      .filter((record) => record.cwd === cwd && (sessionId === undefined || record.id === sessionId))
      .map((record) => this.info(record));
  }

  listAll(): ClientSession[] {
    return this.deps.locator.all().map((record) => this.info(record));
  }

  async messages(ref: SessionRouteRef, page?: { before?: number; limit?: number }): Promise<ClientMessagePage> {
    const { result } = await (await this.#for(ref)).request("transcript");
    return pageMessagesAtSafeBoundary(hostTranscript(result).messages, page);
  }

  async status(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    const { result } = await (await this.#for(ref)).request("status");
    return { ...hostStatus(result), sessionId: ref.id };
  }

  async streamSnapshot(ref: SessionRouteRef): Promise<SessionStreamSnapshot> {
    const { result, seq } = await (await this.#for(ref)).request("transcript");
    return { seq, partial: hostTranscript(result).partial };
  }

  async transcriptSnapshot(ref: SessionRouteRef, page?: { limit?: number }): Promise<SessionTranscriptSnapshot> {
    const { result, seq } = await (await this.#for(ref)).request("transcript");
    const transcript = hostTranscript(result);
    return { seq, partial: transcript.partial, page: pageMessagesAtSafeBoundary(transcript.messages, { limit: page?.limit ?? 100 }), status: { ...transcript.status, sessionId: ref.id } };
  }

  /**
   * Resolves once the host committed the input; a queued input shows in status until it is placed. The client's
   * operation ID makes a retried request the same input; `/skill:name` expands as in a legacy Chat.
   */
  async prompt(ref: SessionRouteRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown, options?: { operationId?: string }): Promise<void> {
    const operationId = options?.operationId;
    if (typeof text !== "string" || text.trim() === "") throw new Error("text field must be a non-empty string");
    if (Array.isArray(attachments) && attachments.length > 0) throw new DurableChatUnavailable("Attachments");
    if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") throw new Error("streamingBehavior must be steer or followUp");
    const connection = await this.#for(ref);
    const expanded = expandSkills(text, this.#skills.get(ref.id) ?? []);
    await connection.request("prompt", { operationId: operationId ?? randomUUID(), text: expanded, ...(streamingBehavior === undefined ? {} : { mode: streamingBehavior }) });
  }

  /** Host-reported capabilities of a Chat (e.g. `compact`, `mcp`), so controls light up only where they work. */
  async capabilities(ref: SessionRouteRef): Promise<string[]> {
    return [...(await this.#for(ref)).capabilities];
  }

  /** Slash commands of a Durable Chat: Working Mode, /compact where the host supports it, and the workspace's skills. */
  async commands(ref: SessionRouteRef): Promise<ClientCommand[]> {
    const connection = await this.#for(ref);
    return [
      { name: "mode", description: "Choose Working Mode guidance for the next prompt; /mode send delivers it now", source: "extension" },
      ...(connection.capabilities.has("compact") ? [{ name: "compact", description: "Manually compact session context", argumentHint: "[instructions]", source: "builtin" as const }] : []),
      ...(this.#skills.get(ref.id) ?? []).map((skill) => ({ name: `skill:${skill.name}`, ...(skill.description === undefined ? {} : { description: skill.description }), source: "skill" as const })),
    ];
  }

  /** `/mode …` runs in the host; `/skill:…` is a prompt; every other command is not available yet. */
  async runCommand(ref: SessionRouteRef, text: string): Promise<ClientCommandResult> {
    const trimmed = text.trim();
    const name = /^\/(\S+)/.exec(trimmed)?.[1] ?? "";
    if (name === "mode") {
      const { result } = await (await this.#for(ref)).request("mode", { args: trimmed.slice("/mode".length).trim() });
      return commandResult(result);
    }
    if (name === "compact") {
      const connection = await this.#for(ref);
      if (!connection.capabilities.has("compact")) return { type: "unsupported", message: "/compact is not available in this Durable Chat's host" };
      const instructions = trimmed.slice("/compact".length).trim();
      const { result } = await connection.request("compact", instructions === "" ? {} : { instructions });
      return commandResult(result);
    }
    if (name.startsWith("skill:")) {
      await this.prompt(ref, trimmed);
      return { type: "done" };
    }
    return { type: "unsupported", message: `/${name} is not available in Durable Chats yet` };
  }

  async openAsks(ref: SessionRouteRef): Promise<PendingAskUser[]> {
    return (await this.status(ref)).pendingAsks ?? [];
  }

  async attentionRequest(ref: SessionRouteRef): Promise<SessionAttentionRequest | undefined> {
    return (await this.status(ref)).attentionRequest;
  }

  async acknowledgeAttention(ref: SessionRouteRef, requestId: string): Promise<boolean> {
    const { result } = await (await this.#for(ref)).request("acknowledgeAttention", { requestId });
    return result === true;
  }

  /** Answers to an open set, validated and rendered by PI WEB's own ask store; the host commits and delivers them. */
  async submitAsk(ref: SessionRouteRef, askId: string, submission: AskUserSubmission, operationId?: string): Promise<AskUserCloseResponse> {
    return this.#closeAsk(ref, askId, operationId, submission.revision, (store, sessionId) => store.submit(sessionId, askId, submission));
  }

  /** Dismiss an open set: the model is still told, naming every question unanswered, as in a legacy Chat. */
  async cancelAsk(ref: SessionRouteRef, askId: string, operationId?: string): Promise<AskUserCloseResponse> {
    return this.#closeAsk(ref, askId, operationId, undefined, (store, sessionId) => store.cancel(sessionId, askId));
  }

  async #closeAsk(ref: SessionRouteRef, askId: string, operationId: string | undefined, revision: string | undefined, close: (store: PendingAskStore, sessionId: string) => PendingAskCloseResult): Promise<AskUserCloseResponse> {
    const connection = await this.#for(ref);
    const asks = (await this.status(ref)).pendingAsks ?? [];
    const store = new PendingAskStore();
    store.restore(ref.id, asks);
    const closed = close(store, ref.id);
    // A set the host no longer has open may be this operation's own earlier close: the host answers that retry.
    const outcome = closed.status === "closed" ? closed.outcome : undefined;
    const content = outcome === undefined ? "" : [renderAskUserAnswersText(outcome), renderOpenAsksReminder(asks.filter((ask) => ask.askId !== askId))].filter((part) => part !== "").join("\n\n");
    const { result } = await connection.request("closeAsk", {
      askId, operationId: operationId ?? randomUUID(), content,
      outcome: outcome ?? { askId, reason: "stale" },
      ...(revision === undefined ? {} : { revision }),
      ...(outcome === undefined ? { revision: "stale" } : {}),
    });
    const sessionStatus = await this.status(ref);
    if (isRecord(result) && result["result"] === "closed" && isAskOutcome(result["outcome"])) return { result: "closed", outcome: result["outcome"], sessionStatus };
    return { result: "stale", sessionStatus };
  }

  async availableModels(ref: SessionRouteRef): Promise<ClientSessionModel[]> {
    const { result } = await (await this.#for(ref)).request("models");
    return Array.isArray(result) ? result.filter(isRecord).map((model) => ({ ...model })) : [];
  }

  /** Every model the host offers, all enabled: a Durable Chat has no separate enabled-model scope yet. */
  async modelCatalog(ref: SessionRouteRef): Promise<ClientSessionModelCatalogEntry[]> {
    return (await this.availableModels(ref)).map((model, catalogIndex) => ({ ...model, provider: model.provider ?? "", id: model.id ?? "", enabled: true, editable: false, catalogIndex }));
  }

  async setModel(ref: SessionRouteRef, provider: string, modelId: string): Promise<ClientSessionStatus> {
    await (await this.#for(ref)).request("setModel", { provider, modelId });
    return this.status(ref);
  }

  /** The owner's resolution of an interrupted call that may have run; the host records it and unblocks the tool. */
  async resolveEffect(ref: SessionRouteRef, taskId: string, resolution: DurableEffectResolution): Promise<ClientSessionStatus> {
    await (await this.#for(ref)).request("resolveEffect", { taskId, resolution });
    return this.status(ref);
  }

  async abort(ref: SessionRouteRef): Promise<void> {
    await (await this.#for(ref)).request("abort");
  }

  async clearQueue(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    await (await this.#for(ref)).request("clearQueue");
    return this.status(ref);
  }

  /** Close the Chat's host; its store keeps every admitted input and reopens paused on next use. */
  async stop(ref: SessionRouteRef): Promise<void> {
    const connection = this.#connections.get(ref.id);
    this.#connections.delete(ref.id);
    await (await connection?.catch(() => undefined))?.close();
  }

  async dispose(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map(async (connection) => (await connection.catch(() => undefined))?.close()));
  }

  #for(ref: SessionRouteRef): Promise<DurableHostConnection> {
    const record = this.deps.locator.durable(ref.id);
    if (record?.cwd !== ref.cwd) throw new Error("Session not found");
    return this.#connection(record);
  }

  #connection(record: DurableChatRecord): Promise<DurableHostConnection> {
    const existing = this.#connections.get(record.id);
    if (existing !== undefined) return existing;
    const storeDir = join(this.deps.storesDir, record.storeId);
    mkdirSync(this.deps.storesDir, { recursive: true, mode: 0o700 });
    const connection = new DurableHostConnection(
      this.deps.launch(record, storeDir),
      (event) => { this.#onEvent(record.id, event); },
      () => this.deps.events.currentSeq(record.id),
      (error) => {
        this.#connections.delete(record.id);
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat host exited");
        this.deps.events.publish(record.id, { type: "agent.end" });
      },
    );
    const opened = connection.ready.then(async () => {
      const loaded = await this.deps.resources?.(record.cwd).catch((error: unknown) => {
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat resources failed to load");
        return undefined;
      });
      if (loaded !== undefined) {
        this.#skills.set(record.id, loaded.skillList);
        await connection.request("configure", { resources: loaded.resources, compaction: loaded.compaction, mcp: { projectTrusted: loaded.projectTrusted } });
      }
      return connection;
    });
    this.#connections.set(record.id, opened);
    opened.catch(() => { if (this.#connections.get(record.id) === opened) this.#connections.delete(record.id); });
    return opened;
  }

  #onEvent(sessionId: string, event: SessionUiEvent | HostAttentionEvent): void {
    const record = this.deps.locator.durable(sessionId);
    if (record === undefined) return;
    const scope = { id: sessionId, cwd: record.cwd };
    if (event.type === "durable.attention") {
      // Committed and deduplicated by the host: one notification per ask or attention request.
      const name = this.info(record).name ?? "Durable Chat";
      this.deps.events.publishGlobal({
        type: "session.attention", sessionId, cwd: record.cwd, sessionName: name.slice(0, 120),
        kind: event.kind, id: event.id, detail: event.detail.trim().split(/\r?\n/u)[0]?.slice(0, 120) ?? "",
      });
      return;
    }
    if (event.type === "status.update") {
      const status = { ...event.status, sessionId };
      this.deps.events.publish(sessionId, { type: "status.update", status }, scope);
      this.deps.events.publishGlobal({ type: "status.update", status });
      if (status.messageCount !== undefined && status.messageCount !== record.messageCount) {
        this.deps.locator.update(sessionId, { messageCount: status.messageCount, modified: new Date().toISOString() });
      }
      return;
    }
    this.deps.events.publish(sessionId, event, scope);
    if (event.type === "agent.start" || event.type === "agent.end") {
      const active = event.type === "agent.start";
      const activity = { sessionId, phase: active ? "active" as const : "idle" as const, label: active ? "agent running" : "idle", at: new Date().toISOString() };
      this.deps.events.publish(sessionId, { type: "activity.update", activity }, scope);
      this.deps.events.publishGlobal({ type: "activity.update", activity });
    }
    if (event.type === "message.end" && record.firstMessage === "") {
      if (isRecord(event.message) && event.message["role"] === "user") this.deps.locator.update(sessionId, { firstMessage: textOf(event.message["content"]) });
    }
  }
}

/** A host-side notification request: the daemon turns it into PI WEB's global `session.attention`. */
interface HostAttentionEvent { type: "durable.attention"; kind: "ask" | "attention"; id: string; detail: string }

/** The host returns the outcome PI WEB's store computed (or, on a retry, recorded); a shape check suffices. */
function isAskOutcome(value: unknown): value is AskUserOutcome {
  return isRecord(value) && typeof value["askId"] === "string" && typeof value["reason"] === "string" && Array.isArray(value["questions"]) && typeof value["summary"] === "string";
}

function commandResult(value: unknown): ClientCommandResult {
  if (isRecord(value) && value["type"] === "done") return { type: "done", ...(typeof value["message"] === "string" ? { message: value["message"] } : {}) };
  if (isRecord(value) && value["type"] === "unsupported" && typeof value["message"] === "string") return { type: "unsupported", message: value["message"] };
  throw new Error("Durable host sent a malformed command result");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : "")).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host is local Workbench code speaking PI WEB's own event shapes; only the discriminator is checked here. */
function isSessionUiEvent(value: unknown): value is SessionUiEvent | HostAttentionEvent {
  return isRecord(value) && typeof value["type"] === "string";
}

function isHostStatus(value: unknown): value is HostTranscript["status"] {
  return isRecord(value) && typeof value["isStreaming"] === "boolean" && Array.isArray(value["queuedMessages"])
    && typeof value["pendingMessageCount"] === "number";
}

function hostStatus(value: unknown): HostTranscript["status"] {
  if (!isHostStatus(value)) throw new Error("Durable host sent a malformed status");
  return value;
}

function hostTranscript(value: unknown): HostTranscript {
  if (!isRecord(value) || !Array.isArray(value["messages"]) || !("partial" in value)) throw new Error("Durable host sent a malformed transcript");
  return { messages: value["messages"], partial: value["partial"], status: hostStatus(value["status"]) };
}
