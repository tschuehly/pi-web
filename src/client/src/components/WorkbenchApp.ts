import { LitElement, css, html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { styleMap } from "lit/directives/style-map.js";
import { customElement, query, state } from "lit/decorators.js";
import { api, type AskUserSubmission, type ExtensionDialogAnswer, type Project, type PromptAttachment, type QueuedSessionMessage, type SessionInfo, type SessionStatus, type SessionTreeForkResult, type SessionTreeNavigateResult, type SessionTreeSummaryChoice, type Workspace } from "../api";
import { HttpRequestError } from "../api/http";
import type { PendingAskUser, PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { adHocFolderWorkspaceId } from "../../../shared/workspaceFiles";
import { initialAppState, type AppState } from "../appState";
import { latestWorkingModeSelection } from "../chatMessages";
import { clampPanelWidth, panelWidthFromDrag, panelWidthFromKeyboard, type PanelResizeConstraints } from "../appShell/panelResizeController";
import { AuthController } from "../controllers/authController";
import { desktopNotifications, DesktopNotificationController, NATIVE_NOTIFICATION_HOLDS_EVENT, NATIVE_NOTIFICATION_OPEN_EVENT, NOTIFICATION_ANCHOR } from "../controllers/desktopNotificationController";
import { SessionController, type PromptEditorTextReplacement, type SessionSelectionOptions } from "../controllers/sessionController";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { selectedMachineId } from "../controllers/types";
import { TabSwipeController } from "../controllers/tabSwipeController";
import { WINDOW_URL_PARAM, WorkbenchWindowController, type WindowRequest } from "../controllers/workbenchWindowController";
import { resolveAppUrl } from "../appUrl";
import { applyInterfaceScale, DEFAULT_INTERFACE_SCALE, readStoredInterfaceScale, stepInterfaceScale, writeStoredInterfaceScale } from "../interfaceScale";
import { markdownWorkspaceContext, type LineRange, type OutsideFileOpenRequest, type WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { machineSessionKey } from "../machineKeys";
import { loadStagedAttachmentDraft, resolveStagedAttachmentKey } from "../promptAttachmentStaging";
import type { ReplyQuote } from "../replyQuotes";
import { nativeDirectoryPicker } from "../nativeHost";
import { writeClipboardText } from "../clipboard";
import { loadExternalPlugins } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { applyPresentationProfile, builtInPresentationProfile, readStoredPresentationProfile } from "../presentationProfiles";
import { applyCheckpointSessionTitle } from "../workstreamCheckpointTitle";
import { workstreamOrientationDepth } from "../workstreamOrientation";
import { hasRenderedModal } from "./modalLayerRegistry";
import { isCreatingSessionId, readRoute, takeMessageAnchor, writeRoute, type ParsedAppRoute } from "../route";
import { sessionTitle } from "../sessionLabels";
import { sessionPersistenceState } from "../sessionPersistence";
import { selectedNotificationView } from "../sessionNotifications";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import { applyPiWebTheme, readStoredThemePreference, resolveThemePreference, writeStoredThemePreference, type ThemePreference } from "../theme";
import { closeChats, focusChat, gridTiles, moveChats, orderedChats, toggleLayout, toggleMaximized, updateChat, type GridTile, type WindowChat, type WindowStore } from "../workbenchWindows";
import { workstreamAccentColor } from "../workstreamColor";
import type { ChatRevealTarget, ChatView } from "./ChatView";
import { hasUnacknowledgedSend, type PromptEditor } from "./PromptEditor";
import type { WorkbenchFilesPane } from "./WorkbenchFilesPane";
import "./AllSessions";
import "./AuthDialog";
import "./ChatView";
import "./CommandPicker";
import "./DelegateRoster";
import "./GoalStatusChip";
import "./ProjectDialog";
import "./PromptEditor";
import "./SessionTreeNavigator";
import "./WorkstreamChooser";
import "./WorkstreamContextDrawer";
import "./WorkbenchSettingsPanel";
import "./WorkbenchFilesPane";
import { openQuestionCount, type WorkbenchQuestionChips } from "./WorkbenchQuestionChips";
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
  @state() private app: AppState = initialAppState();
  /** The navigation still loading; a newer navigation ends its Loading. */
  @state() private loadingAt: number | undefined = 0;
  @state() private showAgentSessions = false;
  @state() private showAllSessions = false;
  @state() private sessionInfoCopied = false;
  @state() private chooserView: "project" | "other" | "all" = "project";
  @state() private currentWorkstream: WorkstreamSnapshot | null | undefined;
  @state() private currentWorkstreamError = "";
  @state() private delegateRosterCollapsed = false;
  /** The right-hand slot beside the Chat: divider, width and close chevron. */
  @state() private sidePane: "files" | undefined;
  /** A workspace the Files pane shows instead of the Chat's, after a link to a file outside the Chat's folder. */
  @state() private filesTarget: { sessionId: string; workspace: Workspace } | undefined;
  @state() private filesWidth = 400;
  private filesResize: { pointerId: number; startX: number; startWidth: number; handle: HTMLElement } | undefined;
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;
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
      const current = this.shadowRoot?.querySelector<HTMLElement>(".grid[data-single] > .tile");
      return current === null || current === undefined ? undefined : { current, peek: this.shadowRoot?.querySelector<HTMLElement>(".swipe-peek") ?? null };
    },
    peek: (sessionId) => { this.swipePeek = sessionId; return this.updateComplete; },
    commit: (sessionId) => this.showWindowChat(sessionId),
  });
  /** One generation for every navigation, New Chat and selection included: only the newest may commit. */
  private get loadSequence(): number {
    return this.sessions.navigationGeneration;
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
  @state() private contentRendering: PluginRegistry["chatContentRendering"] | undefined;
  private themesInitialized = false;
  @state() private themePreference: ThemePreference = readStoredThemePreference() ?? { themeId: "themes:github-dark", auto: true };
  private readonly systemLightThemeMedia = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
  private readonly onSystemLightThemeChange = (): void => { this.applyPreferredTheme(); };

  private applyPreferredTheme(): void {
    const theme = resolveThemePreference({
      themes: this.plugins.getThemes(),
      themePairs: this.plugins.getThemePairs(),
      preference: this.themePreference,
      prefersLight: this.systemLightThemeMedia?.matches ?? false,
    }).activeTheme;
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

  /** Every selection of a Chat commits only once the shared store gives it to this window; else its holder shows it. */
  private readonly toggleDelegateRoster = () => { this.delegateRosterCollapsed = !this.delegateRosterCollapsed; };
  private readonly claimGridChat = (session: SessionInfo, context: Partial<AppState>): Promise<boolean> => this.claimChat(session, context, false);

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

  private readonly notifications = new SessionNotificationController(
    () => this.app,
    (patch) => { this.setApp(patch); },
  );

  private readonly sessions = new SessionController(
    () => this.app,
    (patch) => { this.setApp(patch); },
    () => { this.updateUrl(); },
    undefined,
    {
      notifications: this.notifications,
      draftStorage: () => this.windows.draftStorage,
      onSelectedSessionReady: () => {
        this.desktopNotifications.activate(this.app);
        void this.loadCurrentWorkstream();
      },
      onSessionError: (message, eventId) => { this.desktopNotifications.sessionError(this.app, message, eventId); },
      claimSession: (session, context, focus) => this.claimChat(session, context, focus),
      replacePromptEditorText: (replacement) => this.replacePromptEditorText(replacement),
    },
  );

  private async replacePromptEditorText({ machineId, sessionId, text, mode }: PromptEditorTextReplacement): Promise<void> {
    await this.updateComplete;
    // An unrendered composer queries as null.
    const editor = this.promptEditor ?? undefined;
    if (editor === undefined) return;
    await editor.updateComplete;
    if (selectedMachineId(this.app) !== machineId || this.app.selectedSession?.id !== sessionId || editor.sessionId !== sessionId) return;
    if (mode === "prepend") editor.prependText(text);
    else editor.replaceText(text);
  }

  private readonly auth = new AuthController(
    () => this.app,
    (patch) => { this.setApp(patch); },
    (status) => { this.sessions.applySessionStatus(status); },
  );

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
    void this.updateWindow(toggleLayout);
    if (this.app.selectedSession !== undefined) void this.focusChatComposer();
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
    this.sessions.resume();
    this.notifications.resume();
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
      this.contentRendering = this.plugins.chatContentRendering;
    } catch (error) {
      console.warn("Chat content renderers unavailable", error);
    }
  }

  override disconnectedCallback(): void {
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
    this.auth.dispose();
    this.sessions.dispose();
    this.notifications.dispose();
    super.disconnectedCallback();
  }

  private setApp(patch: Partial<AppState>): void {
    const previous = this.app;
    this.app = { ...this.app, ...patch };
    if (previous.selectedSession?.id !== this.app.selectedSession?.id || selectedMachineId(previous) !== selectedMachineId(this.app)) {
      this.currentWorkstream = undefined;
      window.clearTimeout(this.workstreamWatchTimer);
      this.workstreamWatchSequence = undefined;
      this.workstreamWatchDelay = 2_000;
      ++this.workstreamLoadSequence;
    }
    this.notifications.syncEnvironment(previous, this.app);
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
    if (window === undefined || selected === undefined || isCreatingSessionId(selected) || window.focused === selected) return;
    const lost = Object.entries(this.windows.store).some(([id, other]) => id !== this.windows.id && other.chats.some((chat) => chat.sessionId === selected));
    if (lost) this.retireSelected();
    this.showNext(lost);
  }

  /** Takes the Chat on screen down at once, its composer saved and unmounted; the URL follows what shows next. */
  private retireSelected(): void {
    if (this.sidePane === "files") this.sidePane = undefined;
    this.sessions.deselectSession({ updateUrl: false });
  }

  /** Shows the Chat this window focuses, or its home once nothing is on screen. */
  private showNext(discardConfirmed: boolean): void {
    const next = this.windows.window?.focused;
    if (next === undefined) { if (this.app.selectedSession === undefined) this.updateUrl(); }
    else if (next !== this.app.selectedSession?.id) void this.showWindowChat(next, discardConfirmed);
  }

  private filesPaneCanClose(): boolean {
    return this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() !== false;
  }

  /** Shows one of this window's Chats, in its recorded workspace, without leaving the Chat on screen first. */
  private async showWindowChat(sessionId: string, discardConfirmed = false): Promise<void> {
    const chat = this.windows.window?.chats.find((candidate) => candidate.sessionId === sessionId);
    if (chat === undefined || sessionId === this.app.selectedSession?.id || !discardConfirmed && !this.filesPaneCanClose()) return;
    if (this.sidePane === "files") this.sidePane = undefined;
    void this.updateWindow((store, id) => focusChat(store, id, sessionId));
    const machineId = selectedMachineId(this.app);
    if (chat.machineId !== machineId) {
      writeRoute({ machineId: chat.machineId, projectId: chat.projectId, workspaceId: chat.workspaceId, sessionId, tool: undefined, view: "chat" });
      await this.load(readRoute(), { reuseLoaded: true });
      return;
    }
    const sequence = this.sessions.beginNavigation();
    const isCurrent = () => sequence === this.loadSequence && selectedMachineId(this.app) === machineId;
    try {
      const { project, workspace, workspaces } = await this.windowChatWorkspace(chat);
      const session = isCurrent() ? this.sessions.pendingSession(sessionId, chat.startupToken) ?? await this.knownSession(sessionId, workspace.path, machineId, isCurrent) : undefined;
      if (!isCurrent()) return;
      if (session === undefined) throw new Error("This Chat is no longer available.");
      // The Chat on screen stays until the next one can paint its transcript: never a blank frame between them.
      await this.sessions.prefetchTranscript(session, machineId);
      if (!isCurrent()) return;
      await this.sessions.selectSession(session, this.inWorkspace(session, sequence, { selectedProject: project, workspaces, selectedWorkspace: workspace, sessions: [...unsavedChatsIn(this.app.sessions, workspace.path, session.id), session], error: "" }));
    } catch (error) {
      if (isCurrent()) this.setApp({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The registered workspace a window Chat was opened in while its project still lists it, else the Chat's folder. */
  private readonly windowChatWorkspace = async (chat: WindowChat): Promise<{ project: Project | undefined; workspace: Workspace; workspaces: Workspace[] }> => {
    const project = this.app.projects.find((candidate) => candidate.id === chat.projectId);
    if (project !== undefined && chat.workspaceId !== undefined) {
      const loaded = this.app.workspaces.some((candidate) => candidate.id === chat.workspaceId && candidate.projectId === project.id);
      const workspaces = loaded ? this.app.workspaces : await api.workspaces(project.id, chat.machineId).catch((): Workspace[] => []);
      const workspace = workspaces.find((candidate) => candidate.id === chat.workspaceId);
      if (workspace !== undefined) return { project, workspace, workspaces };
    }
    const pending = this.sessions.pendingSession(chat.sessionId, chat.startupToken);
    const folder = adHocWorkspace(pending?.cwd ?? (await api.locate(chat.sessionId, chat.machineId)).cwd);
    return { project: undefined, workspace: folder, workspaces: [folder] };
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
    if (sessionIds.some((id) => this.sessions.pendingSession(id, undefined, true) !== undefined)) {
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
    const text = leaving === undefined ? undefined : this.promptEditor?.view?.state.doc.toString();
    const machineId = selectedMachineId(this.app);
    // The owner already chose to discard any unsaved file edits; do not ask again.
    if (leaving !== undefined) this.retireSelected();
    return this.updateComplete.then(() => this.updateWindow(change)).then(async () => {
      if (leaving === undefined) return;
      if (this.windows.window?.chats.some((chat) => chat.sessionId === leaving) !== true) { this.showNext(true); return; }
      const { error } = this.app;
      await this.showWindowChat(leaving, true);
      if (text !== undefined) await this.replacePromptEditorText({ machineId, sessionId: leaving, text });
      this.setApp({ error });
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
    this.sessions.deselectSession();
  }

  private chatTabStatuses(): Record<string, ChatTabStatus> {
    const selected = this.app.selectedSession?.id;
    return Object.fromEntries((this.windows.window?.chats ?? []).map((chat) => [chat.sessionId, chatTabStatus(chat.sessionId === selected ? this.app.status : this.app.sessionStatuses[chat.sessionId], this.unreadChats.has(chat.sessionId))]));
  }

  /** The selected Chat's live open asks, and every other Chat's as its last status reported them, else as read when the window connected. */
  private chatQuestionCounts(): Record<string, number> {
    const selected = this.app.selectedSession?.id;
    const asks = (chat: WindowChat) => {
      if (chat.sessionId === selected) return this.app.pendingAsks;
      const status = this.app.sessionStatuses[chat.sessionId];
      return status === undefined ? this.restoredAsks[machineSessionKey(chat.machineId, chat.sessionId)] : status.pendingAsks;
    };
    return Object.fromEntries((this.windows.window?.chats ?? []).map((chat) => [chat.sessionId, openQuestionCount(asks(chat))]));
  }

  /** The Chat's Workstream names its tab group once known; an unreachable Workstream service keeps the last name. */
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
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
    const sequence = this.sessions.beginNavigation();
    const previous = this.app;
    const selectedWorkspace = this.app.selectedWorkspace;
    const retainSelection = completeChatRoute(route)
      && route.sessionId === this.app.selectedSession?.id
      && route.projectId === this.app.selectedProject?.id
      && route.workspaceId === selectedWorkspace?.id
      && (route.machineId ?? "local") === selectedMachineId(this.app);
    if (retainSelection) this.desktopNotifications.suspend();
    this.loadingAt = sequence;
    if (!retainSelection) this.sessions.clearActiveSession();
    try {
      const reuse = options?.reuseLoaded === true && previous.selectedMachine?.id === (route.machineId ?? "local");
      const machines = reuse ? previous.machines : await api.machines();
      if (sequence !== this.loadSequence) return;
      const machine = machines.find((candidate) => candidate.id === (route.machineId ?? "local"))
        ?? machines.find((candidate) => candidate.id === "local")
        ?? machines[0];
      const keepSelection = retainSelection && machine?.id === selectedMachineId(this.app);
      if (retainSelection && !keepSelection) this.sessions.clearActiveSession();
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
      await this.sessions.selectSession(session, { updateUrl: false, ...this.inWorkspace(session, sequence, { selectedProject: project, workspaces, selectedWorkspace: workspace, sessions: keepSelection ? this.app.sessions : [...unsavedChatsIn(previousRows, workspace.path, session.id), session] }) });
      // A reservation resolved to its created Chat: the address names that Chat from now on.
      if (route.sessionId !== session.id && this.app.selectedSession?.id === session.id) this.updateUrl({ replace: true });
    } catch (error) {
      if (sequence === this.loadSequence) {
        if (retainSelection) this.sessions.clearActiveSession();
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
    await this.sessions.selectSession(session, { updateUrl: false, ...this.inWorkspace(session, sequence, { selectedProject: undefined, workspaces: [workspace], selectedWorkspace: workspace, sessions: [...unsavedChatsIn(previousRows, workspace.path, session.id), session] }) });
  }

  /** Commits a Chat with its workspace for navigation `generation`, once claimed; that workspace's catalog loads behind it. */
  private inWorkspace(session: SessionInfo, generation: number, context: Partial<AppState> & { selectedWorkspace: Workspace }): SessionSelectionOptions {
    const machineId = selectedMachineId(this.app);
    return { generation, context, onCommit: () => { void this.loadCatalogBehind(session.id, context.selectedWorkspace, machineId, generation); } };
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

  /** The question chip last pressed in a side tile, opened once that tile's Chat is on screen. */
  private tileQuestion: { sessionId: string; askId: string; questionIndex: number } | undefined;

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
    if (event.type !== "sessions.unread" && event.type !== "notices.updated" && event.type !== "machine.status") this.sessions.applyGlobalEvent(event);
    for (const pane of this.shadowRoot?.querySelectorAll<WorkbenchChatPane>("workbench-chat-pane") ?? []) pane.applyGlobalEvent(event);
  }

  private async chooseMachine(machineId: string): Promise<void> {
    const machine = this.app.machines.find((candidate) => candidate.id === machineId);
    if (machine === undefined || machine.id === this.app.selectedMachine?.id) return;
    const sequence = this.sessions.beginNavigation();
    this.loadingAt = sequence;
    this.sessions.clearActiveSession();
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
    const sequence = this.sessions.beginNavigation();
    this.sessions.clearActiveSession();
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
    const sequence = this.sessions.beginNavigation();
    this.sessions.clearActiveSession();
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
    await this.sessions.selectSession(session, options);
    await this.updateComplete;
    this.promptEditor?.focusInput();
  }

  private async openAllSession(session: SessionInfo): Promise<void> {
    if (await this.openedElsewhere(session.id)) return;
    const generation = this.sessions.beginNavigation();
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
      navigation = this.sessions.beginNavigation();
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

    this.sessions.clearActiveSession();
    this.setApp({ selectedProject: match?.project, selectedWorkspace: workspace, workspaces: match?.workspaces ?? [workspace], sessions: [], error: "" });
    let session: SessionInfo;
    try {
      const started = await this.sessions.startSessionWithOptions({ startupToken: associationKey, propagateError: true });
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
    if (this.selectedChatIs(session.id, machineId)) this.promptEditor?.focusInput();
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
    await this.sessions.startSession();
    await this.updateComplete;
    this.promptEditor?.focusInput();
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
    this.sessions.clearActiveSession();
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

  private async copySessionInfo(session: SessionInfo): Promise<void> {
    if (!await writeClipboardText(sessionInfoText(session, this.app.status))) { this.setApp({ error: "Could not copy the session info." }); return; }
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

  private readonly handleSend = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery?: PromptAttachmentDelivery, folder?: string): Promise<boolean> => {
    if (this.orientationPendingSessionId === this.app.selectedSession?.id) this.orientationPendingSessionId = undefined;
    if ((attachments === undefined || attachments.length === 0) && streamingBehavior === undefined && this.auth.handleSlashCommand(text)) return Promise.resolve(true);
    return this.sessions.send(text, streamingBehavior, attachments, delivery, folder);
  };

  private readonly replyToSelection = (quote: ReplyQuote): void => {
    this.promptEditor?.insertReplyQuote(quote);
    void this.focusChatComposer();
  };

  private readonly loadModels = () => this.sessions.listModels();
  private readonly setModel = (provider: string, modelId: string) => this.sessions.setModel(provider, modelId);
  private readonly setThinkingLevel = (level: string) => this.sessions.setThinkingLevel(level);

  private async focusChatComposer(): Promise<void> {
    await this.updateComplete;
    this.promptEditor?.focusInput();
  }

  /** A tile's Chat now on screen: its pressed question opens in the drawer, else (or once it is gone) its composer takes focus. A superseded switch does neither. */
  private async focusTileChat(sessionId: string): Promise<void> {
    if (this.app.selectedSession?.id !== sessionId) return;
    const question = this.tileQuestion?.sessionId === sessionId ? this.tileQuestion : undefined;
    this.tileQuestion = undefined;
    await this.updateComplete;
    const chips = question === undefined ? undefined : this.shadowRoot?.querySelector<WorkbenchQuestionChips>('.tile[data-focused="true"] .chat-column > workbench-question-chips');
    if (question === undefined || chips === null || chips === undefined || !await chips.openQuestion(question.askId, question.questionIndex)) await this.focusChatComposer();
  }

  private async navigateSessionTree(targetId: string, summaryChoice: SessionTreeSummaryChoice): Promise<SessionTreeNavigateResult> {
    const result = await this.sessions.navigateTree(targetId, summaryChoice);
    if (!result.cancelled) await this.focusChatComposer();
    return result;
  }

  private async forkSessionTree(entryId: string): Promise<SessionTreeForkResult> {
    // The controller selects the forked session and closes the dialog on success.
    return this.sessions.forkFromTree(entryId);
  }

  private closeSessionTreeNavigator(): void {
    this.sessions.closeTreeDialog();
    void this.focusChatComposer();
  }

  private renderSessionTreeNavigator(state: AppState) {
    return state.treeDialog === undefined ? null : html`
      <session-tree-navigator
        .tree=${state.treeDialog}
        .onNavigate=${(targetId: string, summaryChoice: SessionTreeSummaryChoice) => this.navigateSessionTree(targetId, summaryChoice)}
        .onFork=${(entryId: string) => this.forkSessionTree(entryId)}
        .onAbort=${() => this.sessions.abortTreeNavigation()}
        .onCancel=${() => { this.closeSessionTreeNavigator(); }}
      ></session-tree-navigator>
    `;
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
      <div class="stage">${this.app.selectedSession === undefined ? this.renderChooser() : this.renderWindowChats()}${this.renderSwipePeek()}</div>
      ${this.renderWindowMenu()}
    `;
  }

  /**
   * Tabs, or a maximized tile: the focused Chat alone. Grid: its page of up to four tiles, only those live. Every layout
   * renders the focused Chat as the same first tile, so ⌃G and full size never remount it with its composer and Files edits.
   * The other tiles each keep their grid position's slot, so a focus switch never moves one (a moved tile loses its scroll).
   */
  private renderWindowChats() {
    const window = this.windows.window;
    const selected = this.app.selectedSession?.id;
    // Laid out around the Chat on screen: a focus switch keeps the outgoing grid until the selection lands, so no tile remounts.
    const tiles = window?.layout === "grid" && !window.maximized ? gridTiles({ ...window, focused: selected }) : [];
    const focused = tiles.length < 2 ? undefined : tiles.find((tile) => tile.chat.sessionId === selected);
    const statuses = this.chatTabStatuses();
    return html`
      <div class="grid" ?data-single=${focused === undefined} @dragover=${(event: DragEvent) => { if (carriesChats(event)) event.preventDefault(); }} @drop=${(event: DragEvent) => { const dropped = droppedChats(event); if (dropped !== undefined) { event.preventDefault(); void this.takeDroppedChats(dropped); } }}>
        <section class="tile" data-focused="true" style=${this.tileStyle(focused)}>${focused === undefined ? nothing : this.renderTileBar(focused, statuses[focused.chat.sessionId] ?? "idle", true)}${this.renderChat(focused !== undefined)}</section>
        ${(focused === undefined ? [] : tiles).map((tile) => tile === focused ? nothing : keyed(tile.chat.sessionId, this.renderTile(tile, statuses[tile.chat.sessionId] ?? "idle")))}
      </div>
    `;
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

  /** A tile beside the focused one; any press or focus inside hands its Chat to the shell, a question chip opening its question there. */
  private renderTile(tile: GridTile, status: ChatTabStatus) {
    const { chat } = tile;
    const focus = (event: Event) => {
      const path = event.composedPath();
      if (path.some((target) => target instanceof HTMLElement && target.classList.contains("tile-actions"))) return;
      // A press and the focus it causes (WebKit focuses no button on click) both switch; the chip pressed is kept for the switch that lands.
      const chip = path.find((target): target is HTMLElement => target instanceof HTMLElement && target.dataset["ask"] !== undefined && target.dataset["question"] !== undefined);
      if (chip !== undefined) this.tileQuestion = { sessionId: chat.sessionId, askId: chip.dataset["ask"] ?? "", questionIndex: Number(chip.dataset["question"]) };
      void this.showWindowChat(chat.sessionId).then(() => this.focusTileChat(chat.sessionId));
    };
    return html`
      <section class="tile" data-session=${chat.sessionId} style=${this.tileStyle(tile)} @pointerdown=${focus} @focusin=${focus}>
        ${this.renderTileBar(tile, status, false)}
        <workbench-chat-pane .chat=${chat} .claimSession=${this.claimGridChat} .draftStorage=${this.windows.draftStorage} .machines=${this.app.machines} .resolveWorkspace=${this.windowChatWorkspace} .contentRendering=${this.contentRendering}
          .rosterCollapsed=${this.delegateRosterCollapsed} .onToggleRoster=${this.toggleDelegateRoster}></workbench-chat-pane>
      </section>
    `;
  }

  /**
   * Every Grid tile's one header row, focused or not, so focusing a tile moves nothing: its Workstream, its Chat, the
   * Chat's tools, full size and close. Only the focused (`live`) tile's Workstream and tools act; elsewhere they are
   * inert, so a press falls through to the tile and focuses it.
   */
  private renderTileBar({ chat }: GridTile, status: ChatTabStatus, live: boolean) {
    const session = this.app.selectedSession;
    const workstream = chat.workstream;
    const loaded = live && this.currentWorkstream?.id === workstream?.id ? this.currentWorkstream : undefined;
    const maximize = () => { void this.showWindowChat(chat.sessionId).then(() => this.updateWindow(toggleMaximized)); };
    return html`
      <div class="tile-bar" draggable="true" @dblclick=${maximize}
        @contextmenu=${(event: MouseEvent) => { event.preventDefault(); this.openWindowMenu({ sessionIds: [chat.sessionId], label: chat.title, clientX: event.clientX, clientY: event.clientY }); }}
        @dragstart=${(event: DragEvent) => { startChatDrag(event, { windowId: this.windows.id, sessionIds: [chat.sessionId] }, chat.title); this.guardChatDrag(event); }}
        @dragend=${(event: DragEvent) => { if (event.dataTransfer?.dropEffect === "none" && endedOutside(event, window)) this.moveToNewWindow([chat.sessionId]); }}>
        ${workstream === undefined ? nothing : html`<workstream-context-drawer compact ?inert=${!live} .snapshot=${loaded ?? { ...workstream, revision: 0, updatedAt: "", closed: false, sessions: [], humanTasks: [], links: [], overview: null }} .serviceContext=${loaded === undefined ? undefined : this.workstreamServiceContext} .sessionId=${chat.sessionId} @workstream-updated=${(event: CustomEvent<WorkstreamSnapshot>) => { this.currentWorkstream = event.detail; }}></workstream-context-drawer>`}
        ${renderChatStatusDot(status)}
        <span class="tile-title" title=${chat.title}>${chat.title}</span>
        ${status === "needs" ? html`<span class="needs">Needs you</span>` : nothing}
        <span class="tile-tools" ?inert=${!live}>${session === undefined ? nothing : this.renderChatToolButtons(session)}</span>
        <span class="tile-actions">
          <button type="button" class="icon-button" title="Full size (⌃↩)" aria-label=${`Full size ${chat.title}`} @click=${maximize}>${renderBuiltinTabIcon("maximize")}</button>
          <button type="button" class="icon-button" title="Close" aria-label=${`Close ${chat.title}`} @click=${() => { this.closeWindowChats([chat.sessionId]); }}>${renderBuiltinTabIcon("x")}</button>
        </span>
      </div>
    `;
  }

  /** A maximized Grid tile: restore and close, in its header. */
  private renderGridActions(sessionId: string) {
    const window = this.windows.window;
    if (window?.layout !== "grid" || window.chats.length < 2) return nothing;
    return html`
      <button type="button" class="icon-button" title=${window.maximized ? "Restore grid (⌃↩)" : "Full size (⌃↩)"} aria-label=${window.maximized ? "Restore grid" : "Full size"} @click=${() => { void this.updateWindow(toggleMaximized); }}>${renderBuiltinTabIcon(window.maximized ? "minimize" : "maximize")}</button>
      <button type="button" class="icon-button" title="Close" aria-label="Close Chat" @click=${() => { this.closeWindowChats([sessionId]); }}>${renderBuiltinTabIcon("x")}</button>
    `;
  }

  private renderSettingsPanel() {
    return html`
      <workbench-settings-panel
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

  /** Show `path` in the Files pane, in `workspace` or else the Chat's own workspace. */
  private openInFiles(workspace: Workspace | undefined, path: string, lines?: LineRange): void {
    const current = this.filesWorkspace();
    const next = workspace ?? this.app.selectedWorkspace;
    const switching = current !== undefined && (next?.projectId !== current.projectId || next.id !== current.id);
    if (switching && this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() === false) return;
    const session = this.app.selectedSession;
    this.filesTarget = workspace === undefined || session === undefined ? undefined : { sessionId: session.id, workspace };
    this.sidePane = "files";
    void this.updateComplete.then(async () => {
      const pane = this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
      if (pane !== null && pane !== undefined) { await pane.updateComplete; await pane.openFile(path, false, lines); }
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

  /** The selected Chat's Workstream and tools. */
  private renderChatTools() {
    const session = this.app.selectedSession;
    if (session === undefined) return nothing;
    return html`
      ${this.currentWorkstream ? html`<workstream-context-drawer ?compact=${this.chatToolsInTabRow()} .snapshot=${this.currentWorkstream} .error=${this.currentWorkstreamError} .fallbackTitle=${sessionTitle(session)} .serviceContext=${this.workstreamServiceContext} .sessionId=${session.id} @workstream-updated=${(event: CustomEvent<WorkstreamSnapshot>) => { this.currentWorkstream = event.detail; }}></workstream-context-drawer>` : nothing}
      ${this.renderChatToolButtons(session)}
      ${this.renderGridActions(session.id)}
    `;
  }

  /** Files, session tree, session info, settings, notifications; the Chat's folder is the Files tooltip. */
  private renderChatToolButtons(session: SessionInfo) {
    const state = this.app;
    const workspace = state.selectedWorkspace;
    const folder = workspace === undefined ? "" : ` — ${state.selectedProject === undefined ? "" : `${state.selectedProject.name} · `}${workspace.label} (${workspace.path})`;
    return html`
      <button type="button" class="icon-button files-toggle" title=${`Files${folder}`} aria-label="Files" aria-expanded=${this.sidePane === "files"} aria-controls="workbench-files" @click=${() => { this.toggleFiles(); }}>${renderBuiltinTabIcon("files")}</button>
      <button class="icon-button" type="button" title="Session tree" aria-label="Session tree" @click=${() => { void this.sessions.runCommand("/tree"); }}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg></button>
      <button class="icon-button" type="button" title=${`${sessionInfoText(session, state.status)}\n\nClick to copy`} aria-label=${this.sessionInfoCopied ? "Copied session info" : "Copy session info"} @click=${() => { void this.copySessionInfo(session); }}>${this.sessionInfoCopied ? html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>` : html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>`}</button>
      ${this.renderSettingsPanel()}
      ${this.renderDesktopNotificationButton()}
    `;
  }

  /** `tile`: the focused tile of a grid, laid out like every other tile under its tile bar. */
  private renderChat(tile = false) {
    const state = this.app;
    const session = state.selectedSession;
    if (session === undefined) return null;
    const warningCount = state.status?.warnings?.length ?? 0;
    return html`
      <main class="chat-shell" data-view="chat" data-machine=${selectedMachineId(state)} data-project=${state.selectedProject?.id ?? ""} data-workspace=${state.selectedWorkspace?.id ?? ""} data-session=${session.id}>
        ${this.chatToolsInTabRow() || tile ? nothing : html`<header>${this.renderChatTools()}</header>`}
        ${this.renderDesktopNotificationDiagnostic()}
        ${state.error === "" ? null : html`<div class="chat-error" role="alert">${state.error}</div>`}
        <div class="chat-and-files" style=${`--files-width: ${String(this.filesWidth)}px`}>
          <div class="chat-column">
        <chat-view
          .dense=${tile}
          .contentRendering=${this.contentRendering}
          @workspace-file-open=${this.openWorkspaceFile}
          @outside-file-open=${this.openOutsideFile}
          .workspaceContext=${markdownWorkspaceContext(selectedMachineId(state), state.selectedWorkspace, session)}
          .sessionId=${session.id}
          .sessionCwd=${session.cwd}
          .machineId=${selectedMachineId(state)}
          .messages=${state.messages}
          .revealTarget=${this.revealTarget}
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
          .pendingDialogs=${state.pendingDialogs}
          .closedDialogs=${state.closedDialogs}
          .askDraftSessionId=${machineSessionKey(selectedMachineId(state), session.id)}
          .onSubmitAsk=${(askId: string, submission: AskUserSubmission) => this.sessions.submitAsk(askId, submission)}
          .onAnswerDialog=${(dialogId: string, value: ExtensionDialogAnswer) => this.sessions.answerDialog(dialogId, value)}
          .onCancelDialog=${(dialogId: string) => this.sessions.cancelDialog(dialogId)}
          .onDismissClosedDialog=${(dialogId: string) => { this.sessions.dismissClosedDialog(dialogId); }}
          .notificationInbox=${selectedNotificationView(state.selectedNotificationInbox)}
          .onPromoteQueuedMessage=${(message: QueuedSessionMessage) => { void this.sessions.promoteQueuedMessage(message); }}
          .onPromoteAllQueuedMessages=${() => { void this.sessions.promoteAllQueuedMessages(); }}
          .onClearServerQueue=${() => { void this.sessions.clearServerQueue(); }}
          .onDismissWarning=${(dismissId: string) => { void this.sessions.dismissWarning(dismissId); }}
          .onDismissNotification=${(notificationId: string) => { void this.notifications.dismissNotification(notificationId); }}
          .onDismissAllNotifications=${() => { void this.notifications.dismissAll(); }}
          .onLoadMore=${() => { void this.sessions.loadEarlierMessages(); }}
          .onMessageAction=${(entryId: string, action: "fork" | "back") => this.sessions.actOnMessage(entryId, action)}
          .onReplyToSelection=${session.archived === true ? undefined : this.replyToSelection}
        ></chat-view>
        <delegate-roster .status=${state.status} .collapsed=${this.delegateRosterCollapsed} .onToggleCollapsed=${this.toggleDelegateRoster}></delegate-roster>
        <goal-status-chip .status=${state.status}></goal-status-chip>
        <workbench-question-chips .asks=${state.pendingAsks} .draftSessionId=${machineSessionKey(selectedMachineId(state), session.id)} .onSubmit=${(askId: string, submission: AskUserSubmission) => this.sessions.submitAsk(askId, submission)}></workbench-question-chips>
        <prompt-editor
          .draftStorage=${this.windows.draftStorage}
          .dense=${tile}
          .sessionId=${session.id}
          .cwd=${state.selectedWorkspace?.path}
          .machineId=${selectedMachineId(state)}
          .disabled=${session.archived === true}
          .canSteer=${state.status?.isStreaming === true}
          .isCompacting=${state.status?.isCompacting === true}
          .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0}
          .status=${state.status}
          .workingModeTranscriptSelection=${latestWorkingModeSelection(state.messages)}
          .showUsage=${true}
          .warningCount=${warningCount}
          .sending=${state.sendingPrompts[session.id] === true}
          .onSend=${this.handleSend}
          .onStop=${() => { void this.sessions.stopActiveWork(); }}
          .thinkingLevels=${state.availableThinkingLevels}
          .loadModels=${this.loadModels}
          .onSetModel=${this.setModel}
          .onSetThinkingLevel=${this.setThinkingLevel}
          .onRunCommand=${(command: string) => this.sessions.runCommand(command)}
        ></prompt-editor>
          </div>
          ${this.sidePane === undefined ? null : html`
            <div class="files-divider" role="separator" tabindex="0" aria-label="Resize Files pane" title="Resize Files pane" aria-orientation="vertical" aria-controls="workbench-files" aria-valuemin="240" aria-valuemax=${String(this.filesConstraints().maxWidth)} aria-valuenow=${String(this.visibleFilesWidth())}
              @pointerdown=${(event: PointerEvent) => { this.startFilesResize(event); }} @pointermove=${(event: PointerEvent) => { this.moveFilesResize(event); }} @pointerup=${(event: PointerEvent) => { this.finishFilesResize(event); }} @pointercancel=${(event: PointerEvent) => { this.finishFilesResize(event); }} @keydown=${(event: KeyboardEvent) => { this.resizeFilesWithKeyboard(event); }}></div>
            <div class="files-close-anchor"><button type="button" class="files-close" title="Close Files" aria-label="Close Files" aria-controls="workbench-files" @click=${() => { this.toggleFiles(); }}>${renderBuiltinTabIcon("chevron")}</button></div>`}
          ${this.sidePane === "files" ? html`<workbench-files-pane id="workbench-files" .workspace=${this.filesWorkspace()} .machineId=${selectedMachineId(state)}></workbench-files-pane>` : null}
        </div>
        ${state.commandDialog === undefined ? null : html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => { void this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value); }} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>`}
        ${this.renderSessionTreeNavigator(state)}
        ${state.authDialog === undefined ? null : html`
          <auth-dialog
            .state=${state.authDialog}
            .onChooseMethod=${(type: "oauth" | "api_key") => { void this.auth.chooseLoginMethod(type); }}
            .onSelectProvider=${(providerId: string, type: "oauth" | "api_key") => { void this.auth.selectLoginProvider(providerId, type); }}
            .onLogoutProvider=${(providerId: string) => { void this.auth.logoutProvider(providerId); }}
            .onOAuthInput=${(value: string) => { this.auth.updateOAuthInput(value); }}
            .onOAuthRespond=${(value?: string) => { void this.auth.respondOAuth(value); }}
            .onOAuthCancel=${() => { void this.auth.cancelOAuth(); }}
            .onCancel=${() => { this.auth.closeDialog(); }}
          ></auth-dialog>
        `}
      </main>
    `;
  }

  static override styles = css`
    ${chatStatusDotStyles}
    :host { --pi-app-safe-area-bottom: 0px; --pi-workbench-viewport-height: calc(100dvh / var(--pi-interface-scale, 1)); --pi-workbench-viewport-width: calc(100dvw / var(--pi-interface-scale, 1)); position: fixed; top: 0; right: 0; left: 0; display: flex; flex-direction: column; height: var(--pi-workbench-viewport-height); box-sizing: border-box; overflow: hidden; padding: env(safe-area-inset-top) env(safe-area-inset-right) var(--pi-app-safe-area-bottom) env(safe-area-inset-left); background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui, sans-serif; }
    @media (display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui) {
      :host { --pi-app-safe-area-bottom: env(safe-area-inset-bottom); }
    }
    .stage { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; }
    /* No rules between tiles: every tile rests on the background, the gutter is darker, the focused tile is outlined. */
    .grid { height: 100%; display: grid; grid-template: minmax(0, 1fr) minmax(0, 1fr) / minmax(0, 1fr) minmax(0, 1fr); gap: 3px; background: light-dark(color-mix(in srgb, var(--pi-bg) 94%, var(--pi-text)), color-mix(in srgb, var(--pi-bg) 85%, black)); }
    .tile { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--pi-bg); }
    /* Grid tracks size every tile, so it can contain its size: the question drawer measures its height against it (cqh). */
    .tile { container-type: size; }
    /* Half the comfortable profile's spacing inside a tile; focus is only the outline, so it moves nothing. */
    .grid:not([data-single]) > .tile { --pi-panel-padding: 5px; --pi-message-padding: 5px; --pi-toolbar-gap: 3px; }
    .grid:not([data-single]) > .tile[data-focused="true"] { outline: 2px solid var(--ws, color-mix(in srgb, var(--pi-accent) 70%, transparent)); outline-offset: -2px; }
    .tile .chat-shell { flex: 1 1 auto; height: auto; min-height: 0; }
    .tile-bar { position: relative; z-index: 6; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-width: 0; height: 32px; box-sizing: border-box; padding: 0 4px 0 8px; border-left: 3px solid var(--ws, transparent); color: var(--pi-muted); font-size: 12px; user-select: none; }
    .tile-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tile-bar workstream-context-drawer { flex: 0 1 auto; min-width: 60px; max-width: 40%; }
    .needs { flex: 0 0 auto; padding: 0 7px; border-radius: 999px; background: color-mix(in srgb, var(--pi-warning) 28%, transparent); color: var(--pi-text); font-size: 11px; font-weight: 700; line-height: 18px; }
    .tile-tools { flex: 0 0 auto; margin-left: auto; display: flex; align-items: center; gap: 2px; }
    .tile-tools workbench-settings-panel { zoom: 0.75; }
    .tile-actions { flex: 0 0 auto; display: flex; gap: 2px; opacity: 0; }
    .tile-bar:hover .tile-actions, .tile-actions:focus-within { opacity: 1; }
    .tile-bar .icon-button { width: 24px; height: 24px; min-height: 0; padding: 4px; }
    workbench-chat-pane { flex: 1 1 auto; }
    .grid[data-single] > .tile { z-index: 1; }
    .swipe-peek { position: absolute; inset: 0; z-index: 2; visibility: hidden; display: flex; align-items: center; justify-content: center; gap: 10px; background: var(--pi-bg); color: var(--pi-muted); font-size: 14px; pointer-events: none; }
    .swipe-peek strong { color: var(--pi-text); font-weight: 600; }
    .window-menu { position: fixed; z-index: 40; min-width: 220px; display: grid; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 10px 30px var(--pi-shadow); }
    .window-menu button { min-height: 0; padding: 6px 10px; border: 0; border-radius: 5px; background: none; text-align: left; font-size: 13px; }
    .window-menu button:hover, .window-menu button:focus-visible { background: var(--pi-surface-hover); }
    .window-menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--pi-border-muted); }
    .chooser { box-sizing: border-box; height: 100%; overflow: auto; display: grid; place-items: start center; padding: min(10vh, 72px) 24px 32px; }
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
    :is(header, .chat-tools) .notification-button { flex: 0 0 auto; }
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
    header { position: relative; z-index: 6; flex: 0 0 auto; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 4px 12px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
    /* In the tab row the tools keep their natural width, the drawer up to its cap: only the Chat tabs shrink and scroll. */
    .chat-tools { flex: none; display: flex; align-items: center; gap: var(--pi-toolbar-gap, 6px); }
    /* A hairline, centred in the row's gap, sets the window's Add and layout actions apart from the Chat's tools. */
    .chat-tools::after { content: ""; flex: 0 0 auto; width: 1px; height: 16px; margin-left: calc(12px - var(--pi-toolbar-gap, 6px)); background: var(--pi-border); }
    :is(header, .chat-tools) > button { flex: 0 0 auto; min-height: 32px; border-color: transparent; background: transparent; }
    :is(header, .chat-tools) > button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    :is(header, .chat-tools) > .icon-button:hover { border-color: transparent; }
    header workstream-context-drawer { flex: 1 1 auto; min-width: 0; }
    header > .files-toggle { margin-left: auto; }
    .chat-tools workstream-context-drawer { flex: 0 1 auto; min-width: 80px; max-width: 280px; }
    .chat-error { flex: 0 0 auto; padding: 8px 12px; border-bottom: 1px solid var(--pi-border); }
    .chat-and-files { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; }
    .chat-column { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
    /* Zero basis: the transcript takes what is left, so the question chips and drawer never shrink for it. */
    chat-view { flex: 1 1 0; min-height: 0; overflow: hidden; }
    delegate-roster, prompt-editor { flex: 0 0 auto; }
    .files-toggle { flex: 0 0 auto; }
    .files-toggle[aria-expanded="true"] { color: var(--pi-accent); background: var(--pi-selection-bg); }
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
      header { gap: 6px; padding-inline: 8px; }
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
