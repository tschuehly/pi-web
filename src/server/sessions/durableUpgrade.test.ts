import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DURABLE_HOST_PROTOCOL, DurableChatService, type DurableHostLauncher, type DurableHostProcess, IDLE_HOST_CLOSE_MS } from "./durableChatService.js";
import type { DurableChatRecord } from "./sessionRuntimeLocator.js";
import { SessionRuntimeLocator } from "./sessionRuntimeLocator.js";

// Daemon orchestration of the seamless host upgrades (idle close, Upgrade now, automatic upgrade) against host doubles:
// which code each host starts from, what the store holds after a failed start, and what survives a daemon restart.

const status = { persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], messageCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
const events = { publish: () => undefined, publishGlobal: () => undefined, currentSeq: () => 0, hasSessionSubscribers: () => true };
interface Request { id: number; method: string; params?: Record<string, unknown> }

function isRequest(value: unknown): value is Request {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "number" && "method" in value && typeof value.method === "string";
}

let ROOT = "";
afterEach(() => { if (ROOT !== "") rmSync(ROOT, { recursive: true, force: true }); });

/** A revision folder whose host entry runs Pi Durable `version`. */
function revision(name: string, version: string): string {
  const entry = join(ROOT, name, "main.mjs");
  const manifest = join(ROOT, name, "node_modules", "@earendil-works", "pi-durable");
  mkdirSync(manifest, { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(join(manifest, "package.json"), JSON.stringify({ version }));
  return entry;
}

/**
 * A launchd host double: ready (or exits 3 when `fail`), answers status (streaming once it took a prompt), and a close
 * that, with `ifRestartSafe`, is refused while a turn runs, as the Workbench host refuses it.
 */
class Fake extends EventEmitter implements DurableHostProcess {
  readonly requests: Request[] = [];
  streaming = false;
  onStatus: ((request: Request) => boolean) | undefined;
  holdResume = false;
  beforeResume: (() => void) | undefined;

  constructor(readonly code: { entry: string; current: string }, readonly exitHook: () => void, fail = false) {
    super();
    queueMicrotask(() => {
      if (fail) this.emit("exit", 3, null);
      else this.emit("message", { ready: { protocol: DURABLE_HOST_PROTOCOL, revision: dirname(code.entry), capabilities: [], closeIfRestartSafe: true } });
    });
  }

  reply(request: Request, result: unknown): void { this.emit("message", { id: request.id, result }); }

  send(request: unknown): boolean {
    if (!isRequest(request)) return false;
    this.requests.push(request);
    queueMicrotask(() => {
      if (request.method === "status" && this.onStatus?.(request) === true) return;
      if (request.method === "prompt") this.streaming = true;
      if (request.method === "resume") {
        this.beforeResume?.();
        if (this.holdResume) return;
      }
      if (request.method === "close" && request.params?.["ifRestartSafe"] === true && this.streaming) {
        this.reply(request, { closed: false, busy: "a turn is running" });
        return;
      }
      this.reply(request, request.method === "status" ? { ...status, isStreaming: this.streaming } : null);
      if (request.method === "close") {
        this.exitHook();
        this.emit("exit", 0, null);
      }
    });
    return true;
  }

  kill(): boolean {
    this.exitHook();
    this.emit("exit", null, "SIGTERM");
    return true;
  }

  detach(): void { /* a launchd host keeps running */ }
}

/** A daemon over one Chat pinned to `pin`, with `current` the code new hosts get. */
function setup(pin: string, current: string, options: { failCurrent?: boolean; autoUpgrade?: boolean; subscribers?: boolean } = {}) {
  const locator = new SessionRuntimeLocator(ROOT);
  const record = locator.create("/work", "chat");
  locator.setHostEntry(record.id, pin);
  const storesDir = join(ROOT, "stores");
  const hosts: Fake[] = [];
  let now = 0;
  const launch: DurableHostLauncher = (chat: DurableChatRecord, storeDir: string) => {
    const entry = locator.durable(chat.id)?.hostEntry ?? current;
    mkdirSync(storeDir, { recursive: true });
    // Every host that opens the store leaves its Pi Durable version there (a newer one migrates it).
    writeFileSync(join(storeDir, "opened-by"), entry);
    const fail = entry === current && options.failCurrent === true;
    // A newer host that fails after migrating the store, before it is ready.
    if (fail) writeFileSync(join(storeDir, "session.sqlite"), "migrated");
    const host = new Fake({ entry, current }, () => { locator.setHost(chat.id, undefined); }, fail);
    if (!fail) locator.setHostEntry(chat.id, entry);
    hosts.push(host);
    return host;
  };
  const durable = new DurableChatService({
    locator, launch, storesDir, now: () => now, closeGraceMs: 100,
    events: { ...events, hasSessionSubscribers: () => options.subscribers ?? true },
    ...(options.autoUpgrade === undefined ? {} : { autoUpgrade: options.autoUpgrade }),
  });
  return { durable, locator, hosts, ref: { id: record.id, cwd: record.cwd }, storeDir: join(storesDir, record.storeId), idle: () => { now += IDLE_HOST_CLOSE_MS; } };
}

describe("seamless upgrade orchestration", () => {
  it("finding 1: an idle-closed Chat a newer Pi Durable opened stays on that code after the daemon rolls back", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b, old] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2"), revision("rev-old", "1.4.0")];
    const s = setup(a, b, { subscribers: false });
    await s.durable.status(s.ref);
    s.idle();
    await s.durable.closeIdleHosts();
    expect(s.hosts[0]?.requests.map((request) => request.method)).toContain("close");
    // The pin moved to the current code (nothing was running), not away: it still names code that opened the store.
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(b);
    await s.durable.dispose();

    // A daemon rolled back to 1.4.0 reopens the Chat on the 1.5.2 code, never on its own older one.
    const locator = new SessionRuntimeLocator(ROOT);
    let selected = "";
    const back = new DurableChatService({
      locator, events, storesDir: join(ROOT, "stores"),
      launch: (chat) => { selected = locator.durable(chat.id)?.hostEntry ?? old; return new Fake({ entry: selected, current: old }, () => undefined); },
    });
    const reopened = await back.status(s.ref);
    expect(selected).toBe(b);
    expect(reopened.durableHostPin).toBeDefined();
    await expect(back.upgradeHost(s.ref, "now")).rejects.toThrow(/opened by a newer Pi Durable \(1\.5\.2\)/);
    await back.dispose();
  });

  it("finding 2: a failed start of newer Pi Durable code restores the store before the old code reopens it", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [old, b] = [revision("rev-old", "1.4.0"), revision("rev-b", "1.5.2")];
    const s = setup(old, b, { failCurrent: true });
    await s.durable.status(s.ref);
    writeFileSync(join(s.storeDir, "session.sqlite"), "history");
    await expect(s.durable.upgradeHost(s.ref, "now")).rejects.toThrow(/back on its old host code/);
    expect(s.hosts.map((host) => host.code.entry)).toEqual([old, b, old]);
    // The 1.4.0 host reopened the store as it was before the 1.5.2 host touched it.
    expect(readFileSync(join(s.storeDir, "session.sqlite"), "utf8")).toBe("history");
    expect(readFileSync(join(s.storeDir, "opened-by"), "utf8")).toBe(old);
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(old);
    expect(existsSync(`${s.storeDir}.pre-upgrade`)).toBe(false);
    await s.durable.dispose();
  });

  it("finding 2: a successful cross-version upgrade drops its store snapshot", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [old, b] = [revision("rev-old", "1.4.0"), revision("rev-b", "1.5.2")];
    const s = setup(old, b);
    await s.durable.status(s.ref);
    expect((await s.durable.upgradeHost(s.ref, "now")).durableHostPin).toBeUndefined();
    expect(existsSync(`${s.storeDir}.pre-upgrade`)).toBe(false);
    await s.durable.dispose();
  });

  it("finding 3: a double click runs one upgrade: one old and one new host, one resume, both clicks answered", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const s = setup(a, b);
    await s.durable.status(s.ref);
    const results = await Promise.allSettled([s.durable.upgradeHost(s.ref, "now"), s.durable.upgradeHost(s.ref, "now"), s.durable.upgradeHost(s.ref)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(s.hosts).toHaveLength(2);
    expect(s.hosts.flatMap((host) => host.requests.map((request) => request.method)).filter((method) => method === "resume" || method === "close")).toEqual(["close", "resume"]);
    await s.durable.dispose();
  });

  it("finding 4: an automatic upgrade never closes a host that admitted input after the quiet check", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const s = setup(a, b, { autoUpgrade: true });
    await s.durable.status(s.ref);
    const host = s.hosts[0];
    if (host === undefined) throw new Error("no host");
    let release!: () => void;
    let sampled!: () => void;
    const sampledQuiet = new Promise<void>((resolve) => { sampled = resolve; });
    host.onStatus = (request) => { release = () => { host.reply(request, status); }; host.onStatus = undefined; sampled(); return true; };
    const moving = s.durable.upgradePendingHosts();
    await sampledQuiet;
    await s.durable.prompt(s.ref, "owner input just arrived", undefined, undefined, { operationId: "input-race" });
    release();
    await moving;
    // The host refused the conditional close: it keeps running its turn, and the family stays pending on its pin.
    const close = host.requests.find((request) => request.method === "close");
    expect(close?.params).toEqual({ reason: "upgrade", ifRestartSafe: true });
    expect(s.hosts).toHaveLength(1);
    const after = await s.durable.status(s.ref);
    expect(after.isStreaming).toBe(true);
    expect(after.durableHostPin?.pending).toBe(true);
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(a);
    await s.durable.dispose();
  });
});
