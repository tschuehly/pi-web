import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { keyed } from "lit/directives/keyed.js";
import { ChatMessageActionController } from "./ChatMessageActionController";
import * as transcript from "./chatTranscriptTemplates";
import type { TranscriptRenderContext } from "./chatTranscriptTemplates";
import { ChatDisclosureController } from "../chatDisclosure";
import { writeClipboardText } from "../clipboard";
import { chatSessionWarningRows, renderSessionWarnings } from "./chat/SessionWarnings";
export { chatSessionWarningRows } from "./chat/SessionWarnings";
import { type QueuedMessageAction, type QueuedMessageActionTarget } from "../queuedMessageActions";
import { chatQueuedMessageSections, renderQueuedMessageSection, type QueuedMessageSection } from "./chat/QueuedMessages";
export { chatQueuedMessageSections, chatQueuedSectionShowsClearAction, type QueuedMessageSection } from "./chat/QueuedMessages";
import type { DisplayedMessageActionAvailabilityContext, MessageActionAvailabilityContext, MessageActionResult } from "../../../plugin-api";
import type { RegisteredMessageAction } from "../plugins/messageActions";
import { machineSessionKey } from "../machineKeys";
import { canonicalEntryActionHeaders, currentExchangeGroups, groupChatMessages, groupConsecutiveImageOutputs, type ChatDisplayGroup, type ChatGroup } from "../chatGroups";
import type { ReplyQuote } from "../replyQuotes";
import { ChatScrollFlows } from "../ChatScrollFlows";
import type { ConversationMeter } from "./ConversationMeter";
import "./ConversationMeter";
import { ChatRenderKeys } from "../chatRenderKeys";
import { DEFAULT_CHAT_BEHAVIORS, type ChatBehaviors } from "../chatBehaviors";
import type { AskUserSubmission, PendingAskUser, PendingExtensionDialog, QueuedSessionMessage, SessionActivity, SessionRef, SessionStatus } from "../api";
import type { ClosedExtensionDialog } from "../appState";
import type { SelectedSessionNotificationView } from "../sessionNotifications";
import "./SessionNotificationTray";
import type { ChatLine, ChatPart } from "../chatTypes";
import { chatStyles } from "./chat/chatStyles";
import "./AskUserCard";
import "./ExtensionDialogCard";
import type { ExtensionDialogAnswerCallback, ExtensionDialogCancelCallback, ExtensionDialogDismissCallback } from "./ExtensionDialogCard";
import "./ImageGalleryDialog";
import type { ImageGalleryDialog } from "./ImageGalleryDialog";
import "./FormattedText";
import { workspaceContextChanged, type MarkdownWorkspaceContext } from "../formatting/workspaceLinks";
import "./ToolExecutionView";
import { transcriptImageSource } from "./TranscriptImage";
import type { ImageOpenDetail } from "./ImagePresentation";

const messageTimestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export type ChatImagePart = Extract<ChatPart, { type: "image" }>;

export type TranscriptFilter = "everything" | "human" | "assistant" | "human-assistant";

/** Project readable message content while keeping the original indices and entry IDs. */
export function filterChatGroups(groups: ChatGroup[], filter: TranscriptFilter): ChatGroup[] {
  if (filter === "everything") return groups;
  const project = (message: ChatLine, index: number): ChatGroup[] => {
    const role = message.role;
    if (role !== "user" && role !== "assistant") return [];
    if (filter === "human" && role !== "user" || filter === "assistant" && role !== "assistant") return [];
    const parts = message.parts.filter((part) => part.type === "text" || part.type === "image");
    return parts.length === 0 ? [] : [{ kind: "message", message: parts.length === message.parts.length ? message : { ...message, parts }, index }];
  };
  return groups.flatMap((group) => group.kind === "group"
    ? group.messages.flatMap(({ message, index }) => project(message, index))
    : project(group.message, group.index));
}

/** `entry:<entryId>`, `ask:<askId>`, or `dialog:<dialogId>` in one Chat. */
export interface ChatRevealTarget {
  machineId: string;
  sessionId: string;
  anchor: string;
}

/** The message text part (`formatted-text`) holding `node`, crossing shadow roots; undefined in message chrome. */
function messageBodyOf(node: Node): { body: Element; entryId: string } | undefined {
  let body: Element | undefined;
  for (let current: Node | null = node; current !== null; current = current instanceof ShadowRoot ? current.host : current.parentNode) {
    if (!(current instanceof Element)) continue;
    if (current.localName === "formatted-text") body ??= current;
    const entryId = current.getAttribute("data-entry-id");
    if (entryId !== null) return body === undefined ? undefined : { body, entryId };
  }
  return undefined;
}

/** The current selection when both its ends lie in one message's text part, with that message's entry id. */
function messageSelection(root: ShadowRoot): { entryId: string; range: Range } | undefined {
  // getComposedRanges reports the ends inside the messages' shadow roots; happy-dom lacks it but exposes them in getRangeAt.
  const selection: (Omit<Selection, "getComposedRanges"> & Partial<Pick<Selection, "getComposedRanges">>) | null = document.getSelection();
  if (selection === null || selection.rangeCount === 0) return undefined;
  const shadowRoots = [root, ...Array.from(root.querySelectorAll("formatted-text"), (element) => element.shadowRoot).filter((shadow) => shadow !== null)];
  const bounds = selection.getComposedRanges === undefined ? selection.getRangeAt(0) : selection.getComposedRanges({ shadowRoots })[0];
  if (bounds === undefined || bounds.collapsed) return undefined;
  const start = messageBodyOf(bounds.startContainer);
  if (start === undefined || start.body !== messageBodyOf(bounds.endContainer)?.body) return undefined;
  const range = document.createRange();
  range.setStart(bounds.startContainer, bounds.startOffset);
  range.setEnd(bounds.endContainer, bounds.endOffset);
  return { entryId: start.entryId, range };
}

/** Derive the `<img>` source URL and alt text for a rendered image part. */
export function chatImagePartSource(part: ChatImagePart, session?: SessionRef, machineId = "local"): { src: string; alt: string } | undefined {
  return transcriptImageSource(part, session, machineId);
}

export { chatToolOutputLabel, chatMessageGroupClassName, chatMessageGroupLabel } from "./chat/transcriptLabels";

function chatLineIdentity(index: number, message?: ChatLine): string {
  return chatLineScrollIdentity(message) ?? String(index);
}

function chatLineScrollIdentity(message?: ChatLine): string | undefined {
  if (message?.entryId === undefined || message.entryId === "") return undefined;
  // Page offsets count raw entries, whereas display indexes count normalized
  // lines. Only durable entry identity survives coalescing during a prepend.
  // Skill invocations can also produce a user-text line from the same entry.
  const slice = message.parts.some((part) => part.type === "skillInvocation") ? "skill-invocation" : "message";
  return JSON.stringify([message.entryId, message.role, slice]);
}

/** Scroll identities never fall back to normalized display indexes. */
export function chatMessageAnchorKey(_index: number, message?: ChatLine): string | undefined {
  const identity = chatLineScrollIdentity(message);
  return identity === undefined ? undefined : `m:${identity}`;
}

export function chatGroupAnchorKey(_startIndex: number, message?: ChatLine): string | undefined {
  const identity = chatLineScrollIdentity(message);
  return identity === undefined ? undefined : `g:${identity}`;
}

