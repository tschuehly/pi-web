import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api, type AskUserSubmission, type ExtensionDialogAnswer, type Machine, type Project, type PromptAttachment, type QueuedSessionMessage, type Workspace } from "../api";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import { initialAppState, type AppState } from "../appState";
import { latestWorkingModeSelection } from "../chatMessages";
import { SessionController, type SessionControllerDependencies } from "../controllers/sessionController";
import { selectedMachineId } from "../controllers/types";
import { markdownWorkspaceContext } from "../formatting/workspaceLinks";
import { machineSessionKey } from "../machineKeys";
import type { DraftStorage } from "../promptDraftStorage";
import type { PluginRegistry } from "../plugins/registry";
import type { BrowserRealtimeEvent } from "../sessionSocket";
import type { WindowChat } from "../workbenchWindows";
import "./ChatView";
import "./CommandPicker";
import "./DelegateRoster";
import "./GoalStatusChip";
import "./PromptEditor";
import "./WorkbenchQuestionChips";

/**
 * A grid tile's Chat beside the focused one, laid out exactly like the focused tile: its transcript, Activity, goal,
 * question chips, composer and status line, driven by its own SessionController. Focusing the tile hands the Chat to the
 * Workbench shell, which renders the same layout, so nothing moves; Files and quotes stay with the focused Chat.
 */
@customElement("workbench-chat-pane")
export class WorkbenchChatPane extends LitElement {
  @property({ attribute: false }) chat: WindowChat | undefined;
  @property({ attribute: false }) draftStorage: DraftStorage | undefined;
  @property({ attribute: false }) claimSession: SessionControllerDependencies["claimSession"];
  /** The pane binds to the machine its Chat lives on, whatever the focused Chat's machine is. */
  @property({ attribute: false }) machines: readonly Machine[] = [];
  /** Where the Chat lives: its recorded workspace, else its folder. */
  @property({ attribute: false }) resolveWorkspace: ((chat: WindowChat) => Promise<{ project: Project | undefined; workspace: Workspace }>) | undefined;
  @property({ attribute: false }) contentRendering: PluginRegistry["chatContentRendering"] | undefined;
  /** The window's one Activity fold state, shared with the focused tile. */
  @property({ type: Boolean }) rosterCollapsed = false;
  @property({ attribute: false }) onToggleRoster: (() => void) | undefined;
  @state() private app: AppState = initialAppState();
  @state() private loadError = "";
  private readonly sessions = new SessionController(() => this.app, (patch) => { this.app = { ...this.app, ...patch }; }, () => undefined, undefined, {
    draftStorage: () => this.draftStorage,
    claimSession: (session, context) => this.claimSession?.(session, { selectedMachine: this.app.selectedMachine, selectedWorkspace: this.app.selectedWorkspace, ...context }) ?? Promise.resolve(true),
  });

  override connectedCallback(): void {
    super.connectedCallback();
    this.sessions.resume();
    void this.load();
  }

  override disconnectedCallback(): void {
    this.sessions.dispose();
    super.disconnectedCallback();
  }

  /** Window-wide status and activity updates from the shell's realtime socket. */
  applyGlobalEvent(event: BrowserRealtimeEvent): void {
    if (event.type !== "session.attention" && event.type !== "sessions.unread" && event.type !== "notices.updated" && event.type !== "machine.status") this.sessions.applyGlobalEvent(event);
  }

  private async load(): Promise<void> {
    const chat = this.chat;
    const resolve = this.resolveWorkspace;
    if (chat === undefined || resolve === undefined) return;
    const machineId = chat.machineId;
    try {
      const machine = this.machines.find((candidate) => candidate.id === machineId);
      if (machine === undefined) throw new Error("This Chat's machine is not available.");
      const target = await resolve(chat);
      const rows = await api.sessions(target.workspace.path, machineId, { sessionId: chat.sessionId });
      const row = rows.find((candidate) => candidate.id === chat.sessionId);
      if (row === undefined) throw new Error("This Chat is no longer available.");
      this.app = { ...this.app, machines: [machine], selectedMachine: machine, selectedProject: target.project, workspaces: [target.workspace], selectedWorkspace: target.workspace, sessions: [row] };
      await this.sessions.selectSession(row, { updateUrl: false });
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  private readonly handleSend = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery?: PromptAttachmentDelivery, folder?: string): Promise<boolean> =>
    this.sessions.send(text, streamingBehavior, attachments, delivery, folder);

  override render() {
    const state = this.app;
    const session = state.selectedSession;
    if (session === undefined) return html`<p class="placeholder" role=${this.loadError === "" ? "status" : "alert"}>${this.loadError === "" ? "Loading…" : this.loadError}</p>`;
    const machineId = selectedMachineId(state);
    return html`
      ${state.error === "" ? nothing : html`<div class="error" role="alert">${state.error}</div>`}
      <chat-view
        dense
        .contentRendering=${this.contentRendering}
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
      <delegate-roster .status=${state.status} .collapsed=${this.rosterCollapsed} .onToggleCollapsed=${this.onToggleRoster}></delegate-roster>
      <goal-status-chip .status=${state.status}></goal-status-chip>
      <workbench-question-chips .asks=${state.pendingAsks} .draftSessionId=${machineSessionKey(machineId, session.id)} .onSubmit=${(askId: string, submission: AskUserSubmission) => this.sessions.submitAsk(askId, submission)}></workbench-question-chips>
      <prompt-editor
        .draftStorage=${this.draftStorage}
        dense
        .sessionId=${session.id}
        .cwd=${state.selectedWorkspace?.path}
        .machineId=${machineId}
        .disabled=${session.archived === true}
        .canSteer=${state.status?.isStreaming === true}
        .isCompacting=${state.status?.isCompacting === true}
        .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0}
        .status=${state.status}
        .workingModeTranscriptSelection=${latestWorkingModeSelection(state.messages)}
        .showUsage=${true}
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
      ${state.commandDialog === undefined ? nothing : html`<command-picker .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => { void this.sessions.respondToCommand(state.commandDialog?.requestId ?? "", value); }} .onCancel=${() => { this.sessions.cancelCommand(); }}></command-picker>`}
    `;
  }

  static override styles = css`
    :host { display: flex; flex-direction: column; min-width: 0; min-height: 0; color: var(--pi-text); font: 14px system-ui, sans-serif; }
    .placeholder { margin: auto; color: var(--pi-muted); }
    .error { flex: 0 0 auto; padding: 4px 10px; background: color-mix(in srgb, var(--pi-danger) 12%, transparent); color: var(--pi-danger); }
    /* Zero basis: the transcript takes what is left, so the question chips and drawer never shrink for it. */
    chat-view { flex: 1 1 0; min-height: 0; overflow: hidden; }
    delegate-roster, prompt-editor { flex: 0 0 auto; }
  `;
}
