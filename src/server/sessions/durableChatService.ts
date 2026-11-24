import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { CHAT_CAPABILITY_LABELS, type ChatCapability, isChatCapability } from "../../shared/apiTypes.js";
import type { AskUserCloseResponse, AskUserOutcome, AskUserSubmission, PendingAskUser, QueuedSessionMessage, SavedPromptAttachment, SessionAttentionEvent, SessionAttentionRequest, SessionNotificationDismissAllRequest, SessionNotificationDismissRequest, SessionNotificationInboxSnapshot, SessionNotificationSummaryEvent, SessionQueueMessageMutation, SessionStatus, SessionUiEvent } from "../../shared/apiTypes.js";
import { childrenRunning, familyBusy, runningWork } from "../../shared/closeBusy.js";
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
import { catalogWithEnabledFirst, resolveEnabledModelIds } from "./sessionModelScope.js";
import type { ModelRuntime } from "../../piSdk.js";
import type { SpawnSessionResult } from "./spawnSessionTool.js";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import { cleanSessionName, cleanTabName, fallbackSessionName, SESSION_TITLE_SYSTEM_PROMPT, sessionTitleInput, shortSessionNamePrompt, tabNamePrompt } from "./sessionNameGenerator.js";
import type { SessionNotificationGeneration, SessionNotificationMutation, SessionNotificationStore } from "./sessionNotificationStore.js";
import { isWorkstreamLaunchToken, type WorkstreamLaunchStore } from "./workstreamLaunchStore.js";
import { PendingAskStore, renderAskUserAnswersText, renderOpenAsksReminder, withEarlierAnswers, type PendingAskCloseResult } from "./pendingAskStore.js";
import { type DurableChatRecord, type SessionRuntimeLocator, storeCode, type StoreCode, storeCodeRefusal, type StoreSchema } from "./sessionRuntimeLocator.js";
import type { SessionRouteRef } from "./sessionService.js";
import { LiveReviewCollector, type LiveReviewPairing, PAIR_USAGE, parsePairCommand } from "./liveReview.js";

/** The session-host protocol version this daemon speaks (Workbench `chat-session.ts` `PROTOCOL`). */
export const DURABLE_HOST_PROTOCOL = 2;

/** A family host with nothing running or waiting and no browser watching closes after this (legacy `IDLE_SESSION_UNLOAD_MS`). */
/** The host's refusals of a queue edit whose snapshot is stale (`chat-session.ts` mutateQueue, `host.ts` EditTooLate). */
const QUEUE_MOVED = /^Queued messages changed|is no longer queued; it cannot be edited$/;
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
 * its store and exits, 0 once they are cancelled. `readTranscript`: a one-off process (`--read-transcript`) that opens the
 * store paused with no packages, sends `{ transcript: { messages } }` and exits 0; no host starts.
 */
export type DurableHostLauncher = (record: DurableChatRecord, storeDir: string, options?: { attachOnly?: boolean; endJobs?: boolean; readTranscript?: boolean }) => DurableHostProcess;

/** What starts a family's host: the Workbench host entry, the model and Pi agent dir it runs with. */
export interface DurableHostOptions { entry: string; model: string | ((cwd: string) => string); agentDir: string; scripted?: boolean; thinkingLevel?: (cwd: string, model: string) => string }

