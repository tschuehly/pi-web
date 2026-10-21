import type { AppState } from "../appState";
import type { SessionInfo } from "../api";
import { AuthController } from "./authController";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import { SessionNotificationController } from "./sessionNotificationController";
import type { UpdateUrl } from "./types";

/** One Chat's runtime. Its controller never changes when the window focuses a different Chat. */
export class WorkbenchChatSession {
  readonly sessions: SessionController;
  readonly notifications: SessionNotificationController;
  readonly auth: AuthController;
  ready = false;
  loading: Promise<void> | undefined;
  private starting = false;
  private disposed = false;
  private snapshot: AppState;
  get state(): AppState { return this.snapshot; }
  get pending(): boolean { return this.loading !== undefined || this.starting || this.sessions.pendingSession(this.state.selectedSession?.id ?? "", undefined, true) !== undefined; }

  constructor(
    state: AppState,
    private readonly changed: (chat: WorkbenchChatSession, patch: Partial<AppState>, previous: AppState) => void,
    dependencies: SessionControllerDependencies,
    updateUrl: UpdateUrl = () => undefined,
  ) {
    this.snapshot = state;
    const get = () => this.state;
    const set = (patch: Partial<AppState>) => { this.patch(patch); };
    this.notifications = new SessionNotificationController(get, set);
    this.sessions = new SessionController(get, set, updateUrl, undefined, {
      ...dependencies,
      notifications: this.notifications,
      onSelectedSessionReady: (selection) => { this.ready = true; dependencies.onSelectedSessionReady?.(selection); },
    });
    this.auth = new AuthController(get, set, (status) => { this.sessions.applySessionStatus(status); });
  }

  async prepare(session: SessionInfo): Promise<void> {
    if (this.ready) return;
    if (this.loading !== undefined) return this.loading;
    this.patch({ selectedSession: session }, false);
    this.loading = this.sessions.selectSession(session, { updateUrl: false }).then(() => { this.ready = true; });
    try { await this.loading; } finally { this.loading = undefined; }
  }

  async start(options?: Parameters<SessionController["startSessionWithOptions"]>[0]): Promise<SessionInfo | undefined> {
    this.starting = true;
    try { return await this.sessions.startSessionWithOptions(options); } finally { this.starting = false; }
  }

  patch(patch: Partial<AppState>, publish = true): void {
    if (this.disposed) return;
    const previous = this.state;
    this.snapshot = { ...previous, ...patch };
    if (this.starting && this.state.selectedSession !== undefined) this.ready = true;
    this.notifications.syncEnvironment(previous, this.state);
    if (publish) this.changed(this, patch, previous);
  }

  dispose(): void {
    this.disposed = true;
    this.sessions.dispose();
    this.notifications.dispose();
    this.auth.dispose();
  }
}

/**
 * The window-wide tools' only session seam: a pointer and a projection, not a session connection.
 * Background updates stay in their Chat. Focusing publishes its existing state without selecting/reloading it.
 */
export class WorkbenchSessionFocus {
  current: WorkbenchChatSession | undefined;

  constructor(private readonly publish: (patch: Partial<AppState>) => void) {}

  focus(chat: WorkbenchChatSession): void {
    this.current = chat;
    // Only the focused Chat and its workspace context project into the shell; machine-wide aggregates stay window-owned.
    const { selectedMachine, selectedProject, selectedWorkspace, selectedSession, projects, workspaces, sessions,
      messages, messagePageStart, messagePageEnd, messagePageTotal, isLoadingEarlierMessages, sendingPrompts,
      clientQueuedSessionMessages, status, activity, pendingAsks, pendingDialogs, closedDialogs, availableThinkingLevels,
      selectedNotificationInbox, commandDialog, treeDialog, authDialog, error } = chat.state;
    this.publish({ selectedMachine, selectedProject, selectedWorkspace, selectedSession, projects, workspaces, sessions,
      messages, messagePageStart, messagePageEnd, messagePageTotal, isLoadingEarlierMessages, sendingPrompts,
      clientQueuedSessionMessages, status, activity, pendingAsks, pendingDialogs, closedDialogs, availableThinkingLevels,
      selectedNotificationInbox, commandDialog, treeDialog, authDialog, error });
  }

  changed(chat: WorkbenchChatSession, patch: Partial<AppState>): void {
    if (this.current === chat) this.publish(patch);
  }

  clear(): void {
    this.current = undefined;
  }
}
