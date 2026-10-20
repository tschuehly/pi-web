import { closeChats, ensureWindow, focusChat, openChat, parseWindowStore, type WindowChat, type WindowStore, type WorkbenchWindow } from "../workbenchWindows";
import { machineSessionKey } from "../machineKeys";
import { moveDraft, ownedDraftStorage, type DraftStorage } from "../promptDraftStorage";
import { randomHex } from "../randomHex";

export const WINDOW_STORE_KEY = "pi-workbench.windows.v1";
/** Window id → last heartbeat (ms), on its own key so heartbeats never re-render other windows. */
export const WINDOW_HEARTBEAT_KEY = "pi-workbench.windows.alive.v1";
export const WINDOW_URL_PARAM = "win";
/** Web Lock serializing every window's read-modify-write of the shared store. */
export const WINDOW_STORE_LOCK = "pi-workbench.windows.store";
/** Web Lock a live page holds on its window id, so no second page claims the same Chats. */
export const WINDOW_ID_LOCK_PREFIX = "pi-workbench.windows.id:";
/** BroadcastChannel on which windows ask each other to show or hand over Chats, and answer. */
export const WINDOW_CHANNEL = "pi-workbench.windows";
/** sessionStorage key keeping a tab's window id across a load without `?win=` (the macOS app opens notifications so). */
const TAB_WINDOW_KEY = "pi-workbench.window-id";
const HEARTBEAT_MS = 10_000;
const STALE_MS = 3 * HEARTBEAT_MS;
/** A Chat's holder answers a show request within this, or is asked again: it may be reloading. */
const SELECT_REPLY_MS = 500;
const SELECT_ATTEMPTS = 6;

/** The part of `navigator.locks` the windows use. */
export interface WindowLocks {
  request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: Lock | null) => T): Promise<Awaited<T>>;
  query(): Promise<LockManagerSnapshot>;
}

/** What one window asks another: show one of its Chats, or hand Chats over to the asking window. */
export type WindowRequest =
  | { kind: "select"; sessionId: string; anchor?: string | undefined }
  | { kind: "move"; sessionIds: string[] };

/** Window `from` asks window `to` (with `request`, void after `expires`), or `to` gets the answer `ok` to its request `id`. */
interface WindowMessage {
  id: string;
  to: string;
  from: string;
  request?: WindowRequest | undefined;
  expires?: number | undefined;
  ok?: boolean | undefined;
}

export interface WorkbenchWindowEnvironment {
  storage: Storage;
  /** Always localStorage: drafts outlive the window even when `storage` is per tab. */
  draftStorage: DraftStorage;
  /** This tab's sessionStorage, which survives reloads and same-tab navigation. */
  tabStorage: Pick<Storage, "getItem" | "setItem"> | undefined;
  /** Absent outside a secure context: each window then keeps its own working set (see {@link browserWindowEnvironment}). */
  locks: WindowLocks | undefined;
  /** The window's URL; the id is written back with `replaceUrl` so the macOS app restores it. */
  url: () => URL;
  replaceUrl: (url: URL) => void;
  now: () => number;
  newId: () => string;
  /** Subscribes to other windows' storage writes; returns the unsubscribe. */
  onStorage: (listener: (key: string | null) => void) => () => void;
  /** Subscribes to the page going away (window closed or reloaded); returns the unsubscribe. */
  onPageHide: (listener: () => void) => () => void;
  post: (message: WindowMessage) => void;
  /** Subscribes to other windows' posts; returns the unsubscribe. */
  onMessage: (listener: (message: unknown) => void) => () => void;
}

/** Eight hex characters. */
export function newWindowId(): string {
  return randomHex(4);
}

