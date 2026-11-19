import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

const SCHEMA = { documents: { "workbench.delegation": 1 }, tasks: { "workbench.child-reporter": 1 } };

/** A revision folder whose host entry runs Pi Durable `version` and writes the store `schema` (null: no store-schema.json). */
function revision(name: string, version: string, schema: object | null = SCHEMA): string {
  const entry = join(ROOT, name, "main.mjs");
  const manifest = join(ROOT, name, "node_modules", "@earendil-works", "pi-durable");
  mkdirSync(manifest, { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(join(manifest, "package.json"), JSON.stringify({ version }));
  if (schema !== null) writeFileSync(join(ROOT, name, "store-schema.json"), JSON.stringify(schema));
  return entry;
}

/**
 * A launchd host double: ready (or exits 3 when `fail`, or never answers when it is "hang"), answers status (streaming once it took a prompt), and a close
 * that, with `ifRestartSafe`, is refused while a turn runs, as the Workbench host refuses it.
 */
class Fake extends EventEmitter implements DurableHostProcess {
  readonly requests: Request[] = [];
  streaming = false;
  onStatus: ((request: Request) => boolean) | undefined;
  holdResume = false;
  beforeResume: (() => void) | undefined;
  /** Answers resume, or B's conditional close, with an error; or never answers that close ("hang"). */
  resumeError = false;
  closeError: boolean | "hang" = false;
  kills = 0;

  constructor(readonly code: { entry: string; current: string }, readonly exitHook: () => void, fail: boolean | "hang" = false) {
    super();
    queueMicrotask(() => {
      if (fail === "hang") return;
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
        if (this.resumeError) {
          this.emit("message", { id: request.id, error: { name: "Error", message: "injected resume failure" } });
          return;
        }
      }
      if (request.method === "close" && request.params?.["ifRestartSafe"] === true && this.closeError !== false) {
        if (this.closeError === true) this.emit("message", { id: request.id, error: { name: "Error", message: "injected quiet-check failure" } });
        return;
      }
      if (request.method === "close" && request.params?.["ifRestartSafe"] === true && this.streaming) {
        this.reply(request, { closed: false, busy: "a turn is running" });
        return;
      }
      // As the Workbench host: B's close is accepted affirmatively.
      this.reply(request, request.method === "status" ? { ...status, isStreaming: this.streaming } : request.params?.["ifRestartSafe"] === true ? { closed: true } : null);
      if (request.method === "close") {
        this.exitHook();
        this.emit("exit", 0, null);
      }
    });
    return true;
  }

  kill(): boolean {
    this.kills++;
    this.exitHook();
    this.emit("exit", null, "SIGTERM");
    return true;
  }

  detach(): void { /* a launchd host keeps running */ }
}

/** A daemon over one Chat pinned to `pin`, with `current` the code new hosts get. */
function setup(pin: string, current: string, options: { failCurrent?: boolean; failPin?: boolean; failResume?: boolean; autoUpgrade?: boolean; subscribers?: boolean } = {}) {
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
    const fail = entry === current ? options.failCurrent === true : options.failPin === true;
    // A newer host that fails after migrating the store, before it is ready.
    if (fail) writeFileSync(join(storeDir, "session.sqlite"), "migrated");
    const host = new Fake({ entry, current }, () => { locator.setHost(chat.id, undefined); }, fail);
    if (!fail) locator.setHostEntry(chat.id, entry);
    host.resumeError = entry === current && options.failResume === true;
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

  it("A: Upgrade now refuses a move to another Pi Durable version; the pin and store stay as they were", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [old, b] = [revision("rev-old", "1.4.0"), revision("rev-b", "1.5.2")];
    const s = setup(old, b);
    await s.durable.status(s.ref);
    writeFileSync(join(s.storeDir, "session.sqlite"), "history");
    await expect(s.durable.upgradeHost(s.ref, "now")).rejects.toThrow("This upgrade changes the store format (Pi Durable 1.4.0 to 1.5.2); use Upgrade host when the Chat is quiet");
    expect(s.hosts).toHaveLength(1);
    expect(s.hosts[0]?.requests.map((request) => request.method)).not.toContain("close");
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(old);
    expect(s.locator.durable(s.ref.id)?.upgrade).toBeUndefined();
    expect(readFileSync(join(s.storeDir, "session.sqlite"), "utf8")).toBe("history");
    expect(readdirSync(join(ROOT, "stores"))).toEqual([basename(s.storeDir)]);
    expect((await s.durable.status(s.ref)).durableHostPin?.revision).toBe("rev-old");
    await s.durable.dispose();
  });

  it("round 4 F1: Upgrade now refuses a move to another store schema, or one it cannot read, within one Pi Durable version", async () => {
    for (const [schema, refusal] of [
      [{ ...SCHEMA, documents: { "workbench.delegation": 2 } }, "This upgrade changes the store format (its Workbench store schema); use Upgrade host when the Chat is quiet"],
      // Code without the file is older than a declared schema (round 5): refused as any move to an older store is.
      [null, "This Chat was opened by host code with a newer Workbench store schema than the current host"],
    ] as const) {
      ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
      const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2", schema)];
      const s = setup(a, b);
      await s.durable.status(s.ref);
      await expect(s.durable.upgradeHost(s.ref, "now")).rejects.toThrow(refusal);
      expect(s.hosts).toHaveLength(1);
      expect(s.hosts[0]?.requests.map((request) => request.method)).not.toContain("close");
      expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(a);
      await s.durable.dispose();
      rmSync(ROOT, { recursive: true, force: true });
    }
    ROOT = "";
  });

  it("round 5 P1-3: quiet Upgrade host and the idle close never move a family to an older or unreadable Workbench store schema; a pin older than store-schema.json moves forward", async () => {
    for (const [pinSchema, currentSchema] of [[{ ...SCHEMA, documents: { "workbench.delegation": 2 } }, SCHEMA], [SCHEMA, null]] as const) {
      ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
      const [a, b] = [revision("rev-a", "1.5.2", pinSchema), revision("rev-b", "1.5.2", currentSchema)];
      const s = setup(a, b, { subscribers: false });
      await s.durable.status(s.ref);
      await expect(s.durable.upgradeHost(s.ref)).rejects.toThrow("This Chat was opened by host code with a newer Workbench store schema than the current host");
      expect(s.hosts[0]?.requests.map((request) => request.method)).not.toContain("close");
      expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(a);
      // The idle close still closes the host, but the pin stays on the code that wrote the store.
      s.idle();
      await s.durable.closeIdleHosts();
      expect(s.hosts[0]?.requests.map((request) => request.method)).toContain("close");
      expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(a);
      await s.durable.dispose();
      rmSync(ROOT, { recursive: true, force: true });
    }
    // Host code without store-schema.json predates it and wrote every Workbench kind at version 1: it moves forward.
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2", null), revision("rev-b", "1.5.2")];
    const s = setup(a, b);
    await s.durable.status(s.ref);
    await s.durable.upgradeHost(s.ref);
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(b);
    await s.durable.dispose();
  });

  it("Upgrade host moves a Chat that serves Atelier Pages across a store schema change and starts the new host at once; the idle close still keeps it", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2", { ...SCHEMA, documents: { "workbench.delegation": 2 } })];
    const s = setup(a, b, { subscribers: false });
    await s.durable.status(s.ref);
    const [old] = s.hosts;
    if (old === undefined) throw new Error("no host");
    old.onStatus = (request) => {
      old.reply(request, { ...status, extensionStatuses: { "pi-workbench:atelier": JSON.stringify({ schemaVersion: 1, serving: true }) } });
      return true;
    };
    s.idle();
    await s.durable.closeIdleHosts();
    expect(old.requests.map((request) => request.method)).not.toContain("close");
    await expect(s.durable.upgradeHost(s.ref, "now")).rejects.toThrow("This upgrade changes the store format (its Workbench store schema)");
    await s.durable.upgradeHost(s.ref);
    expect(old.requests.map((request) => request.method)).toContain("close");
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(b);
    expect(s.hosts).toHaveLength(2);
    await s.durable.dispose();
  });

  it("B: a store-format change moves by itself only when the Chat is quiet, Pages or not, on a new host started at once; never to a store it cannot read", async () => {
    for (const [pinVersion, schema] of [["1.4.0", SCHEMA], ["1.5.2", { ...SCHEMA, documents: { "workbench.delegation": 2 } }]] as const) {
      ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
      const [a, b] = [revision("rev-a", pinVersion), revision("rev-b", "1.5.2", schema)];
      const s = setup(a, b, { autoUpgrade: true });
      expect((await s.durable.status(s.ref)).durableHostPin?.pending).toBe(true);
      const [old] = s.hosts;
    if (old === undefined) throw new Error("no host");
      let extra: Record<string, unknown> = { pendingAsks: [{ id: "q" }] };
      old.onStatus = (request) => {
        old.reply(request, { ...status, extensionStatuses: { "pi-workbench:atelier": "{}" }, ...extra });
        return true;
      };
      // An open question keeps it: the quiet move would close the host under it.
      await s.durable.upgradePendingHosts();
      expect(old.requests.map((request) => request.method)).not.toContain("close");
      extra = {};
      await s.durable.upgradePendingHosts();
      expect(old.requests.map((request) => request.method)).toContain("close");
      expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(b);
      expect(s.hosts).toHaveLength(2);
      await s.durable.dispose();
      rmSync(ROOT, { recursive: true, force: true });
    }
    // Code that cannot read the store is never pending.
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const s = setup(revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2", null), { autoUpgrade: true });
    expect((await s.durable.status(s.ref)).durableHostPin?.pending).toBeUndefined();
    await s.durable.dispose();
  });

  it("A: a failed start within one Pi Durable version restores only the pin", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const s = setup(a, b, { failCurrent: true });
    await s.durable.status(s.ref);
    await expect(s.durable.upgradeHost(s.ref, "now")).rejects.toThrow(/did not start: .*\. This Chat is back on its old host code \(rev-a\)\.$/);
    expect(s.hosts.map((host) => host.code.entry)).toEqual([a, b, a]);
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(a);
    expect(s.locator.durable(s.ref.id)?.upgrade).toBeUndefined();
    // The store is the one store: no copy, nothing put back.
    expect(readdirSync(join(ROOT, "stores"))).toEqual([basename(s.storeDir)]);
    expect(s.hosts[2]?.requests.filter((request) => request.method === "resume")).toHaveLength(1);
    await s.durable.dispose();
  });

  it("round 4 F2: when the new and then the old code fail to start, the caller gets the error and nothing rejects unobserved", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const options = { failCurrent: true, failPin: false };
    const s = setup(a, b, options);
    await s.durable.status(s.ref);
    options.failPin = true;
    const unobserved: unknown[] = [];
    const record = (reason: unknown) => { unobserved.push(reason); };
    process.on("unhandledRejection", record);
    try {
      await expect(s.durable.upgradeHost(s.ref, "now")).rejects.toThrow(/did not start there either/);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      expect(unobserved).toEqual([]);
      expect(s.hosts.map((host) => host.code.entry)).toEqual([a, b, a]);
    } finally {
      process.off("unhandledRejection", record);
    }
    await s.durable.dispose();
  });

  it("B: a failed write of the upgrade's phase leaves the family on its host, every request answered", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const s = setup(a, b);
    await s.durable.status(s.ref);
    const write = s.locator.setUpgradeState.bind(s.locator);
    s.locator.setUpgradeState = () => { throw Object.assign(new Error("injected phase-write ENOSPC"), { code: "ENOSPC" }); };
    await expect(s.durable.upgradeHost(s.ref, "now")).rejects.toThrow(/phase-write ENOSPC/);
    s.locator.setUpgradeState = write;
    expect(await Promise.race([s.durable.status(s.ref).then(() => "answered"), new Promise((resolve) => { setTimeout(() => { resolve("blocked"); }, 500); })])).toBe("answered");
    expect(s.hosts).toHaveLength(1);
    expect(s.hosts[0]?.requests.map((request) => request.method)).not.toContain("close");
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(a);
    expect(s.locator.durable(s.ref.id)?.upgrade).toBeUndefined();
    await s.durable.dispose();
  });

  it("B: a failed pin write after the close rolls back on exactly one host, every request answered", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const s = setup(a, b);
    await s.durable.status(s.ref);
    const write = s.locator.setHostEntry.bind(s.locator);
    let failed = false;
    // As a full disk does: the record changes in memory, the write to disk throws.
    s.locator.setHostEntry = (id, entry) => {
      write(id, entry);
      if (entry === b && !failed) { failed = true; throw Object.assign(new Error("injected pin-write ENOSPC"), { code: "ENOSPC" }); }
    };
    const during = s.durable.upgradeHost(s.ref, "now");
    const meanwhile = s.durable.status(s.ref);
    await expect(during).rejects.toThrow(/pin-write ENOSPC.*back on its old host code/);
    await meanwhile;
    expect(await Promise.race([s.durable.status(s.ref).then(() => "answered"), new Promise((resolve) => { setTimeout(() => { resolve("blocked"); }, 500); })])).toBe("answered");
    expect(s.hosts.map((host) => host.code.entry)).toEqual([a, a]);
    expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(a);
    expect(s.locator.durable(s.ref.id)?.upgrade).toBeUndefined();
    await s.durable.dispose();
  });

  it("C: an automatic upgrade whose safe close fails or goes unanswered never terminates the host; it stays pending", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const s = setup(a, b, { autoUpgrade: true });
    await s.durable.status(s.ref);
    const host = s.hosts[0];
    if (host === undefined) throw new Error("no host");
    for (const closeError of [true, "hang"] as const) {
      host.closeError = closeError;
      await s.durable.upgradePendingHosts();
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      expect(host.kills, String(closeError)).toBe(0);
      expect(s.hosts).toHaveLength(1);
      expect(s.locator.durable(s.ref.id)?.hostEntry).toBe(a);
      expect(s.locator.durable(s.ref.id)?.upgrade).toBeUndefined();
      expect((await s.durable.status(s.ref)).durableHostPin?.pending).toBe(true);
    }
    host.closeError = false;
    await s.durable.dispose();
  });

  it("D: a rejected resume keeps the owed resume on disk; the next daemon sends it and only then clears it", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const s = setup(a, b, { failResume: true });
    await s.durable.status(s.ref);
    await expect(s.durable.upgradeHost(s.ref, "now")).rejects.toThrow(/injected resume failure/);
    expect(new SessionRuntimeLocator(ROOT).durable(s.ref.id)?.upgrade).toEqual({ from: a });
    await s.durable.dispose();
    const disk = new SessionRuntimeLocator(ROOT);
    const attached: Fake[] = [];
    const restarted = new DurableChatService({
      locator: disk, events, storesDir: join(ROOT, "stores"),
      launch: (chat) => { const host = new Fake({ entry: disk.durable(chat.id)?.hostEntry ?? b, current: b }, () => undefined); attached.push(host); return host; },
    });
    await restarted.reattach();
    expect(attached.map((host) => host.code.entry)).toEqual([b]);
    expect(attached[0]?.requests.filter((request) => request.method === "resume")).toHaveLength(1);
    expect(new SessionRuntimeLocator(ROOT).durable(s.ref.id)?.upgrade).toBeUndefined();
    await restarted.dispose();
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
    expect(s.locator.durable(s.ref.id)?.upgrade).toBeUndefined();
    await s.durable.dispose();
  });

  it("finding 5: a daemon that dies before the new host's resume leaves the obligation on disk; the next daemon resumes it", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2")];
    const locator = new SessionRuntimeLocator(ROOT);
    const record = locator.create("/work", "chat");
    locator.setHostEntry(record.id, a);
    let resumeSent!: () => void;
    const waiting = new Promise<void>((resolve) => { resumeSent = resolve; });
    const hosts: Fake[] = [];
    const launch: DurableHostLauncher = (chat) => {
      const entry = locator.durable(chat.id)?.hostEntry ?? b;
      const host = new Fake({ entry, current: b }, () => { locator.setHost(chat.id, undefined); });
      hosts.push(host);
      locator.setHostEntry(chat.id, entry);
      locator.setHost(chat.id, { label: "test.fake", socket: "fake.sock", revision: dirname(entry), ownerEpoch: hosts.length, pid: hosts.length });
      if (entry === b) { host.holdResume = true; host.beforeResume = resumeSent; }
      return host;
    };
    const durable = new DurableChatService({ locator, events, launch, storesDir: join(ROOT, "stores") });
    const ref = { id: record.id, cwd: record.cwd };
    await durable.status(ref);
    void durable.upgradeHost(ref, "now").catch(() => undefined);
    await waiting;
    await durable.dispose();

    const disk = new SessionRuntimeLocator(ROOT);
    expect(disk.durable(record.id)?.upgrade).toEqual({ from: a });
    const attached: Fake[] = [];
    const restarted = new DurableChatService({
      locator: disk, events, storesDir: join(ROOT, "stores"),
      launch: (chat) => { const host = new Fake({ entry: disk.durable(chat.id)?.hostEntry ?? b, current: b }, () => undefined); attached.push(host); return host; },
    });
    await restarted.reattach();
    expect(attached).toHaveLength(1);
    expect(attached[0]?.requests.filter((request) => request.method === "resume").map((request) => request.params)).toEqual([{ reason: "upgrade-restart" }]);
    expect(disk.durable(record.id)?.hostEntry).toBe(b);
    expect(disk.durable(record.id)?.upgrade).toBeUndefined();
    expect(new SessionRuntimeLocator(ROOT).durable(record.id)?.upgrade).toBeUndefined();
    await restarted.dispose();
  });

  it("finding 5: a daemon that dies while newer code starts leaves the old pin on disk; the next daemon rolls back to it", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [old, b] = [revision("rev-old", "1.5.2"), revision("rev-b", "1.5.2")];
    const daemon = (newHost: "hang" | true) => {
      const locator = new SessionRuntimeLocator(ROOT);
      const hosts: Fake[] = [];
      const launch: DurableHostLauncher = (chat, storeDir) => {
        const entry = locator.durable(chat.id)?.hostEntry ?? b;
        mkdirSync(storeDir, { recursive: true });
        if (entry === b) writeFileSync(join(storeDir, "session.sqlite"), "migrated");
        const host = new Fake({ entry, current: b }, () => { locator.setHost(chat.id, undefined); }, entry === b ? newHost : false);
        hosts.push(host);
        return host;
      };
      return { locator, hosts, durable: new DurableChatService({ locator, events, launch, storesDir: join(ROOT, "stores") }) };
    };
    const first = daemon("hang");
    const record = first.locator.create("/work", "chat");
    first.locator.setHostEntry(record.id, old);
    const ref = { id: record.id, cwd: record.cwd };
    const storeDir = join(ROOT, "stores", record.storeId);
    await first.durable.status(ref);
    writeFileSync(join(storeDir, "session.sqlite"), "history");
    void first.durable.upgradeHost(ref, "now").catch(() => undefined);
    await new Promise<void>((resolve) => { const check = () => { if (first.hosts.length === 2) resolve(); else setTimeout(check, 5); }; check(); });
    // The daemon dies here (its handover never resolves).
    void first.durable.dispose();
    expect(new SessionRuntimeLocator(ROOT).durable(record.id)?.upgrade).toEqual({ from: old });

    // The next daemon: the new code fails again, so the family goes back to its old pin; the store is left as it is.
    const next = daemon(true);
    await next.durable.reattach();
    expect(next.hosts.map((host) => host.code.entry)).toEqual([b, old]);
    expect(readdirSync(join(ROOT, "stores"))).toEqual([record.storeId]);
    expect(next.hosts[1]?.requests.some((request) => request.method === "resume")).toBe(true);
    expect(next.locator.durable(record.id)?.hostEntry).toBe(old);
    expect(next.locator.durable(record.id)?.upgrade).toBeUndefined();
    await next.durable.dispose();
  });

  it("finding 5: Cancel of a pending automatic upgrade survives a daemon restart, until newer code is offered", async () => {
    ROOT = mkdtempSync(join(tmpdir(), "durable-upgrade-"));
    const [a, b, c] = [revision("rev-a", "1.5.2"), revision("rev-b", "1.5.2"), revision("rev-c", "1.5.2")];
    const s = setup(a, b, { autoUpgrade: true });
    expect((await s.durable.status(s.ref)).durableHostPin?.pending).toBe(true);
    await s.durable.upgradeHost(s.ref, "cancel");
    await s.durable.dispose();
    const daemon = (current: string) => {
      const locator = new SessionRuntimeLocator(ROOT);
      return new DurableChatService({ locator, events, storesDir: join(ROOT, "stores"), autoUpgrade: true, launch: (chat) => new Fake({ entry: locator.durable(chat.id)?.hostEntry ?? current, current }, () => undefined) });
    };
    const again = daemon(b);
    const pin = (await again.status(s.ref)).durableHostPin;
    expect(pin).toBeDefined();
    expect(pin?.pending).toBeUndefined();
    await again.dispose();
    const newer = daemon(c);
    expect((await newer.status(s.ref)).durableHostPin?.pending).toBe(true);
    await newer.dispose();
  });
});
