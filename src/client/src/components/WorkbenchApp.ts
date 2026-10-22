import { LitElement, css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { customElement, state } from "lit/decorators.js";
import { api, configApi, type Project, type SessionInfo, type SessionStatus, type Workspace } from "../api";
import { HttpRequestError } from "../api/http";
import type { PendingAskUser } from "../../../shared/apiTypes";
import { adHocFolderWorkspaceId } from "../../../shared/workspaceFiles";
import { initialAppState, type AppState } from "../appState";
import { clampPanelWidth, panelWidthFromDrag, panelWidthFromKeyboard, type PanelResizeConstraints } from "../appShell/panelResizeController";
import { desktopNotifications, DesktopNotificationController, NATIVE_NOTIFICATION_HOLDS_EVENT, NATIVE_NOTIFICATION_OPEN_EVENT, NOTIFICATION_ANCHOR } from "../controllers/desktopNotificationController";
import type { PromptEditorTextReplacement, SessionController, SessionSelectionOptions } from "../controllers/sessionController";
import { WorkbenchChatSession, WorkbenchSessionFocus } from "../controllers/workbenchSessionFocus";
import { selectedMachineId } from "../controllers/types";
import { TabSwipeController } from "../controllers/tabSwipeController";
import { WINDOW_URL_PARAM, WorkbenchWindowController, type WindowRequest } from "../controllers/workbenchWindowController";
import { resolveAppUrl } from "../appUrl";
import { applyInterfaceScale, DEFAULT_INTERFACE_SCALE, readStoredInterfaceScale, stepInterfaceScale, writeStoredInterfaceScale } from "../interfaceScale";
import type { LineRange, OutsideFileOpenRequest, WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import type { ChatContentRendering } from "../formatting/contentRendering";
import { machineSessionKey } from "../machineKeys";
import { loadStagedAttachmentDraft, resolveStagedAttachmentKey } from "../promptAttachmentStaging";
import { nativeDirectoryPicker } from "../nativeHost";
import { writeClipboardText } from "../clipboard";
import { loadExternalPlugins } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { applyPresentationProfile, builtInPresentationProfile, readStoredPresentationProfile } from "../presentationProfiles";
import { applyCheckpointSessionTitle } from "../workstreamCheckpointTitle";
import { workstreamOrientationDepth } from "../workstreamOrientation";
import { focusTopModal, hasRenderedModal } from "./modalLayerRegistry";
import { isCreatingSessionId, readRoute, takeMessageAnchor, writeRoute, type ParsedAppRoute } from "../route";
import { sessionTitle } from "../sessionLabels";
import { sessionPersistenceState } from "../sessionPersistence";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import { pluginStyles, PluginStyleRuntime } from "../plugins/styles";
import { applyPiWebTheme, readStoredThemePreference, resolveThemePreference, writeStoredThemePreference, type ThemePreference } from "../theme";
import { closeChats, focusChat, GRID_MIN_TILE, gridRatio, gridRatioBounds, gridRatioFromDrag, gridRatioFromKeyboard, gridTiles, moveChats, orderedChats, resizeGrid, toggleLayout, toggleMaximized, updateChat, type GridAxis, type GridTile, type WindowChat, type WindowStore } from "../workbenchWindows";
import { WORKSTREAM_TINT_PERCENTAGES, WorkstreamColorController, workstreamAccentColor } from "../workstreamColor";
import type { ChatRevealTarget } from "./ChatView";
import { hasUnacknowledgedSend, type PromptEditor } from "./PromptEditor";
import type { WorkbenchFilesPane } from "./WorkbenchFilesPane";
import "./AllSessions";
import "./ProjectDialog";
import "./WorkstreamChooser";
import "./WorkbenchMenuButton";
import type { WorkbenchSettingsPanel } from "./WorkbenchSettingsPanel";
import "./WorkbenchSettingsPanel";
import "./WorkbenchFilesPane";
import { openQuestionCount } from "./WorkbenchQuestionChips";
import { carriesChats, chatStatusDotStyles, chatTabStatus, droppedChats, endedOutside, renderChatStatusDot, startChatDrag, type ChatTabCloseDetail, type ChatTabMenuDetail, type ChatTabSelectDetail, type ChatTabStatus, type DraggedChats } from "./WorkbenchWindowTabs";
import type { WorkbenchChatPane } from "./WorkbenchChatPane";
import "./WorkbenchChatPane";
import { appendWorkstream, inspectWorkstream, isTemporaryDirectory, watchWorkstreams, workstreamForSession, type OpenWorkstreamSessionDetail, type StartWorkstreamSessionDetail, type WorkstreamAppendRecord, type WorkstreamServiceContext, type WorkstreamSessionAnchor, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { renderBuiltinTabIcon } from "./tabIcons";
import { randomHex } from "../randomHex";

/** A folder used for one Chat without registering a project. */
/** The machine's ~/IdeaProjects as an absolute path, or undefined when it does not exist. */
export async function defaultChatFolder(machineId: string): Promise<string | undefined> {
  const found = (await api.projectDirectories("~/IdeaProjects", machineId).catch(() => [])).find((entry) => entry.path.endsWith("/IdeaProjects/"));
  return found?.path.slice(0, -1);
}

/** WebKit says only "did not respond" when the macOS open panel never appears, typically because the app binary changed while it ran. */
export function folderPanelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to choose a folder: ${message}${message.includes("did not respond") ? ". Quit and reopen Pi Workbench; the folder panel cannot open in an app that was updated while running." : ""}`;
}

/**
 * Session id, folder and transcript file, one per line, for pasting into another Chat or tool. The daemon assigns the
 * transcript path before the file exists, so a known path is always shown; the live status, not the row snapshot taken
 * when the Chat opened, says whether it is written yet.
 */
export function sessionInfoText(session: SessionInfo, status?: SessionStatus): string {
  const transcript = session.path === "" ? "not known yet"
    : sessionPersistenceState(session, status) === "transient" ? `${session.path} (written after the first reply)` : session.path;
  return `Session: ${session.id}\nFolder: ${session.cwd}\nTranscript: ${transcript}`;
}

/** Which workspace Files shows, on which machine: the scope Files resets for. */
const filesKey = ({ machineId, workspace }: { machineId: string; workspace: Workspace | undefined }): string => `${machineId}:${workspace?.projectId ?? ""}:${workspace?.id ?? ""}`;

export const adHocWorkspace = (path: string): Workspace => ({ id: adHocFolderWorkspaceId(path), projectId: "", path, label: path.split("/").filter(Boolean).at(-1) ?? path, isMain: false, effectiveConfig: {} });

/** A project inside another registered project, or its sibling `<project>-<suffix>` repository, belongs to that project's tab. */
export function rootProjectOf(project: Project, projects: readonly Project[]): Project {
  const belongsTo = (candidate: Project): boolean => project.path.startsWith(`${candidate.path}/`)
    || project.path.startsWith(`${candidate.path}-`) && !project.path.slice(candidate.path.length).includes("/");
  const parent = projects.find((candidate) => candidate.id !== project.id && belongsTo(candidate));
  return parent === undefined ? project : rootProjectOf(parent, projects);
}
export const rootProjects = (projects: readonly Project[]): Project[] => projects.filter((project) => rootProjectOf(project, projects).id === project.id);
const subprojectsOf = (root: Project, projects: readonly Project[]): Project[] => projects.filter((project) => rootProjectOf(project, projects).id === root.id);
/** Never-saved blank or pending Chats in this folder: no listing returns them yet, so opening another Chat from its row keeps them. */
const unsavedChatsIn = (rows: readonly SessionInfo[], cwd: string, openedId: string): SessionInfo[] => rows.filter((row) => row.persisted === false && row.cwd === cwd && row.id !== openedId);
/** A window asked to hand over dropped Chats may first ask its owner about unsaved file edits. */
const MOVE_REPLY_MS = 60_000;

@customElement("pi-workbench-app")
export class WorkbenchApp extends LitElement {
  private readonly workstreamColors = new WorkstreamColorController(this);
  @state() private app: AppState = initialAppState();
  /** The navigation still loading; a newer navigation ends its Loading. */
  @state() private loadingAt: number | undefined = 0;
  @state() private showAgentSessions = false;
  @state() private showAllSessions = false;
  @state() private sessionInfoCopied = false;
  @state() private chooserView: "project" | "other" | "all" = "project";
  @state() private currentWorkstream: WorkstreamSnapshot | null | undefined;
  @state() private currentWorkstreamError = "";
  /** The right-hand slot beside the Chat: divider, width and close chevron. */
  @state() private sidePane: "files" | undefined;
  /** A workspace the Files pane shows instead of the Chat's, after a link to a file outside the Chat's folder. */
  @state() private filesTarget: { sessionId: string; workspace: Workspace } | undefined;
  /** What the Files pane shows; only `guardFilesTarget` changes it. */
  @state() private filesShown: { machineId: string; workspace: Workspace | undefined } = { machineId: "local", workspace: undefined };
  /** The target the owner refused to discard Files edits for; Files keeps its own until they ask again or it changes. */
  @state() private filesDeclined: string | undefined;
  /** Files shows another machine or workspace than the one on screen; set by `guardFilesTarget` before each render. */
  private filesElsewhere = false;
  @state() private filesWidth = 400;
  private filesResize: { pointerId: number; startX: number; startWidth: number; handle: HTMLElement } | undefined;
  /**
   * A Grid divider being dragged: its share reaches the window store on release (`released`). Not reactive: a move writes
   * the Grid's template straight to the page once a frame (`frame`), since a render per move would re-render every tile.
   */
  private gridDrag: { axis: GridAxis; pointerId: number; start: number; startRatio: number; size: number; ratio: number; handle: HTMLElement; released: boolean; frame: number | undefined } | undefined;
  /** All window-wide consumers resolve through this pointer; each tile keeps its own state and controller. */
  private readonly focused = new WorkbenchSessionFocus((patch) => { this.setApp(patch, false); });
  private readonly chats = new Set<WorkbenchChatSession>();
  private readonly retiringChats = new Set<string>();
  private launcher: WorkbenchChatSession | undefined;
  private navigationSequence = 0;
  private selectingChat: { sessionId: string; generation: number } | undefined;
  private readonly chatLoadErrors = new Map<string, string>();
  @state() private windowError = "";
  private tileFocusOnClick: string | undefined;
  private get focusedPane(): WorkbenchChatPane | undefined {
    return [...this.shadowRoot?.querySelectorAll<WorkbenchChatPane>("workbench-chat-pane") ?? []].find((pane) => pane.runtime === this.focused.current);
  }
  private get promptEditor(): PromptEditor | undefined { return this.focusedPane?.promptEditor; }
  private get sessions(): SessionController {
    if (this.focused.current !== undefined) return this.focused.current.sessions;
    const launcher = this.launcher ??= this.createChatSession(this.app);
    launcher.patch(this.app, false);
    return launcher.sessions;
  }
  private readonly realtime = new RealtimeSocket();
  private realtimeMachineId: string | undefined;
  /** This window's open Chats, shared with the other windows through localStorage. */
  private readonly windows = new WorkbenchWindowController(() => { this.followWindowChange(); }, undefined, (request, from, expires) => this.answerWindow(request, from, expires));
  /** Open Chats that finished working while another Chat was on screen. */
  private readonly unreadChats = new Set<string>();
  /** Right-click menu of a tab, Workstream tab or tile, in CSS pixels. */
  @state() private windowMenu: { sessionIds: string[]; label: string; left: number; top: number } | undefined;
  /** The neighbour sliding in during a trackpad swipe. */
  @state() private swipePeek: string | undefined;
  private readonly swipe = new TabSwipeController({
    track: () => {
      const window = this.windows.window;
      const current = this.app.selectedSession?.id;
      if (window === undefined || current === undefined || window.layout === "grid" && !window.maximized || !window.chats.some((chat) => chat.sessionId === current)) return undefined;
      return { order: orderedChats(window).map((chat) => chat.sessionId), current };
    },
    surfaces: () => {
      const current = this.shadowRoot?.querySelector<HTMLElement>('.grid[data-single] > .tile[data-focused="true"]');
      return current === null || current === undefined ? undefined : { current, peek: this.shadowRoot?.querySelector<HTMLElement>(".swipe-peek") ?? null };
    },
    peek: (sessionId) => { this.swipePeek = sessionId; return this.updateComplete; },
    commit: (sessionId) => this.showWindowChat(sessionId),
  });
  /** One generation for every navigation, New Chat and selection included: only the newest may commit. */
  private get loadSequence(): number {
    return this.navigationSequence;
  }

  private get loading(): boolean {
    return this.loadingAt === this.loadSequence;
  }
  private workstreamOpenSequence = 0;
  private workstreamLoadSequence = 0;
  private workstreamWatchSequence: number | undefined;
  private workstreamWatchDelay = 2_000;
  private readonly workstreamContexts = new Map<string, WorkstreamServiceContext | undefined>();
  private readonly attemptedCheckpointTitles = new Set<string>();
  private readonly pendingWorkstreamContexts = new Map<string, Promise<WorkstreamServiceContext | undefined>>();
  private orientationPendingSessionId: string | undefined;
  private workstreamWatchTimer: number | undefined;
  private readonly plugins = new PluginRegistry();
  @state() private contentRendering: ChatContentRendering | undefined;
  private themesInitialized = false;
  /** The configured send behavior while a reply streams (upstream's defaultStreamingBehavior setting). */
  @state() private defaultStreamingBehavior: "steer" | "followUp" = "steer";
  @state() private themePreference: ThemePreference = readStoredThemePreference() ?? { themeId: "themes:github-dark", auto: true };
  private readonly systemLightThemeMedia = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
  private readonly onSystemLightThemeChange = (): void => { this.applyPreferredTheme(); };

  /** Bundled themes are stylesheets: publish the active one to the document and every integrated shadow root. */
  private readonly stylesheetRuntime = new PluginStyleRuntime(pluginStyles, (error) => {
    console.error("Failed to apply theme stylesheets", error);
  });

  private applyPreferredTheme(): void {
    const theme = resolveThemePreference({
      themes: this.plugins.getThemes(),
      themePairs: this.plugins.getThemePairs(),
      preference: this.themePreference,
      prefersLight: this.systemLightThemeMedia?.matches ?? false,
    }).activeTheme;
    if (this.isConnected) this.stylesheetRuntime.update(theme?.stylesheets ?? []);
    if (theme !== undefined) applyPiWebTheme(theme);
  }

  private setThemePreference(preference: ThemePreference): void {
    this.themePreference = preference;
    writeStoredThemePreference(preference);
    this.applyPreferredTheme();
  }

  private readonly desktopNotifications = new DesktopNotificationController(
    desktopNotifications(),
    () => { this.requestUpdate(); },
    () => this.currentWorkstream?.title,
    (machineId, sessionId, anchor) => { this.openNotificationChat(machineId, sessionId, anchor); },
  );

  @state() private revealTarget: ChatRevealTarget | undefined;

  private openNotificationChat(machineId: string, sessionId: string, anchor: string | undefined): void {
    this.revealTarget = anchor === undefined ? undefined : { machineId, sessionId, anchor };
    void this.load({ machineId, sessionId, projectId: undefined, workspaceId: undefined, tool: undefined, view: undefined }, { reuseLoaded: true, push: true });
  }

  /**
   * Every Chat this window opens from outside its own tabs (chooser, All sessions, Workstream, history, link or
   * notification) asks here first: one another live window holds opens there, which keeps it; one a closed window holds
   * is freed to open here. True when this window must not open it, also when a newer navigation took over meanwhile.
   */
  private async openedElsewhere(sessionId: string, release = true): Promise<boolean> {
    if (this.windows.window?.chats.some((chat) => chat.sessionId === sessionId) === true) return false;
    const navigation = this.loadSequence;
    const reveal = this.revealTarget?.sessionId === sessionId ? this.revealTarget : undefined;
    const outcome = await this.windows.showInOwner(sessionId, reveal?.anchor);
    if (outcome !== "here" && reveal !== undefined && this.revealTarget === reveal) this.revealTarget = undefined;
    if (navigation !== this.loadSequence) return true;
    if (outcome === "unanswered") this.setApp({ error: "This Chat is open in another window, which does not respond. Try again in a moment." });
    // Only a fresh navigation frees a closed holder; a refused delayed claim never takes a moved Chat back.
    if (outcome === "here" && release) await this.windows.releaseClosed(sessionId).catch((error: unknown) => { this.setApp({ error: error instanceof Error ? error.message : String(error) }); });
    return outcome !== "here";
  }


  private async claimChat(session: SessionInfo, context: Partial<AppState>, focus = true): Promise<boolean> {
    let claimed: boolean;
    try {
      claimed = await this.windows.claim(this.windowChat(session, context.selectedWorkspace ?? this.app.selectedWorkspace, context.selectedMachine?.id), focus);
    } catch (error) {
      // Unrecorded, other windows could claim it too: refuse it here.
      this.setApp({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    this.requestUpdate();
    if (!claimed) void this.openedElsewhere(this.windows.reservationId(session.id, session.startupToken), false);
    return claimed;
  }

  /** A Chat as this window records it, in the workspace it shows it in. */
  private windowChat(session: SessionInfo, workspace: Workspace | undefined, machineId = selectedMachineId(this.app)): WindowChat {
    const registered = workspace !== undefined && workspace.projectId !== "";
    return { sessionId: session.id, startupToken: session.startupToken, title: sessionTitle(session), machineId, projectId: registered ? workspace.projectId : undefined, workspaceId: registered ? workspace.id : undefined };
  }

  /** Another window asks this one to show one of its Chats, or to hand Chats dropped there over to it. */
  private answerWindow(request: WindowRequest, from: string, expires: number): boolean | Promise<boolean> {
    const chats = this.windows.window?.chats ?? [];
    if (request.kind === "move") {
      const { sessionIds } = request;
      const holds = () => this.windows.window?.chats.some((chat) => sessionIds.includes(chat.sessionId)) === true;
      return holds() ? this.moveWindowChats(sessionIds, from, expires)?.then(() => !holds()) ?? false : false;
    }
    const chat = chats.find((candidate) => candidate.sessionId === request.sessionId);
    if (chat === undefined) return false;
    if (request.anchor !== undefined) this.revealTarget = { machineId: chat.machineId, sessionId: chat.sessionId, anchor: request.anchor };
    window.focus();
    void this.showWindowChat(chat.sessionId);
    return true;
  }

  /** The window claims its id first, so the Chat it opens joins its own tabs. */
  private async startWindow(route: ParsedAppRoute): Promise<void> {
    await this.windows.start();
    await this.load(route);
  }

  private readonly onPageAttention = (): void => { this.desktopNotifications.clearVisible(this.app); };

  /** The macOS app reveals a message in the Chat this window already shows without reloading it. */
  private readonly onNativeNotificationOpen = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    if (typeof detail !== "object" || detail === null) return;
    const machineId: unknown = Reflect.get(detail, "machineId");
    const sessionId: unknown = Reflect.get(detail, "sessionId");
    const message: unknown = Reflect.get(detail, "message");
    if (typeof machineId !== "string" || machineId === "" || typeof sessionId !== "string" || sessionId === "") return;
    this.openNotificationChat(machineId, sessionId, typeof message === "string" && NOTIFICATION_ANCHOR.test(message) ? message : undefined);
  };

  /**
   * The macOS app asks each window before routing a notification click, since a window on another Space may be
   * suspended and miss other windows' requests; it then brings the holder forward and opens the Chat there.
   */
  private readonly onNativeNotificationHolds = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    if (typeof detail !== "object" || detail === null) return;
    const machineId: unknown = Reflect.get(detail, "machineId");
    const sessionId: unknown = Reflect.get(detail, "sessionId");
    if (typeof machineId === "string" && typeof sessionId === "string" && this.windows.holds(machineId, sessionId)) event.preventDefault();
  };

  private beginNavigation(): number { this.selectingChat = undefined; return ++this.navigationSequence; }

  private createChatSession(context: AppState): WorkbenchChatSession {
    const chat: WorkbenchChatSession = new WorkbenchChatSession(context, (runtime, patch, previous) => {
      const session = runtime.state.selectedSession;
      if (session !== undefined && this.focused.current !== runtime) {
        if (previous.status?.isStreaming === true && runtime.state.status?.isStreaming === false) this.unreadChats.add(session.id);
        if (previous.selectedSession?.id === session.id && previous.selectedSession !== session && this.windows.window?.chats.some((row) => row.sessionId === session.id && row.title !== sessionTitle(session)) === true) void this.updateWindow((store, id) => updateChat(store, id, session.id, { title: sessionTitle(session) }));
      }
      this.focused.changed(runtime, patch);
      if (session !== undefined && previous.selectedSession?.id !== session.id && runtime === this.focused.current && this.windows.window?.layout === "grid") void this.preparePage(session.id);
      if (runtime === this.launcher && this.focused.current === undefined) this.setApp(patch, false);
      this.requestUpdate();
    }, {
      draftStorage: () => this.windows.draftStorage,
      claimSession: (session, patch, focus) => this.claimChat(session, { selectedMachine: chat.state.selectedMachine, selectedWorkspace: chat.state.selectedWorkspace, ...patch }, focus !== false && this.focused.current === chat),
      replacePromptEditorText: (replacement) => this.replacePromptEditorText(replacement),
      onSelectedSessionReady: () => {
        if (this.focused.current === chat) {
          this.desktopNotifications.activate(this.app);
          void this.loadCurrentWorkstream();
        }
      },
      onSessionError: (message, eventId) => { if (this.focused.current === chat) this.desktopNotifications.sessionError(chat.state, message, eventId); },
      navigateToSession: async (session, options) => {
        if (session === undefined) { if (this.focused.current === chat) this.goHome(); return true; }
        if (options?.creationHandoff === true) {
          // Creation resolves inside its own runtime even while another Chat or the chooser owns window focus.
          await chat.sessions.selectSession(session, { updateUrl: false });
          return chat.state.selectedSession?.id === session.id;
        }
        chat.patch({ treeDialog: undefined, commandDialog: undefined });
        const context = { selectedMachine: chat.state.selectedMachine, selectedProject: chat.state.selectedProject, selectedWorkspace: chat.state.selectedWorkspace, workspaces: chat.state.workspaces };
        const original = chat.state.selectedSession;
        if (this.focused.current !== chat) await this.prepareChat(session, context);
        else await this.selectSession(session, { context });
        // A fork moves the daemon runtime to its new identity. The retained original Chat rejoins its untouched file.
        if (original !== undefined && original.id !== session.id) await chat.sessions.selectSession(original, { updateUrl: false });
        return this.app.selectedSession?.id === session.id;
      },
    }, (options) => { if (this.focused.current === chat) this.updateUrl(options); });
    this.chats.add(chat);
    return chat;
  }

  private focusRuntime(chat: WorkbenchChatSession, refreshCatalog = false): void {
    // Its next stream update must merge into the window's current aggregates, not its old background snapshot.
    chat.patch({ sessionStatuses: this.app.sessionStatuses, sessionActivities: this.app.sessionActivities }, false);
    const catalog = refreshCatalog && selectedMachineId(this.app) === selectedMachineId(chat.state) && this.app.selectedWorkspace?.id === chat.state.selectedWorkspace?.id ? this.app.sessions : chat.state.sessions;
    this.windowError = "";
    this.focused.focus(chat);
    this.setApp({ sessions: catalog }, false);
    if (this.realtimeMachineId !== selectedMachineId(this.app)) this.connectRealtime();
    this.desktopNotifications.activate(this.app);
    void this.loadCurrentWorkstream();
    const { selectedSession: session, selectedWorkspace: workspace } = this.app;
    if (refreshCatalog && session !== undefined && workspace !== undefined && !isCreatingSessionId(session.id)) void this.loadCatalogBehind(session.id, workspace, selectedMachineId(this.app), this.loadSequence);
  }

  private runtimeFor(sessionId: string, machineId: string): WorkbenchChatSession | undefined {
    return [...this.chats].find((chat) => selectedMachineId(chat.state) === machineId && (chat.state.selectedSession?.id === sessionId || chat.sessions.pendingSession(sessionId, undefined, true) !== undefined));
  }

  private pendingSession(sessionId: string, startupToken?: string, includeCompleting = false): SessionInfo | undefined {
    for (const chat of this.chats) {
      const pending = chat.sessions.pendingSession(sessionId, startupToken, includeCompleting);
      if (pending !== undefined) return pending;
    }
    return undefined;
  }

  private async replacePromptEditorText(replacement: PromptEditorTextReplacement): Promise<void> {
    await this.updateComplete;
    const pane = [...this.shadowRoot?.querySelectorAll<WorkbenchChatPane>("workbench-chat-pane") ?? []].find((candidate) => candidate.app?.selectedSession?.id === replacement.sessionId && selectedMachineId(candidate.app) === replacement.machineId);
    await pane?.replacePromptEditorText(replacement);
  }

  /** Going home clears window focus, not any Chat's connection, transcript, composer or draft. */
  private clearActiveSession(): void {
    this.focused.clear();
    const empty = initialAppState();
    this.setApp({ selectedSession: undefined, messages: [], status: undefined, activity: undefined, pendingAsks: [], pendingDialogs: [], closedDialogs: [], availableThinkingLevels: [], treeDialog: undefined, selectedNotificationInbox: undefined, commandDialog: undefined, authDialog: undefined, messagePageStart: empty.messagePageStart, messagePageEnd: empty.messagePageEnd, messagePageTotal: empty.messagePageTotal }, false);
  }

  private async prepareChat(session: SessionInfo, context: Partial<AppState>): Promise<WorkbenchChatSession> {
    const machineId = context.selectedMachine?.id ?? selectedMachineId(this.app);
    const existing = this.runtimeFor(session.id, machineId);
    if (existing !== undefined) { await existing.loading; return existing; }
    const chat = this.createChatSession({ ...initialAppState(), machines: this.app.machines, projects: this.app.projects, sessionStatuses: this.app.sessionStatuses, sessionActivities: this.app.sessionActivities, selectedMachine: this.app.machines.find((machine) => machine.id === machineId), ...context });
    await chat.prepare(session);
    if (!this.windows.holds(machineId, session.id) && !chat.pending) { chat.dispose(); this.chats.delete(chat); }
    this.releaseOffPageChats();
    return chat;
  }

  private async prepareWindowChat(chat: WindowChat): Promise<WorkbenchChatSession> {
    const existing = this.runtimeFor(chat.sessionId, chat.machineId);
    if (existing !== undefined) { await existing.loading; return existing; }
    const { project, projects, workspace, workspaces } = await this.windowChatWorkspace(chat);
    const session = this.pendingSession(chat.sessionId, chat.startupToken) ?? await this.knownSession(chat.sessionId, workspace.path, chat.machineId);
    if (session === undefined) throw new Error("This Chat is no longer available.");
    return this.prepareChat(session, { projects, selectedMachine: this.app.machines.find((machine) => machine.id === chat.machineId), selectedProject: project, selectedWorkspace: workspace, workspaces, sessions: [session] });
  }

  private async preparePage(focused: string): Promise<void> {
    const window = this.windows.window;
    if (window === undefined) return;
    await Promise.all(gridTiles({ ...window, focused }).map(async ({ chat }) => {
      const key = machineSessionKey(chat.machineId, chat.sessionId);
      try { await this.prepareWindowChat(chat); this.chatLoadErrors.delete(key); }
      catch (error) { if (this.windows.holds(chat.machineId, chat.sessionId)) this.chatLoadErrors.set(key, error instanceof Error ? error.message : String(error)); }
    }));
    this.requestUpdate();
  }

  /** A page is prepared behind the outgoing page. Only the final projection changes focus; no live Chat is reselected. */
  private async selectSession(session: SessionInfo, options?: SessionSelectionOptions): Promise<void> {
    const generation = options?.generation ?? this.beginNavigation();
    const context = options?.context ?? {};
    const selection = { sessionId: session.id, generation };
    this.selectingChat = selection;
    try {
      if (!await this.claimChat(session, context, false) || generation !== this.loadSequence) return;
      const warm = this.runtimeFor(session.id, context.selectedMachine?.id ?? selectedMachineId(this.app)) !== undefined;
      const runtime = await this.prepareChat(session, { selectedProject: this.app.selectedProject, selectedWorkspace: this.app.selectedWorkspace, workspaces: this.app.workspaces, sessions: this.app.sessions, ...context });
      const window = this.windows.window;
      if (window?.layout === "grid") await this.preparePage(session.id);
      if (generation !== this.loadSequence) return;
      await this.updateWindow((store, id) => focusChat(store, id, session.id));
      if (generation !== this.loadSequence) return;
      if (!this.windows.holds(selectedMachineId(runtime.state), session.id)) return;
      this.focusRuntime(runtime, warm && options?.onCommit === undefined);
      options?.onCommit?.();
      if (options?.updateUrl !== false) this.updateUrl();
      await this.updateComplete;
      this.releaseOffPageChats();
    } finally { if (this.selectingChat === selection) this.selectingChat = undefined; }
  }

  private releaseOffPageChats(): void {
    const window = this.windows.window;
    const kept = new Set(window === undefined ? [] : [this.app.selectedSession?.id ?? window.focused, this.selectingChat?.sessionId].flatMap((focused) => focused === undefined ? [] : gridTiles({ ...window, focused }).map((tile) => tile.chat.sessionId)));
    for (const chat of this.chats) {
      if (chat === this.focused.current || chat === this.launcher || chat.pending || kept.has(chat.state.selectedSession?.id ?? "")) continue;
      chat.dispose();
      this.chats.delete(chat);
    }
  }

  private async startSessionWithOptions(options?: { startupToken?: string; propagateError?: boolean }): Promise<SessionInfo | undefined> {
    const generation = this.beginNavigation();
    const chat = this.createChatSession({ ...initialAppState(), machines: this.app.machines, projects: this.app.projects, sessionStatuses: this.app.sessionStatuses, sessionActivities: this.app.sessionActivities, selectedMachine: this.app.selectedMachine, selectedProject: this.app.selectedProject, selectedWorkspace: this.app.selectedWorkspace, workspaces: this.app.workspaces, sessions: this.app.sessions });
    this.focused.focus(chat);
    const session = await chat.start(options);
    if (this.focused.current === chat && generation === this.loadSequence) { this.focusRuntime(chat); this.updateUrl(); }
    await this.updateComplete;
    this.releaseOffPageChats();
    return session;
  }

  private readonly onPopState = (): void => {
    if (this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() === false) {
      this.updateUrl({ replace: true });
      return;
    }
    if (this.sidePane === "files") this.sidePane = undefined;
    void this.load(readRoute(), { reuseLoaded: true });
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.windowMenu !== undefined) {
      event.stopPropagation();
      this.windowMenu = undefined;
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && this.windowLayoutKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "t" && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      this.goHome();
    } else if (event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "p" && !event.altKey && !event.shiftKey && this.app.selectedSession !== undefined
      && this.app.selectedWorkspace !== undefined
      && !hasRenderedModal(this.ownerDocument)) {
      event.preventDefault();
      this.openFileSearch();
    } else if (event.key === "+" || event.key === "=") { event.preventDefault(); this.stepScale(1); }
    else if (event.key === "-") { event.preventDefault(); this.stepScale(-1); }
    else if (event.key === "0") { event.preventDefault(); this.setScale(DEFAULT_INTERFACE_SCALE); }
  };

  /** ⌃G switches Grid and Tabs; ⌃↩ outside a text field toggles the focused tile's full size. */
  private windowLayoutKey(event: KeyboardEvent): boolean {
    const window = this.windows.window;
    if (window === undefined || window.chats.length === 0) return false;
    if (event.key.toLowerCase() === "g") {
      this.toggleWindowLayout();
      return true;
    }
    const typing = event.composedPath().some((target) => target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement));
    if (event.key !== "Enter" || window.layout !== "grid" || typing || this.app.selectedSession === undefined) return false;
    void this.updateWindow(toggleMaximized);
    return true;
  }

  private toggleWindowLayout(): void {
    void (async () => {
      const window = this.windows.window;
      const generation = this.loadSequence;
      if (window?.layout === "tabs" && this.app.selectedSession !== undefined) {
        await this.preparePage(this.app.selectedSession.id);
      }
      if (generation !== this.loadSequence) return;
      await this.updateWindow(toggleLayout);
      if (this.app.selectedSession !== undefined) void this.focusChatComposer();
    })();
  }

  private stepScale(direction: 1 | -1): void {
    this.setScale(stepInterfaceScale(readStoredInterfaceScale(), direction));
  }

  private setScale(scale: number): void {
    writeStoredInterfaceScale(scale);
    applyInterfaceScale(scale);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.stylesheetRuntime.connect(this.ownerDocument);
    void this.loadClientConfig();
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener(NATIVE_NOTIFICATION_OPEN_EVENT, this.onNativeNotificationOpen);
    window.addEventListener(NATIVE_NOTIFICATION_HOLDS_EVENT, this.onNativeNotificationHolds);
    window.addEventListener("focus", this.onPageAttention);
    document.addEventListener("visibilitychange", this.onPageAttention);
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("wheel", this.swipe.onWheel, { passive: false, capture: true });
    window.addEventListener("pointerdown", this.closeWindowMenu, { capture: true });
    applyPresentationProfile(readStoredPresentationProfile() ?? builtInPresentationProfile("comfortable"));
    this.systemLightThemeMedia?.addEventListener("change", this.onSystemLightThemeChange);
    void this.initializeThemes();
    const anchor = takeMessageAnchor();
    const route = readRoute();
    const revealed = anchor !== undefined && NOTIFICATION_ANCHOR.test(anchor) && route.sessionId !== undefined ? anchor : undefined;
    if (revealed !== undefined && route.sessionId !== undefined) this.revealTarget = { machineId: route.machineId ?? "local", sessionId: route.sessionId, anchor: revealed };
    void this.startWindow(route);
  }

  private async loadClientConfig(): Promise<void> {
    try {
      this.defaultStreamingBehavior = (await configApi.config()).effectiveConfig.defaultStreamingBehavior ?? "steer";
    } catch (error) {
      console.warn("Failed to load PI WEB config", error);
    }
  }

  private async initializeThemes(): Promise<void> {
    if (!this.themesInitialized) {
      this.themesInitialized = true;
      await this.plugins.register({ id: "themes", plugin: themePackPlugin });
      void this.loadContentRenderers();
    }
    if (!this.isConnected) return;
    this.applyPreferredTheme();
    this.requestUpdate();
  }

  // ponytail: the Workbench shell hosts no plugin panels or actions, so it loads only the enabled
  // gateway Mermaid renderer for Chat fences; widen the allowlist when another renderer plugin ships.
  private async loadContentRenderers(): Promise<void> {
    try {
      const { registrations } = await loadExternalPlugins("pi-web-plugins/manifest.json", { shouldLoadPlugin: (entry) => entry.id === "mermaid" && !entry.machineSpecific });
      if (registrations.length === 0) return;
      await this.plugins.registerBatch(registrations);
      // A new reference re-renders already displayed Chat messages.
      this.contentRendering = this.plugins.getChatContentRendering("local");
    } catch (error) {
      console.warn("Chat content renderers unavailable", error);
    }
  }

  override disconnectedCallback(): void {
    this.stylesheetRuntime.disconnect();
    this.beginNavigation();
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener(NATIVE_NOTIFICATION_OPEN_EVENT, this.onNativeNotificationOpen);
    window.removeEventListener(NATIVE_NOTIFICATION_HOLDS_EVENT, this.onNativeNotificationHolds);
    window.removeEventListener("focus", this.onPageAttention);
    document.removeEventListener("visibilitychange", this.onPageAttention);
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("wheel", this.swipe.onWheel, { capture: true });
    window.removeEventListener("pointerdown", this.closeWindowMenu, { capture: true });
    this.swipe.cancel();
    this.finishFilesResize();
    this.systemLightThemeMedia?.removeEventListener("change", this.onSystemLightThemeChange);
    this.realtime.close();
    this.realtimeMachineId = undefined;
    this.windows.dispose();
    window.clearTimeout(this.workstreamWatchTimer);
    for (const chat of this.chats) chat.dispose();
    this.chats.clear();
    this.focused.clear();
    this.launcher = undefined;
    super.disconnectedCallback();
  }

  private setApp(patch: Partial<AppState>, updateChat = true): void {
    const previous = this.app;
    if (updateChat) {
      const { error, ...chatPatch } = patch;
      if (error !== undefined) this.windowError = error;
      (this.focused.current ?? this.launcher)?.patch(chatPatch, false);
    }
    this.app = { ...this.app, ...patch };
    if (previous.selectedSession?.id !== this.app.selectedSession?.id || selectedMachineId(previous) !== selectedMachineId(this.app)) {
      this.currentWorkstream = undefined;
      window.clearTimeout(this.workstreamWatchTimer);
      this.workstreamWatchSequence = undefined;
      this.workstreamWatchDelay = 2_000;
      ++this.workstreamLoadSequence;
    }
    this.desktopNotifications.sync(previous, this.app);
    this.trackWindowChats(previous);
  }

  /** Keeps this window's open Chats in step with the Chat on screen, and marks the ones that finished out of view. */
  private trackWindowChats(previous: AppState): void {
    const session = this.app.selectedSession;
    for (const chat of this.windows.window?.chats ?? []) {
      if (chat.sessionId !== session?.id && previous.sessionStatuses[chat.sessionId]?.isStreaming === true && this.app.sessionStatuses[chat.sessionId]?.isStreaming !== true) this.unreadChats.add(chat.sessionId);
    }
    if (session === undefined || isCreatingSessionId(session.id)) return;
    this.unreadChats.delete(session.id);
    const title = sessionTitle(session);
    // Every newly selected Chat was claimed before it showed; only a changed session row can change its title.
    if (previous.selectedSession !== session && previous.selectedSession?.id === session.id && this.windows.window?.chats.find((chat) => chat.sessionId === session.id)?.title !== title) void this.updateWindow((store, id) => updateChat(store, id, session.id, { title }));
  }

  private updateWindow(change: (store: WindowStore, windowId: string) => WindowStore): Promise<void> {
    return this.windows.update(change).then((changed) => { if (changed) this.requestUpdate(); }, (error: unknown) => {
      // An unstored move keeps the Chats here: the window shows what the store still holds.
      this.setApp({ error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** Another window holds the Chat on screen: retire it at once. Chats moved here: show what this window now focuses. */
  private followWindowChange(): void {
    this.requestUpdate();
    const window = this.windows.window;
    const selected = this.app.selectedSession?.id;
    if (window === undefined || selected === undefined || isCreatingSessionId(selected) || window.focused === selected || window.focused === this.selectingChat?.sessionId) return;
    const lost = Object.entries(this.windows.store).some(([id, other]) => id !== this.windows.id && other.chats.some((chat) => chat.sessionId === selected));
    if (lost) { this.retireSelected(window.focused); this.releaseOffPageChats(); }
    this.showNext();
  }

  /** Takes the Chat on screen down at once, its composer saved and unmounted; the URL follows what shows next. */
  private retireSelected(next?: string): void {
    if (this.sidePane === "files") this.sidePane = undefined;
    this.beginNavigation();
    const row = this.windows.window?.chats.find((chat) => chat.sessionId === next);
    const runtime = row === undefined ? undefined : this.runtimeFor(row.sessionId, row.machineId);
    if (runtime?.ready === true && !this.retiringChats.has(row?.sessionId ?? "")) { this.focusRuntime(runtime, true); this.updateUrl(); }
    else this.clearActiveSession();
  }

  /** Shows the Chat this window focuses, or its home once nothing is on screen. */
  private showNext(): void {
    const next = this.windows.window?.focused;
    if (next === undefined) { if (this.app.selectedSession === undefined) this.updateUrl(); }
    else if (next !== this.app.selectedSession?.id) void this.showWindowChat(next);
  }

  private filesPaneCanClose(): boolean {
    return this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() !== false;
  }

  /** Shows one of this window's Chats, in its recorded workspace, without leaving the Chat on screen first; Files stays open. */
  private async showWindowChat(sessionId: string): Promise<void> {
    const chat = this.windows.window?.chats.find((candidate) => candidate.sessionId === sessionId);
    if (chat === undefined || sessionId === this.app.selectedSession?.id) return;
    const ready = this.runtimeFor(sessionId, chat.machineId);
    if (ready?.ready === true) {
      const generation = this.beginNavigation();
      this.selectingChat = { sessionId, generation };
      if (this.windows.window?.layout === "grid" && !gridTiles(this.windows.window).some((tile) => tile.chat.sessionId === sessionId)) await this.preparePage(sessionId);
      if (generation !== this.loadSequence || !this.windows.holds(chat.machineId, sessionId)) return;
      this.focusRuntime(ready, true);
      this.selectingChat = undefined;
      this.updateUrl();
      await this.updateWindow((store, id) => focusChat(store, id, sessionId));
      await this.updateComplete;
      if (generation === this.loadSequence) this.releaseOffPageChats();
      return;
    }
    const machineId = selectedMachineId(this.app);
    if (chat.machineId !== machineId) {
      writeRoute({ machineId: chat.machineId, projectId: chat.projectId, workspaceId: chat.workspaceId, sessionId, tool: undefined, view: "chat" });
      await this.load(readRoute(), { reuseLoaded: true });
      return;
    }
    const sequence = this.beginNavigation();
    const isCurrent = () => sequence === this.loadSequence && selectedMachineId(this.app) === machineId;
    try {
      const { project, workspace, workspaces } = await this.windowChatWorkspace(chat);
      const session = isCurrent() ? this.pendingSession(sessionId, chat.startupToken) ?? await this.knownSession(sessionId, workspace.path, machineId, isCurrent) : undefined;
      if (!isCurrent()) return;
      if (session === undefined) throw new Error("This Chat is no longer available.");
      await this.selectSession(session, this.inWorkspace(session, sequence, { selectedProject: project, workspaces, selectedWorkspace: workspace, sessions: [...unsavedChatsIn(this.app.sessions, workspace.path, session.id), session], error: "" }));
    } catch (error) {
      if (isCurrent()) this.setApp({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The registered workspace a window Chat was opened in while its project still lists it, else the Chat's folder. */
  private readonly windowChatWorkspace = async (chat: WindowChat): Promise<{ project: Project | undefined; projects: Project[]; workspace: Workspace; workspaces: Workspace[] }> => {
    const projects = chat.machineId === selectedMachineId(this.app) ? this.app.projects : await api.projects(chat.machineId);
    const project = projects.find((candidate) => candidate.id === chat.projectId);
    if (project !== undefined && chat.workspaceId !== undefined) {
      const loaded = chat.machineId === selectedMachineId(this.app) && this.app.workspaces.some((candidate) => candidate.id === chat.workspaceId && candidate.projectId === project.id);
      const workspaces = loaded ? this.app.workspaces : await api.workspaces(project.id, chat.machineId).catch((): Workspace[] => []);
      const workspace = workspaces.find((candidate) => candidate.id === chat.workspaceId);
      if (workspace !== undefined) return { project, projects, workspace, workspaces };
    }
    const pending = this.pendingSession(chat.sessionId, chat.startupToken);
    const folder = adHocWorkspace(pending?.cwd ?? (await api.locate(chat.sessionId, chat.machineId)).cwd);
    return { project: undefined, projects, workspace: folder, workspaces: [folder] };
  };

  /** Closes Chats in this window; closing the one on screen shows the next, or the home after the last. */
  private closeWindowChats(sessionIds: readonly string[]): void {
    void this.removeWindowChats(sessionIds, (store, id) => closeChats(store, id, sessionIds));
  }

  /**
   * Moves Chats to another window, which shows the first of them; settles once stored, undefined when they stay here.
   * A move another window asked for and gave up on by `expires` (ms) does not happen.
   */
  private moveWindowChats(sessionIds: readonly string[], targetWindowId: string, expires = Number.POSITIVE_INFINITY): Promise<void> | undefined {
    if (!this.windows.shared || !this.canMoveWindowChats(sessionIds)) return undefined;
    return this.removeWindowChats(sessionIds, (store, id) => Date.now() > expires ? store : moveChats(store, id, targetWindowId, sessionIds));
  }

  /** Staged attachments live in this window only, so a Chat holding any stays here until they are sent or removed. */
  private canMoveWindowChats(sessionIds: readonly string[]): boolean {
    const held = this.windows.window?.chats.find((chat) => sessionIds.includes(chat.sessionId) && this.holdsComposerState(chat));
    if (held === undefined) return true;
    this.windowMenu = undefined;
    this.setApp({ error: `Send or remove the attachments staged in "${held.title}" before moving it to another window.` });
    return false;
  }

  private holdsComposerState({ machineId, sessionId }: WindowChat): boolean {
    const staged = loadStagedAttachmentDraft(resolveStagedAttachmentKey(machineSessionKey(machineId, sessionId)));
    return staged.attachments.length > 0 || staged.pendingImageReferences.length > 0;
  }

  /** Dragging a Chat out starts the move in the window that holds it; one with staged composer state does not lift. */
  private readonly guardChatDrag = (event: DragEvent): void => {
    const dragged = droppedChats(event);
    if (dragged !== undefined && (!this.windows.shared || !this.canMoveWindowChats(dragged.sessionIds))) event.preventDefault();
  };

  /**
   * Settles once stored; undefined when the owner kept unsaved file edits of the Chat on screen, which then stays. The
   * Chat on screen retires (its composer gone) before the store lets another window claim it; one the store still keeps
   * here returns with its composer text, which full storage may not have saved.
   */
  private removeWindowChats(sessionIds: readonly string[], change: (store: WindowStore, windowId: string) => WindowStore): Promise<void> | undefined {
    this.windowMenu = undefined;
    // A creation reservation cannot leave its window until completion has retired the temporary composer.
    if (sessionIds.some((id) => this.pendingSession(id, undefined, true) !== undefined)) {
      this.setApp({ error: "This Chat is still being created. Try again once creation finishes." });
      return undefined;
    }
    // Only this window can restore a prompt the server refuses, so the Chat stays until its send is answered.
    if (this.windows.window?.chats.some((chat) => sessionIds.includes(chat.sessionId) && hasUnacknowledgedSend(chat.machineId, chat.sessionId)) === true) {
      this.setApp({ error: "A message in this Chat is still being sent. Try again once it is delivered." });
      return undefined;
    }
    const selected = this.app.selectedSession?.id;
    const leaving = selected !== undefined && sessionIds.includes(selected) ? selected : undefined;
    if (leaving !== undefined && !this.filesPaneCanClose()) return undefined;
    const drafts = [...this.shadowRoot?.querySelectorAll<WorkbenchChatPane>("workbench-chat-pane") ?? []].flatMap((pane) => {
      const state = pane.app;
      const sessionId = state?.selectedSession?.id;
      const text = pane.promptEditor?.view?.state.doc.toString();
      return state === undefined || sessionId === undefined || text === undefined || !sessionIds.includes(sessionId) ? [] : [{ machineId: selectedMachineId(state), sessionId, text }];
    });
    for (const id of sessionIds) this.retiringChats.add(id);
    if (leaving !== undefined) this.retireSelected(change(this.windows.store, this.windows.id)[this.windows.id]?.focused);
    this.requestUpdate();
    return this.updateComplete.then(() => this.updateWindow(change)).then(async () => {
      for (const id of sessionIds) this.retiringChats.delete(id);
      this.requestUpdate();
      const retained = this.windows.window?.chats ?? [];
      for (const chat of this.chats) if (sessionIds.includes(chat.state.selectedSession?.id ?? "") && !retained.some((row) => row.sessionId === chat.state.selectedSession?.id)) {
        chat.dispose(); this.chats.delete(chat);
      }
      if (leaving !== undefined) {
        if (!retained.some((chat) => chat.sessionId === leaving)) { this.showNext(); return; }
        const { error } = this.app;
        await this.showWindowChat(leaving);
        this.setApp({ error });
      }
      await this.updateComplete;
      for (const draft of drafts) await this.replacePromptEditorText(draft);
    });
  }

  /** Opens a new window (a native window in the macOS app) on the moved Chats; it restores like any other. */
  private moveToNewWindow(sessionIds: readonly string[]): void {
    const first = this.windows.window?.chats.find((chat) => chat.sessionId === sessionIds[0]);
    if (first === undefined) return;
    const target = this.windows.newWindowId();
    if (this.moveWindowChats(sessionIds, target) === undefined) return;
    const params = new URLSearchParams({ [WINDOW_URL_PARAM]: target });
    if (first.machineId !== "local") params.set("machine", first.machineId);
    if (first.projectId !== undefined && first.workspaceId !== undefined) { params.set("project", first.projectId); params.set("workspace", first.workspaceId); }
    params.set("session", first.sessionId);
    params.set("view", "chat");
    window.open(resolveAppUrl(`?${params.toString()}`), "_blank");
  }

  /** Chats dragged here from another window's tabs or tiles: that window hands them over once its own guards allow. */
  private async takeDroppedChats({ windowId, sessionIds }: DraggedChats): Promise<void> {
    if (windowId === this.windows.id || !this.windows.shared || !await this.windows.ask(windowId, { kind: "move", sessionIds }, MOVE_REPLY_MS)) return;
    // Re-reads the store the other window just wrote, whose storage event may still be on its way.
    await this.updateWindow((store) => store);
    const focused = this.windows.window?.focused;
    if (focused !== undefined) void this.showWindowChat(focused);
  }

  private readonly closeWindowMenu = (event: Event): void => {
    if (this.windowMenu !== undefined && !event.composedPath().some((target) => target instanceof HTMLElement && target.classList.contains("window-menu"))) this.windowMenu = undefined;
  };

  /** Interface scale zooms the page, so pointer positions arrive scaled while the menu is placed in CSS pixels. */
  private openWindowMenu({ sessionIds, label, clientX, clientY }: ChatTabMenuDetail): void {
    const scale = readStoredInterfaceScale();
    this.windowMenu = { sessionIds, label, left: Math.min(clientX / scale, globalThis.innerWidth / scale - 240), top: clientY / scale };
  }

  private renderWindowMenu() {
    const menu = this.windowMenu;
    if (menu === undefined) return nothing;
    const shared = this.windows.shared;
    const others = shared ? Object.entries(this.windows.store).filter(([id]) => id !== this.windows.id) : [];
    const window = this.windows.window;
    const single = menu.sessionIds.length === 1 ? menu.sessionIds[0] : undefined;
    const sizing = single !== undefined && single === this.app.selectedSession?.id && window?.layout === "grid" && window.chats.length > 1;
    return html`
      <div class="window-menu" role="menu" aria-label=${menu.label} style=${styleMap({ left: `${String(menu.left)}px`, top: `${String(menu.top)}px` })}>
        ${shared ? html`<button role="menuitem" @click=${() => { this.moveToNewWindow(menu.sessionIds); }}>Move to new window</button>` : nothing}
        ${others.map(([id, other]) => html`<button role="menuitem" @click=${() => { void this.moveWindowChats(menu.sessionIds, id); }}>Move to ${other.name}${this.windows.isAlive(id) ? "" : " (closed)"}</button>`)}
        ${shared ? html`<hr>` : nothing}
        ${sizing ? html`<button role="menuitem" @click=${() => { this.windowMenu = undefined; void this.updateWindow(toggleMaximized); }}>${window.maximized ? "Restore grid" : "Full size"}</button>` : nothing}
        <button role="menuitem" @click=${() => { this.closeWindowChats(menu.sessionIds); }}>${single === undefined ? `Close ${String(menu.sessionIds.length)} Chats` : "Close"}</button>
      </div>
    `;
  }

  /** The home: projects, Workstreams and All sessions, with this window's tabs still above it. */
  private goHome(discardConfirmed = false): void {
    if (this.app.selectedSession === undefined || !discardConfirmed && !this.filesPaneCanClose()) return;
    if (this.sidePane === "files") this.sidePane = undefined;
    this.beginNavigation();
    this.clearActiveSession();
    this.updateUrl();
  }

  private chatTabStatuses(): Record<string, ChatTabStatus> {
    return Object.fromEntries((this.windows.window?.chats ?? []).map((chat) => [chat.sessionId, chatTabStatus(this.runtimeFor(chat.sessionId, chat.machineId)?.state.status ?? this.app.sessionStatuses[chat.sessionId], this.unreadChats.has(chat.sessionId))]));
  }

  /** The selected Chat's live open asks, and every other Chat's as its last status reported them, else as read when the window connected. */
  private chatQuestionCounts(): Record<string, number> {
    const asks = (chat: WindowChat) => {
      const runtime = this.runtimeFor(chat.sessionId, chat.machineId);
      if (runtime?.ready === true) return runtime.state.pendingAsks;
      const status = this.app.sessionStatuses[chat.sessionId];
      return status === undefined ? this.restoredAsks[machineSessionKey(chat.machineId, chat.sessionId)] : status.pendingAsks;
    };
    return Object.fromEntries((this.windows.window?.chats ?? []).map((chat) => [chat.sessionId, openQuestionCount(asks(chat))]));
  }

  /** The Chat's Workstream names its tab group once known; an unreachable Workstream service keeps the last name. */
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    this.guardFilesTarget();
    const session = this.app.selectedSession;
    if (!changed.has("currentWorkstream") || session === undefined || this.currentWorkstream === undefined || this.currentWorkstreamError !== "") return;
    const snapshot = this.currentWorkstream;
    void this.updateWindow((store, id) => updateChat(store, id, session.id, { workstream: snapshot === null ? undefined : { id: snapshot.id, title: snapshot.title } }));
  }

  /**
   * `reuseLoaded`: Back and notification clicks keep this window's machines, projects, and realtime socket on the same
   * machine. `push`: the route becomes a new history entry, unless the Chat opens in the other window holding it. That
   * leaves a window showing something as it is; a window still starting shows its own last Chat, else its home.
   */
  private async load(route: ParsedAppRoute, options?: { reuseLoaded?: boolean; push?: boolean }): Promise<void> {
    const navigation = this.loadSequence;
    if (route.sessionId !== undefined && await this.openedElsewhere(route.sessionId)) {
      if (navigation !== this.loadSequence) return;
      if (this.app.selectedMachine !== undefined) {
        if (options?.push !== true) this.updateUrl({ replace: true });
        return;
      }
      const window = this.windows.window;
      const own = window?.chats.find((chat) => chat.sessionId === window.focused);
      route = own === undefined
        ? { ...route, sessionId: undefined, tool: undefined, view: undefined }
        : { machineId: own.machineId, projectId: own.projectId, workspaceId: own.workspaceId, sessionId: own.sessionId, tool: undefined, view: "chat" };
      writeRoute(route, { replace: true });
    } else if (options?.push === true) writeRoute(route);
    const ready = route.sessionId === undefined ? undefined : this.runtimeFor(route.sessionId, route.machineId ?? "local");
    if (options?.reuseLoaded === true && ready?.ready === true && this.windows.holds(selectedMachineId(ready.state), route.sessionId ?? "")) {
      const generation = this.beginNavigation();
      this.selectingChat = { sessionId: route.sessionId ?? "", generation };
      if (this.windows.window?.layout === "grid") await this.preparePage(route.sessionId ?? "");
      if (generation !== this.loadSequence) return;
      this.focusRuntime(ready, true);
      this.selectingChat = undefined;
      await this.updateWindow((store, id) => focusChat(store, id, route.sessionId ?? ""));
      this.updateUrl({ replace: true });
      await this.updateComplete;
      if (generation === this.loadSequence) this.releaseOffPageChats();
      return;
    }
    const sequence = this.beginNavigation();
    const previous = this.app;
    const selectedWorkspace = this.app.selectedWorkspace;
    const retainSelection = completeChatRoute(route)
      && route.sessionId === this.app.selectedSession?.id
      && route.projectId === this.app.selectedProject?.id
      && route.workspaceId === selectedWorkspace?.id
      && (route.machineId ?? "local") === selectedMachineId(this.app);
    if (retainSelection) this.desktopNotifications.suspend();
    this.loadingAt = sequence;
    if (!retainSelection) this.clearActiveSession();
    try {
      const reuse = options?.reuseLoaded === true && previous.selectedMachine?.id === (route.machineId ?? "local");
      const machines = reuse ? previous.machines : await api.machines();
      if (sequence !== this.loadSequence) return;
      const machine = machines.find((candidate) => candidate.id === (route.machineId ?? "local"))
        ?? machines.find((candidate) => candidate.id === "local")
        ?? machines[0];
      const keepSelection = retainSelection && machine?.id === selectedMachineId(this.app);
      if (retainSelection && !keepSelection) this.clearActiveSession();
      // A connected realtime socket keeps live Chat states current, so keep them instead of waiting for its reconnect snapshot.
      const keepRealtime = this.realtimeMachineId === (machine?.id ?? "local");
      this.setApp(keepSelection
        ? { machines, selectedMachine: machine, error: "" }
        : { ...initialAppState(), ...(keepRealtime ? { sessionStatuses: this.app.sessionStatuses, sessionActivities: this.app.sessionActivities } : {}), machines, selectedMachine: machine });
      if (!keepRealtime) this.connectRealtime();
      if (machine === undefined) throw new Error("No PI WEB machine is available.");

      const previousRows = selectedMachineId(previous) === machine.id ? previous.sessions : [];
      const isCurrent = () => sequence === this.loadSequence;
      const knownProjects = reuse && previous.projects.length > 0 && (route.projectId === undefined || previous.projects.some((candidate) => candidate.id === route.projectId));
      const projects = knownProjects ? previous.projects : await api.projects(machine.id);
      if (sequence !== this.loadSequence) return;
      this.setApp({ projects });
      if (!completeChatRoute(route)) {
        if (route.sessionId !== undefined && route.projectId === undefined) { await this.openSessionAnywhere(route.sessionId, machine.id, sequence, previousRows); return; }
        await this.restoreLastWorkspace(projects, machine.id, sequence);
        return;
      }

      const project = projects.find((candidate) => candidate.id === route.projectId);
      if (project === undefined) throw new Error("The selected project is no longer available.");
      const workspaces = await api.workspaces(project.id, machine.id);
      if (sequence !== this.loadSequence) return;
      const workspace = workspaces.find((candidate) => candidate.id === route.workspaceId);
      if (workspace === undefined) throw new Error("The selected workspace is no longer available.");
      const session = await this.knownSession(route.sessionId, workspace.path, machine.id, isCurrent);
      if (sequence !== this.loadSequence) return;
      if (session === undefined) throw new Error("The selected session is no longer available.");
      await this.selectSession(session, { updateUrl: false, ...this.inWorkspace(session, sequence, { selectedProject: project, workspaces, selectedWorkspace: workspace, sessions: keepSelection ? this.app.sessions : [...unsavedChatsIn(previousRows, workspace.path, session.id), session] }) });
      // A reservation resolved to its created Chat: the address names that Chat from now on.
      if (route.sessionId !== session.id && this.app.selectedSession?.id === session.id) this.updateUrl({ replace: true });
    } catch (error) {
      if (sequence === this.loadSequence) {
        if (retainSelection) this.clearActiveSession();
        this.setApp({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (sequence === this.loadSequence) this.loadingAt = undefined;
    }
  }

  private static readonly LAST_WORKSPACE_KEY = "pi-workbench.last-workspace";

  private rememberWorkspace(): void {
    const project = this.app.selectedProject;
    const workspace = this.app.selectedWorkspace;
    try {
      if (project === undefined || workspace === undefined) return;
      localStorage.setItem(WorkbenchApp.LAST_WORKSPACE_KEY, JSON.stringify({ machineId: selectedMachineId(this.app), projectId: project.id, workspaceId: workspace.id }));
    } catch { /* ignore storage errors */ }
  }

  /** Reopen the chooser on the workspace used last time so New Chat is one click. */
  private async restoreLastWorkspace(projects: Project[], machineId: string, sequence: number): Promise<void> {
    void machineId;
    let saved: unknown;
    try {
      const raw = localStorage.getItem(WorkbenchApp.LAST_WORKSPACE_KEY);
      saved = raw === null ? undefined : JSON.parse(raw);
    } catch { saved = undefined; }
    const record = typeof saved === "object" && saved !== null && "machineId" in saved && "projectId" in saved && "workspaceId" in saved && saved.machineId === machineId ? saved : undefined;
    const projectId = record !== undefined && typeof record.projectId === "string" ? record.projectId : undefined;
    const workspaceId = record !== undefined && typeof record.workspaceId === "string" ? record.workspaceId : undefined;
    const project = projects.find((candidate) => candidate.id === projectId) ?? rootProjects(projects)[0];
    if (project === undefined || sequence !== this.loadSequence) return;
    await this.chooseProject(rootProjectOf(project, projects).id, workspaceId);
  }

  /** Reopen a Chat that belongs to no project: find its folder by id, then treat that folder as an ad-hoc workspace. */
  private async openSessionAnywhere(sessionId: string, machineId: string, sequence: number, previousRows: readonly SessionInfo[]): Promise<void> {
    const { cwd } = await api.locate(sessionId, machineId).catch(() => ({ cwd: undefined }));
    if (sequence !== this.loadSequence) return;
    const workspace = cwd === undefined ? undefined : adHocWorkspace(cwd);
    const session = workspace === undefined ? undefined : await this.knownSession(sessionId, workspace.path, machineId, () => sequence === this.loadSequence);
    if (sequence !== this.loadSequence) return;
    if (workspace === undefined || session === undefined) throw new Error("The selected session is no longer available.");
    await this.selectSession(session, { updateUrl: false, ...this.inWorkspace(session, sequence, { selectedProject: undefined, workspaces: [workspace], selectedWorkspace: workspace, sessions: [...unsavedChatsIn(previousRows, workspace.path, session.id), session] }) });
  }

  /**
   * The listing row for exactly this Chat, without waiting for its workspace catalog. A current daemon answers with the
   * row or 404, and its metadata keeps the archived flag authoritative. An older daemon ignores the id and returns the
   * whole catalog; only there may a missing row be a blank Chat rebuilt from status, and only while `isCurrent` holds.
   */
  private async knownSession(id: string, cwd: string, machineId: string, isCurrent: () => boolean = () => true): Promise<SessionInfo | undefined> {
    if (isCreatingSessionId(id)) {
      // A reload mid-creation leaves only this window's reservation; the daemon lists the Chat it became by its token.
      const token = this.windows.window?.chats.find((chat) => chat.sessionId === id)?.startupToken;
      return token === undefined ? undefined : (await api.sessions(cwd, machineId)).find((row) => row.startupToken === token);
    }
    let listed: SessionInfo[];
    try {
      listed = await api.sessions(cwd, machineId, { sessionId: id });
    } catch (error) {
      if (error instanceof HttpRequestError && error.status === 404) return undefined;
      throw error;
    }
    const row = listed.find((candidate) => candidate.id === id);
    return row !== undefined || !isCurrent() ? row : this.unlistedSession(id, cwd, machineId);
  }

  private inWorkspace(session: SessionInfo, generation: number, context: Partial<AppState> & { selectedWorkspace: Workspace }): SessionSelectionOptions {
    const machineId = selectedMachineId(this.app);
    return { generation, context, onCommit: () => { void this.loadCatalogBehind(session.id, context.selectedWorkspace, machineId, generation); } };
  }

  /**
   * Fill the workspace catalog behind a Chat opened from its targeted row. The full listing keeps its daemon-side unread
   * reconciliation; a response for a superseded load, machine, or workspace is dropped. Rows the catalog cannot know yet
   * (the opened or selected Chat, and any never-saved blank or pending Chat) are kept, as is the opened and selected rows'
   * live state; only the catalog's archive overrides that state, so an archived Chat never stays writable.
   */
  private async loadCatalogBehind(sessionId: string, workspace: Workspace, machineId: string, sequence: number): Promise<void> {
    let listed: SessionInfo[];
    try {
      listed = await api.sessions(workspace.path, machineId);
    } catch (error) {
      if (this.catalogIsCurrent(workspace, machineId, sequence)) this.setApp({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!this.catalogIsCurrent(workspace, machineId, sequence)) return;
    const current = this.app.sessions;
    const listedIds = new Set(listed.map((candidate) => candidate.id));
    const keepIds = new Set([sessionId, this.app.selectedSession?.id]);
    const kept = current.filter((candidate) => !listedIds.has(candidate.id) && (keepIds.has(candidate.id) || candidate.persisted === false));
    const merged = listed.map((row) => {
      const live = keepIds.has(row.id) ? current.find((candidate) => candidate.id === row.id) : undefined;
      return live === undefined ? row : withListedArchive(live, row);
    });
    const selected = this.app.selectedSession;
    const selectedRow = selected === undefined ? undefined : listed.find((row) => row.id === selected.id);
    this.setApp({ sessions: [...kept, ...merged], ...(selected === undefined || selectedRow === undefined ? {} : { selectedSession: withListedArchive(selected, selectedRow) }) });
  }

  private catalogIsCurrent(workspace: Workspace, machineId: string, sequence: number): boolean {
    return sequence === this.loadSequence && selectedMachineId(this.app) === machineId && this.app.selectedWorkspace?.id === workspace.id;
  }

  /** A Chat with no user message yet is not listed, but the daemon still serves it; rebuild it from status so a reload keeps it open. */
  private async unlistedSession(id: string, cwd: string, machineId: string): Promise<SessionInfo | undefined> {
    const status = await api.status({ id, cwd }, machineId).catch(() => undefined);
    if (status === undefined) return undefined;
    const now = new Date().toISOString();
    return { id, cwd, path: "", persisted: status.persisted ?? false, created: now, modified: now, messageCount: 0, firstMessage: "" };
  }

  private connectRealtime(): void {
    this.realtime.close();
    const machineId = selectedMachineId(this.app);
    this.realtimeMachineId = machineId;
    this.realtime.connect((event) => { this.handleRealtimeEvent(event); }, () => { this.refreshWindowChatAsks(machineId); }, machineId);
  }

  /** Open asks read for this window's other Chats as the window connects, by machine-scoped key; a status, once known, supersedes them. */
  @state() private restoredAsks: Record<string, readonly PendingAskUser[]> = {};

  /** Open-ask reads in flight, by machine-scoped session key. */
  private readonly askRequests = new Set<string>();

  /**
   * On every (re)connect, reads once the open asks of each other Chat this window holds on the machine, so a restored
   * idle Chat's tab counts its questions before anything streams. The read never opens a Chat: opening a cold one would
   * redeliver its recorded answers and start a turn nobody asked for. Live status updates take over from there.
   */
  private refreshWindowChatAsks(machineId: string): void {
    for (const chat of this.windows.window?.chats ?? []) {
      const key = machineSessionKey(machineId, chat.sessionId);
      if (chat.machineId !== machineId || chat.sessionId === this.app.selectedSession?.id || this.askRequests.has(key)) continue;
      this.askRequests.add(key);
      void this.windowChatWorkspace(chat)
        .then(({ workspace }) => api.openAsks({ id: chat.sessionId, cwd: workspace.path }, machineId))
        .then((asks) => { this.restoredAsks = { ...this.restoredAsks, [key]: asks }; })
        .catch(() => undefined)
        .finally(() => { this.askRequests.delete(key); });
    }
  }

  private handleRealtimeEvent(event: BrowserRealtimeEvent): void {
    if (event.type === "session.attention") {
      this.desktopNotifications.attention(this.app, event, selectedMachineId(this.app));
      return;
    }
    if (event.type !== "sessions.unread" && event.type !== "notices.updated" && event.type !== "machine.status") {
      this.sessions.applyGlobalEvent(event);
      for (const chat of this.chats) if (chat.sessions !== this.sessions && selectedMachineId(chat.state) === selectedMachineId(this.app)) chat.sessions.applyGlobalEvent(event);
    }
  }

  private async chooseMachine(machineId: string): Promise<void> {
    const machine = this.app.machines.find((candidate) => candidate.id === machineId);
    if (machine === undefined || machine.id === this.app.selectedMachine?.id) return;
    const sequence = this.beginNavigation();
    this.loadingAt = sequence;
    this.clearActiveSession();
    this.setApp({ ...initialAppState(), machines: this.app.machines, selectedMachine: machine });
    this.connectRealtime();
    try {
      const projects = await api.projects(machine.id);
      if (sequence === this.loadSequence) this.setApp({ projects });
    } catch (error) {
      if (sequence === this.loadSequence) this.setApp({ error: String(error) });
    } finally {
      if (sequence === this.loadSequence) this.loadingAt = undefined;
    }
  }

  private async chooseProject(projectId: string, preferredWorkspaceId?: string): Promise<void> {
    const project = this.app.projects.find((candidate) => candidate.id === projectId);
    const sequence = this.beginNavigation();
    this.clearActiveSession();
    this.setApp({ selectedProject: project, selectedWorkspace: undefined, workspaces: [], sessions: [], error: "" });
    if (project === undefined) return;
    this.loadingAt = sequence;
    try {
      const machineId = selectedMachineId(this.app);
      const workspaces = (await Promise.all(subprojectsOf(project, this.app.projects).map((member) => api.workspaces(member.id, machineId)))).flat();
      if (sequence !== this.loadSequence) return;
      this.setApp({ workspaces });
      const preferred = workspaces.find((candidate) => candidate.id === preferredWorkspaceId)
        ?? workspaces.find((candidate) => candidate.projectId === project.id && candidate.isMain) ?? workspaces[0];
      if (preferred !== undefined) await this.chooseWorkspace(preferred.id);
    } catch (error) {
      if (sequence === this.loadSequence) this.setApp({ error: String(error) });
    } finally {
      if (sequence === this.loadSequence) this.loadingAt = undefined;
    }
  }

  private async chooseWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.app.workspaces.find((candidate) => candidate.id === workspaceId);
    const sequence = this.beginNavigation();
    this.clearActiveSession();
    const owner = this.app.projects.find((candidate) => candidate.id === workspace?.projectId) ?? this.app.selectedProject;
    this.setApp({ selectedProject: owner, selectedWorkspace: workspace, sessions: [], error: "" });
    if (workspace === undefined) return;
    this.loadingAt = sequence;
    try {
      const sessions = await api.sessions(workspace.path, selectedMachineId(this.app));
      if (sequence === this.loadSequence) { this.setApp({ sessions }); this.rememberWorkspace(); }
    } catch (error) {
      if (sequence === this.loadSequence) this.setApp({ error: String(error) });
    } finally {
      if (sequence === this.loadSequence) this.loadingAt = undefined;
    }
  }

  private async openSession(session: SessionInfo): Promise<void> {
    if (!await this.openedElsewhere(session.id)) await this.showOpenedSession(session);
  }

  private async showOpenedSession(session: SessionInfo, options?: SessionSelectionOptions): Promise<void> {
    await this.selectSession(session, options);
    await this.focusChatComposer();
  }

  private async openAllSession(session: SessionInfo): Promise<void> {
    if (await this.openedElsewhere(session.id)) return;
    const generation = this.beginNavigation();
    this.setApp({ error: "" });
    try {
      const registered = await this.registeredWorkspaceForCwd(session.cwd, selectedMachineId(this.app));
      const workspace = registered?.workspace ?? adHocWorkspace(session.cwd);
      await this.showOpenedSession(session, { generation, context: { selectedProject: registered?.project, selectedWorkspace: workspace, workspaces: registered?.workspaces ?? [workspace], sessions: [session] } });
    } catch (error) {
      this.setApp({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A Git worktree may be a sibling of its registered project's root, not a descendant. */
  private registeredWorkspaceForCwd(cwd: string, machineId: string, isCurrent?: () => boolean): Promise<{ project: Project; workspace: Workspace; workspaces: Workspace[] } | undefined> {
    return this.firstRegisteredWorkspace([...this.app.projects].sort((a, b) => b.path.length - a.path.length), machineId, (workspace) => workspace.path === cwd, isCurrent);
  }

  /** The first project, in the given order, that lists a matching workspace; no further batch starts once `isCurrent` fails. */
  private async firstRegisteredWorkspace(projects: readonly Project[], machineId: string, matches: (workspace: Workspace) => boolean, isCurrent: () => boolean = () => true): Promise<{ project: Project; workspace: Workspace; workspaces: Workspace[] } | undefined> {
    // ponytail: fixed batches of 4 bound the fan-out; a server lookup by path would make this one request.
    for (let start = 0; start < projects.length && isCurrent(); start += 4) {
      const listed = await Promise.all(projects.slice(start, start + 4).map(async (project) => {
        const workspaces = await api.workspaces(project.id, machineId).catch((): Workspace[] => []);
        return { project, workspaces, workspace: workspaces.find(matches) };
      }));
      const hit = listed.find((candidate) => candidate.workspace !== undefined);
      if (hit?.workspace !== undefined) return { project: hit.project, workspace: hit.workspace, workspaces: hit.workspaces };
    }
    return undefined;
  }

  /**
   * The authoritative Chat in its recorded workspace. Only a legacy catalog miss may reconstruct a blank Chat from status.
   */
  private async anchoredWorkstreamSession(detail: OpenWorkstreamSessionDetail, machineId: string, isCurrent: () => boolean): Promise<{ project: Project; workspace: Workspace; workspaces: Workspace[]; session: SessionInfo } | undefined> {
    const project = this.app.projects.find((candidate) => candidate.id === detail.projectId);
    if (project === undefined || detail.workspaceId === undefined) return undefined;
    const workspaces = await api.workspaces(project.id, machineId).catch((): Workspace[] => []);
    if (!isCurrent()) return undefined;
    const workspace = workspaces.find((candidate) => candidate.id === detail.workspaceId);
    if (workspace === undefined) return undefined;
    // A failed or missing row falls back to the locate path instead of guessing a row from status.
    try {
      const session = await this.knownSession(detail.sessionId, workspace.path, machineId, isCurrent);
      return session === undefined ? undefined : { project, workspace, workspaces, session };
    } catch {
      return undefined;
    }
  }

  /** Open the session that wrote a Workstream's newest checkpoint, wherever it lives. */
  private async openWorkstreamSession(detail: OpenWorkstreamSessionDetail): Promise<void> {
    if (await this.openedElsewhere(detail.sessionId)) return;
    const machineId = selectedMachineId(this.app);
    const open = ++this.workstreamOpenSequence;
    let navigation = this.loadSequence;
    // A newer open, any navigation, or a machine switch supersedes this lookup. A lookup leaves in-flight navigation alone.
    const isCurrent = () => open === this.workstreamOpenSequence && navigation === this.loadSequence && selectedMachineId(this.app) === machineId;
    // Applying the Chat takes over navigation: in-flight chooser and boot loads are dropped, so their Loading ends here.
    const apply = (session: SessionInfo, project: Project | undefined, workspace: Workspace, workspaces: Workspace[]) => {
      const projectsPending = this.loading && this.app.projects.length === 0;
      navigation = this.beginNavigation();
      // ponytail: re-asks for the projects of an interrupted machine boot; resuming the dropped request would need per-step sequences.
      if (projectsPending) void api.projects(machineId).then((projects) => { if (selectedMachineId(this.app) === machineId && this.app.projects.length === 0) this.setApp({ projects }); }, () => undefined);
      return { selectedProject: project, selectedWorkspace: workspace, workspaces, sessions: [...unsavedChatsIn(this.app.sessions, workspace.path, session.id), session] };
    };
    this.setApp({ error: "" });
    try {
      const anchored = await this.anchoredWorkstreamSession(detail, machineId, isCurrent);
      if (!isCurrent()) return;
      if (anchored !== undefined) {
        const context = apply(anchored.session, anchored.project, anchored.workspace, anchored.workspaces);
        await this.showOpenedSession(anchored.session, this.inWorkspace(anchored.session, navigation, context));
        return;
      }
      const { cwd } = await api.locate(detail.sessionId, machineId);
      if (!isCurrent()) return;
      // Every located Chat needs archive-authoritative metadata, whether or not the Workstream recorded an anchor.
      const [session, registered] = await Promise.all([
        this.knownSession(detail.sessionId, cwd, machineId, isCurrent),
        this.registeredWorkspaceForCwd(cwd, machineId, isCurrent),
      ]);
      if (!isCurrent()) return;
      if (session === undefined) throw new Error(`Session ${detail.sessionId} is unavailable under ${cwd}.`);
      const workspace = registered?.workspace ?? adHocWorkspace(cwd);
      const context = apply(session, registered?.project, workspace, registered?.workspaces ?? [workspace]);
      await this.showOpenedSession(session, { generation: navigation, context });
    } catch (error) {
      if (isCurrent()) this.setApp({ error: `${error instanceof Error ? error.message : String(error)} Start a new session for this Workstream instead.` });
    }
  }

  private async startWorkstreamSession(detail: StartWorkstreamSessionDetail): Promise<void> {
    const machineId = selectedMachineId(this.app);
    this.setApp({ error: "" });
    let cwd: string;
    let match: { project: Project; workspaces: Workspace[] } | undefined;
    try {
      const referencedDirectory = detail.directories[0];
      if (detail.useSelectedWorkspace === true) {
        const workspace = this.app.selectedWorkspace;
        if (workspace === undefined) throw new Error("Choose a workspace before starting this Workstream.");
        cwd = workspace.path;
      } else if (referencedDirectory !== undefined) cwd = referencedDirectory;
      else if (detail.sessionId !== undefined) cwd = (await api.locate(detail.sessionId, machineId)).cwd;
      else {
        const workspace = this.app.selectedWorkspace;
        if (workspace === undefined) throw new Error("Choose a workspace before starting this Workstream.");
        cwd = workspace.path;
      }
      if (isTemporaryDirectory(cwd)) throw new Error(`The Workstream points to a temporary directory (${cwd}). Move the work to a persistent workspace before starting a Chat.`);
      const loaded = this.app.workspaces.find((workspace) => workspace.path === cwd);
      const owner = this.app.projects.find((project) => project.id === loaded?.projectId);
      match = owner !== undefined ? { project: owner, workspaces: this.app.workspaces } : await this.firstRegisteredWorkspace(this.app.projects, machineId, (workspace) => workspace.path === cwd);
    } catch (error) {
      this.setApp({ error: `Could not find a working directory for this Workstream: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    const workspace = match?.workspaces.find((candidate) => candidate.path === cwd) ?? adHocWorkspace(cwd);
    const workstreamContext = await this.resolveWorkstreamServiceContext();
    if (workstreamContext === undefined) {
      this.setApp({ error: this.app.selectedProject === undefined ? "A registered project with a workspace is needed to access Workstreams." : "Choose a registered workspace before starting this Workstream." });
      return;
    }
    const associationKey = `pi-web:${randomHex(16)}`;
    const anchor: WorkstreamSessionAnchor = match === undefined ? {} : { machineId, projectId: workspace.projectId, workspaceId: workspace.id };
    try {
      const snapshot = await inspectWorkstream(workstreamContext, detail.workstreamId);
      if (detail.sessionId === undefined && snapshot.sessions.some((session) => session.status !== "failed")) throw new Error("This Workstream already has a session. Refresh its card before starting another Chat.");
      const record: WorkstreamAppendRecord = {
        type: "session.pending",
        producer: "pi-web",
        ...(detail.sessionId === undefined ? {} : { sourceSessionId: detail.sessionId }),
        payload: { associationKey, ...(detail.sessionId === undefined ? {} : { derivationKind: "checkpoint" }), ...anchor },
      };
      await appendWorkstream(workstreamContext, { workstreamId: detail.workstreamId, expectedRevision: snapshot.revision, idempotencyKey: `${associationKey}:pending`, records: [record] });
    } catch (error) {
      this.setApp({ error: `Could not record the pending Workstream launch, so no Chat was started. ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    this.clearActiveSession();
    this.setApp({ selectedProject: match?.project, selectedWorkspace: workspace, workspaces: match?.workspaces ?? [workspace], sessions: [], error: "" });
    let session: SessionInfo;
    try {
      const started = await this.startSessionWithOptions({ startupToken: associationKey, propagateError: true });
      if (started === undefined) throw new Error("PI WEB did not start a Chat.");
      session = started;
    } catch (error) {
      const prefix = detail.sessionId === undefined
        ? "Chat creation outcome is unknown after the pending Workstream launch was recorded. Do not start another Chat until Pia reconciles it."
        : "Chat creation failed after the pending Workstream launch was recorded.";
      this.setApp({ error: `${prefix} ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    this.orientationPendingSessionId = session.id;
    this.updateUrl();
    await this.updateComplete;
    if (this.selectedChatIs(session.id, machineId)) await this.focusChatComposer();
    try {
      const confirmationContext = this.workstreamServiceContext ?? workstreamContext;
      const snapshot = await inspectWorkstream(confirmationContext, detail.workstreamId);
      const record: WorkstreamAppendRecord = {
        type: "session.confirmed",
        producer: "pi-web",
        sourceSessionId: session.id,
        payload: { sessionId: session.id, associationKey, ...anchor },
      };
      await appendWorkstream(confirmationContext, { workstreamId: detail.workstreamId, expectedRevision: snapshot.revision, idempotencyKey: `${associationKey}:confirmed`, records: [record] });
      await this.loadCurrentWorkstream();
    } catch (error) {
      if (this.orientationPendingSessionId === session.id) this.orientationPendingSessionId = undefined;
      this.setApp({ error: `Chat ${session.id} was created, but PI WEB could not record its Workstream confirmation. ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (!this.selectedChatIs(session.id, machineId)) return;
    try {
      let depth: "brief" | "full" = "full"; // Unknown recency gets the complete re-entry story.
      try {
        const confirmed = await inspectWorkstream(this.workstreamServiceContext ?? workstreamContext, detail.workstreamId);
        depth = await workstreamOrientationDepth(confirmed, session.id, machineId);
      } catch { /* Keep full orientation. */ }
      if (this.orientationPendingSessionId === session.id && this.selectedChatIs(session.id, machineId)
        && !this.app.messages.some((message) => message.role === "user")) await this.sessions.runCommand(`/skill:orient ${depth}`);
    } catch (error) {
      this.setApp({ error: `Automatic orientation could not start. Run /skill:orient in this Chat. ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (this.orientationPendingSessionId === session.id) this.orientationPendingSessionId = undefined;
    }
  }

  private selectedChatIs(sessionId: string, machineId: string): boolean {
    return this.app.selectedSession?.id === sessionId && selectedMachineId(this.app) === machineId;
  }

  private get workstreamServiceContext(): WorkstreamServiceContext | undefined {
    const projectId = this.app.selectedProject?.id;
    const workspaceId = this.app.selectedWorkspace?.id;
    if (projectId !== undefined && workspaceId !== undefined) return { machineId: selectedMachineId(this.app), projectId, workspaceId };
    return this.app.selectedWorkspace === undefined ? undefined : this.workstreamContexts.get(selectedMachineId(this.app));
  }

  private async resolveWorkstreamServiceContext(): Promise<WorkstreamServiceContext | undefined> {
    if (this.workstreamServiceContext !== undefined || this.app.selectedWorkspace === undefined || this.app.selectedProject !== undefined) return this.workstreamServiceContext;
    const machineId = selectedMachineId(this.app);
    if (this.workstreamContexts.has(machineId)) return this.workstreamContexts.get(machineId);
    let pending = this.pendingWorkstreamContexts.get(machineId);
    if (pending === undefined) {
      pending = (async () => {
        for (const project of rootProjects(this.app.projects)) {
          const workspaces = await api.workspaces(project.id, machineId);
          const workspace = workspaces.find((candidate) => candidate.projectId === project.id && candidate.isMain) ?? workspaces[0];
          if (workspace !== undefined) return { machineId, projectId: workspace.projectId, workspaceId: workspace.id };
        }
        return undefined;
      })();
      this.pendingWorkstreamContexts.set(machineId, pending);
    }
    try {
      const context = await pending;
      if (context !== undefined) this.workstreamContexts.set(machineId, context);
      return context;
    } finally { this.pendingWorkstreamContexts.delete(machineId); }
  }

  private async loadCurrentWorkstream(reset = true): Promise<void> {
    const sessionId = this.app.selectedSession?.id;
    const sequence = ++this.workstreamLoadSequence;
    window.clearTimeout(this.workstreamWatchTimer);
    if (reset) {
      this.currentWorkstream = undefined;
      this.currentWorkstreamError = "";
    }
    if (sessionId === undefined) { this.currentWorkstream = null; return; }
    let context: WorkstreamServiceContext | undefined;
    try {
      context = await this.resolveWorkstreamServiceContext();
      if (sequence !== this.workstreamLoadSequence) return;
      if (context === undefined) {
        this.currentWorkstream = null;
        this.currentWorkstreamError = "Add a registered project to access Workstreams for this Chat.";
        return;
      }
      // Seed before inspecting: a mutation between these calls will still be observed.
      if (this.workstreamWatchSequence === undefined) {
        const head = await watchWorkstreams(context, Number.MAX_SAFE_INTEGER);
        if (sequence !== this.workstreamLoadSequence) return;
        this.workstreamWatchSequence = head.nextSequence;
      }
      const snapshot = await workstreamForSession(context, sessionId);
      if (sequence === this.workstreamLoadSequence && this.app.selectedSession?.id === sessionId) {
        this.currentWorkstream = snapshot;
        this.currentWorkstreamError = "";
        // ponytail: only the selected Chat takes its checkpoint title, when a client loads its Workstream; server-side watching would cover unopened Chats.
        if (snapshot !== null) void applyCheckpointSessionTitle(snapshot, this.app.selectedSession, selectedMachineId(this.app), this.attemptedCheckpointTitles).catch(() => undefined);
      }
    } catch (error) {
      if (sequence === this.workstreamLoadSequence && this.app.selectedSession?.id === sessionId) {
        this.currentWorkstream = null;
        this.currentWorkstreamError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (sequence === this.workstreamLoadSequence && this.isConnected && context !== undefined) this.scheduleWorkstreamWatch(context, sessionId);
    }
  }

  private scheduleWorkstreamWatch(context: WorkstreamServiceContext, sessionId: string): void {
    this.workstreamWatchTimer = window.setTimeout(() => {
      void (async () => {
        const sequence = this.workstreamLoadSequence;
        try {
          if (this.workstreamWatchSequence === undefined) {
            this.workstreamWatchDelay = Math.min(this.workstreamWatchDelay * 2, 30_000);
            await this.loadCurrentWorkstream(false);
            return;
          }
          const batch = await watchWorkstreams(context, this.workstreamWatchSequence);
          if (sequence !== this.workstreamLoadSequence || this.app.selectedSession?.id !== sessionId) return;
          if (batch.nextSequence !== this.workstreamWatchSequence) {
            this.workstreamWatchSequence = batch.nextSequence;
            if (watchConcerns(batch, this.currentWorkstream?.id, sessionId)) {
              this.workstreamWatchDelay = 2_000;
              await this.loadCurrentWorkstream(false);
              return;
            }
          }
          if (this.currentWorkstreamError !== "" && this.workstreamWatchDelay >= 30_000) {
            await this.loadCurrentWorkstream(false);
            return;
          }
        } catch { /* Keep the last known title; retry on the next watch. */ }
        this.workstreamWatchDelay = Math.min(this.workstreamWatchDelay * 2, 30_000);
        if (sequence === this.workstreamLoadSequence && this.isConnected) this.scheduleWorkstreamWatch(context, sessionId);
      })();
    }, this.workstreamWatchDelay);
  }

  private async startSession(): Promise<void> {
    const session = await this.startSessionWithOptions();
    if (session !== undefined && this.app.selectedSession?.id === session.id) await this.focusChatComposer();
  }

  private updateUrl(options?: { replace?: boolean | undefined }): void {
    const session = this.app.selectedSession;
    const project = this.app.selectedProject;
    const workspace = this.app.selectedWorkspace;
    writeRoute({
      machineId: selectedMachineId(this.app),
      projectId: workspace?.projectId === "" ? undefined : project?.id,
      workspaceId: workspace?.projectId === "" ? undefined : workspace?.id,
      sessionId: session?.id,
      tool: undefined,
      view: session === undefined ? undefined : "chat",
    }, options);
  }

  /** Start one Chat without a project: in ~/IdeaProjects, or in a picked folder when asked or when that folder is missing. */
  private async startChatInFolder(pick: boolean): Promise<void> {
    const machineId = selectedMachineId(this.app);
    let path: string | null | undefined = pick ? undefined : await defaultChatFolder(machineId);
    if (path === undefined) {
      const picker = nativeDirectoryPicker(machineId);
      if (picker === undefined) { this.setApp({ error: "Choosing a folder needs the macOS app; add the folder as a project instead." }); return; }
      try {
        path = await picker.pickDirectory();
      } catch (error) {
        this.setApp({ error: folderPanelError(error) });
        return;
      }
    }
    if (path === null) return;
    const workspace = adHocWorkspace(path);
    this.clearActiveSession();
    this.setApp({ selectedProject: undefined, workspaces: [workspace], selectedWorkspace: workspace, sessions: [], error: "" });
    await this.startSession();
  }

  /** macOS: native folder panel; browsers: the path dialog. */
  private async chooseProjectFolder(): Promise<void> {
    const picker = nativeDirectoryPicker(selectedMachineId(this.app));
    if (picker === undefined) { this.setApp({ projectDialogOpen: true }); return; }
    try {
      const path = await picker.pickDirectory();
      if (path !== null) await this.addProject(path, false);
    } catch (error) {
      this.setApp({ error: folderPanelError(error) });
    }
  }

  private async copySessionInfo(session: SessionInfo, status: SessionStatus | undefined): Promise<void> {
    if (!await writeClipboardText(sessionInfoText(session, status))) { this.setApp({ error: "Could not copy the session info." }); return; }
    this.sessionInfoCopied = true;
    window.setTimeout(() => { this.sessionInfoCopied = false; }, 1200);
  }

  private async addProject(path: string, create: boolean): Promise<void> {
    try {
      const project = await api.addProject(path, undefined, create, selectedMachineId(this.app));
      this.setApp({ projects: [...this.app.projects.filter((candidate) => candidate.id !== project.id), project], projectDialogOpen: false });
      await this.chooseProject(project.id);
    } catch (error) {
      this.setApp({ error: String(error) });
    }
  }

  private async focusChatComposer(): Promise<void> {
    await this.updateComplete;
    if (hasRenderedModal(this.ownerDocument)) focusTopModal(this.ownerDocument);
    else this.promptEditor?.focusInput();
  }

  override render() {
    const selected = this.app.selectedSession?.id;
    return html`
      <workbench-window-tabs .workingSet=${this.windows.window} .windowId=${this.windows.id} .selected=${selected === undefined || isCreatingSessionId(selected) ? undefined : selected} .statuses=${this.chatTabStatuses()} .questionCounts=${this.chatQuestionCounts()}
        @chat-tab-select=${(event: CustomEvent<ChatTabSelectDetail>) => { this.swipe.cancel(); void this.showWindowChat(event.detail.sessionId); }}
        @chat-tab-close=${(event: CustomEvent<ChatTabCloseDetail>) => { this.closeWindowChats(event.detail.sessionIds); }}
        @window-home=${() => { this.goHome(); }}
        @window-layout=${() => { this.toggleWindowLayout(); }}
        @chat-tab-menu=${(event: CustomEvent<ChatTabMenuDetail>) => { this.openWindowMenu(event.detail); }}
        @chat-tab-drop=${(event: CustomEvent<DraggedChats>) => { void this.takeDroppedChats(event.detail); }}
        @chat-tab-drag-out=${(event: CustomEvent<DraggedChats>) => { this.moveToNewWindow(event.detail.sessionIds); }}
        @dragstart=${this.guardChatDrag}>${this.chatToolsInTabRow() ? html`<div class="chat-tools" slot="tools">${this.renderChatTools()}</div>` : nothing}</workbench-window-tabs>
      <div class="stage">${this.renderStage()}${this.renderSwipePeek()}</div>
      ${this.renderWindowMenu()}
      ${this.renderSettingsPanel(true)}
    `;
  }

  /** Files and notices stay window-wide. The page's keyed Chats keep one DOM position in Grid, Tabs and full size. */
  private renderStage() {
    const selected = this.app.selectedSession;
    return html`
      ${selected === undefined ? nothing : html`${this.renderDesktopNotificationDiagnostic()}${this.windowError === "" ? nothing : html`<p class="error" role="alert">${this.windowError}</p>`}`}
      <div class="chat-and-files" style=${`--files-width: ${String(this.filesWidth)}px`}>${selected === undefined ? this.renderChooser() : nothing}${this.renderWindowChats()}${this.renderFiles()}</div>
    `;
  }

  private renderWindowChats() {
    const window = this.windows.window;
    const selected = this.focused.current === undefined ? undefined : window?.chats.find((chat) => this.runtimeFor(chat.sessionId, chat.machineId) === this.focused.current)?.sessionId;
    const tiles = window === undefined ? [] : gridTiles({ ...window, focused: selected ?? window.focused }).filter((tile) => !this.retiringChats.has(tile.chat.sessionId));
    const single = window?.layout !== "grid" || window.maximized || tiles.length < 2;
    const statuses = this.chatTabStatuses();
    return html`
      <div class="grid" ?hidden=${selected === undefined} ?inert=${selected === undefined} ?data-single=${single} ?data-tabs=${window?.layout === "tabs"} style=${single ? "" : this.gridTemplate()} @dragover=${(event: DragEvent) => { if (carriesChats(event)) event.preventDefault(); }} @drop=${(event: DragEvent) => { const dropped = droppedChats(event); if (dropped !== undefined) { event.preventDefault(); void this.takeDroppedChats(dropped); } }}>
        ${repeat(tiles, (tile) => this.runtimeFor(tile.chat.sessionId, tile.chat.machineId) ?? machineSessionKey(tile.chat.machineId, tile.chat.sessionId), (tile) => this.renderTile(tile, statuses[tile.chat.sessionId] ?? "idle", single))}
        ${single ? nothing : this.renderGridDivider("columns", tiles.length === 3 ? "1 / 2 / 2 / 3" : "1 / 2 / 3 / 3")}
        ${single || tiles.length < 3 ? nothing : this.renderGridDivider("rows", "2 / 1 / 3 / 3")}
      </div>
    `;
  }

  /** The share of the first column or row on screen: the one being dragged, else the window's. */
  private gridShare(axis: GridAxis): number {
    const drag = this.gridDrag;
    if (drag?.axis === axis) return drag.ratio;
    const window = this.windows.window;
    return window === undefined ? 0.5 : gridRatio(window, axis);
  }

  /**
   * Tracks at the window's shares; each keeps its minimum unless the Grid is too small for two, then both halve. Flex
   * factors are percentages: a track held at its minimum leaves the other one factor below 1, which would fill only that
   * fraction of the rest.
   */
  private gridTemplate(): string {
    const tracks = (axis: GridAxis) => { const share = this.gridShare(axis); return [share, 1 - share].map((part) => `minmax(min(${String(GRID_MIN_TILE[axis])}px, calc(50% - 0.5px)), ${String(Math.round(part * 10_000) / 100)}fr)`).join(" "); };
    return `grid-template-columns: ${tracks("columns")}; grid-template-rows: ${tracks("rows")}`;
  }

  /** The Grid's length along `axis`, less its 1px gap; 0 before layout. */
  private gridSize(axis: GridAxis): number {
    const grid = this.shadowRoot?.querySelector<HTMLElement>(".grid");
    const length = axis === "columns" ? grid?.clientWidth : grid?.clientHeight;
    return Math.max(0, (length ?? 0) - 1);
  }

  /** A divider over the gutter between two tracks, in `area`, wider than the gutter for the pointer; double-click evens it. */
  private renderGridDivider(axis: GridAxis, area: string) {
    const size = this.gridSize(axis);
    const bounds = gridRatioBounds(size, GRID_MIN_TILE[axis]);
    const percent = (share: number) => String(Math.round(share * 100));
    const label = axis === "columns" ? "Resize Grid columns" : "Resize Grid rows";
    return html`
      <div class="grid-divider" data-axis=${axis} role="separator" tabindex="0" aria-label=${label} title=${`${label} (double-click to even)`} aria-orientation=${axis === "columns" ? "vertical" : "horizontal"}
        aria-valuemin=${percent(bounds.min)} aria-valuemax=${percent(bounds.max)} aria-valuenow=${percent(this.gridShare(axis))} style=${`grid-area: ${area}`}
        @pointerdown=${(event: PointerEvent) => { this.startGridResize(axis, event); }} @pointermove=${(event: PointerEvent) => { this.moveGridResize(event); }}
        @pointerup=${(event: PointerEvent) => { this.finishGridResize(event); }} @pointercancel=${(event: PointerEvent) => { this.finishGridResize(event); }}
        @dblclick=${() => { void this.updateWindow((store, id) => resizeGrid(store, id, axis, undefined)); }}
        @keydown=${(event: KeyboardEvent) => { this.resizeGridWithKeyboard(axis, event); }}></div>
    `;
  }

  private startGridResize(axis: GridAxis, event: PointerEvent): void {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement) || this.gridDrag !== undefined && !this.gridDrag.released) return;
    event.preventDefault();
    const handle = event.currentTarget;
    // Captured, so a drag over a tile's transcript or frame keeps reaching the divider.
    handle.setPointerCapture(event.pointerId);
    const size = this.gridSize(axis);
    const ratio = gridRatioFromDrag(this.gridShare(axis), 0, 0, size, GRID_MIN_TILE[axis]);
    this.gridDrag = { axis, pointerId: event.pointerId, start: axis === "columns" ? event.clientX : event.clientY, startRatio: ratio, size, ratio, handle, released: false, frame: undefined };
    handle.toggleAttribute("data-dragging", true);
    this.toggleGridResizing(true);
  }

  /**
   * A size container re-styles and lays out its whole transcript twice whenever it resizes, so tiles stop being containers
   * while a divider moves; each keeps the height it had for what measures against it (the question drawer).
   */
  private toggleGridResizing(resizing: boolean): void {
    const grid = this.shadowRoot?.querySelector(".grid");
    for (const tile of grid?.querySelectorAll<HTMLElement>(":scope > .tile") ?? []) {
      if (resizing) tile.style.setProperty("--pi-tile-height", `${String(tile.clientHeight)}px`);
      else tile.style.removeProperty("--pi-tile-height");
    }
    grid?.toggleAttribute("data-resizing", resizing);
  }

  /** Writes `drag`'s divider and the Grid's template as a render would, without one: the share being dragged, else the window's. */
  private paintGridDrag(drag: NonNullable<WorkbenchApp["gridDrag"]>): void {
    if (drag.frame !== undefined) cancelAnimationFrame(drag.frame);
    drag.frame = undefined;
    this.shadowRoot?.querySelector(".grid")?.setAttribute("style", this.gridTemplate());
    drag.handle.setAttribute("aria-valuenow", String(Math.round(this.gridShare(drag.axis) * 100)));
  }

  private moveGridResize(event: PointerEvent): void {
    const drag = this.gridDrag;
    if (drag?.pointerId !== event.pointerId || drag.released) return;
    event.preventDefault();
    const ratio = gridRatioFromDrag(drag.startRatio, drag.start, drag.axis === "columns" ? event.clientX : event.clientY, drag.size, GRID_MIN_TILE[drag.axis]);
    if (ratio === drag.ratio) return;
    drag.ratio = ratio;
    drag.frame ??= requestAnimationFrame(() => { this.paintGridDrag(drag); });
  }

  /** Stores the dragged share; the drag's share stays on screen until the store has it, so the release moves nothing. */
  private finishGridResize(event: PointerEvent): void {
    const drag = this.gridDrag;
    if (drag?.pointerId !== event.pointerId || drag.released) return;
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    this.paintGridDrag(drag);
    drag.handle.removeAttribute("data-dragging");
    this.toggleGridResizing(false);
    drag.released = true;
    // Painted again once it lands, so the page shows the window's share also when the store refused the drag's.
    const settle = () => { if (this.gridDrag === drag) { this.gridDrag = undefined; this.paintGridDrag(drag); } };
    if (drag.ratio === drag.startRatio) { settle(); return; }
    void this.updateWindow((store, id) => resizeGrid(store, id, drag.axis, drag.ratio)).then(settle);
  }

  private resizeGridWithKeyboard(axis: GridAxis, event: KeyboardEvent): void {
    const size = this.gridSize(axis);
    const next = gridRatioFromKeyboard(this.gridShare(axis), axis, event.key, event.shiftKey, size, GRID_MIN_TILE[axis]);
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    void this.updateWindow((store, id) => resizeGrid(store, id, axis, next));
  }

  private renderSwipePeek() {
    const chat = this.windows.window?.chats.find((candidate) => candidate.sessionId === this.swipePeek);
    if (chat === undefined) return nothing;
    return html`<div class="swipe-peek" aria-hidden="true">${renderChatStatusDot(this.chatTabStatuses()[chat.sessionId] ?? "idle")}<strong>${chat.title}</strong>${chat.workstream === undefined ? nothing : html`<span>${chat.workstream.title}</span>`}</div>`;
  }

  /** Without a tile, the focused Chat fills the window. */
  private tileStyle(tile: GridTile | undefined) {
    const workstream = tile?.chat.workstream;
    return styleMap({ gridArea: tile?.area ?? "1 / 1 / 3 / 3", ...(workstream === undefined ? {} : { "--ws": workstreamAccentColor(workstream.id) }) });
  }

  private renderTile(tile: GridTile, status: ChatTabStatus, single: boolean) {
    const { chat } = tile;
    const runtime = this.runtimeFor(chat.sessionId, chat.machineId);
    const focused = runtime !== undefined && runtime === this.focused.current;
    const focus = (event: Event) => {
      if (event.type === "pointerdown") this.tileFocusOnClick = undefined;
      if (this.app.selectedSession?.id === chat.sessionId) return;
      void this.showWindowChat(chat.sessionId);
      // Native mouse focus happens after pointerdown; finish activation at click without stealing a control's focus.
      if (event.type === "pointerdown") this.tileFocusOnClick = chat.sessionId;
    };
    return html`
      <section class="tile" data-session=${chat.sessionId} data-focused=${String(focused)} ?hidden=${single && !focused} ?inert=${single && !focused} style=${this.tileStyle(single ? undefined : tile)} @pointerdown=${focus} @focusin=${focus}
        @click=${(event: MouseEvent) => {
          if (this.tileFocusOnClick !== chat.sessionId) return;
          this.tileFocusOnClick = undefined;
          if (hasRenderedModal(this.ownerDocument) || !event.composedPath().some((target) => target instanceof HTMLElement && (target.matches("button, input, textarea, summary, a") || target.isContentEditable))) void this.focusChatComposer();
        }}
        @workspace-file-open=${this.openWorkspaceFile} @outside-file-open=${this.openOutsideFile}
        @workbench-prompt=${() => { if (this.orientationPendingSessionId === chat.sessionId) this.orientationPendingSessionId = undefined; }}>
        ${this.renderTileBar(tile, status)}
        <workbench-chat-pane .runtime=${runtime} .app=${runtime?.state} .focused=${focused} .loadError=${this.chatLoadErrors.get(machineSessionKey(chat.machineId, chat.sessionId))} .draftStorage=${this.windows.draftStorage} .defaultStreamingBehavior=${this.defaultStreamingBehavior} .dense=${!single} .contentRendering=${this.contentRendering} .revealTarget=${focused ? this.revealTarget : undefined}></workbench-chat-pane>
      </section>
    `;
  }

  /** Every tile's menu is live. Pointer/focus selection happens before its action, with no synthetic replay. */
  private renderTileBar({ chat }: GridTile, status: ChatTabStatus) {
    const state = this.runtimeFor(chat.sessionId, chat.machineId)?.state;
    const session = state?.selectedSession;
    const maximize = () => { void this.showWindowChat(chat.sessionId).then(() => this.app.selectedSession?.id === chat.sessionId ? this.updateWindow(toggleMaximized) : undefined); };
    const maximized = this.windows.window?.maximized === true;
    return html`
      <div class="tile-bar" draggable="true" @dblclick=${maximize}
        @contextmenu=${(event: MouseEvent) => { event.preventDefault(); this.openWindowMenu({ sessionIds: [chat.sessionId], label: chat.title, clientX: event.clientX, clientY: event.clientY }); }}
        @dragstart=${(event: DragEvent) => { startChatDrag(event, { windowId: this.windows.id, sessionIds: [chat.sessionId] }, chat.title); this.guardChatDrag(event); }}
        @dragend=${(event: DragEvent) => { if (event.dataTransfer?.dropEffect === "none" && endedOutside(event, window)) this.moveToNewWindow([chat.sessionId]); }}>
        ${renderChatStatusDot(status)}
        <span class="tile-title" title=${chat.workstream === undefined ? chat.title : `Workstream: ${chat.workstream.title} · Chat: ${chat.title}`}><span class="chat-name">${chat.title}</span>${chat.workstream === undefined ? nothing : html`<span class="tile-ws"><span class="ws-dot"></span><span>${chat.workstream.title}</span></span>`}</span>
        ${status === "needs" ? html`<span class="needs">Needs you</span>` : nothing}
        <span class="tile-actions">
          <button type="button" class="icon-button" title=${maximized ? "Restore grid (⌃↩)" : "Full size (⌃↩)"} aria-label=${maximized ? "Restore grid" : `Full size ${chat.title}`} @click=${maximize}>${renderBuiltinTabIcon(maximized ? "minimize" : "maximize")}</button>
          <button type="button" class="icon-button" title="Close" aria-label=${`Close ${chat.title}`} @click=${() => { this.closeWindowChats([chat.sessionId]); }}>${renderBuiltinTabIcon("x")}</button>
        </span>
        <span class="tile-tools">${session === undefined ? nothing : this.renderChatToolButtons(session, state)}</span>
      </div>
    `;
  }

  /** `anchored`: the one panel the Chat menus open (`openSettings`), without its own button. */
  private renderSettingsPanel(anchored = false) {
    return html`
      <workbench-settings-panel
        ?no-trigger=${anchored}
        class=${anchored ? "chat-settings" : ""}
        .themePreference=${this.themePreference}
        .themes=${this.plugins.getThemes()}
        .themePairs=${this.plugins.getThemePairs()}
        .onThemePreferenceChange=${(preference: ThemePreference) => { this.setThemePreference(preference); }}
      ></workbench-settings-panel>
    `;
  }

  private renderDesktopNotificationDiagnostic() {
    return this.desktopNotifications.diagnostic === undefined ? null : html`<p class="error" role="alert">${this.desktopNotifications.diagnostic}</p>`;
  }

  private renderDesktopNotificationButton() {
    if (!this.desktopNotifications.canRequestPermission()) return null;
    return html`
      <button class="icon-button notification-button" title="Enable desktop notifications" aria-label="Enable desktop notifications" @click=${() => { void this.desktopNotifications.requestPermission(); }}>
        ${renderBuiltinTabIcon("bell")}
      </button>
    `;
  }

  protected override updated(): void {
    if (this.app.selectedSession !== undefined) return;
    const workspace = this.shadowRoot?.querySelector<HTMLSelectElement>('select[aria-label="Workspace"]');
    if (workspace !== undefined && workspace !== null) workspace.value = this.app.selectedWorkspace?.id ?? "";
  }

  private renderChooser() {
    const agentSessionCount = this.app.sessions.filter(isWorkbenchAgentSession).length;
    const visibleSessions = this.showAgentSessions ? this.app.sessions : this.app.sessions.filter((session) => !isWorkbenchAgentSession(session));
    const recentSessions = this.showAllSessions ? visibleSessions : visibleSessions.slice(0, 5);
    const project = this.app.selectedProject;
    const serviceMachineId = selectedMachineId(this.app);
    const serviceProjectId = project?.id ?? "";
    const serviceWorkspaceId = this.app.selectedWorkspace?.id ?? "";
    return html`
      <main class="chooser" data-view="chooser">
        <section>
          <div class="tabs" role="tablist">
            ${this.app.machines.length > 1 ? html`
              <select aria-label="Machine" .value=${selectedMachineId(this.app)} @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) void this.chooseMachine(event.target.value); }}>
                ${this.app.machines.map((machine) => html`<option value=${machine.id}>${machine.name}</option>`)}
              </select>
            ` : null}
            ${rootProjects(this.app.projects).map((candidate) => html`<button role="tab" aria-selected=${this.chooserView === "project" && project !== undefined && rootProjectOf(project, this.app.projects).id === candidate.id} @click=${() => { this.chooserView = "project"; void this.chooseProject(candidate.id); }}>${candidate.name}</button>`)}
            <button role="tab" aria-selected=${this.chooserView === "other"} @click=${() => { this.chooserView = "other"; }}>Other</button>
            <button role="tab" aria-selected=${this.chooserView === "all"} @click=${() => { this.chooserView = "all"; }}>All sessions</button>
            <span class="tab-actions">
              ${this.renderSettingsPanel()}
              ${this.renderDesktopNotificationButton()}
              <button class="icon-button" title="New Chat in ~/IdeaProjects (⌥-click: choose a folder)" aria-label="New Chat without a project" @click=${(event: MouseEvent) => { void this.startChatInFolder(event.altKey); }}>
                ${renderBuiltinTabIcon("chat-plus")}
              </button>
              <button class="icon-button" title="Add project…" aria-label="Add project…" @click=${() => { void this.chooseProjectFolder(); }}>
                ${renderBuiltinTabIcon("folder-plus")}
              </button>
            </span>
          </div>
          ${this.chooserView === "all" ? html`<all-sessions .sessionStatuses=${this.app.sessionStatuses} .sessionActivities=${this.app.sessionActivities} @open-session=${(event: CustomEvent<SessionInfo>) => { void this.openAllSession(event.detail); }}></all-sessions>` : this.chooserView === "other" ? html`<workstream-chooser .serviceMachineId=${serviceMachineId} .serviceProjectId=${serviceProjectId} .serviceWorkspaceId=${serviceWorkspaceId} .sessionStatuses=${this.app.sessionStatuses} .sessionActivities=${this.app.sessionActivities} .excludeProjects=${rootProjects(this.app.projects).map((candidate) => candidate.name)} @open-workstream-session=${(event: CustomEvent<OpenWorkstreamSessionDetail>) => { void this.openWorkstreamSession(event.detail); }} @start-workstream-session=${(event: CustomEvent<StartWorkstreamSessionDetail>) => { void this.startWorkstreamSession(event.detail); }}></workstream-chooser>` : project === undefined ? html`<p>Choose a project.</p>` : html`
            <div class="new-chat">
              <button class="primary" ?disabled=${this.app.selectedWorkspace === undefined || this.app.startingSessionCount > 0} @click=${() => { void this.startSession(); }}>New Chat</button>
              <label>in
                <select aria-label="Workspace" @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) void this.chooseWorkspace(event.target.value); }}>
                  ${this.app.workspaces.map((workspace) => html`<option value=${workspace.id}>${this.app.projects.find((candidate) => candidate.id === workspace.projectId)?.name ?? ""} · ${workspace.label}${workspace.isMain ? " (main)" : ""}</option>`)}
                </select>
              </label>
            </div>
            <workstream-chooser .project=${rootProjectOf(project, this.app.projects).name} .serviceMachineId=${serviceMachineId} .serviceProjectId=${serviceProjectId} .serviceWorkspaceId=${serviceWorkspaceId} .canStartEmpty=${this.app.selectedWorkspace !== undefined} .sessionStatuses=${this.app.sessionStatuses} .sessionActivities=${this.app.sessionActivities} @open-workstream-session=${(event: CustomEvent<OpenWorkstreamSessionDetail>) => { void this.openWorkstreamSession(event.detail); }} @start-workstream-session=${(event: CustomEvent<StartWorkstreamSessionDetail>) => { void this.startWorkstreamSession(event.detail); }}></workstream-chooser>
          `}
          ${this.loading ? html`<p role="status">Loading…</p>` : null}
          ${this.renderDesktopNotificationDiagnostic()}
          ${this.app.error === "" ? null : html`<p class="error" role="alert">${this.app.error}</p>`}
          ${this.chooserView !== "project" || this.app.selectedWorkspace === undefined ? null : html`
            <div class="sessions">
              <h2>Sessions <small>${String(visibleSessions.length)}</small></h2>
              ${recentSessions.map((session) => html`
                <button class="session" @click=${() => { void this.openSession(session); }}>
                  <strong>${sessionTitle(session)}</strong>
                  <small>${session.archived === true ? "Archived · " : ""}${String(session.messageCount)} messages</small>
                </button>
              `)}
              <div class="session-tools">
                ${visibleSessions.length > 5 ? html`<button class="link" @click=${() => { this.showAllSessions = !this.showAllSessions; }}>${this.showAllSessions ? "Show recent only" : `Show all ${String(visibleSessions.length)}`}</button>` : null}
                ${agentSessionCount === 0 ? null : html`
                  <label class="agent-filter"><input type="checkbox" aria-label="Show agent sessions" .checked=${this.showAgentSessions} @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.showAgentSessions = event.target.checked; }}> Show agent sessions (${agentSessionCount})</label>
                `}
              </div>
            </div>
          `}
        </section>
        ${this.app.projectDialogOpen ? html`<project-dialog .machineId=${selectedMachineId(this.app)} .onSubmit=${(path: string, create: boolean) => { void this.addProject(path, create); }} .onCancel=${() => { this.setApp({ projectDialogOpen: false }); }}></project-dialog>` : null}
      </main>
    `;
  }

  private readonly onWindowResize = (): void => { this.requestUpdate(); };

  private filesConstraints(): PanelResizeConstraints {
    const container = this.shadowRoot?.querySelector<HTMLElement>(".chat-and-files");
    const available = container !== null && container !== undefined && container.clientWidth > 0 ? container.clientWidth : this.filesWidth + 328;
    return { minWidth: 240, maxWidth: Math.max(240, available - 328), defaultWidth: 400, keyboardStep: 24, largeKeyboardStep: 72 };
  }

  private startFilesResize(event: PointerEvent): void {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    this.filesResize = { pointerId: event.pointerId, startX: event.clientX, startWidth: this.visibleFilesWidth(), handle };
  }

  private visibleFilesWidth(): number {
    return clampPanelWidth("workspace", this.filesWidth, this.filesConstraints());
  }

  private moveFilesResize(event: PointerEvent): void {
    const resize = this.filesResize;
    if (resize?.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.filesWidth = panelWidthFromDrag("workspace", resize.startWidth, resize.startX, event.clientX, this.filesConstraints());
  }

  private finishFilesResize(event?: PointerEvent): void {
    const resize = this.filesResize;
    if (resize === undefined || event !== undefined && resize.pointerId !== event.pointerId) return;
    this.filesResize = undefined;
    if (resize.handle.hasPointerCapture(resize.pointerId)) resize.handle.releasePointerCapture(resize.pointerId);
  }

  private resizeFilesWithKeyboard(event: KeyboardEvent): void {
    const next = panelWidthFromKeyboard("workspace", this.visibleFilesWidth(), event.key, { largeStep: event.shiftKey, constraints: this.filesConstraints() });
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.filesWidth = next;
  }

  private openFileSearch(): void {
    if (this.app.selectedWorkspace === undefined) return;
    this.sidePane = "files";
    void this.updateComplete.then(async () => {
      const pane = this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
      if (pane !== null && pane !== undefined) { await pane.updateComplete; await pane.searchFiles(); }
    });
  }

  /** Opens or closes Files in the side slot; closing respects unsaved edits. */
  private toggleFiles(): void {
    if (this.sidePane === "files") {
      if (this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() === false) return;
      this.filesTarget = undefined;
    }
    this.finishFilesResize();
    this.sidePane = this.sidePane === "files" ? undefined : "files";
  }

  private filesWorkspace(): Workspace | undefined {
    const target = this.filesTarget;
    return target !== undefined && target.sessionId === this.app.selectedSession?.id ? target.workspace : this.app.selectedWorkspace;
  }

  /**
   * Every change of what Files shows lands here, on the update that would show it: with unsaved edits in Files the
   * owner chooses between discarding them and keeping Files as it is, beside a Chat of another workspace.
   */
  private guardFilesTarget(): void {
    const next = { machineId: selectedMachineId(this.app), workspace: this.filesWorkspace() };
    const key = filesKey(next);
    this.filesElsewhere = key !== filesKey(this.filesShown);
    if (!this.filesElsewhere) { this.filesDeclined = undefined; return; }
    // No Chat on screen (a chooser, a load or a machine switch in flight): Files keeps what it shows, and says so.
    if (this.app.selectedSession === undefined) return;
    if (this.sidePane !== undefined && (key === this.filesDeclined || !this.filesPaneCanClose())) { this.filesDeclined = key; return; }
    this.filesShown = next;
    this.filesDeclined = undefined;
    this.filesElsewhere = false;
  }

  /** Where Files reads and saves: its workspace, after its machine's name when that is not the one on screen. */
  private filesShownLabel(): string {
    const { machineId, workspace } = this.filesShown;
    const label = workspace?.label ?? "another workspace";
    if (machineId === selectedMachineId(this.app)) return label;
    return `${this.app.machines.find((machine) => machine.id === machineId)?.name ?? machineId} · ${label}`;
  }

  /** Show `path` in the Files pane, in `workspace` or else the Chat's own workspace, unless Files keeps its edits. */
  private openInFiles(workspace: Workspace | undefined, path: string, lines?: LineRange): void {
    const session = this.app.selectedSession;
    this.filesTarget = workspace === undefined || session === undefined ? undefined : { sessionId: session.id, workspace };
    this.filesDeclined = undefined;
    this.sidePane = "files";
    const wanted = filesKey({ machineId: selectedMachineId(this.app), workspace: workspace ?? this.app.selectedWorkspace });
    void this.updateComplete.then(async () => {
      const pane = this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
      if (pane !== null && pane !== undefined && filesKey(this.filesShown) === wanted) { await pane.updateComplete; await pane.openFile(path, false, lines); }
    });
  }

  private readonly openWorkspaceFile = (event: CustomEvent<WorkspaceFileOpenRequest>): void => {
    const workspace = this.app.selectedWorkspace;
    const request = event.detail;
    if (event.defaultPrevented || workspace === undefined
      || request.machineId !== selectedMachineId(this.app) || request.projectId !== workspace.projectId
      || request.workspaceId !== workspace.id || request.root !== workspace.path) return;
    event.preventDefault();
    this.openInFiles(undefined, request.path, request.lines);
  };

  private readonly openOutsideFile = (event: CustomEvent<OutsideFileOpenRequest>): void => {
    const { machineId, path, lines } = event.detail;
    if (event.defaultPrevented || machineId !== selectedMachineId(this.app)) return;
    event.preventDefault();
    void this.workspaceForFile(path, machineId).then(
      (target) => { this.openInFiles(target.workspace, target.path, lines); },
      (error: unknown) => { this.setApp({ error: error instanceof Error ? error.message : String(error) }); },
    );
  };

  /** The deepest registered workspace containing `file`, else its directory as a folder workspace. */
  private async workspaceForFile(file: string, machineId: string): Promise<{ workspace: Workspace; path: string }> {
    const listed = await Promise.all(this.app.projects.map((project) => api.workspaces(project.id, machineId).catch((): Workspace[] => [])));
    const root = (workspace: Workspace) => workspace.path.replace(/\/+$/, "");
    const containing = [...this.app.workspaces, ...listed.flat()]
      .filter((workspace) => file.startsWith(`${root(workspace)}/`))
      .sort((a, b) => root(b).length - root(a).length)[0];
    if (containing !== undefined) return { workspace: containing, path: file.slice(root(containing).length + 1) };
    // ponytail: no Git worktree-root lookup for unregistered files; the file's directory is the folder.
    const slash = file.lastIndexOf("/");
    return { workspace: adHocWorkspace(file.slice(0, slash) || "/"), path: file.slice(slash + 1) };
  }

  /** Tabs: the Chat's tools join the window's tab row. A grid tile, or a window without tabs, keeps its own header. */
  private chatToolsInTabRow(): boolean {
    const window = this.windows.window;
    return this.app.selectedSession !== undefined && window?.layout === "tabs" && window.chats.length > 0;
  }

  /** The selected Chat's menu. */
  private renderChatTools() {
    const session = this.app.selectedSession;
    if (session === undefined) return nothing;
    return html`
      ${this.renderChatToolButtons(session)}
    `;
  }

  /**
   * The Chat's menu: Files, session tree, session info, settings, notifications; the Chat's folder is the Files tooltip.
   * Copying keeps the menu open, so its item can confirm the copy. A Grid has no tab row, so the window's Add and layout
   * toggle follow here.
   */
  private renderChatToolButtons(session: SessionInfo, state = this.app) {
    const workspace = state.selectedWorkspace;
    const folder = workspace === undefined ? "" : ` — ${state.selectedProject === undefined ? "" : `${state.selectedProject.name} · `}${workspace.label} (${workspace.path})`;
    return html`
      <workbench-menu-button class="chat-menu" label="Chat menu">
        <button type="button" class="menu-item files-toggle" title=${`Files${folder}`} aria-expanded=${this.sidePane === "files"} aria-controls="workbench-files" @click=${() => { this.toggleFiles(); }}>${renderBuiltinTabIcon("files")}Files</button>
        <button type="button" class="menu-item" @click=${() => { void this.runtimeFor(session.id, selectedMachineId(state))?.sessions.runCommand("/tree"); }}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>Session tree</button>
        <button type="button" class="menu-item" data-keep-open title=${sessionInfoText(session, state.status)} @click=${() => { void this.copySessionInfo(session, state.status); }}>${this.sessionInfoCopied ? html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>Copied session info` : html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>Copy session info`}</button>
        <button type="button" class="menu-item" aria-haspopup="dialog" @click=${(event: MouseEvent) => { this.openSettings(event); }}>${renderBuiltinTabIcon("settings")}Workbench settings</button>
        ${this.desktopNotifications.canRequestPermission() ? html`<button type="button" class="menu-item" @click=${() => { void this.desktopNotifications.requestPermission(); }}>${renderBuiltinTabIcon("bell")}Enable desktop notifications</button>` : nothing}
        ${this.windows.window?.layout !== "grid" ? nothing : html`
          <hr>
          <button type="button" class="menu-item window-add" @click=${() => { this.goHome(); }}>${renderBuiltinTabIcon("plus")}Add Chat<kbd>⌘T</kbd></button>
          <button type="button" class="menu-item window-layout" @click=${() => { this.toggleWindowLayout(); }}>${renderBuiltinTabIcon("panels-top-left")}Tabs layout<kbd>⌃G</kbd></button>`}
      </workbench-menu-button>
    `;
  }

  /** Opens the settings popover below the Chat menu whose item was pressed. */
  private openSettings(event: MouseEvent): void {
    const menu = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest("workbench-menu-button") : null;
    const panel = this.renderRoot.querySelector<WorkbenchSettingsPanel>("workbench-settings-panel.chat-settings");
    if (menu !== null && panel !== null) panel.openFrom(menu);
  }

  /** Files beside the grid, outside every tile: a focus switch keeps it open and leaves every tile its size. */
  private renderFiles() {
    if (this.sidePane === undefined) return nothing;
    return html`
      <div class="files-divider" role="separator" tabindex="0" aria-label="Resize Files pane" title="Resize Files pane" aria-orientation="vertical" aria-controls="workbench-files" aria-valuemin="240" aria-valuemax=${String(this.filesConstraints().maxWidth)} aria-valuenow=${String(this.visibleFilesWidth())}
        @pointerdown=${(event: PointerEvent) => { this.startFilesResize(event); }} @pointermove=${(event: PointerEvent) => { this.moveFilesResize(event); }} @pointerup=${(event: PointerEvent) => { this.finishFilesResize(event); }} @pointercancel=${(event: PointerEvent) => { this.finishFilesResize(event); }} @keydown=${(event: KeyboardEvent) => { this.resizeFilesWithKeyboard(event); }}></div>
      <div class="files-close-anchor"><button type="button" class="files-close" title="Close Files" aria-label="Close Files" aria-controls="workbench-files" @click=${() => { this.toggleFiles(); }}>${renderBuiltinTabIcon("chevron")}</button></div>
      <workbench-files-pane id="workbench-files" .workspace=${this.filesShown.workspace} .machineId=${this.filesShown.machineId}>${this.filesElsewhere ? html`
        <p class="files-elsewhere" role="status">Files still shows ${this.filesShownLabel()}.${this.filesDeclined === undefined ? nothing : html` <button type="button" @click=${() => { this.filesDeclined = undefined; }}>Show this Chat's files</button>`}</p>` : nothing}</workbench-files-pane>
    `;
  }

  static override styles = css`
    ${chatStatusDotStyles}
    :host { --pi-app-safe-area-bottom: 0px; --pi-workbench-viewport-height: calc(100dvh / var(--pi-interface-scale, 1)); --pi-workbench-viewport-width: calc(100dvw / var(--pi-interface-scale, 1)); position: fixed; top: 0; right: 0; left: 0; display: flex; flex-direction: column; height: var(--pi-workbench-viewport-height); box-sizing: border-box; overflow: hidden; padding: env(safe-area-inset-top) env(safe-area-inset-right) var(--pi-app-safe-area-bottom) env(safe-area-inset-left); background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui, sans-serif; }
    @media (display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui) {
      :host { --pi-app-safe-area-bottom: env(safe-area-inset-bottom); }
    }
    .stage { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    /* No rules between tiles: every tile rests on the background, the gutter is darker, the focused tile is outlined. */
    .grid { flex: 1 1 0; min-width: 0; min-height: 0; display: grid; grid-template: minmax(0, 1fr) minmax(0, 1fr) / minmax(0, 1fr) minmax(0, 1fr); gap: 1px; background: light-dark(color-mix(in srgb, var(--pi-bg) 94%, var(--pi-text)), color-mix(in srgb, var(--pi-bg) 85%, black)); }
    .grid:not([data-single]) { position: relative; }
    /* 9px over the 1px gutter, centred on it: the gutter stays the only line until hover, focus or a drag. */
    .grid-divider { position: absolute; z-index: 7; touch-action: none; }
    .grid-divider[data-axis="columns"] { top: 0; bottom: 0; left: -5px; width: 9px; cursor: col-resize; }
    .grid-divider[data-axis="rows"] { left: 0; right: 0; top: -5px; height: 9px; cursor: row-resize; }
    .grid-divider::after { content: ""; position: absolute; inset: 0; }
    .grid-divider[data-axis="columns"]::after { left: 3px; right: 3px; }
    .grid-divider[data-axis="rows"]::after { top: 3px; bottom: 3px; }
    .grid-divider:hover::after, .grid-divider:focus-visible::after, .grid-divider[data-dragging]::after { background: var(--pi-accent); }
    .grid-divider:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .tile { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--pi-bg); }
    /* Grid tracks size every tile, so it can contain its size: the question drawer measures its height against it (cqh). */
    .tile { container-type: size; }
    .grid[data-resizing] > .tile { container-type: normal; }
    /* Half the comfortable profile's spacing inside a tile; focus is only the outline, so it moves nothing. */
    .grid:not([data-single]) > .tile { --pi-panel-padding: 5px; --pi-message-padding: 5px; --pi-toolbar-gap: 3px; }
    .grid:not([data-single]) > .tile[data-focused="true"] { outline: 1.5px solid var(--ws, color-mix(in srgb, var(--pi-accent) 70%, transparent)); outline-offset: -1.5px; }
    .tile .chat-shell { flex: 1 1 auto; height: auto; min-height: 0; }
    /* Compact: the Workstream colour is a 2px edge and a contrast-checked tint, so the title stays --pi-text. */
    .tile-bar { position: relative; z-index: 6; flex: 0 0 auto; display: flex; align-items: center; gap: 6px; min-width: 0; height: 28px; box-sizing: border-box; padding: 0 2px 0 6px; border-left: 2px solid var(--ws, transparent); background: color-mix(in srgb, var(--ws, var(--pi-surface)) ${WORKSTREAM_TINT_PERCENTAGES.tab}%, var(--pi-surface)); color: var(--pi-muted); font-size: 12px; user-select: none; --workbench-menu-button-size: 24px; }
    .tile-title { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; }
    .chat-name { flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--pi-text); text-overflow: ellipsis; }
    /* The Workstream title gives way long before the Chat title does. */
    .tile-ws { flex: 0 1000 auto; min-width: 0; display: flex; align-items: center; gap: 5px; overflow: hidden; color: var(--pi-muted); }
    .tile-ws::before { content: "·"; }
    .ws-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ws); }
    .tile-ws > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .needs { flex: 0 0 auto; padding: 0 7px; border-radius: 999px; background: color-mix(in srgb, var(--pi-warning) 28%, transparent); color: var(--pi-text); font-size: 11px; font-weight: 700; line-height: 18px; }
    .tile-tools { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; }
    /* Full size and close take room only while the bar is hovered or holds focus, leaving the title the width; the menu stays put at the end. */
    .tile-actions { flex: 0 0 auto; display: none; gap: 2px; }
    .tile-bar:hover .tile-actions, .tile-bar:focus-within .tile-actions { display: flex; }
    .tile-bar .icon-button { width: 24px; height: 24px; min-height: 0; padding: 4px; }
    workbench-chat-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1 1 auto; }
    .grid[data-tabs] .tile-bar { display: none; }
    .grid[hidden] { display: grid; position: absolute; inset: 0; visibility: hidden; pointer-events: none; }
    /* Hidden Tabs keep their geometry: display:none resets a bottom-pinned transcript's scroll in WebKit. */
    .tile[hidden] { display: flex; visibility: hidden; pointer-events: none; }
    .grid[data-single] > .tile { z-index: 1; }
    .swipe-peek { position: absolute; inset: 0; z-index: 2; visibility: hidden; display: flex; align-items: center; justify-content: center; gap: 10px; background: var(--pi-bg); color: var(--pi-muted); font-size: 14px; pointer-events: none; }
    .swipe-peek strong { color: var(--pi-text); font-weight: 600; }
    .window-menu { position: fixed; z-index: 40; min-width: 220px; display: grid; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 10px 30px var(--pi-shadow); }
    .window-menu button { min-height: 0; padding: 6px 10px; border: 0; border-radius: 5px; background: none; text-align: left; font-size: 13px; }
    .window-menu button:hover, .window-menu button:focus-visible { background: var(--pi-surface-hover); }
    .window-menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--pi-border-muted); }
    .chooser { flex: 1 1 0; min-width: 0; box-sizing: border-box; height: 100%; overflow: auto; display: grid; place-items: start center; padding: min(10vh, 72px) 24px 32px; }
    .chooser > section { box-sizing: border-box; width: min(960px, 100%); display: grid; gap: 16px; padding: 24px; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-surface); box-shadow: 0 18px 50px var(--pi-shadow); }
    h1, p { margin: 0; }
    h1 { font-size: 24px; }
    p { color: var(--pi-muted); line-height: 1.45; }
    label { display: grid; gap: 6px; color: var(--pi-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; }
    select, button { box-sizing: border-box; min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: var(--pi-control-padding-block) var(--pi-control-padding-inline); font: 14px system-ui, sans-serif; }
    button { cursor: pointer; text-align: left; }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    button:disabled, select:disabled { opacity: .55; cursor: not-allowed; }
    .secondary { justify-self: start; }
    .new-chat { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .new-chat label { display: flex; align-items: center; gap: 8px; text-transform: none; font-size: 14px; }
    .new-chat span { color: var(--pi-muted); }
    .link { min-height: 0; padding: 0; border: 0; background: none; color: var(--pi-accent); font: inherit; text-decoration: underline; }
    .tabs { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid var(--pi-border); }
    .tab-actions { margin-left: auto; display: flex; gap: 4px; }
    .icon-button { min-height: 0; width: 32px; height: 32px; padding: 6px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 7px; background: none; color: var(--pi-muted); }
    .icon-button:hover { border-color: var(--pi-border); color: var(--pi-text); background: var(--pi-surface-hover); }
    .icon-button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .notification-button { flex: 0 0 auto; }
    .session-tools { display: flex; gap: 14px; align-items: center; }
    .sessions h2 small { color: var(--pi-muted); font-weight: 500; }
    .tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; font-weight: 700; color: var(--pi-muted); }
    .tabs button[aria-selected="true"] { color: var(--pi-text); border-bottom-color: var(--pi-accent); }
    .primary { border-color: var(--pi-success-border); background: var(--pi-success-bg); font-weight: 700; }
    .sessions { min-width: 0; display: grid; gap: 8px; }
    .agent-filter { display: flex; align-items: center; gap: 6px; text-transform: none; }
    .session { min-width: 0; max-width: 100%; display: grid; gap: 3px; overflow: hidden; }
    .session strong, .session small { min-width: 0; overflow-wrap: anywhere; }
    .session strong { display: -webkit-box; overflow: hidden; line-height: 1.3; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .session:hover { background: var(--pi-surface-hover); }
    .session small { color: var(--pi-muted); }
    .error, .chat-error { color: var(--pi-danger); }
    .chat-shell { height: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    /* In the tab row the Chat menu keeps its natural width: only the tabs shrink and scroll. */
    .chat-tools { flex: none; display: flex; align-items: center; gap: 4px; }
    /* A hairline, centred in the row's gap, sets the window's Add and layout actions apart from the Chat's menu. */
    .chat-tools::after { content: ""; flex: 0 0 auto; width: 1px; height: 16px; margin-left: 4px; background: var(--pi-border); }
    /* The Chat menu's items: labelled rows, the icon first. */
    .menu-item { display: flex; align-items: center; gap: 8px; min-height: 0; padding: 6px 10px; border: 0; border-radius: 5px; background: none; color: var(--pi-text); font-size: 13px; white-space: nowrap; }
    .menu-item:hover, .menu-item:focus-visible { background: var(--pi-surface-hover); }
    .menu-item:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .menu-item kbd { margin-left: auto; padding-left: 16px; color: var(--pi-muted); font: 12px system-ui, sans-serif; }
    workbench-menu-button > hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--pi-border-muted); }
    .menu-item svg { flex: 0 0 auto; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; color: var(--pi-muted); }
    .chat-loading { padding: 8px 12px; color: var(--pi-muted); }
    .chat-error { flex: 0 0 auto; padding: 8px 12px; border-bottom: 1px solid var(--pi-border); }
    .chat-and-files { position: relative; display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; }
    .chat-column { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
    /* The composer side of the conversation boundary: Activity, goal, open asks and the composer stack above each other. */
    .composer-area { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    /* Zero basis: the transcript takes what is left, so the question chips and drawer never shrink for it. */
    chat-view { flex: 1 1 0; min-height: 0; overflow: hidden; }
    delegate-roster, prompt-editor { flex: 0 0 auto; }
    .files-toggle { flex: 0 0 auto; }
    .files-toggle[aria-expanded="true"], .files-toggle[aria-expanded="true"] svg { color: var(--pi-accent); }
    .files-divider { position: relative; z-index: 2; flex: 0 0 8px; background: var(--pi-border-muted); cursor: col-resize; touch-action: none; }
    .files-divider::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: var(--pi-border); }
    .files-divider:hover::after, .files-divider:focus-visible::after { background: var(--pi-accent); }
    .files-divider:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    /* Zero-width flex item right of the divider, so the close chevron sits centred on the border without joining the separator. */
    .files-close-anchor { position: relative; z-index: 3; flex: 0 0 0; width: 0; }
    .files-close { position: absolute; top: 50%; left: -15px; transform: translateY(-50%); display: grid; place-items: center; width: 22px; height: 40px; min-height: 0; padding: 0; border: 1px solid var(--pi-border); border-radius: 11px; background: var(--pi-surface); color: var(--pi-text); cursor: pointer; box-shadow: 0 2px 6px var(--pi-shadow-soft); }
    .files-close:hover { border-color: var(--pi-accent); background: var(--pi-surface-hover); }
    .files-close:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .files-close svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    workbench-files-pane { flex: 0 0 min(var(--files-width), max(240px, calc(100% - 328px))); box-sizing: border-box; }
    .files-elsewhere { margin: 0; padding: 6px 10px; border-bottom: 1px solid var(--pi-border); color: var(--pi-warning); font-size: 12px; }
    .files-elsewhere button { font: inherit; }
    @media (max-width: 760px) {
      .chat-and-files { flex-direction: column; }
      .files-divider, .files-close-anchor { display: none; }
      workbench-files-pane { flex: 0 1 48%; width: 100%; min-width: 0; border-top: 1px solid var(--pi-border); }
    }
    @media (max-width: 600px) {
      .chooser, .chooser > section { grid-template-columns: minmax(0, 1fr); }
      .chooser { padding: 16px; }
      .chooser > section { padding: 16px; }
      .new-chat label { min-width: 0; }
      .new-chat select { min-width: 0; max-width: 100%; }
    }
    @media (max-width: 600px), (pointer: coarse) {
      .link { min-height: max(44px, var(--pi-control-min-size)); }
    }
  `;
}

