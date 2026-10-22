import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { SessionStatus, SessionUiEvent } from "../../shared/apiTypes.js";
import type { ClientMessagePage, ClientSession, ClientSessionStatus, SessionStreamSnapshot, SessionTranscriptSnapshot } from "../types.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import type { DurableChatRecord, SessionRuntimeLocator } from "./sessionRuntimeLocator.js";
import type { SessionRouteRef } from "./sessionService.js";

/** The session-host protocol version this daemon speaks (Workbench `chat-session.ts` `PROTOCOL`). */
export const DURABLE_HOST_PROTOCOL = 1;

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
export function forkDurableHost(options: { entry: string; model: string; agentDir: string }): DurableHostLauncher {
  return (record, storeDir) => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(storeDir, "host.log"), "a", 0o600);
    try {
      // No inherited loader flags (tsx): the host is plain Node with type stripping and its own pinned dependencies.
      return fork(options.entry, ["--store", storeDir, "--cwd", record.cwd, "--model", options.model], {
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
  publishGlobal(event: { type: "status.update"; status: SessionStatus } | { type: "activity.update"; activity: { sessionId: string; phase: "active" | "idle" | "error"; label: string; at: string } }): void;
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
  #next = 1;
  #exited: Error | undefined;
  readonly #pending = new Map<number, { resolve: (reply: { result: unknown; seq: number }) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly process: DurableHostProcess,
    onEvent: (event: SessionUiEvent) => void,
    watermark: () => number,
    onExit: (error: Error) => void,
  ) {
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject; });
    process.on("message", (message) => {
      if (!isRecord(message)) return;
      if (isRecord(message["ready"])) {
        const protocol = message["ready"]["protocol"];
        if (protocol === DURABLE_HOST_PROTOCOL) markReady();
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

  /** Graceful close: the host closes its store and exits; a host that does not answer in time is terminated. */
  async close(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return;
    const timer = setTimeout(() => { this.process.kill("SIGTERM"); }, timeoutMs);
    try {
      await this.request("close");
    } catch {
      // Already gone, or terminated by the timer; either way the store is no longer open here.
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
    logger?: { warn(object: object, message: string): void };
  }) {}

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

  /** Resolves once the host committed the input; a queued input shows in status until it is placed. */
  async prompt(ref: SessionRouteRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown): Promise<void> {
    if (typeof text !== "string" || text.trim() === "") throw new Error("text field must be a non-empty string");
    if (Array.isArray(attachments) && attachments.length > 0) throw new DurableChatUnavailable("Attachments");
    if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") throw new Error("streamingBehavior must be steer or followUp");
    // ponytail: one operation ID per HTTP request; a client-supplied ID would also dedupe retried requests.
    await (await this.#for(ref)).request("prompt", { operationId: randomUUID(), text, ...(streamingBehavior === undefined ? {} : { mode: streamingBehavior }) });
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
    const opened = connection.ready.then(() => connection);
    this.#connections.set(record.id, opened);
    opened.catch(() => { if (this.#connections.get(record.id) === opened) this.#connections.delete(record.id); });
    return opened;
  }

  #onEvent(sessionId: string, event: SessionUiEvent): void {
    const record = this.deps.locator.durable(sessionId);
    if (record === undefined) return;
    const scope = { id: sessionId, cwd: record.cwd };
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

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : "")).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host is local Workbench code speaking PI WEB's own event shapes; only the discriminator is checked here. */
function isSessionUiEvent(value: unknown): value is SessionUiEvent {
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
