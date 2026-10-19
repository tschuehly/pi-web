import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeChats, emptyWindow, moveChats, openChat, parseWindowStore, type WindowStore } from "../workbenchWindows";
import { loadDraft, moveDraft, saveDraft } from "../promptDraftStorage";
import { FakeLocks } from "./webLocks.testSupport";
import { WINDOW_HEARTBEAT_KEY, WINDOW_STORE_KEY, WINDOW_STORE_LOCK, WorkbenchWindowController, newWindowId, type WindowLocks, type WindowRequest, type WorkbenchWindowEnvironment } from "./workbenchWindowController";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

interface FakeWindow {
  environment: WorkbenchWindowEnvironment;
  url: URL;
  storageListeners: ((key: string | null) => void)[];
  pageHide: (() => void)[];
}

/** One test's BroadcastChannel: every page hears every post, after the posting task, as in a browser. */
type Bus = Set<(message: unknown) => void>;

function fakeWindow(storage: Storage, href: string, newId = "fresh", locks?: WindowLocks, tabStorage: Storage = new MemoryStorage(), bus: Bus = new Set()): FakeWindow {
  const fake: FakeWindow = {
    url: new URL(href),
    storageListeners: [],
    pageHide: [],
    environment: {
      storage,
      draftStorage: storage,
      tabStorage,
      locks,
      url: () => new URL(fake.url),
      replaceUrl: (url) => { fake.url = url; },
      now: () => Date.now(),
      newId: () => newId,
      onStorage: (listener) => { fake.storageListeners.push(listener); return () => { fake.storageListeners = fake.storageListeners.filter((candidate) => candidate !== listener); }; },
      onPageHide: (listener) => { fake.pageHide.push(listener); return () => { fake.pageHide = []; }; },
      post: (message) => { for (const listener of bus) void Promise.resolve().then(() => { listener(message); }); },
      onMessage: (listener) => { bus.add(listener); return () => { bus.delete(listener); }; },
    },
  };
  return fake;
}

const chat = (sessionId: string) => ({ sessionId, title: sessionId, machineId: "local" });
const storeWith = (windows: WindowStore) => JSON.stringify(windows);

let storage: MemoryStorage;
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  storage = new MemoryStorage();
});
afterEach(() => { vi.useRealTimers(); });

describe("window identity", () => {
  it("keeps the window id from the URL, so a restored native window gets its Chats back", async () => {
    storage.setItem(WINDOW_STORE_KEY, storeWith(openChat({ w1: emptyWindow("Window 1") }, "w1", chat("a"))));
    const fake = fakeWindow(storage, "http://pi.test/app/?win=w1&session=a");
    const controller = new WorkbenchWindowController(() => undefined, fake.environment);
    await controller.start();

    expect(controller.id).toBe("w1");
    expect(controller.window?.chats.map((candidate) => candidate.sessionId)).toEqual(["a"]);
    expect(fake.url.search).toBe("?win=w1&session=a");
  });

  it("reopens a closed window's Chats in a window without an id, and writes the id into the URL", async () => {
    storage.setItem(WINDOW_STORE_KEY, storeWith({
      open: openChat({ open: emptyWindow("Window 1") }, "open", chat("a"))["open"] ?? emptyWindow("x"),
      closed: openChat({ closed: emptyWindow("Window 2") }, "closed", chat("b"))["closed"] ?? emptyWindow("x"),
      empty: emptyWindow("Window 3"),
    }));
    storage.setItem(WINDOW_HEARTBEAT_KEY, JSON.stringify({ open: Date.now() }));
    const fake = fakeWindow(storage, "http://pi.test/app/");
    const controller = new WorkbenchWindowController(() => undefined, fake.environment);
    await controller.start();

    expect(controller.id).toBe("closed");
    expect(fake.url.searchParams.get("win")).toBe("closed");
    expect(Object.keys(controller.store).sort()).toEqual(["closed", "open"]);
  });

  it("starts a new named window when every stored one is still open", async () => {
    storage.setItem(WINDOW_STORE_KEY, storeWith(openChat({ open: emptyWindow("Window 1") }, "open", chat("a"))));
    storage.setItem(WINDOW_HEARTBEAT_KEY, JSON.stringify({ open: Date.now() }));
    const controller = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/").environment);
    await controller.start();

    expect(controller.id).toBe("fresh");
    expect(controller.window?.name).toBe("Window 2");
  });
});

