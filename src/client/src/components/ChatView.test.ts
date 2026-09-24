import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { QueuedSessionMessage, SessionStatus, SessionWarning } from "../api";
import type { ChatGroup } from "../chatGroups";
import {
  notificationTargetKey,
  notificationTrayIsCollapsed,
  type SelectedSessionNotificationView,
} from "../sessionNotifications";
import {
  ChatView,
  chatEventAnchorKey,
  chatFragmentAnchorKey,
  chatGroupAnchorKey,
  chatGroupScrollMarkerId,
  chatMessageMetadataLabel,
  chatQueuedMessageSections,
  chatQueuedSectionShowsClearAction,
  chatSessionWarningRows,
} from "./ChatView";
import { templateEventHandlerAfterMarker, templateEventHandlerNearMarker } from "../templateInspection.testSupport";

describe("chatQueuedMessageSections", () => {
  it("labels client-side pending-start sends separately from server queued messages", () => {
    const sections = chatQueuedMessageSections(
      [{ kind: "followUp", text: "queued before start" }],
      [{ kind: "steer", text: "server queued" }],
    );

    expect(sections).toEqual([
      {
        source: "client",
        heading: "Queued until session starts",
        detail: "Will send once the backend session is ready",
        messages: [{ kind: "followUp", text: "queued before start" }],
      },
      {
        source: "server",
        heading: "Queued messages",
        detail: "1 pending",
        messages: [{ kind: "steer", text: "server queued" }],
      },
    ]);
  });
});

describe("chatQueuedSectionShowsClearAction", () => {
  // The show/hide decision for the server clear-queue button is content/layout,
  // so it lives in a pure exported seam instead of scraping rendered markup.
  const serverSection = requireSection(chatQueuedMessageSections([], [{ kind: "steer", text: "server queued" }])[0]);
  const clientSection = requireSection(chatQueuedMessageSections([{ kind: "followUp", text: "waiting" }], [])[0]);

  it("shows the action for the server queue when a clear handler is wired", () => {
    expect(chatQueuedSectionShowsClearAction(serverSection, true)).toBe(true);
  });

  it("hides the action when no clear handler is wired", () => {
    expect(chatQueuedSectionShowsClearAction(serverSection, false)).toBe(false);
  });

  it("never shows the server action for the separate client pending-start queue", () => {
    expect(chatQueuedSectionShowsClearAction(clientSection, true)).toBe(false);
  });
});

describe("ChatView queued-message clear wiring", () => {
  // Escape hatch: this case verifies the Clear queue button's Lit event wiring,
  // whose only observable effect is invoking the injected callback. Vitest runs
  // with no DOM environment here, so a shadow-DOM click harness would add
  // disproportionate setup; handler extraction anchored to the user-facing
  // "Clear queue" button text is proportionate.
  it("invokes onClearServerQueue when the server-queue action is activated", () => {
    const view = new ChatView();
    const onClearServerQueue = vi.fn();
    view.status = queuedStatus([{ kind: "steer", text: "server queued" }]);
    view.onClearServerQueue = onClearServerQueue;

    templateEventHandlerNearMarker(renderQueuedMessages(view), "Clear queue")(new Event("click"));

    expect(onClearServerQueue).toHaveBeenCalledOnce();
  });
});

describe("chatSessionWarningRows", () => {
  // Warning-row content (severity class, message, path, source, dismiss
  // capability, ordering) is derived by a pure exported seam rather than scraped
  // from rendered `TemplateResult` markup, per the testing-guide rule that
  // TemplateResult inspection is not for general content assertions.
  it("derives one severity-tagged row per warning with optional path and source", () => {
    const rows = chatSessionWarningRows(warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill", path: "/skills/a.md" },
      { severity: "warning", message: "subscription auth is active" },
      { severity: "info", message: "heads up", source: "runtime" },
    ]));

    expect(rows).toEqual([
      { severity: "error", severityClass: "session-warning error", message: "skill failed to load", source: "skill", path: "/skills/a.md", dismissId: undefined },
      { severity: "warning", severityClass: "session-warning warning", message: "subscription auth is active", source: undefined, path: undefined, dismissId: undefined },
      { severity: "info", severityClass: "session-warning info", message: "heads up", source: "runtime", path: undefined, dismissId: undefined },
    ]);
  });

  it("exposes a dismiss id only for warnings carrying a dismiss capability", () => {
    const rows = chatSessionWarningRows(warningStatus([
      { severity: "error", message: "skill failed to load", source: "skill" },
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]));

    expect(rows.map((row) => row.dismissId)).toEqual([undefined, "anthropicExtraUsage"]);
  });

  it("derives no rows when there are no warnings or status is unset", () => {
    expect(chatSessionWarningRows(warningStatus([]))).toEqual([]);
    expect(chatSessionWarningRows(undefined)).toEqual([]);
  });
});

