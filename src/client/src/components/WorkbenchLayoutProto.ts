/* eslint-disable @typescript-eslint/consistent-type-assertions -- throwaway prototype */
// THROWAWAY layout prototype (`?layout=proto`), never merged. One shell per window; every tile or tab is a
// `proto-chat-pane`: the real chat-view, composer and Files pane for one session, driven by its own
// SessionController. The window shares one realtime socket; each pane keeps its session's event stream.
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { api, type AskUserSubmission, type ExtensionDialogAnswer, type Machine, type Project, type PromptAttachment, type QueuedSessionMessage, type SessionInfo, type Workspace } from "../api";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { initialAppState, type AppState } from "../appState";
import { latestWorkingModeSelection } from "../chatMessages";
import { SessionController } from "../controllers/sessionController";
import { selectedMachineId } from "../controllers/types";
import { markdownWorkspaceContext, type WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { machineSessionKey } from "../machineKeys";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { applyPresentationProfile, builtInPresentationProfile, readStoredPresentationProfile } from "../presentationProfiles";
import { sessionTitle } from "../sessionLabels";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import { applyPiWebTheme, readStoredThemePreference, resolveThemePreference } from "../theme";
import type { PromptEditor } from "./PromptEditor";
import type { WorkbenchFilesPane } from "./WorkbenchFilesPane";
import { adHocWorkspace, rootProjects } from "./WorkbenchApp";
import { inspectWorkstream, listWorkstreams, sessionsByActivity, type WorkstreamServiceContext } from "./WorkstreamChooser";
import { renderBuiltinTabIcon } from "./tabIcons";
import "./ChatView";
import "./CommandPicker";
import "./DelegateRoster";
import "./GoalStatusChip";
import "./PromptEditor";
import "./WorkbenchFilesPane";

/** One tab or tile. `groupId`/`group` = its Workstream, absent for a Chat without one. */
interface Entry { id: string; sessionId: string; title: string; groupId?: string | undefined; group?: string | undefined; files?: boolean | undefined }
interface Win { name: string; entries: Entry[]; focused?: string | undefined; layout: "grid" | "tabs"; maximized?: string | undefined }
type Store = Record<string, Win>;
interface Live { streaming: boolean; needsOwner: boolean; unread: boolean }
interface PaneState { title: string; streaming: boolean; needsOwner: boolean }
interface Choice { id: string; title: string }
interface Catalog { workstreams: { id: string; title: string; sessions: Choice[] }[]; loose: Choice[] }
interface Resolved { project: Project | undefined; workspace: Workspace; workspaces: Workspace[] }

const STORE_KEY = "pi-workbench.layout-proto.v2";
const readStore = (): Store => { try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Store; } catch { return {}; } };
const uid = (): string => crypto.randomUUID().slice(0, 8);
const SWIPE_END_MS = 150, SWIPE_COMMIT = 0.3, FLICK_PX_PER_MS = 0.8;
const AGENT_SESSION = /^workbench-(?:coordinator|implementer|planner|reviewer|scout)-[0-9a-f]{8}$/u;
const matches = (text: string, q: string): boolean => text.toLowerCase().includes(q);

/** Whether a wheel starting at this event scrolls something horizontally (code block, table) instead of swiping. */
function canScrollX(event: WheelEvent): boolean {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(node).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollWidth > node.clientWidth + 1
      && (event.deltaX > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0)) return true;
  }
  return false;
}

/** One session's real Chat: transcript, composer and optional Files pane, without any shell chrome. */
@customElement("proto-chat-pane")
export class ProtoChatPane extends LitElement {
  @property() sessionId = "";
  @property({ attribute: false }) machine: Machine | undefined;
  @property({ attribute: false }) resolveWorkspace: ((cwd: string) => Promise<Resolved>) | undefined;
  @property({ type: Boolean }) files = false;
  /** An unfocused grid tile: the composer drops its usage meter to keep the grid calm. */
  @property({ type: Boolean }) quiet = false;
  @state() private app: AppState = initialAppState();
  @state() private loadError = "";
  @query("prompt-editor") private promptEditor?: PromptEditor;
  private lastReport = "";
  private readonly sessions = new SessionController(() => this.app, (patch) => { this.app = { ...this.app, ...patch }; }, () => undefined);

  override connectedCallback(): void {
    super.connectedCallback();
    this.sessions.resume();
    void this.load();
  }

  override disconnectedCallback(): void {
    this.sessions.dispose();
    super.disconnectedCallback();
  }

  /** Window-wide realtime events (status, activity, names) fan out to every pane. */
  applyGlobal(event: BrowserRealtimeEvent): void {
    if (event.type === "session.attention") return;
    if (event.type !== "sessions.unread" && event.type !== "notices.updated" && event.type !== "machine.status") this.sessions.applyGlobalEvent(event);
  }

  focusInput(): void { this.promptEditor?.focusInput(); }

