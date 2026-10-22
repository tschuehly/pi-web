import type { SessionNotificationInboxSnapshot } from "../../shared/apiTypes.js";
import type { SessionRouteRef, SessionRouteService } from "./sessionService.js";
import { DurableChatUnavailable, type DurableChatService } from "./durableChatService.js";

/**
 * Routes each Chat's operations to the runtime its locator names, fixed at creation; Chats without a Durable record
 * stay on the legacy service. Catalog-wide reads merge both; catalog-wide mutations stay legacy-only in slice 1.
 * Durable Chats answer only the operations they support and reject the rest visibly.
 */
export function createRuntimeRoutedSessionService(legacy: SessionRouteService, durable: DurableChatService): SessionRouteService {
  const isDurable = (ref: SessionRouteRef) => durable.owns(ref.id);
  const unavailable = (operation: string): never => { throw new DurableChatUnavailable(operation); };
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
    archiveMany: (refs) => legacy.archiveMany(refs),
    deleteArchivedMany: (refs) => legacy.deleteArchivedMany(refs),

    messages: (ref, page) => isDurable(ref) ? durable.messages(ref, page) : legacy.messages(ref, page),
    media: (ref, mediaId) => isDurable(ref) ? Promise.resolve(undefined) : legacy.media(ref, mediaId),
    status: (ref) => isDurable(ref) ? durable.status(ref) : legacy.status(ref),
    openAsks: (ref) => isDurable(ref) ? Promise.resolve([]) : legacy.openAsks(ref),
    attentionRequest: (ref) => isDurable(ref) ? undefined : legacy.attentionRequest(ref),
    acknowledgeAttention: (ref, requestId) => isDurable(ref) ? false : legacy.acknowledgeAttention(ref, requestId),
    streamSnapshot: (ref) => isDurable(ref) ? durable.streamSnapshot(ref) : legacy.streamSnapshot(ref),
    transcriptSnapshot: (ref, page) => isDurable(ref) ? durable.transcriptSnapshot(ref, page) : legacy.transcriptSnapshot(ref, page),
    notificationInbox: (ref) => isDurable(ref) ? emptyInbox(ref) : legacy.notificationInbox(ref),
    dismissNotification: (ref, request) => isDurable(ref) ? emptyInbox(ref) : legacy.dismissNotification(ref, request),
    dismissAllNotifications: (ref, request) => isDurable(ref) ? emptyInbox(ref) : legacy.dismissAllNotifications(ref, request),
    promoteQueuedMessage: (ref, target) => isDurable(ref) ? unavailable("Promoting a queued message") : legacy.promoteQueuedMessage(ref, target),
    promoteAllQueuedMessages: (ref) => isDurable(ref) ? unavailable("Promoting queued messages") : legacy.promoteAllQueuedMessages(ref),
    clearQueue: (ref) => isDurable(ref) ? durable.clearQueue(ref) : legacy.clearQueue(ref),
    mutateQueueMessage: (ref, mutation) => isDurable(ref) ? unavailable("Editing a queued message") : legacy.mutateQueueMessage(ref, mutation),
    submitAsk: (ref, askId, submission) => isDurable(ref) ? unavailable("Answering questions") : legacy.submitAsk(ref, askId, submission),
    cancelAsk: (ref, askId) => isDurable(ref) ? unavailable("Answering questions") : legacy.cancelAsk(ref, askId),
    answerDialog: (ref, dialogId, value) => isDurable(ref) ? unavailable("Extension dialogs") : legacy.answerDialog(ref, dialogId, value),
    cancelDialog: (ref, dialogId) => isDurable(ref) ? unavailable("Extension dialogs") : legacy.cancelDialog(ref, dialogId),
    dismissWarning: (ref, dismissId) => isDurable(ref) ? unavailable("Dismissing warnings") : legacy.dismissWarning(ref, dismissId),
    getSessionDefaults: (ref) => isDurable(ref) ? unavailable("Session defaults") : legacy.getSessionDefaults(ref),
    setSessionDefaults: (ref, defaults) => isDurable(ref) ? unavailable("Session defaults") : legacy.setSessionDefaults(ref, defaults),
    availableModels: async (ref) => {
      if (!isDurable(ref)) return legacy.availableModels(ref);
      const { model } = await durable.status(ref);
      return model === undefined ? [] : [model];
    },
    modelCatalog: (ref) => isDurable(ref) ? Promise.resolve([]) : legacy.modelCatalog(ref),
    setModel: (ref, provider, modelId) => isDurable(ref) ? unavailable("Switching models") : legacy.setModel(ref, provider, modelId),
    setModelEnabled: (ref, provider, modelId, enabled) => isDurable(ref) ? unavailable("Switching models") : legacy.setModelEnabled(ref, provider, modelId, enabled),
    setModelScope: (ref, mode) => isDurable(ref) ? unavailable("Switching models") : legacy.setModelScope(ref, mode),
    cycleModel: (ref, direction) => isDurable(ref) ? unavailable("Switching models") : legacy.cycleModel(ref, direction),
    availableThinkingLevels: (ref) => isDurable(ref) ? Promise.resolve([]) : legacy.availableThinkingLevels(ref),
    setThinkingLevel: (ref, level) => isDurable(ref) ? unavailable("Changing the thinking level") : legacy.setThinkingLevel(ref, level),
    cycleThinkingLevel: (ref) => isDurable(ref) ? unavailable("Changing the thinking level") : legacy.cycleThinkingLevel(ref),
    commands: (ref) => isDurable(ref) ? Promise.resolve([]) : legacy.commands(ref),
    prompt: (ref, text, streamingBehavior, attachments) => isDurable(ref) ? durable.prompt(ref, text, streamingBehavior, attachments) : legacy.prompt(ref, text, streamingBehavior, attachments),
    saveAttachments: (ref, attachments, folder) => isDurable(ref) ? unavailable("Attachments") : legacy.saveAttachments(ref, attachments, folder),
    shell: (ref, text) => isDurable(ref) ? unavailable("Shell commands") : legacy.shell(ref, text),
    runCommand: (ref, text) => isDurable(ref) ? unavailable("Commands") : legacy.runCommand(ref, text),
    respondToCommand: (ref, requestId, value) => isDurable(ref) ? unavailable("Commands") : legacy.respondToCommand(ref, requestId, value),
    navigateTree: (ref, request) => isDurable(ref) ? unavailable("Tree navigation") : legacy.navigateTree(ref, request),
    forkFromTree: (ref, request) => isDurable(ref) ? unavailable("Forking") : legacy.forkFromTree(ref, request),
    abort: (ref) => isDurable(ref) ? durable.abort(ref) : legacy.abort(ref),
    stop: (ref) => isDurable(ref) ? durable.stop(ref) : legacy.stop(ref),
    archive: (ref) => isDurable(ref) ? unavailable("Archiving") : legacy.archive(ref),
    archiveTree: (ref) => isDurable(ref) ? unavailable("Archiving") : legacy.archiveTree(ref),
    restore: (ref) => isDurable(ref) ? unavailable("Restoring") : legacy.restore(ref),
    reload: (ref) => isDurable(ref) ? unavailable("Reloading") : legacy.reload(ref),
    detachParent: (ref) => isDurable(ref) ? unavailable("Detaching") : legacy.detachParent(ref),
  };
}