describe("ChatView session-warning dismiss wiring", () => {
  // Escape hatch: this case verifies the dismiss button's Lit event wiring,
  // whose observable effect is invoking onDismissWarning with the warning's
  // dismiss id. No DOM environment is available, so handler extraction anchored
  // to the stable `session-warning-dismiss` class marker is proportionate.
  it("invokes onDismissWarning with the warning's dismiss id", () => {
    const view = new ChatView();
    const onDismissWarning = vi.fn();
    view.onDismissWarning = onDismissWarning;
    view.status = warningStatus([
      { severity: "warning", message: "subscription auth is active", source: "anthropic", dismiss: { id: "anthropicExtraUsage" } },
    ]);

    const rendered = renderWarnings(view);
    if (rendered === null) throw new Error("expected a warnings banner");
    templateEventHandlerAfterMarker(rendered, "session-warning-dismiss")(new Event("click"));

    expect(onDismissWarning).toHaveBeenCalledExactlyOnceWith("anthropicExtraUsage");
  });

  // Escape hatch: this verifies the minimise chevron's Lit callback wiring in
  // the node test environment, anchored to its stable semantic class marker.
  // The chevron is wired to the unified onToggleWarnings (toggle ≡ collapse in
  // the expanded state), so this also proves the single visibility mutation.
  it("invokes onToggleWarnings from the visible warning area", () => {
    const view = withStatus(new ChatView(), warningStatus([
      { severity: "warning", message: "subscription auth is active" },
    ]));
    const onToggleWarnings = vi.fn();
    view.onToggleWarnings = onToggleWarnings;

    const rendered = renderWarnings(view);
    if (rendered === null) throw new Error("expected a warnings banner");
    templateEventHandlerAfterMarker(rendered, "session-warnings-collapse")(new Event("click"));

    expect(onToggleWarnings).toHaveBeenCalledOnce();
  });

  it("removes the warning area while presentation is collapsed or there are no warnings", () => {
    const view = withStatus(new ChatView(), warningStatus([
      { severity: "warning", message: "subscription auth is active" },
    ]));
    view.warningsVisible = false;

    expect(renderWarnings(view)).toBeNull();
    expect(renderWarnings(withStatus(new ChatView(), warningStatus([])))).toBeNull();
  });
});