describe("shared store", () => {
  it("applies changes to the latest stored state and reports other windows' writes", async () => {
    const external = vi.fn();
    const fake = fakeWindow(storage, "http://pi.test/?win=w1");
    const controller = new WorkbenchWindowController(external, fake.environment);
    await controller.start();
    const other = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w2").environment);
    await other.start();

    await other.update((store, id) => openChat(store, id, chat("b")));
    expect(await controller.update((store, id) => openChat(store, id, chat("a")))).toBe(true);
    expect(await controller.update((store) => store)).toBe(false);
    expect(Object.keys(controller.store).sort()).toEqual(["w1", "w2"]);

    for (const listener of fake.storageListeners) listener(WINDOW_HEARTBEAT_KEY);
    expect(external).not.toHaveBeenCalled();
    await other.update((store, id) => openChat(store, id, chat("a")));
    for (const listener of fake.storageListeners) listener(WINDOW_STORE_KEY);
    expect(external).toHaveBeenCalledTimes(1);
    expect(controller.window?.chats).toEqual([]);
  });

  it("marks the window closed when its page goes away, and alive again on the next heartbeat", async () => {
    const fake = fakeWindow(storage, "http://pi.test/?win=w1");
    const controller = new WorkbenchWindowController(() => undefined, fake.environment);
    await controller.start();
    const observer = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w2").environment);

    expect(observer.isAlive("w1")).toBe(true);
    for (const listener of fake.pageHide) listener();
    expect(observer.isAlive("w1")).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(observer.isAlive("w1")).toBe(true);
    controller.dispose();
    vi.advanceTimersByTime(60_000);
    expect(observer.isAlive("w1")).toBe(false);
  });
});