/** Event identity is separate from the readable slice of the same entry. */
export function chatEventAnchorKey(_index: number, message?: ChatLine): string | undefined {
  const identity = chatLineScrollIdentity(message);
  return identity === undefined ? undefined : `e:${identity}`;
}

export function chatMessageMetadataLabel(message: ChatLine): string {
  const timestamp = message.meta?.timestamp;
  const time = timestamp === undefined ? undefined : formatMessageTimestamp(timestamp);
  const model = chatMessageModelLabel(message);
  const parts = [time, model, message.meta?.thinkingLevel].filter((part): part is string => part !== undefined && part !== "");
  return parts.length === 0 ? "No Pi message metadata available" : parts.join(" · ");
}

function formatMessageTimestamp(timestamp: string): string | undefined {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  return messageTimestampFormatter.format(date);
}

function chatMessageModelLabel(message: ChatLine): string | undefined {
  const model = message.meta?.model;
  if (model === undefined) return undefined;
  const id = model.responseId ?? model.id;
  if (id === undefined || id === "") return model.provider;
  return model.provider !== undefined && model.provider !== "" ? `${model.provider}/${id}` : id;
}

/** Where the reader is in the whole conversation (0–100), and how much of it is loaded, for the conversation meter. */
export function conversationMeterPosition(input: { messageStart: number; loaded: number; total: number; hasMore: boolean; following: boolean; firstVisibleIndex: () => number | undefined }): { positionPercent: number; loadedPercent: number } {
  const total = !input.hasMore && input.messageStart === 0 ? Math.max(1, input.loaded) : Math.max(1, input.total, input.messageStart + input.loaded);
  const last = total - 1;
  const visible = input.following ? last : input.firstVisibleIndex() ?? input.messageStart;
  const index = Math.min(last, Math.max(0, Number.isFinite(visible) ? visible : input.messageStart));
  return {
    positionPercent: last <= 0 ? 100 : (index / last) * 100,
    loadedPercent: input.hasMore ? Math.min(100, (input.loaded / total) * 100) : 100,
  };
}

