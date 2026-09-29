import { LitElement, css, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { api, type AskUserSubmission, type ExtensionDialogAnswer, type Project, type PromptAttachment, type QueuedSessionMessage, type SessionInfo, type SessionTreeForkResult, type SessionTreeNavigateResult, type SessionTreeSummaryChoice, type Workspace } from "../api";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { adHocFolderWorkspaceId } from "../../../shared/workspaceFiles";
import { initialAppState, type AppState } from "../appState";
import { latestWorkingModeSelection } from "../chatMessages";
import { clampPanelWidth, panelWidthFromDrag, panelWidthFromKeyboard, type PanelResizeConstraints } from "../appShell/panelResizeController";
import { AuthController } from "../controllers/authController";
import { desktopNotifications, DesktopNotificationController } from "../controllers/desktopNotificationController";
import { SessionController } from "../controllers/sessionController";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { selectedMachineId } from "../controllers/types";
import { applyInterfaceScale, DEFAULT_INTERFACE_SCALE, readStoredInterfaceScale, stepInterfaceScale, writeStoredInterfaceScale } from "../interfaceScale";
import { markdownWorkspaceContext, type OutsideFileOpenRequest, type WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { machineSessionKey } from "../machineKeys";
import { nativeDirectoryPicker } from "../nativeHost";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { applyPresentationProfile, builtInPresentationProfile, readStoredPresentationProfile } from "../presentationProfiles";
import { applyCheckpointSessionTitle } from "../workstreamCheckpointTitle";
import { workstreamOrientationDepth } from "../workstreamOrientation";
import { hasRenderedModal } from "./modalLayerRegistry";
import { readRoute, writeRoute, type ParsedAppRoute } from "../route";
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
export const adHocWorkspace = (path: string): Workspace => ({ id: adHocFolderWorkspaceId(path), projectId: "", path, label: path.split("/").filter(Boolean).at(-1) ?? path, isMain: false, effectiveConfig: {} });

/** A project whose path lies inside another registered project belongs to that project's tab. */
export function rootProjectOf(project: Project, projects: readonly Project[]): Project {
  const parent = projects.find((candidate) => candidate.id !== project.id && project.path.startsWith(`${candidate.path}/`));
  return parent === undefined ? project : rootProjectOf(parent, projects);
}
export const rootProjects = (projects: readonly Project[]): Project[] => projects.filter((project) => rootProjectOf(project, projects).id === project.id);
const subprojectsOf = (root: Project, projects: readonly Project[]): Project[] => projects.filter((project) => rootProjectOf(project, projects).id === root.id);

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
  /** A workspace the Files pane shows instead of the Chat's, after a link to a file outside the Chat's folder. */
  @state() private filesTarget: { sessionId: string; workspace: Workspace } | undefined;
  @state() private filesWidth = 400;
  private filesResize: { pointerId: number; startX: number; startWidth: number; handle: HTMLElement } | undefined;
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;
  private readonly realtime = new RealtimeSocket();
  private loadSequence = 0;
  private workstreamLoadSequence = 0;
  private workstreamWatchSequence: number | undefined;
  private workstreamWatchDelay = 2_000;
  private readonly workstreamContexts = new Map<string, WorkstreamServiceContext | undefined>();
  private readonly attemptedCheckpointTitles = new Set<string>();
  private readonly pendingWorkstreamContexts = new Map<string, Promise<WorkstreamServiceContext | undefined>>();
  private orientationPendingSessionId: string | undefined;
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
    () => this.currentWorkstream?.title,
    (machineId, sessionId) => { this.openNotificationChat(machineId, sessionId); },
  );

  private openNotificationChat(machineId: string, sessionId: string): void {
    writeRoute({ machineId, sessionId, projectId: undefined, workspaceId: undefined, tool: undefined, view: undefined });
    void this.load(readRoute());
  }

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
    if (event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "p" && !event.altKey && !event.shiftKey && this.app.selectedSession !== undefined
      && this.app.selectedWorkspace !== undefined
      && !hasRenderedModal(this.ownerDocument)) {
      event.preventDefault();
      this.openFileSearch();
    } else if (event.key === "+" || event.key === "=") { event.preventDefault(); this.stepScale(1); }
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
    if (event.type === "session.attention") {
      this.desktopNotifications.attention(this.app, event, selectedMachineId(this.app));
      return;
    }
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
      this.setApp({ error: `${error instanceof Error ? error.message : String(error)} Start a new session for this Workstream instead.` });
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
    const workstreamContext = await this.resolveWorkstreamServiceContext();
    if (workstreamContext === undefined) {
      this.setApp({ error: this.app.selectedProject === undefined ? "A registered project with a workspace is needed to access Workstreams." : "Choose a registered workspace before starting this Workstream." });
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
    if (this.orientationPendingSessionId === this.app.selectedSession?.id) this.orientationPendingSessionId = undefined;
    if ((attachments === undefined || attachments.length === 0) && streamingBehavior === undefined && this.auth.handleSlashCommand(text)) return Promise.resolve(true);
    return this.sessions.send(text, streamingBehavior, attachments, delivery, folder);
  };

  private readonly loadModels = () => this.sessions.listModels();
  private readonly setModel = (provider: string, modelId: string) => this.sessions.setModel(provider, modelId);
  private readonly setThinkingLevel = (level: string) => this.sessions.setThinkingLevel(level);

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

  private openFileSearch(): void {
    if (this.app.selectedWorkspace === undefined) return;
    this.showFiles = true;
    void this.updateComplete.then(async () => {
      const pane = this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
      if (pane !== null && pane !== undefined) { await pane.updateComplete; await pane.searchFiles(); }
    });
  }

  private readonly toggleFiles = (): void => {
    if (this.showFiles && this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() === false) return;
    if (this.showFiles) { this.finishFilesResize(); this.filesTarget = undefined; }
    this.showFiles = !this.showFiles;
  };

  private filesWorkspace(): Workspace | undefined {
    const target = this.filesTarget;
    return target !== undefined && target.sessionId === this.app.selectedSession?.id ? target.workspace : this.app.selectedWorkspace;
  }

  /** Show `path` in the Files pane, in `workspace` or else the Chat's own workspace. */
  private openInFiles(workspace: Workspace | undefined, path: string): void {
    const current = this.filesWorkspace();
    const next = workspace ?? this.app.selectedWorkspace;
    const switching = current !== undefined && (next?.projectId !== current.projectId || next.id !== current.id);
    if (switching && this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.canClose() === false) return;
    const session = this.app.selectedSession;
    this.filesTarget = workspace === undefined || session === undefined ? undefined : { sessionId: session.id, workspace };
    this.showFiles = true;
    void this.updateComplete.then(async () => {
      const pane = this.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
      if (pane !== null && pane !== undefined) { await pane.updateComplete; await pane.openFile(path); }
    });
  }

  private readonly openWorkspaceFile = (event: CustomEvent<WorkspaceFileOpenRequest>): void => {
    const workspace = this.app.selectedWorkspace;
    const request = event.detail;
    if (event.defaultPrevented || workspace === undefined
      || request.machineId !== selectedMachineId(this.app) || request.projectId !== workspace.projectId
      || request.workspaceId !== workspace.id || request.root !== workspace.path) return;
    event.preventDefault();
    this.openInFiles(undefined, request.path);
  };

  private readonly openOutsideFile = (event: CustomEvent<OutsideFileOpenRequest>): void => {
    const { machineId, path } = event.detail;
    if (event.defaultPrevented || machineId !== selectedMachineId(this.app)) return;
    event.preventDefault();
    void this.workspaceForFile(path, machineId).then(
      (target) => { this.openInFiles(target.workspace, target.path); },
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
          <span title=${state.selectedWorkspace?.path ?? ""}>${state.selectedProject === undefined ? "" : `${state.selectedProject.name} · `}${state.selectedWorkspace?.label}</span>
          <button type="button" class="icon-button files-toggle" title="Files" aria-label="Files" aria-expanded=${this.showFiles} aria-controls="workbench-files" @click=${this.toggleFiles}>${renderBuiltinTabIcon("files")}</button>
          <button type="button" class="header-action" title="Search files (⌘P)" aria-label="Search files" ?disabled=${state.selectedWorkspace === undefined} @click=${() => { this.openFileSearch(); }}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><span>Search files</span></button>
          <button class="icon-button" type="button" title="Session tree" aria-label="Session tree" @click=${() => { void this.sessions.runCommand("/tree"); }}><span aria-hidden="true">⎇</span></button>
          ${this.renderSettingsPanel()}
          ${this.renderDesktopNotificationButton()}
        </header>
        ${this.renderDesktopNotificationDiagnostic()}
        ${state.error === "" ? null : html`<div class="chat-error" role="alert">${state.error}</div>`}
        <div class="chat-and-files" style=${`--files-width: ${String(this.filesWidth)}px`}>
          <div class="chat-column">
        <chat-view
          @workspace-file-open=${this.openWorkspaceFile}
          @outside-file-open=${this.openOutsideFile}
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
          ${this.showFiles ? html`
            <div class="files-divider" role="separator" tabindex="0" aria-label="Resize Files pane" title="Resize Files pane" aria-orientation="vertical" aria-controls="workbench-files" aria-valuemin="240" aria-valuemax=${String(this.filesConstraints().maxWidth)} aria-valuenow=${String(this.visibleFilesWidth())}
              @pointerdown=${(event: PointerEvent) => { this.startFilesResize(event); }} @pointermove=${(event: PointerEvent) => { this.moveFilesResize(event); }} @pointerup=${(event: PointerEvent) => { this.finishFilesResize(event); }} @pointercancel=${(event: PointerEvent) => { this.finishFilesResize(event); }} @keydown=${(event: KeyboardEvent) => { this.resizeFilesWithKeyboard(event); }}></div>
            <workbench-files-pane id="workbench-files" .workspace=${this.filesWorkspace()} .machineId=${selectedMachineId(state)}></workbench-files-pane>` : null}
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
    header { position: relative; z-index: 6; flex: 0 0 auto; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 4px 12px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
    header > button { flex: 0 0 auto; min-height: 32px; border-color: transparent; background: transparent; }
    header > button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    header > .icon-button:hover { border-color: transparent; }
    .back { padding: 4px 10px; text-align: center; }
    .header-action { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; }
    .header-action svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
    header workstream-context-drawer { flex: 1 1 auto; min-width: 0; }
    header span { flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--pi-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    header .header-action span { color: inherit; font-size: inherit; }
    .chat-error { flex: 0 0 auto; padding: 8px 12px; border-bottom: 1px solid var(--pi-border); }
    .chat-and-files { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; overflow: hidden; }
    .chat-column { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
    chat-view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
    delegate-roster, prompt-editor { flex: 0 0 auto; }
    .files-toggle { flex: 0 0 auto; }
    .files-toggle[aria-expanded="true"] { color: var(--pi-accent); background: var(--pi-selection-bg); }
    .files-divider { position: relative; z-index: 2; flex: 0 0 8px; background: var(--pi-border-muted); cursor: col-resize; touch-action: none; }
    .files-divider::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: var(--pi-border); }
    .files-divider:hover::after, .files-divider:focus-visible::after { background: var(--pi-accent); }
    .files-divider:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    workbench-files-pane { flex: 0 0 min(var(--files-width), max(240px, calc(100% - 328px))); box-sizing: border-box; }
    @media (max-width: 760px) {
      .chat-and-files { flex-direction: column; }
      .files-divider { display: none; }
      workbench-files-pane { flex: 0 1 48%; width: 100%; border-top: 1px solid var(--pi-border); }
    }
    @media (max-width: 600px) {
      .chooser, .chooser > section { grid-template-columns: minmax(0, 1fr); }
      .chooser { padding: 16px; }
      .chooser > section { padding: 16px; }
      .new-chat label { min-width: 0; }
      .new-chat select { min-width: 0; max-width: 100%; }
      header { gap: 6px; padding-inline: 8px; }
      header span { display: none; }
      .header-action { width: 34px; padding-inline: 0; justify-content: center; }
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
