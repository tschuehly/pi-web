import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { PendingAskUser, PendingExtensionDialog, SessionInfo, SessionStatus } from "../api";
import type { PiWebNativeHost } from "../nativeHost";
import {
  desktopNotifications,
  DesktopNotificationController,
  type DesktopNotificationBrowser,
  type DesktopNotificationHandle,
  type DesktopNotificationStorage,
} from "./desktopNotificationController";

class FakeNotification implements DesktopNotificationHandle {
  onclick: ((event: Event) => void) | null = null;
  close = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function harness(onPermissionChange: () => void = () => undefined) {
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
    controller: new DesktopNotificationController(browser, onPermissionChange),
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

  it("diagnoses browser permission already denied before a request, including an incomplete native bridge", () => {
    vi.stubGlobal("Notification", { permission: "denied" });
    const browser = desktopNotifications(undefined, memoryStorage());
    const controller = new DesktopNotificationController(browser);
    const incomplete = desktopNotifications({ pickDirectory: () => Promise.resolve(null) }, memoryStorage());

    expect(controller.diagnostic).toContain("browser's site settings");
    expect(controller.canRequestPermission()).toBe(false);
    expect(incomplete.diagnostic).toContain("native notification bridge");
    expect(incomplete.diagnostic).toContain("browser's site settings");
  });

  it("prefers native notifications and persists explicit enablement", async () => {
    const storage = memoryStorage();
    const host = nativeHost();
    const browserRequestPermission = vi.fn(() => Promise.resolve<NotificationPermission>("denied"));
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: browserRequestPermission });
    const adapter = desktopNotifications(host, storage);

    expect(adapter.permission()).toBe("default");
    expect(new DesktopNotificationController(adapter).diagnostic).toBeUndefined();
    await adapter.requestPermission();

    expect(host.requestNotificationPermission).toHaveBeenCalledOnce();
    expect(host.notify).not.toHaveBeenCalled();
    expect(adapter.permission()).toBe("granted");
    expect(desktopNotifications(host, storage).permission()).toBe("granted");
    expect(browserRequestPermission).not.toHaveBeenCalled();
  });

  it("keeps native permission at default when explicit enablement is rejected", async () => {
    const storage = memoryStorage();
    const host = nativeHost();
    host.requestNotificationPermission.mockRejectedValueOnce(new Error("denied"));
    const adapter = desktopNotifications(host, storage);
    const onPermissionChange = vi.fn();
    const controller = new DesktopNotificationController(adapter, onPermissionChange);

    await controller.requestPermission();

    expect(onPermissionChange).toHaveBeenCalledOnce();
    expect(adapter.permission()).toBe("default");
    expect(desktopNotifications(host, storage).permission()).toBe("default");
    expect(controller.diagnostic).toContain("denied");
    expect(controller.diagnostic).toContain("System Settings");
  });

  it("explains a missing installed bundle and clears the diagnostic after a successful retry", async () => {
    const host = nativeHost();
    host.requestNotificationPermission.mockRejectedValueOnce(new Error("Native notifications require the installed app bundle"));
    const controller = new DesktopNotificationController(desktopNotifications(host, memoryStorage()));

    await controller.requestPermission();
    expect(controller.diagnostic).toContain("installed app bundle");
    await controller.requestPermission();
    expect(controller.diagnostic).toBeUndefined();
  });

  it("uses the native bridge after enablement and returns a no-op handle", async () => {
    const storage = memoryStorage();
    const host = nativeHost();
    const adapter = desktopNotifications(host, storage);
    await adapter.requestPermission();
    const handle = await adapter.show("PI WEB · Chat complete", { body: "Finished", tag: "chat:complete" });

    expect(host.notify).toHaveBeenLastCalledWith("PI WEB · Chat complete", "Finished");
    expect(() => { handle.onclick = () => undefined; handle.close(); }).not.toThrow();
  });

  it("downgrades native permission and rerenders when delivery is rejected", async () => {
    const storage = memoryStorage();
    const host = nativeHost();
    const adapter = desktopNotifications(host, storage);
    await adapter.requestPermission();
    host.notify.mockRejectedValueOnce(new Error("permission revoked"));
    const onPermissionChange = vi.fn();
    const controller = new DesktopNotificationController({ ...adapter, isBackground: () => true }, onPermissionChange);
    const selected = state();
    controller.sync(initialAppState(), selected);
    controller.activate(selected);

    controller.sessionError(selected, "failed", 1);

    await vi.waitFor(() => { expect(onPermissionChange).toHaveBeenCalledOnce(); });
    expect(adapter.permission()).toBe("default");
    expect(desktopNotifications(host, storage).permission()).toBe("default");
    expect(controller.diagnostic).toContain("delivery failed");
  });

  it("falls back to browser notifications unless both native capabilities exist", () => {
    const shown: FakeNotification[] = [];
    class BrowserNotification extends FakeNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>("granted"));
      constructor(public readonly title: string, public readonly options: NotificationOptions) {
        super();
        shown.push(this);
      }
    }
    vi.stubGlobal("Notification", BrowserNotification);
    const pickDirectory = () => Promise.resolve(null);
    const staleNotify = vi.fn(() => Promise.resolve());
    const oldShell = desktopNotifications({ pickDirectory }, memoryStorage());
    const incompleteShell = desktopNotifications({ pickDirectory, notify: staleNotify }, memoryStorage());

    const oldHandle = oldShell.show("Browser title", { body: "Browser body" });
    const incompleteHandle = incompleteShell.show("Browser title 2", { body: "Browser body 2" });

    expect(oldHandle).toBe(shown[0]);
    expect(incompleteHandle).toBe(shown[1]);
    expect(staleNotify).not.toHaveBeenCalled();
    expect(oldShell.diagnostic).toContain("native notification bridge");
    expect(incompleteShell.diagnostic).toContain("native notification bridge");
    expect(desktopNotifications(undefined, memoryStorage()).diagnostic).toBeUndefined();
    expect(shown).toMatchObject([
      { title: "Browser title", options: { body: "Browser body" } },
      { title: "Browser title 2", options: { body: "Browser body 2" } },
    ]);
  });
});

function nativeHost() {
  return {
    pickDirectory: () => Promise.resolve(null),
    requestNotificationPermission: vi.fn(() => Promise.resolve()),
    notify: vi.fn<(title: string, body: string) => Promise<void>>(() => Promise.resolve()),
  } satisfies PiWebNativeHost;
}

function memoryStorage(): DesktopNotificationStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