function completeChatRoute(route: ParsedAppRoute): route is ParsedAppRoute & { projectId: string; workspaceId: string; sessionId: string } {
  return route.projectId !== undefined && route.workspaceId !== undefined && route.sessionId !== undefined;
}

/** Whether a Workstream watch batch can change the header of `sessionId`, which shows `workstreamId`; unexpected shapes count. */
function watchConcerns(batch: object, workstreamId: string | undefined, sessionId: string): boolean {
  const events: unknown = Reflect.get(batch, "events");
  if (Reflect.get(batch, "mode") !== "replay" || !Array.isArray(events) || events.length === 0) return true;
  const quotedSessionId = JSON.stringify(sessionId);
  return events.some((event: unknown) => typeof event !== "object" || event === null
    || Reflect.get(event, "workstreamId") === workstreamId || JSON.stringify(event).includes(quotedSessionId));
}

/** `live` with the catalog row's archive applied; a Chat the catalog reports archived is never left writable. */
function withListedArchive(live: SessionInfo, listed: SessionInfo): SessionInfo {
  if (listed.archived !== true || live.archived === true) return live;
  return { ...live, archived: true, ...(listed.archivedAt === undefined ? {} : { archivedAt: listed.archivedAt }) };
}

function isWorkbenchAgentSession(session: SessionInfo): boolean {
  return /^workbench-(?:coordinator|implementer|planner|reviewer|scout)-[0-9a-f]{8}$/u.test(session.name ?? "");
}
