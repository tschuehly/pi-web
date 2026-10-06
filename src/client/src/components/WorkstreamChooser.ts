import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { pluginsApi, sessionsApi, workspacesApi } from "../api/clients";
import { requestPairedPluginBackend } from "../api/pluginBackends";
import { parseBoundedPluginBackendJson } from "../../../shared/pluginBackendProtocol";
import type { SessionActivity, SessionInfo, SessionStatus, Workspace } from "../api";
import { isSessionActive, sessionActivityText } from "../../../shared/activity";
import { renderActivityIndicator } from "./activityBadge";
import { listStyles } from "./shared";
import { WORKSTREAM_TINT_PERCENTAGES, workstreamAccentColor, workstreamMonogram } from "../workstreamColor";

// Workstream re-entry view backed by the user-local Workbench plugin service.

export type WorkstreamWaitingOn = "owner" | "agent" | "external";
export interface WorkstreamCheckpoint {
  id: string; whatChanged: string; remains: string; next: string; references?: string[]; recordedAt: string;
  /** Who the Workstream waits on after this checkpoint; the newest checkpoint's value is current. */
  waitingOn?: WorkstreamWaitingOn | null;
  /** Legacy continuation prompt; new checkpoints project null and PI WEB never preloads it. */
  nextSessionPrompt?: string | null;  /** Title (≤ 80 chars) for the checkpointing Chat; PI WEB applies it unless the owner named that Chat. */
  sessionTitle?: string | null;
}
export interface WorkstreamSession { id: string; status: string; machineId?: string; projectId?: string; workspaceId?: string; latestCheckpoint: WorkstreamCheckpoint | null }
export interface WorkstreamOverview { goal: string; doneWhen: string; description: string; history: string[]; recordedAt: string }
type HumanTaskAnswerKind = "yes-no" | "choice" | "free-text";
type HumanTaskAnswer = { kind: "yes-no" | "choice"; optionId: string } | { kind: "free-text"; text: string };
export type WorkstreamSessionAnchor = { machineId: string; projectId: string; workspaceId: string } | { machineId?: never; projectId?: never; workspaceId?: never };
export type WorkstreamAppendRecord =
  | { type: "title.set"; producer: "owner"; sourceSessionId?: string; payload: { title: string } }
  | { type: "checkpoint.replaced"; producer: "owner"; sourceSessionId: string; payload: { sessionId: string; checkpoint: { id: string; whatChanged: string; remains: string; next: string; waitingOn?: WorkstreamWaitingOn; references?: string[]; sessionTitle?: string } } }
  | { type: "human-task.answered"; producer: "owner"; sourceSessionId?: string; payload: { taskId: string; answerId: string; answer: HumanTaskAnswer } }
  | { type: "session.pending"; producer: "pi-web"; sourceSessionId?: string; payload: { associationKey: string; derivationKind?: "checkpoint" } & WorkstreamSessionAnchor }
  | { type: "session.confirmed"; producer: "pi-web"; sourceSessionId: string; payload: { sessionId: string; associationKey: string } & WorkstreamSessionAnchor };
export interface WorkstreamAppendInput { workstreamId: string; expectedRevision: number; idempotencyKey: string; records: WorkstreamAppendRecord[] }
interface WorkstreamHumanTask {
  id: string; title: string; detail?: string; status: "pending" | "answered" | "resolved";
  answerKind: HumanTaskAnswerKind | null;
  options: { id: string; label: string }[];
  sourceSessionId: string | null;
}
export interface WorkstreamSnapshot {
  id: string; title: string; revision: number; updatedAt: string; closed: boolean;
  sessions: WorkstreamSession[];
  humanTasks: WorkstreamHumanTask[];
  links: { id: string; kind: string; reference: string; label?: string }[];
  overview: WorkstreamOverview | null;
}
export interface WorkstreamSummary {
  id: string; title: string; group: string | null; createdAt: string; updatedAt: string; lastCheckpointAt: string | null; unresolvedHumanTaskCount: number;
  /** Newest checkpoint's next move and waiting actor; absent from older Workbench services. */
  next?: string | null; waitingOn?: WorkstreamWaitingOn | null;
}
export interface WorkstreamListQuery { includeClosed?: boolean; sessionId?: string }

export interface OpenWorkstreamSessionDetail {
  workstreamId: string;
  sessionId: string;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  /** Absolute directories from the newest checkpoint, most likely first. */
  directories: string[];
}

export interface StartWorkstreamSessionDetail {
  workstreamId: string;
  directories: string[];
  sessionId?: string;
  useSelectedWorkspace?: boolean;
}

