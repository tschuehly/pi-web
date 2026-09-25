import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { currentExchangeGroups, groupChatMessages, summarizeChatGroup, type ChatGroup, type ChatGroupPresentation } from "../chatGroups";
import { previewFromDetails } from "../chatMessages";
import { writeClipboardText } from "../clipboard";
import { capturePrependScrollAnchor, PREPEND_RESTORE_SETTLE_FRAMES, restorePrependScrollAnchor, type PrependScrollAnchor } from "../chatScrollAnchoring";
import { shouldRequestEarlierMessages } from "../chatHistoryLoading";
import { ChatScrollController, distanceFromScrollBottom, findFirstVisibleArticle, isNearScrollBottom, type ChatAnchorScrollPosition, type ChatScrollRestoreResult } from "../chatScrollPosition";
import type { AskUserSubmission, PendingAskUser, PendingExtensionDialog, QueuedSessionMessage, SessionActivity, SessionStatus, SessionWarningSeverity } from "../api";
import type { ClosedExtensionDialog } from "../appState";
import {
  notificationAnnouncementLabel,
  notificationDismissLabel,
  notificationFocusTargetAfterDismiss,
  notificationInboxOverflowLabel,
  notificationInboxTotalCount,
  notificationMessageTruncationLabel,
  notificationSeverityLabel,
  notificationTargetKey,
  notificationTrayHeading,
  notificationTrayIsCollapsed,
  setNotificationTrayCollapsed,
  type NotificationFocusTarget,
  type SelectedSessionNotificationView,
  type SessionNotificationTarget,
} from "../sessionNotifications";
import type { ChatLine, ChatPart, GoalLifecycleDetails } from "./shared";
import { chatStyles, renderSessionWarningIcon } from "./shared";
import "./AskUserCard";
import "./ExtensionDialogCard";
import type { ExtensionDialogAnswerCallback, ExtensionDialogCancelCallback, ExtensionDialogDismissCallback } from "./ExtensionDialogCard";
import { registerRenderedModal, type RenderedModalRegistration } from "./modalLayerRegistry";
import "./ConversationMeter";
import "./FormattedText";
import type { MarkdownWorkspaceContext } from "../formatting/workspaceLinks";
import { toolActionLabel } from "./ToolExecutionView";
import { renderBuiltinTabIcon } from "./tabIcons";

const messageTimestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const messageTimeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const goalTransitionLabels: Record<GoalLifecycleDetails["transition"], string> = {
  start: "Goal started", resume: "Goal resumed", pause: "Goal paused", wait: "Goal waiting",
  block: "Goal blocked", usage_limit: "Goal usage limited", budget_limit: "Goal budget limited",
  complete: "Goal completed", clear: "Goal cleared",
};
const notificationTimestampFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

