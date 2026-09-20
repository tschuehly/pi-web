import { describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { PendingAskUser, PendingExtensionDialog, SessionInfo, SessionStatus } from "../api";
import {
  DesktopNotificationController,
  type DesktopNotificationBrowser,
  type DesktopNotificationHandle,
} from "./desktopNotificationController";

class FakeNotification implements DesktopNotificationHandle {
  onclick: ((event: Event) => void) | null = null;
  close = vi.fn();
}

function harness() {
  let permission: NotificationPermission = "granted";
  let background = true;
  const notifications: { title: string; options: NotificationOptions; handle: FakeNotification }[] = [];
  const focus = vi.fn();
  const browser: DesktopNotificationBrowser = {
    permission: () => permission,
    requestPermission: vi.fn(() => Promise.resolve(permission)),
    isBackground: () => background,
    show: (title, options) => {
      const handle = new FakeNotification();
      notifications.push({ title, options, handle });
      return handle;
    },
    focus,
  };
  return {
    controller: new DesktopNotificationController(browser),
    notifications,
    focus,
    setBackground: (value: boolean) => { background = value; },
    setPermission: (value: NotificationPermission) => { permission = value; },
  };
}

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    ...initialAppState(),
    selectedSession: session,
    status: status(false),
    ...overrides,
  };
}

function status(isStreaming: boolean): SessionStatus {
  return {
    sessionId: session.id,
    persisted: true,
    isStreaming,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

const ask: PendingAskUser = { askId: "ask-1", askedAt: "2026-09-20T00:00:00Z", questions: [] };
const dialog: PendingExtensionDialog = { dialogId: "dialog-1", kind: "confirm", title: "Proceed?", askedAt: "2026-09-20T00:00:00Z", runScoped: true };
const session: SessionInfo = { id: "session-1", cwd: "/repo", path: "/sessions/1.jsonl", created: "2026-09-20T00:00:00Z", modified: "2026-09-20T00:00:00Z", messageCount: 1, firstMessage: "Hello" };

describe("DesktopNotificationController", () => {
  it("suppresses foreground activity and notifies only a selected Chat completion transition", () => {
    const test = harness();
    const streaming = state({ status: status(true) });
    test.controller.sync(initialAppState(), streaming);
    test.controller.activate(streaming);

    test.setBackground(false);
    const completed = state({ status: status(false) });
    test.controller.sync(streaming, completed);
    expect(test.notifications).toHaveLength(0);

    test.setBackground(true);
    test.controller.sync(completed, streaming);
    test.controller.sync(streaming, completed);
    expect(test.notifications.map(({ title }) => title)).toEqual(["PI WEB · Chat complete"]);
  });

  it("treats reconnect hydration as a baseline and deduplicates asks, dialogs, and errors", () => {
    const test = harness();
    const hydrated = state({ status: status(false), pendingAsk: ask, pendingDialogs: [dialog] });
    test.controller.sync(initialAppState(), hydrated);
    test.controller.activate(hydrated);
    test.controller.suspend();
    test.controller.sync(hydrated, state());
    test.controller.activate(hydrated);
    expect(test.notifications).toHaveLength(0);

    const nextAsk = { ...ask, askId: "ask-2" };
    const nextDialog = { ...dialog, dialogId: "dialog-2" };
    const attention = state({ pendingAsk: nextAsk, pendingDialogs: [dialog, nextDialog] });
    test.controller.sync(hydrated, attention);
    test.controller.sync(attention, attention);
    test.controller.sessionError(attention, "terminal failed", 42);
    test.controller.sessionError(attention, "terminal failed", 42);

    expect(test.notifications.map(({ title }) => title)).toEqual([
      "PI WEB · Question needs an answer",
      "PI WEB · Dialog needs attention",
      "PI WEB · Chat error",
    ]);
  });

  it("resets deduplication on exact session identity", () => {
    const test = harness();
    const first = state();
    test.controller.sync(initialAppState(), first);
    test.controller.activate(first);
    test.controller.sessionError(first, "failed", 1);

    const secondSession = { ...session, id: "session-2" };
    const second = state({ selectedSession: secondSession, status: { ...status(false), sessionId: secondSession.id } });
    test.controller.sync(first, second);
    test.controller.activate(second);
    test.controller.sessionError(second, "failed", 1);

    expect(test.notifications).toHaveLength(2);
  });

  it("focuses the creating Chat window and closes the notification when clicked", () => {
    const test = harness();
    const selected = state();
    test.controller.sync(initialAppState(), selected);
    test.controller.activate(selected);
    test.controller.sessionError(selected, "failed", 1);

    test.notifications[0]?.handle.onclick?.(new Event("click"));

    expect(test.focus).toHaveBeenCalledOnce();
    expect(test.notifications[0]?.handle.close).toHaveBeenCalledOnce();
  });

  it("requests permission only from the explicit default state", async () => {
    const test = harness();
    test.setPermission("default");
    expect(test.controller.canRequestPermission()).toBe(true);
    await test.controller.requestPermission();
    test.setPermission("denied");
    expect(test.controller.canRequestPermission()).toBe(false);
  });
});