export interface WorkstreamServiceContext { machineId: string; projectId: string; workspaceId: string }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export class WorkstreamServiceError extends Error {
  constructor(message: string, readonly code: string, readonly details?: unknown) { super(message); }
}
const lifecycleByMachine = new Map<string, { expires: number; promise: ReturnType<typeof pluginsApi.plugins> }>();
async function service<T>(context: WorkstreamServiceContext, operation: string, input: unknown, check: (value: unknown) => value is T): Promise<T> {
  let cached = lifecycleByMachine.get(context.machineId);
  if (cached === undefined || cached.expires < Date.now()) {
    const promise = pluginsApi.plugins(context.machineId);
    cached = { expires: Date.now() + 60_000, promise };
    lifecycleByMachine.set(context.machineId, cached);
    void promise.catch(() => { if (lifecycleByMachine.get(context.machineId)?.promise === promise) lifecycleByMachine.delete(context.machineId); });
  }
  const lifecycle = await cached.promise;
  const plugin = lifecycle.plugins.find((candidate) => candidate.id === "pi-workbench");
  const revision = plugin?.server?.activeRevision;
  if (plugin?.server?.state !== "active" || revision === undefined) {
    throw new Error(plugin?.server?.message ?? "The Workstream service is not active. Restart the session runtime after installing the Workbench plugin.");
  }
  const encodedInput = JSON.stringify(input);
  let body: unknown;
  try {
    body = await requestPairedPluginBackend({ pluginId: "pi-workbench", backendRevision: revision, ...context }, operation, parseBoundedPluginBackendJson(encodedInput, `Workstream ${operation} input`));
  } catch (error) {
    lifecycleByMachine.delete(context.machineId);
    throw error;
  }
  if (!isRecord(body) || typeof body["ok"] !== "boolean") throw new Error(`Workstream service returned an invalid ${operation} response.`);
  if (!body["ok"]) {
    const failure = body["error"];
    throw new WorkstreamServiceError(isRecord(failure) && typeof failure["message"] === "string" ? failure["message"] : `Workstream ${operation} failed.`, isRecord(failure) && typeof failure["code"] === "string" ? failure["code"] : "UNKNOWN", isRecord(failure) ? failure["details"] : undefined);
  }
  const value: unknown = body["value"];
  if (!check(value)) throw new Error(`Workstream service returned an invalid ${operation} response.`);
  return value;
}
const isSummaryList = (value: unknown): value is WorkstreamSummary[] => Array.isArray(value);
const isSnapshot = (value: unknown): value is WorkstreamSnapshot => isRecord(value) && Array.isArray(value["sessions"]) && Array.isArray(value["humanTasks"]);
const isReceipt = (value: unknown): value is { acceptedRevision: number } => isRecord(value) && Number.isInteger(value["acceptedRevision"]);
export const listWorkstreams = (context: WorkstreamServiceContext, query: WorkstreamListQuery = {}): Promise<WorkstreamSummary[]> => service(context, "list", query, isSummaryList);
export const inspectWorkstream = (context: WorkstreamServiceContext, workstreamId: string): Promise<WorkstreamSnapshot> => service(context, "inspect", { workstreamId }, isSnapshot);
export const watchWorkstreams = (context: WorkstreamServiceContext, afterSequence: number): Promise<{ nextSequence: number }> => service(context, "watch", { afterSequence }, (value): value is { nextSequence: number } => isRecord(value) && Number.isSafeInteger(value["nextSequence"]) && typeof value["nextSequence"] === "number" && value["nextSequence"] >= 0 && (value["mode"] === "snapshot" && Array.isArray(value["snapshots"]) || value["mode"] === "replay" && Array.isArray(value["events"])));
export const appendWorkstream = (context: WorkstreamServiceContext, input: WorkstreamAppendInput): Promise<{ acceptedRevision: number }> => service(context, "append", input, isReceipt);
export async function workstreamForSession(context: WorkstreamServiceContext, sessionId: string): Promise<WorkstreamSnapshot | null> {
  const matches = await listWorkstreams(context, { sessionId, includeClosed: true });
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error(`Session ${sessionId} has more than one Workstream association.`);
  const match = matches[0];
  return match === undefined ? null : inspectWorkstream(context, match.id);
}
const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
export const groupMatchesProject = (group: string, project: string | undefined): boolean => project === undefined || normalize(group) === normalize(project);
export const ago = (value: string, now = Date.now()): string => {
  const hours = Math.round((now - new Date(value).getTime()) / 36e5);
  return hours < 1 ? "just now" : hours < 24 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
};
export const actor = (text: string): string => (/^\s*(Thomas|Rod|Pia)\b/.exec(text) ?? [])[1] ?? (/\bThomas\b/.test(text) ? "Thomas" : "Pia");
export type WorkstreamAttention = WorkstreamWaitingOn | "dormant";
const attentionLabels: Record<WorkstreamAttention, string> = { owner: "Waiting on you", agent: "Agent can continue", external: "Waiting on someone else", dormant: "Dormant" };
const DORMANT_MS = 7 * 864e5;
/** Dormant after 7 idle days; otherwise the recorded waitingOn, or the actor named by a legacy next move. */
export function attentionOf(summary: WorkstreamSummary, now = Date.now()): WorkstreamAttention | undefined {
  if (now - new Date(summary.lastCheckpointAt ?? summary.createdAt).getTime() > DORMANT_MS) return "dormant";
  if (summary.waitingOn !== undefined && summary.waitingOn !== null && Object.hasOwn(attentionLabels, summary.waitingOn)) return summary.waitingOn;
  if (summary.next === undefined || summary.next === null) return undefined;
  const who = actor(summary.next);
  return who === "Thomas" ? "owner" : who === "Rod" ? "external" : "agent";
}
export const firstClause = (text: string, max = 110): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = new RegExp(`^(.{1,${String(max)}}?[.;:])(\\s|$)`).exec(clean);
  const cut = match?.[1] ?? clean.slice(0, max);
  return cut + (cut.length < clean.length ? "…" : "");
};

