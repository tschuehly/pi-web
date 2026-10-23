import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
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
import { appendInlineImageReferenceMapping, CHECKPOINT_SESSION_TITLE_MAX_LENGTH, CHECKPOINT_TITLE_COMMAND, parseModelSpec } from "./piSessionService.js";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import { cleanSessionName, fallbackSessionName, SESSION_TITLE_SYSTEM_PROMPT, sessionTitleInput, shortSessionNamePrompt } from "./sessionNameGenerator.js";
import type { SessionNotificationGeneration, SessionNotificationMutation, SessionNotificationStore } from "./sessionNotificationStore.js";
import { isWorkstreamLaunchToken, type WorkstreamLaunchStore } from "./workstreamLaunchStore.js";
import { PendingAskStore, renderAskUserAnswersText, renderOpenAsksReminder, type PendingAskCloseResult } from "./pendingAskStore.js";
import type { DurableChatRecord, SessionRuntimeLocator } from "./sessionRuntimeLocator.js";
import type { SessionRouteRef } from "./sessionService.js";

/** The session-host protocol version this daemon speaks (Workbench `chat-session.ts` `PROTOCOL`). */
export const DURABLE_HOST_PROTOCOL = 2;

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
}

/** Starts the host process that owns one Chat family's store. */
export type DurableHostLauncher = (record: DurableChatRecord, storeDir: string) => DurableHostProcess;

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
export function forkDurableHost(options: { entry: string; model: string; agentDir: string; scripted?: boolean; thinkingLevel?: (cwd: string, model: string) => string }): DurableHostLauncher {
  return (record, storeDir) => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(storeDir, "host.log"), "a", 0o600);
    try {
      // No inherited loader flags (tsx): the host is plain Node with type stripping and its own pinned dependencies.
      // A new Chat starts at the thinking level Pi would pick; a reopened one keeps its own (the host ignores this).
      const thinking = options.thinkingLevel ?? ((cwd: string, model: string) => durableThinkingLevel(cwd, options.agentDir, model));
      return fork(options.entry, durableHostArgs(record, storeDir, { ...options, thinking: thinking(record.cwd, options.model) }), {
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
  publishGlobal(event: { type: "status.update"; status: SessionStatus } | { type: "activity.update"; activity: { sessionId: string; phase: "active" | "idle" | "error"; label: string; at: string } } | { type: "session.name"; sessionId: string; name?: string } | SessionAttentionEvent): void;
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
  /**
   * The gated operations the host names in its ready message (Workbench `chat-session.ts` `CAPABILITIES`, names from
   * `CHAT_CAPABILITY_LABELS`); none when it reports no list. Each one is refused and its control hidden until named.
   */
  capabilities: ChatCapability[] = [];
  /** Skills and prompts the host's Pi packages contributed (`resources_discover`), named in its ready message. */
  contributed: DurableContributedResources = { skillPaths: [], promptPaths: [] };
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
   * so a host opened next for the same store never meets its lock.
   */
  async close(graceMs: number): Promise<void> {
    if (!this.alive) return;
    const terminate = setTimeout(() => { this.process.kill("SIGTERM"); }, graceMs);
    const kill = setTimeout(() => { this.process.kill("SIGKILL"); }, 2 * graceMs);
    try {
      await this.request("close");
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
    logger?: { warn(object: object, message: string): void };
    /** Stop's wait before SIGTERM, and again before SIGKILL; default 5 s. */
    closeGraceMs?: number;
  }) {}

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

  owns(sessionId: string): boolean {
    return this.deps.locator.durable(sessionId) !== undefined;
  }

  /**
   * A Workstream launch token is reserved before the Chat exists and bound to it once its host runs, as for legacy
   * Chats: a retried launch looks the token up instead of creating a second Chat.
   */
  async start(cwd: string, startupToken?: string): Promise<ClientSession> {
    const launch = startupToken !== undefined && isWorkstreamLaunchToken(startupToken) ? startupToken : undefined;
    const launches = this.deps.launches;
    if (launch !== undefined) {
      if (launches === undefined) throw new Error("Workstream launch tracking is unavailable");
      await launches.reserve(launch, canonicalizeStoredCwd(cwd));
    }
    const record = this.deps.locator.create(cwd);
    try {
      await this.#connection(record);
    } catch (error) {
      this.deps.locator.remove(record.id);
      throw error;
    }
    if (launch !== undefined) await launches?.confirm(launch, canonicalizeStoredCwd(cwd), record.id);
    return { ...this.info(record), ...(startupToken === undefined ? {} : { startupToken }) };
  }

  /** The Durable Chat a launch token created in this workspace; undefined when it names none (ask legacy Chats). */
  async lookupWorkstreamLaunch(token: string, cwd: string): Promise<{ status: "found"; sessionId: string; cwd: string } | undefined> {
    const record = await this.deps.launches?.lookup(token);
    if (record?.status !== "created" || !this.owns(record.sessionId) || !cwdPathsEqual(record.cwd, cwd)) return undefined;
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
      { name: "mode", description: "Choose Working Mode guidance for the next prompt; /mode send delivers it now", source: "extension" as const },
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
   * prompt's first words. ponytail: no goal title after five prompts yet (legacy `auto-final`).
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
    }).then((name) => {
      this.#titling.delete(record.id);
      this.#applyGeneratedName(record.id, name ?? fallbackSessionName(titleText), "auto", undefined);
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
    await (await connection?.catch(() => undefined))?.close(this.deps.closeGraceMs ?? 5000);
  }

  async dispose(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map(async (connection) => (await connection.catch(() => undefined))?.close(this.deps.closeGraceMs ?? 5000)));
  }

  #for(ref: SessionRouteRef): Promise<DurableHostConnection> {
    return this.#connection(this.#record(ref));
  }

  #connection(record: DurableChatRecord): Promise<DurableHostConnection> {
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
    const connection = new DurableHostConnection(
      this.deps.launch(record, storeDir),
      (event) => { this.#onEvent(record.id, event, connection); },
      () => this.deps.events.currentSeq(record.id),
      (error) => {
        this.#connections.delete(record.id);
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat host exited");
        void this.#unread(record, "closed");
        this.deps.events.publish(record.id, { type: "agent.end" });
      },
      (error) => { this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat host process error"); },
    );
    const opened = connection.ready.then(async () => {
      this.#capabilities.set(record.id, connection.capabilities);
      const loaded = await this.deps.resources?.(record.cwd, connection.contributed).catch((error: unknown) => {
        this.deps.logger?.warn({ sessionId: record.id, err: error }, "Durable Chat resources failed to load");
        return undefined;
      });
      if (loaded !== undefined) {
        this.#skills.set(record.id, loaded.skillList);
        this.#templates.set(record.id, loaded.promptList ?? []);
        await connection.request("configure", { resources: loaded.resources, compaction: loaded.compaction });
      }
      return connection;
    });
    this.#connections.set(record.id, opened);
    opened.catch(() => { if (this.#connections.get(record.id) === opened) this.#connections.delete(record.id); });
    return opened;
  }

  #activity(sessionId: string, scope: { id: string; cwd: string }, phase: "active" | "idle" | "error", label: string): void {
    const activity = { sessionId, phase, label, at: new Date().toISOString() };
    this.deps.events.publish(sessionId, { type: "activity.update", activity }, scope);
    this.deps.events.publishGlobal({ type: "activity.update", activity });
  }

  #onEvent(sessionId: string, event: SessionUiEvent | HostEvent, connection: DurableHostConnection): void {
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
    if (event.type === "durable.notification") {
      const generation = this.#notificationGenerations.get(sessionId);
      if (generation !== undefined) this.#publishNotifications(this.deps.notifications?.addNotification(generation, event.message, event.severity).mutations ?? []);
      return;
    }
    if (event.type === "status.update") {
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
    ...(connection.capabilities.includes("queue.edit") ? {} : { queueMessageActionsUnavailable: "Editing queued messages is not available in this Durable Chat host yet." }),
  };
}

/** A host-side notification request: the daemon turns it into PI WEB's global `session.attention`. */
interface HostAttentionEvent { type: "durable.attention"; kind: "ask" | "attention"; id: string; detail: string }
/** A Pi package's warning or error outside a command: kept in the Chat's notification inbox, as in a legacy Chat. */
interface HostNotificationEvent { type: "durable.notification"; severity: "warning" | "error"; message: string }
type HostEvent = HostAttentionEvent | HostNotificationEvent;

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