describe("ChatView notification tray wiring", () => {
  // Escape hatch: these cases verify only the tray buttons' Lit callback wiring.
  // Content and identity decisions use pure seams; Vitest has no shadow-DOM
  // harness, so stable semantic class markers keep handler extraction narrow.
  // A minimal render-root fake verifies the resulting focus move without
  // recreating a browser DOM harness.
  it("wires individual dismissal and recovers header focus after the final row", () => {
    const view = withNotificationInbox(new ChatView());
    const onDismissNotification = vi.fn();
    const headerFocus = installNotificationFocusRoot(view);
    view.onDismissNotification = onDismissNotification;

    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");
    templateEventHandlerAfterMarker(rendered, "notification-row-dismiss")(new Event("click"));
    view.notificationInbox = emptyNotificationInbox(requireNotificationInbox(view));

    expect(renderNotificationTray(view)).not.toBeNull();
    focusPendingNotificationTarget(view);
    expect(onDismissNotification).toHaveBeenCalledExactlyOnceWith("daemon-a:1");
    expect(headerFocus).toHaveBeenCalledOnce();
  });

  it("wires clear-all and recovers header focus while the emptied tray is retained", () => {
    const view = withNotificationInbox(new ChatView());
    const onDismissAllNotifications = vi.fn();
    const headerFocus = installNotificationFocusRoot(view);
    view.onDismissAllNotifications = onDismissAllNotifications;

    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");
    templateEventHandlerAfterMarker(rendered, "notification-clear")(new Event("click"));
    view.notificationInbox = emptyNotificationInbox(requireNotificationInbox(view));

    expect(renderNotificationTray(view)).not.toBeNull();
    focusPendingNotificationTarget(view);
    expect(onDismissAllNotifications).toHaveBeenCalledOnce();
    expect(headerFocus).toHaveBeenCalledOnce();
  });

  it("does not move pending dismissal focus into another exact chat", () => {
    const view = withNotificationInbox(new ChatView());
    const headerFocus = installNotificationFocusRoot(view);
    view.onDismissAllNotifications = vi.fn();

    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");
    templateEventHandlerAfterMarker(rendered, "notification-clear")(new Event("click"));
    view.notificationInbox = { ...requireNotificationInbox(view), machineId: "remote" };
    focusPendingNotificationTarget(view);

    expect(headerFocus).not.toHaveBeenCalled();
  });

  it("keeps a collapsed tray closed for new arrivals and isolates matching session ids by exact chat", () => {
    const view = withNotificationInbox(new ChatView());
    const inbox = requireNotificationInbox(view);
    const rendered = renderNotificationTray(view);
    if (rendered === null) throw new Error("expected a notification tray");

    templateEventHandlerAfterMarker(rendered, "notification-toggle")(new Event("click"));

    const collapsedTargetKeys: unknown = Reflect.get(view, "collapsedNotificationTargetKeys");
    if (!(collapsedTargetKeys instanceof Set)) throw new Error("Expected collapsed notification target keys");
    const firstNotification = inbox.notifications[0];
    if (firstNotification === undefined) throw new Error("expected a retained notification");
    const newArrival = {
      ...inbox,
      notifications: [{ ...firstNotification, id: "daemon-a:2", order: 2 }, ...inbox.notifications],
      retainedCount: 2,
    };
    expect(notificationTrayIsCollapsed(collapsedTargetKeys, newArrival)).toBe(true);
    expect(notificationTrayIsCollapsed(collapsedTargetKeys, { ...newArrival, cwd: "/other" })).toBe(false);
    expect(notificationTrayIsCollapsed(collapsedTargetKeys, { ...newArrival, machineId: "remote" })).toBe(false);
    expect(collapsedTargetKeys.has(notificationTargetKey(inbox))).toBe(true);
  });
});

describe("chatMessageMetadataLabel", () => {
  it("keeps only the timestamp when model and thinking metadata are present", () => {
    const timestamp = "2026-07-10T19:15:30.000Z";
    const formattedTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));

    expect(chatMessageMetadataLabel({
      role: "assistant",
      parts: [],
      meta: { timestamp, model: { provider: "provider", id: "model" }, thinkingLevel: "high" },
    })).toBe(formattedTimestamp);
  });

  it("does not synthesize fallback metadata", () => {
    expect(chatMessageMetadataLabel({ role: "system", parts: [] })).toBeUndefined();
  });
});

describe("chat event-group content seams", () => {
  it("keeps stable group and per-event scroll anchors without disclosure state", () => {
    expect(chatGroupAnchorKey(40)).toBe("g:40");
    expect(chatGroupAnchorKey(40, "activity", 1)).toBe("g:40:activity:1");
    expect(chatEventAnchorKey(40)).toBe("e:40");
    expect(chatEventAnchorKey(41)).toBe("e:41");
    expect(chatGroupScrollMarkerId(41)).toBe("g:41");
    expect(chatGroupScrollMarkerId(41, "thinking", 1)).toBe("g:41:thinking:1");
  });

  it("gives split top-level fragments unique repeat keys", () => {
    const groups: ChatGroup[] = [
      { kind: "message", index: 40, message: { role: "assistant", parts: [{ type: "text", text: "before" }] } },
      { kind: "group", presentation: "thinking", startIndex: 40, endIndex: 40, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "thought" }] }] },
      { kind: "message", index: 40, message: { role: "assistant", parts: [{ type: "text", text: "after" }] } },
    ];

    const keys = groups.map((_, index) => chatFragmentAnchorKey(groups, index));
    expect(keys).toEqual(["m:40", "g:40", "m:40:1"]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});


