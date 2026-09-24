import type {
  AskUserCloseResponse,
  AskUserSubmission,
  ExtensionDialogAnswer,
  ExtensionDialogCloseResponse,
  SavedPromptAttachment,
  SessionBulkArchiveResponse,
  SessionBulkDeleteArchivedResponse,
  SessionBulkMutationRef,
  SessionNotificationCatalogSnapshot,
  SessionNotificationDismissAllRequest,
  SessionNotificationDismissRequest,
  SessionNotificationInboxSnapshot,
  SessionModelScopeMode,
  SessionDefaults,
  SessionDefaultsUpdate,
  SessionUnreadAcknowledgeRequest,
  SessionUnreadCatalogSnapshot,
  SessionTopicSnapshot,
  SessionTopicSummary,
} from "../../shared/apiTypes.js";
import type {
  ClientArchiveSessionsResponse,
  ClientCommand,
  ClientCommandResult,
  ClientMessagePage,
  ClientSession,
  ClientSessionCleanupExecuteResponse,
  ClientSessionCleanupPreviewResponse,
  ClientSessionModel,
  ClientSessionModelCatalogEntry,
  ClientSessionRef,
  ClientSessionStatus,
  ClientSessionTreeForkRequest,
  ClientSessionTreeForkResult,
  ClientSessionTreeNavigateRequest,
  ClientSessionTreeNavigateResult,
  ClientThinkingLevel,
  SessionStreamSnapshot,
} from "../types.js";
import type { NormalizedSessionCleanupRequest } from "./sessionCleanup.js";

export type SessionRouteRef = ClientSessionRef;

/**
 * Route-facing session contract for PI WEB's HTTP/WebSocket API.
 *
 * Keep transport concerns separate from the bundled Pi SDK implementation so
 * routes remain testable. Pi-specific lifecycle hooks such as auth-change
 * handling and daemon shutdown stay on the concrete service.
 */