export function browserWindowEnvironment(): WorkbenchWindowEnvironment {
  const locks = webLocks();
  return {
    // ponytail: without Web Locks (plain-http LAN origins) windows can neither serialize store writes nor hold their
    // ids, so each tab keeps its own working set in sessionStorage: no moves between windows, no routing to another
    // window, and a restarted macOS app reopens its windows without their tabs. Serve over https or localhost to share.
    storage: locks === undefined ? window.sessionStorage : window.localStorage,
    draftStorage: window.localStorage,
    tabStorage: window.sessionStorage,
    locks,
    url: () => new URL(window.location.href),
    replaceUrl: (url) => { window.history.replaceState(window.history.state, "", url); },
    now: () => Date.now(),
    newId: newWindowId,
    onStorage: (listener) => {
      const onStorage = (event: StorageEvent) => { listener(event.key); };
      window.addEventListener("storage", onStorage);
      return () => { window.removeEventListener("storage", onStorage); };
    },
    onPageHide: (listener) => {
      window.addEventListener("pagehide", listener);
      return () => { window.removeEventListener("pagehide", listener); };
    },
    post: (message) => {
      const channel = new BroadcastChannel(WINDOW_CHANNEL);
      channel.postMessage(message);
      channel.close();
    },
    onMessage: (listener) => {
      const channel = new BroadcastChannel(WINDOW_CHANNEL);
      channel.onmessage = (event: MessageEvent) => { listener(event.data); };
      return () => { channel.close(); };
    },
  };
}

/** `navigator.locks`, missing outside secure contexts (and null in some test DOMs). */
function webLocks(): WindowLocks | undefined {
  const locks: unknown = typeof navigator === "undefined" ? undefined : Reflect.get(navigator, "locks");
  return typeof locks === "object" && locks !== null ? navigator.locks : undefined;
}

/**
 * Owns this window's identity and its read-modify-write access to the shared window store. `start` claims the URL's
 * `?win=` id, else the working set of a window nobody holds any more (a closed window reopened with ⌘N), else a new
 * one; a live page holds its id's Web Lock, so a second page asking for the same id gets a new one. Every store write
 * runs under one Web Lock, so windows never overwrite each other's changes. Other windows' writes arrive through
 * `onExternalChange`.
 */
