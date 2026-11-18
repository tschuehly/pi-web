import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { CHAT_CAPABILITY_LABELS, type ChatCapability, isChatCapability } from "../../shared/apiTypes.js";
import type { AskUserCloseResponse, AskUserOutcome, AskUserSubmission, PendingAskUser, QueuedSessionMessage, SavedPromptAttachment, SessionAttentionEvent, SessionAttentionRequest, SessionNotificationDismissAllRequest, SessionNotificationDismissRequest, SessionNotificationInboxSnapshot, SessionNotificationSummaryEvent, SessionQueueMessageMutation, SessionStatus, SessionUiEvent } from "../../shared/apiTypes.js";
import { hasExplicitPromptImageReference, parsePromptAttachments, removeImageReferenceTokensFromText, stripInlineImageReferenceMapping } from "../../shared/promptAttachments.js";
import type { PiWebConfig } from "../../config.js";
import { loadEffectiveProjectAttachmentsConfig } from "../workspaces/projectPiWebConfig.js";
import { attachmentsToInlineImages, saveAttachmentsToWorkspace } from "./attachmentService.js";
import type { SessionMedia, SessionMediaIndex } from "./sessionMediaIndex.js";
import type { ClientCommand, ClientCommandResult, ClientMessagePage, ClientSession, ClientSessionModel, ClientSessionModelCatalogEntry, ClientSessionStatus, ClientSessionTreeNavigateRequest, ClientSessionTreeNavigateResult, ClientThinkingLevel, SessionStreamSnapshot, SessionTranscriptSnapshot } from "../types.js";
import { projectSessionTree, type ProjectableSessionTreeNode } from "./sessionTreeProjection.js";
import type { DurableChatResourceSet, DurableContributedResources } from "./durableChatResources.js";
import { durableThinkingLevel, expandPromptTemplate, expandSkills } from "./durableChatResources.js";
import { BUILTIN_COMMANDS } from "./builtinCommands.js";
import { cacheMissNoticesByEntryId, cacheScanEntries, liveCacheMissNotice } from "./cacheMissNotices.js";
import type { ModelPriceSource } from "./cacheStats.js";
import { pageMessagesAtSafeBoundary } from "./messagePaging.js";
import { appendInlineImageReferenceMapping, CHECKPOINT_SESSION_TITLE_MAX_LENGTH, CHECKPOINT_TITLE_COMMAND, parseModelSpec, spawnTargetError } from "./piSessionService.js";
import type { SpawnTargetResolver } from "./spawnTargetResolver.js";
import type { SpawnSessionResult } from "./spawnSessionTool.js";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import { cleanSessionName, fallbackSessionName, SESSION_TITLE_SYSTEM_PROMPT, sessionTitleInput, shortSessionNamePrompt } from "./sessionNameGenerator.js";
import type { SessionNotificationGeneration, SessionNotificationMutation, SessionNotificationStore } from "./sessionNotificationStore.js";
import { isWorkstreamLaunchToken, type WorkstreamLaunchStore } from "./workstreamLaunchStore.js";
import { PendingAskStore, renderAskUserAnswersText, renderOpenAsksReminder, type PendingAskCloseResult } from "./pendingAskStore.js";
import type { DurableChatRecord, SessionRuntimeLocator } from "./sessionRuntimeLocator.js";
import type { SessionRouteRef } from "./sessionService.js";

/** The session-host protocol version this daemon speaks (Workbench `chat-session.ts` `PROTOCOL`). */
export const DURABLE_HOST_PROTOCOL = 2;

/** A family host with nothing running or waiting and no browser watching closes after this (legacy `IDLE_SESSION_UNLOAD_MS`). */
export const IDLE_HOST_CLOSE_MS = 2 * 60 * 60 * 1000;
const IDLE_HOST_SWEEP_MS = 10 * 60 * 1000;

/** How the owner resolves an interrupted unsafe tool call that may have run. */
export type DurableEffectResolution = "done" | "not-done" | "retry";

/** The part of a child process a host connection uses; tests pass a fake. */
export interface DurableHostProcess {
  /** As `ChildProcess.send`: a closed channel's error goes to the callback, not to an "error" event. */
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  /** A host the daemon does not own (a launchd job): drop the connection and leave the host running. */
  detach?(): void;
  /** A launchd host: the entry it runs from and the one new families get; they differ while the family is pinned (Phase C3). */
  readonly code?: { entry: string; current: string };
}

/**
 * Starts (or, for a launchd host, reattaches to) the host process that owns one Chat family's store. `attachOnly`: never
 * start one; the returned process exits when there is no live host to attach to. `endJobs`: instead of a host, a one-off
 * process from the same host entry (`--end-jobs`) that cancels the family's unfinished background jobs without opening
 * its store and exits, 0 once they are cancelled.
 */
export type DurableHostLauncher = (record: DurableChatRecord, storeDir: string, options?: { attachOnly?: boolean; endJobs?: boolean }) => DurableHostProcess;

/** What starts a family's host: the Workbench host entry, the model and Pi agent dir it runs with. */
export interface DurableHostOptions { entry: string; model: string; agentDir: string; scripted?: boolean; thinkingLevel?: (cwd: string, model: string) => string }

/** The host's arguments for one family; a new Chat starts at the thinking level Pi would pick (a reopened one keeps its own). */
export function durableHostLaunchArgs(options: DurableHostOptions, record: Pick<DurableChatRecord, "id" | "cwd">, storeDir: string): string[] {
  const thinking = options.thinkingLevel ?? ((cwd: string, model: string) => durableThinkingLevel(cwd, options.agentDir, model));
  return durableHostArgs(record, storeDir, { ...options, thinking: thinking(record.cwd, options.model) });
}

/** Host arguments: the family store, workspace, model, Chat ID and a new Chat's thinking level; every host runs the installed Pi packages it binds. */
export function durableHostArgs(record: Pick<DurableChatRecord, "id" | "cwd">, storeDir: string, options: { model: string; scripted?: boolean; thinking?: string }): string[] {
  return [
    "--store", storeDir, "--cwd", record.cwd, "--model", options.model, "--session-id", record.id, "--packages",
    ...(options.thinking === undefined ? [] : ["--thinking", options.thinking]), ...(options.scripted === true ? ["--scripted"] : []),
  ];
}

/**
 * Fork the Workbench Durable host (`chat-host-main.ts`) for one family store, with an IPC channel, the agent-visible
 * environment and the daemon's Pi agent directory, so it reads the same stored logins (Claude, ChatGPT, Copilot). Host
 * output goes to `host.log` in the store directory.
 */