export interface SessionRouteService {
  list(cwd: string): Promise<ClientSession[]>;
  listRecent(limit: number): Promise<ClientSession[]>;
  /**
   * Create a session. Most startup tokens are ephemeral progress labels;
   * Workstream launch tokens are reserved and recorded for exact reconciliation.
   */
  start(cwd: string, options?: { startupToken?: string }): Promise<ClientSession>;
  /** Unknown never proves non-creation. Only a live or persisted exact match is found. */
  lookupWorkstreamLaunch(token: string, cwd: string): Promise<{ status: "found"; sessionId: string; cwd: string } | { status: "unknown" }>;
  messages(ref: SessionRouteRef, page?: { before?: number; limit?: number }): Promise<ClientMessagePage>;
  topics(ref: SessionRouteRef): Promise<{ topics: SessionTopicSummary[] }>;
  createTopic(ref: SessionRouteRef, title: string): Promise<SessionTopicSummary>;
  topic(ref: SessionRouteRef, topicId: string): Promise<SessionTopicSnapshot>;
  postTopicMessage(ref: SessionRouteRef, topicId: string, text: string, requestId: string, attachments?: unknown): Promise<{ topicId: string; status: "accepted" | "queued" }>;
  acknowledgeTopic(ref: SessionRouteRef, topicId: string): Promise<SessionTopicSnapshot>;
  status(ref: SessionRouteRef): Promise<ClientSessionStatus>;
  streamSnapshot(ref: SessionRouteRef): Promise<SessionStreamSnapshot>;
  notificationCatalog(): SessionNotificationCatalogSnapshot | Promise<SessionNotificationCatalogSnapshot>;
  unreadCatalog(): Promise<SessionUnreadCatalogSnapshot>;
  /** Working directory of a persisted session found by id across every project, or undefined. */
  locate(sessionId: string): Promise<{ cwd: string } | undefined>;
  acknowledgeUnread(sessionId: string, request: SessionUnreadAcknowledgeRequest): Promise<SessionUnreadCatalogSnapshot>;
  notificationInbox(ref: SessionRouteRef): SessionNotificationInboxSnapshot | Promise<SessionNotificationInboxSnapshot>;
  dismissNotification(ref: SessionRouteRef, request: Omit<SessionNotificationDismissRequest, "cwd">): SessionNotificationInboxSnapshot | Promise<SessionNotificationInboxSnapshot>;
  dismissAllNotifications(ref: SessionRouteRef, request: Omit<SessionNotificationDismissAllRequest, "cwd">): SessionNotificationInboxSnapshot | Promise<SessionNotificationInboxSnapshot>;
  promoteQueuedMessage(ref: SessionRouteRef, target: { kind: "steer" | "followUp"; text: string }): Promise<ClientSessionStatus>;
  promoteAllQueuedMessages(ref: SessionRouteRef): Promise<ClientSessionStatus>;
  clearQueue(ref: SessionRouteRef): Promise<ClientSessionStatus>;
  submitAsk(ref: SessionRouteRef, askId: string, submission: AskUserSubmission): Promise<AskUserCloseResponse>;
  cancelAsk(ref: SessionRouteRef, askId: string): Promise<AskUserCloseResponse>;
  answerDialog(ref: SessionRouteRef, dialogId: string, value: ExtensionDialogAnswer): Promise<ExtensionDialogCloseResponse>;
  cancelDialog(ref: SessionRouteRef, dialogId: string): Promise<ExtensionDialogCloseResponse>;
  dismissWarning(ref: SessionRouteRef, dismissId: string): Promise<ClientSessionStatus>;
  getSessionDefaults(ref: SessionRouteRef): Promise<SessionDefaults>;
  setSessionDefaults(ref: SessionRouteRef, defaults: SessionDefaultsUpdate): Promise<SessionDefaults>;
  availableModels(ref: SessionRouteRef): Promise<ClientSessionModel[]>;
  /** The session machine's full available-model catalog with per-model enabled state, enabled models first. */
  modelCatalog(ref: SessionRouteRef): Promise<ClientSessionModelCatalogEntry[]>;
  setModel(ref: SessionRouteRef, provider: string, modelId: string): Promise<ClientSessionStatus>;
  /** Add/remove one model to/from pi's enabled-models scope; returns the updated full catalog. */
  setModelEnabled(ref: SessionRouteRef, provider: string, modelId: string, enabled: boolean): Promise<ClientSessionModelCatalogEntry[]>;
  /** Atomically select every model or retain only the session's current model. */
  setModelScope(ref: SessionRouteRef, mode: SessionModelScopeMode): Promise<ClientSessionModelCatalogEntry[]>;
  cycleModel(ref: SessionRouteRef, direction: "forward" | "backward"): Promise<ClientSessionStatus>;
  availableThinkingLevels(ref: SessionRouteRef): Promise<ClientThinkingLevel[]>;
  setThinkingLevel(ref: SessionRouteRef, level: string): Promise<ClientSessionStatus>;
  cycleThinkingLevel(ref: SessionRouteRef): Promise<ClientSessionStatus>;
  commands(ref: SessionRouteRef): Promise<ClientCommand[]>;
  prompt(ref: SessionRouteRef, text: unknown, streamingBehavior?: unknown, attachments?: unknown): Promise<void>;
  saveAttachments(ref: SessionRouteRef, attachments: unknown, folder?: string): Promise<SavedPromptAttachment[]>;
  cleanupPreview(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupPreviewResponse>;
  cleanup(request: NormalizedSessionCleanupRequest): Promise<ClientSessionCleanupExecuteResponse>;
  archiveMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkArchiveResponse>;
  deleteArchivedMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkDeleteArchivedResponse>;
  shell(ref: SessionRouteRef, text: string): Promise<void>;
  runCommand(ref: SessionRouteRef, text: string): Promise<ClientCommandResult>;
  respondToCommand(ref: SessionRouteRef, requestId: string, value: string): Promise<ClientCommandResult>;
  navigateTree(ref: SessionRouteRef, request: ClientSessionTreeNavigateRequest): Promise<ClientSessionTreeNavigateResult>;
  forkFromTree(ref: SessionRouteRef, request: ClientSessionTreeForkRequest): Promise<ClientSessionTreeForkResult>;
  abort(ref: SessionRouteRef): Promise<void>;
  stop(ref: SessionRouteRef): void | Promise<void>;
  archive(ref: SessionRouteRef): Promise<void>;
  archiveTree(ref: SessionRouteRef): Promise<ClientArchiveSessionsResponse>;
  restore(ref: SessionRouteRef): Promise<void>;
  reload(ref: SessionRouteRef): Promise<void>;
  detachParent(ref: SessionRouteRef): Promise<void>;
}
