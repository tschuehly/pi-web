import { LitElement, css, html } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { api, type AskUserSubmission, type ExtensionDialogAnswer, type Project, type PromptAttachment, type SessionInfo, type Workspace } from "../api";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { initialAppState, type AppState } from "../appState";
import { AuthController } from "../controllers/authController";
import { SessionController } from "../controllers/sessionController";
import { SessionNotificationController } from "../controllers/sessionNotificationController";
import { selectedMachineId } from "../controllers/types";
import { machineSessionKey } from "../machineKeys";
import { readRoute, writeRoute, type ParsedAppRoute } from "../route";
import { selectedNotificationView } from "../sessionNotifications";
import { RealtimeSocket, type BrowserRealtimeEvent } from "../sessionSocket";
import type { ChatView } from "./ChatView";
import type { PromptEditor } from "./PromptEditor";
import "./AuthDialog";
import "./ChatView";
import "./CommandPicker";
import "./ProjectDialog";
import "./PromptEditor";
import "./StatusBar";
import "./WorkstreamChooser";
import type { OpenWorkstreamSessionDetail } from "./WorkstreamChooser";

@customElement("pi-workbench-app")
export class WorkbenchApp extends LitElement {
  @state() private app: AppState = initialAppState();
  @state() private loading = true;
  @state() private showAgentSessions = false;
  @state() private chooserTab: "workstreams" | "sessions" = "workstreams";
  @query("chat-view") private chatView?: ChatView;
  @query("prompt-editor") private promptEditor?: PromptEditor;
  private readonly realtime = new RealtimeSocket();
  private loadSequence = 0;
  private modelDialogInstanceId = 0;

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
      replacePromptEditorText: async ({ machineId, sessionId, text }) => {
        await this.updateComplete;
        if (selectedMachineId(this.app) === machineId && this.app.selectedSession?.id === sessionId) this.promptEditor?.replaceText(text);
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
  }

  private async load(route: ParsedAppRoute): Promise<void> {
    const sequence = ++this.loadSequence;
    this.loading = true;
    this.sessions.clearActiveSession();
    try {
      const machines = await api.machines();
      if (sequence !== this.loadSequence) return;
      const machine = machines.find((candidate) => candidate.id === (route.machineId ?? "local"))
        ?? machines.find((candidate) => candidate.id === "local")
        ?? machines[0];
      this.setApp({ ...initialAppState(), machines, selectedMachine: machine });
      this.connectRealtime();
      if (machine === undefined) throw new Error("No PI WEB machine is available.");

      const projects = await api.projects(machine.id);
      if (sequence !== this.loadSequence) return;
      this.setApp({ projects });
      if (!completeChatRoute(route)) { await this.restoreLastWorkspace(projects, machine.id, sequence); return; }

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
      if (sequence === this.loadSequence) this.setApp({ error: error instanceof Error ? error.message : String(error) });
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
    let saved: unknown;
    try {
      const raw = localStorage.getItem(WorkbenchApp.LAST_WORKSPACE_KEY);
      saved = raw === null ? undefined : JSON.parse(raw);
    } catch { saved = undefined; }
    if (typeof saved !== "object" || saved === null || !("machineId" in saved) || !("projectId" in saved) || !("workspaceId" in saved)) return;
    const { machineId: savedMachine, projectId, workspaceId } = saved;
    if (savedMachine !== machineId || typeof projectId !== "string" || typeof workspaceId !== "string") return;
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) return;
    const workspaces = await api.workspaces(project.id, machineId).catch((): Workspace[] => []);
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (sequence !== this.loadSequence || workspace === undefined) return;
    const sessions = await api.sessions(workspace.path, machineId).catch((): SessionInfo[] => []);
    if (sequence !== this.loadSequence) return;
    this.setApp({ selectedProject: project, workspaces, selectedWorkspace: workspace, sessions });
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
      const workspaces = await api.workspaces(project.id, selectedMachineId(this.app));
      if (sequence === this.loadSequence) this.setApp({ workspaces });
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
    this.setApp({ selectedWorkspace: workspace, sessions: [], error: "" });
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

  /** Open the session that wrote a Workstream's newest checkpoint, wherever it lives. */
  private async openWorkstreamSession(detail: OpenWorkstreamSessionDetail): Promise<void> {
    const machineId = selectedMachineId(this.app);
    this.setApp({ error: "" });
    try {
      const { cwd } = await api.locate(detail.sessionId, machineId);
      const sessions = await api.sessions(cwd, machineId);
      const session = sessions.find((entry) => entry.id === detail.sessionId);
      if (session === undefined) throw new Error(`Session ${detail.sessionId} is not listed under ${cwd}.`);
      const project = this.app.projects.find((candidate) => cwd === candidate.path || cwd.startsWith(`${candidate.path}/`));
      const workspaces = project === undefined ? [] : await api.workspaces(project.id, machineId).catch((): Workspace[] => []);
      const workspace = workspaces.find((candidate) => candidate.path === cwd);
      this.setApp({ selectedProject: project, selectedWorkspace: workspace, workspaces, sessions });
      await this.openSession(session);
    } catch (error) {
      this.setApp({ error: `${error instanceof Error ? error.message : String(error)} Choose its workspace below and start a new Chat with the copied prompt.` });
    }
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
      projectId: project?.id,
      workspaceId: workspace?.id,
      sessionId: session?.id,
      tool: undefined,
      view: session === undefined ? undefined : "chat",
    }, options);
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

