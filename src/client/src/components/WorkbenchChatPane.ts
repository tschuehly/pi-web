import { LitElement, html, nothing, type PropertyValues } from "lit";
import type { MessageActionAvailabilityContext } from "../../../plugin-api";
import { runWorkbenchDisplayedMessageAction, runWorkbenchMessageAction, workbenchMessageActionContext, WORKBENCH_MESSAGE_ACTIONS } from "../workbenchMessageActions";
import { customElement, property, query, state } from "lit/decorators.js";
import type { AskUserSubmission, ExtensionDialogAnswer, PromptAttachment, QueuedSessionMessage, SessionTreeSummaryChoice } from "../api";
import type { PromptAttachmentDelivery } from "../../../shared/apiTypes";
import type { AppState } from "../appState";
import { DEFAULT_CHAT_BEHAVIORS, type ChatBehaviors } from "../chatBehaviors";
import { latestWorkingModeSelection } from "../chatMessages";
import type { WorkbenchChatSession } from "../controllers/workbenchSessionFocus";
import type { PromptEditorTextReplacement } from "../controllers/sessionController";
import { selectedMachineId } from "../controllers/types";
import { markdownWorkspaceContext } from "../formatting/workspaceLinks";
import { queuedMessageRecallConfirmation, type QueuedMessageActionTarget } from "../queuedMessageActions";
import { machineSessionKey } from "../machineKeys";
import type { DraftStorage } from "../promptDraftStorage";
import type { ChatContentRendering } from "../formatting/contentRendering";
import type { ReplyQuote } from "../replyQuotes";
import { selectedNotificationView } from "../sessionNotifications";
import type { ChatRevealTarget, ChatView } from "./ChatView";
import type { PromptEditor } from "./PromptEditor";
import { focusTopModal } from "./modalLayerRegistry";
import "./AuthDialog";
import "./ChatView";
import "./CommandPicker";
import "./DelegateRoster";
import "./GoalStatusChip";
import "./PromptEditor";
import "./SessionTreeNavigator";
import "./WorkbenchQuestionChips";

/**
 * WebKit's native scroll anchoring moves a tile's reading place whenever a sibling tile shows, hides or re-renders, and a
 * Grid ↔ Tabs switch reflows every tile: Workbench Chats keep the reading place themselves.
 */
const WORKBENCH_CHAT_BEHAVIORS: ChatBehaviors = Object.freeze({ ...DEFAULT_CHAT_BEHAVIORS, holdReadingPlace: true });

/** One mounted Chat in every layout. Focus changes its window tools, never its runtime or DOM. */
@customElement("workbench-chat-pane")
export class WorkbenchChatPane extends LitElement {
  @property({ attribute: false }) runtime: WorkbenchChatSession | undefined;
  @property({ attribute: false }) app: AppState | undefined;
  @property({ attribute: false }) loadError: string | undefined;
  @property({ attribute: false }) draftStorage: DraftStorage | undefined;
  @property({ attribute: false }) contentRendering: ChatContentRendering | undefined;
  @property({ attribute: false }) revealTarget: ChatRevealTarget | undefined;
  @property({ type: Boolean }) dense = false;
  @property({ type: Boolean }) focused = false;
  @state() private rosterCollapsed = true;
  /** A draft-replacing request in flight (go back to a message, or a queue action). One at a time; Recall and go-back lock the composer. */
  @state() private revertPending = false;
  @state() private queuedActionTarget: QueuedMessageActionTarget | undefined;
  @query("chat-view") chatView?: ChatView;
  @query("prompt-editor") promptEditor?: PromptEditor;