  private async load(): Promise<void> {
    const machine = this.machine;
    const machineId = machine?.id ?? "local";
    try {
      const { cwd } = await api.locate(this.sessionId, machineId);
      const [target, rows] = await Promise.all([
        this.resolveWorkspace?.(cwd) ?? Promise.resolve({ project: undefined, workspace: adHocWorkspace(cwd), workspaces: [adHocWorkspace(cwd)] }),
        api.sessions(cwd, machineId, { sessionId: this.sessionId }),
      ]);
      const row = rows.find((candidate) => candidate.id === this.sessionId);
      if (row === undefined) throw new Error("This Chat is no longer available.");
      this.app = { ...this.app, machines: machine === undefined ? [] : [machine], selectedMachine: machine, selectedProject: target.project, workspaces: target.workspaces, selectedWorkspace: target.workspace, sessions: [row] };
      await this.sessions.selectSession(row, { updateUrl: false });
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  private readonly handleSend = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery?: PromptAttachmentDelivery, folder?: string): Promise<boolean> =>
    this.sessions.send(text, streamingBehavior, attachments, delivery, folder);

  private readonly openWorkspaceFile = (event: CustomEvent<WorkspaceFileOpenRequest>): void => {
    const workspace = this.app.selectedWorkspace;
    if (event.defaultPrevented || event.detail.root !== workspace?.path) return;
    event.preventDefault();
    this.files = true;
    this.dispatchEvent(new CustomEvent("pane-files", { detail: true, bubbles: true, composed: true }));
    void this.updateComplete.then(async () => {
      const pane = this.renderRoot.querySelector<WorkbenchFilesPane>("workbench-files-pane");
      if (pane !== null) { await pane.updateComplete; await pane.openFile(event.detail.path); }
    });
  };

  protected override updated(): void {
    const session = this.app.selectedSession;
    const report: PaneState = {
      title: session === undefined ? "" : sessionTitle(session),
      streaming: this.app.status?.isStreaming === true,
      needsOwner: this.app.pendingAsk !== undefined || this.app.pendingDialogs.length > 0,
    };
    const json = JSON.stringify(report);
    if (json === this.lastReport) return;
    this.lastReport = json;
    this.dispatchEvent(new CustomEvent<PaneState>("pane-state", { detail: report, bubbles: true, composed: true }));
  }

  override render() {
    const state = this.app;
    const session = state.selectedSession;
    if (session === undefined) return html`<p class="placeholder" role=${this.loadError === "" ? "status" : "alert"}>${this.loadError === "" ? "Loading…" : this.loadError}</p>`;
    const machineId = selectedMachineId(state);
    return html`
      ${state.error === "" ? nothing : html`<div class="error" role="alert">${state.error}</div>`}
      <div class="body" data-files=${this.files}>
        <div class="chat-column">
          <chat-view
            @workspace-file-open=${this.openWorkspaceFile}
            .workspaceContext=${markdownWorkspaceContext(machineId, state.selectedWorkspace, session)}
            .sessionId=${session.id}
            .sessionCwd=${session.cwd}
            .machineId=${machineId}
            .messages=${state.messages}
            .messageStart=${state.messagePageStart}
            .messageEnd=${state.messagePageEnd}
            .messageTotal=${state.messagePageTotal}
            .hasMore=${state.messagePageStart > 0}
            .loadingMore=${state.isLoadingEarlierMessages}
            .isSendingPrompt=${state.sendingPrompts[session.id] === true}
            .isCompacting=${state.status?.isCompacting === true}
            .pendingMessageCount=${state.status?.pendingMessageCount ?? 0}
            .clientQueuedMessages=${state.clientQueuedSessionMessages[session.id] ?? []}
            .status=${state.status}
            .activity=${state.activity}
            .pendingAsk=${state.pendingAsk}
            .pendingDialogs=${state.pendingDialogs}
            .closedDialogs=${state.closedDialogs}
            .askDraftSessionId=${machineSessionKey(machineId, session.id)}
            .onSubmitAsk=${(askId: string, submission: AskUserSubmission) => this.sessions.submitAsk(askId, submission)}
            .onAnswerDialog=${(dialogId: string, value: ExtensionDialogAnswer) => this.sessions.answerDialog(dialogId, value)}
            .onCancelDialog=${(dialogId: string) => this.sessions.cancelDialog(dialogId)}
            .onDismissClosedDialog=${(dialogId: string) => { this.sessions.dismissClosedDialog(dialogId); }}
            .onPromoteQueuedMessage=${(message: QueuedSessionMessage) => { void this.sessions.promoteQueuedMessage(message); }}
            .onPromoteAllQueuedMessages=${() => { void this.sessions.promoteAllQueuedMessages(); }}
            .onClearServerQueue=${() => { void this.sessions.clearServerQueue(); }}
            .onDismissWarning=${(dismissId: string) => { void this.sessions.dismissWarning(dismissId); }}
            .onLoadMore=${() => { void this.sessions.loadEarlierMessages(); }}
            .onMessageAction=${(entryId: string, action: "fork" | "back") => this.sessions.actOnMessage(entryId, action)}
          ></chat-view>
          <delegate-roster .status=${state.status}></delegate-roster>
          <goal-status-chip .status=${state.status}></goal-status-chip>
          <prompt-editor
            .sessionId=${session.id}
            .cwd=${state.selectedWorkspace?.path}
            .machineId=${machineId}
            .projectId=${state.selectedProject?.id}
            .workspaceId=${state.selectedWorkspace?.id}
            .disabled=${session.archived === true}
            .canSteer=${state.status?.isStreaming === true}
            .isCompacting=${state.status?.isCompacting === true}
            .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0}
            .status=${state.status}
            .workingModeTranscriptSelection=${latestWorkingModeSelection(state.messages)}
            .showUsage=${!this.quiet}
            .warningCount=${state.status?.warnings?.length ?? 0}
            .sending=${state.sendingPrompts[session.id] === true}
            .onSend=${this.handleSend}
            .onStop=${() => { void this.sessions.stopActiveWork(); }}
            .thinkingLevels=${state.availableThinkingLevels}
            .loadModels=${() => this.sessions.listModels()}
            .onSetModel=${(provider: string, modelId: string) => this.sessions.setModel(provider, modelId)}
            .onSetThinkingLevel=${(level: string) => this.sessions.setThinkingLevel(level)}
            .onRunCommand=${(command: string) => this.sessions.runCommand(command)}
          ></prompt-editor>
        </div>
        ${this.files ? html`<workbench-files-pane .workspace=${state.selectedWorkspace} .machineId=${machineId}></workbench-files-pane>` : nothing}
      </div>
      ${state.commandDialog === undefined ? nothing : html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => { void this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value); }} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>`}
    `;
  }

  static override styles = css`
    :host { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .placeholder { margin: auto; color: var(--pi-muted); }
    .error { flex: 0 0 auto; padding: 6px 12px; border-bottom: 1px solid var(--pi-border); color: var(--pi-danger); }
    .body { flex: 1 1 auto; display: flex; min-width: 0; min-height: 0; }
    .chat-column { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    chat-view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
    delegate-roster, goal-status-chip, prompt-editor { flex: 0 0 auto; }
    .body { container-type: inline-size; }
    workbench-files-pane { flex: 0 0 min(420px, 45%); box-sizing: border-box; min-width: 0; border-left: 1px solid var(--pi-border); }
    /* Too narrow to split (a grid tile): Files takes the whole pane until it is toggled off. */
    @container (max-width: 860px) {
      .body[data-files="true"] .chat-column { display: none; }
      .body[data-files="true"] workbench-files-pane { flex: 1 1 auto; border-left: 0; }
    }
  `;
}

@customElement("workbench-layout-proto")
export class WorkbenchLayoutProto extends LitElement {
  @state() private store: Store = readStore();
  @state() private winId = "";
  @state() private machine: Machine | undefined;
  @state() private menu: { x: number; y: number; ids: string[]; label: string } | undefined;
  @state() private live = new Map<string, Live>();
  @state() private alive = new Map<string, number>();
  @state() private adding = false;
  @state() private addQuery = "";
  @state() private expanded = new Set<string>();
  @state() private catalog: Catalog | undefined;
  @state() private catalogError = "";
  private projects: Project[] = [];
  private workspaceIndex: Promise<{ project: Project; workspaces: Workspace[] }[]> | undefined;
  private readonly realtime = new RealtimeSocket();
  private readonly channel = new BroadcastChannel("pi-workbench.layout-proto");
  private pingTimer: number | undefined;
  private swipe: { ids: string[]; k: number; acc: number; ignore: boolean; hist: { t: number; dx: number }[]; timer: number } | undefined;
  private readonly plugins = new PluginRegistry();

  private get win(): Win { return this.store[this.winId] ?? { name: "Window", entries: [], layout: "grid" }; }

  override connectedCallback(): void {
    super.connectedCallback();
    applyPresentationProfile(readStoredPresentationProfile() ?? builtInPresentationProfile("comfortable"));
    void this.plugins.register({ id: "themes", plugin: themePackPlugin }).then(() => {
      const theme = resolveThemePreference({ themes: this.plugins.getThemes(), themePairs: this.plugins.getThemePairs(), preference: readStoredThemePreference() ?? { themeId: "themes:github-dark", auto: true }, prefersLight: matchMedia("(prefers-color-scheme: light)").matches }).activeTheme;
      if (theme !== undefined) applyPiWebTheme(theme);
    });
    window.addEventListener("storage", this.onStorage);
    window.addEventListener("keydown", this.onKey, { capture: true });
    window.addEventListener("wheel", this.onWheel, { passive: false, capture: true });
    window.addEventListener("pointerdown", this.closePopups);
    window.addEventListener("pagehide", this.onPageHide);
    this.channel.onmessage = (event: MessageEvent<{ type: string; win: string }>) => {
      if (event.data.type === "bye") this.alive.delete(event.data.win);
      else this.alive.set(event.data.win, Date.now());
      if (event.data.type === "hello") this.channel.postMessage({ type: "ping", win: this.winId });
      this.alive = new Map(this.alive);
    };
    void this.boot();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("storage", this.onStorage);
    window.removeEventListener("keydown", this.onKey, { capture: true });
    window.removeEventListener("wheel", this.onWheel, { capture: true });
    window.removeEventListener("pointerdown", this.closePopups);
    window.removeEventListener("pagehide", this.onPageHide);
    window.clearInterval(this.pingTimer);
    this.realtime.close();
    this.channel.close();
    super.disconnectedCallback();
  }

  /** Pick this window's working set (the URL's, else a stored one no live window holds, else a new empty one), then connect. */
  private async boot(): Promise<void> {
    const url = new URL(location.href);
    let id = url.searchParams.get("win") ?? undefined;
    if (id === undefined) {
      this.channel.postMessage({ type: "hello", win: "" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      id = Object.keys(this.store).find((candidate) => !this.alive.has(candidate)) ?? uid();
      url.searchParams.set("win", id);
      history.replaceState(null, "", url);
    }
    this.winId = id;
    this.channel.postMessage({ type: "ping", win: id });
    this.pingTimer = window.setInterval(() => { this.channel.postMessage({ type: "ping", win: id }); }, 3_000);
    if (this.store[id] === undefined) this.mutate((store) => { store[id] = { name: this.nextWindowName(store), entries: [], layout: "grid" }; });
    const machines = await api.machines();
    const machine = machines.find((candidate) => candidate.id === "local") ?? machines[0];
    this.projects = await api.projects(machine?.id ?? "local").catch(() => []);
    this.realtime.connect((event) => {
      for (const pane of this.renderRoot.querySelectorAll<ProtoChatPane>("proto-chat-pane")) pane.applyGlobal(event);
    }, undefined, machine?.id ?? "local");
    this.machine = machine;
  }

  private nextWindowName(store: Store): string {
    const used = new Set(Object.values(store).map((win) => win.name));
    let n = 1;
    while (used.has(`Window ${String(n)}`)) n += 1;
    return `Window ${String(n)}`;
  }

  /** Read-modify-write the shared store; other windows see it through the `storage` event. */
  private mutate(change: (store: Store) => void): void {
    const store = readStore();
    change(store);
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    this.store = store;
  }

  private mutateWin(change: (win: Win) => void): void {
    this.mutate((store) => { const win = store[this.winId]; if (win !== undefined) change(win); });
  }

  private readonly onStorage = (event: StorageEvent): void => { if (event.key === STORE_KEY) this.store = readStore(); };
  private readonly onPageHide = (): void => { this.channel.postMessage({ type: "bye", win: this.winId }); };
  private readonly closePopups = (event: Event): void => {
    const inside = (name: string) => event.composedPath().some((node) => node instanceof HTMLElement && node.classList.contains(name));
    if (this.menu !== undefined && !inside("menu")) this.menu = undefined;
    if (this.adding && !inside("add-pop") && !inside("add")) this.adding = false;
  };

  // ---------- where sessions live ----------
  /** The registered workspace whose path is `cwd`, else the folder itself. */
  private readonly resolveWorkspace = async (cwd: string): Promise<Resolved> => {
    const index = await this.indexWorkspaces();
    for (const { workspaces } of index) {
      const workspace = workspaces.find((candidate) => candidate.path === cwd);
      if (workspace !== undefined) return { project: this.projects.find((project) => project.id === workspace.projectId), workspace, workspaces };
    }
    const folder = adHocWorkspace(cwd);
    return { project: undefined, workspace: folder, workspaces: [folder] };
  };

  private indexWorkspaces(): Promise<{ project: Project; workspaces: Workspace[] }[]> {
    const machineId = this.machine?.id ?? "local";
    // ponytail: lists every project's workspaces once per window; a server lookup by path would make this one request.
    this.workspaceIndex ??= Promise.all(this.projects.map(async (project) => ({ project, workspaces: await api.workspaces(project.id, machineId).catch((): Workspace[] => []) })));
    return this.workspaceIndex;
  }

  private async workstreamContext(): Promise<WorkstreamServiceContext | undefined> {
    const index = await this.indexWorkspaces();
    for (const root of rootProjects(this.projects)) {
      const workspaces = index.find((candidate) => candidate.project.id === root.id)?.workspaces ?? [];
      const workspace = workspaces.find((candidate) => candidate.projectId === root.id && candidate.isMain) ?? workspaces[0];
      if (workspace !== undefined) return { machineId: this.machine?.id ?? "local", projectId: workspace.projectId, workspaceId: workspace.id };
    }
    return undefined;
  }

  /** Open Workstreams with their Chats, and recent Chats without a Workstream. */
  private async loadCatalog(): Promise<void> {
    const machineId = this.machine?.id ?? "local";
    try {
      const context = await this.workstreamContext();
      const [recent, listed] = await Promise.all([api.recent(500, machineId), context === undefined ? [] : listWorkstreams(context)]);
      const rows = new Map(recent.map((row) => [row.id, row]));
      const summaries = [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const snapshots = [];
      // ponytail: one inspect per open Workstream, eight at a time; a list-with-sessions operation would make this one call.
      for (let start = 0; start < summaries.length; start += 8) {
        snapshots.push(...await Promise.all(summaries.slice(start, start + 8).map((summary) => (context === undefined ? Promise.resolve(undefined) : inspectWorkstream(context, summary.id)).catch(() => undefined))));
      }
      const placed = new Set<string>();
      const workstreams = snapshots.flatMap((snapshot) => {
        if (snapshot === undefined) return [];
        // ponytail: only Chats among the 500 most recent are offered; older Workstream Chats need a server lookup by id.
        const sessions = sessionsByActivity(snapshot.sessions.filter((session) => session.status !== "failed" && session.status !== "pending")).flatMap((session) => {
          const row = rows.get(session.id);
          if (row === undefined) return [];
          placed.add(session.id);
          return [{ id: session.id, title: sessionTitle(row) }];
        });
        return sessions.length === 0 ? [] : [{ id: snapshot.id, title: snapshot.title, sessions }];
      });
      const loose = recent.filter((row: SessionInfo) => !placed.has(row.id) && !AGENT_SESSION.test(row.name ?? "")).map((row) => ({ id: row.id, title: sessionTitle(row) }));
      this.catalog = { workstreams, loose };
      this.catalogError = "";
    } catch (error) {
      this.catalogError = error instanceof Error ? error.message : String(error);
    }
  }

  private openAdd(): void {
    this.adding = true;
    this.addQuery = "";
    void this.loadCatalog();
    void this.updateComplete.then(() => { this.renderRoot.querySelector<HTMLInputElement>(".add-pop input")?.focus(); });
  }

  /** Put these sessions in this window, moving them out of any other window. */
  private addSessions(picks: Choice[], group?: { id: string; title: string }): void {
    const ids = new Set(picks.map((pick) => pick.id));
    let focus: string | undefined;
    this.mutate((store) => {
      for (const [winId, win] of Object.entries(store)) {
        if (winId === this.winId) continue;
        win.entries = win.entries.filter((entry) => !ids.has(entry.sessionId));
        if (!win.entries.some((entry) => entry.id === win.focused)) win.focused = win.entries[0]?.id;
        if (!win.entries.some((entry) => entry.id === win.maximized)) win.maximized = undefined;
      }
      const win = store[this.winId];
      if (win === undefined) return;
      for (const pick of picks) {
        const owner = group ?? this.catalog?.workstreams.find((workstream) => workstream.sessions.some((session) => session.id === pick.id));
        const existing = win.entries.find((entry) => entry.sessionId === pick.id);
        if (existing !== undefined) { focus ??= existing.id; continue; }
        const entry: Entry = { id: uid(), sessionId: pick.id, title: pick.title, groupId: owner?.id, group: owner?.title };
        win.entries.push(entry);
        focus ??= entry.id;
      }
      win.focused = focus ?? win.focused;
      win.maximized = undefined;
    });
    this.adding = false;
    if (focus !== undefined) this.activate(focus);
  }

  private holder(sessionId: string): string | undefined {
    return Object.entries(this.store).find(([, win]) => win.entries.some((entry) => entry.sessionId === sessionId))?.[0];
  }

  // ---------- grouping and focus ----------
  /** Grouped by Workstream in first-seen order; Chats without one last, without a chip. */
  private groups(): { id: string; title: string | undefined; entries: Entry[] }[] {
    const groups = new Map<string, { title: string | undefined; entries: Entry[] }>();
    for (const entry of this.win.entries) {
      const key = entry.groupId ?? "";
      const group = groups.get(key) ?? { title: entry.group, entries: [] };
      group.entries.push(entry);
      groups.set(key, group);
    }
    const loose = groups.get("");
    groups.delete("");
    if (loose !== undefined) groups.set("", loose);
    return [...groups].map(([id, group]) => ({ id, ...group }));
  }

  private ordered(): Entry[] { return this.groups().flatMap((group) => group.entries); }
  private tile(id: string): HTMLElement | null { return this.renderRoot.querySelector<HTMLElement>(`.tile[data-id="${id}"]`); }

  /** Focus is never stolen: only owner actions call this. */
  private setFocused(id: string): void {
    if (this.live.get(id)?.unread === true) this.patchLive(id, { unread: false });
    if (this.win.focused === id) return;
    this.mutateWin((win) => { win.focused = id; if (win.maximized !== undefined) win.maximized = id; });
  }

  /** Focus a Chat and put the caret in its composer. */
  private activate(id: string): void {
    this.setFocused(id);
    void this.updateComplete.then(() => { this.tile(id)?.querySelector<ProtoChatPane>("proto-chat-pane")?.focusInput(); });
  }

  private toggleLayout(): void {
    this.mutateWin((win) => { win.layout = win.layout === "grid" ? "tabs" : "grid"; win.maximized = undefined; });
    const focused = this.win.focused;
    if (focused !== undefined) this.activate(focused);
  }

  private toggleMaximized(id: string): void {
    this.mutateWin((win) => { win.focused = id; win.maximized = win.maximized === id ? undefined : id; });
  }

  private toggleFiles(id: string, open?: boolean): void {
    this.mutateWin((win) => { const entry = win.entries.find((candidate) => candidate.id === id); if (entry !== undefined) entry.files = open ?? entry.files !== true; });
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && (this.adding || this.menu !== undefined)) { this.adding = false; this.menu = undefined; return; }
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "t") { event.preventDefault(); event.stopPropagation(); if (this.adding) this.adding = false; else this.openAdd(); return; }
    if (!event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.toLowerCase() === "g") { event.preventDefault(); event.stopPropagation(); this.toggleLayout(); }
    else if (event.key === "Enter" && this.win.layout === "grid" && this.win.focused !== undefined) { event.preventDefault(); event.stopPropagation(); this.toggleMaximized(this.win.focused); }
  };

  private onPaneState(entry: Entry, report: PaneState): void {
    const before = this.live.get(entry.id);
    this.patchLive(entry.id, { streaming: report.streaming, needsOwner: report.needsOwner, unread: (before?.unread ?? false) || (before?.streaming === true && !report.streaming && this.win.focused !== entry.id) });
    if (report.title !== "" && report.title !== entry.title) this.mutateWin((win) => { const stored = win.entries.find((candidate) => candidate.id === entry.id); if (stored !== undefined) stored.title = report.title; });
  }

  private patchLive(id: string, patch: Partial<Live>): void {
    const next = new Map(this.live);
    next.set(id, { streaming: false, needsOwner: false, unread: false, ...this.live.get(id), ...patch });
    this.live = next;
  }

  private close(ids: string[]): void {
    this.mutateWin((win) => {
      const order = this.ordered().map((entry) => entry.id);
      const index = order.indexOf(win.focused ?? "");
      win.entries = win.entries.filter((entry) => !ids.includes(entry.id));
      if (win.focused !== undefined && ids.includes(win.focused)) win.focused = order.slice(index + 1).find((id) => !ids.includes(id)) ?? order.slice(0, index).reverse().find((id) => !ids.includes(id));
      if (win.maximized !== undefined && ids.includes(win.maximized)) win.maximized = undefined;
    });
    this.menu = undefined;
  }

  /** Move Chats to `targetWin` (created when missing); their panes reconnect there. */
  private moveTo(ids: string[], targetWin: string, fromWin = this.winId): void {
    this.mutate((store) => {
      const source = store[fromWin];
      if (source === undefined) return;
      const moving = source.entries.filter((candidate) => ids.includes(candidate.id));
      if (moving.length === 0) return;
      source.entries = source.entries.filter((candidate) => !ids.includes(candidate.id));
      if (!source.entries.some((entry) => entry.id === source.focused)) source.focused = source.entries[0]?.id;
      if (!source.entries.some((entry) => entry.id === source.maximized)) source.maximized = undefined;
      const target = store[targetWin] ?? (store[targetWin] = { name: this.nextWindowName(store), entries: [], layout: source.layout });
      target.entries.push(...moving);
      target.focused = moving[0]?.id;
    });
    this.menu = undefined;
  }

  private moveToNewWindow(ids: string[]): void {
    const target = uid();
    this.moveTo(ids, target);
    window.open(`/?layout=proto&win=${target}`, "_blank");
  }

  // ---------- trackpad swipe: tabs mode and a maximized tile ----------
  private swipeIds(): string[] | undefined {
    return this.win.layout === "tabs" || this.win.maximized !== undefined ? this.ordered().map((entry) => entry.id) : undefined;
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey) return; // pinch zoom
    if (this.swipe === undefined) {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const ids = this.swipeIds();
      if (ids === undefined || this.win.focused === undefined) return;
      this.swipe = { ids, k: ids.indexOf(this.win.focused), acc: 0, hist: [], ignore: canScrollX(event), timer: 0 };
    }
    const swipe = this.swipe;
    window.clearTimeout(swipe.timer);
    swipe.timer = window.setTimeout(() => { this.endSwipe(); }, SWIPE_END_MS);
    if (swipe.ignore) return;
    event.preventDefault();
    swipe.acc += event.deltaX;
    swipe.hist.push({ t: performance.now(), dx: event.deltaX });
    this.paintSwipe();
  };

  /** Current Chat follows the fingers; the neighbour slides in beside it. */
  private paintSwipe(): void {
    const swipe = this.swipe;
    if (swipe === undefined) return;
    const current = this.tile(swipe.ids[swipe.k] ?? "");
    if (current === null) return;
    const width = current.offsetWidth;
    const dir = Math.sign(swipe.acc);
    const neighbourId = swipe.ids[swipe.k + dir];
    const x = -swipe.acc * (neighbourId === undefined ? 0.25 : 1); // rubber band at the ends
    for (const id of swipe.ids) {
      const tile = this.tile(id);
      if (tile === null || tile === current) continue;
      const isNeighbour = id === neighbourId;
      tile.style.transition = "none";
      tile.style.visibility = isNeighbour ? "visible" : "";
      tile.style.transform = isNeighbour ? `translateX(${String(dir * width + x)}px)` : "";
    }
    current.style.transition = "none";
    current.style.transform = `translateX(${String(x)}px)`;
  }

  private endSwipe(): void {
    const swipe = this.swipe;
    this.swipe = undefined;
    if (swipe === undefined || swipe.ignore || swipe.hist.length === 0) return;
    const current = this.tile(swipe.ids[swipe.k] ?? "");
    const width = current?.offsetWidth ?? innerWidth;
    const last = swipe.hist[swipe.hist.length - 1]?.t ?? 0;
    const recent = swipe.hist.filter((sample) => last - sample.t <= 100);
    const velocity = recent.reduce((sum, sample) => sum + sample.dx, 0) / Math.max(16, last - (recent[0]?.t ?? last));
    const dir = Math.sign(swipe.acc);
    const target = swipe.ids[swipe.k + dir];
    const flick = Math.abs(velocity) > FLICK_PX_PER_MS && Math.sign(velocity) === dir && Math.abs(swipe.acc) > 20;
    const commit = dir !== 0 && target !== undefined && (Math.abs(swipe.acc) > SWIPE_COMMIT * width || flick);
    const neighbour = target === undefined ? null : this.tile(target);
    const ease = "transform .22s cubic-bezier(.2,.8,.2,1)";
    if (current !== null) { current.style.transition = ease; current.style.transform = commit ? `translateX(${String(-dir * width)}px)` : ""; }
    if (neighbour !== null) { neighbour.style.transition = ease; neighbour.style.transform = commit ? "translateX(0)" : `translateX(${String(dir * width)}px)`; }
    window.setTimeout(() => {
      for (const id of swipe.ids) {
        const tile = this.tile(id);
        if (tile !== null) { tile.style.transition = ""; tile.style.transform = ""; tile.style.visibility = ""; }
      }
      if (commit) this.activate(target);
    }, 230);
  }

  // ---------- drag a tab to another window, or out of this one ----------
  private dragStart(event: DragEvent, ids: string[], label: string): void {
    event.dataTransfer?.setData("application/x-pi-proto-tab", JSON.stringify({ win: this.winId, ids }));
    event.dataTransfer?.setData("text/plain", label);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
  }

  private dragEnd(event: DragEvent, ids: string[]): void {
    const outside = event.screenX < window.screenX || event.screenX > window.screenX + window.outerWidth
      || event.screenY < window.screenY || event.screenY > window.screenY + window.outerHeight;
    if (event.dataTransfer?.dropEffect === "none" && outside && this.win.entries.some((candidate) => ids.includes(candidate.id))) this.moveToNewWindow(ids);
  }

  private drop(event: DragEvent): void {
    const raw = event.dataTransfer?.getData("application/x-pi-proto-tab");
    if (raw === undefined || raw === "") return;
    event.preventDefault();
    const { win, ids } = JSON.parse(raw) as { win: string; ids: string[] };
    if (win !== this.winId) this.moveTo(ids, this.winId, win);
  }

  private openMenu(event: MouseEvent, ids: string[], label: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu = { x: event.clientX, y: event.clientY, ids, label };
  }

  // ---------- rendering ----------
  private statusOf(entry: Entry): "running" | "needs" | "idle" {
    const live = this.live.get(entry.id);
    if (live?.needsOwner === true || live?.unread === true) return "needs";
    return live?.streaming === true ? "running" : "idle";
  }

  private dot(entry: Entry) {
    const status = this.statusOf(entry);
    const live = this.live.get(entry.id);
    const label = live?.needsOwner === true ? "Waiting for your answer" : live?.unread === true ? "Finished while you were away" : status === "running" ? "Working" : "Idle";
    return html`<span class="dot" data-status=${status} title=${label} aria-label=${label}></span>`;
  }

  /** Grid cells for the visible page: 1 fills, 2 side by side, 3 = two over one, 4 = 2×2. */
  private placement(entry: Entry, ordered: Entry[]): { visible: boolean; area?: string } {
    const win = this.win;
    const focused = ordered.some((candidate) => candidate.id === win.focused) ? win.focused : ordered[0]?.id;
    if (win.layout === "tabs" || win.maximized !== undefined) return { visible: entry.id === (win.maximized ?? focused) };
    const page = this.page(ordered);
    const index = ordered.indexOf(entry) - page * 4;
    const count = Math.min(4, ordered.length - page * 4);
    if (index < 0 || index >= 4) return { visible: false };
    const row = index < 2 ? 1 : 2;
    const column = index % 2 + 1;
    const area = count === 1 ? "1 / 1 / 3 / 3"
      : count === 2 ? `1 / ${String(column)} / 3 / ${String(column + 1)}`
      : count === 3 && index === 2 ? "2 / 1 / 3 / 3"
      : `${String(row)} / ${String(column)} / ${String(row + 1)} / ${String(column + 1)}`;
    return { visible: true, area };
  }

  private page(ordered: Entry[]): number { return Math.max(0, Math.floor(ordered.findIndex((candidate) => candidate.id === this.win.focused) / 4)); }

  override render() {
    const win = this.win;
    const ordered = this.ordered();
    const focused = ordered.find((entry) => entry.id === win.focused) ?? ordered[0];
    document.title = `${win.name}${focused === undefined ? "" : ` · ${focused.title}`}`;
    const empty = ordered.length === 0;
    const tabs = win.layout === "tabs" && !empty;
    const pages = Math.ceil(ordered.length / 4);
    return html`
      <nav class="bar" aria-label=${win.name} @dragover=${(event: DragEvent) => { if (event.dataTransfer?.types.includes("application/x-pi-proto-tab") === true) event.preventDefault(); }} @drop=${(event: DragEvent) => { this.drop(event); }}>
        ${tabs ? this.renderTabs(win) : html`
          <div class="lead">
            <span class="win-name">${win.name}</span>
            ${win.layout === "grid" && win.maximized === undefined && pages > 1 ? html`
              <span class="pager" role="group" aria-label="Grid pages">
                <button aria-label="Previous page" ?disabled=${this.page(ordered) === 0} @click=${() => { const id = ordered[(this.page(ordered) - 1) * 4]?.id; if (id !== undefined) this.activate(id); }}>‹</button>
                <span>${String(this.page(ordered) + 1)} / ${String(pages)}</span>
                <button aria-label="Next page" ?disabled=${this.page(ordered) >= pages - 1} @click=${() => { const id = ordered[(this.page(ordered) + 1) * 4]?.id; if (id !== undefined) this.activate(id); }}>›</button>
              </span>` : nothing}
          </div>`}
        <div class="actions">
          ${tabs && focused !== undefined ? html`<button class="icon" title="Files" aria-label="Files" aria-pressed=${focused.files === true} @click=${() => { this.toggleFiles(focused.id); }}>${renderBuiltinTabIcon("files")}</button>` : nothing}
          ${empty ? nothing : html`<button class="add" title="Add Chats (⌘T)" aria-haspopup="dialog" aria-expanded=${this.adding} @click=${() => { if (this.adding) this.adding = false; else this.openAdd(); }}>＋ Add</button>`}
          ${empty ? nothing : html`
            <div class="segmented" role="group" aria-label="Layout (⌃G)" title="Toggle layout (⌃G)">
              <button aria-pressed=${win.layout === "grid"} @click=${() => { if (win.layout !== "grid") this.toggleLayout(); }}>Grid</button>
              <button aria-pressed=${win.layout === "tabs"} @click=${() => { if (win.layout !== "tabs") this.toggleLayout(); }}>Tabs</button>
            </div>`}
        </div>
      </nav>
      <div class="stage" data-layout=${win.layout} data-maximized=${win.maximized !== undefined}>
        ${empty ? html`
          <div class="empty">
            <p>No Chats in this window yet.</p>
            <button class="primary" @click=${() => { this.openAdd(); }}>Add a Workstream or Chat <kbd>⌘T</kbd></button>
          </div>` : nothing}
        ${this.machine === undefined ? nothing : repeat(ordered, (entry) => entry.id, (entry) => this.renderTile(entry, ordered))}
      </div>
      ${this.adding ? this.renderAdd() : nothing}
      ${this.renderMenu()}
    `;
  }

  private renderTabs(win: Win) {
    return html`
      <div class="tabs" role="tablist" aria-label=${`${win.name} Chats`}>
        ${this.groups().map((group) => html`
          <div class="group" role="group" aria-label=${group.title ?? "Without Workstream"}>
            ${group.title === undefined ? nothing : html`<button class="chip" title=${group.title} draggable="true"
              @click=${(event: MouseEvent) => { this.openMenu(event, group.entries.map((entry) => entry.id), group.title ?? ""); }}
              @contextmenu=${(event: MouseEvent) => { this.openMenu(event, group.entries.map((entry) => entry.id), group.title ?? ""); }}
              @dragstart=${(event: DragEvent) => { this.dragStart(event, group.entries.map((entry) => entry.id), group.title ?? ""); }}
              @dragend=${(event: DragEvent) => { this.dragEnd(event, group.entries.map((entry) => entry.id)); }}>${group.title}</button>`}
            ${group.entries.map((entry) => html`
              <div role="tab" tabindex="0" class="tab" draggable="true" data-id=${entry.id} aria-selected=${entry.id === win.focused} title=${entry.title}
                @click=${() => { this.activate(entry.id); }}
                @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.activate(entry.id); } }}
                @auxclick=${(event: MouseEvent) => { if (event.button === 1) this.close([entry.id]); }}
                @contextmenu=${(event: MouseEvent) => { this.openMenu(event, [entry.id], entry.title); }}
                @dragstart=${(event: DragEvent) => { this.dragStart(event, [entry.id], entry.title); }}
                @dragend=${(event: DragEvent) => { this.dragEnd(event, [entry.id]); }}>
                ${this.dot(entry)}
                <span class="title">${entry.title}</span>
                <button class="x" title="Close" aria-label=${`Close ${entry.title}`} @click=${(event: Event) => { event.stopPropagation(); this.close([entry.id]); }}>×</button>
              </div>`)}
          </div>`)}
      </div>`;
  }

  private renderTile(entry: Entry, ordered: Entry[]) {
    const win = this.win;
    const place = this.placement(entry, ordered);
    const maximized = win.maximized === entry.id;
    return html`
      <section class="tile" data-id=${entry.id} data-visible=${place.visible} data-focused=${entry.id === win.focused} style=${styleMap(place.area === undefined ? {} : { gridArea: place.area })}
        @pointerdown=${() => { this.setFocused(entry.id); }} @focusin=${() => { this.setFocused(entry.id); }}
        @pane-state=${(event: CustomEvent<PaneState>) => { this.onPaneState(entry, event.detail); }}
        @pane-files=${() => { this.toggleFiles(entry.id, true); }}>
        <header class="tile-bar" draggable="true" @dblclick=${() => { this.toggleMaximized(entry.id); }} @contextmenu=${(event: MouseEvent) => { this.openMenu(event, [entry.id], entry.title); }}
          @dragstart=${(event: DragEvent) => { this.dragStart(event, [entry.id], entry.title); }} @dragend=${(event: DragEvent) => { this.dragEnd(event, [entry.id]); }}>
          ${this.dot(entry)}
          <span class="title" title=${entry.title}>${entry.title}</span>
          ${entry.group === undefined ? nothing : html`<span class="chip small" title=${`Workstream: ${entry.group}`}>${entry.group}</span>`}
          <span class="tile-actions">
            <button class="icon" title="Files" aria-label="Files" aria-pressed=${entry.files === true} @click=${() => { this.toggleFiles(entry.id); }}>${renderBuiltinTabIcon("files")}</button>
            <button class="icon" title=${maximized ? "Restore grid (⌃↩)" : "Full size (⌃↩)"} aria-label=${maximized ? "Restore grid" : "Full size"} @click=${() => { this.toggleMaximized(entry.id); }}>${maximized ? "⤡" : "⤢"}</button>
            <button class="icon" title="Close" aria-label=${`Close ${entry.title}`} @click=${() => { this.close([entry.id]); }}>×</button>
          </span>
        </header>
        <proto-chat-pane .sessionId=${entry.sessionId} .machine=${this.machine} .resolveWorkspace=${this.resolveWorkspace} .files=${entry.files === true} .quiet=${win.layout === "grid" && win.maximized === undefined && entry.id !== win.focused}></proto-chat-pane>
      </section>`;
  }

  private renderAdd() {
    const q = this.addQuery.trim().toLowerCase();
    const catalog = this.catalog;
    const here = this.winId;
    const where = (sessionId: string) => {
      const holder = this.holder(sessionId);
      if (holder === undefined) return nothing;
      return html`<span class="where" data-here=${holder === here}>${holder === here ? "Here" : this.store[holder]?.name ?? "Other window"}</span>`;
    };
    const sessionRow = (pick: Choice, group?: { id: string; title: string }) => html`
      <button class="pick session" @click=${() => { this.addSessions([pick], group); }}><span class="title">${pick.title}</span>${where(pick.id)}</button>`;
    const workstreams = (catalog?.workstreams ?? []).flatMap((workstream) => {
      const titleHit = q === "" || matches(workstream.title, q);
      const sessions = titleHit ? workstream.sessions : workstream.sessions.filter((session) => matches(session.title, q));
      return sessions.length === 0 ? [] : [{ ...workstream, shown: sessions }];
    });
    const loose = (catalog?.loose ?? []).filter((pick) => q === "" || matches(pick.title, q)).slice(0, q === "" ? 30 : 100);
    const firstWorkstream = workstreams[0];
    const addFirst = (): void => { if (firstWorkstream !== undefined) this.addSessions(firstWorkstream.sessions, firstWorkstream); else if (loose[0] !== undefined) this.addSessions([loose[0]]); };
    return html`
      <div class="add-pop" data-centered=${this.win.entries.length === 0} role="dialog" aria-label=${`Add to ${this.win.name}`}>
        <input type="text" placeholder="Search Workstreams and Chats" aria-label="Search Workstreams and Chats" .value=${this.addQuery}
          @input=${(event: Event) => { this.addQuery = (event.target as HTMLInputElement).value; }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") addFirst();
          }}>
        <div class="add-list">
          ${catalog === undefined ? html`<p class="note">${this.catalogError === "" ? "Loading…" : this.catalogError}</p>` : nothing}
          ${workstreams.length === 0 ? nothing : html`<h3>Workstreams</h3>`}
          ${workstreams.map((workstream) => {
            const open = q !== "" || this.expanded.has(workstream.id);
            const shown = open ? workstream.shown : workstream.shown.slice(0, 3);
            return html`
              <div class="ws">
                <button class="pick ws-row" title="Add all its Chats" @click=${() => { this.addSessions(workstream.sessions, workstream); }}>
                  <span class="title">${workstream.title}</span><span class="meta">Add ${String(workstream.sessions.length)}</span>
                </button>
                ${shown.map((pick) => sessionRow(pick, workstream))}
                ${shown.length < workstream.shown.length ? html`<button class="more" @click=${() => { this.expanded = new Set([...this.expanded, workstream.id]); }}>${String(workstream.shown.length - shown.length)} more</button>` : nothing}
              </div>`;
          })}
          ${loose.length === 0 ? nothing : html`<h3>Chats without a Workstream</h3>${loose.map((pick) => sessionRow(pick))}`}
          ${catalog !== undefined && workstreams.length === 0 && loose.length === 0 ? html`<p class="note">Nothing matches.</p>` : nothing}
        </div>
      </div>`;
  }

  private renderMenu() {
    const menu = this.menu;
    if (menu === undefined) return nothing;
    const others = Object.entries(this.store).filter(([id]) => id !== this.winId);
    const single = menu.ids.length === 1 ? menu.ids[0] : undefined;
    return html`
      <div class="menu" role="menu" aria-label=${menu.label} style=${styleMap({ left: `${String(Math.min(menu.x, innerWidth - 240))}px`, top: `${String(menu.y)}px` })}>
        <button role="menuitem" @click=${() => { this.moveToNewWindow(menu.ids); }}>Move to new window</button>
        ${others.map(([id, other]) => html`
          <button role="menuitem" @click=${() => { this.moveTo(menu.ids, id); }}>Move to ${other.name}${this.alive.has(id) ? "" : " (closed)"}</button>`)}
        <hr>
        ${single === undefined || this.win.layout !== "grid" ? nothing : html`<button role="menuitem" @click=${() => { this.toggleMaximized(single); this.menu = undefined; }}>${this.win.maximized === single ? "Restore grid" : "Full size"}</button>`}
        <button role="menuitem" @click=${() => { this.close(menu.ids); }}>${single === undefined ? `Close ${String(menu.ids.length)} Chats` : "Close"}</button>
      </div>`;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--pi-bg); color: var(--pi-text); font: 13px system-ui, sans-serif; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .bar { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; min-width: 0; height: 40px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--pi-border); background: var(--pi-surface); }
    .lead { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 12px; }
    .win-name { color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
    .pager { display: flex; align-items: center; gap: 4px; color: var(--pi-muted); font-size: 12px; }
    .pager button { width: 24px; height: 24px; border: 0; border-radius: 6px; background: none; }
    .pager button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    .pager button:disabled { opacity: .35; cursor: default; }
    .tabs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 12px; overflow-x: auto; scrollbar-width: none; }
    .group { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: 2px; }
    .group + .group { padding-left: 12px; border-left: 1px solid var(--pi-border-muted); }
    .chip { flex: 0 1 auto; min-width: 40px; max-width: 200px; overflow: hidden; padding: 2px 8px; border: 1px solid var(--pi-border); border-radius: 999px; background: none; color: var(--pi-muted); font-size: 11px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
    button.chip:hover { color: var(--pi-text); border-color: var(--pi-muted); }
    .chip.small { flex: 0 1 auto; min-width: 0; max-width: 40%; padding: 0 7px; font-weight: 500; }
    .tab { flex: 0 1 auto; min-width: 72px; max-width: 260px; display: flex; align-items: center; gap: 6px; height: 28px; box-sizing: border-box; padding: 0 4px 0 9px; border-radius: 7px; color: var(--pi-muted); cursor: pointer; user-select: none; }
    .tab:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .tab[aria-selected="true"] { background: var(--pi-bg); color: var(--pi-text); box-shadow: inset 0 -2px 0 var(--pi-accent); }
    .tab:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .tab .x { flex: 0 0 auto; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--pi-muted); line-height: 1; visibility: hidden; }
    .tab:hover .x, .tab[aria-selected="true"] .x { visibility: visible; }
    .tab .x:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .title { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--pi-border); }
    .dot[data-status="running"] { background: var(--pi-accent); animation: pulse 1.2s ease-in-out infinite; }
    .dot[data-status="needs"] { background: var(--pi-warning, #d29922); box-shadow: 0 0 0 3px color-mix(in srgb, var(--pi-warning, #d29922) 25%, transparent); }
    @keyframes pulse { 50% { opacity: .35; } }
    .actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
    .icon { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); font-size: 14px; }
    .icon:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .icon[aria-pressed="true"] { color: var(--pi-accent); background: var(--pi-selection-bg, var(--pi-surface-hover)); }
    .icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .add { height: 28px; padding: 0 10px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); white-space: nowrap; }
    .add:hover, .add[aria-expanded="true"] { border-color: var(--pi-accent); }
    .segmented { display: flex; border: 1px solid var(--pi-border); border-radius: 7px; overflow: hidden; }
    .segmented button { height: 26px; padding: 0 10px; border: 0; background: none; color: var(--pi-muted); }
    .segmented button + button { border-left: 1px solid var(--pi-border); }
    .segmented button[aria-pressed="true"] { background: var(--pi-selection-bg, var(--pi-surface-hover)); color: var(--pi-text); font-weight: 600; }
    .stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; display: grid; grid-template: minmax(0, 1fr) minmax(0, 1fr) / minmax(0, 1fr) minmax(0, 1fr); gap: 1px; background: var(--pi-border); }
    .stage[data-layout="tabs"], .stage[data-maximized="true"] { display: block; background: var(--pi-bg); }
    .tile { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--pi-bg); }
    .tile[data-visible="false"], .stage[data-layout="tabs"] .tile, .stage[data-maximized="true"] .tile { position: absolute; inset: 0; }
    .tile[data-visible="false"] { visibility: hidden; pointer-events: none; }
    .tile-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-width: 0; height: 30px; padding: 0 4px 0 10px; border-bottom: 1px solid var(--pi-border-muted); color: var(--pi-muted); cursor: default; user-select: none; }
    .tile-bar .title { flex: 0 1 auto; }
    .tile[data-focused="true"] .tile-bar { color: var(--pi-text); box-shadow: inset 0 2px 0 var(--pi-accent); }
    .stage[data-layout="tabs"] .tile-bar { display: none; }
    .tile-actions { flex: 0 0 auto; margin-left: auto; display: flex; gap: 2px; opacity: 0; }
    .tile-bar:hover .tile-actions, .tile[data-focused="true"] .tile-actions, .tile-actions:focus-within { opacity: 1; }
    .tile-actions .icon { width: 24px; height: 24px; }
    proto-chat-pane { flex: 1 1 auto; }
    .empty { grid-area: 1 / 1 / 3 / 3; display: grid; place-content: center; justify-items: center; gap: 14px; background: var(--pi-bg); color: var(--pi-muted); font-size: 14px; }
    .empty p { margin: 0; }
    .primary { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border: 1px solid var(--pi-accent); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); font-size: 14px; }
    kbd { padding: 0 5px; border: 1px solid var(--pi-border); border-radius: 4px; color: var(--pi-muted); font: 11px ui-monospace, monospace; }
    .add-pop { position: fixed; z-index: 30; top: 44px; right: 8px; width: min(480px, calc(100vw - 16px)); max-height: min(70vh, 640px); display: flex; flex-direction: column; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); box-shadow: 0 16px 40px var(--pi-shadow); }
    .add-pop[data-centered="true"] { top: 18vh; right: auto; left: 50%; transform: translateX(-50%); }
    .add-pop input { margin: 10px; padding: 7px 10px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); font: inherit; font-size: 14px; }
    .add-pop input:focus { outline: 2px solid var(--pi-accent); outline-offset: -1px; }
    .add-list { min-height: 0; overflow-y: auto; padding: 0 6px 8px; }
    .add-list h3 { margin: 10px 8px 4px; color: var(--pi-muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    .ws { padding: 2px 0 6px; }
    .ws + .ws { border-top: 1px solid var(--pi-border-muted); padding-top: 6px; }
    .pick { width: 100%; display: flex; align-items: center; gap: 10px; padding: 5px 8px; border: 0; border-radius: 6px; background: none; text-align: left; }
    .pick:hover { background: var(--pi-surface-hover); }
    .ws-row { font-weight: 600; }
    .pick .title { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-height: 1.3; }
    .ws .session { padding-left: 22px; color: var(--pi-muted); }
    .ws .session:hover { color: var(--pi-text); }
    .meta { flex: 0 0 auto; color: var(--pi-accent); font-size: 12px; font-weight: 500; }
    .where { flex: 0 0 auto; padding: 0 6px; border-radius: 4px; background: var(--pi-surface-hover); color: var(--pi-muted); font-size: 11px; }
    .where[data-here="true"] { color: var(--pi-accent); }
    .more { margin-left: 22px; padding: 2px 8px; border: 0; background: none; color: var(--pi-accent); font-size: 12px; }
    .note { margin: 10px; color: var(--pi-muted); }
    .menu { position: fixed; z-index: 40; min-width: 220px; display: grid; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 10px 30px var(--pi-shadow); }
    .menu button { padding: 6px 10px; border: 0; border-radius: 5px; background: none; text-align: left; }
    .menu button:hover { background: var(--pi-surface-hover); }
    .menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--pi-border-muted); }
  `;
}