export class WorkbenchWindowController {
  private windowId = "";
  private current: WindowStore = {};
  /** Set while started; a `start` still claiming after `dispose` sees a different run and stops. */
  private run: object | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void)[] = [];
  private releaseId: (() => void) | undefined;
  private asked = 0;
  private readonly answers = new Map<string, (ok: boolean) => void>();
  readonly draftStorage: DraftStorage;

  constructor(
    private readonly onExternalChange: () => void,
    private readonly environment: WorkbenchWindowEnvironment = browserWindowEnvironment(),
    /** Another window asks this one something, which is void after `expires` (ms); resolves to whether this window did it. */
    private readonly onRequest: (request: WindowRequest, from: string, expires: number) => boolean | Promise<boolean> = () => false,
  ) {
    // Only the holder can hand a live claim on. Its synchronous writes finish before that handoff;
    // dispose revokes callbacks before releasing the id lock, so a closed holder cannot write late.
    this.draftStorage = ownedDraftStorage((key) => this.run !== undefined && this.read()[this.windowId]?.chats.some((chat) =>
      key === machineSessionKey(chat.machineId, chat.sessionId)
      || chat.startupToken !== undefined && key === machineSessionKey(chat.machineId, chat.startupToken.startsWith("creating:") ? chat.startupToken : `creating:${chat.startupToken}`),
    ) === true, environment.draftStorage);
  }

  get id(): string { return this.windowId; }
  /** False without Web Locks: this window then shares nothing with the others. */
  get shared(): boolean { return this.environment.locks !== undefined; }
  get store(): WindowStore { return this.current; }
  get window(): WorkbenchWindow | undefined { return this.current[this.windowId]; }

  async start(): Promise<void> {
    if (this.run !== undefined) return;
    const run = {};
    this.run = run;
    if (this.windowId === "") await this.claimId();
    else await this.holdId(this.windowId);
    if (this.run !== run) return;
    this.beat();
    this.heartbeat = setInterval(() => { this.beat(); }, HEARTBEAT_MS);
    this.unsubscribe = [
      this.environment.onStorage((key) => {
        if (key !== WINDOW_STORE_KEY) return;
        this.current = this.read();
        this.onExternalChange();
      }),
      // A reloaded page beats again on start; a closed one stays marked closed.
      this.environment.onPageHide(() => { this.markClosed(); }),
      this.environment.onMessage((message) => { void this.receive(message); }),
    ];
  }

  private async claimId(): Promise<void> {
    const url = this.environment.url();
    const stored = this.read();
    const alive = this.readHeartbeats();
    const now = this.environment.now();
    const isAlive = (id: string) => (alive[id] ?? 0) > now - STALE_MS;
    const requested = url.searchParams.get(WINDOW_URL_PARAM) ?? this.environment.tabStorage?.getItem(TAB_WINDOW_KEY) ?? null;
    const candidates = requested !== null && requested !== "" ? [requested]
      : Object.keys(stored).filter((candidate) => !isAlive(candidate) && (stored[candidate]?.chats.length ?? 0) > 0);
    let id: string | undefined;
    for (const candidate of candidates) if (await this.holdId(candidate)) { id = candidate; break; }
    if (id === undefined) {
      id = this.environment.newId();
      await this.holdId(id);
    }
    if (url.searchParams.get(WINDOW_URL_PARAM) !== id) {
      url.searchParams.set(WINDOW_URL_PARAM, id);
      this.environment.replaceUrl(url);
    }
    try { this.environment.tabStorage?.setItem(TAB_WINDOW_KEY, id); } catch { /* The URL still carries the id. */ }
    this.windowId = id;
    const claimed = id;
    // Closed windows without Chats are dropped; closed ones with Chats stay as move targets and for ⌘N to reopen.
    await this.exclusive(() => {
      const latest = this.read();
      const kept = ensureWindow(Object.fromEntries(Object.entries(latest).filter(([candidate, window]) => candidate === claimed || isAlive(candidate) || window.chats.length > 0)), claimed);
      try {
        this.write(kept);
      } catch (error) {
        // Only claims and moves must reach the store; the window still shows its working set.
        console.warn(error);
        this.current = kept;
      }
    });
  }

  /** Holds `id` for this page's lifetime; false while another live page holds it. */
  private holdId(id: string): Promise<boolean> {
    const locks = this.environment.locks;
    if (locks === undefined) return Promise.resolve(true);
    return new Promise((held) => {
      void locks.request(`${WINDOW_ID_LOCK_PREFIX}${id}`, { ifAvailable: true }, (lock) => {
        held(lock !== null);
        return lock === null ? undefined : new Promise<void>((release) => { this.releaseId = release; });
      });
    });
  }

  /** Applies `change` to the latest stored state under the store lock; resolves to whether anything changed, rejects when it cannot be stored. */
  update(change: (store: WindowStore, windowId: string) => WindowStore): Promise<boolean> {
    if (this.windowId === "") return Promise.resolve(false);
    return this.exclusive(() => {
      const latest = this.read();
      this.current = latest;
      const next = change(latest, this.windowId);
      if (next === latest) return false;
      this.write(next);
      return true;
    });
  }

  /** Runs `step` while no other window writes the store; immediately without Web Locks. */
  private exclusive<T>(step: () => T): Promise<Awaited<T>> {
    const locks = this.environment.locks;
    return locks === undefined ? Promise.resolve(step()) : locks.request(WINDOW_STORE_LOCK, {}, step);
  }

  /**
   * Opens `chat` in this window only while no other window holds it, decided under the store lock as the claim commits:
   * a selection that started before another window took the Chat, or before this one handed it on, takes nothing back.
   * Rejects when the store cannot record the claim, which other windows would then never see; a Chat the store already
   * gives this window stays claimed.
   */
  claim(chat: WindowChat, focus = true): Promise<boolean> {
    if (this.windowId === "") return Promise.resolve(true);
    return this.exclusive(async () => {
      const latest = this.read();
      this.current = latest;
      const holder = this.holderIn(latest, chat.sessionId, chat.startupToken);
      const reservationWindow = holder ?? this.windowId;
      const reservation = latest[reservationWindow]?.chats.find((held) => held.sessionId !== chat.sessionId && held.sessionId.startsWith("creating:") && held.startupToken !== undefined && held.startupToken === chat.startupToken);
      // A real-id claim is compare-and-set even for a closed target: a delayed selection must not undo a move.
      // A pending reservation cannot be moved; only its dead creator may be recovered here.
      if (holder !== undefined && (reservation === undefined || await this.isHeld(holder))) return false;
      try {
        const claimed = openChat(reservation === undefined ? latest : closeChats(latest, reservationWindow, [reservation.sessionId]), this.windowId, chat);
        this.write(focus ? claimed : focusChat(claimed, this.windowId, latest[this.windowId]?.focused ?? chat.sessionId));
      } catch (error) {
        if (latest[this.windowId]?.chats.some((held) => held.sessionId === chat.sessionId) !== true) throw error;
      }
      // Transfer the draft only after ownership commits, under the same lock as the identity change.
      if (reservation !== undefined) moveDraft(machineSessionKey(chat.machineId, reservation.sessionId), machineSessionKey(chat.machineId, chat.sessionId), this.draftStorage);
      return true;
    });
  }

  /** Frees a closed holder only at the start of a new navigation, never while a delayed selection commits. */
  releaseClosed(sessionId: string): Promise<void> {
    return this.exclusive(async () => {
      const latest = this.read();
      const holder = this.holderIn(latest, sessionId);
      if (holder !== undefined && !await this.isHeld(holder)) this.write(closeChats(latest, holder, [sessionId]));
    });
  }

  /** The other live window holding `sessionId`, if any. */
  async ownerOf(sessionId: string): Promise<string | undefined> {
    const holder = this.holderIn(this.read(), sessionId);
    return holder !== undefined && await this.isHeld(holder) ? holder : undefined;
  }

  /** Whether this window holds the Chat, read from the store as stored now: a suspended page may have missed changes. */
  holds(machineId: string, sessionId: string): boolean {
    return this.windowId !== "" && this.read()[this.windowId]?.chats.some((chat) => chat.machineId === machineId && chat.sessionId === sessionId) === true;
  }

  /** The reservation is authoritative even before its backend id is known in this window. */
  reservationId(sessionId: string, startupToken?: string): string {
    return Object.values(this.read()).flatMap((window) => window.chats).find((chat) => chat.sessionId === sessionId || startupToken !== undefined && chat.startupToken === startupToken)?.sessionId ?? sessionId;
  }

  private holderIn(store: WindowStore, sessionId: string, startupToken?: string): string | undefined {
    return Object.entries(store).find(([id, window]) => id !== this.windowId && window.chats.some((chat) => chat.sessionId === sessionId || startupToken !== undefined && chat.startupToken === startupToken))?.[0];
  }

  /** Only a held id lock proves a window alive; without Web Locks no other window counts. */
  private async isHeld(windowId: string): Promise<boolean> {
    const locks = this.environment.locks;
    return locks !== undefined && (await locks.query()).held?.some((lock) => lock.name === `${WINDOW_ID_LOCK_PREFIX}${windowId}`) === true;
  }

  /**
   * Has the other live window holding `sessionId` show it, so that window keeps it: "here" when no live window holds
   * it, "shown" once the holder answers, "unanswered" when it stays alive but silent. A holder reloading meanwhile
   * misses the request and holds its id again moments later, so the request repeats until it answers or stays gone.
   */
  async showInOwner(sessionId: string, anchor: string | undefined): Promise<"here" | "shown" | "unanswered"> {
    let owner = await this.ownerOf(sessionId);
    if (owner === undefined) return "here";
    for (let attempt = 0; attempt < SELECT_ATTEMPTS; attempt += 1) {
      if (await this.ask(owner, { kind: "select", sessionId, anchor }, SELECT_REPLY_MS)) return "shown";
      owner = await this.ownerOf(sessionId) ?? owner;
    }
    return await this.ownerOf(sessionId) === undefined ? "here" : "unanswered";
  }

  /** Asks window `windowId`; false when it declines or does not answer within `timeoutMs`. */
  ask(windowId: string, request: WindowRequest, timeoutMs: number): Promise<boolean> {
    this.asked += 1;
    const id = `${this.windowId}:${String(this.asked)}`;
    return new Promise((resolve) => {
      const answer = (ok: boolean) => { clearTimeout(timer); this.answers.delete(id); resolve(ok); };
      const timer = setTimeout(() => { answer(false); }, timeoutMs);
      this.answers.set(id, answer);
      this.environment.post({ id, to: windowId, from: this.windowId, request, expires: this.environment.now() + timeoutMs });
    });
  }

  private async receive(raw: unknown): Promise<void> {
    const message = windowMessage(raw);
    if (message?.to !== this.windowId) return;
    if (message.request === undefined) {
      this.answers.get(message.id)?.(message.ok === true);
      return;
    }
    const ok = await this.onRequest(message.request, message.from, message.expires ?? 0);
    this.environment.post({ id: message.id, to: message.from, from: this.windowId, ok });
  }

  /** An id for a window this one is about to open. */
  newWindowId(): string { return this.environment.newId(); }

  isAlive(windowId: string): boolean {
    return windowId === this.windowId || (this.readHeartbeats()[windowId] ?? 0) > this.environment.now() - STALE_MS;
  }

  /** Marks this window closed, so other windows label it and the next ⌘N window may reopen its Chats. */
  dispose(): void {
    this.run = undefined;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.releaseId?.();
    this.releaseId = undefined;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
    this.markClosed();
  }

  private markClosed(): void {
    if (this.windowId === "") return;
    this.writeHeartbeats(Object.fromEntries(Object.entries(this.readHeartbeats()).filter(([id]) => id !== this.windowId)));
  }

  private beat(): void {
    this.writeHeartbeats({ ...this.readHeartbeats(), [this.windowId]: this.environment.now() });
  }

  private read(): WindowStore {
    return parseWindowStore(this.environment.storage.getItem(WINDOW_STORE_KEY));
  }

  /** Throws when storage refuses the write (full or private), leaving `current` as last stored. */
  private write(store: WindowStore): void {
    try {
      this.environment.storage.setItem(WINDOW_STORE_KEY, JSON.stringify(store));
    } catch (error) {
      throw new Error("Could not save this window's Chats: browser storage is full or unavailable.", { cause: error });
    }
    this.current = store;
  }

  private readHeartbeats(): Record<string, number> {
    let parsed: unknown;
    try { parsed = JSON.parse(this.environment.storage.getItem(WINDOW_HEARTBEAT_KEY) ?? "{}"); } catch { return {}; }
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  }

  private writeHeartbeats(alive: Record<string, number>): void {
    try {
      this.environment.storage.setItem(WINDOW_HEARTBEAT_KEY, JSON.stringify(alive));
    } catch { /* A missing heartbeat only makes this window look closed to the others. */ }
  }
}

function windowMessage(message: unknown): WindowMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const id: unknown = Reflect.get(message, "id");
  const to: unknown = Reflect.get(message, "to");
  const from: unknown = Reflect.get(message, "from");
  if (typeof id !== "string" || typeof to !== "string" || typeof from !== "string") return undefined;
  const expires: unknown = Reflect.get(message, "expires");
  return { id, to, from, request: windowRequest(Reflect.get(message, "request")), expires: typeof expires === "number" ? expires : undefined, ok: Reflect.get(message, "ok") === true };
}

function windowRequest(request: unknown): WindowRequest | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const kind: unknown = Reflect.get(request, "kind");
  const sessionId: unknown = Reflect.get(request, "sessionId");
  const anchor: unknown = Reflect.get(request, "anchor");
  const sessionIds: unknown = Reflect.get(request, "sessionIds");
  if (kind === "select" && typeof sessionId === "string") return { kind, sessionId, anchor: typeof anchor === "string" ? anchor : undefined };
  if (kind === "move" && Array.isArray(sessionIds) && sessionIds.every((candidate) => typeof candidate === "string")) return { kind, sessionIds };
  return undefined;
}