/** Newest checkpoint per session, newest first. Two sessions within 36 h count as a conflict. */
export function latestCheckpoints(snapshot: WorkstreamSnapshot): (WorkstreamSession & { latestCheckpoint: WorkstreamCheckpoint })[] {
  return snapshot.sessions
    .filter((session): session is WorkstreamSession & { latestCheckpoint: WorkstreamCheckpoint } => session.latestCheckpoint !== null)
    .sort((a, b) => b.latestCheckpoint.recordedAt.localeCompare(a.latestCheckpoint.recordedAt));
}
/** Latest known activity: the newer of the checkpoint time and the session's UUIDv7 creation time. */
export function sessionActivityTime(session: WorkstreamSession): number {
  const hex = session.id.replace(/-/g, "");
  const created = /^[0-9a-f]{12}7/i.test(hex) ? parseInt(hex.slice(0, 12), 16) : 0;
  const checkpoint = session.latestCheckpoint === null ? 0 : new Date(session.latestCheckpoint.recordedAt).getTime();
  return Math.max(created, Number.isNaN(checkpoint) ? 0 : checkpoint);
}
export const sessionsByActivity = (sessions: WorkstreamSession[]): WorkstreamSession[] => [...sessions].sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a));
const githubUrl = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/g;
const shortReference = /(?<![\w/.@-])([a-z][\w.-]*)#(\d+)\b/g;
export interface WorkstreamReference { key: string; url: string; kind: "PR" | "Issue" | "PR or issue" }
/** GitHub PRs and issues named by checkpoints and links; `repo#N` resolves its owner from a full URL for the same repo. */
export function referencesOf(snapshot: WorkstreamSnapshot): WorkstreamReference[] {
  const text = [
    ...latestCheckpoints(snapshot).flatMap(({ latestCheckpoint: cp }) => [cp.whatChanged, cp.remains, cp.next, ...(cp.references ?? [])]),
    ...snapshot.links.flatMap((link) => [link.reference, link.label ?? ""]),
  ].join("\n");
  const owners = new Map<string, string>();
  const found = new Map<string, WorkstreamReference>();
  for (const [, owner = "", repo = "", kind, number = ""] of text.matchAll(githubUrl)) {
    owners.set(repo, owner);
    const key = `${repo}#${number}`;
    if (!found.has(key)) found.set(key, { key, url: `https://github.com/${owner}/${repo}/${kind ?? "issues"}/${number}`, kind: kind === "pull" ? "PR" : "Issue" });
  }
  for (const [, repo = "", number = ""] of text.replace(githubUrl, "").matchAll(shortReference)) {
    const key = `${repo}#${number}`;
    const owner = owners.get(repo);
    // GitHub redirects /issues/N to /pull/N, so one URL serves both kinds.
    if (!found.has(key)) found.set(key, { key, url: owner === undefined ? `https://github.com/search?type=issues&q=${encodeURIComponent(key)}` : `https://github.com/${owner}/${repo}/issues/${number}`, kind: "PR or issue" });
  }
  return [...found.values()];
}

export function isTemporaryDirectory(value: string): boolean {
  return /^(?:\/private)?\/(?:tmp|var\/tmp|var\/folders)(?:\/|$)/.test(value)
    || /^(?:[A-Za-z]:[\\/])(?:Users[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Temp|Temp)(?:[\\/]|$)/i.test(value);
}

export function directoriesOf(checkpoint: WorkstreamCheckpoint | undefined): string[] {
  // ponytail: path kind is heuristic because the browser cannot stat local references.
  const absolute = (checkpoint?.references ?? []).filter((ref) => ref.startsWith("/") && !isTemporaryDirectory(ref));
  const files = absolute.filter((ref) => /\.[a-z0-9]{1,5}$/i.test(ref));
  const directories = absolute.filter((ref) => !files.includes(ref));
  if (directories.length > 0) return [...new Set(directories)];
  return [...new Set(files.map((ref) => ref.slice(0, ref.lastIndexOf("/")) || "/"))];
}

/** The exact row for one Chat in one cwd; an older daemon ignores `sessionId` and returns its whole catalog. */
const targetedChat = (id: string, cwd: string, machineId: string, signal: AbortSignal): Promise<SessionInfo | undefined> =>
  sessionsApi.sessions(cwd, machineId, { sessionId: id, signal }).then((rows) => rows.find((row) => row.id === id && row.cwd === cwd), () => undefined);

/**
 * Settles like `start()`, but starts nothing once `signal` has aborted and rejects as soon as it aborts, so an abandoned
 * lookup frees its slot at once and issues no further request.
 */
function unlessAborted<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(new Error("Chat lookup aborted")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void start().then(resolve, reject).finally(() => { signal.removeEventListener("abort", abort); });
  });
}

/**
 * PI WEB metadata for one Workstream Chat on this machine: the recorded workspace's targeted row first, then the cwd the
 * daemon locates. Nothing is rebuilt from status. Once `signal` aborts, no step starts and the open request closes;
 * the daemon may still finish read-only work it had already begun. `workspacesOf` requests are shared and owned by
 * the caller.
 */
async function workstreamChatInfo(session: WorkstreamSession, machineId: string, workspacesOf: (projectId: string) => Promise<readonly Workspace[]>, signal: AbortSignal): Promise<SessionInfo | undefined> {
  const step = <T>(start: () => Promise<T>): Promise<T> => unlessAborted(start, signal);
  const { projectId, workspaceId } = session;
  let anchoredCwd: string | undefined;
  if (projectId !== undefined && workspaceId !== undefined) {
    const workspaces = await step(() => workspacesOf(projectId).catch((): Workspace[] => []));
    const cwd = workspaces.find((workspace) => workspace.id === workspaceId)?.path;
    const row = cwd === undefined ? undefined : await step(() => targetedChat(session.id, cwd, machineId, signal));
    if (row !== undefined) return row;
    anchoredCwd = cwd;
  }
  const cwd = await step(() => sessionsApi.locate(session.id, machineId, { signal }).then((located) => located.cwd, () => undefined));
  return cwd === undefined || cwd === anchoredCwd ? undefined : step(() => targetedChat(session.id, cwd, machineId, signal));
}