export function forkDurableHost(options: DurableHostOptions): DurableHostLauncher {
  return (record, storeDir, launch) => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(storeDir, "host.log"), "a", 0o600);
    try {
      // No inherited loader flags (tsx): the host is plain Node with type stripping and its own pinned dependencies.
      return fork(options.entry, [...durableHostLaunchArgs(options, record, storeDir), ...(launch?.endJobs === true ? ["--end-jobs"] : [])], {
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
  /** Image references of published events; a media read binds the Chat's images from its transcript. */
  readonly mediaIndex?: SessionMediaIndex;
  /** Notification inbox summaries (the daemon's shared notification catalog). */
  publishNotificationSummary?(event: SessionNotificationSummaryEvent): void;
  publishGlobal(event: { type: "session.created"; session: ClientSession } | { type: "status.update"; status: SessionStatus } | { type: "activity.update"; activity: { sessionId: string; phase: "active" | "idle" | "error"; label: string; at: string } } | { type: "session.name"; sessionId: string; name?: string } | SessionAttentionEvent): void;
  currentSeq(sessionId: string): number;
  /** Whether a browser watches the Chat: its host is never idle (legacy idle unload). */
  hasSessionSubscribers?(sessionId: string): boolean;
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
  /**
   * The gated operations the host names in its ready message (Workbench `chat-session.ts` `CAPABILITIES`, names from
   * `CHAT_CAPABILITY_LABELS`); none when it reports no list. Each one is refused and its control hidden until named.
   */
  capabilities: ChatCapability[] = [];
  /** Skills and prompts the host's Pi packages contributed (`resources_discover`), named in its ready message. */
  contributed: DurableContributedResources = { skillPaths: [], promptPaths: [] };
  /** The revision folder the host's ready message names, if any. */
  revision: string | undefined;
  /** Set while the family runs older host code than new Chats get (Phase C3): both revisions, short. */
  pin: { revision: string; current: string } | undefined;
  /** Seamless upgrade B: the daemon restarts this pinned family on current code at its next safe moment. */
  upgradePending = false;
  /** Resolves when the host process has exited, so its store lock is released. */
  readonly exited: Promise<void>;
  #markExited!: () => void;
  #next = 1;
  #exited: Error | undefined;
  readonly #pending = new Map<number, { resolve: (reply: { result: unknown; seq: number }) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly process: DurableHostProcess,
    onEvent: (event: SessionUiEvent | HostEvent) => void,
    watermark: () => number,
    onExit: (error: Error) => void,
    onError: (error: Error) => void = () => undefined,
  ) {
    this.exited = new Promise((resolve) => { this.#markExited = resolve; });
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { markReady = resolve; failReady = reject; });
    process.on("message", (message) => {
      if (!isRecord(message)) return;
      if (isRecord(message["ready"])) {
        const protocol = message["ready"]["protocol"];
        const capabilities = message["ready"]["capabilities"];
        if (Array.isArray(capabilities)) this.capabilities = capabilities.filter(isChatCapability);
        this.contributed = parseContributedResources(message["ready"]["resources"]);
        const revision = message["ready"]["revision"];
        if (typeof revision === "string") this.revision = revision;
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
    // An unhandled ChildProcess "error" (a failed kill, a closing channel) would take the whole daemon down.
    process.on("error", onError);
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

  /** The entry the host runs from and the one new families get (a launchd host only). */
  get code(): DurableHostProcess["code"] {
    return this.process.code;
  }

  /** Leave a host the daemon does not own running (see `DurableHostProcess.detach`); false for a forked host. */
  detach(): boolean {
    if (this.process.detach === undefined) return false;
    this.process.detach();
    return true;
  }

  async request(method: string, params?: object): Promise<{ result: unknown; seq: number }> {
    await this.ready;
    if (this.#exited !== undefined) throw this.#exited;
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      // The host can die between the check above and this send: its closed channel fails only this request.
      this.process.send({ id, method, ...(params === undefined ? {} : { params }) }, (error) => {
        if (!(error instanceof Error) || !this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  /**
   * Graceful close: the host closes its store and exits. A host that does not exit within `graceMs` gets SIGTERM (it
   * bounds its own close and exits non-zero); one still alive `graceMs` later, as when its close joins work that
   * ignores cancellation, gets SIGKILL and reopens with that work interrupted. Resolves only once the process is gone,
   * so a host opened next for the same store never meets its lock. `end`: the owner ends the Chat, and the host cancels
   * the family's background jobs first; any other close (restart, idle, upgrade) leaves them running. `upgrade`: Upgrade
   * now's close, which the host records as an `upgrade-restart`.
   */
  async close(graceMs: number, end = false, upgrade = false): Promise<void> {
    if (!this.alive) return;
    const terminate = setTimeout(() => { this.process.kill("SIGTERM"); }, graceMs);
    const kill = setTimeout(() => { this.process.kill("SIGKILL"); }, 2 * graceMs);
    try {
      await this.request("close", end ? { end } : upgrade ? { reason: "upgrade" } : undefined);
    } catch {
      // Already gone, or terminated by the timers.
    }
    try {
      await this.exited;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
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
    /**
     * AGENTS.md, APPEND_SYSTEM.md, skills and prompts for a workspace, from Pi's loader, with those the host's packages
     * contributed; sent to each host as it opens.
     */
    resources?: (cwd: string, contributed?: DurableContributedResources) => Promise<DurableChatResourceSet>;
    /** PI WEB config, for the attachment folder of a save request that names none (as legacy Chats). */
    config?: { read(): { effectiveConfig: PiWebConfig } | Promise<{ effectiveConfig: PiWebConfig }> };
    /** Pi's prompt cache-miss notices, as legacy Chats show them: Pi's `showCacheMissNotices` for a workspace, and prices. */
    cacheMissNotices?: { enabled(cwd: string): boolean; models: ModelPriceSource };
    /**
     * The daemon's unread catalog (the legacy service's, shared): committed run starts and ends, and a host exit.
     * Turn ends of a Durable Chat mark it unread exactly as a legacy Chat's do.
     */
    unread?: (sessionId: string, cwd: string, change: "active" | "idle" | "closed") => Promise<void>;
    /** The daemon's notification store (shared with legacy Chats): each host's package warnings, per Chat. */
    notifications?: SessionNotificationStore;
    /** The daemon's Workstream launch records (shared with legacy Chats): a launch token names the Chat it created. */
    launches?: Pick<WorkstreamLaunchStore, "reserve" | "confirm" | "lookup">;
    logger?: { warn(object: object, message: string): void; info?(object: object, message: string): void };
    /** The project-scoped targets of spawn_session (legacy `spawnSessions`); without it, hosts are told spawning is off. */
    spawnTargets?: SpawnTargetResolver;
    /** Stop's wait before SIGTERM, and again before SIGKILL; default 5 s. */
    closeGraceMs?: number;
    /** The clock of the idle close; tests inject one. */
    now?: () => number;
    /**
     * Seamless upgrade B (`PI_WEB_DURABLE_AUTO_UPGRADE=1`, default off): a pinned family that may move is "upgrade
     * pending" and restarts on current code by itself (Upgrade now) once only restart-surviving work remains.
     */
    autoUpgrade?: boolean;
  }) {
    this.#idleSweep = setInterval(() => { void this.closeIdleHosts().then(() => this.upgradePendingHosts()); }, IDLE_HOST_SWEEP_MS);
    this.#idleSweep.unref();
  }

  readonly #idleSweep: NodeJS.Timeout;
  /** Chats whose pending automatic upgrade the owner cancelled. ponytail: for the daemon's life; persist if a restart should keep it. */
  readonly #upgradeDeclined = new Set<string>();
  /** Ordered restarts in progress, by Chat (see `#upgradeOnce`). */
  readonly #upgrades = new Map<string, Promise<void>>();
  /** Chats an automatic upgrade is checking or restarting. */
  readonly #autoUpgrading = new Set<string>();
  /** When each connected family last opened or sent an event: its idle window starts there. */
  readonly #lastActive = new Map<string, number>();

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Each Chat's paid turns and context resets, from its last transcript read and later events, for live notices. */
  readonly #cacheScan = new Map<string, unknown[]>();
  /** The notification generation of each Chat's current host: a new host's inbox starts over. */
  readonly #notificationGenerations = new Map<string, SessionNotificationGeneration>();
  /** Chats with a title request in flight. */
  readonly #titling = new Set<string>();

  readonly #skills = new Map<string, DurableChatResourceSet["skillList"]>();
  readonly #templates = new Map<string, NonNullable<DurableChatResourceSet["promptList"]>>();
  /** Last reported capabilities per Chat, so its listing gates controls before its host is asked again. */
  readonly #capabilities = new Map<string, ChatCapability[]>();
  /** spawn_session requests by ID, so a repeated request answers with the Chat it started instead of another. */
  readonly #spawns = new Map<string, Promise<SpawnSessionResult>>();

  owns(sessionId: string): boolean {
    return this.deps.locator.durable(sessionId) !== undefined;
  }

  /**
   * A Workstream launch token is reserved, naming the Chat ID it is for, before the Chat exists, and bound to it once
   * its host runs. A confirmed token is single-use, as for legacy Chats (look it up instead). A launch that stopped in
   * between (a failed confirmation, a host that never opened, a daemon that died) stays recoverable: lookup finds its
   * Chat, and a retry with the same token in the same workspace finishes that Chat instead of creating another.
   */
  async start(cwd: string, startupToken?: string): Promise<ClientSession> {
    const launch = startupToken !== undefined && isWorkstreamLaunchToken(startupToken) ? startupToken : undefined;
    const launches = this.deps.launches;
    const location = canonicalizeStoredCwd(cwd);
    let id: string = randomUUID();
    if (launch !== undefined) {
      if (launches === undefined) throw new Error("Workstream launch tracking is unavailable");
      try {
        await launches.reserve(launch, location, id);
      } catch (error) {
        const reserved = await launches.lookup(launch);
        if (reserved?.status !== "pending" || reserved.sessionId === undefined || reserved.cwd !== location) throw error;
        id = reserved.sessionId;
      }
    }
    const existing = this.deps.locator.durable(id);
    const record = existing ?? this.deps.locator.create(cwd, id);
    try {
      await this.#connection(record);
    } catch (error) {
      // Only a record this call made: a recovered Chat may already be in use.
      if (existing === undefined) this.deps.locator.remove(record.id);
      throw error;
    }
    if (launch !== undefined) await launches?.confirm(launch, location, record.id);
    return { ...this.info(this.deps.locator.durable(record.id) ?? record), ...(startupToken === undefined ? {} : { startupToken }) };
  }

  /**
   * The Durable Chat a launch token created in this workspace, or reserved and created before its confirmation was
   * lost; undefined when it names none (ask legacy Chats). Never opens the Chat's host.
   */
  async lookupWorkstreamLaunch(token: string, cwd: string): Promise<{ status: "found"; sessionId: string; cwd: string } | undefined> {
    const record = await this.deps.launches?.lookup(token);
    if (record?.sessionId === undefined || !this.owns(record.sessionId) || !cwdPathsEqual(record.cwd, cwd)) return undefined;
    return { status: "found", sessionId: record.sessionId, cwd: record.cwd };
  }

  /** The Chat's retained notifications; undefined when its host has not run in this daemon (an empty inbox). */
  notificationInbox(ref: SessionRouteRef): SessionNotificationInboxSnapshot | undefined {
    return this.#inbox(ref, (store, cwd) => ({ snapshot: store.inboxSnapshot(ref.id, cwd), mutations: [] }));
  }

  dismissNotification(ref: SessionRouteRef, request: Omit<SessionNotificationDismissRequest, "cwd">): SessionNotificationInboxSnapshot | undefined {
    return this.#inbox(ref, (store, cwd) => store.dismissNotification(ref.id, cwd, request.daemonInstanceId, request.notificationId));
  }

  dismissAllNotifications(ref: SessionRouteRef, request: Omit<SessionNotificationDismissAllRequest, "cwd">): SessionNotificationInboxSnapshot | undefined {
    return this.#inbox(ref, (store, cwd) => store.dismissAll(ref.id, cwd, request.daemonInstanceId, request.throughOrder, request.throughOverflowWatermark));
  }

  #inbox(ref: SessionRouteRef, operate: (store: SessionNotificationStore, cwd: string) => { snapshot: SessionNotificationInboxSnapshot; mutations: SessionNotificationMutation[] }): SessionNotificationInboxSnapshot | undefined {
    const record = this.#record(ref);
    const store = this.deps.notifications;
    if (store === undefined || !this.#notificationGenerations.has(record.id)) return undefined;
    const { snapshot, mutations } = operate(store, canonicalizeStoredCwd(record.cwd));
    this.#publishNotifications(mutations);
    return snapshot;
  }

  #publishNotifications(mutations: readonly SessionNotificationMutation[]): void {
    for (const mutation of mutations) {
      this.deps.events.publish(mutation.sessionId, mutation.inboxEvent);
      this.deps.events.publishNotificationSummary?.(mutation.summaryEvent);
    }
  }

  info(record: DurableChatRecord): ClientSession {
    return {
      id: record.id,
      cwd: record.cwd,
      // Not a filesystem path: browsers never receive store locations.
      path: `durable:${record.id}`,
      persisted: true,
      name: record.name !== undefined ? `Durable · ${record.name}` : record.firstMessage === "" ? "Durable Chat" : `Durable · ${record.firstMessage.slice(0, 60)}`,
      created: record.created,
      modified: record.modified,
      messageCount: record.messageCount,
      firstMessage: record.firstMessage,
      capabilities: this.#capabilities.get(record.id) ?? [],
    };
  }

  #record(ref: SessionRouteRef): DurableChatRecord {
    const record = this.deps.locator.durable(ref.id);
    if (record?.cwd !== ref.cwd) throw new Error("Session not found");
    return record;
  }

  async #unread(record: DurableChatRecord, change: "active" | "idle" | "closed"): Promise<void> {
    await this.deps.unread?.(record.id, record.cwd, change).catch((error: unknown) => {
      this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat unread state failed to update");
    });
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
    return pageMessagesAtSafeBoundary(this.#withCacheMissNotices(ref, hostTranscript(result).messages).map(displayPromptMessage), page);
  }

  async status(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    const connection = await this.#for(ref);
    const { result } = await connection.request("status");
    return { ...browserStatus(hostStatus(result), connection), sessionId: ref.id };
  }

  /** An image of the Chat's transcript (or its in-flight answer), bound to the Chat as a legacy Chat's media are. */
  async media(ref: SessionRouteRef, mediaId: string): Promise<SessionMedia | undefined> {
    const index = this.deps.events.mediaIndex;
    if (index === undefined) return undefined;
    const scope = { id: ref.id, cwd: ref.cwd };
    const cached = index.get(scope, mediaId);
    if (cached !== undefined) return cached;
    const { result } = await (await this.#for(ref)).request("transcript");
    const transcript = hostTranscript(result);
    return index.find(scope, mediaId, [transcript.messages, transcript.partial]);
  }

  async streamSnapshot(ref: SessionRouteRef): Promise<SessionStreamSnapshot> {
    const { result, seq } = await (await this.#for(ref)).request("transcript");
    return { seq, partial: hostTranscript(result).partial };
  }

  async transcriptSnapshot(ref: SessionRouteRef, page?: { limit?: number }): Promise<SessionTranscriptSnapshot> {
    const connection = await this.#for(ref);
    const { result, seq } = await connection.request("transcript");
    const transcript = hostTranscript(result);
    return { seq, partial: transcript.partial, page: pageMessagesAtSafeBoundary(this.#withCacheMissNotices(ref, transcript.messages).map(displayPromptMessage), { limit: page?.limit ?? 100 }), status: { ...browserStatus(transcript.status, connection), sessionId: ref.id } };
  }

  /** History with Pi's cache-miss notices re-derived onto the assistant turns that paid for them (legacy `historyWithCacheMissNotices`). */
  #withCacheMissNotices(ref: SessionRouteRef, messages: unknown[]): unknown[] {
    const notices = this.deps.cacheMissNotices;
    if (notices === undefined) return messages;
    // Every event before this reply is published, so later message.end events extend exactly this history.
    this.#cacheScan.set(ref.id, cacheScanEntries(messages, "usage"));
    if (!notices.enabled(ref.cwd)) return messages;
    const byEntryId = cacheMissNoticesByEntryId(cacheScanEntries(messages), notices.models);
    if (byEntryId.size === 0) return messages;
    return messages.map((message) => {
      const cacheMissNotice = isRecord(message) && typeof message["entryId"] === "string" ? byEntryId.get(message["entryId"]) : undefined;
      return cacheMissNotice === undefined || !isRecord(message) ? message : { ...message, cacheMissNotice };
    });
  }

  /** A just-ended message with its live cache-miss notice; the scan history then includes it. */
  #liveCacheMissNotice(sessionId: string, cwd: string, message: unknown): unknown {
    const notices = this.deps.cacheMissNotices;
    if (notices === undefined) return message;
    const history = this.#cacheScan.get(sessionId) ?? [];
    const cacheMissNotice = isRecord(message) && message["role"] === "assistant" && notices.enabled(cwd) ? liveCacheMissNotice(history, message, notices.models) : undefined;
    // ponytail: grows by one small usage record per paid turn while the daemon runs; trim after compaction if it matters.
    this.#cacheScan.set(sessionId, [...history, ...cacheScanEntries([message], "usage")]);
    return cacheMissNotice === undefined || !isRecord(message) ? message : { ...message, cacheMissNotice };
  }

  /**
   * Resolves once the host committed the input; a queued input shows in status until it is placed. The client's
   * operation ID makes a retried request the same input; `/skill:name` expands as in a legacy Chat.
   */
  async prompt(ref: SessionRouteRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown, options?: { operationId?: string }): Promise<void> {
    const operationId = options?.operationId;
    if (typeof text !== "string") throw new Error("text field must be a non-empty string");
    if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") throw new Error("streamingBehavior must be steer or followUp");
    // As a legacy Chat: images go inline (resized by Pi), named [PIC_n] in a trailing legend unless a command takes them.
    const parsed = parsePromptAttachments(attachments, { enforceInlineSizeLimit: false });
    if (text.trim() === "" && parsed.length === 0) throw new Error("text field must be a non-empty string");
    const connection = await this.#for(ref);
    if (parsed.length > 0) this.#require(connection, "attachments");
    const explicit = hasExplicitPromptImageReference(attachments);
    const images = (await attachmentsToInlineImages(parsed, explicit)).map((entry) => entry.image);
    const templates = this.#templates.get(ref.id) ?? [];
    const command = text.trim();
    const references = parsed.map((attachment) => attachment.reference);
    // A leading template takes its arguments raw (no inline skills, no image tokens), as Pi expands it.
    const template = isTemplateCommand(command, templates);
    const body = template ? (explicit ? removeImageReferenceTokensFromText(command, references) : command).trim() : text;
    const skilled = template ? body : expandSkills(body, this.#skills.get(ref.id) ?? []);
    const expanded = expandPromptTemplate(skilled, templates);
    const providerText = !explicit || template ? expanded : appendInlineImageReferenceMapping(expanded, references);
    this.#maybeTitle(ref, template ? body : text, connection);
    await connection.request("prompt", {
      operationId: operationId ?? randomUUID(), text: providerText,
      ...(streamingBehavior === undefined ? {} : { mode: streamingBehavior }),
      ...(images.length === 0 ? {} : {
        images,
        attachments: parsed.map((attachment) => ({ reference: attachment.reference, mimeType: attachment.mimeType, ...(attachment.name === undefined ? {} : { name: attachment.name }) })),
      }),
    });
  }

  /** Files saved into the Chat's workspace, exactly as a legacy Chat saves them (the prompt then names their paths). */
  async saveAttachments(ref: SessionRouteRef, attachments: unknown, folder?: string): Promise<SavedPromptAttachment[]> {
    const parsed = parsePromptAttachments(attachments, { enforceInlineSizeLimit: false, allowFileAttachments: true });
    if (parsed.length === 0) return [];
    this.#require(await this.#for(ref), "attachments");
    const globalConfig = this.deps.config === undefined ? {} : (await this.deps.config.read()).effectiveConfig;
    const effectiveFolder = folder ?? (await loadEffectiveProjectAttachmentsConfig(ref.cwd, globalConfig)).defaultFolder;
    return saveAttachmentsToWorkspace(ref.cwd, parsed, effectiveFolder === undefined ? {} : { folder: effectiveFolder });
  }

  /** `!cmd` / `!!cmd` in the Chat's workspace; the host streams shell events and records the result. */
  async shell(ref: SessionRouteRef, text: string): Promise<void> {
    const connection = await this.#for(ref);
    this.#require(connection, "shell");
    await connection.request("shell", { text });
  }

  async availableThinkingLevels(ref: SessionRouteRef): Promise<ClientThinkingLevel[]> {
    const connection = await this.#for(ref);
    if (!connection.capabilities.includes("thinking")) return [];
    const { result } = await connection.request("thinkingLevels");
    return Array.isArray(result) ? result.filter((level): level is ClientThinkingLevel => typeof level === "string") : [];
  }

  async setThinkingLevel(ref: SessionRouteRef, level: string): Promise<ClientSessionStatus> {
    const connection = await this.#for(ref);
    this.#require(connection, "thinking");
    await connection.request("setThinkingLevel", { level });
    return this.status(ref);
  }

  async cycleThinkingLevel(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    const connection = await this.#for(ref);
    this.#require(connection, "thinking");
    await connection.request("cycleThinkingLevel");
    return this.status(ref);
  }

  /** Remove, recall (`edit`) or toggle a queued message, against the queue the browser showed (as legacy Chats). */
  async mutateQueueMessage(ref: SessionRouteRef, mutation: SessionQueueMessageMutation): Promise<ClientSessionStatus> {
    const connection = await this.#for(ref);
    this.#require(connection, "queue.edit");
    const queued = hostStatus((await connection.request("status")).result).queuedMessages;
    const current = queued.map(displayQueuedMessage);
    if (current.length !== mutation.expectedQueue.length || current.some((entry, index) => {
      const expected = mutation.expectedQueue[index];
      if (expected === undefined) return true;
      return entry.kind !== expected.kind || entry.text !== expected.text
        || (mutation.action === "edit" && index === mutation.index && (entry.hasAttachments === true) !== (expected.hasAttachments === true));
    })) throw new Error("Queued messages changed; refresh the queue and try again");
    if (mutation.index >= current.length) throw new Error("Invalid queue index");
    await this.#mutateQueue(connection, mutation.action === "edit" ? "recall" : mutation.action, mutation.index, queued);
    return this.status(ref);
  }

  /** Send a queued follow-up at the next steering boundary; an unknown or already-steering message changes nothing. */
  async promoteQueuedMessage(ref: SessionRouteRef, target: { kind: string; text: string }): Promise<ClientSessionStatus> {
    const connection = await this.#for(ref);
    this.#require(connection, "queue.promote");
    const queued = hostStatus((await connection.request("status")).result).queuedMessages;
    const index = queued.map(displayQueuedMessage).findIndex((message) => message.kind === target.kind && message.text === target.text);
    if (index !== -1 && queued[index]?.kind === "followUp") await this.#mutateQueue(connection, "promote", index, queued);
    return this.status(ref);
  }

  async promoteAllQueuedMessages(ref: SessionRouteRef): Promise<ClientSessionStatus> {
    const connection = await this.#for(ref);
    this.#require(connection, "queue.promote");
    const queued = hostStatus((await connection.request("status")).result).queuedMessages;
    const index = queued.findIndex((message) => message.kind === "followUp");
    if (index !== -1) await this.#mutateQueue(connection, "promoteAll", index, queued);
    return this.status(ref);
  }

  /** The host withdraws and re-admits durably, against the exact queued IDs this request saw. */
  async #mutateQueue(connection: DurableHostConnection, action: string, index: number, queued: readonly QueuedSessionMessage[]): Promise<void> {
    const expected = queued.map((message) => (isRecord(message) ? message["id"] : undefined));
    await connection.request("mutateQueue", { editId: randomUUID(), action, index, expected });
  }

  #require(connection: DurableHostConnection, capability: ChatCapability): void {
    if (!connection.capabilities.includes(capability)) throw new DurableChatUnavailable(CHAT_CAPABILITY_LABELS[capability]);
  }

  /**
   * Slash commands of a Durable Chat: /name, /session, /compact where the host supports it, Working Mode, the host's
   * commands (its own, like /quota-check, and the installed Pi packages'), prompt templates and the workspace's skills.
   */
  async commands(ref: SessionRouteRef): Promise<ClientCommand[]> {
    const connection = await this.#for(ref);
    const hostCommands = await this.#hostCommands(ref);
    return [
      ...(connection.capabilities.includes("compact") ? [{ name: "compact", description: "Manually compact session context", argumentHint: "[instructions]", source: "builtin" as const }] : []),
      ...BUILTIN_COMMANDS.filter((command) => command.name === "name" || command.name === "session" || (command.name === "tree" && connection.capabilities.includes("tree"))),
      { name: "mode", description: "Choose Working Mode guidance for the next prompt; /mode send delivers it now; /mode unalign clears the alignment", source: "extension" as const },
      ...hostCommands.map((command) => ({ ...command, source: "extension" as const })),
      ...(this.#templates.get(ref.id) ?? []).map((template) => ({
        name: template.name, source: "prompt" as const,
        ...(template.description === undefined ? {} : { description: template.description }),
        ...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
      })),
      ...(this.#skills.get(ref.id) ?? []).map((skill) => ({ name: `skill:${skill.name}`, ...(skill.description === undefined ? {} : { description: skill.description }), source: "skill" as const })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * `/name`, `/session`, `/compact` and `/mode …` as listed; `/skill:…` and templates are prompts; every other command
   * goes to the host's one dispatcher under a fresh operation id: its own (`/quota-check`), an installed Pi package's,
   * or a visible refusal with the host's reason.
   */
  async runCommand(ref: SessionRouteRef, text: string): Promise<ClientCommandResult> {
    const trimmed = text.trim();
    const name = /^\/(\S+)/.exec(trimmed)?.[1] ?? "";
    const rest = trimmed.slice(name.length + 1).trim();
    if (name === "name") return this.#name(ref, rest);
    const checkpointTitle = CHECKPOINT_TITLE_COMMAND.exec(trimmed)?.[1];
    if (checkpointTitle !== undefined) {
      // A Workstream checkpoint's title for its Chat (the Workbench client sends it): no turn, as in a legacy Chat.
      const title = checkpointTitle.replace(/\s+/g, " ").trim().slice(0, CHECKPOINT_SESSION_TITLE_MAX_LENGTH).trim();
      const current = this.#record(ref).name;
      if (title !== "" && title !== current) this.#applyGeneratedName(ref.id, title, "checkpoint", current);
      return { type: "done" };
    }
    if (name === "session") return { type: "done", message: await this.#stats(ref) };
    if (name === "mode") {
      const { result } = await (await this.#for(ref)).request("mode", { args: trimmed.slice("/mode".length).trim() });
      return commandResult(result);
    }
    if (name === "compact") {
      const connection = await this.#for(ref);
      if (!connection.capabilities.includes("compact")) return { type: "unsupported", message: "/compact is not available in this Durable Chat's host" };
      const instructions = trimmed.slice("/compact".length).trim();
      const { result } = await connection.request("compact", instructions === "" ? {} : { instructions });
      return commandResult(result);
    }
    if (name === "tree") {
      const connection = await this.#for(ref);
      if (!connection.capabilities.includes("tree")) return { type: "unsupported", message: "/tree is not available in Durable Chats yet" };
      return hostTree((await connection.request("tree")).result);
    }
    if (name.startsWith("skill:") || isTemplateCommand(trimmed, this.#templates.get(ref.id) ?? [])) {
      await this.prompt(ref, trimmed);
      return { type: "done" };
    }
    const connection = await this.#for(ref);
    const reply = await connection.request("command", { name, args: rest, operationId: randomUUID() }).catch((error: unknown) => {
      // An older host without the dispatcher runs no commands.
      if (error instanceof Error && error.message === "Unknown method command") return undefined;
      throw error;
    });
    if (reply === undefined) return { type: "unsupported", message: `/${name} is not available in Durable Chats yet` };
    return commandResult(reply.result);
  }

  /**
   * Continue the Chat from an earlier entry: the host selects or forks the branch, revision-checked against the leaf
   * the browser showed and refused while work is pending. Branch summaries are not offered (unused in legacy Chats).
   */
  async navigateTree(ref: SessionRouteRef, request: ClientSessionTreeNavigateRequest): Promise<ClientSessionTreeNavigateResult> {
    const connection = await this.#for(ref);
    this.#require(connection, "tree");
    if (request.summary.mode !== "none") this.#require(connection, "tree.summary");
    const { result } = await connection.request("navigate", {
      targetId: request.targetId, expectedLeafId: request.expectedLeafId, ...(request.retainCheckpoint === true ? { retainCheckpoint: true } : {}),
    });
    const editorText = isRecord(result) && typeof result["editorText"] === "string" ? stripInlineImageReferenceMapping(result["editorText"]) : undefined;
    return { cancelled: false, ...(editorText === undefined ? {} : { editorText }) };
  }

  /** The commands the host offers; a host without any (an older build) offers none. */
  async #hostCommands(ref: SessionRouteRef): Promise<{ name: string; description?: string }[]> {
    const result = await (await this.#for(ref)).request("commands").then((reply) => reply.result, () => []);
    return Array.isArray(result)
      ? result.filter(isRecord).flatMap((command) => typeof command["name"] === "string"
        ? [{ name: command["name"], ...(typeof command["description"] === "string" ? { description: command["description"] } : {}) }]
        : [])
      : [];
  }

  #name(ref: SessionRouteRef, name: string): ClientCommandResult {
    if (name === "") return { type: "unsupported", message: "Usage: /name <session name>" };
    this.#record(ref);
    return { type: "done", message: `Session named: ${name}`, session: this.#setName(ref.id, name, "manual") };
  }

  #setName(sessionId: string, name: string, nameSource: NonNullable<DurableChatRecord["nameSource"]>): ClientSession {
    this.deps.locator.update(sessionId, { name, nameSource });
    const record = this.deps.locator.durable(sessionId);
    if (record === undefined) throw new Error("Session not found");
    const session = this.info(record);
    const event = { type: "session.name" as const, sessionId, ...(session.name === undefined ? {} : { name: session.name }) };
    this.deps.events.publish(sessionId, event);
    this.deps.events.publishGlobal(event);
    return session;
  }

  /** A generated title (legacy `applyGeneratedSessionName`): only over the name it was made for, never over the owner's. */
  #applyGeneratedName(sessionId: string, name: string | undefined, source: "auto" | "checkpoint", expectedName: string | undefined): void {
    const record = this.deps.locator.durable(sessionId);
    if (name === undefined || record === undefined || record.name !== expectedName) return;
    if (record.name !== undefined && (record.nameSource ?? "manual") === "manual") return;
    this.#setName(sessionId, name, source);
  }

  /**
   * Legacy title rules for an untitled Chat: its first prompt with title text gets a short title from the configured
   * naming model (default the Chat's own), asked through the Chat's host outside the conversation; on failure, the
   * first words of the prompt as the host's redactor masks it (whole, before formatting cuts a secret into pieces no
   * redactor knows), or no title when the host cannot redact. ponytail: no goal title after five prompts yet (legacy
   * `auto-final`).
   */
  #maybeTitle(ref: SessionRouteRef, text: string, connection: DurableHostConnection): void {
    const record = this.#record(ref);
    const titleText = sessionTitleInput(text);
    if (record.name !== undefined || titleText === undefined || this.#titling.has(record.id)) return;
    if (record.firstMessage !== "" && sessionTitleInput(record.firstMessage) !== undefined) return;
    this.#titling.add(record.id);
    void (async () => {
      const naming = this.deps.config === undefined ? {} : (await this.deps.config.read()).effectiveConfig.sessionNaming ?? {};
      const model = naming.model === undefined ? undefined : parseModelSpec(naming.model);
      const { result } = await connection.request("complete", {
        systemPrompt: SESSION_TITLE_SYSTEM_PROMPT, prompt: shortSessionNamePrompt(titleText),
        maxTokens: naming.maxTokens ?? 24, reasoning: naming.thinkingLevel ?? "minimal", timeoutMs: naming.timeoutMs ?? 10_000,
        ...(model === undefined ? {} : { model }),
      });
      return typeof result === "string" ? cleanSessionName(result) : undefined;
    })().catch((error: unknown) => {
      this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat naming failed; using the first-message fallback");
      return undefined;
    }).then(async (name) => name ?? fallbackSessionName((await connection.request("redact", { text: titleText })).result))
      .catch((error: unknown) => {
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat title fallback could not be redacted; leaving the Chat untitled");
        return undefined;
      })
      .then((name) => {
        this.#titling.delete(record.id);
        this.#applyGeneratedName(record.id, name, "auto", undefined);
      });
  }

  /** PI WEB's `/session` lines (`sessionCommandService.ts`), counted from the Chat's transcript and usage. */
  async #stats(ref: SessionRouteRef): Promise<string> {
    const { result } = await (await this.#for(ref)).request("transcript");
    const { messages, status } = hostTranscript(result);
    const role = (name: string) => messages.filter((message) => isRecord(message) && message["role"] === name);
    const toolCalls = role("assistant").flatMap((message): unknown[] => (isRecord(message) && Array.isArray(message["content"]) ? message["content"] : []))
      .filter((part) => isRecord(part) && part["type"] === "toolCall").length;
    return [
      `Session: ${ref.id}`,
      `Messages: ${String(messages.length)} (${String(role("user").length)} user, ${String(role("assistant").length)} assistant)`,
      `Tool calls: ${String(toolCalls)}`,
      `Tokens: ↑${String(status.tokens.input)} ↓${String(status.tokens.output)} total ${String(status.tokens.total)}`,
      `Cost: $${status.cost.toFixed(4)}`,
    ].join("\n");
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
    // The store's sets after this close, as a legacy Chat reminds: a partial send leaves its set open with the rest.
    const content = outcome === undefined ? "" : [renderAskUserAnswersText(outcome), renderOpenAsksReminder(store.pendingAsks(ref.id))].filter((part) => part !== "").join("\n\n");
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

  /**
   * End the Chat's host (Phase C3): it cancels the family's background jobs and closes its store in order, children
   * included, and a launchd host's job is unloaded.
   * Reaches the host an earlier daemon started too. The store keeps every admitted input and reopens paused on next use.
   */
  async stop(ref: SessionRouteRef): Promise<void> {
    await this.#end(ref.id, true);
  }

  /**
   * Stop-all: every family host, connected or only recorded by an earlier daemon, ends as `stop` ends one, and so does
   * every family with unfinished background jobs whose host is gone.
   */
  async stopAll(): Promise<void> {
    const recorded = this.deps.locator.all().filter((record) => record.host !== undefined).map((record) => record.id);
    await Promise.all([...new Set([...this.#connections.keys(), ...recorded, ...familiesWithBackgroundJobs()])].map((id) => this.#end(id, true)));
  }

  /**
   * Close a family's host in order: the connected one, else the launchd host the locator names. An `explicit` end (Chat
   * stop, stop-all) also cancels the family's background jobs: when no host is left to reach and the family still has
   * unfinished jobs, a one-off `endJobs` process cancels them; no host starts, so no undelivered completion wakes the
   * model. An idle close or an upgrade keeps the jobs.
   */
  async #end(sessionId: string, explicit = false): Promise<void> {
    const record = this.deps.locator.durable(sessionId);
    const pending = this.#connections.get(sessionId) ?? (record?.host === undefined ? undefined : this.#connection(record, true));
    this.#connections.delete(sessionId);
    const connection = await pending?.catch(() => undefined);
    if (connection === undefined && explicit && record !== undefined && familiesWithBackgroundJobs().has(sessionId)) {
      const child = this.deps.launch(record, join(this.deps.storesDir, record.storeId), { endJobs: true });
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`Cancelling the background jobs of Durable Chat ${sessionId} failed (exit ${String(code)})`)); });
      });
    }
    await connection?.close(this.deps.closeGraceMs ?? 5000, explicit);
  }

  /**
   * Close every family host idle for {@link IDLE_HOST_CLOSE_MS}: no event since, nothing running or waiting (see
   * `familyBusy`) and no browser watching, as legacy `unloadIdleSessions` unloads sessions. The next use reopens it, on
   * the current host code when the family was pinned and may move (see `hostMoveRefusal`).
   */
  async closeIdleHosts(): Promise<void> {
    const idle = (id: string) => this.#now() - (this.#lastActive.get(id) ?? 0) >= IDLE_HOST_CLOSE_MS && this.deps.events.hasSessionSubscribers?.(id) !== true;
    for (const [id, pending] of [...this.#connections]) {
      if (!idle(id)) continue;
      const connection = await pending.catch(() => undefined);
      const busy = connection === undefined ? "it is not open" : await connection.request("status").then(({ result }) => familyBusy(hostStatus(result)), () => "its status is unknown");
      // Re-checked after the await: work or a browser may have arrived meanwhile.
      if (busy !== undefined || !idle(id) || this.#connections.get(id) !== pending) continue;
      this.deps.logger?.info?.({ sessionId: id }, "Closing idle Durable Chat host");
      // A pinned family moves to the current code as it closes (seamless upgrade A): nothing runs, so nothing repeats.
      // The pin moves, not away: it keeps naming code that opened the store, so a daemon rolled back to older code
      // reopens the family on it and never on code older than the store.
      const upgrade = connection?.pin !== undefined && hostMoveRefusal(connection.code) === undefined ? connection.code?.current : undefined;
      const closed = await this.#end(id).then(() => true, (error: unknown) => { this.deps.logger?.warn({ sessionId: id, err: error }, "Durable Chat host did not close cleanly"); return false; });
      if (closed && upgrade !== undefined) this.deps.locator.setHostEntry(id, upgrade);
    }
  }

  /**
   * Move a pinned family to the host code new Chats get (Phase C3), on the owner's request. Never to older Pi Durable
   * code (after a roll back): it cannot read a store newer code opened, so the family stays on its host and pin.
   * - `quiet` (Upgrade host): refused unless the family is quiet; its host closes in order and the next one starts from
   *   the current revision folder at the next message.
   * - `now` (Upgrade now, seamless upgrade C): whatever runs, the host closes in order (`upgrade-restart`) and the new
   *   host starts at once and resumes, recovering as after any restart (see `upgradeRepeats`). If the new host does not
   *   start, the family goes back to its old pin and host, and the error says so.
   * - `cancel`: drop the pending automatic upgrade (B; see `upgradePendingHosts`).
   * shortcut (quiet): input arriving between the quiet check and the close waits, paused, for the next message.
   */
  async upgradeHost(ref: SessionRouteRef, mode: "quiet" | "now" | "cancel" = "quiet"): Promise<ClientSessionStatus> {
    const record = this.#record(ref);
    const connection = await this.#for(ref);
    // A second click while the family moves gets that upgrade's outcome, not another restart.
    const running = this.#upgrades.get(record.id);
    if (running !== undefined && mode !== "cancel") {
      await running;
      return this.status(ref);
    }
    const pin = connection.pin;
    if (mode === "cancel") {
      // Cancel a pending automatic upgrade (B): the family stays pinned until the owner asks.
      this.#upgradeDeclined.add(record.id);
      connection.upgradePending = false;
      return this.status(ref);
    }
    if (pin === undefined) return this.status(ref);
    const refusal = hostMoveRefusal(connection.code);
    if (refusal !== undefined) throw new Error(refusal);
    if (mode === "quiet") {
      const busy = familyBusy(hostStatus((await connection.request("status")).result));
      if (busy !== undefined) throw new Error(`This Chat cannot move to new host code while ${busy}; try again when it is quiet`);
      await this.#end(record.id);
      this.deps.locator.setHostEntry(record.id, connection.code?.current);
      return this.status(ref);
    }
    await this.#upgradeOnce(record, pin, connection.code?.current);
    return this.status(ref);
  }

  /** One ordered restart per family at a time, until its resume: a later request (a double click, B) joins it. */
  #upgradeOnce(record: DurableChatRecord, pin: { revision: string; current: string }, current: string | undefined): Promise<void> {
    let running = this.#upgrades.get(record.id);
    if (running === undefined) {
      running = this.#upgradeRestart(record, pin, current).finally(() => { this.#upgrades.delete(record.id); });
      this.#upgrades.set(record.id, running);
    }
    return running;
  }

  /**
   * Upgrade now's ordered restart: close (`upgrade`), move the pin to the current code, start the new host and resume
   * it; else roll back. Requests arriving meanwhile wait for the new host instead of starting a second one on the store.
   * Onto newer Pi Durable code, the closed store is copied first: a new host that fails after migrating it must not
   * leave the old code a store it cannot read, so the rollback reopens the copy.
   */
  async #upgradeRestart(record: DurableChatRecord, pin: { revision: string; current: string }, current: string | undefined): Promise<void> {
    const pinned = this.deps.locator.durable(record.id)?.hostEntry;
    this.deps.logger?.info?.({ sessionId: record.id, from: pin.revision, to: pin.current }, "upgrade-restart: restarting Durable Chat host on current code");
    const old = this.#connections.get(record.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = gate.then(() => {
      this.#connections.delete(record.id);
      return this.#connection(record);
    });
    held.catch(() => { if (this.#connections.get(record.id) === held) this.#connections.delete(record.id); });
    this.#connections.set(record.id, held);
    const storeDir = join(this.deps.storesDir, record.storeId);
    let snapshot: string | undefined;
    let connection: DurableHostConnection;
    try {
      await (await old?.catch(() => undefined))?.close(this.deps.closeGraceMs ?? 5000, false, true);
      if (newerDurable(current, pinned) && existsSync(storeDir)) snapshot = snapshotStore(storeDir);
      this.deps.locator.setHostEntry(record.id, current);
      release();
      connection = await held;
    } catch (error) {
      release();
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.logger?.warn({ sessionId: record.id, err: error }, "upgrade-restart: the new host did not start; rolling back to the old pin");
      if (snapshot !== undefined) {
        const failed = restoreStore(storeDir, snapshot);
        this.deps.logger?.warn({ sessionId: record.id, failed }, "upgrade-restart: restored the store from before the attempt; the attempted one is kept aside");
      }
      this.deps.locator.setHostEntry(record.id, pinned);
      if (this.#connections.get(record.id) === held) this.#connections.delete(record.id);
      const back = await this.#connection(record).then((restored) => this.#resume(restored)).then(() => "", (again: unknown) => ` It did not start there either (${again instanceof Error ? again.message : String(again)}); the next message tries again.`);
      throw new Error(`The new host code (${pin.current}) did not start: ${reason}. This Chat is back on its old host code (${pin.revision})${snapshot === undefined ? "" : ", with its store as before the attempt"}.${back}`, { cause: error });
    }
    if (snapshot !== undefined) rmSync(snapshot, { recursive: true, force: true });
    await this.#resume(connection);
  }

  /** Resume a host Upgrade now started; a host without `resume` (older code) stays paused until the next message. */
  async #resume(connection: DurableHostConnection): Promise<void> {
    await connection.request("resume", { reason: "upgrade-restart" }).catch((error: unknown) => {
      if (!(error instanceof Error && error.message === "Unknown method resume")) throw error;
      this.deps.logger?.warn({}, "upgrade-restart: this host code cannot resume by itself; it waits for the next message");
    });
  }

  /**
   * Seamless upgrade B: restart every upgrade-pending family whose only work left survives a restart (open questions,
   * background bash, watchers, Atelier Pages; see `restartSafe`). A running turn, queued input, a running tool or
   * children wait. Runs on each status the host publishes and on the idle sweep. A failed start rolls back (as Upgrade
   * now) and leaves the family pinned, with a notice in its inbox.
   */
  async upgradePendingHosts(only?: string): Promise<void> {
    for (const [id, pending] of [...this.#connections]) {
      if ((only !== undefined && id !== only) || this.#autoUpgrading.has(id)) continue;
      this.#autoUpgrading.add(id);
      try {
        const connection = await pending.catch(() => undefined);
        const record = this.deps.locator.durable(id);
        const pin = connection?.pin;
        if (connection?.upgradePending !== true || pin === undefined || record === undefined || this.#connections.get(id) !== pending) continue;
        const status = await connection.request("status").then(({ result }) => hostStatus(result), () => undefined);
        if (status === undefined || !restartSafe(status) || this.#upgradeDeclined.has(id) || this.#connections.get(id) !== pending) continue;
        this.deps.logger?.info?.({ sessionId: id }, "upgrade-restart: automatic upgrade at a safe moment");
        await this.#upgradeOnce(record, pin, connection.code?.current).catch((error: unknown) => {
          this.deps.logger?.warn({ sessionId: id, err: error }, "upgrade-restart: automatic upgrade failed");
          this.#upgradeDeclined.add(id);
          const generation = this.#notificationGenerations.get(id);
          if (generation !== undefined) this.#publishNotifications(this.deps.notifications?.addNotification(generation, error instanceof Error ? error.message : String(error), "warning").mutations ?? []);
        });
      } finally {
        this.#autoUpgrading.delete(id);
      }
    }
  }

  /**
   * The daemon is going away: a forked host closes its store (admitted work reopens paused); a launchd host is only
   * detached and keeps running for the next daemon.
   */
  async dispose(): Promise<void> {
    clearInterval(this.#idleSweep);
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map(async (pending) => {
      const connection = await pending.catch(() => undefined);
      if (connection?.detach() === false) await connection.close(this.deps.closeGraceMs ?? 5000);
    }));
  }

  /** After a daemon restart: reconnect to every family host the locator names that still runs; never starts one. */
  async reattach(): Promise<void> {
    await Promise.all(this.deps.locator.all().filter((record) => record.host !== undefined).map((record) => this.#connection(record, true).catch(() => undefined)));
  }

  #for(ref: SessionRouteRef): Promise<DurableHostConnection> {
    return this.#connection(this.#record(ref));
  }

  #connection(record: DurableChatRecord, attachOnly = false): Promise<DurableHostConnection> {
    const existing = this.#connections.get(record.id);
    if (existing !== undefined) return existing;
    const storeDir = join(this.deps.storesDir, record.storeId);
    mkdirSync(this.deps.storesDir, { recursive: true, mode: 0o700 });
    // A new host starts its packages again, and with them their notices: its inbox starts over.
    const notifications = this.deps.notifications?.registerSession(record.id, canonicalizeStoredCwd(record.cwd));
    if (notifications !== undefined) {
      this.#notificationGenerations.set(record.id, notifications.generation);
      this.#publishNotifications(notifications.mutations);
    }
    const host = attachOnly ? this.deps.launch(record, storeDir, { attachOnly }) : this.deps.launch(record, storeDir);
    this.#lastActive.set(record.id, this.#now());
    const connection = new DurableHostConnection(
      host,
      (event) => { this.#onEvent(record.id, event, connection); },
      () => this.deps.events.currentSeq(record.id),
      (error) => {
        // Only this host's entry: during Upgrade now the map already holds the handover to the next host.
        if (this.#connections.get(record.id) === opened) this.#connections.delete(record.id);
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat host exited");
        void this.#unread(record, "closed");
        this.deps.events.publish(record.id, { type: "agent.end" });
      },
      (error) => { this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat host process error"); },
    );
    const opened = connection.ready.then(async () => {
      this.#capabilities.set(record.id, connection.capabilities);
      connection.pin = await hostPin(host.code, connection.revision);
      connection.upgradePending = this.deps.autoUpgrade === true && connection.pin !== undefined && !this.#upgradeDeclined.has(record.id) && hostMoveRefusal(host.code) === undefined;
      const loaded = await this.deps.resources?.(record.cwd, connection.contributed).catch((error: unknown) => {
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat resources failed to load");
        return undefined;
      });
      if (loaded !== undefined) {
        this.#skills.set(record.id, loaded.skillList);
        this.#templates.set(record.id, loaded.promptList ?? []);
        await connection.request("configure", { resources: loaded.resources, compaction: loaded.compaction, spawnSessions: this.deps.spawnTargets !== undefined });
      }
      return connection;
    });
    this.#connections.set(record.id, opened);
    opened.catch(() => { if (this.#connections.get(record.id) === opened) this.#connections.delete(record.id); });
    return opened;
  }

  /** A host's spawn_session request (legacy `spawnSession`), answered with the started Chat or the refusal. */
  async #answerSpawn(connection: DurableHostConnection, event: HostSpawnEvent): Promise<void> {
    let pending = this.#spawns.get(event.requestId);
    if (pending === undefined) {
      pending = this.#spawn(event);
      this.#spawns.set(event.requestId, pending);
      // ponytail: successful request IDs stay for the daemon's life (one small entry per spawned Chat).
      pending.catch(() => { this.#spawns.delete(event.requestId); });
    }
    const answer = await pending.then((result) => ({ result }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    await connection.request("spawned", { requestId: event.requestId, ...answer }).catch((error: unknown) => {
      this.deps.logger?.warn({ requestId: event.requestId, err: error }, "Durable Chat host did not take the spawn_session answer");
    });
  }

  async #spawn(event: HostSpawnEvent): Promise<SpawnSessionResult> {
    const targets = this.deps.spawnTargets;
    if (targets === undefined) throw new Error("Spawning sessions is disabled");
    const decision = await targets.resolveSpawnTarget(event.spawningCwd, event.cwd);
    if (!decision.allowed) throw spawnTargetError(decision);
    const model = event.model === undefined ? undefined : parseModelSpec(event.model);
    if (event.model !== undefined && model === undefined) throw new Error(`Invalid model "${event.model}": expected provider/model-id`);
    // The request ID is a launch token on disk: a daemon that died mid-spawn, or before its answer reached the host,
    // finds the Chat it started when the host asks again, instead of starting another (launch records persist).
    const launches = this.deps.launches;
    const token = launches === undefined ? undefined : `launch-spawn:${event.requestId}`;
    const earlier = token === undefined ? undefined : await launches?.lookup(token);
    const id = earlier?.status === "created" ? earlier.sessionId : (await this.start(decision.cwd, token)).id;
    const child = this.deps.locator.durable(id);
    if (child === undefined) throw new Error("The spawned Chat no longer exists");
    const ref = { id, cwd: child.cwd };
    try {
      if (model !== undefined) await this.setModel(ref, model.provider, model.modelId);
      // The host clamps the level to the Chat's model, as Pi does.
      if (event.thinkingLevel !== undefined) await (await this.#for(ref)).request("setThinkingLevel", { level: event.thinkingLevel });
      await this.prompt(ref, event.prompt, undefined, undefined, { operationId: `spawn-${event.requestId}` });
    } catch (error) {
      // A Chat a dead daemon started may already run: only a new one is undone.
      if (earlier !== undefined) throw error;
      // A refused model leaves no half-made Chat behind. shortcut: its empty store folder stays; prune if they pile up.
      await this.stop(ref);
      this.deps.locator.remove(ref.id);
      throw error;
    }
    const record = this.deps.locator.durable(ref.id);
    if (record !== undefined) this.deps.events.publishGlobal({ type: "session.created", session: this.info(record) });
    this.deps.logger?.info?.({ spawningCwd: event.spawningCwd, sessionId: ref.id, cwd: ref.cwd, promptLength: event.prompt.length }, "spawn_session started a new Durable Chat");
    const used = event.model ?? (await this.status(ref).then((status) => status.model, () => undefined).then((m) => (m?.provider === undefined || m.id === undefined ? undefined : `${m.provider}/${m.id}`)));
    return { sessionId: ref.id, cwd: ref.cwd, ...(used === undefined ? {} : { model: used }) };
  }

  #activity(sessionId: string, scope: { id: string; cwd: string }, phase: "active" | "idle" | "error", label: string): void {
    const activity = { sessionId, phase, label, at: new Date().toISOString() };
    this.deps.events.publish(sessionId, { type: "activity.update", activity }, scope);
    this.deps.events.publishGlobal({ type: "activity.update", activity });
  }

  #onEvent(sessionId: string, event: SessionUiEvent | HostEvent, connection: DurableHostConnection): void {
    const record = this.deps.locator.durable(sessionId);
    if (record === undefined) return;
    this.#lastActive.set(sessionId, this.#now());
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
    if (event.type === "durable.spawn") {
      if (typeof event.requestId !== "string" || typeof event.prompt !== "string") return;
      // Scoped by the workspace this daemon knows for the Chat, not the one the host names.
      void this.#answerSpawn(connection, { ...event, spawningCwd: record.cwd });
      return;
    }
    if (event.type === "durable.notification") {
      const generation = this.#notificationGenerations.get(sessionId);
      if (generation !== undefined) this.#publishNotifications(this.deps.notifications?.addNotification(generation, event.message, event.severity).mutations ?? []);
      return;
    }
    if (event.type === "status.update") {
      if (connection.upgradePending && restartSafe(event.status)) void this.upgradePendingHosts(sessionId);
      const status = { ...browserStatus(event.status, connection), sessionId };
      this.deps.events.publish(sessionId, { type: "status.update", status }, scope);
      this.deps.events.publishGlobal({ type: "status.update", status });
      if (status.messageCount !== undefined && status.messageCount !== record.messageCount) {
        this.deps.locator.update(sessionId, { messageCount: status.messageCount, modified: new Date().toISOString() });
      }
      return;
    }
    this.deps.events.publish(sessionId, event.type === "message.end" ? { ...event, message: displayPromptMessage(this.#liveCacheMissNotice(sessionId, record.cwd, event.message)) } : event, scope);
    if (event.type === "agent.start" || event.type === "agent.end") {
      const active = event.type === "agent.start";
      // The host emits these after the committed run start and end; a reopened store replays neither.
      void this.#unread(record, active ? "active" : "idle");
      this.#activity(sessionId, scope, active ? "active" : "idle", active ? "agent running" : "idle");
    }
    // Each tool phase by name, as legacy Activity shows it; a finished tool leaves the run active until it ends.
    if (event.type === "tool.start") this.#activity(sessionId, scope, "active", `running tool: ${event.toolName}`);
    if (event.type === "tool.end") this.#activity(sessionId, scope, event.isError ? "error" : "active", `${event.isError ? "tool failed" : "tool complete"}: ${event.toolName}`);
    if (event.type === "message.end" && record.firstMessage === "") {
      if (isRecord(event.message) && event.message["role"] === "user") this.deps.locator.update(sessionId, { firstMessage: textOf(event.message["content"]) });
    }
  }
}

function isTemplateCommand(text: string, templates: readonly { name: string }[]): boolean {
  const name = /^\/(\S+)/.exec(text)?.[1];
  return name !== undefined && templates.some((template) => template.name === name);
}

/** The browser's view of a user message: without PI WEB's trailing image legend (legacy `displayPromptMessage`). */
function displayPromptMessage(message: unknown): unknown {
  if (!isRecord(message) || message["role"] !== "user") return message;
  const content = message["content"];
  if (typeof content === "string") return { ...message, content: stripInlineImageReferenceMapping(content) };
  if (!Array.isArray(content)) return message;
  return { ...message, content: content.map((part: unknown) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? { ...part, text: stripInlineImageReferenceMapping(part["text"]) } : part) };
}

/** A queued message as the browser sees it: no host ID, no image legend. */
function displayQueuedMessage(message: QueuedSessionMessage): QueuedSessionMessage {
  return {
    kind: message.kind, text: stripInlineImageReferenceMapping(message.text),
    ...(message.hasAttachments === undefined ? {} : { hasAttachments: message.hasAttachments }),
    ...(message.attachmentCount === undefined ? {} : { attachmentCount: message.attachmentCount }),
  };
}

/** Host status for the browser: the host's capabilities gate its controls; without queue edits it says why. */
function browserStatus(status: HostTranscript["status"], connection: DurableHostConnection): HostTranscript["status"] & { capabilities: ChatCapability[] } {
  return {
    ...status,
    queuedMessages: status.queuedMessages.map(displayQueuedMessage),
    capabilities: connection.capabilities,
    ...(connection.pin === undefined ? {} : { durableHostPin: { ...connection.pin, repeats: upgradeRepeats(status), ...(connection.upgradePending ? { pending: true } : {}) } }),
    ...(connection.capabilities.includes("queue.edit") ? {} : { queueMessageActionsUnavailable: "Editing queued messages is not available in this Durable Chat host yet." }),
  };
}

const run = promisify(execFile);

/**
 * Chat families with background bash jobs not yet settled, read from the Workbench job registry as its host reads it
 * (pi-workbench extensions/background-bash/jobs.mjs): `<root>/<job>/job.json` names the family as `sessionId`, and an
 * `exit` record settles the job. The root comes from the same environment the daemon gives its hosts.
 * shortcut: a job whose runner vanished without an exit (a machine restart) counts until a host settles it once.
 */
function familiesWithBackgroundJobs(): Set<string> {
  const root = process.env["PI_BACKGROUND_BASH_ROOT"] ?? join(homedir(), ".pi-workbench", "background-bash", "jobs");
  const families = new Set<string>();
  for (const id of existsSync(root) ? readdirSync(root) : []) {
    if (existsSync(join(root, id, "exit"))) continue;
    try {
      const job: unknown = JSON.parse(readFileSync(join(root, id, "job.json"), "utf8"));
      if (isRecord(job) && typeof job["sessionId"] === "string") families.add(job["sessionId"]);
    } catch {
      // Not a job record (being written, or foreign).
    }
  }
  return families;
}

/** Both revisions, short, while a launchd family runs other host code than new families get; undefined otherwise. */
async function hostPin(code: DurableHostProcess["code"], revision: string | undefined): Promise<{ revision: string; current: string } | undefined> {
  if (code === undefined || code.entry === code.current) return undefined;
  return { revision: await shortRevision(revision ?? dirname(code.entry)), current: await shortRevision(dirname(code.current)) };
}

/**
 * Why a pinned family cannot move to the current host code, undefined when it can: never to older Pi Durable code (after
 * a roll back it cannot read a store newer code opened), nor when either version cannot be read.
 */
function hostMoveRefusal(code: DurableHostProcess["code"]): string | undefined {
  const [pinned, current] = [code?.entry, code?.current].map((entry) => (entry === undefined ? undefined : durableVersion(entry)));
  if (pinned === undefined || current === undefined) return "This Chat cannot move to new host code: the Pi Durable version of its host code cannot be read";
  if (compareVersions(current, pinned) < 0) return `This Chat was opened by a newer Pi Durable (${pinned}); the current host is ${current}`;
  return undefined;
}

/** Whether `entry` runs a newer Pi Durable than `than` (a move that may migrate the store). */
function newerDurable(entry: string | undefined, than: string | undefined): boolean {
  const [next, before] = [entry, than].map((path) => (path === undefined ? undefined : durableVersion(path)));
  return next !== undefined && before !== undefined && compareVersions(next, before) > 0;
}

/**
 * A copy of a closed family store (its owner exited, so SQLite's files are consistent), beside it.
 * ponytail: a full copy per cross-version upgrade (stores are megabytes); copy only session.sqlite if they grow large.
 */
function snapshotStore(storeDir: string): string {
  const snapshot = `${storeDir}.pre-upgrade`;
  rmSync(snapshot, { recursive: true, force: true });
  cpSync(storeDir, snapshot, { recursive: true });
  return snapshot;
}

/**
 * Put the snapshot back in place. The attempted store moves aside by rename, so a failed host still running keeps its
 * own files; its owner.json stays current, so owner epochs only grow. Returns where the attempted store went.
 */
function restoreStore(storeDir: string, snapshot: string): string {
  const failed = `${storeDir}.failed-upgrade`;
  rmSync(failed, { recursive: true, force: true });
  renameSync(storeDir, failed);
  renameSync(snapshot, storeDir);
  if (existsSync(join(failed, "owner.json"))) copyFileSync(join(failed, "owner.json"), join(storeDir, "owner.json"));
  return failed;
}

/**
 * The `@earendil-works/pi-durable` version a host entry runs, from the package.json Node resolves from the entry's folder
 * (the package exports no `./package.json`); undefined when none is found or it names no numeric version.
 */
function durableVersion(entry: string): string | undefined {
  for (let folder = dirname(entry); ; folder = dirname(folder)) {
    const manifest = join(folder, "node_modules", "@earendil-works", "pi-durable", "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        const version = isRecord(parsed) ? parsed["version"] : undefined;
        return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
      } catch {
        return undefined;
      }
    }
    if (dirname(folder) === folder) return undefined;
  }
}

/** Orders two versions by major.minor.patch. shortcut: pre-release tags are ignored; Pi Durable ships none today. */
function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => version.split(/[.+-]/).slice(0, 3).map(Number));
  for (let index = 0; index < 3; index++) {
    const difference = (left?.[index] ?? 0) - (right?.[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A revision folder's short commit (installed folders are git worktrees), else its name. */
async function shortRevision(folder: string): Promise<string> {
  return run("git", ["-C", folder, "rev-parse", "--short", "HEAD"]).then(({ stdout }) => stdout.trim(), () => basename(folder));
}

/**
 * Why a family is not quiet, from its host's status; undefined when nothing runs or waits. The legacy idle-unload rule
 * (`isIdleForUnload`, `hasExtensionBackgroundWork`): a running turn, queued input, an open question, a running tool,
 * children, background bash or a watcher; plus Atelier Pages the host serves. An unparseable status line counts as busy.
 */
function familyBusy(status: HostTranscript["status"]): string | undefined {
  if (status.isStreaming || status.isCompacting || status.isBashRunning) return "a turn is running";
  if (status.pendingMessageCount > 0) return "input is queued";
  if ((status.pendingAsks?.length ?? 0) > 0) return "a question is open";
  if ((status.activeToolExecutions?.length ?? 0) > 0) return "a tool is running";
  const list = (key: string, field: string) => statusList(status, key, field);
  if (childrenRunning(status)) return "children are running";
  if (list("pi-workbench:background-bash", "jobs")?.length !== 0) return "background bash is running";
  if (list("pi-process-monitor:watchers", "watchers")?.length !== 0) return "a watcher is running";
  if (status.extensionStatuses?.["pi-workbench:atelier"] !== undefined) return "it serves Atelier Pages";
  return undefined;
}

/**
 * Whether an automatic upgrade (B) may restart the family now: nothing runs or waits except work that survives a host
 * restart unchanged (open questions, background bash, watchers, Atelier Pages).
 */
function restartSafe(status: HostTranscript["status"]): boolean {
  return !status.isStreaming && !status.isCompacting && !status.isBashRunning && status.pendingMessageCount === 0
    && (status.activeToolExecutions?.length ?? 0) === 0 && !childrenRunning(status);
}

/** A JSON list in one of the host's extension status lines: none when the line is absent, undefined when unparseable. */
function statusList(status: HostTranscript["status"], key: string, field: string): unknown[] | undefined {
  const text = status.extensionStatuses?.[key];
  if (text === undefined) return [];
  try {
    const value: unknown = JSON.parse(text);
    const items = isRecord(value) ? value[field] : undefined;
    return Array.isArray(items) ? items : undefined;
  } catch {
    return undefined;
  }
}

/** A delegate roster row not yet ended (Subagents, Workers); an unparseable roster counts as running. */
function childrenRunning(status: HostTranscript["status"]): boolean {
  const delegates = statusList(status, "pi-workbench:activity", "items");
  return delegates === undefined || delegates.some((item) => !isRecord(item) || item["endedAt"] === undefined);
}

/**
 * What Upgrade now repeats or holds, from the host's status (the survival table of the rebuild plan): an answer in flight
 * is requested again, a running tool reruns when it is safe and waits for the owner otherwise, running children resume.
 * Open questions, queued input, background bash, watchers and Atelier Pages carry over unchanged.
 */
function upgradeRepeats(status: HostTranscript["status"]): string[] {
  const repeats: string[] = [];
  if (status.isStreaming || status.isCompacting) repeats.push("the running turn: its answer is requested again; safe tools rerun, others wait for you");
  if (status.isBashRunning) repeats.push("the running ! command is interrupted");
  if (childrenRunning(status)) repeats.push("running Subagents and Workers resume their current step");
  return repeats;
}

/** A host-side notification request: the daemon turns it into PI WEB's global `session.attention`. */
interface HostAttentionEvent { type: "durable.attention"; kind: "ask" | "attention"; id: string; detail: string }
/** A Pi package's warning or error outside a command: kept in the Chat's notification inbox, as in a legacy Chat. */
interface HostNotificationEvent { type: "durable.notification"; severity: "warning" | "error"; message: string }
/** spawn_session: start an independent Chat in a workspace of the spawning Chat's project, answered with `spawned`. */
interface HostSpawnEvent { type: "durable.spawn"; requestId: string; spawningCwd: string; prompt: string; cwd?: string; model?: string; thinkingLevel?: string }
type HostEvent = HostAttentionEvent | HostNotificationEvent | HostSpawnEvent;

/** The host returns the outcome PI WEB's store computed (or, on a retry, recorded); a shape check suffices. */
function isAskOutcome(value: unknown): value is AskUserOutcome {
  return isRecord(value) && typeof value["askId"] === "string" && typeof value["reason"] === "string" && Array.isArray(value["questions"]) && typeof value["summary"] === "string";
}

function commandResult(value: unknown): ClientCommandResult {
  if (isRecord(value) && value["type"] === "done") return { type: "done", ...(typeof value["message"] === "string" ? { message: value["message"] } : {}) };
  if (isRecord(value) && value["type"] === "unsupported" && typeof value["message"] === "string") return { type: "unsupported", message: value["message"] };
  throw new Error("Durable host sent a malformed command result");
}

/** The host's history as Pi-shaped entries, projected with the legacy tree projection; or its visible refusal. */
function hostTree(value: unknown): ClientCommandResult {
  if (isRecord(value) && value["type"] === "unsupported" && typeof value["message"] === "string") return { type: "unsupported", message: value["message"] };
  if (!isRecord(value) || value["type"] !== "tree" || !Array.isArray(value["nodes"])) throw new Error("Durable host sent a malformed session tree");
  const nodes = new Map<string, { entry: unknown; children: ProjectableSessionTreeNode[] }>();
  const roots: ProjectableSessionTreeNode[] = [];
  for (const entry of value["nodes"]) {
    if (!isRecord(entry) || typeof entry["id"] !== "string") throw new Error("Durable host sent a malformed session-tree entry");
    const node = { entry, children: [] };
    nodes.set(entry["id"], node);
    const parent = typeof entry["parentId"] === "string" ? nodes.get(entry["parentId"]) : undefined;
    (parent?.children ?? roots).push(node);
  }
  const leaf = value["activeLeafId"];
  const tree = projectSessionTree(roots, typeof leaf === "string" ? leaf : null);
  if (tree.nodes.length === 0) return { type: "unsupported", message: "Cannot navigate an empty session tree." };
  return { type: "tree", tree };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : "")).join("\n");
}

/** The contributed resources a host's ready message names; anything malformed is dropped. */
function parseContributedResources(value: unknown): DurableContributedResources {
  const paths = (list: unknown) => (Array.isArray(list) ? list : []).flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const { path, extensionPath } = entry;
    return typeof path === "string" && path !== "" && typeof extensionPath === "string" && extensionPath !== "" ? [{ path, extensionPath }] : [];
  });
  return isRecord(value) ? { skillPaths: paths(value["skillPaths"]), promptPaths: paths(value["promptPaths"]) } : { skillPaths: [], promptPaths: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host is local Workbench code speaking PI WEB's own event shapes; only the discriminator is checked here. */
function isSessionUiEvent(value: unknown): value is SessionUiEvent | HostEvent {
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