  // The shell owns the layout styles and the native host's Chat selector. There is only one Chat layout to style.
  protected override createRenderRoot(): HTMLElement { return this; }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("focused") && this.focused) void this.updateComplete.then(() => {
      // The outgoing pane must hide its modal before the incoming pane chooses the top layer.
      if (this.focused && this.isConnected) focusTopModal(this.ownerDocument);
    });
  }

  async replacePromptEditorText({ machineId, sessionId, text, mode }: PromptEditorTextReplacement): Promise<void> {
    await this.updateComplete;
    const editor = this.promptEditor ?? undefined;
    if (editor === undefined) return;
    await editor.updateComplete;
    if (this.app === undefined || selectedMachineId(this.app) !== machineId || this.app.selectedSession?.id !== sessionId || editor.sessionId !== sessionId) return;
    if (mode === "prepend") editor.prependText(text);
    else editor.replaceText(text);
    // The restored text has landed: typing is safe again while history refreshes.
    this.revertPending = false;
  }

  private get composerLocked(): boolean { return this.revertPending || this.queuedActionTarget?.action === "edit"; }

  private get draft(): string { return this.promptEditor?.view?.state.doc.toString() ?? ""; }

  private isCurrent(runtime: WorkbenchChatSession, machineId: string, sessionId: string): boolean {
    return this.runtime === runtime && this.app !== undefined && selectedMachineId(this.app) === machineId && this.app.selectedSession?.id === sessionId;
  }

  /** Disable the composer now, before the request, so nothing typed meanwhile is overwritten by the restored text. */
  private async lockComposer(): Promise<void> {
    const editor = this.promptEditor;
    if (editor === undefined) return;
    editor.disabled = true;
    await editor.updateComplete;
  }

  // Mirrors PiWebApp's guarded history action: going back to a user message restores its text into the composer.
  private readonly goBack = async (input: MessageActionAvailabilityContext): Promise<void> => {
    const runtime = this.runtime;
    if (runtime === undefined || !this.isCurrent(runtime, input.machine.id, input.session.id)) throw new Error("This message's conversation is no longer available.");
    if (this.revertPending || this.queuedActionTarget !== undefined) throw new Error("Another draft-replacing action is already in progress.");
    if (input.message.role === "user" && this.draft !== "" && !window.confirm("Going back will replace your unsent draft. Continue?")) return;
    this.revertPending = true;
    try {
      await this.lockComposer();
      if (!this.isCurrent(runtime, input.machine.id, input.session.id)) return;
      await runtime.sessions.actOnMessage(input.message.entryId, "back");
    } finally {
      this.revertPending = false;
    }
  };

  // Mirrors PiWebApp's queued-message handler: Recall confirms lost attachments/later entries and the unsent draft.
  private readonly actOnQueuedMessage = async (target: QueuedMessageActionTarget): Promise<void> => {
    const runtime = this.runtime;
    if (runtime === undefined || this.revertPending || this.queuedActionTarget !== undefined || !this.isCurrent(runtime, target.machineId, target.sessionId)) return;
    if (target.action === "edit") {
      const confirmation = queuedMessageRecallConfirmation(target.expectedQueue, target.index);
      if (confirmation !== undefined && !window.confirm(confirmation)) return;
      if (this.draft !== "" && !window.confirm("Recalling will replace your unsent draft. Continue?")) return;
    }
    this.queuedActionTarget = target;
    try {
      if (target.action === "edit") await this.lockComposer();
      if (!this.isCurrent(runtime, target.machineId, target.sessionId)) return;
      await runtime.sessions.mutateQueuedMessage(target.action, target.index, target.expectedQueue);
    } finally {
      if (this.queuedActionTarget === target) this.queuedActionTarget = undefined;
    }
  };

  private readonly toggleRoster = (): void => { this.rosterCollapsed = !this.rosterCollapsed; };

  private readonly replyToSelection = (quote: ReplyQuote): void => {
    this.promptEditor?.insertReplyQuote(quote);
    this.promptEditor?.focusInput();
  };

  override render() {
    const state = this.app;
    const runtime = this.runtime;
    const session = state?.selectedSession;
    if (state === undefined || session === undefined || runtime === undefined) return html`<div class=${this.loadError === undefined ? "chat-loading" : "chat-error"} role=${this.loadError === undefined ? "status" : "alert"}>${this.loadError ?? "Loading Chat…"}</div>`;
    const { sessions, notifications, auth } = runtime;
    const machineId = selectedMachineId(state);
    const send = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachment[], delivery?: PromptAttachmentDelivery, folder?: string): Promise<boolean> => {
      this.dispatchEvent(new Event("workbench-prompt", { bubbles: true, composed: true }));
      if ((attachments === undefined || attachments.length === 0) && streamingBehavior === undefined && auth.handleSlashCommand(text)) return Promise.resolve(true);
      return sessions.send(text, streamingBehavior, attachments, delivery, folder);
    };
    return html`
      <main class="chat-shell" data-view="chat" data-machine=${machineId} data-project=${state.selectedProject?.id ?? ""} data-workspace=${state.selectedWorkspace?.id ?? ""} data-session=${session.id}>
        ${state.error === "" ? nothing : html`<div class="chat-error" role="alert">${state.error}</div>`}
        <div class="chat-column">
          <chat-view
            .dense=${this.dense}
            .behaviors=${WORKBENCH_CHAT_BEHAVIORS}
            .contentRendering=${this.contentRendering}
            .workspaceContext=${markdownWorkspaceContext(machineId, state.selectedWorkspace, session)}
            .sessionId=${session.id}
            .sessionCwd=${session.cwd}
            .machineId=${machineId}
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
            .askDraftSessionId=${machineSessionKey(machineId, session.id)}
            .onSubmitAsk=${(askId: string, submission: AskUserSubmission) => sessions.submitAsk(askId, submission)}
            .onAnswerDialog=${(dialogId: string, value: ExtensionDialogAnswer) => sessions.answerDialog(dialogId, value)}
            .onCancelDialog=${(dialogId: string) => sessions.cancelDialog(dialogId)}
            .onDismissClosedDialog=${(dialogId: string) => { sessions.dismissClosedDialog(dialogId); }}
            .notificationInbox=${selectedNotificationView(state.selectedNotificationInbox)}
            .onPromoteQueuedMessage=${(message: QueuedSessionMessage) => { void sessions.promoteQueuedMessage(message); }}
            .onPromoteAllQueuedMessages=${() => { void sessions.promoteAllQueuedMessages(); }}
            .onClearServerQueue=${() => { void sessions.clearServerQueue(); }}
            .onQueuedMessageAction=${session.archived === true ? undefined : this.actOnQueuedMessage}
            .queuedMessageActionPending=${this.queuedActionTarget !== undefined || this.revertPending}
            .onDismissWarning=${(dismissId: string) => { void sessions.dismissWarning(dismissId); }}
            .onDismissNotification=${(notificationId: string) => { void notifications.dismissNotification(notificationId); }}
            .onDismissAllNotifications=${() => { void notifications.dismissAll(); }}
            .onLoadMore=${() => { void sessions.loadEarlierMessages(); }}
            .messageActions=${WORKBENCH_MESSAGE_ACTIONS}
            .messageActionContext=${workbenchMessageActionContext(state)}
            .onMessageAction=${(input: MessageActionAvailabilityContext, actionId: string) => runWorkbenchMessageAction(this.goBack, input, actionId)}
            .onDisplayedMessageAction=${runWorkbenchDisplayedMessageAction}
            .onReplyToSelection=${session.archived === true ? undefined : this.replyToSelection}
          ></chat-view>
          <delegate-roster ?compact=${this.dense} .status=${state.status} .collapsed=${this.rosterCollapsed} .onToggleCollapsed=${this.toggleRoster}></delegate-roster>
          <goal-status-chip .status=${state.status}></goal-status-chip>
          <workbench-question-chips .workspaceContext=${markdownWorkspaceContext(machineId, state.selectedWorkspace, session)} .asks=${state.pendingAsks} .draftSessionId=${machineSessionKey(machineId, session.id)} .onSubmit=${(askId: string, submission: AskUserSubmission) => sessions.submitAsk(askId, submission)}></workbench-question-chips>
          <prompt-editor
            .draftStorage=${this.draftStorage}
            .dense=${this.dense}
            .activityExpanded=${!this.rosterCollapsed}
            .onToggleActivity=${this.dense ? this.toggleRoster : undefined}
            .sessionId=${session.id}
            .cwd=${state.selectedWorkspace?.path}
            .machineId=${machineId}
            .disabled=${session.archived === true || this.composerLocked}
            .canSteer=${state.status?.isStreaming === true}
            .isCompacting=${state.status?.isCompacting === true}
            .canStop=${state.status?.isStreaming === true || state.status?.isBashRunning === true || state.status?.isCompacting === true || (state.status?.pendingMessageCount ?? 0) > 0}
            .status=${state.status}
            .workingModeTranscriptSelection=${latestWorkingModeSelection(state.messages)}
            .showUsage=${true}
            .warningCount=${state.status?.warnings?.length ?? 0}
            .sending=${state.sendingPrompts[session.id] === true}
            .onSend=${send}
            .onStop=${() => { void sessions.stopActiveWork(); }}
            .thinkingLevels=${state.availableThinkingLevels}
            .loadModels=${() => sessions.listModels()}
            .onSetModel=${(provider: string, modelId: string) => sessions.setModel(provider, modelId)}
            .onSetThinkingLevel=${(level: string) => sessions.setThinkingLevel(level)}
            .onRunCommand=${(command: string) => sessions.runCommand(command)}
          ></prompt-editor>
        </div>
        <div ?hidden=${!this.focused} ?inert=${!this.focused}>
        ${state.commandDialog === undefined ? nothing : html`<command-picker ?inert=${!this.focused} .title=${state.commandDialog.title} .options=${state.commandDialog.options} .onPick=${(value: string) => { void sessions.respondToCommand(state.commandDialog?.requestId ?? "", value); }} .onCancel=${() => { sessions.cancelCommand(); }}></command-picker>`}
        ${state.treeDialog === undefined ? nothing : html`<session-tree-navigator ?inert=${!this.focused}
          .tree=${state.treeDialog}
          .onNavigate=${async (target: string, summary: SessionTreeSummaryChoice) => { const result = await sessions.navigateTree(target, summary); if (!result.cancelled && this.focused) this.promptEditor?.focusInput(); return result; }}
          .onFork=${(entry: string) => sessions.forkFromTree(entry)}
          .onAbort=${() => sessions.abortTreeNavigation()}
          .onCancel=${() => { sessions.closeTreeDialog(); this.promptEditor?.focusInput(); }}
        ></session-tree-navigator>`}
        ${state.authDialog === undefined ? nothing : html`<auth-dialog ?inert=${!this.focused}
          .state=${state.authDialog}
          .onChooseMethod=${(type: "oauth" | "api_key") => { void auth.chooseLoginMethod(type); }}
          .onSelectProvider=${(provider: string, type: "oauth" | "api_key") => { void auth.selectLoginProvider(provider, type); }}
          .onLogoutProvider=${(provider: string) => { void auth.logoutProvider(provider); }}
          .onOAuthInput=${(value: string) => { auth.updateOAuthInput(value); }}
          .onOAuthRespond=${(value?: string) => { void auth.respondOAuth(value); }}
          .onOAuthCancel=${() => { void auth.cancelOAuth(); }}
          .onCancel=${() => { auth.closeDialog(); }}
        ></auth-dialog>`}
        </div>
      </main>
    `;
  }
}