type RenderQueuedMessages = (this: ChatView) => TemplateResult;
type RenderWarnings = (this: ChatView) => TemplateResult | null;
type RenderNotificationTray = (this: ChatView) => TemplateResult | null;
type FocusPendingNotificationTarget = (this: ChatView) => void;

function renderQueuedMessages(view: ChatView): TemplateResult {
  const method: unknown = Reflect.get(view, "renderQueuedMessages");
  if (!isRenderQueuedMessages(method)) throw new Error("ChatView.renderQueuedMessages is not callable");
  return method.call(view);
}

function renderWarnings(view: ChatView): TemplateResult | null {
  const method: unknown = Reflect.get(view, "renderWarnings");
  if (!isRenderWarnings(method)) throw new Error("ChatView.renderWarnings is not callable");
  return method.call(view);
}

function renderNotificationTray(view: ChatView): TemplateResult | null {
  const method: unknown = Reflect.get(view, "renderNotificationTray");
  if (!isRenderNotificationTray(method)) throw new Error("ChatView.renderNotificationTray is not callable");
  return method.call(view);
}

function focusPendingNotificationTarget(view: ChatView): void {
  const method: unknown = Reflect.get(view, "focusPendingNotificationTarget");
  if (!isFocusPendingNotificationTarget(method)) throw new Error("ChatView.focusPendingNotificationTarget is not callable");
  method.call(view);
}

function isRenderQueuedMessages(value: unknown): value is RenderQueuedMessages {
  return typeof value === "function";
}

function isRenderWarnings(value: unknown): value is RenderWarnings {
  return typeof value === "function";
}

function isRenderNotificationTray(value: unknown): value is RenderNotificationTray {
  return typeof value === "function";
}

function isFocusPendingNotificationTarget(value: unknown): value is FocusPendingNotificationTarget {
  return typeof value === "function";
}

function requireSection(section: ReturnType<typeof chatQueuedMessageSections>[number] | undefined): ReturnType<typeof chatQueuedMessageSections>[number] {
  if (section === undefined) throw new Error("expected a queued-message section");
  return section;
}

function withStatus(view: ChatView, status: SessionStatus): ChatView {
  view.status = status;
  return view;
}

function withNotificationInbox(view: ChatView): ChatView {
  const notificationInbox: SelectedSessionNotificationView = {
    machineId: "local",
    sessionId: "session-1",
    cwd: "/repo",
    daemonInstanceId: "daemon-a",
    notifications: [{
      id: "daemon-a:1",
      message: "plain <strong>text</strong>\nsecond line",
      truncated: false,
      severity: "warning",
      receivedAt: "2026-07-18T00:00:00.000Z",
      order: 1,
    }],
    retainedCount: 1,
    discardedCount: 0,
    highestSeverity: "warning",
    dismissThrough: { order: 1, overflowWatermark: 0 },
    pendingDismissedIds: new Set(),
    dismissAllPending: false,
    announcements: [],
  };
  view.sessionId = notificationInbox.sessionId;
  view.notificationInbox = notificationInbox;
  return view;
}

function requireNotificationInbox(view: ChatView): SelectedSessionNotificationView {
  if (view.notificationInbox === undefined) throw new Error("expected a notification inbox");
  return view.notificationInbox;
}

function emptyNotificationInbox(inbox: SelectedSessionNotificationView): SelectedSessionNotificationView {
  const empty: SelectedSessionNotificationView = {
    ...inbox,
    notifications: [],
    retainedCount: 0,
    discardedCount: 0,
    pendingDismissedIds: new Set(),
    dismissAllPending: false,
  };
  delete empty.highestSeverity;
  return empty;
}

function installNotificationFocusRoot(view: ChatView): ReturnType<typeof vi.fn> {
  const headerFocus = vi.fn();
  const renderRoot = {
    querySelector: (selector: string) => selector === "[data-notification-focus='header']" ? { focus: headerFocus } : null,
    querySelectorAll: () => [],
  };
  if (!Reflect.set(view, "renderRoot", renderRoot)) throw new Error("Could not install notification focus root");
  return headerFocus;
}

function warningStatus(warnings: SessionWarning[]): SessionStatus {
  return {
    ...queuedStatus([]),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

function queuedStatus(queuedMessages: QueuedSessionMessage[]): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: queuedMessages.length,
    queuedMessages,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}
