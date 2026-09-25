import type { AppState } from "../appState";
import type { SessionAttentionEvent } from "../../../shared/apiTypes";
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
  private readonly seen = new Set<string>();
  private readonly recentErrors = new Map<string, number>();

  constructor(
    private readonly browser: DesktopNotificationBrowser,
    private readonly onPermissionChange: () => void = () => undefined,
    private readonly workstreamTitle: () => string | undefined = () => undefined,
    private readonly openChat: (machineId: string, sessionId: string) => void = () => undefined,
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
    if (this.streaming === true && nextStreaming === false) {
      const reply = [...next.messages].reverse().find((line) => line.role === "assistant")?.parts
        .filter((part) => part.type === "text").map((part) => part.text).join("");
      this.notifySelected(next, "complete", `Finished · ${preview(reply ?? "")}`);
    }
    this.streaming = nextStreaming;

    const askId = next.pendingAsk?.askId;
    if (askId !== undefined && this.mark(nextKey, "ask", askId)) {
      this.notifySelected(next, "ask", `Question · ${next.pendingAsk?.questions[0]?.question ?? "Needs an answer"}`);
    }
    for (const dialog of next.pendingDialogs) {
      if (!this.mark(nextKey, "dialog", dialog.dialogId)) continue;
      this.notifySelected(next, "dialog", `Dialog · ${dialog.title}`);
    }

    void previous;
  }

  /** Seed authoritative join state without notifying for hydration or reconnect. */
  activate(state: AppState): void {
    const key = selectedSessionKey(state);
    if (key !== this.sessionKey) this.reset(key);
    this.armed = key !== undefined;
    this.streaming = state.status?.isStreaming;
    if (key !== undefined && state.pendingAsk !== undefined) this.mark(key, "ask", state.pendingAsk.askId);
    if (key !== undefined) for (const dialog of state.pendingDialogs) this.mark(key, "dialog", dialog.dialogId);
  }

  suspend(): void {
    this.armed = false;
  }

  sessionError(state: AppState, message: string, eventId: number | undefined): void {
    const key = selectedSessionKey(state);
    if (key === undefined || key !== this.sessionKey) return;
    const id = eventId === undefined ? message : String(eventId);
    if (this.mark(key, "error", id)) this.notifySelected(state, "error", `Error · ${message}`);
  }

  attention(state: AppState, event: SessionAttentionEvent, machineId: string): void {
    const key = machineSessionKey(machineId, event.sessionId);
    if (key === selectedSessionKey(state) || !this.mark(key, event.kind, event.id)) return;
    const reason = event.kind === "ask" ? "Question" : event.kind === "dialog" ? "Dialog" : "Error";
    this.notify(machineId, event.sessionId, event.cwd, event.sessionName, event.kind, `${reason} · ${event.detail}`);
  }

  private mark(key: string, kind: SessionAttentionEvent["kind"], id: string): boolean {
    const identity = JSON.stringify([key, kind, id]);
    if (this.seen.has(identity)) return false;
    // Retain recent event identities across Chat switches without unbounded growth.
    const oldest = this.seen.values().next().value;
    if (this.seen.size >= 2048 && oldest !== undefined) this.seen.delete(oldest);
    this.seen.add(identity);
    return true;
  }

  private reset(sessionKey: string | undefined): void {
    this.sessionKey = sessionKey;
    this.armed = false;
    this.streaming = undefined;
  }

  private notifySelected(state: AppState, tag: DesktopNotificationKind, body: string): void {
    const session = state.selectedSession;
    if (session === undefined) return;
    this.notify(selectedMachineId(state), session.id, session.cwd, session.name === undefined || session.name.trim() === "" ? this.workstreamTitle() : session.name, tag, body);
  }

  private notify(machineId: string, sessionId: string, cwd: string, name: string | undefined, tag: DesktopNotificationKind, body: string): void {
    if (this.browser.permission() !== "granted" || !this.browser.isBackground()) return;
    const key = machineSessionKey(machineId, sessionId);
    if (tag === "error") {
      const now = Date.now();
      if (now - (this.recentErrors.get(key) ?? -Infinity) < 30_000) return;
      this.recentErrors.set(key, now);
      const oldest = this.recentErrors.keys().next().value;
      if (this.recentErrors.size > 2048 && oldest !== undefined) this.recentErrors.delete(oldest);
    }
    const title = [name, cwd.split("/").filter(Boolean).at(-1), cwd]
      .find((value) => value !== undefined && value.trim().length > 0)?.trim() ?? "Chat";
    try {
      const shown = this.browser.show(title, { body, tag: `${key}:${tag}`, data: { machineId, sessionId } });
      if (shown instanceof Promise) {
        void shown.then((notification) => { this.bindClick(notification, machineId, sessionId); }).catch((error: unknown) => { this.deliveryFailed(error); });
        return;
      }
      this.bindClick(shown, machineId, sessionId);
    } catch (error) {
      this.deliveryFailed(error);
    }
  }

  private deliveryFailed(error: unknown): void {
    this.diagnostic = notificationDiagnostic(error, "delivery");
    this.onPermissionChange();
  }

  private bindClick(notification: DesktopNotificationHandle, machineId: string, sessionId: string): void {
    notification.onclick = () => {
      this.browser.focus();
      this.openChat(machineId, sessionId);
      notification.close();
    };
  }
}

function preview(text: string): string {
  const firstLine = text.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  return firstLine.length === 0 ? "Response complete" : firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
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
        const target: unknown = options.data;
        if (typeof target !== "object" || target === null || !("machineId" in target) || typeof target.machineId !== "string"
          || !("sessionId" in target) || typeof target.sessionId !== "string") throw new Error("Notification requires a Chat target");
        await nativeHost.notify(title, options.body ?? "", { machineId: target.machineId, sessionId: target.sessionId });
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
