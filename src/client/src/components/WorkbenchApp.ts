import { LitElement, css, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { api, type AskUserSubmission, type ExtensionDialogAnswer, type Project, type PromptAttachment, type QueuedSessionMessage, type SessionInfo, type SessionTreeForkResult, type SessionTreeNavigateResult, type SessionTreeSummaryChoice, type Workspace } from "../api";
import type { PromptImageAttachment, SessionTopicMessage, SessionTopicSnapshot, SessionTopicSummary } from "../../../shared/apiTypes";
import { base64ByteLength, isSupportedImageMimeType } from "../../../shared/promptAttachments";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { initialAppState, type AppState } from "../appState";
import { clampPanelWidth, panelWidthFromDrag, panelWidthFromKeyboard, type PanelResizeConstraints } from "../appShell/panelResizeController";
import { AuthController } from "../controllers/authController";
import { desktopNotifications, DesktopNotificationController } from "../controllers/desktopNotificationController";
import { SessionController } from "../controllers/sessionController";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { selectedMachineId } from "../controllers/types";
import { applyInterfaceScale, DEFAULT_INTERFACE_SCALE, readStoredInterfaceScale, stepInterfaceScale, writeStoredInterfaceScale } from "../interfaceScale";
import { markdownWorkspaceContext, type WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { machineSessionKey } from "../machineKeys";
import { nativeDirectoryPicker } from "../nativeHost";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { applyPresentationProfile, builtInPresentationProfile, readStoredPresentationProfile } from "../presentationProfiles";
import { readFileAsBase64 } from "../promptAttachmentCapture";
import { readRoute, writeRoute, type ParsedAppRoute } from "../route";
import { loadTopicImageState, saveTopicImageState, type PendingTopicImagePost } from "../topicImageDraftStorage";
import { sessionTitle } from "../sessionLabels";
import { selectedNotificationView } from "../sessionNotifications";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import { applyPiWebTheme, readStoredThemePreference, resolveThemePreference, writeStoredThemePreference, type ThemePreference } from "../theme";
import type { ChatView } from "./ChatView";
import type { PromptEditor } from "./PromptEditor";
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
import { appendWorkstream, inspectWorkstream, isTemporaryDirectory, watchWorkstreams, workstreamForSession, type OpenWorkstreamSessionDetail, type StartWorkstreamSessionDetail, type WorkstreamAppendRecord, type WorkstreamServiceContext, type WorkstreamSessionAnchor, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { renderBuiltinTabIcon } from "./tabIcons";

/** A folder used for one Chat without registering a project. */
export const adHocWorkspace = (path: string): Workspace => ({ id: `folder:${path}`, projectId: "", path, label: path.split("/").filter(Boolean).at(-1) ?? path, isMain: false, effectiveConfig: {} });

/** A project whose path lies inside another registered project belongs to that project's tab. */
export function rootProjectOf(project: Project, projects: readonly Project[]): Project {
  const parent = projects.find((candidate) => candidate.id !== project.id && project.path.startsWith(`${candidate.path}/`));
  return parent === undefined ? project : rootProjectOf(parent, projects);
}
export const rootProjects = (projects: readonly Project[]): Project[] => projects.filter((project) => rootProjectOf(project, projects).id === project.id);
const subprojectsOf = (root: Project, projects: readonly Project[]): Project[] => projects.filter((project) => rootProjectOf(project, projects).id === root.id);

function isTopicStorageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PendingTopicPost = PendingTopicImagePost;
const MAX_TOPIC_IMAGES = 4;
const MAX_TOPIC_IMAGE_BYTES = 8 * 1024 * 1024;

function savedTopicPosts(value: unknown): Record<string, PendingTopicPost> {
  if (!isTopicStorageRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, PendingTopicPost] => {
    const post = entry[1];
    return isTopicStorageRecord(post) && typeof post["requestId"] === "string" && typeof post["text"] === "string" && (post["status"] === "queued" || post["status"] === "sending" || post["status"] === "unknown" || post["status"] === "conflict" || post["status"] === "invalid");
  }));
}

@customElement("pi-workbench-app")
export class WorkbenchApp extends LitElement {
  @state() private app: AppState = initialAppState();
  @state() private loading = true;
  @state() private showAgentSessions = false;
  @state() private showAllSessions = false;
  @state() private chooserView: "project" | "other" | "all" = "project";
  @state() private currentWorkstream: WorkstreamSnapshot | null | undefined;
  @state() private currentWorkstreamError = "";
  @state() private delegateRosterCollapsed = false;
  @state() private showFiles = false;
  @state() private filesWidth = 400;
  @state() private showFocusTopic = false;
  @state() private showNewTopic = false;
  @state() private topics: SessionTopicSummary[] = [];
  @state() private selectedTopicId = "";
  @state() private topicSnapshot: SessionTopicSnapshot | undefined;
  private topicSnapshotVersion = "";
  @state() private focusTopicDraft = "";
  @state() private focusTopicError = "";
  @state() private focusTopicLoading = false;
  @state() private focusTopicSending = false;
  @state() private topicImagesReading = false;
  private topicImageReadSequence = 0;
  @state() private topicImageStorageError = false;
  @state() private topicImageDrafts: Record<string, PromptImageAttachment[]> = {};
  @state() private newTopicTitle = "";
  private focusTopicLoadSequence = 0;
  @state() private pendingTopicPosts: Record<string, PendingTopicPost> = {};
  private topicDrafts: Record<string, string> = {};
  private topicScrolls: Record<string, number> = {};
  private topicRefreshTimer: number | undefined;
  private filesResize: { pointerId: number; startX: number; startWidth: number; handle: HTMLElement } | undefined;
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;
  private readonly realtime = new RealtimeSocket();
  private loadSequence = 0;
  private modelDialogInstanceId = 0;
  private workstreamLoadSequence = 0;
  private workstreamWatchSequence: number | undefined;
  private workstreamWatchDelay = 2_000;
  private workstreamWatchTimer: number | undefined;
  private readonly themes = new PluginRegistry();
  private themesInitialized = false;
  @state() private themePreference: ThemePreference = readStoredThemePreference() ?? { themeId: "themes:github-dark", auto: true };
  private readonly systemLightThemeMedia = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-color-scheme: light)") : undefined;
  private readonly onSystemLightThemeChange = (): void => { this.applyPreferredTheme(); };

  private applyPreferredTheme(): void {
    const theme = resolveThemePreference({
      themes: this.themes.getThemes(),
      themePairs: this.themes.getThemePairs(),
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
  );

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
      onSelectedSessionReady: () => {
        this.desktopNotifications.activate(this.app);
        void this.loadCurrentWorkstream();
        void this.loadTopics(true);
      },
      onSessionError: (message, eventId) => { this.desktopNotifications.sessionError(this.app, message, eventId); },
      replacePromptEditorText: async ({ machineId, sessionId, text, mode }) => {
        await this.updateComplete;
        const editor = this.promptEditor;
        if (editor === undefined) return;
        await editor.updateComplete;
        if (selectedMachineId(this.app) !== machineId || this.app.selectedSession?.id !== sessionId || editor.sessionId !== sessionId) return;
        if (mode === "prepend") editor.prependText(text);
        else editor.replaceText(text);
      },
    },
  );

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
    this.showFiles = false;
    void this.load(readRoute());
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); this.stepScale(1); }
    else if (event.key === "-") { event.preventDefault(); this.stepScale(-1); }
    else if (event.key === "0") { event.preventDefault(); this.setScale(DEFAULT_INTERFACE_SCALE); }
  };

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
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("resize", this.onWindowResize);
    applyPresentationProfile(readStoredPresentationProfile() ?? builtInPresentationProfile("comfortable"));
    this.systemLightThemeMedia?.addEventListener("change", this.onSystemLightThemeChange);
    void this.initializeThemes();
    void this.load(readRoute());
  }

  private async initializeThemes(): Promise<void> {
    if (!this.themesInitialized) {
      this.themesInitialized = true;
      await this.themes.register({ id: "themes", plugin: themePackPlugin });
    }
    if (!this.isConnected) return;
    this.applyPreferredTheme();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    window.removeEventListener("resize", this.onWindowResize);
    this.finishFilesResize();
    this.systemLightThemeMedia?.removeEventListener("change", this.onSystemLightThemeChange);
    this.realtime.close();
    window.clearTimeout(this.workstreamWatchTimer);
    window.clearTimeout(this.topicRefreshTimer);
    this.auth.dispose();
    this.sessions.dispose();
    this.notifications.dispose();
    super.disconnectedCallback();
  }

  private setApp(patch: Partial<AppState>): void {
    const previous = this.app;
    const next = { ...this.app, ...patch };
    if (previous.selectedSession && (previous.selectedSession.id !== (next.selectedSession?.id ?? "") || previous.selectedSession.cwd !== (next.selectedSession?.cwd ?? "") || selectedMachineId(previous) !== selectedMachineId(next))) this.saveTopicPosition();
    this.app = next;
    if (previous.selectedSession?.id !== this.app.selectedSession?.id || previous.selectedSession?.cwd !== this.app.selectedSession?.cwd || selectedMachineId(previous) !== selectedMachineId(this.app)) {
      ++this.focusTopicLoadSequence;
      this.showFocusTopic = false;
      this.showNewTopic = false;
      this.topics = [];
      this.selectedTopicId = "";
      this.topicSnapshot = undefined;
      this.topicSnapshotVersion = "";
      this.pendingTopicPosts = {};
      this.focusTopicDraft = "";
      this.focusTopicError = "";
      this.focusTopicLoading = false;
      this.focusTopicSending = false;
      this.topicImagesReading = false;
      ++this.topicImageReadSequence;
      this.topicImageStorageError = false;
      this.topicImageDrafts = {};
      window.clearTimeout(this.topicRefreshTimer);
      this.topicRefreshTimer = undefined;
      const storageKey = `pi-web.topics.${selectedMachineId(this.app)}.${this.app.selectedSession?.id ?? ""}.${this.app.selectedSession?.cwd ?? ""}`;
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
        if (!isTopicStorageRecord(saved)) throw new Error("Invalid saved topic state");
        const selected = saved["selected"];
        const drafts = saved["drafts"];
        const scrolls = saved["scrolls"];
        this.selectedTopicId = typeof selected === "string" ? selected : "";
        this.topicDrafts = isTopicStorageRecord(drafts) ? Object.fromEntries(Object.entries(drafts).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
        this.topicScrolls = isTopicStorageRecord(scrolls) ? Object.fromEntries(Object.entries(scrolls).filter((entry): entry is [string, number] => typeof entry[1] === "number")) : {};
        this.pendingTopicPosts = savedTopicPosts(saved["pendingPosts"]);
        this.focusTopicDraft = this.topicDrafts[this.selectedTopicId] ?? "";
      } catch { this.topicDrafts = {}; this.topicScrolls = {}; this.pendingTopicPosts = {}; }
      window.clearTimeout(this.workstreamWatchTimer);
      this.workstreamWatchSequence = undefined;
      this.workstreamWatchDelay = 2_000;
      ++this.workstreamLoadSequence;
    }
    if (previous.status?.isStreaming === true && this.app.status?.isStreaming === false && this.app.selectedSession) {
      void this.loadTopics();
    }
    if (this.app.status?.isStreaming === true && this.app.selectedSession && this.topicRefreshTimer === undefined) this.scheduleTopicRefresh();
    this.notifications.syncEnvironment(previous, this.app);
    this.desktopNotifications.sync(previous, this.app);
  }

  private async load(route: ParsedAppRoute): Promise<void> {
    const sequence = ++this.loadSequence;
    const selectedWorkspace = this.app.selectedWorkspace;
    const retainSelection = completeChatRoute(route)
      && route.sessionId === this.app.selectedSession?.id
      && route.projectId === this.app.selectedProject?.id
      && route.workspaceId === selectedWorkspace?.id
      && (route.machineId ?? "local") === selectedMachineId(this.app);
    if (retainSelection) this.desktopNotifications.suspend();
    this.loading = true;
    if (!retainSelection) this.sessions.clearActiveSession();
    try {
      const machines = await api.machines();
      if (sequence !== this.loadSequence) return;
      const machine = machines.find((candidate) => candidate.id === (route.machineId ?? "local"))
        ?? machines.find((candidate) => candidate.id === "local")
        ?? machines[0];
      const keepSelection = retainSelection && machine?.id === selectedMachineId(this.app);
      if (retainSelection && !keepSelection) this.sessions.clearActiveSession();
      this.setApp(keepSelection
        ? { machines, selectedMachine: machine, error: "" }
        : { ...initialAppState(), machines, selectedMachine: machine });
      this.connectRealtime();
      if (machine === undefined) throw new Error("No PI WEB machine is available.");

      const projects = await api.projects(machine.id);
      if (sequence !== this.loadSequence) return;
      this.setApp({ projects });
      if (!completeChatRoute(route)) {
        if (route.sessionId !== undefined && route.projectId === undefined) { await this.openSessionAnywhere(route.sessionId, machine.id, sequence); return; }
        await this.restoreLastWorkspace(projects, machine.id, sequence);
        return;
      }

      const project = projects.find((candidate) => candidate.id === route.projectId);
      if (project === undefined) throw new Error("The selected project is no longer available.");
      const workspaces = await api.workspaces(project.id, machine.id);
      if (sequence !== this.loadSequence) return;
      const workspace = workspaces.find((candidate) => candidate.id === route.workspaceId);
      if (workspace === undefined) throw new Error("The selected workspace is no longer available.");
      const sessions = await api.sessions(workspace.path, machine.id);
      if (sequence !== this.loadSequence) return;
      const session = sessions.find((candidate) => candidate.id === route.sessionId) ?? await this.unlistedSession(route.sessionId, workspace.path, machine.id);
      if (session === undefined) throw new Error("The selected session is no longer available.");
      this.setApp({ selectedProject: project, workspaces, selectedWorkspace: workspace, sessions });
      await this.sessions.selectSession(session, { updateUrl: false });
    } catch (error) {
      if (sequence === this.loadSequence) {
        if (retainSelection) this.sessions.clearActiveSession();
        this.setApp({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (sequence === this.loadSequence) this.loading = false;
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
    await this.chooseProject(rootProjectOf(project, projects).id);
    if (workspaceId !== undefined && this.app.workspaces.some((candidate) => candidate.id === workspaceId) && this.app.selectedWorkspace?.id !== workspaceId) await this.chooseWorkspace(workspaceId);
  }

  /** Reopen a Chat that belongs to no project: find its folder by id, then treat that folder as an ad-hoc workspace. */
  private async openSessionAnywhere(sessionId: string, machineId: string, sequence: number): Promise<void> {
    const { cwd } = await api.locate(sessionId, machineId).catch(() => ({ cwd: undefined }));
    if (sequence !== this.loadSequence) return;
    const workspace = cwd === undefined ? undefined : adHocWorkspace(cwd);
    const sessions = workspace === undefined ? [] : await api.sessions(workspace.path, machineId).catch((): SessionInfo[] => []);
    const session = sessions.find((candidate) => candidate.id === sessionId) ?? (workspace === undefined ? undefined : await this.unlistedSession(sessionId, workspace.path, machineId));
    if (sequence !== this.loadSequence) return;
    if (workspace === undefined || session === undefined) throw new Error("The selected session is no longer available.");
    this.setApp({ selectedProject: undefined, workspaces: [workspace], selectedWorkspace: workspace, sessions });
    await this.sessions.selectSession(session, { updateUrl: false });
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
    this.realtime.connect((event) => { this.handleRealtimeEvent(event); }, undefined, machineId);
  }

  private handleRealtimeEvent(event: BrowserRealtimeEvent): void {
    if (event.type !== "sessions.unread" && event.type !== "notices.updated" && event.type !== "machine.status") this.sessions.applyGlobalEvent(event);
  }

  private async chooseMachine(machineId: string): Promise<void> {
    const machine = this.app.machines.find((candidate) => candidate.id === machineId);
    if (machine === undefined || machine.id === this.app.selectedMachine?.id) return;
    const sequence = ++this.loadSequence;
    this.loading = true;
    this.sessions.clearActiveSession();
    this.setApp({ ...initialAppState(), machines: this.app.machines, selectedMachine: machine });
    this.connectRealtime();
    try {
      const projects = await api.projects(machine.id);
      if (sequence === this.loadSequence) this.setApp({ projects });
    } catch (error) {
      if (sequence === this.loadSequence) this.setApp({ error: String(error) });
    } finally {
      if (sequence === this.loadSequence) this.loading = false;
    }
  }

  private async chooseProject(projectId: string): Promise<void> {
    const project = this.app.projects.find((candidate) => candidate.id === projectId);
    const sequence = ++this.loadSequence;
    this.sessions.clearActiveSession();
    this.setApp({ selectedProject: project, selectedWorkspace: undefined, workspaces: [], sessions: [], error: "" });
    if (project === undefined) return;
    this.loading = true;
    try {
      const machineId = selectedMachineId(this.app);
      const workspaces = (await Promise.all(subprojectsOf(project, this.app.projects).map((member) => api.workspaces(member.id, machineId)))).flat();
      if (sequence !== this.loadSequence) return;
      this.setApp({ workspaces });
      const preferred = workspaces.find((candidate) => candidate.projectId === project.id && candidate.isMain) ?? workspaces[0];
      if (preferred !== undefined) await this.chooseWorkspace(preferred.id);
    } catch (error) {
      if (sequence === this.loadSequence) this.setApp({ error: String(error) });
    } finally {
      if (sequence === this.loadSequence) this.loading = false;
    }
  }

  private async chooseWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.app.workspaces.find((candidate) => candidate.id === workspaceId);
    const sequence = ++this.loadSequence;
    this.sessions.clearActiveSession();
    const owner = this.app.projects.find((candidate) => candidate.id === workspace?.projectId) ?? this.app.selectedProject;
    this.setApp({ selectedProject: owner, selectedWorkspace: workspace, sessions: [], error: "" });
    if (workspace === undefined) return;
    this.loading = true;
    try {
      const sessions = await api.sessions(workspace.path, selectedMachineId(this.app));
      if (sequence === this.loadSequence) { this.setApp({ sessions }); this.rememberWorkspace(); }
    } catch (error) {
      if (sequence === this.loadSequence) this.setApp({ error: String(error) });
    } finally {
      if (sequence === this.loadSequence) this.loading = false;
    }
  }

  private async openSession(session: SessionInfo): Promise<void> {
    await this.sessions.selectSession(session);
    await this.updateComplete;
    this.promptEditor?.focusInput();
  }

  private async openAllSession(session: SessionInfo): Promise<void> {
    this.setApp({ error: "" });
    try {
      const registered = await this.registeredWorkspaceForCwd(session.cwd, selectedMachineId(this.app));
      const workspace = registered?.workspace ?? adHocWorkspace(session.cwd);
      this.setApp({ selectedProject: registered?.project, selectedWorkspace: workspace, workspaces: registered?.workspaces ?? [workspace], sessions: [session] });
      await this.openSession(session);
    } catch (error) {
      this.setApp({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A Git worktree may be a sibling of its registered project's root, not a descendant. */
  private async registeredWorkspaceForCwd(cwd: string, machineId: string): Promise<{ project: Project; workspace: Workspace; workspaces: Workspace[] } | undefined> {
    for (const project of [...this.app.projects].sort((a, b) => b.path.length - a.path.length)) {
      const workspaces = await api.workspaces(project.id, machineId).catch((): Workspace[] => []);
      const workspace = workspaces.find((candidate) => candidate.path === cwd);
      if (workspace !== undefined) return { project, workspace, workspaces };
    }
    return undefined;
  }

  /** Open the session that wrote a Workstream's newest checkpoint, wherever it lives. */
  private async openWorkstreamSession(detail: OpenWorkstreamSessionDetail): Promise<void> {
    const machineId = selectedMachineId(this.app);
    this.setApp({ error: "" });
    try {
      const { cwd } = await api.locate(detail.sessionId, machineId);
      const [session, registered] = await Promise.all([
        this.unlistedSession(detail.sessionId, cwd, machineId),
        this.registeredWorkspaceForCwd(cwd, machineId),
      ]);
      if (session === undefined) throw new Error(`Session ${detail.sessionId} is unavailable under ${cwd}.`);
      const workspace = registered?.workspace ?? adHocWorkspace(cwd);
      this.setApp({ selectedProject: registered?.project, selectedWorkspace: workspace, workspaces: registered?.workspaces ?? [workspace], sessions: [session] });
      await this.openSession(session);
    } catch (error) {
      this.setApp({ error: `${error instanceof Error ? error.message : String(error)} Start a new session with the checkpoint prompt instead.` });
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
      const candidates = await Promise.all(this.app.projects.map(async (project) => ({
        project,
        workspaces: await api.workspaces(project.id, machineId).catch((): Workspace[] => []),
      })));
      match = candidates.find(({ workspaces }) => workspaces.some((workspace) => workspace.path === cwd));
    } catch (error) {
      this.setApp({ error: `Could not find a working directory for this Workstream: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    const workspace = match?.workspaces.find((candidate) => candidate.path === cwd) ?? adHocWorkspace(cwd);
    const workstreamContext = this.workstreamServiceContext;
    if (workstreamContext === undefined) {
      this.setApp({ error: "Choose a registered workspace before starting this Workstream." });
      return;
    }
    const associationKey = `pi-web:${globalThis.crypto.randomUUID()}`;
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

    this.updateUrl();
    await this.preloadWorkstreamPrompt(detail.prompt, machineId, session.id);
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
      this.setApp({ error: `Chat ${session.id} was created, but PI WEB could not record its Workstream confirmation. ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private get workstreamServiceContext(): WorkstreamServiceContext | undefined {
    const projectId = this.app.selectedProject?.id;
    const workspaceId = this.app.selectedWorkspace?.id;
    return projectId === undefined || workspaceId === undefined
      ? undefined
      : { machineId: selectedMachineId(this.app), projectId, workspaceId };
  }

  private async loadCurrentWorkstream(reset = true): Promise<void> {
    const sessionId = this.app.selectedSession?.id;
    const sequence = ++this.workstreamLoadSequence;
    window.clearTimeout(this.workstreamWatchTimer);
    if (reset) {
      this.currentWorkstream = undefined;
      this.currentWorkstreamError = "";
    }
    const context = this.workstreamServiceContext;
    if (sessionId === undefined || context === undefined) { this.currentWorkstream = null; return; }
    try {
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
      }
    } catch (error) {
      if (sequence === this.workstreamLoadSequence && this.app.selectedSession?.id === sessionId) {
        this.currentWorkstream = null;
        this.currentWorkstreamError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (sequence === this.workstreamLoadSequence && this.isConnected) this.scheduleWorkstreamWatch(context, sessionId);
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
            this.workstreamWatchDelay = 2_000;
            await this.loadCurrentWorkstream(false);
            return;
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

  private async preloadWorkstreamPrompt(prompt: string, machineId: string, sessionId: string): Promise<void> {
    await this.updateComplete;
    const editor = this.promptEditor;
    if (editor === undefined) return;
    await editor.updateComplete;
    if (selectedMachineId(this.app) !== machineId || this.app.selectedSession?.id !== sessionId || editor.sessionId !== sessionId) return;
    editor.replaceText(prompt);
    editor.focusInput();
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

  /** Start one Chat in any folder without registering a project. */
  private async startChatInFolder(): Promise<void> {
    const picker = nativeDirectoryPicker(selectedMachineId(this.app));
    if (picker === undefined) { this.setApp({ error: "Choosing a folder needs the macOS app; add the folder as a project instead." }); return; }
    const path = await picker.pickDirectory().catch(() => null);
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
      this.setApp({ error: `Failed to choose project folder: ${error instanceof Error ? error.message : String(error)}` });
    }
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
    if ((attachments === undefined || attachments.length === 0) && streamingBehavior === undefined && this.auth.handleSlashCommand(text)) return Promise.resolve(true);
    return this.sessions.send(text, streamingBehavior, attachments, delivery, folder);
  };

  private async openModelDialog(): Promise<void> {
    const session = this.app.selectedSession;
    if (session === undefined) return;
    const [models, catalog] = await Promise.all([this.sessions.listModels(), this.sessions.listModelCatalog()]);
    const current = this.app.status?.model;
    this.setApp({
      modelDialog: {
        instanceId: ++this.modelDialogInstanceId,
        origin: { machineId: selectedMachineId(this.app), sessionId: session.id, cwd: session.cwd },
        title: "Select Model",
        ...(current?.provider !== undefined && current.id !== undefined ? { selectedValue: `${current.provider}/${current.id}` } : {}),
        options: models.map((model) => ({
          value: `${model.provider ?? ""}/${model.id ?? ""}`,
          label: `${model.id ?? ""}${model.provider === current?.provider && model.id === current?.id ? " ✓ current" : ""}`,
          description: model.provider ?? "",
        })),
        catalog,
      },
    });
  }

  private async pickModel(value: string): Promise<void> {
    this.setApp({ modelDialog: undefined });
    const slash = value.indexOf("/");
    if (slash > 0) await this.sessions.setModel(value.slice(0, slash), value.slice(slash + 1));
  }

  private async openThinkingDialog(): Promise<void> {
    const levels = await this.sessions.listThinkingLevels();
    const current = this.app.status?.thinkingLevel ?? "off";
    this.setApp({ thinkingDialog: { title: "Select Thinking Level", selectedValue: current, options: levels.map((level) => ({ value: level, label: `${level}${level === current ? " ✓ current" : ""}` })) } });
  }

  private async pickThinking(value: string): Promise<void> {
    this.setApp({ thinkingDialog: undefined });
    if (value !== "") await this.sessions.setThinkingLevel(value);
  }

  private async focusChatComposer(): Promise<void> {
    await this.updateComplete;
    this.promptEditor?.focusInput();
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
    return this.app.selectedSession === undefined ? this.renderChooser() : this.renderChat();
  }

  private renderSettingsPanel() {
    return html`
      <workbench-settings-panel
        .themePreference=${this.themePreference}
        .themes=${this.themes.getThemes()}
        .themePairs=${this.themes.getThemePairs()}
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
              <button class="icon-button" title="Chat in a folder…" aria-label="Chat in a folder…" @click=${() => { void this.startChatInFolder(); }}>
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

  private readonly toggleFiles = (): void => {
    if (this.showFiles && this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() === false) return;
    if (this.showFiles) this.finishFilesResize();
    else { this.saveTopicPosition(); this.showFocusTopic = false; }
    this.showFiles = !this.showFiles;
  };

  private renderTopicMessage(message: SessionTopicMessage) {
    return html`<article class=${`topic-message ${message.role}`} data-topic-entry=${message.id}><strong>${message.role === "user" ? "You" : "Orchestrator"}${message.attention === "question" ? " · Question" : message.attention === "update" ? " · Update" : ""}</strong>${message.text ? html`<p>${message.text}</p>` : null}${message.images?.map((image, index) => html`<img class="topic-image" src=${`data:${image.mimeType};base64,${image.data}`} alt=${`Attached image ${String(index + 1)}`}/>` )}</article>`;
  }

  private saveTopicPosition(captureScroll = true): void {
    const history = this.shadowRoot?.querySelector<HTMLElement>(".focus-topic-history");
    if (captureScroll && history && this.selectedTopicId) this.topicScrolls[this.selectedTopicId] = history.scrollTop;
    const session = this.app.selectedSession;
    if (session) sessionStorage.setItem(`pi-web.topics.${selectedMachineId(this.app)}.${session.id}.${session.cwd}`, JSON.stringify({ selected: this.selectedTopicId, drafts: this.topicDrafts, scrolls: this.topicScrolls, pendingPosts: this.pendingTopicPosts }));
  }

  private scheduleTopicRefresh(): void {
    this.topicRefreshTimer = window.setTimeout(() => {
      this.topicRefreshTimer = undefined;
      if (this.app.status?.isStreaming === true) { void this.loadTopics(false, true); this.scheduleTopicRefresh(); }
    }, 2_000);
  }

  private readonly toggleFocusTopic = (): void => {
    if (this.showFocusTopic) { this.saveTopicPosition(); this.showFocusTopic = false; this.showNewTopic = false; return; }
    if (this.showFiles && this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() === false) return;
    if (this.showFiles) { this.finishFilesResize(); this.showFiles = false; }
    this.showFocusTopic = true;
    void this.loadTopics();
  };

  private readonly toggleNewTopic = (): void => {
    this.showNewTopic = !this.showNewTopic;
    if (this.showNewTopic) void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLInputElement>("#new-topic")?.focus());
  };

  private async loadTopics(openIfPopulated = false, pollOnly = false): Promise<void> {
    const session = this.app.selectedSession;
    if (!session) return;
    const machineId = selectedMachineId(this.app);
    const sequence = ++this.focusTopicLoadSequence;
    this.focusTopicLoading = true;
    try {
      const { topics } = await api.topics({ id: session.id, cwd: session.cwd }, machineId);
      if (sequence !== this.focusTopicLoadSequence || this.app.selectedSession?.id !== session.id || selectedMachineId(this.app) !== machineId) return;
      this.topics = topics;
      if (this.selectedTopicId === "") {
        let stored: unknown;
        try { stored = JSON.parse(sessionStorage.getItem(`pi-web.topics.${machineId}.${session.id}.${session.cwd}`) ?? "{}"); }
        catch { stored = {}; }
        if (isTopicStorageRecord(stored)) {
          if (typeof stored["selected"] === "string") this.selectedTopicId = stored["selected"];
          if (isTopicStorageRecord(stored["drafts"])) this.topicDrafts = Object.fromEntries(Object.entries(stored["drafts"]).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
          this.pendingTopicPosts = savedTopicPosts(stored["pendingPosts"]);
          this.focusTopicDraft = this.topicDrafts[this.selectedTopicId] ?? "";
        }
      }
      if (!topics.some((topic) => topic.topicId === this.selectedTopicId)) this.selectedTopicId = topics[0]?.topicId ?? "";
      if (openIfPopulated && topics.length > 0 && !this.showFiles) this.showFocusTopic = true;
      const selected = topics.find((topic) => topic.topicId === this.selectedTopicId);
      if (selected && (!pollOnly || !this.topicSnapshot || this.topicSnapshotVersion !== `${selected.updatedAt}:${selected.attention}`)) await this.loadTopic(this.selectedTopicId);
      else if (!selected) { this.topicSnapshot = undefined; this.topicSnapshotVersion = ""; }
      if (!this.topicImageStorageError) this.focusTopicError = "";
    } catch (error) {
      if (sequence === this.focusTopicLoadSequence) this.focusTopicError = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.app.selectedSession?.id === session.id) this.focusTopicLoading = false;
    }
  }

  private async loadTopic(topicId: string): Promise<void> {
    const session = this.app.selectedSession;
    if (!session) return;
    const machineId = selectedMachineId(this.app);
    const sequence = ++this.focusTopicLoadSequence;
    try {
      const storageKey = `pi-web.topics.${machineId}.${session.id}.${session.cwd}:${topicId}`;
      const [snapshot, storedState] = await Promise.all([
        api.topic({ id: session.id, cwd: session.cwd }, topicId, machineId),
        loadTopicImageState(storageKey).catch(() => undefined),
      ]);
      if (sequence !== this.focusTopicLoadSequence || this.selectedTopicId !== topicId || this.app.selectedSession?.id !== session.id || selectedMachineId(this.app) !== machineId) return;
      this.topicSnapshot = snapshot;
      this.topicSnapshotVersion = `${this.topics.find((topic) => topic.topicId === topicId)?.updatedAt ?? ""}:${snapshot.attention}`;
      if (!storedState) {
        this.topicImageStorageError = true;
        this.focusTopicError = "Saved images could not be read. Do not resend; reload after browser storage recovers.";
        return;
      }
      this.topicImageStorageError = false;
      this.topicImageDrafts = { ...this.topicImageDrafts, [topicId]: storedState.images };
      const pending = storedState.pending ?? this.pendingTopicPosts[topicId];
      if (storedState.pending && this.pendingTopicPosts[topicId]?.requestId !== storedState.pending.requestId) {
        this.recordTopicSend(`pi-web.topics.${machineId}.${session.id}.${session.cwd}`, topicId, storedState.pending);
      }
      if (pending && snapshot.messages.some((message) => message.role === "user" && message.requestId === pending.requestId)) {
        try { if (storedState.pending) await saveTopicImageState(storageKey, { images: [] }); }
        catch {
          this.topicImageStorageError = true;
          this.focusTopicError = "Input recorded, but saved image cleanup failed. Reload after browser storage recovers.";
          this.recordTopicSend(`pi-web.topics.${machineId}.${session.id}.${session.cwd}`, topicId, undefined, pending.text);
          this.topicImageDrafts = { ...this.topicImageDrafts, [topicId]: [] };
          return;
        }
        this.recordTopicSend(`pi-web.topics.${machineId}.${session.id}.${session.cwd}`, topicId, undefined, pending.text);
        this.topicImageDrafts = { ...this.topicImageDrafts, [topicId]: [] };
      }
      this.focusTopicError = "";
      await this.updateComplete;
      if (sequence === this.focusTopicLoadSequence) {
        const history = this.shadowRoot?.querySelector<HTMLElement>(".focus-topic-history");
        if (history) history.scrollTop = this.topicScrolls[topicId] ?? history.scrollHeight;
      }
    } catch (error) {
      if (sequence === this.focusTopicLoadSequence) this.focusTopicError = error instanceof Error ? error.message : String(error);
    }
  }

  private readonly selectTopic = (topicId: string): void => {
    if (topicId === this.selectedTopicId) return;
    this.saveTopicPosition();
    this.selectedTopicId = topicId;
    this.focusTopicDraft = this.topicDrafts[topicId] ?? "";
    this.topicSnapshot = undefined;
    this.topicSnapshotVersion = "";
    this.showFocusTopic = true;
    this.saveTopicPosition(false);
    void this.loadTopic(topicId);
  };

  private readonly openTopicLink = (event: CustomEvent<string>): void => {
    const id = event.detail;
    if (!id) return;
    this.showFocusTopic = true;
    if (this.topics.some((topic) => topic.topicId === id)) { this.selectTopic(id); return; }
    void this.loadTopics().then(() => {
      if (this.topics.some((topic) => topic.topicId === id)) this.selectTopic(id);
      else this.focusTopicError = "Topic unavailable on this session branch";
    });
  };

  private readonly topicKeys = (event: KeyboardEvent): void => {
    const index = this.topics.findIndex((topic) => topic.topicId === this.selectedTopicId);
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? this.topics.length - 1 : -1;
    if (next < 0 && event.key !== "ArrowUp") return;
    if (!this.topics.length) return;
    event.preventDefault();
    const id = this.topics[(next + this.topics.length) % this.topics.length]?.topicId;
    if (id !== undefined) { this.selectTopic(id); void this.updateComplete.then(() => Array.from(this.shadowRoot?.querySelectorAll<HTMLElement>("[data-topic-id]") ?? []).find((tab) => tab.dataset["topicId"] === id)?.focus()); }
  };

  private readonly createTopic = async (event: Event): Promise<void> => {
    event.preventDefault();
    const session = this.app.selectedSession;
    const title = this.newTopicTitle.trim();
    if (!session || !title || this.focusTopicSending) return;
    this.focusTopicSending = true;
    try {
      const topic = await api.createTopic({ id: session.id, cwd: session.cwd }, title, selectedMachineId(this.app));
      if (this.app.selectedSession?.id !== session.id) return;
      this.newTopicTitle = "";
      this.showNewTopic = false;
      await this.loadTopics();
      this.selectTopic(topic.topicId);
    } catch (error) { this.focusTopicError = error instanceof Error ? error.message : String(error); }
    finally { this.focusTopicSending = false; }
  };

  private recordTopicSend(storageKey: string, id: string, pending?: PendingTopicPost, clearText?: string): void {
    let saved: unknown;
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}"); } catch { saved = {}; }
    const record = isTopicStorageRecord(saved) ? saved : {};
    const pendingPosts = Object.fromEntries(Object.entries(savedTopicPosts(record["pendingPosts"])).filter(([key]) => key !== id));
    if (pending) pendingPosts[id] = pending;
    const drafts = isTopicStorageRecord(record["drafts"]) ? { ...record["drafts"] } : {};
    if (clearText !== undefined && typeof drafts[id] === "string" && drafts[id].trim() === clearText) drafts[id] = "";
    sessionStorage.setItem(storageKey, JSON.stringify({ ...record, drafts, pendingPosts }));
    const session = this.app.selectedSession;
    if (!session || storageKey !== `pi-web.topics.${selectedMachineId(this.app)}.${session.id}.${session.cwd}`) return;
    this.pendingTopicPosts = pendingPosts;
    if (clearText !== undefined && this.topicDrafts[id]?.trim() === clearText) {
      this.topicDrafts[id] = "";
      if (this.selectedTopicId === id) this.focusTopicDraft = "";
    }
    this.saveTopicPosition(false);
  }

  private async addTopicImages(files: File[]): Promise<void> {
    const session = this.app.selectedSession;
    const topicId = this.selectedTopicId;
    if (!session || !topicId || this.topicImagesReading || this.focusTopicSending || this.pendingTopicPosts[topicId] || this.topicImageStorageError || session.archived === true || this.app.status?.persisted === false || files.length === 0) return;
    const machineId = selectedMachineId(this.app);
    const key = `pi-web.topics.${machineId}.${session.id}.${session.cwd}:${topicId}`;
    const readSequence = ++this.topicImageReadSequence;
    this.topicImagesReading = true;
    try {
      const stored = await loadTopicImageState(key);
      if (stored.pending) throw new Error("This topic message is still pending. Check the topic history before attaching more images.");
      const current = stored.images;
      if (current.length + files.length > MAX_TOPIC_IMAGES) throw new Error(`Attach up to ${String(MAX_TOPIC_IMAGES)} images per message.`);
      const nextReference = Math.max(0, ...current.map((image) => Number(/^\[PIC_(\d+)\]$/.exec(image.reference)?.[1] ?? 0))) + 1;
      const additions = await Promise.all(files.map(async (file, index): Promise<PromptImageAttachment> => {
        if (!isSupportedImageMimeType(file.type)) throw new Error("Only PNG, JPEG, GIF and WebP images can be sent to a topic.");
        if (file.size > MAX_TOPIC_IMAGE_BYTES) throw new Error("An image is too large (8 MiB maximum).");
        const data = await readFileAsBase64(file);
        if (base64ByteLength(data) > MAX_TOPIC_IMAGE_BYTES) throw new Error("An image is too large (8 MiB maximum).");
        return { kind: "image", reference: `[PIC_${String(nextReference + index)}]`, mimeType: file.type, data, name: file.name };
      }));
      if (readSequence !== this.topicImageReadSequence) return;
      const images = [...current, ...additions];
      await saveTopicImageState(key, { images });
      if (readSequence === this.topicImageReadSequence) {
        this.topicImageDrafts = { ...this.topicImageDrafts, [topicId]: images };
        this.focusTopicError = "";
      }
    } catch (error) { if (readSequence === this.topicImageReadSequence) this.focusTopicError = error instanceof Error ? error.message : String(error); }
    finally { if (readSequence === this.topicImageReadSequence) this.topicImagesReading = false; }
  }

  private async removeTopicImage(reference: string): Promise<void> {
    const session = this.app.selectedSession;
    const topicId = this.selectedTopicId;
    if (!session || !topicId || this.topicImagesReading || this.focusTopicSending || this.pendingTopicPosts[topicId] || this.topicImageStorageError) return;
    const readSequence = ++this.topicImageReadSequence;
    this.topicImagesReading = true;
    try {
      const key = `pi-web.topics.${selectedMachineId(this.app)}.${session.id}.${session.cwd}:${topicId}`;
      const stored = await loadTopicImageState(key);
      if (stored.pending) throw new Error("This topic message is still pending.");
      const images = stored.images.filter((image) => image.reference !== reference);
      await saveTopicImageState(key, { images });
      if (readSequence === this.topicImageReadSequence) this.topicImageDrafts = { ...this.topicImageDrafts, [topicId]: images };
    } catch (error) { if (readSequence === this.topicImageReadSequence) this.focusTopicError = error instanceof Error ? error.message : String(error); }
    finally { if (readSequence === this.topicImageReadSequence) this.topicImagesReading = false; }
  }

  private readonly pasteTopicImages = (event: ClipboardEvent): void => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    if (this.pendingTopicPosts[this.selectedTopicId]) return;
    void this.addTopicImages(files);
  };

  private readonly chooseTopicImages = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const files = Array.from(input.files ?? []);
    input.value = "";
    void this.addTopicImages(files);
  };

  private async sendTopic(text: string): Promise<void> {
    const session = this.app.selectedSession;
    const topicId = this.selectedTopicId;
    text = text.trim();
    if (!session || !topicId || this.focusTopicSending || this.topicImagesReading || this.topicImageStorageError || session.archived === true || this.app.status?.persisted === false) return;
    const machineId = selectedMachineId(this.app);
    const storageKey = `pi-web.topics.${machineId}.${session.id}.${session.cwd}`;
    const imageKey = `${storageKey}:${topicId}`;
    let images = this.topicImageDrafts[topicId] ?? [];
    let prior = this.pendingTopicPosts[topicId];
    if (!text && images.length === 0 && !prior) return;
    this.focusTopicSending = true;
    this.focusTopicError = "";
    let submitted = false;
    let requestId = prior?.requestId ?? crypto.randomUUID();
    try {
      if (images.length > 0 || (prior?.imageCount ?? 0) > 0) {
        const stored = await loadTopicImageState(imageKey);
        prior = stored.pending ?? prior;
        images = stored.images;
        if (prior?.status === "conflict" || prior?.status === "invalid") throw new Error("This request cannot be retried. Check the topic history, then discard the local draft.");
        if (prior && (prior.text !== text || (prior.imageCount ?? 0) !== images.length)) throw new Error("Original image draft unavailable or message changed. Check the topic history, then discard the local draft.");
        requestId = prior?.requestId ?? requestId;
      }
      if (!text && images.length === 0) return;
      const pending: PendingTopicPost = { requestId, text, status: "sending", ...(images.length ? { imageCount: images.length } : {}) };
      if (images.length > 0) await saveTopicImageState(imageKey, { images, pending });
      this.recordTopicSend(storageKey, topicId, pending);
      submitted = true;
      const receipt = await api.postTopic({ id: session.id, cwd: session.cwd }, topicId, text, machineId, requestId, images);
      if (receipt.status === "queued") {
        const queued = { ...pending, status: "queued" as const };
        if (images.length > 0) await saveTopicImageState(imageKey, { images, pending: queued });
        this.recordTopicSend(storageKey, topicId, queued);
      } else {
        let cleanupFailed = false;
        if (images.length > 0) {
          try { await saveTopicImageState(imageKey, { images: [] }); }
          catch { cleanupFailed = true; }
          if (this.app.selectedSession?.id === session.id) this.topicImageDrafts = { ...this.topicImageDrafts, [topicId]: [] };
        }
        this.recordTopicSend(storageKey, topicId, undefined, text);
        if (cleanupFailed) this.focusTopicError = "Input recorded, but saved image cleanup failed. Reload after browser storage recovers.";
      }
      if (this.app.selectedSession?.id === session.id && selectedMachineId(this.app) === machineId) await this.loadTopics();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (submitted) {
        const status = message === "Topic request id already used for different content" ? "conflict" : message.startsWith("Image conversion failed") ? "invalid" : "unknown";
        const pending: PendingTopicPost = { requestId, text, status, ...(images.length ? { imageCount: images.length } : {}) };
        if (images.length > 0) await saveTopicImageState(imageKey, { images, pending }).catch(() => undefined);
        this.recordTopicSend(storageKey, topicId, pending);
      }
      if (this.app.selectedSession?.id === session.id) this.focusTopicError = `${message}. ${submitted ? "Delivery not confirmed; check the topic history before retrying." : "Nothing was sent; restore browser storage or the original draft."}`;
    } finally { this.focusTopicSending = false; }
  }

  private async discardTopicSend(): Promise<void> {
    const session = this.app.selectedSession;
    const topicId = this.selectedTopicId;
    const pending = this.pendingTopicPosts[topicId];
    if (!session || !topicId || !pending || this.focusTopicSending || this.app.status?.isStreaming === true || (this.app.status?.pendingMessageCount ?? 0) > 0) return;
    const storageKey = `pi-web.topics.${selectedMachineId(this.app)}.${session.id}.${session.cwd}`;
    try {
      await saveTopicImageState(`${storageKey}:${topicId}`, { images: [] });
      this.topicImageDrafts = { ...this.topicImageDrafts, [topicId]: [] };
      this.recordTopicSend(storageKey, topicId, undefined, pending.text);
      this.focusTopicError = "";
    } catch (error) { this.focusTopicError = error instanceof Error ? error.message : String(error); }
  }

  private readonly postFocusTopic = (event: Event): void => { event.preventDefault(); void this.sendTopic(this.focusTopicDraft); };

  private readonly ackTopic = async (): Promise<void> => {
    const session = this.app.selectedSession;
    const topicId = this.selectedTopicId;
    if (!session || !topicId || this.focusTopicSending) return;
    this.focusTopicSending = true;
    try {
      this.topicSnapshot = await api.ackTopic({ id: session.id, cwd: session.cwd }, topicId, selectedMachineId(this.app));
      await this.loadTopics();
    } catch (error) { this.focusTopicError = error instanceof Error ? error.message : String(error); }
    finally { this.focusTopicSending = false; }
  };

  private readonly openWorkspaceFile = (event: CustomEvent<WorkspaceFileOpenRequest>): void => {
    const workspace = this.app.selectedWorkspace;
    const request = event.detail;
    if (event.defaultPrevented || workspace?.projectId === undefined || workspace.projectId === ""
      || request.machineId !== selectedMachineId(this.app) || request.projectId !== workspace.projectId
      || request.workspaceId !== workspace.id || request.root !== workspace.path) return;
    event.preventDefault();
    this.showFiles = true;
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.openFile(request.path));
  };

  private renderChat() {
    const state = this.app;
    const session = state.selectedSession;
    if (session === undefined) return null;
    const warningCount = state.status?.warnings?.length ?? 0;
    return html`
      <main class="chat-shell" data-view="chat" data-machine=${selectedMachineId(state)} data-project=${state.selectedProject?.id ?? ""} data-workspace=${state.selectedWorkspace?.id ?? ""} data-session=${session.id}>
        <header>
          <button class="back" type="button" aria-label="Back" title="Back" @click=${() => { if (this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() !== false) { this.showFiles = false; this.sessions.deselectSession(); } }}>←</button>
          <workstream-context-drawer .snapshot=${this.currentWorkstream} .error=${this.currentWorkstreamError} .fallbackTitle=${sessionTitle(session)} .serviceContext=${this.workstreamServiceContext} .sessionId=${session.id} @workstream-updated=${(event: CustomEvent<WorkstreamSnapshot>) => { this.currentWorkstream = event.detail; }}></workstream-context-drawer>
          <span title=${state.selectedWorkspace?.path ?? ""}>${state.selectedProject?.name !== undefined && state.selectedProject.name !== "" ? `${state.selectedProject.name} · ` : ""}${state.selectedWorkspace?.label}</span>
          <button type="button" class="topic-toggle" title="Open topic conversations with this same agent" aria-label="Topics" aria-expanded=${this.showFocusTopic} aria-controls="focus-topic" @click=${this.toggleFocusTopic}>${this.topics.some((topic) => topic.attention === "question" || topic.attention === "update" || topic.attention === "unanswered") ? "● " : ""}Topics · ${this.topics.filter((topic) => topic.attention === "question" || topic.attention === "update" || topic.attention === "unanswered").length}<span class="topic-count-detail"> need you</span></button>
          <button type="button" class="icon-button files-toggle" title="Files" aria-label="Files" aria-expanded=${this.showFiles} aria-controls="workbench-files" @click=${this.toggleFiles}>${renderBuiltinTabIcon("files")}</button>
          <button class="icon-button" type="button" title="Session tree" aria-label="Session tree" @click=${() => { void this.sessions.runCommand("/tree"); }}><span aria-hidden="true">⎇</span></button>
          ${this.renderSettingsPanel()}
          ${this.renderDesktopNotificationButton()}
        </header>
        ${this.renderDesktopNotificationDiagnostic()}
        ${state.error === "" ? null : html`<div class="chat-error" role="alert">${state.error}</div>`}
        <div class=${`chat-and-files${this.showFocusTopic ? " topic-open" : ""}`} style=${`--files-width: ${String(this.filesWidth)}px`}>
          <div class="chat-column">
        ${this.showFocusTopic ? html`<div class="conversation-heading"><span>Orchestrator · same session</span></div>` : null}
        <chat-view
          @workspace-file-open=${this.openWorkspaceFile}
          @open-topic=${this.openTopicLink}
          .workspaceContext=${markdownWorkspaceContext(selectedMachineId(state), state.selectedWorkspace, session)}
          .sessionId=${session.id}
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
        ></chat-view>
        <delegate-roster .status=${state.status} .collapsed=${this.delegateRosterCollapsed} .onToggleCollapsed=${() => { this.delegateRosterCollapsed = !this.delegateRosterCollapsed; }}></delegate-roster>
        <goal-status-chip .status=${state.status}></goal-status-chip>
        <prompt-editor
          id="orchestrator-editor"
          .sessionId=${session.id}
          .cwd=${state.selectedWorkspace?.path}
          .machineId=${selectedMachineId(state)}
          .projectId=${state.selectedProject?.id}
          .workspaceId=${state.selectedWorkspace?.id}
          .disabled=${session.archived === true}
          .canSteer=${state.status?.isStreaming === true}
          .isCompacting=${state.status?.isCompacting === true}
          .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0}
          .status=${state.status}
          .showUsage=${true}
          .warningCount=${warningCount}
          .availableThinkingLevels=${state.availableThinkingLevels}
          .sending=${state.sendingPrompts[session.id] === true}
          .onSend=${this.handleSend}
          .onStop=${() => { void this.sessions.stopActiveWork(); }}
          .onSelectModel=${() => { void this.openModelDialog(); }}
          .onSelectThinking=${() => { void this.openThinkingDialog(); }}
          .onRunCommand=${(command: string) => this.sessions.runCommand(command)}
        ></prompt-editor>
          </div>
          ${this.showFocusTopic ? html`
            <section id="focus-topic" class="focus-topic" aria-label="Topic conversations">
              <header class="focus-topic-heading"><strong>Topics</strong><span>Same orchestrator · one session</span><button type="button" class="topic-create-toggle" title="New topic" aria-label="Create topic" aria-expanded=${this.showNewTopic} aria-controls="topic-create-form" @click=${this.toggleNewTopic}>+</button><button type="button" title="Refresh topics" aria-label="Refresh topics" @click=${() => { void this.loadTopics(); }}>↻</button><button type="button" aria-label="Stop current work" ?disabled=${!(state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0)} @click=${() => { void this.sessions.stopActiveWork(); }}>Stop</button><button type="button" aria-label="Close topics" @click=${this.toggleFocusTopic}>Close</button></header>
              ${this.focusTopicError === "" ? null : html`<p class="topic-error" role="alert">${this.focusTopicError}</p>`}
              ${this.showNewTopic ? html`<form id="topic-create-form" class="topic-create" @submit=${this.createTopic}><label for="new-topic">New topic</label><input id="new-topic" .value=${this.newTopicTitle} @input=${(event: Event) => { this.newTopicTitle = event.target instanceof HTMLInputElement ? event.target.value : ""; }} placeholder="Topic title"/><button type="submit" ?disabled=${!this.newTopicTitle.trim() || this.focusTopicSending || state.status?.persisted === false || state.status?.isStreaming === true || state.status?.isCompacting === true}>Create</button></form>` : null}
              ${this.showNewTopic && (state.status?.isStreaming === true || state.status?.isCompacting === true) ? html`<p class="topic-notice">New topics wait for the current turn.</p>` : null}
              ${state.status?.persisted === false ? html`<p class="topic-notice">Send an orchestrator message first to save this Chat before creating topics.</p>` : null}
              <div class="topics-inner">
                <nav class="topic-rail" role="tablist" aria-label="Session topics" aria-orientation="vertical" @keydown=${this.topicKeys}>
                  ${this.topics.map((topic) => html`<button type="button" role="tab" data-topic-id=${topic.topicId} aria-selected=${topic.topicId === this.selectedTopicId} aria-controls="topic-panel" tabindex=${topic.topicId === this.selectedTopicId ? "0" : "-1"} @click=${() => { this.selectTopic(topic.topicId); }}><span class="topic-name">${topic.title}<span class=${`topic-mark ${topic.attention}`} aria-label=${topic.attention === "question" ? "Question for you" : topic.attention === "update" ? "Update for you" : topic.attention === "unanswered" ? "No reply recorded" : topic.attention === "working" ? "Agent working" : "No attention needed"}>${topic.attention === "question" ? "?" : topic.attention === "update" ? "i" : topic.attention === "unanswered" ? "!" : topic.attention === "working" ? "⋯" : "✓"}</span></span><small>${topic.preview}${this.topicDrafts[topic.topicId] !== undefined && this.topicDrafts[topic.topicId] !== "" ? " · draft" : ""}</small></button>`)}
                </nav>
                <div id="topic-panel" class="topic-panel" role="tabpanel" aria-label=${this.topics.find((topic) => topic.topicId === this.selectedTopicId)?.title ?? "Topic"}>
                  ${this.topicSnapshot ? html`
                    <div class="topic-title"><strong>${this.topicSnapshot.title}</strong></div>
                    <div class="focus-topic-history" role="log" aria-label="Topic messages" @scroll=${() => { this.saveTopicPosition(); }}>
                      ${this.topicSnapshot.messages.length === 0 ? html`<p class="topic-notice">No messages yet. Send one below.</p>` : null}
                      ${this.topicSnapshot.messages.length > 1 ? html`<details><summary>Earlier in this topic · ${this.topicSnapshot.messages.length - 1} turns</summary>${this.topicSnapshot.messages.slice(0, -1).map((message) => this.renderTopicMessage(message))}</details>` : null}
                      ${this.topicSnapshot.messages.slice(-1).map((message) => this.renderTopicMessage(message))}
                      ${this.topicSnapshot.attention === "question" && this.topicSnapshot.state !== "pending" ? html`<div class="topic-attention"><strong>Question for you</strong>${this.topicSnapshot.messages.at(-1)?.choices?.map((choice) => html`<button type="button" ?disabled=${this.focusTopicSending || this.pendingTopicPosts[this.selectedTopicId] !== undefined} @click=${() => { void this.sendTopic(choice.label); }}>${choice.label}<small>${choice.detail}</small></button>`)}</div>` : null}
                      ${this.topicSnapshot.attention === "update" && this.topicSnapshot.state !== "pending" ? html`<div class="topic-attention"><strong>Update · no answer needed</strong><button type="button" ?disabled=${this.focusTopicSending || state.status?.isStreaming === true || state.status?.isCompacting === true} @click=${this.ackTopic}>Acknowledge</button></div>` : null}
                      ${this.pendingTopicPosts[this.selectedTopicId] ? html`<p class="topic-notice" role="status">${this.pendingTopicPosts[this.selectedTopicId]?.status === "queued" && (state.status?.isStreaming === true || (state.status?.pendingMessageCount ?? 0) > 0) ? "Queued for the agent’s next turn—not recorded yet." : this.pendingTopicPosts[this.selectedTopicId]?.status === "conflict" || this.pendingTopicPosts[this.selectedTopicId]?.status === "invalid" ? "This request cannot be retried." : "Delivery not confirmed. Check the topic history before retrying or discarding the local draft."}${(this.pendingTopicPosts[this.selectedTopicId]?.imageCount ?? 0) > (this.topicImageDrafts[this.selectedTopicId]?.length ?? 0) ? " Original image draft missing; retry is disabled." : ""} <button type="button" ?disabled=${this.focusTopicSending || this.topicImagesReading || this.topicImageStorageError || state.status?.isStreaming === true || state.status?.isCompacting === true || this.pendingTopicPosts[this.selectedTopicId]?.status === "conflict" || this.pendingTopicPosts[this.selectedTopicId]?.status === "invalid" || (this.pendingTopicPosts[this.selectedTopicId]?.imageCount ?? 0) !== (this.topicImageDrafts[this.selectedTopicId]?.length ?? 0)} @click=${() => { void this.sendTopic(this.pendingTopicPosts[this.selectedTopicId]?.text ?? ""); }}>Retry same message</button><button type="button" ?disabled=${this.focusTopicSending || this.topicImagesReading || this.topicImageStorageError || state.status?.isStreaming === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0} @click=${() => { void this.discardTopicSend(); }}>Discard local draft</button></p>` : null}
                      ${this.topicSnapshot.attention === "working" ? html`<p class="topic-notice">The orchestrator is working; no answer needed.</p>` : null}
                      ${this.topicSnapshot.state === "unanswered" ? html`<p class="topic-notice">No topic reply recorded. Refresh, or check the orchestrator conversation.</p>` : null}
                      ${this.topicSnapshot.state === "pending" ? html`<p class="topic-notice">Waiting for the agent to process this topic.</p>` : null}
                    </div>
                    <form class="focus-topic-compose" @submit=${this.postFocusTopic} @paste=${this.pasteTopicImages}>
                      <label for="focus-topic-input">${this.topicSnapshot.attention === "question" && this.topicSnapshot.state !== "pending" ? "Answer in your own words" : `Message about ${this.topicSnapshot.title}`}</label>
                      <textarea id="focus-topic-input" .value=${this.focusTopicDraft} @input=${(event: Event) => { this.focusTopicDraft = event.target instanceof HTMLTextAreaElement ? event.target.value : ""; this.topicDrafts[this.selectedTopicId] = this.focusTopicDraft; this.saveTopicPosition(); }} ?disabled=${session.archived === true || this.focusTopicSending} rows="3"></textarea>
                      ${(this.topicImageDrafts[this.selectedTopicId] ?? []).length ? html`<div class="topic-image-drafts">${this.topicImageDrafts[this.selectedTopicId]?.map((image) => html`<span class="topic-image-draft"><img src=${`data:${image.mimeType};base64,${image.data}`} alt=${`Image ${image.reference}`}/><button type="button" aria-label=${`Remove ${image.reference}`} ?disabled=${this.focusTopicSending || this.topicImagesReading || this.topicImageStorageError || this.pendingTopicPosts[this.selectedTopicId] !== undefined} @click=${() => { void this.removeTopicImage(image.reference); }}>×</button></span>`)}</div>` : null}
                      <div class="topic-compose-actions"><input id="topic-image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden @change=${this.chooseTopicImages}/><button type="button" title="Attach images or paste into the message" aria-label="Attach images" ?disabled=${session.archived === true || state.status?.persisted === false || this.focusTopicSending || this.topicImagesReading || this.topicImageStorageError || this.pendingTopicPosts[this.selectedTopicId] !== undefined} @click=${() => { this.shadowRoot?.querySelector<HTMLInputElement>("#topic-image-input")?.click(); }}>＋ Image</button><button type="submit" ?disabled=${session.archived === true || this.focusTopicSending || this.topicImagesReading || this.topicImageStorageError || this.pendingTopicPosts[this.selectedTopicId] !== undefined || state.status?.isCompacting === true || (!this.focusTopicDraft.trim() && (this.topicImageDrafts[this.selectedTopicId]?.length ?? 0) === 0) || state.status?.persisted === false}>${this.focusTopicSending ? "Sending…" : this.topicSnapshot.attention === "question" && this.topicSnapshot.state !== "pending" ? "Send answer" : "Send to agent"}</button></div>
                    </form>
                  ` : html`<p class="focus-topic-empty">${this.focusTopicLoading ? "Loading topics…" : "Create a topic to start a focused conversation."}</p>`}
                </div>
              </div>
            </section>` : null}
          ${this.showFiles ? html`
            <div class="files-divider" role="separator" tabindex="0" aria-label="Resize Files pane" title="Resize Files pane" aria-orientation="vertical" aria-controls="workbench-files" aria-valuemin="240" aria-valuemax=${String(this.filesConstraints().maxWidth)} aria-valuenow=${String(this.visibleFilesWidth())}
              @pointerdown=${(event: PointerEvent) => { this.startFilesResize(event); }} @pointermove=${(event: PointerEvent) => { this.moveFilesResize(event); }} @pointerup=${(event: PointerEvent) => { this.finishFilesResize(event); }} @pointercancel=${(event: PointerEvent) => { this.finishFilesResize(event); }} @keydown=${(event: KeyboardEvent) => { this.resizeFilesWithKeyboard(event); }}></div>
            <workbench-files-pane id="workbench-files" .workspace=${state.selectedWorkspace} .machineId=${selectedMachineId(state)}></workbench-files-pane>` : null}
        </div>
        ${state.commandDialog === undefined ? null : html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => { void this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value); }} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>`}
        ${state.modelDialog === undefined ? null : html`<command-picker .title=${state.modelDialog.title} .searchable=${true} .options=${state.modelDialog.options} .selectedValue=${state.modelDialog.selectedValue} .onPick=${(value: string) => { void this.pickModel(value); }} .onCancel=${() => { this.setApp({ modelDialog: undefined }); }}></command-picker>`}
        ${state.thinkingDialog === undefined ? null : html`<command-picker .title=${state.thinkingDialog.title} .options=${state.thinkingDialog.options} .selectedValue=${state.thinkingDialog.selectedValue} .onPick=${(value: string) => { void this.pickThinking(value); }} .onCancel=${() => { this.setApp({ thinkingDialog: undefined }); }}></command-picker>`}
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
    :host { --pi-app-safe-area-bottom: 0px; --pi-workbench-viewport-height: calc(100dvh / var(--pi-interface-scale, 1)); --pi-workbench-viewport-width: calc(100dvw / var(--pi-interface-scale, 1)); position: fixed; top: 0; right: 0; left: 0; display: block; height: var(--pi-workbench-viewport-height); box-sizing: border-box; overflow: hidden; padding: env(safe-area-inset-top) env(safe-area-inset-right) var(--pi-app-safe-area-bottom) env(safe-area-inset-left); background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui, sans-serif; }
    @media (display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui) {
      :host { --pi-app-safe-area-bottom: env(safe-area-inset-bottom); }
    }
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
    header .notification-button { flex: 0 0 auto; }
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
    header { position: relative; z-index: 6; flex: 0 0 auto; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
    .back { flex: 0 0 auto; min-height: 32px; padding: 4px 10px; text-align: center; }
    header workstream-context-drawer { flex: 1 1 auto; }
    header span { flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--pi-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .chat-error { flex: 0 0 auto; padding: 8px 12px; border-bottom: 1px solid var(--pi-border); }
    .chat-and-files { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; }
    .chat-column { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
    .conversation-heading { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--pi-border-muted); font-size: 12px; font-weight: 700; }
    .conversation-heading span { flex: 1 1 auto; min-width: 0; }
    .mobile-compose-toggle { display: none; }
    .topic-toggle { flex: 0 0 auto; min-height: 32px; padding: 4px 9px; font-size: 12px; }
    .topic-toggle[aria-expanded="true"] { border-color: var(--pi-accent); color: var(--pi-accent); }
    .focus-topic { display: flex; flex: 0 0 44%; min-width: 300px; min-height: 0; flex-direction: column; border-left: 1px solid var(--pi-border); background: var(--pi-bg); }
    .focus-topic-heading { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .focus-topic-heading span { flex: 1 1 auto; min-width: 0; }
    .focus-topic-heading button { flex: 0 0 auto; }
    .topics-inner { display: flex; flex: 1 1 auto; min-height: 0; }
    .topic-rail { flex: 0 0 35%; min-width: 110px; overflow: auto; border-right: 1px solid var(--pi-border); }
    .topic-rail button { display: block; width: 100%; text-align: left; padding: 9px; background: transparent; border: 0; color: var(--pi-text); cursor: pointer; }
    .topic-rail button[aria-selected="true"] { background: var(--pi-surface); border-left: 3px solid var(--pi-accent); }
    .topic-rail small, .topic-title small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); }
    .topic-name { display: flex; justify-content: space-between; gap: 4px; }
    .topic-mark { padding: 1px 5px; border-radius: 9px; background: var(--pi-surface); }
    .topic-mark.question, .topic-mark.update, .topic-mark.unanswered { color: var(--pi-accent); }
    .topic-panel { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
    .topic-title, .topic-create { padding: 8px; border-bottom: 1px solid var(--pi-border); }
    .topic-create { display: flex; align-items: center; gap: 6px; }
    .topic-create-toggle { min-width: 32px; font-size: 20px; line-height: 1; }
    .topic-create input { flex: 1; min-width: 0; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); font: inherit; }
    .topic-attention { padding: 9px; border-left: 3px solid var(--pi-accent); }
    .topic-attention button { display: block; margin: 6px 0; text-align: left; }
    .topic-attention small { display: block; }
    .focus-topic-history details { width: 100%; }
    .focus-topic-history summary { cursor: pointer; }
    .focus-topic-history { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; align-items: start; gap: 12px; }
    .focus-topic-empty, .topic-notice { color: var(--pi-muted); font-size: 13px; }
    .topic-message { max-width: 88%; padding: 10px 12px; border: 1px solid var(--pi-border-muted); border-radius: 9px; overflow-wrap: anywhere; }
    .topic-message.user { align-self: end; background: var(--pi-surface); }
    .topic-message strong { font-size: 11px; color: var(--pi-muted); }
    .topic-message p { margin-top: 6px; white-space: pre-wrap; color: var(--pi-text); }
    .topic-image { display: block; max-width: 100%; max-height: 240px; margin-top: 8px; border-radius: 6px; object-fit: contain; }
    .topic-image-drafts { display: flex; flex-wrap: wrap; gap: 8px; }
    .topic-image-draft { display: inline-flex; align-items: start; gap: 3px; }
    .topic-image-draft img { width: 56px; height: 56px; border-radius: 5px; object-fit: cover; }
    .topic-compose-actions { display: flex; justify-content: space-between; gap: 8px; }
    .topic-compose-actions button { justify-self: auto; }
    .topic-error { padding: 8px 12px; color: var(--pi-danger); }
    .focus-topic-compose { flex: 0 0 auto; display: grid; gap: 6px; padding: 12px; border-top: 1px solid var(--pi-border-muted); }
    .focus-topic-compose label { text-transform: none; }
    .focus-topic-compose textarea { box-sizing: border-box; width: 100%; resize: vertical; padding: 8px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); font: inherit; }
    .focus-topic-compose button { justify-self: end; }
    chat-view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
    delegate-roster, prompt-editor { flex: 0 0 auto; }
    .files-toggle { flex: 0 0 auto; }
    .files-toggle[aria-expanded="true"] { border-color: var(--pi-accent); }
    .files-divider { position: relative; z-index: 2; flex: 0 0 8px; background: var(--pi-border-muted); cursor: col-resize; touch-action: none; }
    .files-divider::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: var(--pi-border); }
    .files-divider:hover::after, .files-divider:focus-visible::after { background: var(--pi-accent); }
    .files-divider:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    workbench-files-pane { flex: 0 0 min(var(--files-width), max(240px, calc(100% - 328px))); box-sizing: border-box; }
    @media (max-width: 760px) {
      .chat-and-files { flex-direction: column; position: relative; }
      .chat-and-files.topic-open .chat-column { display: none; }
      .chat-and-files.topic-open .focus-topic { position: absolute; inset: 0; z-index: 4; background: var(--pi-bg); }
      .focus-topic { flex: 1 1 auto; min-width: 0; width: 100%; border-left: 0; border-top: 1px solid var(--pi-border); }
      .files-divider { display: none; }
      workbench-files-pane { flex: 0 1 48%; width: 100%; border-top: 1px solid var(--pi-border); }
    }
    @media (max-width: 600px) {
      .topic-count-detail { display: none; }
      .chooser, .chooser > section { grid-template-columns: minmax(0, 1fr); }
      .chooser { padding: 16px; }
      .chooser > section { padding: 16px; }
      .new-chat label { min-width: 0; }
      .new-chat select { min-width: 0; max-width: 100%; }
      header span { display: none; }
    }
    @media (max-width: 600px), (pointer: coarse) {
      .link { min-height: max(44px, var(--pi-control-min-size)); }
    }
  `;
}

function completeChatRoute(route: ParsedAppRoute): route is ParsedAppRoute & { projectId: string; workspaceId: string; sessionId: string } {
  return route.projectId !== undefined && route.workspaceId !== undefined && route.sessionId !== undefined;
}

function isWorkbenchAgentSession(session: SessionInfo): boolean {
  return /^workbench-(?:coordinator|implementer|planner|reviewer|scout)-[0-9a-f]{8}$/u.test(session.name ?? "");
}