/** The host's arguments for one family; a new Chat starts at the thinking level Pi would pick (a reopened one keeps its own). */
export function durableHostLaunchArgs(options: DurableHostOptions, record: Pick<DurableChatRecord, "id" | "cwd">, storeDir: string): string[] {
  const thinking = options.thinkingLevel ?? ((cwd: string, model: string) => durableThinkingLevel(cwd, options.agentDir, model));
  const model = typeof options.model === "string" ? options.model : options.model(record.cwd);
  return durableHostArgs(record, storeDir, { ...options, model, thinking: thinking(record.cwd, model) });
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
      return fork(options.entry, [...durableHostLaunchArgs(options, record, storeDir), ...(launch?.endJobs === true ? ["--end-jobs"] : []), ...(launch?.readTranscript === true ? ["--read-transcript"] : [])], {
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
  publishGlobal(event: { type: "session.created"; session: ClientSession } | { type: "status.update"; status: SessionStatus } | { type: "activity.update"; activity: { sessionId: string; phase: "active" | "idle" | "error"; label: string; at: string } } | { type: "session.name"; sessionId: string; name?: string; shortName?: string } | SessionAttentionEvent): void;
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
  /** B for an upgrade that changes the store format: only once the family is quiet, and with no fallback (see `#upgradeRestart`). */
  upgradeQuiet = false;
  /** The host's ready message says it closes only if still restart-safe, checked and quiesced in the host (B's close). */
  closeIfRestartSafe = false;
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
        this.closeIfRestartSafe = message["ready"]["closeIfRestartSafe"] === true;
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
   * the family's background jobs first; any other close (restart, idle, upgrade) leaves them running. `reason: "upgrade"`:
   * Upgrade now's close, which the host records as an `upgrade-restart`; with `ifRestartSafe` the host closes only if
   * nothing but restart-surviving work runs, and refuses otherwise. Returns the host's refusal (it keeps running): only
   * its affirmative answer (`closed: true`) lets the timers end it; an error, or no answer within `2 * graceMs`, is a refusal.
   */
  async close(graceMs: number, params?: { end: true } | { reason: "upgrade"; ifRestartSafe?: true }): Promise<string | undefined> {
    if (!this.alive) return undefined;
    const conditional = params !== undefined && "ifRestartSafe" in params;
    if (conditional) {
      let wait: NodeJS.Timeout | undefined;
      const answer = await Promise.race([
        this.request("close", params).then(({ result }) => result, (error: unknown) => ({ closed: false, busy: `its safe close failed (${error instanceof Error ? error.message : String(error)})` })),
        new Promise<unknown>((resolve) => { wait = setTimeout(() => { resolve({ closed: false, busy: "it did not answer the safe close" }); }, 2 * graceMs); }),
      ]);
      clearTimeout(wait);
      if (!isRecord(answer) || answer["closed"] !== true) return isRecord(answer) && typeof answer["busy"] === "string" ? answer["busy"] : "the host is busy";
    }
    const terminate = setTimeout(() => { this.process.kill("SIGTERM"); }, graceMs);
    const kill = setTimeout(() => { this.process.kill("SIGKILL"); }, 2 * graceMs);
    try {
      // Already gone, or terminated by the timers.
      if (!conditional) await this.request("close", params).catch(() => undefined);
      await this.exited;
      return undefined;
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
  /** History reads of Chats with no host (`#readCold`), by Chat ID, chained one after another. */
  readonly #coldReads = new Map<string, Promise<unknown[] | undefined>>();
  #coldQueue: Promise<void> = Promise.resolve();

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
    /** Pi's `enabledModels` patterns for a workspace; they scope the models a Chat offers, as for legacy Chats. None: every model. */
    enabledModels?: (cwd: string) => string[] | undefined;
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
    /** How long `stopIfUnwatched` waits for the closing tab's own socket to go; default 2 s. */
    watchGraceMs?: number;
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
  /** Ordered restarts in progress, by Chat (see `#upgradeOnce`). */
  readonly #upgrades = new Map<string, Promise<string | undefined>>();
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
  /**
   * send_chat_message deliveries by sender and request ID, for an hour: a retried request gets the same answer and counts
   * once. Later the target answers a retry with its first delivery.
   */
  readonly #chatMessages = new Map<string, { at: number; sending: Promise<ChatMessageResult> }>();
  /** Which request each chat sent to each target (`<from>\0<to>`), and to any target (`<from>`), when; in memory only: the loop guard. */
  readonly #chatMessagesSent = new Map<string, { at: number; requestId: string }[]>();
  /** Each chat's place in a reply chain: the highest hop of the chat messages delivered to it; an admitted owner prompt resets it. */
  readonly #hops = new Map<string, number>();
  /** Chats whose host last reported a running turn, for send_chat_message's list. */
  readonly #streaming = new Set<string>();
  /** Live review: each paired main Chat's work since its last digest; in memory, so a daemon restart drops a partial digest. */
  readonly #liveReviews = new Map<string, LiveReviewCollector>();
  /** Reviewer Chats working on a digest (delivered, its turn not ended yet), so the next digest waits and merges. */
  readonly #reviewing = new Set<string>();
  /** Live review: each main Chat's events in order, as each waits for its fields' redaction. */
  readonly #reviewEvents = new Map<string, Promise<void>>();
  /** Live review: `/pair`, `/pair stop` and an explicit end, one at a time per main Chat. */
  readonly #pairings = new Map<string, Promise<unknown>>();

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
      ...(record.shortName === undefined ? {} : { shortName: record.shortName }),
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

  /**
   * A Chat with no host is read by a one-off reader process, not a started host: a host runs the Chat's packages, which
   * can restart saved processes (a Workstream's orientation sweep reads every Chat in it). Host code without the reader
   * (an older pin) fails it, and the read starts the host as before.
   */
  async messages(ref: SessionRouteRef, page?: { before?: number; limit?: number }): Promise<ClientMessagePage> {
    const record = this.#record(ref);
    const cold = this.#connections.has(record.id) || record.host !== undefined || record.upgrade !== undefined ? undefined : await this.#readCold(record);
    const messages = cold ?? hostTranscript((await (await this.#connection(record)).request("transcript")).result).messages;
    return pageMessagesAtSafeBoundary(this.#withCacheMissNotices(ref, messages).map(displayPromptMessage), page);
  }

  /** The reader's messages, or undefined when it failed; a host start waits for a read of its store (`#connection`). */
  #readCold(record: DurableChatRecord): Promise<unknown[] | undefined> {
    const running = this.#coldReads.get(record.id);
    if (running !== undefined) return running;
    // ponytail: one read at a time daemon-wide (each is a Node process opening the store); a sweep of N Chats takes N reads.
    // Never rejects: a reader that cannot start (a launcher refusal, a spawn error) is a failed read, and the next one runs.
    const read = this.#coldQueue.then(() => new Promise<unknown[] | undefined>((resolve) => {
      const failed = (error: unknown) => {
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat history reader failed");
        resolve(undefined);
      };
      let messages: unknown[] | undefined;
      try {
        const reader = this.deps.launch(record, join(this.deps.storesDir, record.storeId), { readTranscript: true });
        reader.on("message", (message) => {
          const transcript = isRecord(message) && isRecord(message["transcript"]) ? message["transcript"] : undefined;
          if (Array.isArray(transcript?.["messages"])) messages = transcript["messages"];
        });
        // A spawn failure emits "error" and may never emit "exit".
        reader.on("error", failed);
        reader.on("exit", (code) => { resolve(code === 0 ? messages : undefined); });
      } catch (error) {
        failed(error);
      }
    })).finally(() => { this.#coldReads.delete(record.id); });
    this.#coldQueue = read.then(() => undefined);
    this.#coldReads.set(record.id, read);
    return read;
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
  async prompt(ref: SessionRouteRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown, options?: { operationId?: string; spawned?: true }): Promise<void> {
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
    // Chats titled before tab names existed, or while their host was down, get one on their next prompt.
    const titled = this.deps.locator.durable(ref.id);
    if (titled?.name !== undefined && titled.shortName === undefined && titled.shortNameSource !== "manual") this.#retab(ref.id);
    const { result } = await connection.request("prompt", {
      operationId: operationId ?? randomUUID(), text: providerText,
      ...(streamingBehavior === undefined ? {} : { mode: streamingBehavior }),
      ...(images.length === 0 ? {} : {
        images,
        attachments: parsed.map((attachment) => ({ reference: attachment.reference, mimeType: attachment.mimeType, ...(attachment.name === undefined ? {} : { name: attachment.name }) })),
      }),
    });
    // The host admitted a new owner input (not a replayed operation; an older host does not say): this chat's reply chain
    // starts again. spawn_session's assignment is not the owner.
    if (options?.spawned !== true && isRecord(result) && result["fresh"] === true) this.#hops.delete(ref.id);
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

  /** Remove, recall (`edit`) or toggle a queued message, against the queue the browser showed (as legacy Chats); a changed queue changes nothing. */
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
    })) return { ...(await this.status(ref)), queueChanged: true };
    if (mutation.index >= current.length) throw new Error("Invalid queue index");
    const changed = await this.#mutateQueue(connection, mutation.action === "edit" ? "recall" : mutation.action, mutation.index, queued);
    return changed ? { ...(await this.status(ref)), queueChanged: true } : this.status(ref);
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
  /**
   * Edit the host's queue against the snapshot read just before; true when the queue moved in between (a message was
   * delivered or a notice arrived), so the edit changed nothing and the caller returns the current queue, as legacy does.
   */
  async #mutateQueue(connection: DurableHostConnection, action: string, index: number, queued: readonly QueuedSessionMessage[]): Promise<boolean> {
    const expected = queued.map((message) => (isRecord(message) ? message["id"] : undefined));
    try {
      await connection.request("mutateQueue", { editId: randomUUID(), action, index, expected });
      return false;
    } catch (error) {
      if (error instanceof Error && QUEUE_MOVED.test(error.message)) return true;
      throw error;
    }
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
      { name: "tabname", description: "Name this Chat's tab in one or two words; without a name, the tab takes a generated one again", argumentHint: "[name]", source: "builtin" as const },
      { name: "mode", description: "Choose Working Mode guidance for the next prompt; /mode send delivers it now; /mode unalign clears the alignment", source: "extension" as const },
      { name: "pair", description: "Live review: a reviewer chat watches this chat's work and messages it on a defect; /pair stop ends it", argumentHint: "[provider/model] [--trigger turn|turn5|edits] [--brief silent|coach] | stop", source: "extension" as const },
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
    if (name === "tabname") return this.#tabName(ref, rest);
    // An agent's prompt or message reading /pair is text; only the command route calls this (see its shortcut).
    if (name === "pair") return this.#serializePairing(ref.id, () => this.#pair(ref, rest));
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
    // A generated tab name belongs to the old title: the tab shows the new title until its own is generated.
    const generated = this.deps.locator.durable(sessionId)?.shortNameSource !== "manual";
    this.deps.locator.update(sessionId, { name, nameSource, ...(generated ? { shortName: undefined } : {}) });
    this.#retab(sessionId);
    return this.#publishName(sessionId);
  }

  #tabName(ref: SessionRouteRef, shortName: string): ClientCommandResult {
    this.#record(ref);
    if (shortName === "") {
      this.deps.locator.update(ref.id, { shortName: undefined, shortNameSource: "auto" });
      this.#retab(ref.id);
      return { type: "done", message: "The tab takes a generated name again", session: this.#publishName(ref.id) };
    }
    const clean = cleanTabName(shortName);
    if (clean === undefined) return { type: "unsupported", message: "Usage: /tabname <one or two words, at most 24 characters>" };
    this.deps.locator.update(ref.id, { shortName: clean, shortNameSource: "manual" });
    return { type: "done", message: `Tab named: ${clean}`, session: this.#publishName(ref.id) };
  }

  /** A generated tab name for the Chat's title, asked through its running host; never over the owner's `/tabname`. */
  #retab(sessionId: string): void {
    const record = this.deps.locator.durable(sessionId);
    const connection = this.#connections.get(sessionId);
    const title = record?.name;
    if (title === undefined || record?.shortNameSource === "manual" || connection === undefined) return;
    void (async () => {
      const naming = this.deps.config === undefined ? {} : (await this.deps.config.read()).effectiveConfig.sessionNaming ?? {};
      const model = naming.model === undefined ? undefined : parseModelSpec(naming.model);
      const { result } = await (await connection).request("complete", {
        systemPrompt: SESSION_TITLE_SYSTEM_PROMPT, prompt: tabNamePrompt(title),
        maxTokens: naming.maxTokens ?? 24, reasoning: naming.thinkingLevel ?? "minimal", timeoutMs: naming.timeoutMs ?? 10_000,
        ...(model === undefined ? {} : { model }),
      });
      const shortName = typeof result === "string" ? cleanTabName(result) : undefined;
      const current = this.deps.locator.durable(sessionId);
      if (shortName === undefined || current?.name !== title || current.shortNameSource === "manual") return;
      this.deps.locator.update(sessionId, { shortName, shortNameSource: "auto" });
      this.#publishName(sessionId);
    })().catch((error: unknown) => {
      this.deps.logger?.warn({ sessionId, err: error }, "Durable Chat tab naming failed; the tab shows the title");
    });
  }

  #publishName(sessionId: string): ClientSession {
    const record = this.deps.locator.durable(sessionId);
    if (record === undefined) throw new Error("Session not found");
    const session = this.info(record);
    const event = { type: "session.name" as const, sessionId, ...(session.name === undefined ? {} : { name: session.name }), ...(session.shortName === undefined ? {} : { shortName: session.shortName }) };
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

  /** The running host's open asks; undefined when none runs, as this read never starts one. */
  async openAsks(ref: SessionRouteRef): Promise<PendingAskUser[] | undefined> {
    const status = await this.#runningStatus(ref);
    return status === undefined ? undefined : status.pendingAsks ?? [];
  }

  async attentionRequest(ref: SessionRouteRef): Promise<SessionAttentionRequest | undefined> {
    return (await this.#runningStatus(ref))?.attentionRequest;
  }

  /**
   * The status of the Chat's connected (or connecting) host, else undefined: never starts a host. A host with an open
   * ask is never idle-closed (`familyBusy`), so only a crash or the owner's stop leaves an open ask on a cold Chat.
   */
  async #runningStatus(ref: SessionRouteRef): Promise<HostTranscript["status"] | undefined> {
    const connection = await this.#connections.get(this.#record(ref).id)?.catch(() => undefined);
    return connection === undefined ? undefined : hostStatus((await connection.request("status")).result);
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
    // The host's earlier partial-send records of the set (`earlier`, oldest first) make the browser's record whole.
    const earlier = isRecord(result) && Array.isArray(result["earlier"]) ? result["earlier"].filter(isAskOutcome) : [];
    // `order`: the set's question ids as posted and revised, so the record numbers them in set order, as a legacy Chat's.
    const order = isRecord(result) && Array.isArray(result["order"]) ? result["order"].filter((id) => typeof id === "string") : [];
    if (isRecord(result) && result["result"] === "closed" && isAskOutcome(result["outcome"])) return { result: "closed", outcome: withEarlierAnswers(result["outcome"], earlier, order), sessionStatus };
    return { result: "stale", sessionStatus };
  }

  /** The models a Chat can switch to: the host's, scoped to `enabledModels` in their order, as a legacy Chat's. */
  async availableModels(ref: SessionRouteRef): Promise<ClientSessionModel[]> {
    return (await this.#scopedModels(ref)).filter((entry) => entry.enabled).map((entry) => entry.model);
  }

  /** Every model the host offers, enabled ones first; the scope is edited in Pi's settings, not here. */
  async modelCatalog(ref: SessionRouteRef): Promise<ClientSessionModelCatalogEntry[]> {
    return (await this.#scopedModels(ref)).map(({ model, enabled, catalogIndex }) => ({ ...model, enabled, editable: false, catalogIndex }));
  }

  async #scopedModels(ref: SessionRouteRef) {
    const { result } = await (await this.#for(ref)).request("models");
    const models = (Array.isArray(result) ? result.filter(isRecord) : []).map((model) => ({ ...model, provider: typeof model["provider"] === "string" ? model["provider"] : "", id: typeof model["id"] === "string" ? model["id"] : "" }));
    // Pi's own pattern resolution, over the host's models (those with a stored login) rather than PI WEB's catalog.
    const enabledIds = await resolveEnabledModelIds({
      settingsManager: { getEnabledModels: () => this.deps.enabledModels?.(ref.cwd) },
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Pi's scope resolution reads only getAvailable; the host's models stand in for the runtime's.
      modelRuntime: { getAvailable: () => Promise.resolve(models) } as unknown as ModelRuntime,
      scopedModels: [],
    });
    return catalogWithEnabledFirst(models, enabledIds);
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
    await this.#unpair(ref.id);
    await this.#end(ref.id, true);
  }

  /**
   * Closing a Chat's tab (Workbench): end it as `stop` does, unless a browser still watches it (after waiting for the
   * closing tab's own socket to go) or, unless `confirmed`, work runs; the refusal names that work for the warning.
   * shortcut: a window that starts watching between the last check and the end loses the host; it reopens on next use.
   * shortcut: work the host starts between its status sample and `{ end: true }` (milliseconds) ends unwarned; move the check into the host if that bites.
   * shortcut: another browser that is reconnecting has no socket, so the Chat counts as unwatched and ends; it reopens when that browser reconnects.
   */
  async stopIfUnwatched(ref: SessionRouteRef, confirmed: boolean): Promise<{ stopped: true } | { stopped: false; watched: true } | { stopped: false; busy: string }> {
    const record = this.#record(ref);
    const watched = () => this.deps.events.hasSessionSubscribers?.(record.id) !== false;
    for (let waited = 0; watched() && waited < (this.deps.watchGraceMs ?? 2000); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    if (watched()) return { stopped: false, watched: true };
    if (!confirmed) {
      const pending = this.#connections.get(record.id) ?? (record.host === undefined ? undefined : this.#connection(record, true));
      const connection = await pending?.catch(() => undefined);
      const busy = connection === undefined
        ? familiesWithBackgroundJobs().has(record.id) ? "Background bash jobs are running; closing ends them." : undefined
        : runningWork(hostStatus((await connection.request("status")).result));
      if (busy !== undefined) return { stopped: false, busy };
      if (watched()) return { stopped: false, watched: true };
    }
    await this.#unpair(record.id);
    await this.#end(record.id, true);
    return { stopped: true };
  }

  /**
   * Stop-all: every family host, connected or only recorded by an earlier daemon, ends with its background jobs, and so
   * does every family with unfinished background jobs whose host is gone. Live review pairs stay, as across a daemon
   * restart: no owner ended a Chat.
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
    await connection?.close(this.deps.closeGraceMs ?? 5000, explicit ? { end: true } : undefined);
  }

  /**
   * Close every family host idle for {@link IDLE_HOST_CLOSE_MS}: no event since, nothing running or waiting (see
   * `familyBusy`) and no browser watching, as legacy `unloadIdleSessions` unloads sessions. The next use reopens it, on
   * the current host code when the family was pinned and may move (see `hostMoveRefusal`).
   * shortcut: an open Atelier Page goes offline with the idle host (the owner chose Pages live and die with the Chat); reopening the Chat serves it again.
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
   * - `quiet` (Upgrade host): refused unless the family is quiet; its host closes in order (only if still quiet, decided
   *   in the host, when it can) and the new host starts at once from the current revision folder, with no fallback.
   * - `now` (Upgrade now, seamless upgrade C): whatever runs, the host closes in order (`upgrade-restart`) and the new
   *   host starts at once and resumes, recovering as after any restart (see `upgradeRepeats`). If the new host does not
   *   start, the family goes back to its old pin and host, and the error says so.
   * - `cancel`: drop the pending automatic upgrade (B; see `upgradePendingHosts`).
   * shortcut (quiet, a host without the conditional close): input arriving between the quiet check and the close waits,
   * paused, for the next message.
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
      this.deps.locator.setUpgradeState(record.id, "upgradeDeclined", connection.code?.current);
      connection.upgradePending = false;
      return this.status(ref);
    }
    if (pin === undefined) return this.status(ref);
    const refusal = hostMoveRefusal(connection.code);
    if (refusal !== undefined) throw new Error(refusal);
    if (mode === "quiet") {
      // Served Pages do not block the owner's click: `status` below starts the new host at once, which reopens them on the
      // same port, so open tabs miss only the restart.
      const busy = familyBusy(hostStatus((await connection.request("status")).result));
      const refused = busy ?? await this.#upgradeOnce(record, pin, connection.code, connection.closeIfRestartSafe ? "ifRestartSafe" : "plain", true);
      if (refused !== undefined) throw new Error(`This Chat cannot move to new host code while ${refused}; try again when it is quiet`);
      return this.status(ref);
    }
    await this.#upgradeOnce(record, pin, connection.code, "upgrade");
    return this.status(ref);
  }

  /**
   * One ordered restart per family at a time, until its resume: a later request (a double click, B) joins it. Only within
   * one Pi Durable version (see `restartRefusal`), unless with `noFallback`, which only never moves to older code.
   */
  #upgradeOnce(record: DurableChatRecord, pin: { revision: string; current: string }, code: DurableHostProcess["code"], close: UpgradeClose, noFallback = false): Promise<string | undefined> {
    let running = this.#upgrades.get(record.id);
    if (running === undefined) {
      const refusal = noFallback ? hostMoveRefusal(code) : restartRefusal(code);
      if (refusal !== undefined) return Promise.reject(new Error(refusal));
      running = this.#upgradeRestart(record, pin, code?.current, close, noFallback).finally(() => { this.#upgrades.delete(record.id); });
      this.#upgrades.set(record.id, running);
    }
    return running;
  }

  /**
   * Upgrade now's ordered restart: close (`upgrade`), move the pin to the current code, start the new host and resume
   * it; else move the pin back and start the old code once more. The store is never copied or moved: both codes run the
   * same Pi Durable, so a rollback only restores the pin. While it runs, the family's connection is a handover every
   * request waits on, settled exactly once with the host the family ends on (the old one when it never closed), whatever
   * fails. `ifRestartSafe` (B, Upgrade host): the old host closes only if it still runs nothing but restart-surviving
   * work, decided in the host, which admits no input meanwhile; returns its refusal, and the family stays on its host.
   * `plain`: Upgrade host's close of a host without that check, as an idle close (no resume follows). `noFallback` (a
   * store-format change, Upgrade host): the new code may have migrated the store, so a failed start leaves the pin on it
   * and the next use tries it again; the upgrade on disk names no `from`, so no daemon rolls it back either. The upgrade
   * is on disk first (`DurableChatRecord.upgrade`) and cleared only once a host acknowledged its resume, so a daemon that
   * dies or fails before then leaves the owed resume to the next one (`#recoverUpgrade`).
   */
  async #upgradeRestart(record: DurableChatRecord, pin: { revision: string; current: string }, current: string | undefined, close: UpgradeClose, noFallback: boolean): Promise<string | undefined> {
    const id = record.id;
    const pinned = this.deps.locator.durable(id)?.hostEntry;
    const old = this.#connections.get(id);
    if (old === undefined) return "it is not open";
    this.deps.logger?.info?.({ sessionId: id, from: pin.revision, to: pin.current }, "upgrade-restart: restarting Durable Chat host on current code");
    let settle!: (connection: Promise<DurableHostConnection>) => void;
    const held = new Promise<DurableHostConnection>((resolve) => { settle = resolve; });
    // Settled with a failed start when both codes fail: the caller gets that error; the family's entry may have no reader.
    void held.catch(() => undefined);
    let final: Promise<DurableHostConnection> | undefined;
    const handOver = (connection: Promise<DurableHostConnection>) => {
      if (final !== undefined) return;
      final = connection;
      settle(connection);
      // The family's entry becomes the host's own, so its exit drops it; none when it is gone or never started.
      void connection.then(
        (host) => { if (this.#connections.get(id) === held) { if (host.alive) this.#connections.set(id, connection); else this.#connections.delete(id); } },
        () => { if (this.#connections.get(id) === held) this.#connections.delete(id); },
      );
    };
    // A host on `entry`, while the handover stays the family's entry: nobody else starts one meanwhile.
    const open = (entry: string | undefined): Promise<DurableHostConnection> => {
      this.#connections.delete(id);
      const started = this.#start(record, entry);
      this.#connections.set(id, held);
      return started;
    };
    this.#connections.set(id, held);
    try {
      this.deps.locator.setUpgradeState(id, "upgrade", pinned === undefined || noFallback ? {} : { from: pinned });
      const params = close === "plain" ? undefined : { reason: "upgrade" as const, ...(close === "ifRestartSafe" ? { ifRestartSafe: true as const } : {}) };
      const busy = await (await old.catch(() => undefined))?.close(this.deps.closeGraceMs ?? 5000, params);
      if (busy !== undefined) {
        this.#upgradeDone(id);
        this.deps.logger?.info?.({ sessionId: id, busy }, "upgrade-restart: the host refused to close; the family stays on its host");
        handOver(old);
        return busy;
      }
    } catch (error) {
      // Before the close: the old host still runs, and the family stays on it as it was.
      this.#upgradeDone(id);
      handOver(old);
      throw error;
    }
    // The old host is gone: the family ends on exactly one new host, the current code's or, failing that, the old code's.
    const next = open(current);
    const connection = await next.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (connection instanceof Error && noFallback) {
      this.deps.logger?.warn({ sessionId: id, err: connection }, "upgrade-restart: the new host did not start; no fallback across a store-format change");
      handOver(next);
      this.#upgradeDone(id);
      throw new Error(`The new host code (${pin.current}) did not start: ${connection.message}. This upgrade changes the store format, so this Chat stays on the new code; the next message tries again.`, { cause: connection });
    }
    if (connection instanceof Error) {
      const back = await this.#rollBack(record, open(pinned), connection, handOver);
      throw new Error(`The new host code (${pin.current}) did not start: ${connection.message}. This Chat is back on its old host code (${pin.revision}).${back}`, { cause: connection });
    }
    // Settled before the resume is sent, which still goes first: waiters run only after it is on its way.
    handOver(next);
    if (close === "plain") this.#upgradeDone(id);
    else await this.#finishUpgrade(id, connection);
    return undefined;
  }

  /** A host for the family on `entry` (its pin first); a failed pin write fails it, before anything starts. */
  #start(record: DurableChatRecord, entry: string | undefined): Promise<DurableHostConnection> {
    try {
      this.deps.locator.setHostEntry(record.id, entry);
      return this.#connection(record);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** The upgrade is over: no resume is owed. A failed write only leaves a resume to resend, which is harmless. */
  #upgradeDone(sessionId: string): void {
    try {
      this.deps.locator.setUpgradeState(sessionId, "upgrade", undefined);
    } catch (error) {
      this.deps.logger?.warn({ sessionId, err: error }, "upgrade-restart: could not record the end of the upgrade; a later daemon resends its resume");
    }
  }

  /** Resume the family's new host; only its acknowledgement ends the upgrade (a failure leaves the resume owed). */
  async #finishUpgrade(sessionId: string, connection: DurableHostConnection): Promise<void> {
    await this.#resume(connection);
    this.#upgradeDone(sessionId);
  }

  /**
   * After a failed start of the new host: the old pin's host (`started`, the one host the rollback starts), resumed.
   * `handOver` gets it as the family's connection. Returns the rest of the error's sentence.
   */
  async #rollBack(record: DurableChatRecord, started: Promise<DurableHostConnection>, error: unknown, handOver?: (connection: Promise<DurableHostConnection>) => void): Promise<string> {
    this.deps.logger?.warn({ sessionId: record.id, err: error }, "upgrade-restart: the new host did not start; rolling back to the old pin");
    handOver?.(started);
    const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));
    return started.then(
      (host) => this.#finishUpgrade(record.id, host).then(() => "", (failure: unknown) => ` It did not resume there (${message(failure)}); the next message resumes it.`),
      (again: unknown) => { this.#upgradeDone(record.id); return ` It did not start there either (${message(again)}); the next message tries again.`; },
    );
  }

  /**
   * A daemon that died during an Upgrade now (`DurableChatRecord.upgrade`): start or reattach the family's host on its
   * pin and send the resume it still owes. A new host that does not start rolls back as Upgrade now does, unless the
   * upgrade names no `from` (a store-format change, see `#upgradeRestart`).
   */
  async #recoverUpgrade(record: DurableChatRecord, upgrade: NonNullable<DurableChatRecord["upgrade"]>): Promise<void> {
    this.deps.logger?.info?.({ sessionId: record.id }, "upgrade-restart: finishing an upgrade an earlier daemon left");
    const connection = await this.#connection(record).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (!(connection instanceof Error)) {
      await this.#finishUpgrade(record.id, connection).catch((error: unknown) => { this.deps.logger?.warn({ sessionId: record.id, err: error }, "upgrade-restart: the resume failed; a later daemon or the next message resumes"); });
      return;
    }
    if (upgrade.from === undefined || this.deps.locator.durable(record.id)?.hostEntry === upgrade.from) {
      // The old host was not closed yet, or was already rolled back to: nothing to undo.
      this.#upgradeDone(record.id);
      this.deps.logger?.warn({ sessionId: record.id, err: connection }, "upgrade-restart: the family's host did not start; the next message tries again");
      return;
    }
    await this.#rollBack(record, this.#start(record, upgrade.from), connection);
  }

  /** Whether the owner cancelled (or a failure ended) the automatic upgrade to this current code; kept across daemon restarts. */
  #declined(sessionId: string, code: DurableHostProcess["code"]): boolean {
    const declined = this.deps.locator.durable(sessionId)?.upgradeDeclined;
    return declined !== undefined && declined === code?.current;
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
   * children wait. The daemon's status check only selects candidates: the host itself checks again as it closes and
   * admits no input meanwhile (only hosts that say so are pending). Runs on each status the host publishes and on the
   * idle sweep. A failed start rolls back (as Upgrade now) and leaves the family pinned, with a notice in its inbox; across a
   * store-format change (only once quiet, see `familyBusy`) it never rolls back, the notice says so, and the next use retries.
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
        if (status === undefined || !restartSafe(status) || this.#declined(id, connection.code) || this.#connections.get(id) !== pending) continue;
        // A store-format change moves only when the family is quiet, as the Upgrade host click does.
        if (connection.upgradeQuiet && familyBusy(status) !== undefined) continue;
        this.deps.logger?.info?.({ sessionId: id }, "upgrade-restart: automatic upgrade at a safe moment");
        await this.#upgradeOnce(record, pin, connection.code, "ifRestartSafe", connection.upgradeQuiet).catch((error: unknown) => {
          this.deps.logger?.warn({ sessionId: id, err: error }, "upgrade-restart: automatic upgrade failed");
          this.deps.locator.setUpgradeState(id, "upgradeDeclined", connection.code?.current);
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

  /**
   * After a daemon restart: reconnect to every family host the locator names that still runs; never starts one, except
   * for a family an earlier daemon left mid-upgrade, whose host is owed a resume.
   */
  async reattach(): Promise<void> {
    await Promise.all(this.deps.locator.all().map((record) => {
      if (record.upgrade !== undefined) return this.#recoverUpgrade(record, record.upgrade);
      return record.host === undefined ? Promise.resolve() : this.#connection(record, true).then(() => undefined, () => undefined);
    }));
  }

  #for(ref: SessionRouteRef): Promise<DurableHostConnection> {
    return this.#connection(this.#record(ref));
  }

  #connection(record: DurableChatRecord, attachOnly = false): Promise<DurableHostConnection> {
    const existing = this.#connections.get(record.id);
    if (existing !== undefined) return existing;
    // The reader holds the store: the host opens it after.
    const reading = this.#coldReads.get(record.id);
    if (reading !== undefined) return reading.then(() => this.#connection(record, attachOnly));
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
        this.#streaming.delete(record.id);
        if (this.#reviewing.delete(record.id) && record.reviewing !== undefined) void this.#sendDigest(record.reviewing);
        this.deps.events.publish(record.id, { type: "agent.end" });
      },
      (error) => { this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat host process error"); },
    );
    const opened = connection.ready.then(async () => {
      this.#capabilities.set(record.id, connection.capabilities);
      connection.pin = await hostPin(host.code, connection.revision);
      const refusal = restartRefusal(host.code);
      connection.upgradeQuiet = refusal !== undefined && hostMoveRefusal(host.code) === undefined;
      connection.upgradePending = this.deps.autoUpgrade === true && connection.pin !== undefined && !this.#declined(record.id, host.code)
        && (connection.upgradeQuiet || refusal === undefined) && connection.closeIfRestartSafe;
      const loaded = await this.deps.resources?.(record.cwd, connection.contributed).catch((error: unknown) => {
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat resources failed to load");
        return undefined;
      });
      if (loaded !== undefined) {
        this.#skills.set(record.id, loaded.skillList);
        this.#templates.set(record.id, loaded.promptList ?? []);
        await connection.request("configure", { resources: loaded.resources, compaction: loaded.compaction, spawnSessions: this.deps.spawnTargets !== undefined, chatMessages: true });
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
      await this.prompt(ref, event.prompt, undefined, undefined, { operationId: `spawn-${event.requestId}`, spawned: true });
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

  /**
   * The key and name other chats see. The key is assigned and saved the first time it is needed and never changes after.
   * Both come from the title, else from the first message, each as the host's redactor masks it whole, before anything
   * cuts or lowercases it (a token cut short or hyphenated is one no redactor knows); neither when the host cannot redact.
   */
  async #chatIdentity(record: DurableChatRecord, connection: DurableHostConnection): Promise<{ key: string; name: string }> {
    const before = this.deps.locator.durable(record.id) ?? record;
    const masked = (text: string) => connection.request("redact", { text }).then(
      ({ result }) => {
        const clean = typeof result === "string" ? result.replace(/\[REDACTED[^\]]*\]/gu, " ").replace(/\s+/gu, " ").trim() : "";
        return clean === "" ? undefined : clean;
      },
      () => undefined,
    );
    const title = before.name === undefined ? undefined : await masked(before.name);
    const needed = before.firstMessage !== "" && (title === undefined || before.key === undefined);
    const first = !needed ? "" : (await masked(before.firstMessage)) ?? "";
    // Read again after the await, with no await before the save: a concurrent send may have assigned the key meanwhile.
    const live = this.deps.locator.durable(record.id) ?? before;
    let key = live.key;
    if (key === undefined) {
      key = chatKey({ id: live.id, ...(title === undefined ? {} : { name: title }), firstMessage: first }, new Set(this.deps.locator.all().flatMap((other) => (other.key === undefined ? [] : [other.key]))));
      this.deps.locator.update(live.id, { key });
    }
    return { key, name: title ?? (first.slice(0, 60).trim() || "Durable Chat") };
  }

  /** A target named by key first, then by chat ID; never a legacy Chat (it has no Durable record). */
  #chatMessageTarget(chat: unknown): DurableChatRecord {
    const name = typeof chat === "string" ? chat.trim() : "";
    if (name === "") throw new Error("send_chat_message: chat must name a chat key or chat ID");
    const records = this.deps.locator.all();
    const found = records.find((record) => record.key === name) ?? this.deps.locator.durable(name);
    if (found !== undefined) return found;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(name)) throw new Error(`No Durable Chat ${name} in this PI WEB`);
    const close = closeChatKeys(name, records.flatMap((record) => (record.key === undefined ? [] : [record.key])));
    throw new Error(`send_chat_message: no chat with key ${name}${close.length === 0 ? "" : `; close matches: ${close.join(", ")}`}. Run send_chat_message with action "list" to see chats.`);
  }

  /** A host's send_chat_message request: answered with `chatMessaged`, the delivery or the refusal. */
  async #answerChatMessage(connection: DurableHostConnection, sender: DurableChatRecord, event: HostChatMessageEvent | HostChatListEvent): Promise<void> {
    let pending: Promise<ChatMessageResult | { chats: ChatListEntry[] }>;
    if (event.type === "durable.chat-list") pending = this.#chatList(sender, connection).then((chats) => ({ chats }));
    else {
      const now = this.#now();
      for (const [id, { at }] of this.#chatMessages) if (now - at >= CHAT_MESSAGE_HOUR_MS) this.#chatMessages.delete(id);
      const id = `${sender.id}\0${event.requestId}`;
      let sending = this.#chatMessages.get(id)?.sending;
      if (sending === undefined) {
        sending = this.#sendChatMessage(sender, event, connection);
        this.#chatMessages.set(id, { at: now, sending });
        sending.catch(() => { this.#chatMessages.delete(id); });
      }
      pending = sending;
    }
    const answer = await pending.then((result) => ({ result }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    await connection.request("chatMessaged", { requestId: event.requestId, ...answer }).catch((error: unknown) => {
      this.deps.logger?.warn({ requestId: event.requestId, err: error }, "Durable Chat host did not take the send_chat_message answer");
    });
  }

  /** Other chats, most recently active first, at most 15. */
  #chatList(sender: DurableChatRecord, connection: DurableHostConnection): Promise<ChatListEntry[]> {
    const active = (record: DurableChatRecord) => Math.max(Date.parse(record.modified) || 0, this.#lastActive.get(record.id) ?? 0);
    const records = this.deps.locator.all().filter((record) => record.id !== sender.id).sort((a, b) => active(b) - active(a)).slice(0, CHAT_LIST_LIMIT);
    return Promise.all(records.map(async (record): Promise<ChatListEntry> => {
      const { key, name } = await this.#chatIdentity(record, connection);
      return { id: record.id, key, title: name.slice(0, 60), cwd: record.cwd, state: !this.#connections.has(record.id) ? "closed" : this.#streaming.has(record.id) ? "running" : "idle" };
    }));
  }

  /** Validate, apply the loop guard, start or reach the target's host, and deliver; the sender is the daemon's record. */
  async #sendChatMessage(sender: DurableChatRecord, event: HostChatMessageEvent, senderConnection: DurableHostConnection): Promise<ChatMessageResult> {
    const { text } = event;
    if (typeof text !== "string" || text.trim() === "" || text.length > CHAT_MESSAGE_MAX_LENGTH) throw new Error(`send_chat_message: text must be 1 to ${String(CHAT_MESSAGE_MAX_LENGTH)} characters`);
    const target = this.#chatMessageTarget(event.chat);
    if (target.id === sender.id) throw new Error("send_chat_message: a chat cannot message itself");
    const to = await this.#chatIdentity(target, senderConnection);
    const from = await this.#chatIdentity(sender, senderConnection);
    const { key } = to;
    const now = this.#now();
    // Expired sends go on every check, so pairs that stopped sending leave nothing behind.
    for (const [window, sends] of this.#chatMessagesSent) {
      const kept = sends.filter(({ at }) => now - at < (window.includes("\0") ? CHAT_MESSAGE_WINDOW_MS : CHAT_MESSAGE_HOUR_MS));
      if (kept.length === 0) this.#chatMessagesSent.delete(window);
      else this.#chatMessagesSent.set(window, kept);
    }
    // A live reviewer messaging the main Chat it watches: no limits and no reply chain (the main Chat never replies).
    const live = sender.reviewing === target.id && target.liveReview?.reviewerId === sender.id;
    const windows = live ? [] : [`${sender.id}\0${target.id}`, sender.id];
    const [direction = [], hourly = []] = windows.map((window) => this.#chatMessagesSent.get(window));
    if (direction.length >= CHAT_MESSAGE_LIMIT) throw new Error(`send_chat_message: you sent ${String(CHAT_MESSAGE_LIMIT)} messages to ${key} in the last 5 minutes; stop and report to the owner instead of retrying.`);
    if (hourly.length >= CHAT_MESSAGE_HOURLY_LIMIT) throw new Error(`send_chat_message: you sent ${String(CHAT_MESSAGE_HOURLY_LIMIT)} chat messages in the last hour; stop and report to the owner instead of retrying.`);
    for (const window of windows) this.#chatMessagesSent.set(window, [...(this.#chatMessagesSent.get(window) ?? []), { at: now, requestId: event.requestId }]);
    // shortcut: a replay after a daemon restart counts until the target answers it as a duplicate, so a full window refuses it first; persist the windows if that shows up.
    const uncount = () => {
      for (const window of windows) {
        const kept = (this.#chatMessagesSent.get(window) ?? []).filter((sent) => sent.requestId !== event.requestId);
        if (kept.length === 0) this.#chatMessagesSent.delete(window);
        else this.#chatMessagesSent.set(window, kept);
      }
    };
    const hop = (this.#hops.get(sender.id) ?? 0) + 1;
    // From hop 6 a reply chain no longer wakes anyone: delivered as a note, and the sender tells the owner to step in.
    const held = !live && event.wake !== false && hop >= CHAT_MESSAGE_HOP_LIMIT;
    const wake = event.wake !== false && !held;
    try {
      const connection = await this.#connection(target);
      const { result } = await connection.request("chatMessage", {
        requestId: event.requestId, from: { chatId: sender.id, key: from.key, name: from.name }, text, wake, urgent: wake && event.urgent === true,
        ...(live ? { liveReview: { kind: "reviewer" } } : { hop }), ...(held ? { held: true } : {}),
      });
      const delivery = isRecord(result) ? result["delivery"] : undefined;
      if (delivery !== "started" && delivery !== "queued" && delivery !== "steered" && delivery !== "noted") throw new Error("The target chat's host sent a malformed delivery");
      // A replay the target took before (a restarted daemon forgot it): the hop and held flag it was admitted with, and no quota.
      const duplicate = isRecord(result) && result["duplicate"] === true;
      if (duplicate) uncount();
      const firstHop = duplicate && typeof result["hop"] === "number" ? result["hop"] : hop;
      const firstHeld = duplicate ? result["held"] === true : held;
      if (live) return { chatId: target.id, key, name: to.name, delivery };
      // An unrelated low-hop note never lowers the chain the target is in.
      this.#hops.set(target.id, Math.max(this.#hops.get(target.id) ?? 0, firstHop));
      this.deps.logger?.info?.({ from: sender.id, to: target.id, delivery, hop: firstHop, duplicate, length: text.length }, "send_chat_message delivered");
      return { chatId: target.id, key, name: to.name, delivery, hop: firstHop, ...(firstHeld ? { held: true } : {}) };
    } catch (error) {
      // A failed delivery does not count toward the limits: its own entry goes from the current windows.
      uncount();
      if (error instanceof Error && error.message === "Unknown method chatMessage") throw new Error("The target chat's host is too old; upgrade its host", { cause: error });
      // The target's restore waits for its owner: refused now, never delivered later.
      if (error instanceof Error && error.message === CHAT_PAUSED) throw new Error(`${key} is paused until the owner resumes it; the message was not delivered`, { cause: error });
      throw error;
    }
  }

  /**
   * `/pair`: start a reviewer Durable Chat in this Chat's workspace, as spawn_session does (the model asked for, thinking
   * low), and record the pairing in both records; `/pair stop` forgets it, and the reviewer Chat stays readable.
   */
  async #pair(ref: SessionRouteRef, args: string): Promise<ClientCommandResult> {
    const main = this.#record(ref);
    let command: ReturnType<typeof parsePairCommand>;
    try {
      command = parsePairCommand(args);
    } catch {
      return { type: "unsupported", message: PAIR_USAGE };
    }
    const pairing = main.liveReview;
    const reviewerName = (id: string) => this.deps.locator.durable(id)?.name ?? "the reviewer chat";
    if ("stop" in command) {
      if (pairing === undefined) return { type: "unsupported", message: "This chat has no live reviewer." };
      this.#unlink(main.id, pairing.reviewerId);
      return { type: "done", message: `Live review stopped; "${reviewerName(pairing.reviewerId)}" stays readable.` };
    }
    if (main.reviewing !== undefined) return { type: "unsupported", message: "This chat is a live reviewer; it cannot have one." };
    if (pairing !== undefined) return { type: "unsupported", message: `This chat already has a live reviewer, "${reviewerName(pairing.reviewerId)}"; /pair stop ends it first.` };
    const model = parseModelSpec(command.model);
    if (model === undefined) return { type: "unsupported", message: PAIR_USAGE };
    const connection = await this.#connection(main);
    // An older host would show the reviewer's messages as ordinary mail and drop the reviewer's brief.
    if (!connection.capabilities.includes("liveReview")) return { type: "unsupported", message: "Live review needs this chat's host to support it: upgrade host, then /pair again." };
    const { name } = await this.#chatIdentity(main, connection);
    const reviewer = await this.start(main.cwd);
    const reviewerRef = { id: reviewer.id, cwd: reviewer.cwd };
    try {
      if (!(await this.#for(reviewerRef)).capabilities.includes("liveReview")) {
        await this.stop(reviewerRef);
        this.deps.locator.remove(reviewer.id);
        return { type: "unsupported", message: "Live review needs the reviewer chat's host to support it: upgrade host, then /pair again." };
      }
      await this.setModel(reviewerRef, model.provider, model.modelId);
      await (await this.#for(reviewerRef)).request("setThinkingLevel", { level: "low" });
    } catch (error) {
      await this.stop(reviewerRef);
      this.deps.locator.remove(reviewer.id);
      throw error;
    }
    const title = `Live review · ${name}`.slice(0, CHECKPOINT_SESSION_TITLE_MAX_LENGTH);
    this.#setName(reviewer.id, title, "manual");
    const next: LiveReviewPairing = { reviewerId: reviewer.id, model: command.model, thinking: "low", trigger: command.trigger, brief: command.brief, turn: 0, digests: 0, startedAt: new Date(this.#now()).toISOString() };
    this.deps.locator.updateAll([[main.id, { liveReview: next }], [reviewer.id, { reviewing: main.id }]]);
    const record = this.deps.locator.durable(reviewer.id);
    if (record !== undefined) this.deps.events.publishGlobal({ type: "session.created", session: this.info(record) });
    this.deps.logger?.info?.({ sessionId: main.id, reviewerId: reviewer.id, model: command.model, trigger: command.trigger, brief: command.brief }, "live review started");
    return { type: "done", message: `Live review on: "${title}" reviews this chat with ${command.model} at thinking low, trigger ${command.trigger}, brief ${command.brief}. /pair stop ends it.` };
  }

  /** Run a pairing change after the ones before it for the same main Chat, so two `/pair` never start two reviewers. */
  #serializePairing<T>(mainId: string, change: () => Promise<T>): Promise<T> {
    const run = (this.#pairings.get(mainId) ?? Promise.resolve()).then(change, change);
    this.#pairings.set(mainId, run.catch(() => undefined));
    return run;
  }

  /**
   * An explicit end of either Chat ends its pairing (an idle close or a daemon restart keeps it). It waits behind the
   * main Chat's pairing changes, so a `/pair` still starting is undone, and a reviewer's end undoes only its own pair.
   */
  async #unpair(sessionId: string): Promise<void> {
    const mainId = this.deps.locator.durable(sessionId)?.reviewing ?? sessionId;
    await this.#serializePairing(mainId, () => {
      const reviewerId = this.deps.locator.durable(mainId)?.liveReview?.reviewerId;
      if (reviewerId !== undefined && (mainId === sessionId || reviewerId === sessionId)) this.#unlink(mainId, reviewerId);
      else if (mainId !== sessionId && this.deps.locator.durable(sessionId)?.reviewing === mainId) this.deps.locator.update(sessionId, { reviewing: undefined });
      return Promise.resolve();
    });
  }

  /** Forget a pairing in both records at once and drop its pending digest. */
  #unlink(mainId: string, reviewerId: string): void {
    this.deps.locator.updateAll([[mainId, { liveReview: undefined }], [reviewerId, { reviewing: undefined }]]);
    this.#liveReviews.delete(mainId);
    this.#reviewing.delete(reviewerId);
    this.deps.logger?.info?.({ sessionId: mainId, reviewerId }, "live review stopped");
  }

  /** A paired main Chat's event goes into its next digest; a reviewer's turn end lets the waiting digest go. */
  #liveReviewEvent(record: DurableChatRecord, event: { type: string }, connection: DurableHostConnection): void {
    if (record.reviewing !== undefined && event.type === "agent.end") {
      this.#reviewing.delete(record.id);
      void this.#sendDigest(record.reviewing);
    }
    const pairing = record.liveReview;
    if (pairing === undefined) return;
    if (event.type === "agent.start") this.deps.locator.update(record.id, { liveReview: { ...pairing, turn: pairing.turn + 1 } });
    let review = this.#liveReviews.get(record.id);
    if (review === undefined) this.#liveReviews.set(record.id, review = new LiveReviewCollector(pairing.trigger));
    const collector = review;
    // Each field through this main Chat host's redactor whole, before the digest cuts or escapes it.
    const redact = (text: string) => connection.request("redact", { text }).then(({ result }) => {
      if (typeof result !== "string") throw new Error("The host's redactor returned no text");
      return result;
    });
    const next = (this.#reviewEvents.get(record.id) ?? Promise.resolve()).then(async () => {
      await collector.add(event, redact);
      if (collector.due && this.#liveReviews.get(record.id) === collector) void this.#sendDigest(record.id);
    }).catch((error: unknown) => { this.deps.logger?.warn({ sessionId: record.id, err: error }, "live review event not collected"); });
    this.#reviewEvents.set(record.id, next);
  }

  /**
   * Send the main Chat's due digest to its reviewer as a waking chat message, unless the reviewer still works on the last
   * one: then it waits for the reviewer's turn end and covers everything since. Exempt from send_chat_message's limits.
   */
  async #sendDigest(mainId: string): Promise<void> {
    const main = this.deps.locator.durable(mainId);
    const pairing = main?.liveReview;
    const review = this.#liveReviews.get(mainId);
    if (main === undefined || pairing === undefined || review?.due !== true) return;
    const reviewer = this.deps.locator.durable(pairing.reviewerId);
    if (reviewer === undefined || this.#reviewing.has(reviewer.id) || this.#streaming.has(reviewer.id)) return;
    const digest = review.take();
    if (digest === undefined) return;
    const { text } = digest;
    this.#reviewing.add(reviewer.id);
    const number = pairing.digests + 1;
    this.deps.locator.update(mainId, { liveReview: { ...pairing, digests: number } });
    try {
      const connection = await this.#connection(reviewer);
      const from = await this.#chatIdentity(main, connection);
      await connection.request("chatMessage", {
        requestId: `live-review-digest-${String(number)}`, from: { chatId: main.id, ...from }, text, wake: true, urgent: false,
        liveReview: { kind: "digest", turn: Math.max(1, pairing.turn), trigger: pairing.trigger, brief: pairing.brief },
      });
      this.deps.logger?.info?.({ sessionId: mainId, reviewerId: reviewer.id, digest: number, turn: pairing.turn, length: text.length }, "live review digest sent");
    } catch (error) {
      // The reviewer did not take it: the next digest carries it.
      this.#reviewing.delete(reviewer.id);
      review.putBack(digest);
      this.deps.logger?.warn({ sessionId: mainId, reviewerId: reviewer.id, err: error }, "live review digest not delivered");
    }
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
    if (event.type === "durable.chat-message" || event.type === "durable.chat-list") {
      if (typeof event.requestId !== "string") return;
      // The sender is the Chat this connection belongs to, as the daemon records it; never who the host names.
      void this.#answerChatMessage(connection, record, event);
      return;
    }
    if (event.type === "durable.notification") {
      const generation = this.#notificationGenerations.get(sessionId);
      if (generation !== undefined) this.#publishNotifications(this.deps.notifications?.addNotification(generation, event.message, event.severity).mutations ?? []);
      return;
    }
    if (event.type === "status.update") {
      if (event.status.isStreaming) this.#streaming.add(sessionId);
      else this.#streaming.delete(sessionId);
      // A reviewer that went idle takes the live review digest that waited for it.
      if (!event.status.isStreaming && record.reviewing !== undefined) void this.#sendDigest(record.reviewing);
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
    this.#liveReviewEvent(record, event, connection);
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

/** How an upgrade closes the old host (see `#upgradeRestart`). */
type UpgradeClose = "upgrade" | "ifRestartSafe" | "plain";

/**
 * Why a pinned family cannot move to the current host code, undefined when it can: never to code that writes an older
 * store, by Pi Durable version or by Workbench store schema (after a roll back it cannot read a store newer code
 * opened; see `storeCodeRefusal`), nor when the version of either cannot be read.
 */
function hostMoveRefusal(code: DurableHostProcess["code"]): string | undefined {
  const [pinned, current] = [code?.entry, code?.current].map((entry) => (entry === undefined ? {} : storeCode(entry)));
  if (pinned?.durable === undefined || current?.durable === undefined) return "This Chat cannot move to new host code: the Pi Durable version of its host code cannot be read";
  return storeCodeRefusal(pinned, current);
}

/**
 * Why Upgrade now and the automatic upgrade cannot restart a pinned family, undefined when they can: only within one
 * Pi Durable version and one declared Workbench store schema, which needs no store migration, so a rollback only
 * restores the pin. Upgrade host (quiet) moves forward across them (see `hostMoveRefusal`).
 */
function restartRefusal(code: DurableHostProcess["code"]): string | undefined {
  const refusal = hostMoveRefusal(code);
  if (refusal !== undefined) return refusal;
  const [pinned, current] = [code?.entry, code?.current].map((entry) => (entry === undefined ? {} : storeCode(entry)));
  if (pinned?.durable !== current?.durable) return `This upgrade changes the store format (Pi Durable ${String(pinned?.durable)} to ${String(current?.durable)}); use Upgrade host when the Chat is quiet`;
  // Same Pi Durable, but a Workbench document or task at a new version is migrated too: the old code then refuses the store.
  return isSchema(pinned?.schema) && JSON.stringify(pinned.schema) === JSON.stringify(current?.schema) ? undefined : "This upgrade changes the store format (its Workbench store schema); use Upgrade host when the Chat is quiet";
}

function isSchema(schema: StoreCode["schema"]): schema is StoreSchema {
  return schema !== undefined && schema !== null;
}

/** A revision folder's short commit (installed folders are git worktrees), else its name. */
async function shortRevision(folder: string): Promise<string> {
  return run("git", ["-C", folder, "rev-parse", "--short", "HEAD"]).then(({ stdout }) => stdout.trim(), () => basename(folder));
}

/**
 * Whether an automatic upgrade (B) may restart the family now: nothing runs or waits except work that survives a host
 * restart unchanged (open questions, background bash, watchers, Atelier Pages).
 */
function restartSafe(status: HostTranscript["status"]): boolean {
  return !status.isStreaming && !status.isCompacting && !status.isBashRunning && status.pendingMessageCount === 0
    && (status.activeToolExecutions?.length ?? 0) === 0 && !childrenRunning(status);
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
/** send_chat_message from a Durable Chat's lead: deliver to another Chat, answered with `chatMessaged`. */
interface HostChatMessageEvent { type: "durable.chat-message"; requestId: string; chat: unknown; text: unknown; wake?: unknown; urgent?: unknown }
/** send_chat_message's list of other Chats, answered with `chatMessaged`. */
interface HostChatListEvent { type: "durable.chat-list"; requestId: string }
type HostEvent = HostAttentionEvent | HostNotificationEvent | HostSpawnEvent | HostChatMessageEvent | HostChatListEvent;
interface ChatMessageResult { chatId: string; key: string; name: string; delivery: "started" | "queued" | "steered" | "noted"; hop?: number; held?: true }
interface ChatListEntry { id: string; key: string; title: string; cwd: string; state: "running" | "idle" | "closed" }

const CHAT_MESSAGE_MAX_LENGTH = 8000;
const CHAT_LIST_LIMIT = 15;
/** The loop guard: a chat sends to one target at most this many times in any rolling window. */
const CHAT_MESSAGE_LIMIT = 2;
const CHAT_MESSAGE_WINDOW_MS = 5 * 60_000;
const CHAT_MESSAGE_HOURLY_LIMIT = 10;
const CHAT_MESSAGE_HOUR_MS = 60 * 60_000;
const CHAT_MESSAGE_HOP_LIMIT = 6;
const CHAT_KEY_STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "its", "of", "on", "or", "the", "this", "that", "to", "via", "vs", "with"]);

/** The Durable host's refusal of a chat message while its restore waits for the owner (pi-workbench `chat-message.ts`). */
const CHAT_PAUSED = "The chat is paused until the owner resumes it; the message was not delivered";

/**
 * A chat's 3-word key: the first 3 significant ASCII words of its title, then of its first message, joined by hyphens;
 * `chat-<first 8 hex of the ID>` when neither has any; `-2`, `-3`… when taken.
 */
export function chatKey(record: Pick<DurableChatRecord, "id" | "firstMessage"> & { name?: string }, taken: ReadonlySet<string>): string {
  const words = (text: string) => text.normalize("NFKD").replace(/[^\x20-\x7e]/gu, "").toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word !== "" && !CHAT_KEY_STOP_WORDS.has(word));
  const picked = [...words(record.name ?? ""), ...words(record.firstMessage)].slice(0, 3);
  const base = picked.length === 0 ? `chat-${record.id.replace(/-/gu, "").slice(0, 8)}` : picked.join("-");
  let key = base;
  for (let suffix = 2; taken.has(key); suffix++) key = `${base}-${String(suffix)}`;
  return key;
}

/** Up to 3 keys sharing the most words with `name` (a word matches on its first 4 letters, so plurals match). */
function closeChatKeys(name: string, keys: readonly string[]): string[] {
  const stems = (key: string) => key.split("-").map((word) => word.slice(0, 4));
  const wanted = new Set(stems(name));
  return keys.map((key) => ({ key, score: stems(key).filter((stem) => wanted.has(stem)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, 3)
    .map(({ key }) => key);
}

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
