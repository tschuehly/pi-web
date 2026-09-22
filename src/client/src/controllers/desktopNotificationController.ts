import type { AppState } from "../appState";
import { machineSessionKey } from "../machineKeys";
import type { PiWebNativeHost } from "../nativeHost";
import { selectedMachineId } from "./types";

export interface DesktopNotificationHandle {
  onclick: ((event: Event) => void) | null;
  close(): void;
}

export interface DesktopNotificationBrowser {
  diagnostic?: string;
  permission(): NotificationPermission | "unsupported";
  requestPermission(): Promise<NotificationPermission>;
  isBackground(): boolean;
  show(title: string, options: NotificationOptions): DesktopNotificationHandle | Promise<DesktopNotificationHandle>;
  focus(): void;
}

export interface DesktopNotificationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type DesktopNotificationKind = "complete" | "ask" | "dialog" | "error";

export class DesktopNotificationController {
  private sessionKey: string | undefined;
  diagnostic: string | undefined;
  private armed = false;
  private streaming: boolean | undefined;
  private readonly askIds = new Set<string>();
  private readonly dialogIds = new Set<string>();
  private readonly errorIds = new Set<string>();

  constructor(
    private readonly browser: DesktopNotificationBrowser,
    private readonly onPermissionChange: () => void = () => undefined,
  ) {
    this.diagnostic = browser.diagnostic;
  }

  canRequestPermission(): boolean {
    return this.browser.permission() === "default";
  }

  async requestPermission(): Promise<void> {
    if (!this.canRequestPermission()) return;
    try {
      await this.browser.requestPermission();
      this.diagnostic = this.browser.permission() === "denied"
        ? BROWSER_PERMISSION_DENIED
        : this.browser.diagnostic;
    } catch (error) {
      this.diagnostic = notificationDiagnostic(error, "permission");
    }
    this.onPermissionChange();
  }

  sync(previous: AppState, next: AppState): void {
    const nextKey = selectedSessionKey(next);
    if (nextKey !== this.sessionKey) {
      this.reset(nextKey);
      return;
    }
    if (!this.armed || nextKey === undefined) return;

    const nextStreaming = next.status?.isStreaming;
    if (this.streaming === true && nextStreaming === false) this.notify("complete", "Chat complete", "The selected Chat finished responding.");
    this.streaming = nextStreaming;

    const askId = next.pendingAsk?.askId;
    if (askId !== undefined && !this.askIds.has(askId)) {
      this.askIds.add(askId);
      this.notify("ask", "Question needs an answer", "The selected Chat is waiting for input.");
    }
    for (const dialog of next.pendingDialogs) {
      if (this.dialogIds.has(dialog.dialogId)) continue;
      this.dialogIds.add(dialog.dialogId);
      this.notify("dialog", "Dialog needs attention", dialog.title);
    }

    void previous;
  }

  /** Seed authoritative join state without notifying for hydration or reconnect. */
  activate(state: AppState): void {
    const key = selectedSessionKey(state);
    if (key !== this.sessionKey) this.reset(key);
    this.armed = key !== undefined;
    this.streaming = state.status?.isStreaming;
    if (state.pendingAsk !== undefined) this.askIds.add(state.pendingAsk.askId);
    for (const dialog of state.pendingDialogs) this.dialogIds.add(dialog.dialogId);
  }

  suspend(): void {
    this.armed = false;
  }

  sessionError(state: AppState, message: string, eventId: number | undefined): void {
    const key = selectedSessionKey(state);
    if (key === undefined || key !== this.sessionKey) return;
    const id = eventId === undefined ? message : String(eventId);
    if (this.errorIds.has(id)) return;
    this.errorIds.add(id);
    this.notify("error", "Chat error", message);
  }

  private reset(sessionKey: string | undefined): void {
    this.sessionKey = sessionKey;
    this.armed = false;
    this.streaming = undefined;
    this.askIds.clear();
    this.dialogIds.clear();
    this.errorIds.clear();
  }

  private notify(tag: DesktopNotificationKind, title: string, body: string): void {
    if (this.browser.permission() !== "granted" || !this.browser.isBackground()) return;
    try {
      const shown = this.browser.show(`PI WEB · ${title}`, { body, tag: `${this.sessionKey ?? "chat"}:${tag}` });
      if (shown instanceof Promise) {
        void shown.then((notification) => { this.bindClick(notification); }).catch((error: unknown) => { this.deliveryFailed(error); });
        return;
      }
      this.bindClick(shown);
    } catch (error) {
      this.deliveryFailed(error);
    }
  }

