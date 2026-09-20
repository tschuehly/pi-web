import type { AppState } from "../appState";
import { machineSessionKey } from "../machineKeys";
import { selectedMachineId } from "./types";

export interface DesktopNotificationHandle {
  onclick: ((event: Event) => void) | null;
  close(): void;
}

export interface DesktopNotificationBrowser {
  permission(): NotificationPermission | "unsupported";
  requestPermission(): Promise<NotificationPermission>;
  isBackground(): boolean;
  show(title: string, options: NotificationOptions): DesktopNotificationHandle;
  focus(): void;
}

export type DesktopNotificationKind = "complete" | "ask" | "dialog" | "error";

export class DesktopNotificationController {
  private sessionKey: string | undefined;
  private armed = false;
  private streaming: boolean | undefined;
  private readonly askIds = new Set<string>();
  private readonly dialogIds = new Set<string>();
  private readonly errorIds = new Set<string>();

  constructor(
    private readonly browser: DesktopNotificationBrowser,
    private readonly onPermissionChange: () => void = () => undefined,
  ) {}

  canRequestPermission(): boolean {
    return this.browser.permission() === "default";
  }

  async requestPermission(): Promise<void> {
    if (!this.canRequestPermission()) return;
    await this.browser.requestPermission();
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
    const notification = this.browser.show(`PI WEB · ${title}`, { body, tag: `${this.sessionKey ?? "chat"}:${tag}` });
    notification.onclick = () => {
      this.browser.focus();
      notification.close();
    };
  }
}

export function browserDesktopNotifications(): DesktopNotificationBrowser {
  return {
    permission: () => typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    isBackground: () => document.hidden || !document.hasFocus(),
    show: (title, options) => new Notification(title, options),
    focus: () => { window.focus(); },
  };
}

function selectedSessionKey(state: AppState): string | undefined {
  return state.selectedSession === undefined ? undefined : machineSessionKey(selectedMachineId(state), state.selectedSession.id);
}