/** A Chat record's lookup identity: its id and recorded anchors, so an anchor repair never reuses another record's row. */
const chatKey = (session: WorkstreamSession): string => JSON.stringify([session.id, session.machineId ?? null, session.projectId ?? null, session.workspaceId ?? null]);
/** Chats shown before the "older Chats" fold; older ones are looked up only once the fold opens. */
const VISIBLE_CHATS = 5;
/**
 * Component-wide ceiling on open Chat metadata requests. Each running lookup issues one request at a time, and a
 * retained workspace request no running lookup waits on holds a slot of its own.
 */
const CHAT_LOOKUP_LIMIT = 8;
interface ChatLookup { session: WorkstreamSession; machineId: string; controller: AbortController; running: boolean }
/**
 * One project's workspace request, shared by lookups and aborted once no queued or running lookup needs it. `waiting`
 * counts running lookups that joined it and have not finished.
 */
interface ProjectWorkspaces { promise: Promise<readonly Workspace[]>; controller: AbortController; settled: boolean; waiting: number }

@customElement("workstream-chooser")
export class WorkstreamChooser extends LitElement {
  /** PI WEB project name; only Workstream groups equal to it (case- and punctuation-insensitive) are shown. */
  @property() project: string | undefined;
  @property() serviceMachineId = "";
  @property() serviceProjectId = "";
  @property() serviceWorkspaceId = "";
  /** Project names whose Workstreams are hidden here; used by the Other tab to show the rest. */
  @property({ attribute: false }) excludeProjects: string[] = [];
  /** Whether the project tab currently has a selected workspace for a Workstream's first Chat. */
  @property({ type: Boolean }) canStartEmpty = false;
  /** Live per-session state, keyed by session id, buffered by the daemon events socket. */
  @property({ attribute: false }) sessionStatuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) sessionActivities: Record<string, SessionActivity> = {};
  @state() private summaries: WorkstreamSummary[] = [];
  @state() private selected: WorkstreamSnapshot | undefined;
  @state() private error = "";
  @state() private notice = "";
  @state() private loading = true;
  @state() private liveWorkstreamIds = new Set<string>();
  /** PI WEB session metadata for this machine, keyed by `chatKey`, for Chat titles. */
  @state() private chatInfo = new Map<string, SessionInfo>();
  /** Chat records whose lookup finished without a row; other eligible Chats without metadata show as loading. */
  @state() private chatMisses = new Set<string>();
  /** Queued and running Chat lookups by `chatKey`, so reopening a card joins them instead of repeating them. */
  private readonly chatLookups = new Map<string, ChatLookup>();
  /** Wanted lookups waiting for one of the `CHAT_LOOKUP_LIMIT` slots, in display order. */
  private chatQueue: string[] = [];
  private runningLookups = 0;
  /** Workspace requests shared by current lookups, by project id. */
  private readonly cardWorkspaces = new Map<string, ProjectWorkspaces>();
  /** Async results apply only while their machine, load, and card selection are still current. */
  private machineEpoch = 0;
  private loadSequence = 0;
  private selection = 0;
  private liveSessionKey = "";
  private readonly workstreamBySession = new Map<string, Promise<string | undefined>>();

  private get serviceContext(): WorkstreamServiceContext | undefined {
    return this.serviceMachineId === "" || this.serviceProjectId === "" || this.serviceWorkspaceId === ""
      ? undefined
      : { machineId: this.serviceMachineId, projectId: this.serviceProjectId, workspaceId: this.serviceWorkspaceId };
  }

  private async load(): Promise<void> {
    const sequence = ++this.loadSequence;
    const context = this.serviceContext;
    if (context === undefined) return;
    this.loading = true;
    try {
      const list = await listWorkstreams(context);
      if (sequence === this.loadSequence) this.summaries = this.sortedSummaries(list);
    } catch (error) {
      if (sequence === this.loadSequence) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === this.loadSequence) this.loading = false;
    }
  }

  /**
   * A pending inspection belongs to the service scope it was asked in. Workstreams, Chat metadata, and live associations
   * belong to one machine; a machine switch forgets them, the open card, and aborts its Chat lookups.
   */
  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("serviceMachineId") || changed.has("serviceProjectId") || changed.has("serviceWorkspaceId")) this.selection++;
    if (!changed.has("serviceMachineId")) return;
    this.machineEpoch++;
    this.selected = undefined;
    this.summaries = [];
    this.error = "";
    this.notice = "";
    this.chatInfo = new Map();
    this.chatMisses = new Set();
    this.wantChats([], () => false);
    this.workstreamBySession.clear();
    this.liveSessionKey = "";
    this.liveWorkstreamIds = new Set();
  }

  /** A detached chooser closes its Chat metadata requests; reattached, it starts with no card open. */
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.selection++;
    this.selected = undefined;
    this.wantChats([], () => false);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("serviceMachineId") || changed.has("serviceProjectId") || changed.has("serviceWorkspaceId")) void this.load();
    if (changed.has("serviceMachineId") || changed.has("sessionStatuses") || changed.has("sessionActivities")) void this.resolveLiveWorkstreams();
  }

  private async resolveLiveWorkstreams(): Promise<void> {
    const sessionIds = [...new Set([...Object.keys(this.sessionStatuses), ...Object.keys(this.sessionActivities)])]
      .filter((id) => isSessionActive(this.sessionStatuses[id], this.sessionActivities[id]))
      .sort();
    const key = sessionIds.join("\0");
    if (key === this.liveSessionKey) return;
    this.liveSessionKey = key;
    const epoch = this.machineEpoch;
    const workstreamIds = await Promise.all(sessionIds.map((sessionId) => {
      const cached = this.workstreamBySession.get(sessionId);
      if (cached !== undefined) return cached;
      // A failed or unmatched lookup is forgotten so a later render can retry it; a match is kept.
      const context = this.serviceContext;
      if (context === undefined) return Promise.resolve(undefined);
      const lookup = listWorkstreams(context, { sessionId, includeClosed: true })
        .then((matches) => matches.length === 1 ? matches[0]?.id : undefined)
        .catch(() => undefined)
        .then((id) => { if (id === undefined && this.workstreamBySession.get(sessionId) === lookup) this.workstreamBySession.delete(sessionId); return id; });
      this.workstreamBySession.set(sessionId, lookup);
      return lookup;
    }));
    if (key === this.liveSessionKey && epoch === this.machineEpoch) this.liveWorkstreamIds = new Set(workstreamIds.filter((id): id is string => id !== undefined));
  }

  private async select(id: string): Promise<void> {
    this.notice = "";
    const selection = ++this.selection;
    if (this.selected?.id === id) { this.selected = undefined; this.wantChats([]); return; }
    try {
      const context = this.serviceContext;
      if (context === undefined) throw new Error("Choose a workspace before opening a Workstream.");
      const snapshot = await inspectWorkstream(context, id);
      if (selection !== this.selection) return;
      this.selected = snapshot;
      this.error = "";
      this.loadChatNames(snapshot);
    } catch (error) {
      if (selection === this.selection) this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private sortedSummaries(list: WorkstreamSummary[]): WorkstreamSummary[] {
    return [...list].sort((a, b) => (b.lastCheckpointAt ?? b.createdAt).localeCompare(a.lastCheckpointAt ?? a.createdAt));
  }

  /** Only active Chats recorded on this machine, or on no machine, have PI WEB metadata to look up. */
  private chatEligible(session: WorkstreamSession): boolean {
    return session.status === "active" && (session.machineId === undefined || session.machineId === this.serviceMachineId);
  }

  /**
   * Look up the opened card's visible Chats; older ones wait for the fold to open. Reopening a card retries its misses,
   * and a new card takes over the slots of lookups it does not share.
   */
  private loadChatNames(snapshot: WorkstreamSnapshot): void {
    const keys = new Set(snapshot.sessions.map(chatKey));
    // A newly opened card reads fresh workspaces, but joins a request still in flight.
    for (const [projectId, shared] of this.cardWorkspaces) if (shared.settled) this.cardWorkspaces.delete(projectId);
    if ([...this.chatMisses].some((key) => keys.has(key))) this.chatMisses = new Set([...this.chatMisses].filter((key) => !keys.has(key)));
    this.wantChats(sessionsByActivity(snapshot.sessions).slice(0, VISIBLE_CHATS), (key) => keys.has(key));
  }

  /**
   * Make `sessions` the wanted lookups, in display order. Queued lookups nobody wants are dropped; running ones finish
   * and stay cached unless `keepRunning` refuses them, which aborts them and frees their slots. A shared project
   * workspace request is aborted once no remaining lookup belongs to its project.
   */
  private wantChats(sessions: readonly WorkstreamSession[], keepRunning: (key: string) => boolean = () => true): void {
    const wanted = new Map<string, WorkstreamSession>();
    for (const session of sessions) {
      const key = chatKey(session);
      if (this.chatEligible(session) && !this.chatInfo.has(key) && !this.chatMisses.has(key)) wanted.set(key, session);
    }
    for (const [key, lookup] of this.chatLookups) {
      if (wanted.has(key) || (lookup.running && keepRunning(key))) continue;
      this.chatLookups.delete(key);
      lookup.controller.abort();
    }
    for (const [key, session] of wanted) {
      if (!this.chatLookups.has(key)) this.chatLookups.set(key, { session, machineId: this.serviceMachineId, controller: new AbortController(), running: false });
    }
    const projects = new Set([...this.chatLookups.values()].map((lookup) => lookup.session.projectId));
    for (const [projectId, shared] of this.cardWorkspaces) {
      if (projects.has(projectId)) continue;
      this.cardWorkspaces.delete(projectId);
      shared.controller.abort();
    }
    this.chatQueue = [...wanted.keys()].filter((key) => this.chatLookups.get(key)?.running === false);
    this.pumpChatLookups();
  }

  /** A retained workspace request whose consumers are all queued: still open, but owned by no running lookup. */
  private unowned(shared: ProjectWorkspaces | undefined): boolean {
    return shared !== undefined && !shared.settled && shared.waiting === 0;
  }

  /**
   * Start queued lookups while a slot is free, counting unowned workspace requests as taken. A queued lookup that joins
   * an unowned request takes over its slot, so it starts even when none is free. Each lookup settles on its own, so one
   * slow Chat never holds another's title.
   */
  private pumpChatLookups(): void {
    const queue = this.chatQueue;
    this.chatQueue = [];
    for (const key of queue) {
      const lookup = this.chatLookups.get(key);
      if (lookup === undefined || lookup.running) continue;
      const { projectId, workspaceId } = lookup.session;
      const joinsUnowned = projectId !== undefined && workspaceId !== undefined && this.unowned(this.cardWorkspaces.get(projectId));
      const held = [...this.cardWorkspaces.values()].filter((shared) => this.unowned(shared)).length;
      if (!joinsUnowned && this.runningLookups + held >= CHAT_LOOKUP_LIMIT) { this.chatQueue.push(key); continue; }
      lookup.running = true;
      this.runningLookups++;
      let joined: ProjectWorkspaces | undefined;
      const workspacesOf = (projectId: string): Promise<readonly Workspace[]> => {
        let shared = this.cardWorkspaces.get(projectId);
        if (shared === undefined) {
          const controller = new AbortController();
          const request: ProjectWorkspaces = { promise: workspacesApi.workspaces(projectId, lookup.machineId, { signal: controller.signal }), controller, settled: false, waiting: 0 };
          // A settled unowned request frees its slot.
          const settle = (): void => { request.settled = true; this.pumpChatLookups(); };
          void request.promise.then(settle, settle);
          shared = request;
          this.cardWorkspaces.set(projectId, shared);
        }
        joined = shared;
        shared.waiting++;
        return shared.promise;
      };
      void workstreamChatInfo(lookup.session, lookup.machineId, workspacesOf, lookup.controller.signal)
        .catch(() => undefined)
        .then((row) => {
          // An aborted or superseded lookup has already left the map and must not apply its result.
          if (this.chatLookups.get(key) !== lookup) return;
          this.chatLookups.delete(key);
          if (row === undefined) this.chatMisses = new Set(this.chatMisses).add(key);
          else this.chatInfo = new Map(this.chatInfo).set(key, row);
        })
        .finally(() => { if (joined !== undefined) joined.waiting--; this.runningLookups--; this.pumpChatLookups(); });
    }
  }

  private chatTitle(session: WorkstreamSession): string {
    const key = chatKey(session);
    const info = this.chatInfo.get(key);
    const cp = session.latestCheckpoint;
    const named = [info?.name, cp?.sessionTitle, info?.firstMessage].map((value) => value?.trim() ?? "").find((value) => value !== "");
    if (named !== undefined) return named;
    if (cp !== null) return firstClause(cp.whatChanged, 80);
    return this.chatEligible(session) && info === undefined && !this.chatMisses.has(key) ? "Loading title…" : "Chat not found in PI WEB";
  }

  private renderSessionRow(snapshot: WorkstreamSnapshot, session: WorkstreamSession) {
    const live = isSessionActive(this.sessionStatuses[session.id], this.sessionActivities[session.id]);
    const doing = live ? sessionActivityText(this.sessionActivities[session.id]) : undefined;
    const modified = this.chatInfo.get(chatKey(session))?.modified;
    const when = Math.max(sessionActivityTime(session), modified === undefined ? 0 : new Date(modified).getTime() || 0);
    return html`
      <button class="session-row ${live ? "live" : ""}" data-session-id=${session.id} @click=${() => { this.open(snapshot, session); }}>
        <span class="session-title">${this.chatTitle(session)}</span>
        <span class="session-meta">
          ${live ? renderActivityIndicator("session", doing ?? "Session active") : nothing}
          ${session.status === "active" ? nothing : html`<span class="status">${session.status}</span>`}
          <span>${doing ?? (when === 0 ? "" : ago(new Date(when).toISOString()))}</span>
        </span>
      </button>
    `;
  }

  private open(snapshot: WorkstreamSnapshot, session: WorkstreamSession): void {
    const detail: OpenWorkstreamSessionDetail = {
      workstreamId: snapshot.id,
      sessionId: session.id,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      directories: session.latestCheckpoint === null ? [] : directoriesOf(session.latestCheckpoint),
    };
    this.dispatchEvent(new CustomEvent<OpenWorkstreamSessionDetail>("open-workstream-session", { detail, bubbles: true, composed: true }));
  }

  private start(snapshot: WorkstreamSnapshot, session: WorkstreamSession & { latestCheckpoint: WorkstreamCheckpoint }, useSelectedWorkspace = false): void {
    this.dispatchStart({
      workstreamId: snapshot.id,
      directories: useSelectedWorkspace ? [] : directoriesOf(session.latestCheckpoint),
      sessionId: session.id,
      ...(useSelectedWorkspace ? { useSelectedWorkspace: true } : {}),
    });
  }

  private startEmpty(snapshot: WorkstreamSnapshot): void {
    this.dispatchStart({ workstreamId: snapshot.id, directories: [] });
  }

  private dispatchStart(detail: StartWorkstreamSessionDetail): void {
    this.dispatchEvent(new CustomEvent<StartWorkstreamSessionDetail>("start-workstream-session", { detail, bubbles: true, composed: true }));
  }

  override render() {
    if (this.loading) return html`<p role="status">Loading Workstreams…</p>`;
    if (this.error !== "" && this.summaries.length === 0) return html`<p class="error" role="alert">${this.error}</p>`;
    const groups = new Map<string, WorkstreamSummary[]>();
    for (const item of this.summaries) {
      const key = item.group ?? "Ungrouped";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    const mine = sorted.filter(([group]) => groupMatchesProject(group, this.project) && !this.excludeProjects.some((project) => groupMatchesProject(group, project)));
    const renderGroup = ([group, items]: [string, WorkstreamSummary[]]) => html`
      <section class="group" aria-label=${group}>
        <h3>${group} <small>${String(items.length)}</small></h3>
        <div class="list" role="list">
          ${items.map((item) => this.renderWorkstream(item))}
        </div>
      </section>`;
    return html`
      ${mine.length === 0 && this.project !== undefined ? html`<p class="missing">No Workstream group is named “${this.project}”. Ask Pi to set the group.</p>` : nothing}
      ${mine.map(renderGroup)}
      ${this.notice === "" ? nothing : html`<p role="status">${this.notice}</p>`}
      ${this.error === "" ? nothing : html`<p class="error" role="alert">${this.error}</p>`}
    `;
  }

  private renderWorkstream(item: WorkstreamSummary) {
    const open = this.selected?.id === item.id;
    const attention = attentionOf(item);
    return html`
      <div role="listitem" class="workstream ${open ? "open" : ""} ${attention ?? ""}" style=${`--workstream-color:${workstreamAccentColor(item.id)}`}>
        <button class="row" aria-expanded=${open} @click=${() => { void this.select(item.id); }}>
          <span class="row-title"><span class="identity-mark" aria-hidden="true">${workstreamMonogram(item.title)}</span><strong>${item.title}</strong>${this.liveWorkstreamIds.has(item.id) ? renderActivityIndicator("session", "Session active") : nothing}<span class="age">${item.lastCheckpointAt === null ? `started ${ago(item.createdAt)}` : ago(item.lastCheckpointAt)}</span></span>
          <span class="next">${attention === undefined ? nothing : html`<span class="badge ${attention}">${attentionLabels[attention]}</span>`}${item.next ?? (item.lastCheckpointAt === null ? "No checkpoint yet." : "")}</span>
        </button>
        ${open && this.selected !== undefined ? this.renderCard(this.selected) : nothing}
      </div>
    `;
  }

  private renderCard(snapshot: WorkstreamSnapshot) {
    const overview = snapshot.overview;
    const checkpoints = latestCheckpoints(snapshot);
    const latest = checkpoints[0];
    const cp = latest?.latestCheckpoint;
    const directories = directoriesOf(cp);
    const sessions = sessionsByActivity(snapshot.sessions);
    const references = referencesOf(snapshot);
    const blocksFirstChat = snapshot.sessions.some((session) => session.status !== "failed");
    const day = (value: string) => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const historyParts = [overview === null ? "" : "overview", checkpoints.length === 0 ? "" : `${String(checkpoints.length)} checkpoint${checkpoints.length > 1 ? "s" : ""}`].filter((part) => part !== "");
    const olderChats = sessions.length - VISIBLE_CHATS;
    const loadOlder = (event: Event): void => { if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open) this.wantChats(sessions); };
    return html`
      <div class="card" aria-label=${`Re-entry card for ${snapshot.title}`}>
        <h4>Goal</h4>
        ${overview === null
          ? html`<p class="missing">No overview stored yet. Ask Pi: “write the overview for ${snapshot.id}”.</p>`
          : html`<p class="goal">${overview.goal}</p><p class="done"><b>Done when</b> ${overview.doneWhen}</p>`}
        ${references.length === 0 ? nothing : html`
          <h4>PRs and issues</h4>
          <ul class="refs">${references.map((ref) => html`<li><span class="kind">${ref.kind}</span><a href=${ref.url} target="_blank" rel="noreferrer">${ref.key}</a></li>`)}</ul>
        `}
        <h4>Chats</h4>
        ${sessions.length === 0 ? html`<p class="missing">No Chats yet.</p>` : html`
          <div class="session-list">${sessions.slice(0, VISIBLE_CHATS).map((session) => this.renderSessionRow(snapshot, session))}</div>
          ${olderChats > 0 ? html`<details class="older" @toggle=${loadOlder}><summary>${String(olderChats)} older Chat${olderChats > 1 ? "s" : ""}</summary><div class="session-list">${sessions.slice(VISIBLE_CHATS).map((session) => this.renderSessionRow(snapshot, session))}</div></details>` : nothing}
        `}
        ${historyParts.length === 0 ? nothing : html`
          <details class="history"><summary>History · ${historyParts.join(" and ")}</summary><div>
            ${overview === null ? nothing : html`<p>${overview.description}</p>${overview.history.length === 0 ? nothing : html`<ol>${overview.history.map((event) => html`<li>${event}</li>`)}</ol>`}`}
            ${checkpoints.map(({ latestCheckpoint }) => html`<p><span class="date">${day(latestCheckpoint.recordedAt)}</span> ${latestCheckpoint.whatChanged}</p>`)}
          </div></details>
        `}
        <div class="actions">
          ${latest !== undefined
            ? html`<button class="primary" @click=${() => { this.open(snapshot, latest); }}>Open session</button>`
            : blocksFirstChat
              ? snapshot.sessions.some((session) => session.status === "pending")
                ? html`<p class="missing">Session launch pending reconciliation. Ask Pia to reconcile it before starting another Chat.</p>`
                : html`<p class="missing">No session has checkpointed yet.</p>`
              : this.project === undefined
                ? html`<p class="missing">This Workstream has no matching PI WEB project tab. Set its group to a registered project before starting it.</p>`
                : html`<button class="primary" title=${this.canStartEmpty ? "Start Workstream Chat" : "Choose a workspace first"} ?disabled=${!this.canStartEmpty} @click=${() => { this.startEmpty(snapshot); }}>Start Workstream Chat</button>`}
          ${latest === undefined ? nothing : html`
            ${directories.length > 0 || cp?.references?.some(isTemporaryDirectory) !== true ? html`<button @click=${() => { this.start(snapshot, latest); }}>New session</button>` : nothing}
            ${cp?.references?.some(isTemporaryDirectory) === true ? html`<button ?disabled=${!this.canStartEmpty} title="Choose a persistent workspace first" @click=${() => { this.start(snapshot, latest, true); }}>New session in selected workspace</button>` : nothing}
          `}
        </div>
      </div>
    `;
  }

  static override styles = [listStyles, css`
    :host { display: grid; gap: 10px; min-width: 0; max-width: 100%; }
    * { box-sizing: border-box; min-width: 0; }
    .card p, .card li { overflow-wrap: anywhere; }
    .card p, .card ol { max-width: 75ch; }
    .group { display: grid; gap: 6px; }
    h3 { margin: 6px 0 0; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--pi-muted); }
    h3 small { font-weight: 500; }
    h4 { margin: 10px 0 2px; font-size: 12px; font-weight: 700; color: var(--pi-text); }
    h4:first-child { margin-top: 2px; }
    p { margin: 0; line-height: 1.45; }
    .list { display: grid; gap: 8px; }
    button { box-sizing: border-box; min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 12px; font: inherit; text-align: left; cursor: pointer; }
    button:hover { background: var(--pi-surface-hover); }
    button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    a { color: var(--pi-text); text-decoration: underline; text-underline-offset: 2px; font-weight: 600; }
    .workstream { border: 1px solid var(--pi-border-muted); border-left: 3px solid var(--workstream-color, var(--pi-border)); border-radius: 10px; background: var(--pi-surface); }
    .workstream:hover, .workstream.open { border-color: var(--pi-border); border-left-color: var(--workstream-color, var(--pi-border)); }
    .row { width: 100%; display: grid; gap: 4px; padding: 10px 14px; border: 0; border-radius: 9px; background: transparent; }
    .row:hover { background: var(--pi-surface-hover); }
    .row-title { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
    .row-title::after { content: "▸"; flex: none; width: 10px; color: var(--pi-text); }
    .open .row-title::after { content: "▾"; }
    .row-title strong { flex: 1 1 0; min-width: 0; font-size: 15px; line-height: 1.3; }
    .dormant .row-title strong { font-weight: 500; }
    .age { flex: none; color: var(--pi-text); font-size: 12px; white-space: nowrap; }
    .next { margin-left: 36px; max-width: 75ch; color: var(--pi-text); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; line-height: 1.45; }
    .open .next { display: block; }
    .dormant:not(.open) .next { -webkit-line-clamp: 1; }
    .badge { display: inline-flex; align-items: center; gap: 5px; margin-right: 6px; padding: 0 8px 0 7px; border: 1px solid var(--pi-border-muted); border-radius: 999px; background: var(--pi-bg); color: var(--pi-text); font-size: 12px; font-weight: 700; line-height: 18px; vertical-align: 1px; white-space: nowrap; }
    .badge::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .badge.owner { border-color: var(--pi-accent); background: var(--pi-accent); color: #fff; }
    .badge.agent::before { background: var(--pi-success); }
    .badge.external { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
    .badge.external::before { background: var(--pi-warning); }
    .badge.dormant { background: transparent; color: var(--pi-text); font-weight: 600; }
    .badge.dormant::before { background: none; box-shadow: inset 0 0 0 1.5px var(--pi-dim); }
    .identity-mark { flex: 0 0 auto; display: inline-grid; place-items: center; width: 28px; height: 24px; border: 2px solid var(--pi-text); border-radius: 7px 7px 3px 7px; background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.mark}%, var(--pi-surface)); color: var(--pi-text); font-size: 10px; font-weight: 850; letter-spacing: .03em; line-height: 1; }
    .row .activity-indicator, .session-row .activity-indicator { box-shadow: 0 0 0 1px var(--pi-text); }
    .card { display: grid; padding: 0 14px 12px 50px; font-size: 14px; }
    .done { margin-top: 2px; color: var(--pi-text); font-size: 13px; }
    .done b { font-weight: 700; }
    .refs { margin: 0; padding: 0; list-style: none; }
    .refs li { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
    .kind { font-size: 11px; color: var(--pi-text); border: 1px solid var(--pi-border-muted); border-radius: 4px; padding: 0 4px; white-space: nowrap; }
    .session-list { display: grid; }
    .session-row { width: 100%; min-height: 0; display: flex; align-items: baseline; gap: 8px; padding: 5px 4px; font-size: 13px; border: 0; border-top: 1px solid var(--pi-border-muted); border-radius: 0; background: transparent; }
    .session-row:first-child { border-top: 0; }
    .session-row.live { border-color: var(--pi-success-border); background: var(--pi-success-bg); }
    .session-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-meta { flex: none; display: flex; align-items: center; gap: 4px; max-width: 45%; color: var(--pi-text); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status { padding: 0 5px; border: 1px solid var(--pi-border); border-radius: 999px; }
    details { margin-top: 6px; }
    summary { display: inline-flex; gap: 6px; padding: 2px 4px 2px 0; border-radius: 4px; color: var(--pi-text); font-size: 13px; font-weight: 600; cursor: pointer; list-style: none; }
    summary:hover { text-decoration: underline; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: "▸"; }
    details[open] > summary::before { content: "▾"; }
    details > div { display: grid; gap: 6px; margin: 6px 0 0 14px; }
    .history ol { margin: 0; padding-left: 18px; }
    .history li + li { margin-top: 3px; }
    .date { color: var(--pi-text); font-weight: 600; font-size: 12px; margin-right: 4px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .primary { border-color: var(--pi-success-border); background: var(--pi-success-bg); font-weight: 700; }
    .missing, .error { color: var(--pi-muted); font-size: 13px; }
    .workstream .missing { color: var(--pi-text); }
    .error { color: var(--pi-danger); }
    @media (max-width: 560px) { .next { margin-left: 0; } .card { padding-left: 14px; } }
    @media (forced-colors: active) {
      .workstream { border-left-color: LinkText; }
      .badge.owner { forced-color-adjust: none; border-color: Highlight; background: Highlight; color: HighlightText; }
      .identity-mark { border-color: ButtonText; background: Canvas; color: CanvasText; }
      .row .activity-indicator, .session-row .activity-indicator { border: 1px solid CanvasText; background: Highlight; box-shadow: none; }
    }
  `];
}