  private deliveryFailed(error: unknown): void {
    this.diagnostic = notificationDiagnostic(error, "delivery");
    this.onPermissionChange();
  }

  private bindClick(notification: DesktopNotificationHandle): void {
    notification.onclick = () => {
      this.browser.focus();
      notification.close();
    };
  }
}

const NATIVE_NOTIFICATION_PERMISSION_KEY = "pi-web:native-notifications:permission";
const BROWSER_PERMISSION_DENIED = "Desktop notification permission was denied. Enable notifications for PI WEB in your browser's site settings (and System Settings if needed), then reload.";

export function desktopNotifications(
  nativeHost: PiWebNativeHost | undefined = typeof window === "undefined" ? undefined : window.piWebNative,
  storage: DesktopNotificationStorage | undefined = browserLocalStorage(),
): DesktopNotificationBrowser {
  if (supportsNativeNotifications(nativeHost)) return nativeDesktopNotifications(nativeHost, storage);
  const browser = browserDesktopNotifications();
  if (nativeHost !== undefined) {
    const bridgeDiagnostic = "The installed app's native notification bridge is missing. Update the app to enable native notifications; browser notifications remain available.";
    browser.diagnostic = browser.diagnostic === undefined ? bridgeDiagnostic : `${bridgeDiagnostic} ${browser.diagnostic}`;
  }
  return browser;
}

export function browserDesktopNotifications(): DesktopNotificationBrowser {
  return {
    ...(typeof Notification !== "undefined" && Notification.permission === "denied" ? { diagnostic: BROWSER_PERMISSION_DENIED } : {}),
    permission: () => typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    isBackground: () => document.hidden || !document.hasFocus(),
    show: (title, options) => new Notification(title, options),
    focus: () => { window.focus(); },
  };
}

type NativeNotificationHost = Required<Pick<PiWebNativeHost, "requestNotificationPermission" | "notify">>;

function supportsNativeNotifications(nativeHost: PiWebNativeHost | undefined): nativeHost is PiWebNativeHost & NativeNotificationHost {
  return typeof nativeHost?.requestNotificationPermission === "function" && typeof nativeHost.notify === "function";
}

function nativeDesktopNotifications(nativeHost: NativeNotificationHost, storage: DesktopNotificationStorage | undefined): DesktopNotificationBrowser {
  let permission: NotificationPermission = readNativePermission(storage);
  const downgrade = (): void => {
    permission = "default";
    try { storage?.removeItem(NATIVE_NOTIFICATION_PERMISSION_KEY); } catch { /* Storage may be unavailable. */ }
  };
  return {
    permission: () => permission,
    requestPermission: async () => {
      try {
        await nativeHost.requestNotificationPermission();
        permission = "granted";
        try { storage?.setItem(NATIVE_NOTIFICATION_PERMISSION_KEY, "granted"); } catch { /* Keep this page enabled. */ }
      } catch (error) {
        downgrade();
        throw error;
      }
      return permission;
    },
    isBackground: () => document.hidden || !document.hasFocus(),
    show: async (title, options) => {
      try {
        await nativeHost.notify(title, options.body ?? "");
        return { onclick: null, close: () => undefined };
      } catch (error) {
        downgrade();
        throw error;
      }
    },
    focus: () => undefined,
  };
}

function notificationDiagnostic(error: unknown, operation: "permission" | "delivery"): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/installed app bundle/i.test(detail)) return "Native notifications require the installed app bundle. Launch the installed app to enable them.";
  if (/denied/i.test(detail)) return "Desktop notification permission was denied. Enable notifications for PI WEB in System Settings.";
  return operation === "permission"
    ? `Desktop notification permission request failed: ${detail}. Try again or check System Settings.`
    : `Desktop notification delivery failed: ${detail}. Check notification settings and try enabling notifications again.`;
}

function readNativePermission(storage: DesktopNotificationStorage | undefined): NotificationPermission {
  try { return storage?.getItem(NATIVE_NOTIFICATION_PERMISSION_KEY) === "granted" ? "granted" : "default"; } catch { return "default"; }
}

function browserLocalStorage(): DesktopNotificationStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

function selectedSessionKey(state: AppState): string | undefined {
  return state.selectedSession === undefined ? undefined : machineSessionKey(selectedMachineId(state), state.selectedSession.id);
}