describe("draft ownership", () => {
  it("r5–r8: serializes a token reservation with a real-id claim, then rejects every former-owner writer", async () => {
    const locks = new FakeLocks();
    const source = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w1", "w1", locks).environment);
    const target = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w2", "w2", locks).environment);
    await source.start();
    await target.start();
    const pending = { ...chat("creating:one"), startupToken: "creating:one" };
    const real = { ...chat("real"), startupToken: pending.startupToken };
    const release = locks.hold(WINDOW_STORE_LOCK);
    const reserving = source.claim(pending);
    const competing = target.claim(real);
    release();
    expect(await reserving).toBe(true);
    expect(await competing).toBe(false);
    expect(saveDraft("local:creating:one", "first prompt", source.draftStorage)).toBe(true);
    expect(saveDraft("local:creating:one", "foreign", target.draftStorage)).toBe(false);
    expect(await source.claim(real)).toBe(true);
    moveDraft("local:creating:one", "local:real", source.draftStorage);
    expect(loadDraft("local:real", storage)).toBe("first prompt");
    await source.update((store, id) => moveChats(store, id, "w2", [real.sessionId]));
    expect(saveDraft("local:real", "target edits", target.draftStorage)).toBe(true);
    expect(saveDraft("local:real", "late source callback", source.draftStorage)).toBe(false);
    expect(saveDraft("local:real", "", source.draftStorage)).toBe(false);
    expect(saveDraft("local:creating:one", "late pending callback", source.draftStorage)).toBe(false);
    expect(loadDraft("local:real", storage)).toBe("target edits");
    source.dispose();
    target.dispose();
  });

  it("recovers a closed creator's reservation and rejects its late callbacks before releasing its id", async () => {
    const locks = new FakeLocks();
    const source = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w1", "w1", locks).environment);
    const target = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w2", "w2", locks).environment);
    await source.start();
    await target.start();
    await source.claim({ ...chat("creating:one"), startupToken: "creating:one" });
    saveDraft("local:creating:one", "recover me", source.draftStorage);
    source.dispose();
    expect(saveDraft("local:creating:one", "late callback", source.draftStorage)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(await target.claim({ ...chat("real"), startupToken: "creating:one" })).toBe(true);
    expect(loadDraft("local:real", storage)).toBe("recover me");
    expect(source.window?.chats).not.toHaveLength(0); // Its stale view is not write authority.
    expect(parseWindowStore(storage.getItem(WINDOW_STORE_KEY))["w1"]?.chats).toEqual([]);
    target.dispose();
  });

  it("r6: a failed migration never erases the only stored draft", () => {
    saveDraft("local:creating:one", "first prompt", storage);
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    moveDraft("local:creating:one", "local:real", storage);
    expect(loadDraft("local:creating:one", storage)).toBe("first prompt");
  });
});

describe("Web Locks", () => {
  const chatsOf = (windowId: string) => parseWindowStore(storage.getItem(WINDOW_STORE_KEY))[windowId]?.chats.map((candidate) => candidate.sessionId);

  it("serializes store writes, so a window writing meanwhile keeps its Chat", async () => {
    const locks = new FakeLocks();
    const controller = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w1", "fresh", locks).environment);
    await controller.start();
    let write = (): void => undefined;
    // Window 2 reads the store and writes it back with its Chat, holding the store lock in between.
    const other = locks.request(WINDOW_STORE_LOCK, {}, async () => {
      const read = parseWindowStore(storage.getItem(WINDOW_STORE_KEY));
      await new Promise<void>((resolve) => { write = resolve; });
      storage.setItem(WINDOW_STORE_KEY, JSON.stringify(openChat(read, "w2", chat("b"))));
    });

    const mine = controller.update((store, id) => openChat(store, id, chat("a")));
    write();
    await Promise.all([other, mine]);

    expect(chatsOf("w1")).toEqual(["a"]);
    expect(chatsOf("w2")).toEqual(["b"]);
  });

  it("gives a second page asking for a live window's id a window of its own, and the id back once that page closes", async () => {
    const locks = new FakeLocks();
    storage.setItem(WINDOW_STORE_KEY, storeWith(openChat({ w1: emptyWindow("Window 1") }, "w1", chat("a"))));
    const first = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w1", "unused", locks).environment);
    await first.start();
    const duplicate = fakeWindow(storage, "http://pi.test/?win=w1&session=a", "w2", locks);
    const second = new WorkbenchWindowController(() => undefined, duplicate.environment);
    await second.start();

    expect(first.id).toBe("w1");
    expect(second.id).toBe("w2");
    expect(duplicate.url.search).toBe("?win=w2&session=a");
    expect(second.window?.chats).toEqual([]);
    expect(chatsOf("w1")).toEqual(["a"]);

    first.dispose();
    await vi.advanceTimersByTimeAsync(0);
    const reopened = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w1", "unused", locks).environment);
    await reopened.start();
    expect(reopened.id).toBe("w1");
  });

  it("keeps a tab's window id when the tab loads a Chat URL without one, as the macOS app opens notifications", async () => {
    const locks = new FakeLocks();
    storage.setItem(WINDOW_STORE_KEY, storeWith({
      w1: openChat({ w1: emptyWindow("Window 1") }, "w1", chat("a"))["w1"] ?? emptyWindow("x"),
      w2: openChat({ w2: emptyWindow("Window 2") }, "w2", chat("b"))["w2"] ?? emptyWindow("x"),
    }));
    const tab = new MemoryStorage();
    const first = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w2", "unused", locks, tab).environment);
    await first.start();
    first.dispose();
    await vi.advanceTimersByTimeAsync(0);

    const reloaded = fakeWindow(storage, "http://pi.test/?session=a", "unused", locks, tab);
    const controller = new WorkbenchWindowController(() => undefined, reloaded.environment);
    await controller.start();
    expect(controller.id).toBe("w2");
    expect(reloaded.url.search).toBe("?session=a&win=w2");
    expect(await controller.ownerOf("a")).toBeUndefined();
    const owner = new WorkbenchWindowController(() => undefined, fakeWindow(storage, "http://pi.test/?win=w1", "unused", locks).environment);
    await owner.start();
    expect(await controller.ownerOf("a")).toBe("w1");
    expect(await controller.ownerOf("b")).toBeUndefined();
  });
});

describe("asking the window holding a Chat", () => {
  const noop = () => undefined;
  let locks: FakeLocks;
  let bus: Bus;
  const page = (windowId: string, onRequest?: (request: WindowRequest) => boolean | Promise<boolean>) =>
    new WorkbenchWindowController(noop, fakeWindow(storage, `http://pi.test/?win=${windowId}`, windowId, locks, new MemoryStorage(), bus).environment, onRequest);
  beforeEach(() => {
    locks = new FakeLocks();
    bus = new Set();
    storage.setItem(WINDOW_STORE_KEY, storeWith(openChat({ w1: emptyWindow("Window 1") }, "w1", chat("a"))));
  });

  it("asks a holder that reloads again, until it answers", async () => {
    const holder = page("w1", () => { holder.dispose(); return new Promise<boolean>(noop); });
    await holder.start();
    const asker = page("w2");
    await asker.start();

    const outcome = asker.showInOwner("a", "entry:e1");
    await vi.advanceTimersByTimeAsync(600);
    const shown: WindowRequest[] = [];
    const reloaded = page("w1", (request) => { shown.push(request); return true; });
    await reloaded.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toBe("shown");
    expect(shown).toEqual([{ kind: "select", sessionId: "a", anchor: "entry:e1" }]);
  });

  it("reports a live holder that stays silent, and opens the Chat here once the holder is gone", async () => {
    const holder = page("w1", () => new Promise<boolean>(noop));
    await holder.start();
    const asker = page("w2");
    await asker.start();

    const silent = asker.showInOwner("a", undefined);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await silent).toBe("unanswered");

    const closing = asker.showInOwner("a", undefined);
    await vi.advanceTimersByTimeAsync(100);
    holder.dispose();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await closing).toBe("here");
    expect(await asker.showInOwner("a", undefined)).toBe("here");
  });

  it("claims a Chat only while no other window holds it, and frees it from a closed holder", async () => {
    const holder = page("w1");
    await holder.start();
    const asker = page("w2");
    await asker.start();

    expect(await asker.claim(chat("a"))).toBe(false);
    expect(asker.store["w1"]?.chats.map((candidate) => candidate.sessionId)).toEqual(["a"]);
    expect(await asker.claim(chat("b"))).toBe(true);
    expect(await holder.claim(chat("b"))).toBe(false);

    holder.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(await asker.claim(chat("a"))).toBe(false);
    await asker.releaseClosed("a");
    expect(await asker.claim(chat("a"))).toBe(true);
    expect(asker.window?.chats.map((candidate) => candidate.sessionId)).toEqual(["b", "a"]);
    expect(asker.store["w1"]?.chats).toEqual([]);
  });

  it("refuses a claim or move the full store cannot record, so no second window may claim the Chat too", async () => {
    const first = page("w2");
    await first.start();
    const second = page("w3");
    await second.start();
    const setItem = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });

    await expect(first.claim(chat("b"))).rejects.toThrow("storage is full");
    await expect(second.claim(chat("b"))).rejects.toThrow("storage is full");
    expect(first.window?.chats).toEqual([]);
    setItem.mockRestore();
    expect(await first.claim(chat("b"))).toBe(true);

    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    await expect(first.update((store, id) => closeChats(store, id, ["b"]))).rejects.toThrow("storage is full");
    expect(first.window?.chats.map((candidate) => candidate.sessionId)).toEqual(["b"]);
    expect(await second.claim(chat("b"))).toBe(false);
  });

  it("without Web Locks shares nothing and routes nothing", async () => {
    storage.setItem(WINDOW_HEARTBEAT_KEY, JSON.stringify({ w1: Date.now() }));
    const controller = new WorkbenchWindowController(noop, fakeWindow(storage, "http://pi.test/?win=w2").environment);
    await controller.start();

    expect(controller.shared).toBe(false);
    expect(await controller.showInOwner("a", undefined)).toBe("here");
  });
});

describe("newWindowId", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("works without crypto.randomUUID, as on a plain-http LAN origin", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array<ArrayBuffer>) => real.getRandomValues(array) });

    expect(newWindowId()).toMatch(/^[0-9a-f]{8}$/);
  });
});
