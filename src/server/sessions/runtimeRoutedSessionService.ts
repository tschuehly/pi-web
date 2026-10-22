import { CHAT_CAPABILITY_LABELS, type ChatCapability, type SessionNotificationInboxSnapshot } from "../../shared/apiTypes.js";
import type { SessionRouteRef, SessionRouteService } from "./sessionService.js";
import { DurableChatUnavailable, type DurableChatService } from "./durableChatService.js";

/**
 * Routes each Chat's operations to the runtime its locator names, fixed at creation; Chats without a Durable record
 * stay on the legacy service. Catalog-wide reads merge both; catalog-wide mutations stay legacy-only in slice 1.
 * Durable Chats answer only the operations they support and reject the rest visibly. Slice 2 adds questions,
 * attention, commands (/mode, /skill:), model switching and effect resolution. Slice 3 (composer) adds queue edits
 * and promotion, inline and saved attachments with media, thinking levels, `!` shell commands and prompt templates;
 * slice 3 (attention) unread, /name and /session.
 */
export function createRuntimeRoutedSessionService(legacy: SessionRouteService, durable: DurableChatService): SessionRouteService {
  const isDurable = (ref: SessionRouteRef) => durable.owns(ref.id);
  // Gated operations name the capability a Durable Chat reports once it supports them; the browser hides their controls.
  const unavailable = (capability: ChatCapability): never => { throw new DurableChatUnavailable(CHAT_CAPABILITY_LABELS[capability]); };
  // Slice 1 records no notifications for Durable Chats: their inbox is always empty.
  const emptyInbox = async (ref: SessionRouteRef): Promise<SessionNotificationInboxSnapshot> => {
    const { daemonInstanceId, catalogRevision } = await legacy.notificationCatalog();
    return {
      daemonInstanceId,
      catalogRevision,
      summary: { sessionId: ref.id, cwd: ref.cwd, inboxRevision: 0, retainedCount: 0, discardedCount: 0 },
      notifications: [],
      dismissThrough: { order: 0, overflowWatermark: 0 },
    };
  };

  return {
    list: async (cwd, options) => {
      const durableChats = durable.list(cwd, options?.sessionId);
      if (options?.sessionId !== undefined && durableChats.length > 0) return durableChats;
      return [...await legacy.list(cwd, options), ...durableChats];
    },
    listRecent: async (limit) => [...await legacy.listRecent(limit), ...durable.listAll()]
      .sort((left, right) => right.modified.localeCompare(left.modified))
      .slice(0, limit),
    start: (cwd, options) => options?.runtime === "durable"
      ? durable.start(cwd, options.startupToken)
      : legacy.start(cwd, options?.startupToken === undefined ? undefined : { startupToken: options.startupToken }),
    locate: async (sessionId) => {
      const chat = durable.listAll().find((session) => session.id === sessionId);
      return chat === undefined ? legacy.locate(sessionId) : { cwd: chat.cwd };
    },
    lookupWorkstreamLaunch: (token, cwd) => legacy.lookupWorkstreamLaunch(token, cwd),
    notificationCatalog: () => legacy.notificationCatalog(),
    unreadCatalog: () => legacy.unreadCatalog(),
    acknowledgeUnread: (sessionId, request) => legacy.acknowledgeUnread(sessionId, request),
    cleanupPreview: (request) => legacy.cleanupPreview(request),
    cleanup: (request) => legacy.cleanup(request),
    // Archiving is not ported to Durable Chats (unused): bulk requests report each Durable Chat as a failure.
    archiveMany: async (refs) => {
      const response = await legacy.archiveMany(refs.filter((ref) => !durable.owns(ref.id)));
      for (const ref of refs) if (durable.owns(ref.id)) response.failures.push({ sessionId: ref.id, error: `${CHAT_CAPABILITY_LABELS.archive} is not available in Durable Chats yet` });
      return response;
    },
    deleteArchivedMany: async (refs) => {
      const response = await legacy.deleteArchivedMany(refs.filter((ref) => !durable.owns(ref.id)));
      for (const ref of refs) if (durable.owns(ref.id)) response.failures.push({ sessionId: ref.id, error: `${CHAT_CAPABILITY_LABELS.archive} is not available in Durable Chats yet` });
      return response;
    },

    messages: (ref, page) => isDurable(ref) ? durable.messages(ref, page) : legacy.messages(ref, page),
    media: (ref, mediaId) => isDurable(ref) ? durable.media(ref, mediaId) : legacy.media(ref, mediaId),
    status: (ref) => isDurable(ref) ? durable.status(ref) : legacy.status(ref),
    openAsks: (ref) => isDurable(ref) ? durable.openAsks(ref) : legacy.openAsks(ref),
    attentionRequest: (ref) => isDurable(ref) ? durable.attentionRequest(ref) : legacy.attentionRequest(ref),
    acknowledgeAttention: (ref, requestId) => isDurable(ref) ? durable.acknowledgeAttention(ref, requestId) : legacy.acknowledgeAttention(ref, requestId),
    streamSnapshot: (ref) => isDurable(ref) ? durable.streamSnapshot(ref) : legacy.streamSnapshot(ref),
    transcriptSnapshot: (ref, page) => isDurable(ref) ? durable.transcriptSnapshot(ref, page) : legacy.transcriptSnapshot(ref, page),
    notificationInbox: (ref) => isDurable(ref) ? emptyInbox(ref) : legacy.notificationInbox(ref),
    dismissNotification: (ref, request) => isDurable(ref) ? emptyInbox(ref) : legacy.dismissNotification(ref, request),
    dismissAllNotifications: (ref, request) => isDurable(ref) ? emptyInbox(ref) : legacy.dismissAllNotifications(ref, request),
    promoteQueuedMessage: (ref, target) => isDurable(ref) ? durable.promoteQueuedMessage(ref, target) : legacy.promoteQueuedMessage(ref, target),
    promoteAllQueuedMessages: (ref) => isDurable(ref) ? durable.promoteAllQueuedMessages(ref) : legacy.promoteAllQueuedMessages(ref),
    clearQueue: (ref) => isDurable(ref) ? durable.clearQueue(ref) : legacy.clearQueue(ref),
    mutateQueueMessage: (ref, mutation) => isDurable(ref) ? durable.mutateQueueMessage(ref, mutation) : legacy.mutateQueueMessage(ref, mutation),
    submitAsk: (ref, askId, submission, operationId) => isDurable(ref) ? durable.submitAsk(ref, askId, submission, operationId) : legacy.submitAsk(ref, askId, submission, operationId),
    cancelAsk: (ref, askId, operationId) => isDurable(ref) ? durable.cancelAsk(ref, askId, operationId) : legacy.cancelAsk(ref, askId, operationId),
    answerDialog: (ref, dialogId, value) => isDurable(ref) ? unavailable("dialogs") : legacy.answerDialog(ref, dialogId, value),
    cancelDialog: (ref, dialogId) => isDurable(ref) ? unavailable("dialogs") : legacy.cancelDialog(ref, dialogId),
    dismissWarning: (ref, dismissId) => isDurable(ref) ? unavailable("warnings.dismiss") : legacy.dismissWarning(ref, dismissId),
    getSessionDefaults: (ref) => isDurable(ref) ? unavailable("defaults") : legacy.getSessionDefaults(ref),
    setSessionDefaults: (ref, defaults) => isDurable(ref) ? unavailable("defaults") : legacy.setSessionDefaults(ref, defaults),
    availableModels: (ref) => isDurable(ref) ? durable.availableModels(ref) : legacy.availableModels(ref),
    modelCatalog: (ref) => isDurable(ref) ? durable.modelCatalog(ref) : legacy.modelCatalog(ref),
    setModel: (ref, provider, modelId) => isDurable(ref) ? durable.setModel(ref, provider, modelId) : legacy.setModel(ref, provider, modelId),
    setModelEnabled: (ref, provider, modelId, enabled) => isDurable(ref) ? unavailable("models.enabled") : legacy.setModelEnabled(ref, provider, modelId, enabled),
    setModelScope: (ref, mode) => isDurable(ref) ? unavailable("models.enabled") : legacy.setModelScope(ref, mode),
    cycleModel: (ref, direction) => isDurable(ref) ? unavailable("models.cycle") : legacy.cycleModel(ref, direction),
    availableThinkingLevels: (ref) => isDurable(ref) ? durable.availableThinkingLevels(ref) : legacy.availableThinkingLevels(ref),
    setThinkingLevel: (ref, level) => isDurable(ref) ? durable.setThinkingLevel(ref, level) : legacy.setThinkingLevel(ref, level),
    cycleThinkingLevel: (ref) => isDurable(ref) ? durable.cycleThinkingLevel(ref) : legacy.cycleThinkingLevel(ref),
    commands: (ref) => isDurable(ref) ? durable.commands(ref) : legacy.commands(ref),
    prompt: (ref, text, streamingBehavior, attachments, options) => isDurable(ref) ? durable.prompt(ref, text, streamingBehavior, attachments, options) : legacy.prompt(ref, text, streamingBehavior, attachments, options),
    saveAttachments: (ref, attachments, folder) => isDurable(ref) ? durable.saveAttachments(ref, attachments, folder) : legacy.saveAttachments(ref, attachments, folder),
    shell: (ref, text) => isDurable(ref) ? durable.shell(ref, text) : legacy.shell(ref, text),
    runCommand: (ref, text) => isDurable(ref) ? durable.runCommand(ref, text) : legacy.runCommand(ref, text),
    respondToCommand: (ref, requestId, value) => isDurable(ref) ? unavailable("commands.respond") : legacy.respondToCommand(ref, requestId, value),
    navigateTree: (ref, request) => isDurable(ref) ? unavailable("tree") : legacy.navigateTree(ref, request),
    forkFromTree: (ref, request) => isDurable(ref) ? unavailable("fork") : legacy.forkFromTree(ref, request),
    abort: (ref) => isDurable(ref) ? durable.abort(ref) : legacy.abort(ref),
    stop: (ref) => isDurable(ref) ? durable.stop(ref) : legacy.stop(ref),
    archive: (ref) => isDurable(ref) ? unavailable("archive") : legacy.archive(ref),
    archiveTree: (ref) => isDurable(ref) ? unavailable("archive") : legacy.archiveTree(ref),
    restore: (ref) => isDurable(ref) ? unavailable("archive") : legacy.restore(ref),
    reload: (ref) => isDurable(ref) ? unavailable("reload") : legacy.reload(ref),
    detachParent: (ref) => isDurable(ref) ? unavailable("detach-parent") : legacy.detachParent(ref),
    resolveEffect: (ref, taskId, resolution) => isDurable(ref) ? durable.resolveEffect(ref, taskId, resolution) : Promise.reject(new DurableChatUnavailable("Resolving interrupted tool calls outside Durable Chats")),
  };
}