  protected override updated(): void {
    if (this.app.selectedSession !== undefined) return;
    const project = this.shadowRoot?.querySelector<HTMLSelectElement>('select[aria-label="Project"]');
    const workspace = this.shadowRoot?.querySelector<HTMLSelectElement>('select[aria-label="Workspace"]');
    if (project !== undefined && project !== null) project.value = this.app.selectedProject?.id ?? "";
    if (workspace !== undefined && workspace !== null) workspace.value = this.app.selectedWorkspace?.id ?? "";
  }

  private renderChooser() {
    const agentSessionCount = this.app.sessions.filter(isWorkbenchAgentSession).length;
    const visibleSessions = this.showAgentSessions ? this.app.sessions : this.app.sessions.filter((session) => !isWorkbenchAgentSession(session));
    return html`
      <main class="chooser" data-view="chooser">
        <section>
          <div class="workspace-row">
            ${this.app.machines.length > 1 ? html`
              <label>Machine
                <select aria-label="Machine" .value=${selectedMachineId(this.app)} @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) void this.chooseMachine(event.target.value); }}>
                  ${this.app.machines.map((machine) => html`<option value=${machine.id}>${machine.name}</option>`)}
                </select>
              </label>
            ` : null}
            <label>Project
              <select aria-label="Project" @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) void this.chooseProject(event.target.value); }}>
                <option value="">Choose a project…</option>
                ${this.app.projects.map((project) => html`<option value=${project.id}>${project.name}</option>`)}
              </select>
            </label>
            <label>Workspace
              <select aria-label="Workspace" ?disabled=${this.app.selectedProject === undefined} @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) void this.chooseWorkspace(event.target.value); }}>
                <option value="">Choose a workspace…</option>
                ${this.app.workspaces.map((workspace) => html`<option value=${workspace.id}>${workspace.label}${workspace.isMain ? " · main" : ""}</option>`)}
              </select>
            </label>
            <button class="primary" ?disabled=${this.app.selectedWorkspace === undefined || this.app.startingSessionCount > 0} @click=${() => { void this.startSession(); }}>New Chat</button>
            <button class="secondary" @click=${() => { this.setApp({ projectDialogOpen: true }); }}>Add project…</button>
          </div>
          <div class="tabs" role="tablist">
            <button role="tab" aria-selected=${this.chooserTab === "workstreams"} @click=${() => { this.chooserTab = "workstreams"; }}>Workstreams</button>
            <button role="tab" aria-selected=${this.chooserTab === "sessions"} @click=${() => { this.chooserTab = "sessions"; }}>Sessions${this.app.selectedWorkspace === undefined ? "" : ` · ${this.app.selectedWorkspace.branch ?? this.app.selectedWorkspace.label}`}</button>
          </div>
          ${this.chooserTab === "workstreams" ? html`<workstream-chooser @open-workstream-session=${(event: CustomEvent<OpenWorkstreamSessionDetail>) => { void this.openWorkstreamSession(event.detail); }}></workstream-chooser>` : null}
          ${this.loading ? html`<p role="status">Loading…</p>` : null}
          ${this.app.error === "" ? null : html`<p class="error" role="alert">${this.app.error}</p>`}
          ${this.chooserTab !== "sessions" ? null : this.app.selectedWorkspace === undefined ? html`<p>Choose a workspace above to see its sessions.</p>` : html`
            <div class="sessions">
              ${agentSessionCount === 0 ? null : html`
                <label class="agent-filter"><input type="checkbox" aria-label="Show agent sessions" .checked=${this.showAgentSessions} @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.showAgentSessions = event.target.checked; }}> Show agent sessions (${agentSessionCount})</label>
              `}
              ${visibleSessions.map((session) => html`
                <button class="session" @click=${() => { void this.openSession(session); }}>
                  <strong>${sessionTitle(session)}</strong>
                  <small>${session.archived === true ? "Archived · " : ""}${String(session.messageCount)} messages</small>
                </button>
              `)}
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
          .onClearServerQueue=${() => { void this.sessions.clearServerQueue(); }}
          .onDismissWarning=${(dismissId: string) => { void this.sessions.dismissWarning(dismissId); }}
          .onDismissNotification=${(notificationId: string) => { void this.notifications.dismissNotification(notificationId); }}
          .onDismissAllNotifications=${() => { void this.notifications.dismissAll(); }}
          .onLoadMore=${() => { void this.sessions.loadEarlierMessages(); }}
        ></chat-view>
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
    .workspace-row { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; }
    .workspace-row label { flex: 1 1 160px; }
    .workspace-row .secondary { justify-self: auto; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--pi-border); }
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
    prompt-editor, status-bar { flex: 0 0 auto; }
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