function renderNotificationDisclosureIcon(collapsed: boolean) {
  return html`
    <svg class=${`notification-icon notification-disclosure-icon${collapsed ? "" : " expanded"}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m9 18 6-6-6-6"></path>
    </svg>
  `;
}

function renderNotificationCloseIcon() {
  return html`
    <svg class="notification-icon notification-close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12"></path>
      <path d="M18 6 6 18"></path>
    </svg>
  `;
}

function isSessionNotificationTarget(value: unknown): value is SessionNotificationTarget {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "machineId") === "string"
    && typeof Reflect.get(value, "cwd") === "string"
    && typeof Reflect.get(value, "sessionId") === "string";
}

function clampPercent(value: number): number {
  return clampNumber(value, 0, 100);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

interface PendingNotificationFocus {
  chatKey: string;
  focusTarget: NotificationFocusTarget;
}

export interface QueuedMessageSection {
  source: "client" | "server";
  heading: string;
  detail: string;
  messages: QueuedSessionMessage[];
}

export function chatQueuedMessageSections(clientQueued: QueuedSessionMessage[], serverQueued: QueuedSessionMessage[]): QueuedMessageSection[] {
  return [
    clientQueued.length === 0 ? undefined : { source: "client", heading: "Queued until session starts", detail: "Will send once the backend session is ready", messages: clientQueued },
    serverQueued.length === 0 ? undefined : { source: "server", heading: "Queued messages", detail: `${String(serverQueued.length)} pending`, messages: serverQueued },
  ].filter((section): section is QueuedMessageSection => section !== undefined);
}

export type TranscriptFilter = "everything" | "human" | "assistant" | "human-assistant";

/** Project readable message content while keeping the original indices and entry IDs. */
export function filterChatGroups(groups: ChatGroup[], filter: TranscriptFilter, messages: ChatLine[], messageStart: number): ChatGroup[] {
  if (filter === "everything") return groups;
  const project = (message: ChatLine, index: number): ChatGroup[] => {
    const role = messages[index - messageStart]?.role;
    if (role !== "user" && role !== "assistant") return [];
    if (filter === "human" && role !== "user" || filter === "assistant" && role !== "assistant") return [];
    const parts = message.parts.filter((part) => part.type === "text" || part.type === "image");
    return parts.length === 0 ? [] : [{ kind: "message", message: parts.length === message.parts.length ? message : { ...message, parts }, index }];
  };
  return groups.flatMap((group) => group.kind === "group"
    ? group.messages.flatMap((message, offset) => project(message, group.messageIndices?.[offset] ?? group.startIndex + offset))
    : project(group.message, group.index));
}

export type ChatImagePart = Extract<ChatPart, { type: "image" }>;

/** Derive the `<img>` source URL and alt text for a rendered image part. */
export function chatImagePartSource(part: ChatImagePart): { src: string; alt: string } {
  return { src: `data:${part.mimeType};base64,${part.data}`, alt: "attached image" };
}

/** The message-header label used when a tool message renders as an image output. */
export function chatToolOutputLabel(toolName?: string): string {
  return toolName === undefined || toolName === "" ? "tool output" : `${toolName} output`;
}

/** The stable scroll-anchor/render key for a top-level message at `index`. */
export function chatMessageAnchorKey(index: number): string {
  return `m:${String(index)}`;
}

/** The stable scroll-anchor/render key for an event group starting at `startIndex`. */
export function chatGroupAnchorKey(startIndex: number, presentation?: ChatGroupPresentation | "events", occurrence = 0): string {
  const base = `g:${String(startIndex)}`;
  return presentation === undefined ? base : `${base}:${presentation}:${String(occurrence)}`;
}

/** The stable scroll-anchor key for an event inside a group at `index`. */
export function chatEventAnchorKey(index: number): string {
  return `e:${String(index)}`;
}

/** The stable scroll-marker id emitted before an event group ending at `endIndex`. */
export function chatGroupScrollMarkerId(endIndex: number, presentation?: ChatGroupPresentation | "events", occurrence = 0): string {
  const base = `g:${String(endIndex)}`;
  return presentation === undefined ? base : `${base}:${presentation}:${String(occurrence)}`;
}

/** The unique render key and outer scroll anchor for a split transcript fragment. */
export function chatFragmentAnchorKey(groups: ChatGroup[], index: number): string {
  const group = groups[index];
  if (group === undefined) throw new RangeError("Chat fragment index is out of bounds");
  if (group.kind === "group") {
    const preceding = groups.slice(0, index).filter((candidate) => candidate.kind === "group" && candidate.startIndex === group.startIndex);
    if (preceding.length === 0) return chatGroupAnchorKey(group.startIndex);
    const occurrence = preceding.filter((candidate) => candidate.kind === "group" && candidate.presentation === group.presentation).length;
    return chatGroupAnchorKey(group.startIndex, group.presentation ?? "events", occurrence);
  }
  const occurrence = groups.slice(0, index).filter((candidate) => candidate.kind !== "group" && candidate.index === group.index).length;
  const base = chatMessageAnchorKey(group.index);
  return occurrence === 0 ? base : `${base}:${String(occurrence)}`;
}

/** Whether a queued-message section shows the server clear-queue action. */
export function chatQueuedSectionShowsClearAction(section: QueuedMessageSection, hasClearHandler: boolean): boolean {
  return section.source === "server" && hasClearHandler;
}

/** A rendered session-warning row derived from live status warnings. */
export interface ChatSessionWarningRow {
  severity: SessionWarningSeverity;
  severityClass: string;
  message: string;
  source?: string;
  path?: string;
  dismissId?: string;
}

/** Derive one severity-tagged warning row per live status warning, in order. */
export function chatSessionWarningRows(status: SessionStatus | undefined): ChatSessionWarningRow[] {
  return (status?.warnings ?? []).map((warning) => ({
    severity: warning.severity,
    severityClass: `session-warning ${warning.severity}`,
    message: warning.message,
    ...(warning.source === undefined ? {} : { source: warning.source }),
    ...(warning.path === undefined ? {} : { path: warning.path }),
    ...(warning.dismiss === undefined ? {} : { dismissId: warning.dismiss.id }),
  }));
}

export function chatMessageMetadataLabel(message: ChatLine): string | undefined {
  const timestamp = message.meta?.timestamp;
  return timestamp === undefined ? undefined : formatMessageTimestamp(timestamp);
}

function formatMessageTimestamp(timestamp: string): string | undefined {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  return messageTimestampFormatter.format(date);
}

function formatMessageTime(timestamp: string): string {
  return messageTimeFormatter.format(new Date(timestamp));
}

function formatToolCallArguments(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    const formatted: unknown = JSON.stringify(args, undefined, 2);
    return typeof formatted === "string" ? formatted : String(args);
  } catch {
    return String(args);
  }
}

@customElement("chat-view")
export class ChatView extends LitElement {
  @property({ attribute: false }) messages: ChatLine[] = [];
  @property() sessionId = "";
  @property({ attribute: false }) workspaceContext: MarkdownWorkspaceContext | undefined;
  @property({ attribute: false }) onMessageAction?: (entryId: string, action: "fork" | "back") => Promise<void>;
  @property({ type: Boolean }) messageActionsDisabled = false;
  @state() private messageActionPending = false;
  @state() private messageActionError: { sessionId: string; entryId: string; message: string } | undefined;
  @property({ type: Number }) messageStart = 0;
  @property({ type: Number }) messageEnd = 0;
  @property({ type: Number }) messageTotal = 0;
  @property({ type: Boolean }) hasMore = false;
  @property({ type: Boolean }) loadingMore = false;
  @property({ type: Boolean }) isSendingPrompt = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Number }) pendingMessageCount = 0;
  @property({ attribute: false }) clientQueuedMessages: QueuedSessionMessage[] = [];
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) activity?: SessionActivity;
  @property({ attribute: false }) pendingAsk?: PendingAskUser;
  @property({ attribute: false }) askDraftSessionId = "";
  @property({ attribute: false }) onSubmitAsk?: (askId: string, submission: AskUserSubmission) => void | Promise<void>;
  @property({ attribute: false }) pendingDialogs: PendingExtensionDialog[] = [];
  @property({ attribute: false }) closedDialogs: ClosedExtensionDialog[] = [];
  @property({ attribute: false }) onAnswerDialog?: ExtensionDialogAnswerCallback;
  @property({ attribute: false }) onCancelDialog?: ExtensionDialogCancelCallback;
  @property({ attribute: false }) onDismissClosedDialog?: ExtensionDialogDismissCallback;
  @property({ attribute: false }) notificationInbox?: SelectedSessionNotificationView;
  @property({ attribute: false }) onClearServerQueue?: () => void;
  @property({ attribute: false }) onPromoteQueuedMessage?: (message: QueuedSessionMessage) => void;
  @property({ attribute: false }) onPromoteAllQueuedMessages?: () => void;
  @property({ attribute: false }) onDismissWarning?: (dismissId: string) => void;
  @property({ attribute: false }) onDismissNotification?: (notificationId: string) => void;
  @property({ attribute: false }) onDismissAllNotifications?: () => void;
  @property({ type: Boolean }) warningsVisible = true;
  @property({ attribute: false }) onToggleWarnings?: () => void;
  @property({ attribute: false }) onLoadMore?: () => void;
  @query(".chat") private chat?: HTMLDivElement | null;
  @query("dialog.image-zoom") private imageZoomDialog?: HTMLDialogElement | null;
  @state() private pinnedToBottom = true;
  @state() private transcriptFilter: TranscriptFilter = "everything";
  @state() private filterMenuOpen = false;
  @state() private zoomedImage: { src: string; alt: string } | undefined = undefined;
  @state() private copiedMessageKey: string | undefined;
  @state() private currentConversationIndex: number | undefined;
  @state() private collapsedNotificationTargetKeys: ReadonlySet<string> = new Set();
  @state() private retainedEmptyNotificationTrayTargetKey: string | undefined;
  private pendingNotificationFocus: PendingNotificationFocus | undefined;
  private imageZoomModalRegistration: RenderedModalRegistration | undefined;
  private readonly scrollController = new ChatScrollController();
  private chatResizeObserver: ResizeObserver | undefined;
  private suppressScrollSave = false;
  private suppressLoadMoreRequests = false;
  private loadMoreCheckFrame: number | undefined;
  private scrollToBottomFrame: number | undefined;
  private scrollToOpenAskFrame: number | undefined;
  private scrollToOpenDialogFrame: number | undefined;
  private conversationRailFrame: number | undefined;
  private groupedMessagesInput?: ChatLine[];
  private groupedMessagesStart = 0;
  private groupedMessagesCache: ChatGroup[] = [];
  private readonly messageMetaCache = new WeakMap<ChatLine, string | undefined>();
  private readonly messageCopyTextCache = new WeakMap<ChatLine, string>();
  private lastScrollTop = 0;
  private lastClientHeight = 0;
  private touchStartY: number | undefined;
  private pendingScrollRestoreSessionId: string | undefined;
  private pendingScrollRestorePosition: ChatAnchorScrollPosition | undefined;
  private restoreScrollFrame: number | undefined;
  private prependRestoreToken = 0;
  @state() private loadMoreRequested = false;
  private readonly onViewportResize = () => {
    if (this.pinnedToBottom) this.scrollToBottom();
    else this.lastClientHeight = this.chat?.clientHeight ?? 0;
  };
  private readonly onChatResize = (): void => {
    const chat = this.chat;
    if (!(chat instanceof HTMLElement)) return;
    if (this.pinnedToBottom) {
      this.scrollToBottom();
      return;
    }
    chat.scrollTop = this.lastScrollTop;
    this.lastClientHeight = chat.clientHeight;
  };
  private readonly onImageLoad = (): void => {
    if (this.pinnedToBottom) this.scrollToBottom();
  };
  private readonly openImageZoom = (src: string, alt: string): void => {
    this.zoomedImage = { src, alt };
  };
  private readonly closeImageZoom = (): void => {
    if (this.zoomedImage !== undefined) this.zoomedImage = undefined;
  };
  private readonly onImageZoomDialogClick = (event: MouseEvent): void => {
    if (event.target === this.imageZoomDialog) this.closeImageZoom();
  };
  private readonly onPageHide = () => {
    this.saveScrollPosition();
  };
  private readonly handleClearServerQueue = (): void => {
    this.onClearServerQueue?.();
  };
  private readonly handleToggleWarnings = (): void => {
    this.onToggleWarnings?.();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
    window.addEventListener("pagehide", this.onPageHide);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
    this.observeChatResize();
  }

  protected override firstUpdated(): void {
    this.lastClientHeight = this.chat?.clientHeight ?? 0;
    this.observeChatResize();
  }

  private observeChatResize(): void {
    const chat = this.chat;
    if (this.chatResizeObserver !== undefined || !(chat instanceof Element) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(this.onChatResize);
    observer.observe(chat);
    this.chatResizeObserver = observer;
  }

  override disconnectedCallback(): void {
    this.saveScrollPosition();
    this.scrollController.dispose();
    this.chatResizeObserver?.disconnect();
    this.chatResizeObserver = undefined;
    this.releaseImageZoomModal();
    this.prependRestoreToken += 1;
    if (this.restoreScrollFrame !== undefined) cancelAnimationFrame(this.restoreScrollFrame);
    if (this.loadMoreCheckFrame !== undefined) cancelAnimationFrame(this.loadMoreCheckFrame);
    if (this.scrollToBottomFrame !== undefined) cancelAnimationFrame(this.scrollToBottomFrame);
    if (this.scrollToOpenAskFrame !== undefined) {
      cancelAnimationFrame(this.scrollToOpenAskFrame);
      this.scrollToOpenAskFrame = undefined;
    }
    if (this.scrollToOpenDialogFrame !== undefined) {
      cancelAnimationFrame(this.scrollToOpenDialogFrame);
      this.scrollToOpenDialogFrame = undefined;
    }
    if (this.conversationRailFrame !== undefined) cancelAnimationFrame(this.conversationRailFrame);
    window.removeEventListener("resize", this.onViewportResize);
    window.removeEventListener("pagehide", this.onPageHide);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    super.disconnectedCallback();
  }

  private savePreviousSessionScrollPosition(previousSessionId: unknown): void {
    if (typeof previousSessionId !== "string" || previousSessionId === "" || previousSessionId === this.sessionId) return;
    this.saveScrollPosition(previousSessionId);
  }

  private prepareSessionUiState(): void {
    this.pendingNotificationFocus = undefined;
    this.retainedEmptyNotificationTrayTargetKey = undefined;
    this.scrollController.clearScheduledSave();
    this.suppressScrollSave = false;
    this.suppressLoadMoreRequests = false;
    this.pendingScrollRestoreSessionId = undefined;
    this.pendingScrollRestorePosition = undefined;
    this.prependRestoreToken += 1;
    if (this.restoreScrollFrame !== undefined) {
      cancelAnimationFrame(this.restoreScrollFrame);
      this.restoreScrollFrame = undefined;
    }
    if (this.scrollToOpenAskFrame !== undefined) {
      cancelAnimationFrame(this.scrollToOpenAskFrame);
      this.scrollToOpenAskFrame = undefined;
    }
    if (this.scrollToOpenDialogFrame !== undefined) {
      cancelAnimationFrame(this.scrollToOpenDialogFrame);
      this.scrollToOpenDialogFrame = undefined;
    }
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("sessionId")) {
      this.savePreviousSessionScrollPosition(changed.get("sessionId"));
      this.transcriptFilter = "everything";
      this.filterMenuOpen = false;
      this.prepareSessionUiState();
    } else if (changed.has("notificationInbox") && this.notificationTargetChanged(changed.get("notificationInbox"))) {
      this.pendingNotificationFocus = undefined;
      this.retainedEmptyNotificationTrayTargetKey = undefined;
    }
    if (changed.has("transcriptFilter") && !changed.has("sessionId")) {
      this.pendingScrollRestoreSessionId = undefined;
      this.pendingScrollRestorePosition = undefined;
      if (this.restoreScrollFrame !== undefined) cancelAnimationFrame(this.restoreScrollFrame);
      this.restoreScrollFrame = undefined;
    }
    if (changed.has("messages") || changed.has("pendingAsk") || changed.has("pendingDialogs") || changed.has("closedDialogs")) this.pinnedToBottom = this.pinnedToBottom && (this.didChatHeightChange() || this.isNearBottom());
  }

  protected override update(changed: Map<string, unknown>): void {
    const prependAnchor = this.isPrependingMessages(changed) ? this.capturePrependScrollAnchor() : undefined;
    const filterAnchor = changed.has("transcriptFilter") && !changed.has("sessionId") && !this.pinnedToBottom
      ? this.captureFilterScrollAnchor(filterChatGroups(this.groupedMessages(), this.transcriptFilter, this.messages, this.messageStart)) : undefined;
    super.update(changed);
    if (prependAnchor !== undefined) this.restorePrependScrollAnchor(prependAnchor);
    if (filterAnchor !== undefined) this.restorePrependScrollAnchor(filterAnchor);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("loadingMore") && !this.loadingMore) this.loadMoreRequested = false;
    if (changed.has("hasMore") && !this.hasMore) this.loadMoreRequested = false;
    if (changed.has("sessionId")) this.restoreScrollPosition();
    if (changed.has("transcriptFilter") && !changed.has("sessionId")) {
      if (this.pinnedToBottom) this.scrollToBottom();
      if (this.transcriptFilter === "everything") this.requestLoadMoreIfNeeded();
      this.scheduleConversationRailUpdate();
    }
    const openedAsk = changed.has("pendingAsk") && this.isNewPendingAsk(changed.get("pendingAsk"));
    const openedDialog = changed.has("pendingDialogs") && this.isNewOpenDialog(changed.get("pendingDialogs"));
    // The form uses the transcript scroller. Start a new long form at question
    // one rather than applying the usual live-tail scroll and landing at its end.
    if (!changed.has("sessionId") && openedAsk && this.pinnedToBottom) this.scrollToOpenAsk();
    else if (!changed.has("sessionId") && openedDialog && this.pinnedToBottom) this.scrollToOpenDialog();
    else if (!changed.has("sessionId") && (changed.has("messages") || changed.has("pendingAsk") || changed.has("pendingDialogs") || changed.has("closedDialogs")) && this.pinnedToBottom) this.scrollToBottom();
    if (changed.has("messages") || changed.has("messageStart") || changed.has("messageTotal") || changed.has("hasMore") || changed.has("loadingMore")) this.scheduleConversationRailUpdate();
    if (changed.has("messages") || changed.has("messageStart") || changed.has("hasMore") || changed.has("loadingMore") || changed.has("pendingAsk") || changed.has("pendingDialogs") || changed.has("closedDialogs")) this.continuePendingScrollRestore();
    if (changed.has("messages") || changed.has("hasMore") || changed.has("loadingMore")) this.requestLoadMoreIfNeeded();
    if (changed.has("notificationInbox") && this.pendingNotificationFocus !== undefined) this.focusPendingNotificationTarget();
    if (changed.has("zoomedImage")) this.syncImageZoomDialog();
  }

  private syncImageZoomDialog(): void {
    const dialog = this.imageZoomDialog;
    if (!(dialog instanceof HTMLDialogElement)) return;
    if (this.zoomedImage !== undefined) {
      if (this.imageZoomModalRegistration === undefined) {
        const registration = registerRenderedModal({
          element: dialog,
          nativeTopLayer: true,
          focus: () => {
            const close = this.renderRoot.querySelector<HTMLElement>(".image-zoom-close");
            (close ?? dialog).focus();
          },
        });
        this.imageZoomModalRegistration = registration;
        try {
          if (!dialog.open) dialog.showModal();
        } catch (error) {
          this.imageZoomModalRegistration = undefined;
          registration.unregister();
          throw error;
        }
      }
      this.imageZoomModalRegistration.focus();
      return;
    }
    if (dialog.open) dialog.close();
    this.releaseImageZoomModal();
  }

  private releaseImageZoomModal(): void {
    const registration = this.imageZoomModalRegistration;
    this.imageZoomModalRegistration = undefined;
    registration?.unregister();
  }

  private notificationTargetChanged(previous: unknown): boolean {
    const currentInbox = this.notificationInbox;
    if (!isSessionNotificationTarget(previous) || currentInbox === undefined) return previous !== currentInbox;
    return notificationTargetKey(previous) !== notificationTargetKey(currentInbox);
  }

  override render() {
    const groups = filterChatGroups(this.groupedMessages(), this.transcriptFilter, this.messages, this.messageStart);
    const exchange = this.transcriptFilter === "everything"
      ? currentExchangeGroups(this.messages, groups, this.messageStart, this.hasMore)
      : { history: [], current: groups, startsOutsideLoadedPage: false };
    return html`
      ${this.renderTopNotices()}
      ${this.renderNotificationLiveRegions()}
      <div class="transcript-filter" @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape" && this.filterMenuOpen) { event.stopPropagation(); this.filterMenuOpen = false; this.renderRoot.querySelector<HTMLButtonElement>(".filter-toggle")?.focus(); } }} @focusout=${(event: FocusEvent) => { if (event.currentTarget instanceof HTMLElement && (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))) this.filterMenuOpen = false; }}>
        <button type="button" class="filter-toggle" aria-label=${`Filter transcript: ${this.filterLabel()}`} title=${`Filter transcript: ${this.filterLabel()}`} aria-expanded=${String(this.filterMenuOpen)} data-filter-active=${String(this.transcriptFilter !== "everything")} aria-controls=${this.filterMenuOpen ? "transcript-filter-options" : nothing} @click=${() => { this.filterMenuOpen = !this.filterMenuOpen; }}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6h16M7 12h10m-7 6h4"></path></svg>
        </button>
        ${this.filterMenuOpen ? html`<div id="transcript-filter-options" class="filter-options" role="group" aria-label="Transcript messages">
          ${this.transcriptFilter === "everything" ? null : this.renderFilterOption("everything", "Everything")}
          ${this.renderFilterOption("human", "Human only")}
          ${this.renderFilterOption("assistant", "Assistant only")}
          ${this.renderFilterOption("human-assistant", "Human + Assistant")}
        </div>` : null}
      </div>
      <div class="chat-wrap">
        ${this.renderConversationRail()}
        <div class="chat" @scroll=${() => { this.onScroll(); }} @wheel=${(event: WheelEvent) => { this.onWheel(event); }} @touchstart=${(event: TouchEvent) => { this.onTouchStart(event); }} @touchmove=${(event: TouchEvent) => { this.onTouchMove(event); }}>
          ${this.renderHistoryBoundary()}
          ${exchange.history.length === 0 ? null : html`
            <details class="exchange-history" open>
              <summary>Earlier conversation · ${exchange.history.length} ${exchange.history.length === 1 ? "item" : "items"}</summary>
              <div class="exchange-history-body">${this.renderGroups(exchange.history)}</div>
            </details>
          `}
          ${exchange.startsOutsideLoadedPage ? html`<div class="exchange-boundary" role="note">Current loaded tail · the latest user message is in earlier history</div>` : null}
          ${this.renderGroups(exchange.current)}
          ${this.transcriptFilter !== "everything" && groups.length === 0 ? html`<p class="filter-empty" role="status">No messages matching ${this.filterLabel()} in loaded history.${this.hasMore ? " Load earlier messages to continue." : ""}</p>` : null}
          ${this.renderQueuedMessages()}
          ${this.renderSessionActivity()}
          ${this.renderOpenAsk()}
          ${this.renderExtensionDialogs()}
        </div>
        ${this.pinnedToBottom ? null : html`
          <button type="button" class="scroll-to-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" @click=${() => { this.jumpToBottom(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
          </button>
        `}
        ${this.renderActivityDock()}
      </div>
      ${this.renderImageZoom()}
    `;
  }

  private filterLabel(): string {
    return this.transcriptFilter === "human" ? "Human only" : this.transcriptFilter === "assistant" ? "Assistant only" : this.transcriptFilter === "human-assistant" ? "Human + Assistant" : "Everything";
  }

  private renderFilterOption(filter: TranscriptFilter, label: string) {
    return html`<button type="button" aria-pressed=${String(this.transcriptFilter === filter)} @click=${() => {
      if (this.transcriptFilter === "everything") this.saveScrollPosition();
      this.transcriptFilter = filter;
      this.filterMenuOpen = false;
      this.renderRoot.querySelector<HTMLButtonElement>(".filter-toggle")?.focus();
    }}>${label}</button>`;
  }

  private renderGroups(groups: ChatGroup[]) {
    return repeat(
      groups,
      (_, index) => chatFragmentAnchorKey(groups, index),
      (group, index) => {
        const anchorId = chatFragmentAnchorKey(groups, index);
        if (group.kind === "group") return this.renderMessageGroup(
          group.messages,
          group.startIndex,
          anchorId,
          this.groupScrollMarkerId(groups, index, group.endIndex, group.presentation),
          group.presentation,
          groups,
          index,
          group.messageIndices,
        );
        if (group.kind === "tool-image") return this.renderToolImageOutput(group.message, group.index, anchorId, group.toolName);
        return this.renderMessage(group.message, group.index, anchorId);
      },
    );
  }

  private renderTopNotices() {
    const warnings = this.renderWarnings();
    const notifications = this.renderNotificationTray();
    if (warnings === null && notifications === null) return null;
    return html`<div class="top-notices">${warnings}${notifications}</div>`;
  }

  private renderNotificationTray() {
    const inbox = this.notificationInbox;
    if (inbox?.sessionId !== this.sessionId) return null;
    const chatKey = notificationTargetKey(inbox);
    const hasPendingOverlay = inbox.pendingDismissedIds.size > 0 || inbox.dismissAllPending;
    const retainsFocusTarget = this.retainedEmptyNotificationTrayTargetKey === chatKey;
    const totalCount = notificationInboxTotalCount(inbox);
    if (totalCount === 0 && !hasPendingOverlay && !retainsFocusTarget) return null;
    const collapsed = notificationTrayIsCollapsed(this.collapsedNotificationTargetKeys, inbox);
    const toggleLabel = collapsed ? "Expand notifications" : "Collapse notifications";
    return html`
      <section class=${`notification-tray${collapsed ? " collapsed" : ""}`} role="region" aria-labelledby="session-notifications-heading" @focusout=${(event: FocusEvent) => { this.releaseEmptyNotificationTray(event); }}>
        <header class="notification-header" data-notification-focus="header" tabindex="-1">
          <strong class="notification-heading" id="session-notifications-heading">${notificationTrayHeading(inbox)}</strong>
          <div class="notification-header-actions">
            <button
              type="button"
              class="notification-control notification-clear"
              aria-label="Clear all notifications"
              title="Clear all notifications"
              ?disabled=${inbox.dismissAllPending || totalCount === 0 || this.onDismissAllNotifications === undefined}
              @click=${() => { this.dismissAllNotifications(); }}
            >Clear</button>
            <button
              type="button"
              class="notification-control notification-toggle"
              aria-label=${toggleLabel}
              title=${toggleLabel}
              aria-expanded=${String(!collapsed)}
              aria-controls="session-notification-list"
              @click=${() => { this.toggleNotificationTray(inbox, collapsed); }}
            >${renderNotificationDisclosureIcon(collapsed)}</button>
          </div>
        </header>
        <div class="notification-list" id="session-notification-list" ?hidden=${collapsed}>
          ${inbox.discardedCount === 0 ? null : html`
            <p class="notification-overflow">${notificationInboxOverflowLabel(inbox.discardedCount)}</p>
          `}
          ${inbox.notifications.map((notification) => {
            const label = notificationSeverityLabel(notification.severity);
            const truncationLabel = notificationMessageTruncationLabel(notification);
            return html`
              <article class=${`notification-row ${notification.severity}`} data-notification-id=${notification.id} tabindex="-1">
                <div class="notification-metadata">
                  <strong class="notification-severity">${label}</strong>
                  <span aria-hidden="true">·</span>
                  <time datetime=${notification.receivedAt}>${notificationTimestampFormatter.format(new Date(notification.receivedAt))}</time>
                </div>
                <p class="notification-message" dir="auto">${notification.message}</p>
                ${truncationLabel === undefined ? null : html`<p class="notification-truncated">${truncationLabel}</p>`}
                <button
                  type="button"
                  class="notification-row-dismiss"
                  aria-label=${notificationDismissLabel(notification)}
                  title="Dismiss notification"
                  ?disabled=${inbox.pendingDismissedIds.has(notification.id) || inbox.dismissAllPending || this.onDismissNotification === undefined}
                  @click=${() => { this.dismissNotification(notification.id); }}
                >${renderNotificationCloseIcon()}</button>
              </article>
            `;
          })}
        </div>
      </section>
    `;
  }

  private renderNotificationLiveRegions() {
    const announcements = this.notificationInbox?.sessionId === this.sessionId ? this.notificationInbox.announcements : [];
    const polite = announcements.filter((announcement) => announcement.severity !== "error");
    const assertive = announcements.filter((announcement) => announcement.severity === "error");
    return html`
      <div class="visually-hidden notification-live" aria-live="polite" aria-atomic="false">${repeat(polite, (announcement) => announcement.id, (announcement) => html`<span data-announcement-id=${announcement.id}>${notificationAnnouncementLabel(announcement)}</span>`)}</div>
      <div class="visually-hidden notification-live" aria-live="assertive" aria-atomic="false">${repeat(assertive, (announcement) => announcement.id, (announcement) => html`<span data-announcement-id=${announcement.id}>${notificationAnnouncementLabel(announcement)}</span>`)}</div>
    `;
  }

  private toggleNotificationTray(inbox: SelectedSessionNotificationView, collapsed: boolean): void {
    this.collapsedNotificationTargetKeys = setNotificationTrayCollapsed(this.collapsedNotificationTargetKeys, inbox, !collapsed);
  }

  private dismissNotification(notificationId: string): void {
    const inbox = this.notificationInbox;
    if (inbox === undefined || this.onDismissNotification === undefined) return;
    const focusTarget = notificationFocusTargetAfterDismiss(inbox.notifications, notificationId);
    const chatKey = notificationTargetKey(inbox);
    this.pendingNotificationFocus = { chatKey, focusTarget };
    if (focusTarget.kind === "header") this.retainedEmptyNotificationTrayTargetKey = chatKey;
    this.onDismissNotification(notificationId);
  }

  private dismissAllNotifications(): void {
    const inbox = this.notificationInbox;
    if (inbox === undefined || this.onDismissAllNotifications === undefined) return;
    const chatKey = notificationTargetKey(inbox);
    this.pendingNotificationFocus = { chatKey, focusTarget: { kind: "header" } };
    this.retainedEmptyNotificationTrayTargetKey = chatKey;
    this.onDismissAllNotifications();
  }

  private releaseEmptyNotificationTray(event: FocusEvent): void {
    const tray = event.currentTarget;
    const next = event.relatedTarget;
    if (tray instanceof HTMLElement && next instanceof Node && tray.contains(next)) return;
    // Removing the activated row can emit focusout before updated() moves focus.
    if (this.pendingNotificationFocus !== undefined) return;
    const inbox = this.notificationInbox;
    if (inbox !== undefined
      && this.retainedEmptyNotificationTrayTargetKey === notificationTargetKey(inbox)
      && notificationInboxTotalCount(inbox) === 0) this.retainedEmptyNotificationTrayTargetKey = undefined;
  }

  private focusPendingNotificationTarget(): void {
    const pending = this.pendingNotificationFocus;
    this.pendingNotificationFocus = undefined;
    const inbox = this.notificationInbox;
    if (pending === undefined || inbox === undefined || notificationTargetKey(inbox) !== pending.chatKey) return;
    const target = pending.focusTarget;
    if (target.kind === "header") {
      this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='header']")?.focus();
      return;
    }
    const row = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-notification-id]"))
      .find((candidate) => candidate.dataset["notificationId"] === target.notificationId);
    if (row !== undefined) {
      row.focus();
      return;
    }
    if (notificationInboxTotalCount(inbox) === 0) this.retainedEmptyNotificationTrayTargetKey = pending.chatKey;
    this.renderRoot.querySelector<HTMLElement>("[data-notification-focus='header']")?.focus();
  }

  private renderWarnings() {
    const rows = chatSessionWarningRows(this.status);
    if (!this.warningsVisible || rows.length === 0) return null;
    return html`
      <aside class="session-warnings" role="alert" aria-live="polite">
        ${this.onToggleWarnings === undefined ? null : html`
          <div class="session-warnings-controls">
            <button
              type="button"
              class="session-warnings-collapse"
              title="Minimise warnings"
              aria-label="Minimise warnings"
              @click=${this.handleToggleWarnings}
            >
              <svg class="session-warnings-collapse-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="m18 15-6-6-6 6"></path>
              </svg>
              <span>Minimise</span>
            </button>
          </div>
        `}
        ${rows.map((row) => {
          const dismissId = row.dismissId;
          return html`
          <div class=${row.severityClass}>
            <div class="session-warning-head">
              ${renderSessionWarningIcon(row.severity, "session-warning-icon")}
              ${row.source === undefined ? null : html`<span class="session-warning-source">${row.source}</span>`}
            </div>
            <div class="session-warning-body">
              <p class="session-warning-message">${row.message}</p>
              ${row.path === undefined ? null : html`<p class="session-warning-path">${row.path}</p>`}
            </div>
            ${dismissId === undefined ? null : html`
              <button
                type="button"
                class="session-warning-dismiss"
                title="Don't show this warning again"
                aria-label="Dismiss warning"
                @click=${() => { this.onDismissWarning?.(dismissId); }}
              >×</button>
            `}
          </div>
        `;
        })}
      </aside>
    `;
  }

  private renderImageZoom() {
    return html`
      <dialog class="image-zoom" @click=${this.onImageZoomDialogClick} @close=${this.closeImageZoom} @cancel=${this.closeImageZoom}>
        ${this.zoomedImage === undefined ? null : html`
          <button type="button" class="image-zoom-close" aria-label="Close image" @click=${this.closeImageZoom}>×</button>
          <img class="image-zoom-full" src=${this.zoomedImage.src} alt=${this.zoomedImage.alt} />
        `}
      </dialog>
    `;
  }

  private groupedMessages(): ChatGroup[] {
    if (this.groupedMessagesInput === this.messages && this.groupedMessagesStart === this.messageStart) return this.groupedMessagesCache;
    this.groupedMessagesInput = this.messages;
    this.groupedMessagesStart = this.messageStart;
    this.groupedMessagesCache = groupChatMessages(this.messages, this.messageStart);
    return this.groupedMessagesCache;
  }

  private renderActivityDock() {
    if (this.isSendingPrompt) {
      return html`
        <div class="activity-dock active" aria-live="polite">
          <span class="dot"></span>
          <span class="activity-text">Sending your message…</span>
        </div>
      `;
    }
    const state = this.activityState();
    if (state === undefined || (this.activity?.phase === "idle" && (this.status === undefined || state === "idle")) || (state === "idle" && this.activity === undefined)) return null;
    return html`
      <div class=${this.activity?.phase === "error" ? "activity-dock" : "activity-dock active"} aria-live="polite">
        <span class="dot"></span>
        <span class="activity-text">${this.activityText(state)}</span>
      </div>
    `;
  }

  private renderQueuedMessages() {
    const serverQueued = this.status?.queuedMessages ?? [];
    return html`${chatQueuedMessageSections(this.clientQueuedMessages, serverQueued).map((section) => this.renderQueuedMessageList(section))}`;
  }

  private renderQueuedMessageList(section: QueuedMessageSection) {
    const canClear = chatQueuedSectionShowsClearAction(section, this.onClearServerQueue !== undefined);
    const canPromote = section.source === "server" && this.onPromoteQueuedMessage !== undefined;
    const canPromoteAll = section.source === "server" && section.messages.some((message) => message.kind === "followUp") && this.onPromoteAllQueuedMessages !== undefined;
    const promotionDisabled = this.status?.isCompacting === true;
    const promotionTitle = promotionDisabled ? "Available after compaction finishes" : "Move to steering";
    return html`
      <aside class="queued-messages" aria-live="polite">
        <div class="queued-header">
          <div class="queued-heading">
            <strong>${section.heading}</strong>
            <small>${section.detail}</small>
          </div>
          <div class="queued-actions">
            ${canPromoteAll ? html`
              <button type="button" class="queued-send-all-button" title=${promotionTitle} ?disabled=${promotionDisabled} @click=${() => { this.onPromoteAllQueuedMessages?.(); }}>Send all now</button>
            ` : null}
            ${canClear ? html`
              <button type="button" class="queued-clear-button" title="Clear queued messages without stopping active work" @click=${this.handleClearServerQueue}>Clear queue</button>
            ` : null}
          </div>
        </div>
        ${section.messages.map((message, index) => html`
          <div class="queued-message">
            <div class="queued-message-header">
              <span class="queued-kind">${message.kind === "steer" ? "Steer" : "Follow-up"} ${String(index + 1)}</span>
              ${canPromote && message.kind === "followUp" ? html`
                <button type="button" class="queued-send-now-button" aria-label=${`Send follow-up ${String(index + 1)} now`} title=${promotionTitle} ?disabled=${promotionDisabled} @click=${() => { this.onPromoteQueuedMessage?.(message); }}>Send now</button>
              ` : null}
            </div>
            <formatted-text .workspaceContext=${this.workspaceContext} .text=${message.text}></formatted-text>
          </div>
        `)}
      </aside>
    `;
  }

  private renderOpenAsk() {
    if (this.pendingAsk === undefined) return null;
    return html`
      <ask-user-card
        data-scroll-anchor-id=${`ask:${this.pendingAsk.askId}`}
        .ask=${this.pendingAsk}
        .draftSessionId=${this.askDraftSessionId}
        .onSubmit=${this.onSubmitAsk}
      ></ask-user-card>
    `;
  }

  private renderExtensionDialogs() {
    const open = this.pendingDialogs[0];
    if (open === undefined && this.closedDialogs.length === 0) return null;
    const queuedCount = this.pendingDialogs.length - 1;
    return html`
      ${repeat(
        this.closedDialogs,
        (closed) => closed.dialog.dialogId,
        (closed) => html`
          <extension-dialog-card
            class="closed-dialog-card"
            data-scroll-anchor-id=${`closed-dialog:${closed.dialog.dialogId}`}
            .outcome=${closed}
            .onDismiss=${this.onDismissClosedDialog}
          ></extension-dialog-card>
        `,
      )}
      ${open === undefined ? null : html`
        <extension-dialog-card
          class="open-dialog-card"
          data-scroll-anchor-id=${`dialog:${open.dialogId}`}
          .dialog=${open}
          .onAnswer=${this.onAnswerDialog}
          .onCancel=${this.onCancelDialog}
        ></extension-dialog-card>
        ${queuedCount > 0
          ? html`<p class="queued-dialogs" role="status">${String(queuedCount)} more extension ${queuedCount === 1 ? "dialog" : "dialogs"} queued</p>`
          : null}
      `}
    `;
  }

  private renderSessionActivity() {
    if (!this.isCompacting) return null;
    return html`
      <aside class="session-activity compacting" aria-live="polite">
        <strong>Compacting history…</strong>
        <span>The agent is summarizing earlier context. New prompts will be queued until compaction finishes.</span>
        ${this.pendingMessageCount > 0 ? html`<small>${this.pendingMessageCount} queued ${this.pendingMessageCount === 1 ? "message" : "messages"}</small>` : null}
      </aside>
    `;
  }

  private activityState(): string | undefined {
    const status = this.status;
    if (status === undefined) return this.activity?.label;
    if (status.isCompacting) return "compacting";
    if (status.isBashRunning) return "bash";
    if (status.isStreaming) return "running";
    if (status.pendingMessageCount > 0) return "queued";
    return "idle";
  }

  private activityText(state: string): string {
    const activity = this.activity;
    if (activity === undefined) return state;
    if (state !== "idle" && activity.phase === "idle") return state;
    return activity.detail !== undefined && activity.detail !== "" ? `${activity.label}: ${activity.detail}` : activity.label;
  }

  private renderConversationRail() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const total = this.conversationDisplayTotal();
    const position = this.conversationPositionPercent(total);
    const loadedPercent = this.hasMore ? clampPercent((this.messages.length / total) * 100) : 100;
    return html`<conversation-meter .positionPercent=${position} .loadedPercent=${loadedPercent}></conversation-meter>`;
  }

  private conversationDisplayTotal(): number {
    if (!this.hasMore && this.messageStart === 0) return Math.max(1, this.messages.length);
    return Math.max(1, this.messageTotal, this.messageStart + this.messages.length);
  }

  private conversationPositionPercent(total = this.conversationDisplayTotal()): number {
    if (total <= 1) return 100;
    const fallbackIndex = this.pinnedToBottom ? this.messageStart + this.messages.length - 1 : this.messageStart;
    const index = clampNumber(this.currentConversationIndex ?? fallbackIndex, 0, total - 1);
    return clampPercent((index / (total - 1)) * 100);
  }

  private renderHistoryBoundary() {
    const range = this.historyRangeLabel();
    if (this.loadingMore) return html`<div class="history-boundary"><span>Loading earlier messages…</span>${range}</div>`;
    if (this.hasMore) return html`
      <div class="history-boundary">
        <button type="button" class="history-load-button" ?disabled=${this.loadMoreRequested} @click=${() => { this.requestLoadMore(); }}>Load earlier messages</button>
        ${this.transcriptFilter === "everything" ? html`<span>Scroll up to load earlier messages</span>` : null}
        ${range}
      </div>
    `;
    if (this.messages.length) return html`<div class="history-boundary"><span>Beginning of session</span>${range}</div>`;
    return null;
  }

  private historyRangeLabel() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const from = this.messageStart + 1;
    const to = this.loadedRawMessageEnd();
    const total = Math.max(this.messageTotal, to);
    return html`<small>Showing messages ${from}–${to} of ${total}</small>`;
  }

  private loadedRawMessageEnd(): number {
    return Math.max(this.messageEnd, this.messageStart + this.messages.length);
  }

  private renderMessage(message: ChatLine, index: number, anchorId: string) {
    const toolOnly = this.isToolExecutionOnlyMessage(message);
    const askUserRecordOnly = this.isAskUserRecordOnlyMessage(message);
    const goalLifecycleOnly = message.parts.length > 0 && message.parts.every((part) => part.type === "goalLifecycle");
    const subagentCompletionOnly = message.parts.length > 0 && message.parts.every((part) => part.type === "subagentCompletion");
    const backgroundBashOnly = message.parts.length > 0 && message.parts.every((part) => part.type === "backgroundBash");
    const workingModeOnly = message.parts.length > 0 && message.parts.every((part) => part.type === "workingMode");
    const skillReadOnly = this.isSkillReadOnlyMessage(message);
    const headerless = toolOnly || askUserRecordOnly || skillReadOnly || goalLifecycleOnly || subagentCompletionOnly || backgroundBashOnly || workingModeOnly;
    const shellClass = workingModeOnly || backgroundBashOnly ? "msg goal-lifecycle-shell" : toolOnly ? "msg tool-execution-shell" : askUserRecordOnly ? "msg ask-user-record-shell" : goalLifecycleOnly ? "msg goal-lifecycle-shell" : subagentCompletionOnly ? "msg subagent-completion-shell" : "msg skill-read-shell";
    return html`
      ${this.renderScrollMarker(anchorId)}
      <article class=${`${headerless ? shellClass : `msg ${message.role}`}${message.severity === "error" ? " error" : ""}`} data-index=${index} data-scroll-anchor-id=${anchorId}>
        ${headerless ? null : this.renderMessageHeader(message, anchorId)}
        ${message.parts.map((part) => this.renderPart(part, message))}
      </article>
    `;
  }

  private renderToolImageOutput(message: ChatLine, index: number, anchorId: string, toolName?: string) {
    const label = chatToolOutputLabel(toolName);
    return html`
      ${this.renderScrollMarker(anchorId)}
      <article class="msg tool-image-output" data-index=${index} data-scroll-anchor-id=${anchorId}>
        ${this.renderMessageHeader(message, anchorId, label)}
        ${message.parts.map((part) => this.renderPart(part, message))}
      </article>
    `;
  }

  private isToolExecutionOnlyMessage(message: ChatLine): boolean {
    return message.role === "tool" && message.parts.length > 0 && message.parts.every((part) => part.type === "toolExecution");
  }

  private isAskUserRecordOnlyMessage(message: ChatLine): boolean {
    return message.parts.length > 0 && message.parts.every((part) => part.type === "askUserRecord");
  }

  private isSkillReadOnlyMessage(message: ChatLine): boolean {
    return message.parts.length > 0 && message.parts.every((part) => part.type === "skillRead");
  }

  private renderMessageGroup(messages: ChatLine[], startIndex: number, anchorId: string, markerId: string, presentation: ChatGroupPresentation | undefined, groups: ChatGroup[], groupIndex: number, messageIndices?: number[]) {
    const marker = this.renderScrollMarker(markerId);
    if (presentation === "history") return html`
      ${marker}
      <details class="event-group history-summary-group" data-index=${startIndex} data-scroll-anchor-id=${anchorId}>
        <summary><span class="chevron">${renderBuiltinTabIcon("chevron")}</span><strong>${summarizeChatGroup(messages)}</strong><span>Context compacted</span></summary>
        <div class="group-body">${this.renderMessageGroupBody(messages, startIndex, groups, groupIndex)}</div>
      </details>
    `;
    if (presentation === "activity") return html`
      ${marker}
      <details class="event-group activity-group" data-index=${startIndex} data-scroll-anchor-id=${anchorId}>
        <summary><span class="chevron">${renderBuiltinTabIcon("chevron")}</span><strong>Activity</strong><span>${this.activityStepCount(messages)} ${this.activityStepCount(messages) === 1 ? "step" : "steps"}</span></summary>
        <div class="group-body">${this.renderMessageGroupBody(messages, startIndex, groups, groupIndex)}</div>
      </details>
    `;
    if (presentation === "thinking") {
      const segments: { kind: "thinking" | "skill" | "activity"; messages: ChatLine[]; offset: number }[] = [];
      for (const [offset, message] of messages.entries()) {
        const kind = message.parts.every((part) => part.type === "thinking") ? "thinking" : this.isSkillReadOnlyMessage(message) ? "skill" : "activity";
        const previous = segments.at(-1);
        if (previous?.kind === kind) previous.messages.push(message);
        else segments.push({ kind, messages: [message], offset });
      }
      return html`
        ${marker}
        <details class="event-group thinking-group" data-index=${startIndex} data-scroll-anchor-id=${anchorId} open>
          <summary><span class="chevron">${renderBuiltinTabIcon("chevron")}</span><small>Thinking</small></summary>
          ${segments.map((segment) => {
            if (segment.kind === "thinking") {
              const text = segment.messages.flatMap((message) => message.parts).filter((part): part is Extract<ChatPart, { type: "thinking" }> => part.type === "thinking").map((part) => part.text).join("\n\n");
              return html`<formatted-text .workspaceContext=${this.workspaceContext} .text=${text}></formatted-text>`;
            }
            if (segment.kind === "skill") return this.renderMessageGroupBody(segment.messages, startIndex, groups, groupIndex, messageIndices, segment.offset);
            return this.renderMessageGroupBody(segment.messages, startIndex, groups, groupIndex, messageIndices, segment.offset);
          })}
        </details>
      `;
    }
    return html`${marker}<div class="event-group" data-index=${startIndex} data-scroll-anchor-id=${anchorId}>${this.renderMessageGroupBody(messages, startIndex, groups, groupIndex)}</div>`;
  }

  private activityStepCount(messages: ChatLine[]): number {
    const parts = messages.flatMap((message) => message.parts).filter((part) => part.type === "toolCall" || part.type === "toolExecution" || part.type === "toolResult");
    const ids = new Set(parts.flatMap((part) => part.toolCallId === undefined ? [] : [part.toolCallId]));
    const anonymousExecutions = parts.filter((part) => part.toolCallId === undefined && part.type === "toolExecution").length;
    const anonymousNames = new Set(parts.filter((part) => part.toolCallId === undefined).map((part) => part.toolName));
    const anonymousCallsAndResults = [...anonymousNames].reduce((count, toolName) => count + Math.max(
      parts.filter((part) => part.toolCallId === undefined && part.toolName === toolName && part.type === "toolCall").length,
      parts.filter((part) => part.toolCallId === undefined && part.toolName === toolName && part.type === "toolResult").length,
    ), 0);
    return ids.size + anonymousExecutions + anonymousCallsAndResults;
  }

  private renderMessageGroupBody(messages: ChatLine[], startIndex: number, groups: ChatGroup[], groupIndex: number, messageIndices?: number[], segmentOffset = 0) {
    return messages.map((message, offset) => {
      const toolOnly = this.isToolExecutionOnlyMessage(message);
      const skillOnly = this.isSkillReadOnlyMessage(message);
      const classes = `${toolOnly ? "group-msg tool-execution-shell" : skillOnly ? "group-msg skill-read-shell" : `group-msg ${message.role}`}${message.severity === "error" ? " error" : ""}`;
      const index = messageIndices?.[segmentOffset + offset] ?? startIndex + offset;
      const group = groups[groupIndex];
      const withinGroup = messageIndices?.slice(0, segmentOffset + offset).filter((candidate, earlier) => candidate === index && group?.kind === "group" && group.messages[earlier]?.parts.some((part) => part.type !== "thinking") === true).length ?? 0;
      const anchorId = this.eventAnchorKey(groups, groupIndex, index, withinGroup);
      return html`
        <article class=${classes} data-index=${index} data-scroll-anchor-id=${anchorId}>
          ${toolOnly || skillOnly ? null : this.renderMessageHeader(message, anchorId)}
          ${message.parts.map((part) => this.renderPart(part, message))}
        </article>
      `;
    });
  }

  private renderScrollMarker(markerId: string) {
    return html`<span class="scroll-marker" data-marker-id=${markerId} aria-hidden="true"></span>`;
  }

  private renderMessageHeader(message: ChatLine, key: string, label: string = message.role) {
    const timestamp = message.meta?.timestamp;
    const meta = this.messageMetaLabel(message);
    return html`
      <div class="msg-header">
        <div class="msg-heading">
          <b class="label">${label}</b>
          ${meta === undefined || timestamp === undefined ? null : html`<time class="msg-meta" datetime=${timestamp} title=${meta} aria-label=${meta}>${formatMessageTime(timestamp)}</time>`}
        </div>
        ${this.renderMessageActions(message, key)}
      </div>
    `;
  }

  private renderMessageActions(message: ChatLine, key: string) {
    if (message.role !== "user" && message.role !== "assistant") return null;
    const canNavigate = message.entryId !== undefined && this.onMessageAction !== undefined;
    const canCopy = this.isCopyableMessage(message);
    if (!canNavigate && !canCopy) return null;
    const copied = this.copiedMessageKey === key;
    const disabled = this.messageActionsDisabled || this.messageActionPending || this.status?.isStreaming === true;
    return html`
      <div class="msg-actions" aria-label="Message actions">
        ${canCopy ? html`
          <button type="button" class="msg-action" title=${copied ? "Copied" : "Copy message"} aria-label=${`${copied ? "Copied" : "Copy"} ${message.role} message`} @click=${(event: MouseEvent) => { void this.copyMessage(message, key, event); }}>
            <span aria-hidden="true">${copied ? "✓" : "⧉"}</span>
          </button>
        ` : null}
        ${canNavigate ? html`
          <button type="button" class="msg-action" title="Revert to here" aria-label="Revert to here" ?disabled=${disabled} @click=${(event: MouseEvent) => { void this.actOnMessage(message, "back", event); }}><span aria-hidden="true">⏪</span></button>
        ` : null}
        ${canNavigate && message.role === "user" ? html`
          <button type="button" class="msg-action" title="Edit & resend" aria-label="Edit and resend" ?disabled=${disabled} @click=${(event: MouseEvent) => { void this.actOnMessage(message, "back", event); }}><span aria-hidden="true">✎</span></button>
        ` : null}
        ${this.messageActionError?.sessionId === this.sessionId && this.messageActionError.entryId === message.entryId ? html`<span role="alert">${this.messageActionError.message}</span>` : null}
      </div>
    `;
  }

  private async actOnMessage(message: ChatLine, action: "fork" | "back", event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.messageActionsDisabled || this.messageActionPending || message.entryId === undefined || this.onMessageAction === undefined) return;
    if (!window.confirm(action === "fork" ? "Are you sure you want to fork this session?" : "Are you sure you want to go back to this message?")) return;
    const sessionId = this.sessionId;
    this.messageActionPending = true;
    this.messageActionError = undefined;
    try {
      await this.onMessageAction(message.entryId, action);
    } catch (error) {
      if (this.sessionId === sessionId) this.messageActionError = { sessionId, entryId: message.entryId, message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.messageActionPending = false;
    }
  }

  private isCopyableMessage(message: ChatLine): boolean {
    return (message.role === "user" || message.role === "assistant") && this.messageCopyText(message) !== "";
  }

  private messageCopyText(message: ChatLine): string {
    const cached = this.messageCopyTextCache.get(message);
    if (cached !== undefined) return cached;
    const text = message.parts
      .filter((part): part is Extract<ChatPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text.trim())
      .filter((partText) => partText !== "")
      .join("\n\n");
    this.messageCopyTextCache.set(message, text);
    return text;
  }

  private async copyMessage(message: ChatLine, key: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const copied = await writeClipboardText(this.messageCopyText(message));
    if (!copied) return;
    this.copiedMessageKey = key;
    window.setTimeout(() => {
      if (this.copiedMessageKey === key) this.copiedMessageKey = undefined;
    }, 1200);
  }


  private messageMetaLabel(message: ChatLine): string | undefined {
    const cached = this.messageMetaCache.get(message);
    if (cached !== undefined) return cached;
    const label = chatMessageMetadataLabel(message);
    this.messageMetaCache.set(message, label);
    return label;
  }

  private renderPart(part: ChatPart, message?: ChatLine) {
    if (part.type === "text" && message?.role === "bash") return html`<pre class="part shell-output">${part.text}</pre>`;
    if (part.type === "text") return html`<formatted-text class="part" .workspaceContext=${this.workspaceContext} .text=${part.text}></formatted-text>`;
    if (part.type === "thinking") return html`
      <div class="part thinking">
        <small class="thinking-label">Thinking</small>
        <formatted-text .workspaceContext=${this.workspaceContext} .text=${part.text}></formatted-text>
      </div>
    `;
    if (part.type === "skillInvocation") return html`
      <details class="part skill-invocation">
        <summary><span class="chevron">${renderBuiltinTabIcon("chevron")}</span><span class="disclosure-preview"><b>[skill]</b> ${part.name}</span></summary>
        <small>${part.location}</small>
        <formatted-text .workspaceContext=${this.workspaceContext} .text=${part.content}></formatted-text>
      </details>
    `;
    if (part.type === "skillRead") return html`<div class="part skill-read">Read skill · ${part.name}</div>`;
    if (part.type === "subagentCompletion") return html`
      <details class="part subagent-completion">
        <summary>Subagents finished</summary>
        <div class="subagent-completion-instruction" dir="auto">${part.text}</div>
      </details>
    `;
    if (part.type === "backgroundBash") return html`
      <details class="part background-bash-card">
        <summary><span aria-hidden="true">${part.details.state === "complete" ? "✓" : part.details.state === "cancelled" ? "○" : "✖"}</span>
          <span>${part.details.state} · exit ${part.details.exitCode === undefined ? "unknown" : String(part.details.exitCode)} · ${String(part.details.elapsedSeconds)}s</span>
          <code class="background-bash-command" title=${part.details.command}>${part.details.command}</code>
        </summary>
        <pre class="background-bash-output">${part.output}</pre>
        <div class="background-bash-log"><code>${part.details.logPath}</code>
          <button type="button" aria-label="Copy log path" @click=${() => { void writeClipboardText(part.details.logPath); }}>Copy</button>
        </div>
      </details>
    `;
    if (part.type === "workingMode") return html`
      <details class="part working-mode-card">
        <summary><span class="working-mode-title">Working Mode</span>${part.dials.map((dial) => html`<span class=${dial.guidance === undefined ? "working-mode-value" : "working-mode-value changed"} title=${dial.label}>${dial.value}</span>`)}</summary>
        ${part.dials.some((dial) => dial.guidance !== undefined)
          ? html`<dl>${part.dials.filter((dial) => dial.guidance !== undefined).map((dial) => html`<dt>${dial.label} — ${dial.value}</dt><dd>${dial.guidance}</dd>`)}</dl>`
          : html`<p>Every dial is at its starting setting; no extra guidance applies.</p>`}
      </details>
    `;
    if (part.type === "goalLifecycle") return html`
      <details class="part goal-lifecycle">
        <summary>${goalTransitionLabels[part.details.transition]}</summary>
        <div><strong>State:</strong> ${part.details.state}</div>
        <div><strong>Goal ID:</strong> <code>${part.details.goalId}</code></div>
        ${part.details.reason === undefined ? null : html`<div><strong>Reason:</strong> ${part.details.reason}</div>`}
        ${part.details.summary === undefined ? null : html`<div><strong>Summary:</strong> ${part.details.summary}</div>`}
      </details>
    `;
    if (part.type === "askUserRecord") return html`
      <ask-user-card
        class="part"
        .outcome=${part.outcome}
        .draftSessionId=${this.askDraftSessionId}
      ></ask-user-card>
    `;
    if (part.type === "image") {
      const { src, alt } = chatImagePartSource(part);
      return html`<img class="part chat-image" src=${src} alt=${alt} loading="lazy" role="button" tabindex="0" title="Click to enlarge" @load=${this.onImageLoad} @click=${() => { this.openImageZoom(src, alt); }} @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.openImageZoom(src, alt); } }} />`;
    }
    if (part.type === "toolCall") return html`
      <details class="part tool-line">
        <summary><span class="chevron">${renderBuiltinTabIcon("chevron")}</span>▶ ${toolActionLabel(part.toolName)}<span class="summary">${part.summary}</span></summary>
        ${part.args === undefined ? null : html`<pre>${formatToolCallArguments(part.args)}</pre>`}
      </details>
    `;
    if (part.type === "toolExecution") return html`<tool-execution-view class="part" .execution=${part}></tool-execution-view>`;
    if (part.type === "toolResult") {
      const preview = previewFromDetails(part.details);
      if ((typeof part.details === "object" && part.details !== null && typeof Reflect.get(part.details, "diff") === "string") || preview?.diff !== undefined) return html`
        <tool-execution-view class="part" .orphan=${true} .execution=${{
          type: "toolExecution", toolName: part.toolName, summary: "", status: part.isError ? "error" : "success",
          resultText: part.text, details: part.details, preview,
        }}></tool-execution-view>
      `;
      const previewError = preview?.error;
      return html`
        <details class=${part.isError ? "part tool-result error" : "part tool-result"} ?open=${previewError !== undefined && previewError !== ""}>
          <summary>${part.isError ? "✖" : "✓"} ${toolActionLabel(part.toolName)} result</summary>
          <pre class="orphan-tool-result">${part.text}</pre>
          ${previewError === undefined || previewError === "" ? null : html`<pre class="orphan-preview-error">Preview error: ${previewError}</pre>`}
        </details>
      `;
    }
    return null;
  }

  private onScroll() {
    this.requestLoadMoreIfNeeded();
    this.updatePinnedToBottomFromScroll();
    this.scheduleConversationRailUpdate();
    if (!this.suppressScrollSave) this.scheduleScrollPositionSave();
  }

  private onWheel(event: WheelEvent) {
    if (event.deltaY < 0 && this.canScrollUp()) this.pinnedToBottom = false;
  }

  private onTouchStart(event: TouchEvent) {
    this.touchStartY = event.touches[0]?.clientY;
  }

  private onTouchMove(event: TouchEvent) {
    const y = event.touches[0]?.clientY;
    if (this.touchStartY !== undefined && y !== undefined && y > this.touchStartY && this.canScrollUp()) this.pinnedToBottom = false;
  }

  private updatePinnedToBottomFromScroll() {
    const chat = this.chat;
    if (!chat) return;
    const heightChanged = this.didChatHeightChange();
    const wasPinnedToBottom = this.pinnedToBottom;
    const scrollingUp = chat.scrollTop < this.lastScrollTop;
    if (heightChanged && wasPinnedToBottom) {
      this.lastClientHeight = chat.clientHeight;
      this.scrollToBottom();
      return;
    }
    if (this.isAtBottom()) this.pinnedToBottom = true;
    else if (scrollingUp) this.pinnedToBottom = false;
    else this.pinnedToBottom = this.isNearBottom();
    this.lastScrollTop = chat.scrollTop;
    this.lastClientHeight = chat.clientHeight;
  }

  private didChatHeightChange(): boolean {
    const chat = this.chat;
    return chat != null && this.lastClientHeight !== 0 && chat.clientHeight !== this.lastClientHeight;
  }

  private isPrependingMessages(changed: Map<string, unknown>): boolean {
    const oldMessageStart = changed.get("messageStart");
    return typeof oldMessageStart === "number" && this.messageStart < oldMessageStart;
  }

  private requestLoadMoreIfNeeded(): void {
    if (this.transcriptFilter !== "everything" || this.loadMoreCheckFrame !== undefined) return;
    this.loadMoreCheckFrame = requestAnimationFrame(() => {
      this.loadMoreCheckFrame = undefined;
      if (this.suppressLoadMoreRequests || this.transcriptFilter !== "everything") return;
      const chat = this.chat;
      if (!chat) return;
      if (shouldRequestEarlierMessages({
        hasMore: this.hasMore,
        loadingMore: this.loadingMore || this.loadMoreRequested,
        canRequest: this.onLoadMore !== undefined,
        scrollTop: chat.scrollTop,
        scrollHeight: chat.scrollHeight,
        clientHeight: chat.clientHeight,
      })) this.requestLoadMore();
    });
  }

  private requestLoadMore(): void {
    if (this.loadMoreRequested) return;
    if (!this.hasMore || this.loadingMore || this.onLoadMore === undefined) return;
    this.loadMoreRequested = true;
    this.onLoadMore();
  }

  private isNearBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return isNearScrollBottom(chat);
  }

  private isAtBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return distanceFromScrollBottom(chat) < 2;
  }

  private canScrollUp(): boolean {
    const chat = this.chat;
    return chat != null && chat.scrollTop > 0;
  }

  private scrollToBottom() {
    if (this.scrollToBottomFrame !== undefined) return;
    this.scrollToBottomFrame = requestAnimationFrame(() => {
      this.scrollToBottomFrame = undefined;
      const chat = this.chat;
      if (!chat) return;
      this.withSuppressedScrollSave(() => {
        chat.scrollTop = chat.scrollHeight;
        this.lastScrollTop = chat.scrollTop;
        this.lastClientHeight = chat.clientHeight;
      });
    });
  }

  private jumpToBottom(): void {
    this.pinnedToBottom = true;
    this.scrollToBottom();
  }

  private isNewPendingAsk(previous: unknown): boolean {
    return this.pendingAsk !== undefined
      && (typeof previous !== "object" || previous === null || Reflect.get(previous, "askId") !== this.pendingAsk.askId);
  }

  private isNewOpenDialog(previous: unknown): boolean {
    const oldest = this.pendingDialogs[0];
    if (oldest === undefined) return false;
    if (!Array.isArray(previous)) return true;
    const previousOldest: unknown = previous[0];
    return typeof previousOldest !== "object" || previousOldest === null || Reflect.get(previousOldest, "dialogId") !== oldest.dialogId;
  }

  private scrollToOpenAsk(): void {
    if (this.scrollToOpenAskFrame !== undefined) return;
    if (this.scrollToBottomFrame !== undefined) {
      cancelAnimationFrame(this.scrollToBottomFrame);
      this.scrollToBottomFrame = undefined;
    }
    this.scrollToOpenAskFrame = requestAnimationFrame(() => {
      this.scrollToOpenAskFrame = undefined;
      this.withSuppressedScrollSave(() => { this.alignOpenAskToTop(); });
    });
  }

  private alignOpenAskToTop(): boolean {
    const chat = this.chat;
    if (chat == null) return false;
    const card = this.renderRoot.querySelector<HTMLElement>(".chat > ask-user-card");
    if (card === null) return false;
    chat.scrollTop += card.getBoundingClientRect().top - chat.getBoundingClientRect().top;
    this.syncScrollMetrics();
    this.pinnedToBottom = this.isNearBottom();
    return true;
  }

  private scrollToOpenDialog(): void {
    if (this.scrollToOpenDialogFrame !== undefined) return;
    if (this.scrollToBottomFrame !== undefined) {
      cancelAnimationFrame(this.scrollToBottomFrame);
      this.scrollToBottomFrame = undefined;
    }
    this.scrollToOpenDialogFrame = requestAnimationFrame(() => {
      this.scrollToOpenDialogFrame = undefined;
      this.withSuppressedScrollSave(() => { this.alignOpenDialogToTop(); });
    });
  }

  private alignOpenDialogToTop(): boolean {
    const chat = this.chat;
    if (chat == null) return false;
    const card = this.renderRoot.querySelector<HTMLElement>(".chat > extension-dialog-card.open-dialog-card");
    if (card === null) return false;
    chat.scrollTop += card.getBoundingClientRect().top - chat.getBoundingClientRect().top;
    this.syncScrollMetrics();
    this.pinnedToBottom = this.isNearBottom();
    return true;
  }

  restoreScrollPosition() {
    const sessionId = this.sessionId;
    if (this.restoreScrollFrame !== undefined) cancelAnimationFrame(this.restoreScrollFrame);
    this.restoreScrollFrame = requestAnimationFrame(() => {
      this.restoreScrollFrame = undefined;
      if (this.sessionId !== sessionId || this.transcriptFilter !== "everything") return;
      this.withSuppressedScrollSave(() => {
        if (this.pendingAsk !== undefined && this.scrollController.readPosition(sessionId) === undefined && this.alignOpenAskToTop()) return;
        if (this.pendingDialogs.length > 0 && this.scrollController.readPosition(sessionId) === undefined && this.alignOpenDialogToTop()) return;
        const chat = this.chat;
        const result = this.scrollController.restorePosition(sessionId, chat ?? undefined, chat == null ? [] : this.scrollAnchorElements(), { fallbackToBottom: this.shouldFallbackToBottomForMissingAnchor() });
        this.handleScrollRestoreResult(sessionId, result);
      });
    });
  }

  private continuePendingScrollRestore(): void {
    const sessionId = this.pendingScrollRestoreSessionId;
    const position = this.pendingScrollRestorePosition;
    if (this.transcriptFilter !== "everything" || sessionId === undefined || position === undefined || sessionId !== this.sessionId || this.restoreScrollFrame !== undefined) return;
    this.restoreScrollFrame = requestAnimationFrame(() => {
      this.restoreScrollFrame = undefined;
      if (this.sessionId !== sessionId || this.transcriptFilter !== "everything") return;
      this.withSuppressedScrollSave(() => {
        const chat = this.chat;
        const result = this.scrollController.restoreExplicitPosition(position, chat ?? undefined, chat == null ? [] : this.scrollAnchorElements(), { fallbackToBottom: this.shouldFallbackToBottomForMissingAnchor() });
        this.handleScrollRestoreResult(sessionId, result);
      });
    });
  }

  private handleScrollRestoreResult(sessionId: string, result: ChatScrollRestoreResult): void {
    if (this.transcriptFilter !== "everything") return;
    this.syncScrollMetrics();
    if (result.status !== "missing") {
      this.updatePinnedToBottomAfterRestore(result.status);
      if (result.status === "restored" || result.status === "bottom") this.cancelPrependRestore();
      this.pendingScrollRestoreSessionId = undefined;
      this.pendingScrollRestorePosition = undefined;
      return;
    }

    this.pinnedToBottom = false;
    this.pendingScrollRestoreSessionId = sessionId;
    this.pendingScrollRestorePosition = result.position;
    const chat = this.chat;
    if (chat == null || !this.hasMore || this.loadingMore) return;
    chat.scrollTop = 0;
    this.syncScrollMetrics();
    this.requestLoadMore();
  }

  private shouldFallbackToBottomForMissingAnchor(): boolean {
    // Only fall back to the bottom once the full history is loaded; while earlier
    // pages can still load, a missing scroll anchor should keep retrying rather
    // than jump the user to the bottom.
    return !this.hasMore;
  }

  private updatePinnedToBottomAfterRestore(status: Exclude<ChatScrollRestoreResult["status"], "missing">): void {
    if (status === "bottom") this.pinnedToBottom = true;
    else if (status === "restored") this.pinnedToBottom = this.isNearBottom();
  }

  private syncScrollMetrics(): void {
    const chat = this.chat;
    if (chat == null) return;
    this.lastScrollTop = chat.scrollTop;
    this.lastClientHeight = chat.clientHeight;
  }

  private cancelPrependRestore(): void {
    this.prependRestoreToken += 1;
    this.suppressLoadMoreRequests = false;
  }

  private captureFilterScrollAnchor(groups: ChatGroup[]): PrependScrollAnchor | undefined {
    const chat = this.chat;
    if (!chat) return undefined;
    const source = this.firstVisibleArticle();
    if (source === undefined || groups.length === 0) return this.capturePrependScrollAnchor();
    const visibleIndex = Number(source.dataset["index"]);
    const next = groups.findIndex((group) => (group.kind === "group" ? group.endIndex : group.index) >= visibleIndex);
    const target = groups[next < 0 ? groups.length - 1 : next];
    if (target === undefined) return this.capturePrependScrollAnchor();
    const targetIndex = target.kind === "group" ? target.startIndex : target.index;
    const offset = source.getBoundingClientRect().top - chat.getBoundingClientRect().top;
    return {
      distanceFromBottom: chat.scrollHeight - chat.scrollTop,
      markerId: chatFragmentAnchorKey(groups, next < 0 ? groups.length - 1 : next),
      markerOffset: targetIndex === visibleIndex ? offset : Math.max(0, offset),
    };
  }

  capturePrependScrollAnchor(): PrependScrollAnchor | undefined {
    const chat = this.chat;
    if (!chat) return undefined;
    return capturePrependScrollAnchor(chat, this.scrollMarkers());
  }

  restorePrependScrollAnchor(anchor: PrependScrollAnchor | undefined): void {
    if (this.chat == null || !anchor) return;
    this.suppressLoadMoreRequests = true;
    this.suppressScrollSave = true;
    const token = this.prependRestoreToken + 1;
    this.prependRestoreToken = token;
    let frames = 0;
    const settle = () => {
      const chat = this.chat;
      if (!chat || token !== this.prependRestoreToken) return;
      restorePrependScrollAnchor(chat, anchor, anchor.markerId === undefined ? undefined : this.scrollMarkerAt(anchor.markerId));
      this.lastScrollTop = chat.scrollTop;
      frames += 1;
      // Formatted markdown/code layout can settle after Lit's first render. Re-apply
      // the marker anchor briefly so late height changes above the viewport do not
      // move the user's reading position.
      if (frames < PREPEND_RESTORE_SETTLE_FRAMES) {
        requestAnimationFrame(settle);
        return;
      }
      requestAnimationFrame(() => {
        if (token !== this.prependRestoreToken) return;
        this.suppressScrollSave = false;
        this.suppressLoadMoreRequests = false;
      });
    };
    settle();
  }

  saveScrollPosition(sessionId = this.sessionId) {
    if (this.transcriptFilter !== "everything") return;
    const chat = this.chat;
    if (!sessionId || chat == null) return;
    this.scrollController.savePosition(sessionId, chat, this.scrollAnchorElements());
  }

  private scheduleScrollPositionSave() {
    if (this.transcriptFilter !== "everything") return;
    const sessionId = this.sessionId;
    this.scrollController.scheduleSave(sessionId, (scheduledSessionId) => {
      if (this.sessionId === scheduledSessionId) this.saveScrollPosition(scheduledSessionId);
    });
  }

  private scheduleConversationRailUpdate(): void {
    if (this.conversationRailFrame !== undefined) return;
    this.conversationRailFrame = requestAnimationFrame(() => {
      this.conversationRailFrame = undefined;
      this.updateConversationRailPosition();
    });
  }

  private updateConversationRailPosition(): void {
    if (!this.messages.length || this.messageTotal <= 0) {
      this.currentConversationIndex = undefined;
      return;
    }
    const total = this.conversationDisplayTotal();
    const article = this.firstVisibleArticle();
    const index = Number(article?.dataset["index"]);
    if (Number.isFinite(index)) {
      this.currentConversationIndex = clampNumber(index, 0, Math.max(0, total - 1));
      return;
    }
    this.currentConversationIndex = clampNumber(this.pinnedToBottom ? this.messageStart + this.messages.length - 1 : this.messageStart, 0, Math.max(0, total - 1));
  }

  private scrollMarkers(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".scroll-marker"));
  }

  private scrollMarkerAt(markerId: string): HTMLElement | undefined {
    return this.scrollMarkers().find((marker) => marker.dataset["markerId"] === markerId);
  }

  private firstVisibleArticle(): HTMLElement | undefined {
    const chat = this.chat;
    return chat == null ? undefined : findFirstVisibleArticle(chat, this.articles());
  }

  private articles(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("article.msg, article.group-msg"));
  }

  private scrollAnchorElements(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"));
  }

  private withSuppressedScrollSave(callback: () => void) {
    this.suppressScrollSave = true;
    callback();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.suppressScrollSave = false;
      });
    });
  }

  private eventAnchorKey(groups: ChatGroup[], groupIndex: number, index: number, withinGroup = 0): string {
    const occurrence = groups.slice(0, groupIndex).reduce((count, group) => group.kind === "group" && (group.presentation !== "thinking" || group.messageIndices !== undefined)
      ? count + group.messages.filter((_, offset) => (group.messageIndices?.[offset] ?? group.startIndex + offset) === index && (group.presentation !== "thinking" || group.messages[offset]?.parts.every((part) => part.type !== "thinking") === true)).length
      : count, withinGroup);
    const base = chatEventAnchorKey(index);
    return occurrence === 0 ? base : `${base}:${String(occurrence)}`;
  }

  private groupScrollMarkerId(groups: ChatGroup[], index: number, endIndex: number, presentation?: ChatGroupPresentation): string {
    const preceding = groups.slice(0, index).filter((group) => group.kind === "group" && group.endIndex === endIndex);
    if (preceding.length === 0) return chatGroupScrollMarkerId(endIndex);
    const occurrence = preceding.filter((group) => group.kind === "group" && group.presentation === presentation).length;
    return chatGroupScrollMarkerId(endIndex, presentation ?? "events", occurrence);
  }

  static override styles = [chatStyles, css`
    .transcript-filter { position: relative; display: flex; justify-content: flex-end; padding: 4px 10px; }
    .filter-toggle, .filter-options button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); cursor: pointer; }
    .filter-toggle { display: grid; place-items: center; width: 30px; height: 30px; }
    .filter-toggle svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    .filter-toggle[data-filter-active="true"] { color: var(--pi-accent); border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .filter-options { position: absolute; z-index: 2; top: 100%; right: 10px; display: grid; gap: 4px; padding: 6px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 4px 12px #0003; }
    .filter-options button { min-height: 30px; padding: 4px 10px; text-align: left; white-space: nowrap; }
    .filter-options button[aria-pressed="true"] { border-color: var(--pi-accent); }
    .transcript-filter button:focus-visible { outline: 2px solid var(--pi-accent); }
    .filter-empty { margin: 12px; color: var(--pi-muted); }
    .history-summary-group { border: 1px solid var(--pi-border); border-left: 3px solid var(--pi-accent); border-radius: 8px; background: color-mix(in srgb, var(--pi-accent) 6%, var(--pi-surface)); }
    .history-summary-group > summary { display: flex; align-items: center; gap: 7px; min-height: 36px; padding: 6px 10px; color: var(--pi-muted); list-style: none; cursor: pointer; }
    .history-summary-group > summary::-webkit-details-marker { display: none; }
    .history-summary-group > summary strong { color: var(--pi-text); }
    .history-summary-group > summary span:last-child { margin-left: auto; font-size: 11px; text-transform: uppercase; }
    .history-summary-group > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .history-summary-group > .group-body { padding: 6px 10px 10px 31px; border-top: 1px solid var(--pi-border-muted); }
    .msg.goal-lifecycle-shell { padding: 0 2px var(--pi-message-padding); }
    .goal-lifecycle { border-left: 3px solid var(--pi-accent); padding: 6px 12px; color: var(--pi-text); background: var(--pi-surface); border-radius: 6px; }
    .goal-lifecycle > summary { cursor: pointer; font-weight: 600; }
    .working-mode-card { border-left: 3px solid var(--pi-accent); padding: 6px 12px; color: var(--pi-text); background: var(--pi-surface); border-radius: 6px; }
    .working-mode-card > summary { cursor: pointer; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .working-mode-card > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .working-mode-title { font-weight: 600; margin-right: 4px; }
    .working-mode-value { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--pi-border); color: var(--pi-muted); font-size: 0.9em; }
    .working-mode-value.changed { border-color: var(--pi-accent); color: var(--pi-text); font-weight: 600; }
    .working-mode-card dl { margin: 8px 0 2px; }
    .working-mode-card dt { font-weight: 600; margin-top: 6px; }
    .working-mode-card dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    .working-mode-card p { margin: 8px 0 2px; }
    .goal-lifecycle > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .goal-lifecycle > div { margin-top: 6px; overflow-wrap: anywhere; }
    .background-bash-card { border-left: 3px solid var(--pi-accent); padding: 6px 12px; background: var(--pi-surface); border-radius: 6px; min-width: 0; }
    .background-bash-card > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; min-width: 0; }
    .background-bash-card > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .background-bash-command { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .background-bash-output { max-height: 240px; overflow: auto; white-space: pre; font: inherit; font-family: monospace; }
    .background-bash-log { display: flex; align-items: center; gap: 8px; }
    .background-bash-log code { overflow-wrap: anywhere; min-width: 0; }
    .msg.subagent-completion-shell { padding: 0 2px var(--pi-message-padding); }
    .subagent-completion { color: var(--pi-muted); font-size: 12px; }
    .subagent-completion > summary { width: fit-content; cursor: pointer; }
    .subagent-completion > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .subagent-completion-instruction { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--pi-text); }
  `];
}
