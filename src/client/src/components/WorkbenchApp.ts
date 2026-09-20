import { LitElement, css, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { api, type AskUserSubmission, type ExtensionDialogAnswer, type Project, type PromptAttachment, type QueuedSessionMessage, type SessionInfo, type Workspace } from "../api";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { initialAppState, type AppState } from "../appState";
import { AuthController } from "../controllers/authController";
import { browserDesktopNotifications, DesktopNotificationController } from "../controllers/desktopNotificationController";
import { SessionController } from "../controllers/sessionController";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { selectedMachineId } from "../controllers/types";
import { machineSessionKey } from "../machineKeys";
import { nativeDirectoryPicker } from "../nativeHost";
import { readRoute, writeRoute, type ParsedAppRoute } from "../route";
import { selectedNotificationView } from "../sessionNotifications";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import type { ChatView } from "./ChatView";
import type { PromptEditor } from "./PromptEditor";
import "./AllSessions";
import "./AuthDialog";
import "./ChatView";
import "./CommandPicker";
import "./DelegateRoster";
import "./ProjectDialog";
import "./PromptEditor";
import "./StatusBar";
import "./WorkingModeControls";
import "./WorkstreamChooser";
import { appendWorkstream, inspectWorkstream, type OpenWorkstreamSessionDetail, type StartWorkstreamSessionDetail, type WorkstreamAppendRecord, type WorkstreamSessionAnchor } from "./WorkstreamChooser";
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

@customElement("pi-workbench-app")
export class WorkbenchApp extends LitElement {
  @state() private app: AppState = initialAppState();
  @state() private loading = true;
  @state() private showAgentSessions = false;
  @state() private showAllSessions = false;
  @state() private chooserView: "project" | "other" | "all" = "project";
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;
  private readonly realtime = new RealtimeSocket();
  private loadSequence = 0;
  private modelDialogInstanceId = 0;

  private readonly desktopNotifications = new DesktopNotificationController(
    browserDesktopNotifications(),
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
      onSelectedSessionReady: () => { this.desktopNotifications.activate(this.app); },
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

  private readonly onPopState = (): void => { void this.load(readRoute()); };

  override connectedCallback(): void {
    super.connectedCallback();
    this.sessions.resume();
    this.notifications.resume();
    window.addEventListener("popstate", this.onPopState);
    void this.load(readRoute());
  }

  override disconnectedCallback(): void {
    window.removeEventListener("popstate", this.onPopState);
    this.realtime.close();
    this.auth.dispose();
    this.sessions.dispose();
    this.notifications.dispose();
    super.disconnectedCallback();
  }

  private setApp(patch: Partial<AppState>): void {
    const previous = this.app;
    this.app = { ...this.app, ...patch };
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
      const project = this.app.projects
        .filter((candidate) => session.cwd === candidate.path || session.cwd.startsWith(`${candidate.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      const workspaces = project === undefined ? [] : await api.workspaces(project.id, selectedMachineId(this.app)).catch((): Workspace[] => []);
      const registeredWorkspace = workspaces.find((candidate) => candidate.path === session.cwd);
      const workspace = registeredWorkspace ?? adHocWorkspace(session.cwd);
      this.setApp({ selectedProject: registeredWorkspace === undefined ? undefined : project, selectedWorkspace: workspace, workspaces: registeredWorkspace === undefined ? [workspace] : workspaces, sessions: [session] });
      await this.openSession(session);
    } catch (error) {
      this.setApp({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Open the session that wrote a Workstream's newest checkpoint, wherever it lives. */
  private async openWorkstreamSession(detail: OpenWorkstreamSessionDetail): Promise<void> {
    const machineId = selectedMachineId(this.app);
    this.setApp({ error: "" });
    try {
      const { cwd } = await api.locate(detail.sessionId, machineId);
      const project = this.app.projects.find((candidate) => cwd === candidate.path || cwd.startsWith(`${candidate.path}/`));
      const [session, workspaces] = await Promise.all([
        this.unlistedSession(detail.sessionId, cwd, machineId),
        project === undefined ? Promise.resolve([]) : api.workspaces(project.id, machineId).catch((): Workspace[] => []),
      ]);
      if (session === undefined) throw new Error(`Session ${detail.sessionId} is unavailable under ${cwd}.`);
      const workspace = workspaces.find((candidate) => candidate.path === cwd);
      this.setApp({ selectedProject: project, selectedWorkspace: workspace, workspaces, sessions: [session] });
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
      cwd = detail.directories[0] ?? (await api.locate(detail.sessionId, machineId)).cwd;
      const candidates = await Promise.all(this.app.projects.map(async (project) => ({
        project,
        workspaces: await api.workspaces(project.id, machineId).catch((): Workspace[] => []),
      })));
      match = candidates.find(({ workspaces }) => workspaces.some((workspace) => workspace.path === cwd));
    } catch (error) {
      this.setApp({ error: `Could not find a working directory for the previous session: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    const workspace = match?.workspaces.find((candidate) => candidate.path === cwd) ?? adHocWorkspace(cwd);
    const associationKey = `pi-web:${globalThis.crypto.randomUUID()}`;
    const anchor: WorkstreamSessionAnchor = match === undefined ? {} : { machineId, projectId: workspace.projectId, workspaceId: workspace.id };
    try {
      const snapshot = await inspectWorkstream(detail.workstreamId);
      const record: WorkstreamAppendRecord = {
        type: "session.pending",
        producer: "pi-web",
        sourceSessionId: detail.sessionId,
        payload: { associationKey, derivationKind: "checkpoint", ...anchor },
      };
      await appendWorkstream({ workstreamId: detail.workstreamId, expectedRevision: snapshot.revision, idempotencyKey: `${associationKey}:pending`, records: [record] });
    } catch (error) {
      this.setApp({ error: `Could not record the pending Workstream launch, so no Chat was started. ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    this.sessions.clearActiveSession();
    this.setApp({ selectedProject: match?.project, selectedWorkspace: workspace, workspaces: match?.workspaces ?? [workspace], sessions: [], error: "" });
    let session: SessionInfo;
    try {
      await this.sessions.startSession();
      const started = this.app.selectedSession;
      if (started === undefined) throw new Error("PI WEB did not start a Chat.");
      session = started;
    } catch (error) {
      this.setApp({ error: `Chat creation failed after the pending Workstream launch was recorded. ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    this.updateUrl();
    await this.preloadWorkstreamPrompt(detail.prompt, machineId, session.id);
    try {
      const snapshot = await inspectWorkstream(detail.workstreamId);
      const record: WorkstreamAppendRecord = {
        type: "session.confirmed",
        producer: "pi-web",
        sourceSessionId: session.id,
        payload: { sessionId: session.id, associationKey, ...anchor },
      };
      await appendWorkstream({ workstreamId: detail.workstreamId, expectedRevision: snapshot.revision, idempotencyKey: `${associationKey}:confirmed`, records: [record] });
    } catch (error) {
      this.setApp({ error: `Chat ${session.id} was created, but PI WEB could not record its Workstream confirmation. ${error instanceof Error ? error.message : String(error)}` });
    }
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

  private readonly handleSend = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery?: PromptAttachmentDelivery): void => {
    if ((attachments === undefined || attachments.length === 0) && streamingBehavior === undefined && this.auth.handleSlashCommand(text)) return;
    void this.sessions.send(text, streamingBehavior, attachments, delivery);
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

  override render() {
    return this.app.selectedSession === undefined ? this.renderChooser() : this.renderChat();
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
              ${this.renderDesktopNotificationButton()}
              <button class="icon-button" title="Chat in a folder…" aria-label="Chat in a folder…" @click=${() => { void this.startChatInFolder(); }}>
                ${renderBuiltinTabIcon("chat-plus")}
              </button>
              <button class="icon-button" title="Add project…" aria-label="Add project…" @click=${() => { void this.chooseProjectFolder(); }}>
                ${renderBuiltinTabIcon("folder-plus")}
              </button>
            </span>
          </div>
          ${this.chooserView === "all" ? html`<all-sessions @open-session=${(event: CustomEvent<SessionInfo>) => { void this.openAllSession(event.detail); }}></all-sessions>` : this.chooserView === "other" ? html`<workstream-chooser .excludeProjects=${rootProjects(this.app.projects).map((candidate) => candidate.name)} @open-workstream-session=${(event: CustomEvent<OpenWorkstreamSessionDetail>) => { void this.openWorkstreamSession(event.detail); }} @start-workstream-session=${(event: CustomEvent<StartWorkstreamSessionDetail>) => { void this.startWorkstreamSession(event.detail); }}></workstream-chooser>` : project === undefined ? html`<p>Choose a project.</p>` : html`
            <div class="new-chat">
              <button class="primary" ?disabled=${this.app.selectedWorkspace === undefined || this.app.startingSessionCount > 0} @click=${() => { void this.startSession(); }}>New Chat</button>
              <label>in
                <select aria-label="Workspace" @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) void this.chooseWorkspace(event.target.value); }}>
                  ${this.app.workspaces.map((workspace) => html`<option value=${workspace.id}>${this.app.projects.find((candidate) => candidate.id === workspace.projectId)?.name ?? ""} · ${workspace.label}${workspace.isMain ? " (main)" : ""}</option>`)}
                </select>
              </label>
            </div>
            <workstream-chooser .project=${rootProjectOf(project, this.app.projects).name} @open-workstream-session=${(event: CustomEvent<OpenWorkstreamSessionDetail>) => { void this.openWorkstreamSession(event.detail); }} @start-workstream-session=${(event: CustomEvent<StartWorkstreamSessionDetail>) => { void this.startWorkstreamSession(event.detail); }}></workstream-chooser>
          `}
          ${this.loading ? html`<p role="status">Loading…</p>` : null}
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

  private renderChat() {
    const state = this.app;
    const session = state.selectedSession;
    if (session === undefined) return null;
    const warningCount = state.status?.warnings?.length ?? 0;
    return html`
      <main class="chat-shell" data-view="chat" data-machine=${selectedMachineId(state)} data-project=${state.selectedProject?.id ?? ""} data-workspace=${state.selectedWorkspace?.id ?? ""} data-session=${session.id}>
        <header>
          <button class="back" type="button" aria-label="Back" title="Back" @click=${() => { this.sessions.deselectSession(); }}>←</button>
          <strong>${sessionTitle(session)}</strong>
          <span title=${state.selectedWorkspace?.path ?? ""}>${state.selectedProject?.name} · ${state.selectedWorkspace?.label}</span>
          ${this.renderDesktopNotificationButton()}
        </header>
        ${state.error === "" ? null : html`<div class="chat-error" role="alert">${state.error}</div>`}
        <chat-view
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
        ></chat-view>
        <delegate-roster .status=${state.status}></delegate-roster>
        <working-mode-controls .status=${state.status} .onRunCommand=${(command: string) => this.sessions.runCommand(command)}></working-mode-controls>
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
          .warningCount=${warningCount}
          .availableThinkingLevels=${state.availableThinkingLevels}
          .sending=${state.sendingPrompts[session.id] === true}
          .onSend=${this.handleSend}
          .onStop=${() => { void this.sessions.stopActiveWork(); }}
          .onSelectModel=${() => { void this.openModelDialog(); }}
          .onSelectThinking=${() => { void this.openThinkingDialog(); }}
        ></prompt-editor>
        <status-bar .status=${state.status}></status-bar>
        ${state.commandDialog === undefined ? null : html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => { void this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value); }} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>`}
        ${state.modelDialog === undefined ? null : html`<command-picker .title=${state.modelDialog.title} .searchable=${true} .options=${state.modelDialog.options} .selectedValue=${state.modelDialog.selectedValue} .onPick=${(value: string) => { void this.pickModel(value); }} .onCancel=${() => { this.setApp({ modelDialog: undefined }); }}></command-picker>`}
        ${state.thinkingDialog === undefined ? null : html`<command-picker .title=${state.thinkingDialog.title} .options=${state.thinkingDialog.options} .selectedValue=${state.thinkingDialog.selectedValue} .onPick=${(value: string) => { void this.pickThinking(value); }} .onCancel=${() => { this.setApp({ thinkingDialog: undefined }); }}></command-picker>`}
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
    :host { position: fixed; inset: 0; display: block; overflow: hidden; background: var(--pi-bg); color: var(--pi-text); font: 14px system-ui, sans-serif; }
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
    header { flex: 0 0 auto; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
    .back { flex: 0 0 auto; min-height: 32px; padding: 4px 10px; text-align: center; }
    header strong, header span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header strong { flex: 1 1 auto; }
    header span { flex: 0 1 auto; color: var(--pi-muted); font-size: 12px; }
    .chat-error { flex: 0 0 auto; padding: 8px 12px; border-bottom: 1px solid var(--pi-border); }
    chat-view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
    delegate-roster, working-mode-controls, prompt-editor, status-bar { flex: 0 0 auto; }
    @media (max-width: 600px) {
      .chooser { padding: 16px; }
      .chooser > section { padding: 16px; }
      header span { display: none; }
    }
  `;
}

function completeChatRoute(route: ParsedAppRoute): route is ParsedAppRoute & { projectId: string; workspaceId: string; sessionId: string } {
  return route.projectId !== undefined && route.workspaceId !== undefined && route.sessionId !== undefined;
}

function isWorkbenchAgentSession(session: SessionInfo): boolean {
  return /^workbench-(?:coordinator|implementer|planner|reviewer|scout)-[0-9a-f]{8}$/u.test(session.name ?? "");
}

function sessionTitle(session: SessionInfo): string {
  if (session.name !== undefined && session.name !== "") return session.name;
  return session.firstMessage === "" ? session.id : session.firstMessage;
}