@customElement("chat-view")
export class ChatView extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) messages: ChatLine[] = [];
  /** A grid tile's compact transcript: tints instead of borders, half the spacing, filter on hover. */
  @property({ type: Boolean, reflect: true }) dense = false;
  @property() sessionId = "";
  @property({ attribute: false }) onNavigationChange?: (controls: TemplateResult) => void;
  @property() sessionCwd = "";
  @property({ attribute: false, hasChanged: workspaceContextChanged }) workspaceContext: MarkdownWorkspaceContext | undefined;
  @property({ attribute: false }) contentRendering: import("../formatting/contentRendering").ChatContentRendering | undefined;
  @property() machineId = "local";
  @property({ attribute: false }) messageActions: readonly RegisteredMessageAction[] = [];
  @property({ attribute: false }) messageActionContext?: Omit<MessageActionAvailabilityContext, "message">;
  @property({ attribute: false }) onMessageAction?: (input: MessageActionAvailabilityContext, actionId: string) => Promise<MessageActionResult>;
  @property({ attribute: false }) onDisplayedMessageAction?: (input: DisplayedMessageActionAvailabilityContext, actionId: string) => Promise<MessageActionResult>;
  private readonly messageActionController = new ChatMessageActionController(() => ({
    machineId: this.machineId,
    sessionId: this.sessionId,
    connected: this.isConnected,
    actions: this.messageActions,
    availability: this.messageActionContext,
    onEntry: this.onMessageAction,
    onDisplay: this.onDisplayedMessageAction,
  }), () => { this.requestUpdate(); });
  @property({ type: Number }) messageStart = 0;
  @property({ type: Number }) messageEnd = 0;
  @property({ type: Number }) messageTotal = 0;
  @property({ type: Boolean }) hasMore = false;
  @property({ type: Boolean }) historyReady = true;
  @property({ type: Boolean }) loadingMore = false;
  @property({ type: Boolean }) isSendingPrompt = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Number }) pendingMessageCount = 0;
  @property({ attribute: false }) clientQueuedMessages: QueuedSessionMessage[] = [];
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) activity?: SessionActivity;
  /** Open `ask_user` sets, oldest first; the agent keeps working while they wait. */
  @property({ attribute: false }) pendingAsks: PendingAskUser[] = [];
  @property({ attribute: false }) askDraftSessionId = "";
  @property({ attribute: false }) onSubmitAsk: ((askId: string, submission: AskUserSubmission) => void | Promise<void>) | undefined;
  @property({ attribute: false }) pendingDialogs: PendingExtensionDialog[] = [];
  @property({ attribute: false }) closedDialogs: ClosedExtensionDialog[] = [];
  @property({ attribute: false }) onAnswerDialog?: ExtensionDialogAnswerCallback;
  @property({ attribute: false }) onCancelDialog?: ExtensionDialogCancelCallback;
  @property({ attribute: false }) onDismissClosedDialog?: ExtensionDialogDismissCallback;
  @property({ attribute: false }) notificationInbox?: SelectedSessionNotificationView;
  @property({ attribute: false }) onClearServerQueue?: () => void;
  @property({ attribute: false }) onPromoteQueuedMessage?: (message: QueuedSessionMessage) => void;
  @property({ attribute: false }) onPromoteAllQueuedMessages?: () => void;
  /** A message to scroll to and flash once; a new object reveals again. */
  @property({ attribute: false }) revealTarget: ChatRevealTarget | undefined;
  /** Receives text selected inside one message; without it no Reply button appears. */
  @property({ attribute: false }) onReplyToSelection?: (quote: ReplyQuote) => void;
  @state() private replySelection: (ReplyQuote & { left: number; top: number; scrollTop: number }) | undefined;
  @state() private transcriptFilter: TranscriptFilter = "everything";
  @state() private filterMenuOpen = false;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private revealFrame: number | undefined;
  private revealedTarget: ChatRevealTarget | undefined;
  @property({ attribute: false }) onQueuedMessageAction?: (target: QueuedMessageActionTarget) => Promise<void>;
  @property({ type: Boolean }) queuedMessageActionPending = false;
  @state() private queuedCopyFeedback = "";
  @property({ attribute: false }) onDismissWarning?: (dismissId: string) => void;
  @property({ attribute: false }) onDismissNotification?: (notificationId: string) => void;
  @property({ attribute: false }) onDismissAllNotifications?: () => void;
  @property({ type: Boolean }) warningsVisible = true;
  @property({ attribute: false }) onToggleWarnings?: () => void;
  @property({ attribute: false }) onLoadMore?: () => void;
  @property({ attribute: false }) behaviors: ChatBehaviors = DEFAULT_CHAT_BEHAVIORS;
  /** Workbench presentation: bubbles with role and time, the conversation meter, one scroll-to-bottom button, wrapped tool output. */
  @property({ type: Boolean, reflect: true }) workbench = false;
  @query(".chat") private chat?: HTMLDivElement;
  @query("conversation-meter") private meter?: ConversationMeter;
  private meterFrame: number | undefined;
  @query("pi-web-image-gallery-dialog") private imageGalleryDialog?: ImageGalleryDialog;
  @state() private followingLive = false;
  @state() private expandedMetaKey: string | undefined;
  private readonly disclosures = new ChatDisclosureController();
  private readonly transientDisclosures = new Map<string, boolean>();
  private readonly scrollFlows = new ChatScrollFlows({
    getScroller: () => this.chat ?? undefined,
    onFollowingChange: (following) => { this.followingLive = following; },
    getAnchors: () => this.scrollAnchorElements(),
    getSessionId: () => this.sessionId,
    // A filtered view is a projection: it neither saves positions nor pages history on its own.
    getBehaviors: () => this.transcriptFilter === "everything" ? this.behaviors : { ...this.behaviors, rememberPosition: false, automaticHistory: false },
    hasMore: () => this.hasMore,
    isHistoryReady: () => this.historyReady,
    isLoadingMore: () => this.loadingMore || this.loadMoreRequested,
    canRequestEarlier: () => this.onLoadMore !== undefined,
    requestEarlier: () => { this.requestLoadMore(); },
    getOpenForm: (kind) => this.renderRoot.querySelector<HTMLElement>(kind === "dialog"
      ? ".chat > extension-dialog-card.open-dialog-card"
      : kind === "ask" ? ".chat > ask-user-card.open-question-card:last-of-type"
      : ".chat > ask-user-card.open-question-card, .chat > extension-dialog-card.open-dialog-card") ?? undefined,
  });
  private groupedMessagesInput?: ChatLine[];
  private groupedMessagesStart = 0;
  private groupedMessagesCache: ChatGroup[] = [];
  private readonly messageMetaCache = new WeakMap<ChatLine, string>();
  private imageSession: SessionRef | undefined;
  private touchY: number | undefined;
  private loadMoreRequested = false;
  private readonly onViewportResize = () => { this.scrollFlows.onViewportResize(); };
  // Composer growth, drawers and Grid dividers shrink the transcript without resizing the window.
  private readonly transcriptResize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(this.onViewportResize);
  private observedTranscript: Element | undefined;
  // Formatting completes independently of message updates. Reuse the existing
  // layout/restore flow without making content loading wait for enhancement.
  private readonly onContentLayoutChanged = () => { this.scrollFlows.onViewportResize(); };
  private readonly onContentLayoutWillChange = () => { this.scrollFlows.holdReadingPlace(); };
  private readonly handleScroll = () => {
    this.scrollFlows.onScroll();
    this.scheduleMeterUpdate();
    // The Reply button follows its selection.
    if (this.replySelection !== undefined) this.requestUpdate();
  };
  // Native details toggles do not bubble; capture layout changes independently
  // of the listener that remembers a group's disclosure choice.
  private readonly handleDisclosureToggle = {
    capture: true,
    handleEvent: (event: Event): void => {
      if (event.target instanceof HTMLDetailsElement) this.scrollFlows.onContentLayoutChanged();
    },
  };
  private readonly handleWheel = (event: WheelEvent) => {
    if (event.deltaY !== 0) this.scrollFlows.onInteraction();
    if (event.deltaY < 0) this.scrollFlows.onUpIntent();
  };
  private readonly handleTouchStart = (event: TouchEvent) => {
    this.touchY = event.touches[0]?.clientY;
    this.scrollFlows.onInteraction();
  };
  private readonly handleTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (this.touchY !== undefined && y !== undefined && y > this.touchY) this.scrollFlows.onUpIntent();
    this.touchY = y;
  };
  private readonly handleTouchEnd = () => { this.touchY = undefined; };
  private readonly handleJumpTop = () => { this.scrollFlows.jumpToTop(); };
  private readonly handleJumpEnd = () => { this.scrollFlows.jumpToEnd(); };
  private readonly openImageZoom = (src: string, alt: string): void => {
    if (this.behaviors.loadImages) this.imageGalleryDialog?.show([{ src, alt }]);
  };
  private openToolImageGallery(images: readonly { part: ChatImagePart; description: string }[], selectedIndex: number): void {
    if (!this.behaviors.loadImages) return;
    const entries = images.flatMap((image, index) => {
      const source = transcriptImageSource(image.part, this.transcriptSession(), this.machineId);
      return source === undefined ? [] : [{ src: source.src, alt: image.description, partIndex: index }];
    });
    const index = entries.findIndex((entry) => entry.partIndex === selectedIndex);
    if (index >= 0) this.imageGalleryDialog?.show(entries, index);
  }
  private readonly onPageHide = () => {
    this.saveScrollPosition();
  };
  private readonly handleClearServerQueue = (): void => {
    this.onClearServerQueue?.();
  };
  private readonly handleToggleWarnings = (): void => {
    this.onToggleWarnings?.();
  };
  /** Mouse, touch and keyboard selections all end up here, settled briefly so a drag does not re-render per step. */
  private readonly onSelectionChange = (): void => {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => { this.showReplyForSelection(); }, 150);
  };
  private showReplyForSelection(): void {
    const selected = this.onReplyToSelection === undefined || this.shadowRoot === null ? undefined : messageSelection(this.shadowRoot);
    const excerpt = selected?.range.toString().trim() ?? "";
    const wrapElement = this.renderRoot.querySelector<HTMLElement>(".chat-wrap");
    const wrap = wrapElement?.getBoundingClientRect();
    if (selected === undefined || excerpt === "" || wrapElement === null || wrap === undefined) {
      this.replySelection = undefined;
      return;
    }
    const rects = selected.range.getClientRects();
    const end = rects.item(rects.length - 1) ?? selected.range.getBoundingClientRect();
    // Client rects are zoomed screen pixels under the interface scale (CSS zoom); `left`/`top` are layout pixels.
    const scale = wrapElement.offsetWidth > 0 ? wrap.width / wrapElement.offsetWidth : 1;
    this.replySelection = { entryId: selected.entryId, excerpt, left: Math.max(0, Math.min((end.right - wrap.left) / scale, wrapElement.offsetWidth - 96)), top: (end.bottom - wrap.top) / scale + 6, scrollTop: this.chat?.scrollTop ?? 0 };
  }
  private readonly replyToSelection = (): void => {
    const quote = this.replySelection;
    this.replySelection = undefined;
    if (quote === undefined) return;
    document.getSelection()?.removeAllRanges();
    this.onReplyToSelection?.({ entryId: quote.entryId, excerpt: quote.excerpt });
  };
  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.replySelection !== undefined) this.replySelection = undefined;
  };
  /** A sent quote's leading `[msg id](#entry:id)` link reveals its source; look-alike `#entry:` links elsewhere do nothing. */
  private readonly onQuoteSourceClick = (event: MouseEvent): void => {
    const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    const entryId = link === undefined ? undefined : /^#entry:(.+)$/.exec(link.getAttribute("href") ?? "")?.[1];
    if (link === undefined || entryId === undefined) return;
    event.preventDefault();
    const paragraph = link.parentElement;
    const quote = paragraph?.parentElement;
    const isSource = paragraph?.localName === "p" && paragraph.firstChild === link && quote?.localName === "blockquote" && quote.firstElementChild === paragraph && (quote.parentElement?.closest("blockquote") ?? null) === null;
    if (isSource) this.revealTarget = { machineId: this.machineId, sessionId: this.sessionId, anchor: `entry:${entryId}` };
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
    window.addEventListener("pagehide", this.onPageHide);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
    document.addEventListener("keydown", this.onDocumentKeyDown);
    document.addEventListener("selectionchange", this.onSelectionChange);
  }

  override disconnectedCallback(): void {
    this.scrollFlows.dispose();
    this.transcriptResize?.disconnect();
    this.observedTranscript = undefined;
    this.messageActionController.reset();
    window.removeEventListener("resize", this.onViewportResize);
    window.removeEventListener("pagehide", this.onPageHide);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    document.removeEventListener("keydown", this.onDocumentKeyDown);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    clearTimeout(this.selectionTimer);
    if (this.revealFrame !== undefined) cancelAnimationFrame(this.revealFrame);
    this.revealFrame = undefined;
    if (this.meterFrame !== undefined) cancelAnimationFrame(this.meterFrame);
    this.meterFrame = undefined;
    super.disconnectedCallback();
  }

  private prepareSessionUiState(): void {
    if (this.behaviors.rememberDisclosures) this.disclosures.syncSession(this.sessionId);
    this.loadMoreRequested = false;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("sessionId") || changed.has("machineId") || (changed.has("behaviors") && !this.behaviors.loadImages)) this.imageGalleryDialog?.close();
    if (changed.has("sessionId") || changed.has("machineId")) {
      this.transientDisclosures.clear();
      this.queuedCopyFeedback = "";
      this.transcriptFilter = "everything";
      this.filterMenuOpen = false;
      this.replySelection = undefined;
    }
    if (changed.has("sessionId") || changed.has("machineId")) {
      this.messageActionController.reset();
    }
    if (changed.has("sessionId")) {
      this.prepareSessionUiState();
    }
    if (changed.has("behaviors") || changed.has("transcriptFilter")) {
      this.scrollFlows.configure();
      if (this.behaviors.rememberDisclosures) this.disclosures.syncSession(this.sessionId);
    }
  }

  protected override update(changed: Map<string, unknown>): void {
    const previousStart = changed.get("messageStart");
    this.scrollFlows.beforeRender({
      sessionChanged: changed.has("sessionId") || changed.has("machineId"),
      previousSessionId: changed.get("sessionId"),
      prepend: typeof previousStart === "number" && this.messageStart < previousStart,
    });
    super.update(changed);
  }

  protected override updated(changed: Map<string, unknown>): void {
    const transcript = this.chat ?? undefined;
    if (transcript !== undefined && transcript !== this.observedTranscript) {
      this.transcriptResize?.disconnect();
      this.transcriptResize?.observe(transcript);
      this.observedTranscript = transcript;
    }
    if (changed.has("loadingMore") && !this.loadingMore) this.loadMoreRequested = false;
    if (changed.has("hasMore") && !this.hasMore) this.loadMoreRequested = false;
    this.scrollFlows.afterRender({
      sessionChanged: changed.has("sessionId") || changed.has("machineId"),
      contentChanged: this.scrollContentChanged(changed),
      historyChanged: changed.has("messages") || changed.has("messageStart") || changed.has("hasMore") || changed.has("loadingMore") || changed.has("historyReady"),
      openedForm: changed.has("pendingDialogs") && this.isNewOpenDialog(changed.get("pendingDialogs")) ? "dialog"
        : changed.has("pendingAsks") && this.isNewPendingAsk(changed.get("pendingAsks")) ? "ask" : false,
    });
    if (changed.has("messages") || changed.has("messageStart") || changed.has("messageTotal") || changed.has("hasMore") || changed.has("followingLive") || changed.has("workbench")) this.scheduleMeterUpdate();
    if (changed.has("revealTarget") || changed.has("sessionId") || changed.has("messages") || changed.has("pendingAsks") || changed.has("pendingDialogs")) this.scheduleReveal();
    // A filtered view is a projection: returning to Everything returns to the place saved when it was left.
    if (changed.get("transcriptFilter") !== undefined && this.transcriptFilter === "everything") this.scrollFlows.restorePosition();
    if (changed.has("followingLive") || changed.has("behaviors") || changed.has("onNavigationChange")) {
      this.onNavigationChange?.(this.renderNavigation());
    }
  }

  private readonly renderKeys = new ChatRenderKeys();

  override render() {
    const sourceGroups = filterChatGroups(this.groupedMessages(), this.transcriptFilter);
    const entryActionHeaders = canonicalEntryActionHeaders(sourceGroups);
    const groups = groupConsecutiveImageOutputs(sourceGroups);
    // Keep incremental updates within one transcript, but dispose the whole
    // repeat part when the transcript changes. Besides preventing cross-session
    // DOM reuse, clearing the part reclaims the end markers that the current Lit
    // build retains when repeat items are removed.
    const transcriptIdentity = machineSessionKey(this.machineId, this.sessionId);
    const seen = new Map<string, number>();
    const keys = this.renderKeys.reconcile(transcriptIdentity, groups.map((group) => {
      const source = group.kind === "tool-images" ? group.outputs[0] : group;
      const index = source.kind === "group" ? source.startIndex : source.index;
      const message = source.kind === "group" ? source.messages[0]?.message : source.message;
      const presentation = source.kind === "group" ? source.presentation : undefined;
      const identity = chatLineScrollIdentity(message);
      // One entry can split into several groups of a kind (thinking, then activity); repeat keys must stay unique.
      const base = JSON.stringify([group.kind, presentation, identity ?? index, message?.role]);
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return {
        slot: JSON.stringify([base, occurrence]),
        ...(identity === undefined ? {} : { identity: JSON.stringify([group.kind, presentation, identity, occurrence]) }),
      };
    }));
    const exchange = this.transcriptFilter === "everything"
      ? currentExchangeGroups(this.messages, groups, this.messageStart, this.hasMore)
      : { history: [], current: groups, startsOutsideLoadedPage: false };
    const renderGroups = (slice: ChatDisplayGroup[], offset: number) => repeat(
      slice,
      (_group, index) => keys[offset + index],
      (group, index) => {
        if (group.kind === "group") return this.renderMessageGroup(group, this.isLiveTailGroup(groups, offset + index), entryActionHeaders);
        if (group.kind === "tool-images") return this.renderToolImageOutputs(group, entryActionHeaders);
        return this.renderMessage(group.message, group.index, entryActionHeaders);
      },
    );
    return html`
      ${this.renderTopNotices()}
      <div class=${this.behaviors.visualEffects ? "chat-wrap" : "chat-wrap plain"}>
        ${this.renderTranscriptFilter()}
        <div class="chat" @click=${this.onQuoteSourceClick} @image-open=${(event: CustomEvent<ImageOpenDetail>) => { this.openImageZoom(event.detail.src, event.detail.alt); }}
          ?data-holds-place=${this.behaviors.holdReadingPlace}
          @scroll=${this.behaviors.rememberPosition || this.behaviors.followTail || this.behaviors.automaticHistory || this.behaviors.holdReadingPlace || this.replySelection !== undefined ? this.handleScroll : undefined}
          @toggle=${this.behaviors.followTail ? this.handleDisclosureToggle : undefined}
          @content-layout-will-change=${this.onContentLayoutWillChange}
          @content-layout-changed=${this.onContentLayoutChanged}
          @wheel=${this.handlesScrollIntent ? this.handleWheel : undefined}
          @touchstart=${this.handlesScrollIntent ? this.handleTouchStart : undefined}
          @touchmove=${this.handlesScrollIntent ? this.handleTouchMove : undefined}
          @touchend=${this.handlesScrollIntent ? this.handleTouchEnd : undefined}
          @touchcancel=${this.handlesScrollIntent ? this.handleTouchEnd : undefined}>
          ${this.renderHistoryBoundary()}
          ${keyed(transcriptIdentity, html`
            ${exchange.history.length === 0 ? nothing : html`
              <details class="exchange-history" open>
                <summary>Earlier conversation · ${exchange.history.length} ${exchange.history.length === 1 ? "item" : "items"}</summary>
                <div class="exchange-history-body">${renderGroups(exchange.history, 0)}</div>
              </details>
            `}
            ${exchange.startsOutsideLoadedPage ? html`<div class="exchange-boundary" role="note">Current loaded tail · the latest user message is in earlier history</div>` : nothing}
            ${renderGroups(exchange.current, exchange.history.length)}
          `)}
          ${this.transcriptFilter !== "everything" && groups.length === 0 ? html`<p class="filter-empty" role="status">No messages matching ${this.filterLabel()} in loaded history.${this.hasMore ? " Load earlier messages to continue." : ""}</p>` : nothing}
          ${this.renderQueuedMessages()}
          ${this.renderSessionActivity()}
          ${this.renderOpenAsks()}
          ${this.renderExtensionDialogs()}
        </div>
        ${this.renderReplySelection()}
        ${this.workbench && this.messages.length > 0 ? html`<conversation-meter ?dense=${this.dense}></conversation-meter>` : nothing}
        ${this.onNavigationChange !== undefined ? nothing : this.workbench ? this.renderScrollToBottom() : this.renderNavigation()}
      </div>
      <pi-web-image-gallery-dialog></pi-web-image-gallery-dialog>
    `;
  }

  private renderScrollToBottom() {
    if (this.behaviors.followTail && this.followingLive) return nothing;
    // Lucide "chevron-down".
    return html`<button type="button" class="scroll-to-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" @click=${this.handleJumpEnd}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"></path></svg>
    </button>`;
  }

  /** Scrolling moves only the meter's marker, never a ChatView render. */
  private scheduleMeterUpdate(): void {
    if (!this.workbench || this.meterFrame !== undefined) return;
    this.meterFrame = requestAnimationFrame(() => {
      this.meterFrame = undefined;
      // @query yields null before the element renders.
      const meter = this.meter ?? undefined;
      const chat = this.chat ?? undefined;
      if (meter === undefined || chat === undefined) return;
      const position = conversationMeterPosition({ messageStart: this.messageStart, loaded: this.messages.length, total: this.messageTotal, hasMore: this.hasMore, following: this.followingLive,
        firstVisibleIndex: () => {
          const top = chat.getBoundingClientRect().top;
          const first = [...chat.querySelectorAll<HTMLElement>("[data-index]")].find((element) => element.getBoundingClientRect().bottom > top + 1);
          return first === undefined ? undefined : Number(first.dataset["index"]);
        } });
      meter.positionPercent = position.positionPercent;
      meter.loadedPercent = position.loadedPercent;
    });
  }

  private renderNavigation() {
    const following = this.behaviors.followTail && this.followingLive;
    return html`<nav class="chat-jumps" aria-label="Chat navigation">
      <button type="button" title="Jump to top" aria-label="Jump to top" @click=${this.handleJumpTop}>↑</button>
      <button type="button" class=${following ? "following" : ""}
        title=${!this.behaviors.followTail ? "Jump to end" : following ? "Following live — jump to end" : "Jump to end and follow live"}
        aria-label="Jump to end" aria-describedby="chat-follow-state" @click=${this.handleJumpEnd}>↓</button>
      <span id="chat-follow-state" class="chat-follow-state">${!this.behaviors.followTail ? "Automatic following disabled" : following ? "Following live" : "Live following paused"}</span>
    </nav>`;
  }

  private renderTopNotices() {
    return html`<div class="top-notices">
      ${this.renderWarnings()}
      <session-notification-tray
        .sessionId=${this.sessionId}
        .notificationInbox=${this.notificationInbox}
        .onDismissNotification=${this.onDismissNotification}
        .onDismissAllNotifications=${this.onDismissAllNotifications}
      ></session-notification-tray>
    </div>`;
  }

  private renderWarnings() {
    const rows = chatSessionWarningRows(this.status);
    if (!this.warningsVisible || rows.length === 0) return null;
    return renderSessionWarnings(rows,
      this.onToggleWarnings === undefined ? undefined : this.handleToggleWarnings,
      this.onDismissWarning,
    );
  }

  private groupedMessages(): ChatGroup[] {
    if (this.groupedMessagesInput === this.messages && this.groupedMessagesStart === this.messageStart) return this.groupedMessagesCache;
    this.groupedMessagesInput = this.messages;
    this.groupedMessagesStart = this.messageStart;
    this.groupedMessagesCache = groupChatMessages(this.messages, this.messageStart);
    return this.groupedMessagesCache;
  }

  private isLiveTailGroup(groups: readonly ChatDisplayGroup[], index: number): boolean {
    return index === groups.length - 1 && this.isSessionLive();
  }

  private isSessionLive(): boolean {
    return this.isSendingPrompt
      || this.status?.isStreaming === true
      || this.status?.isCompacting === true
      || this.status?.isBashRunning === true
      || this.activity?.phase === "active";
  }

  private renderQueuedMessages() {
    const serverQueued = this.status?.queuedMessages ?? [];
    return html`${chatQueuedMessageSections(this.clientQueuedMessages, serverQueued).map((section) => this.renderQueuedMessageList(section))}
      ${this.queuedCopyFeedback === "" ? nothing : html`<small role="status">${this.queuedCopyFeedback}</small>`}`;
  }

  private renderQueuedMessageList(section: QueuedMessageSection) {
    return renderQueuedMessageSection(section, {
      machineId: this.machineId,
      sessionId: this.sessionId,
      behaviors: this.behaviors,
      contentRendering: this.contentRendering,
      workspaceContext: this.workspaceContext,
      pending: this.queuedMessageActionPending,
      unavailable: this.status?.queueMessageActionsUnavailable,
      onClear: this.onClearServerQueue === undefined ? undefined : this.handleClearServerQueue,
      onCopy: (text) => { void this.copyQueuedMessage(text); },
      onAction: this.onQueuedMessageAction === undefined ? undefined : (action, index, messages) => { this.actOnQueuedMessage(action, index, messages); },
      onPromote: this.onPromoteQueuedMessage,
      onPromoteAll: this.onPromoteAllQueuedMessages,
      compacting: this.status?.isCompacting === true,
    });
  }

  private async copyQueuedMessage(text: string): Promise<void> {
    const identity = machineSessionKey(this.machineId, this.sessionId);
    const copied = await writeClipboardText(text);
    if (this.isConnected && identity === machineSessionKey(this.machineId, this.sessionId)) {
      this.queuedCopyFeedback = copied ? "" : "Could not copy message";
    }
  }

  private actOnQueuedMessage(action: QueuedMessageAction, index: number, messages: QueuedSessionMessage[]): void {
    if (this.queuedMessageActionPending || this.status?.queueMessageActionsUnavailable !== undefined) return;
    void this.onQueuedMessageAction?.({ machineId: this.machineId, sessionId: this.sessionId, action, index, expectedQueue: messages.map((message) => ({ ...message })) });
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
            .outcome=${closed}
            .onDismiss=${this.onDismissClosedDialog}
          ></extension-dialog-card>
        `,
      )}
      ${open === undefined ? null : html`
        <extension-dialog-card
          class="open-dialog-card"
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
      <aside class="session-activity compacting ui-transcript-surface" aria-live="polite">
        <strong>Compacting history…</strong>
        <span>The agent is summarizing earlier context. New prompts will be queued until compaction finishes.</span>
        ${this.pendingMessageCount > 0 ? html`<small>${this.pendingMessageCount} queued ${this.pendingMessageCount === 1 ? "message" : "messages"}</small>` : null}
      </aside>
    `;
  }

  private renderHistoryBoundary() {
    const range = this.historyRangeLabel();
    if (this.loadingMore) return html`<div class="history-boundary"><span>Loading earlier messages…</span>${range}</div>`;
    if (this.hasMore) return html`
      <div class="history-boundary">
        <button type="button" class="history-load-button ui-button ui-button--compact" ?disabled=${this.loadMoreRequested} @click=${() => { this.requestLoadMore(); }}>Load earlier messages</button>
        ${this.behaviors.automaticHistory ? html`<span>Scroll up to load earlier messages</span>` : null}
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

  private transcriptRenderContext(): TranscriptRenderContext {
    return {
      machineId: this.machineId,
      sessionId: this.sessionId,
      session: this.transcriptSession(),
      messages: this.messages,
      messageStart: this.messageStart,
      behaviors: this.behaviors,
      contentRendering: this.contentRendering,
      workspaceContext: this.workspaceContext,
      anchors: { message: chatMessageAnchorKey, event: chatEventAnchorKey },
      disclosure: {
        isOpen: (key, defaultOpen) => this.isDisclosureOpen(key, defaultOpen),
        toggle: (key, event, defaultOpen) => { this.onDisclosureToggle(key, event, defaultOpen); },
      },
      metadata: {
        expandedKey: this.expandedMetaKey,
        label: (message) => this.messageMetaLabel(message),
        expand: (key) => { this.expandedMetaKey = key; },
      },
      actions: this.messageActionController,
      askDraftSessionId: this.askDraftSessionId,
      openImageGallery: (images, index) => { this.openToolImageGallery(images, index); },
    };
  }

  private renderMessage(message: ChatLine, index: number, entryActionHeaders: ReadonlySet<ChatLine>) {
    return transcript.renderMessage(this.transcriptRenderContext(), message, index, entryActionHeaders);
  }

  private renderToolImageOutputs(group: Extract<ChatDisplayGroup, { kind: "tool-images" }>, entryActionHeaders: ReadonlySet<ChatLine>) {
    return transcript.renderToolImageOutputs(this.transcriptRenderContext(), group, entryActionHeaders);
  }

  private renderMessageGroup(group: Extract<ChatGroup, { kind: "group" }>, live: boolean, entryActionHeaders: ReadonlySet<ChatLine> = new Set()) {
    // Reasoning stays open; routine activity and compacted history fold away even on the live tail.
    const defaultOpen = group.presentation === "thinking" || (group.presentation === undefined && live);
    const disclosureKey = this.groupDisclosureKey(group, defaultOpen);
    const open = this.isDisclosureOpen(disclosureKey, defaultOpen);
    return transcript.renderMessageGroup(this.transcriptRenderContext(), group, defaultOpen, entryActionHeaders, {
      open,
      anchor: this.groupAnchorKey(group, defaultOpen),
      toggle: (event) => { this.onDisclosureToggle(disclosureKey, event, defaultOpen); },
    });
  }

  private messageMetaLabel(message: ChatLine): string {
    const cached = this.messageMetaCache.get(message);
    if (cached !== undefined) return cached;
    const label = chatMessageMetadataLabel(message);
    this.messageMetaCache.set(message, label);
    return label;
  }

  private transcriptSession(): SessionRef {
    if (this.imageSession?.id !== this.sessionId || this.imageSession.cwd !== this.sessionCwd) {
      this.imageSession = { id: this.sessionId, cwd: this.sessionCwd };
    }
    return this.imageSession;
  }

  private isDisclosureOpen(key: string, defaultOpen: boolean): boolean {
    return this.behaviors.rememberDisclosures
      ? this.disclosures.isOpen(key, defaultOpen)
      : this.transientDisclosures.get(key) ?? defaultOpen;
  }

  private onDisclosureToggle(key: string, event: Event, defaultOpen: boolean) {
    const details = event.currentTarget;
    if (!(details instanceof HTMLDetailsElement)) return;
    const changed = this.isDisclosureOpen(key, defaultOpen) !== details.open;
    if (this.behaviors.rememberDisclosures) this.disclosures.applyToggle(key, details.open, defaultOpen);
    else this.transientDisclosures.set(key, details.open);
    if (changed) this.requestUpdate();
  }

  private get handlesScrollIntent(): boolean {
    return this.behaviors.followTail || this.behaviors.rememberPosition;
  }

  private scrollContentChanged(changed: Map<string, unknown>): boolean {
    return changed.has("messages") || changed.has("historyReady") || changed.has("messageEnd") || changed.has("messageTotal") || changed.has("pendingAsks") || changed.has("pendingDialogs") || changed.has("closedDialogs") || changed.has("transcriptFilter");
  }

  private requestLoadMore(): void {
    if (this.loadMoreRequested || !this.hasMore || this.loadingMore || this.onLoadMore === undefined) return;
    this.loadMoreRequested = true;
    this.onLoadMore();
  }

  /** True when an ask appeared that the previous list did not hold. */
  private isNewPendingAsk(previous: unknown): boolean {
    const known: unknown[] = Array.isArray(previous) ? previous : [];
    return this.pendingAsks.some((ask) => !known.some((old) => typeof old === "object" && old !== null && "askId" in old && old.askId === ask.askId));
  }

  private renderOpenAsks() {
    return repeat(this.pendingAsks, (ask) => ask.askId, (ask) => html`
      <ask-user-card
        class="open-question-card"
        data-scroll-anchor-id=${`ask:${ask.askId}`}
        .ask=${ask}
        .draftSessionId=${this.askDraftSessionId}
        .workspaceContext=${this.workspaceContext}
        .onSubmit=${this.onSubmitAsk}
      ></ask-user-card>
    `);
  }

  private renderTranscriptFilter() {
    return html`<div class="transcript-filter" @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape" && this.filterMenuOpen) { event.stopPropagation(); this.filterMenuOpen = false; this.renderRoot.querySelector<HTMLButtonElement>(".filter-toggle")?.focus(); } }} @focusout=${(event: FocusEvent) => { if (event.currentTarget instanceof HTMLElement && (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))) this.filterMenuOpen = false; }}>
      <button type="button" class="filter-toggle" aria-label=${`Filter transcript: ${this.filterLabel()}`} title=${`Filter transcript: ${this.filterLabel()}`} aria-expanded=${String(this.filterMenuOpen)} data-filter-active=${String(this.transcriptFilter !== "everything")} aria-controls=${this.filterMenuOpen ? "transcript-filter-options" : nothing} @click=${() => { this.filterMenuOpen = !this.filterMenuOpen; }}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6h16M7 12h10m-7 6h4"></path></svg>
      </button>
      ${this.filterMenuOpen ? html`<div id="transcript-filter-options" class="filter-options" role="group" aria-label="Transcript messages">
        ${this.transcriptFilter === "everything" ? null : this.renderFilterOption("everything", "Everything")}
        ${this.renderFilterOption("human", "Human only")}
        ${this.renderFilterOption("assistant", "Assistant only")}
        ${this.renderFilterOption("human-assistant", "Human + Assistant")}
      </div>` : null}
    </div>`;
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

  private renderReplySelection() {
    const selection = this.replySelection;
    if (selection === undefined) return null;
    const top = selection.top - ((this.chat?.scrollTop ?? 0) - selection.scrollTop);
    // Lucide "reply".
    return html`<button type="button" class="reply-selection" aria-label="Reply to selection" title="Reply to selection" style=${`left: ${String(selection.left)}px; top: ${String(top)}px`} @mousedown=${(event: MouseEvent) => { event.preventDefault(); }} @click=${this.replyToSelection}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path><path d="m9 17-5-5 5-5"></path></svg><span>Reply</span>
    </button>`;
  }

  /** Runs after scroll restoration, so the revealed message wins over the saved position. */
  private scheduleReveal(): void {
    const target = this.revealTarget;
    if (target === undefined || target === this.revealedTarget || this.revealFrame !== undefined) return;
    this.revealFrame = requestAnimationFrame(() => {
      this.revealFrame = undefined;
      if (this.revealTarget !== target || target.sessionId !== this.sessionId || target.machineId !== this.machineId) return;
      const element = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-entry-id], [data-scroll-anchor-id]"))
        .find((candidate) => candidate.getAttribute("data-scroll-anchor-id") === target.anchor || `entry:${candidate.getAttribute("data-entry-id") ?? ""}` === target.anchor);
      const chat = this.chat;
      if (element === undefined || chat === undefined) {
        // ponytail: an anchor outside the loaded page keeps the usual restored position; page back to it if owners miss it.
        if (this.messages.length > 0 || this.pendingAsks.length > 0 || this.pendingDialogs.length > 0) this.revealedTarget = target;
        return;
      }
      this.revealedTarget = target;
      for (let details = element.closest("details"); details !== null; details = details.parentElement?.closest("details") ?? null) details.open = true;
      chat.scrollTop += element.getBoundingClientRect().top - chat.getBoundingClientRect().top;
      this.scrollFlows.onScroll();
      element.setAttribute("data-notification-reveal", "");
      setTimeout(() => { element.removeAttribute("data-notification-reveal"); }, 2000);
    });
  }

  private isNewOpenDialog(previous: unknown): boolean {
    const oldest = this.pendingDialogs[0];
    if (oldest === undefined) return false;
    if (!Array.isArray(previous)) return true;
    const previousOldest: unknown = previous[0];
    return typeof previousOldest !== "object" || previousOldest === null || Reflect.get(previousOldest, "dialogId") !== oldest.dialogId;
  }

  /** Public navigation hooks; the position-memory flow owns their effects. */
  restoreScrollPosition(): void {
    this.scrollFlows.restorePosition();
  }

  saveScrollPosition(sessionId = this.sessionId): void {
    this.scrollFlows.savePosition(sessionId);
  }

  private scrollAnchorElements(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"));
  }

  private groupDisclosureKey(group: Extract<ChatGroup, { kind: "group" }>, defaultOpen: boolean): string {
    return defaultOpen
      ? `${this.sessionId}:live:${chatLineIdentity(group.startIndex, group.messages[0]?.message)}`
      : `${this.sessionId}:${chatLineIdentity(group.endIndex, group.messages.at(-1)?.message)}`;
  }


  private groupAnchorKey(group: Extract<ChatGroup, { kind: "group" }>, live: boolean): string | undefined {
    // Historical groups can absorb earlier events; live groups grow at the end.
    // Skip transient members rather than persisting their display indexes.
    const durableIdentities = group.messages
      .map(({ message }) => chatLineScrollIdentity(message))
      .filter((identity): identity is string => identity !== undefined);
    const identity = live ? durableIdentities[0] : durableIdentities.at(-1);
    if (identity === undefined) return undefined;
    return live ? `g:${identity}` : `g-end:${identity}`;
  }

  // Workbench additions on the base chat theme: filter, reply, reveal, folds, cards, and the dense grid tile.
  static override styles = [chatStyles, css`
    /* holdReadingPlace: the scroll flows keep the reading place, so the browser must not move it too. */
    .chat[data-holds-place] { overflow-anchor: none; }
    [data-notification-reveal] { animation: notification-reveal 2s ease-out; }
    @keyframes notification-reveal { from { box-shadow: 0 0 0 2px var(--pi-accent); background-color: var(--pi-selection-bg); } }
    @media (prefers-reduced-motion: reduce) { [data-notification-reveal] { animation: none; outline: 2px solid var(--pi-accent); } }
    .reply-selection { position: absolute; z-index: 23; display: flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); box-shadow: 0 2px 8px var(--pi-shadow); font: inherit; font-size: 12px; cursor: pointer; }
    .reply-selection:hover, .reply-selection:focus-visible { border-color: var(--pi-accent); color: var(--pi-text-bright); outline: none; }
    .reply-selection svg, .filter-toggle svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .transcript-filter { position: absolute; z-index: 22; top: 6px; right: 10px; }
    .filter-toggle, .filter-options button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); cursor: pointer; }
    .filter-toggle { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; opacity: .7; }
    .filter-toggle:hover, .filter-toggle:focus-visible, .filter-toggle[aria-expanded="true"] { opacity: 1; }
    .filter-toggle[data-filter-active="true"] { opacity: 1; color: var(--pi-accent); border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    .filter-options { position: absolute; top: calc(100% + 4px); right: 0; display: grid; gap: 4px; padding: 6px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 4px 12px #0003; }
    .filter-options button { min-height: 30px; padding: 4px 10px; text-align: left; white-space: nowrap; }
    .filter-options button[aria-pressed="true"] { border-color: var(--pi-accent); }
    .transcript-filter button:focus-visible { outline: 2px solid var(--pi-accent); }
    @media (forced-colors: active) {
      .filter-toggle[data-filter-active="true"], .filter-options button[aria-pressed="true"] { color: Highlight; border-color: Highlight; }
      .transcript-filter button:focus-visible { outline-color: Highlight; }
    }
    .filter-empty { margin: 12px 16px; color: var(--pi-muted); }
    .exchange-history > summary { padding: 6px 16px; color: var(--pi-muted); font-size: 12px; }
    .exchange-boundary { padding: 6px 16px; color: var(--pi-muted); font-size: 12px; }
    .msg.event-group > summary strong { color: var(--pi-text); font-weight: 600; }
    .msg.event-group > summary .group-note { margin-inline-start: auto; font-size: 11px; text-transform: uppercase; }
    .history-group { --ui-activity-tone: var(--pi-accent); }
    .thinking-group > .thinking-text { display: block; padding: 8px 12px; color: var(--pi-text-secondary); font-style: italic; }
    .tool-fold { margin: 0; padding: 2px 12px; }
    .tool-fold > summary { display: inline-flex; align-items: center; gap: 5px; padding: 2px 4px 2px 0; border-radius: 4px; color: var(--pi-muted); font-size: 12px; list-style: none; cursor: pointer; }
    .tool-fold > summary::-webkit-details-marker { display: none; }
    .tool-fold > summary:hover { color: var(--pi-text); }
    .tool-fold > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .tool-fold .running { color: var(--pi-text); }
    .tool-fold > .group-body { padding: 2px 0 2px 17px; }
    .chevron { flex: 0 0 auto; display: inline-grid; transition: transform .12s ease; }
    .chevron .tab-icon { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    details[open] > summary .chevron { transform: rotate(90deg); }
    .tool-call-arguments { margin: 0; padding: 8px 12px; font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .skill-read { padding: 2px 0; color: var(--pi-purple); font-size: 12px; }
    .msg.skill-read-shell { padding: 4px 16px; }
    .msg.goal-lifecycle-shell, .msg.subagent-completion-shell { padding: 6px 16px; }
    .msg.error, .group-msg.error { color: var(--pi-danger); }
    .msg.warning, .group-msg.warning { color: var(--pi-warning); }
    .goal-lifecycle, .background-bash-card { border-inline-start: 3px solid var(--pi-accent); padding: 6px 12px; color: var(--pi-text); background: var(--pi-surface); }
    .goal-lifecycle > summary, .background-bash-card > summary { cursor: pointer; }
    .goal-lifecycle > summary { font-weight: 600; }
    .goal-lifecycle > div { margin-top: 6px; overflow-wrap: anywhere; }
    .working-mode-card { color: var(--pi-muted); font-size: 0.9em; }
    .working-mode-card > summary { display: flex; align-items: center; gap: 6px; list-style: none; cursor: pointer; }
    .working-mode-card > summary::-webkit-details-marker { display: none; }
    .working-mode-card > summary:hover, .working-mode-card[open] { color: var(--pi-text); }
    .working-mode-icon { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: var(--pi-accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .working-mode-summary { min-width: 0; overflow-wrap: anywhere; }
    .working-mode-card dl { margin: 8px 0 2px 20px; }
    .working-mode-card dt { font-weight: 600; margin-top: 6px; }
    .working-mode-card dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    .working-mode-card p { margin: 8px 0 2px; }
    .background-bash-card > summary { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .background-bash-command { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .background-bash-full-command { display: block; white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0; }
    .background-bash-output { max-height: 240px; overflow: auto; white-space: pre; font: 12px var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .background-bash-log { display: flex; align-items: center; gap: 8px; }
    .background-bash-log code { overflow-wrap: anywhere; min-width: 0; }
    .subagent-completion { color: var(--pi-muted); font-size: 12px; }
    .subagent-completion > summary { width: fit-content; }
    .subagent-completion-instruction { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--pi-text); }
    :is(.goal-lifecycle, .background-bash-card, .working-mode-card, .subagent-completion) > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .queued-send-now-button, .queued-send-all-button { color: var(--pi-warning); }
    .chat > ask-user-card.open-question-card { display: block; margin: 8px 12px; }
    /* Dense (a grid tile): tints separate the roles; spacing halves; the filter shows on hover. */
    :host([dense]) .transcript-filter { top: 4px; right: 6px; opacity: 0; transition: opacity .12s ease; }
    :host([dense]:hover) .transcript-filter, :host([dense]) .transcript-filter:focus-within { opacity: 1; }
    :host([dense]) .filter-toggle, :host([dense]) .filter-options button { border: 0; background: var(--pi-surface-hover); }
    :host([dense]) .msg { padding: 6px 8px 8px; }
    :host([dense]) .msg.conversation-layout { padding: 0; }
    :host([dense]) .conversation-body { padding: 6px 8px; }
    :host([dense]) .transcript-content { padding: 4px 8px; }
    :host([dense]) .part + .part { margin-top: 4px; }
    :host([dense]) .msg.skill-read-shell, :host([dense]) .msg.goal-lifecycle-shell, :host([dense]) .msg.subagent-completion-shell { padding: 2px 8px; }
    :host([dense]) .tool-fold { padding: 1px 8px; }
    :host([dense]) .thinking-group > .thinking-text { padding: 4px 8px; }
    :host([dense]) .exchange-history > summary, :host([dense]) .exchange-boundary { padding: 4px 8px; }
    /* Workbench presentation: rounded role bubbles with an inline role and time, wrapped tool output, one scroll-to-bottom button. */
    .msg-heading { display: none; }
    :host([workbench]) { --pi-tool-output-white-space: pre-wrap; --pi-tool-output-overflow-wrap: anywhere; }
    :host([workbench]) .msg.conversation-message { --ui-transcript-bg: var(--pi-surface); margin: 0 var(--pi-panel-padding, 10px) var(--pi-message-gap, 10px); border: 1px solid var(--pi-border); border-radius: 14px; overflow-wrap: anywhere; }
    :host([workbench]) .msg.user.conversation-message { --ui-transcript-bg: color-mix(in srgb, var(--pi-accent) 10%, var(--pi-surface)); border-color: color-mix(in srgb, var(--pi-accent) 30%, var(--pi-border)); }
    :host([workbench]) .conversation-body { padding: var(--pi-message-padding, 10px) calc(var(--pi-message-padding, 10px) + 2px); }
    :host([workbench]) .conversation-content > .msg-header.conversation-header { inset-block-end: 4px; inset-inline-end: 6px; }
    :host([workbench]) .msg-heading { display: flex; align-items: baseline; gap: 5px; min-width: 0; margin-bottom: 6px; overflow: hidden; color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
    .msg-role { font-weight: normal; text-transform: uppercase; color: var(--pi-text-secondary); }
    .msg.user .msg-role { color: var(--pi-accent); }
    .msg-time { min-width: 0; overflow: hidden; color: var(--pi-dim); font-size: 11px; text-overflow: ellipsis; }
    .scroll-to-bottom { position: absolute; left: 50%; bottom: 12px; z-index: 21; display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid var(--pi-border); border-radius: 50%; background: var(--pi-bg-overlay, var(--pi-surface)); color: var(--pi-text); box-shadow: 0 4px 12px var(--pi-shadow); transform: translateX(-50%); cursor: pointer; }
    .scroll-to-bottom:hover, .scroll-to-bottom:focus-visible { border-color: var(--pi-accent); color: var(--pi-text-bright); }
    .scroll-to-bottom:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .scroll-to-bottom svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    /* Dense tiles: tints instead of borders, and the role and time float inline at the start of the first line. */
    :host([workbench][dense]) .msg.conversation-message { margin: 0 6px 5px; border: 0; border-radius: 6px; }
    :host([workbench][dense]) .msg.assistant.conversation-message { --ui-transcript-bg: transparent; }
    :host([workbench][dense]) .msg.user.conversation-message { --ui-transcript-bg: color-mix(in srgb, var(--pi-accent) 12%, transparent); }
    :host([workbench][dense]) .conversation-body { padding: 3px 8px; }
    :host([workbench][dense]) .msg-heading { float: left; height: 21px; margin: 0 8px 0 0; }
    :host([workbench][dense]) .msg-role { font-size: 10px; font-weight: 700; letter-spacing: .04em; }
    :host([workbench][dense]) .msg-time { font-size: 10px; }
    :host([dense]) conversation-meter { opacity: 0; transition: opacity .15s ease; }
    :host([dense]:hover) conversation-meter { opacity: .5; }
    :host([dense]) .scroll-to-bottom { width: 28px; height: 28px; bottom: 8px; border: 0; background: var(--pi-surface-hover); box-shadow: 0 2px 8px var(--pi-shadow-soft, transparent); }
  `];
}
