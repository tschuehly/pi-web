import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { DURABLE_HOST_PROTOCOL, DurableChatService, IDLE_HOST_CLOSE_MS } from "./durableChatService.js";
import { durableHostSocketPath, launchdDurableHost } from "./durableHostLaunchd.js";
import { SessionRuntimeLocator } from "./sessionRuntimeLocator.js";

// Phase C1 against the real launchd (trial labels only): a family's host is its own job on an owner-only socket; a
// daemon that goes away leaves it running, the next one reattaches, and a stale or foreign socket is refused.
const PREFIX = "com.pi-workbench.durable-trial.host";
const domain = `gui/${String(process.getuid?.())}`;
const status = { persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], messageCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };

/**
 * A host speaking the socket protocol: each start owns the store with the next epoch, answers status and close, and
 * logs every request it gets to `<store>/requests.log` (an explicit end's close as `close:end`, a reason as `:<reason>`), and answers transcript with an empty one. Its revision
 * is the folder of its entry; `<store>/status.json`, when present, overrides fields of its status (a busy family), and a
 * close `ifRestartSafe` is refused while that status says a turn runs. An explicit end cancels the family's jobs in the
 * background bash registry (PI_BACKGROUND_BASH_ROOT), as the Workbench host's cancelAll does: the runner's group is
 * killed and a cancelled exit recorded. With `--end-jobs` it only cancels them, logs `end-jobs` and exits, never serving.
 */
const HOST = `
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const store = arg("--store"), socketPath = arg("--socket");
const epochFile = join(store, "epoch");
const cancelJobs = () => {
  const jobs = process.env.PI_BACKGROUND_BASH_ROOT;
  for (const id of jobs !== undefined && existsSync(jobs) ? readdirSync(jobs) : []) {
    try {
      if (JSON.parse(readFileSync(join(jobs, id, "job.json"), "utf8")).sessionId !== arg("--session-id")) continue;
      try { process.kill(-JSON.parse(readFileSync(join(jobs, id, "claim"), "utf8")).pid, "SIGKILL"); } catch {}
      writeFileSync(join(jobs, id, "exit"), JSON.stringify({ cancelled: true }));
    } catch {}
  }
};
if (process.argv.includes("--end-jobs")) {
  appendFileSync(join(store, "requests.log"), "end-jobs\\n");
  cancelJobs();
  process.exit(0);
}
const ownerEpoch = (existsSync(epochFile) ? Number(readFileSync(epochFile, "utf8")) : 0) + 1;
writeFileSync(epochFile, String(ownerEpoch));
const server = createServer((socket) => {
  socket.write(JSON.stringify({ ready: { protocol: ${String(DURABLE_HOST_PROTOCOL)}, revision: dirname(process.argv[1]), storeId: basename(store), ownerEpoch, pid: process.pid, capabilities: [], closeIfRestartSafe: true } }) + "\\n");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\\n"); end !== -1; end = buffer.indexOf("\\n")) {
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      appendFileSync(join(store, "requests.log"), request.method + (request.params?.end === true ? ":end" : "") + (request.params?.reason === undefined ? "" : ":" + request.params.reason) + "\\n");
      if (request.method === "close" && request.params?.end === true) cancelJobs();
      const override = existsSync(join(store, "status.json")) ? JSON.parse(readFileSync(join(store, "status.json"), "utf8")) : {};
      const current = { ...${JSON.stringify(status)}, ...override };
      if (request.method === "close" && request.params?.ifRestartSafe === true && current.isStreaming) {
        socket.write(JSON.stringify({ id: request.id, result: { closed: false, busy: "a turn is running" } }) + "\\n");
        continue;
      }
      socket.write(JSON.stringify({ id: request.id, result: request.method === "status" ? current : request.method === "transcript" ? { messages: [], partial: null, status: current } : request.params?.ifRestartSafe === true ? { closed: true } : null }) + "\\n", () => { if (request.method === "close") process.exit(0); });
    }
  });
  socket.on("error", () => {});
});
const umask = process.umask(0o077);
server.listen(socketPath);
process.umask(umask);
`;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Unload every job a test left (only labels whose plists it wrote), then remove its folders.
    for (const name of await readdir(join(root, "h")).catch(() => [])) {
      if (name.endsWith(".plist")) { try { execFileSync("launchctl", ["bootout", `${domain}/${name.slice(0, -".plist".length)}`], { stdio: "ignore" }); } catch { /* not loaded */ } }
    }
    await rm(root, { recursive: true, force: true });
  }
});

/** A daemon's view: data in a fresh folder, sockets in a short owner-only one (macOS caps socket paths at 104 bytes). */
interface DaemonOptions { entry?: string; now?: () => number; events?: SessionEventHub; autoUpgrade?: boolean }
async function fixture(): Promise<{ root: string; hostsDir: string; daemon: (warnings?: string[], options?: DaemonOptions) => { durable: DurableChatService; locator: SessionRuntimeLocator } }> {
  const short = tmpdir().length <= 60 ? tmpdir() : join(homedir(), ".pi-workbench", "tmp");
  await mkdir(short, { recursive: true });
  const root = await mkdtemp(join(short, "c1-"));
  roots.push(root);
  const entry = join(root, "host.mjs");
  await writeFile(entry, HOST);
  const hostsDir = join(root, "h");
  const daemon = (warnings: string[] = [], options: DaemonOptions = {}) => {
    // A new locator per daemon: it reads only what the previous daemon persisted.
    const locator = new SessionRuntimeLocator(join(root, "data"));
    const durable = new DurableChatService({
      locator,
      events: options.events ?? new SessionEventHub(),
      launch: launchdDurableHost({ entry: options.entry ?? entry, model: "faux", agentDir: root, thinkingLevel: () => "medium", labelPrefix: PREFIX, hostsDir, locator, startTimeoutMs: 15_000 }),
      storesDir: join(root, "data", "durable"),
      logger: { warn: (_object, message) => { warnings.push(message); } },
      closeGraceMs: 2000,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.autoUpgrade === undefined ? {} : { autoUpgrade: options.autoUpgrade }),
    });
    return { durable, locator };
  };
  return { root, hostsDir, daemon };
}

const jobPid = (label: string): number | undefined => {
  try {
    const pid = /^\s*pid = (\d+)$/m.exec(execFileSync("launchctl", ["print", `${domain}/${label}`], { encoding: "utf8" }))?.[1];
    return pid === undefined ? undefined : Number(pid);
  } catch {
    return undefined;
  }
};
const loaded = (label: string) => { try { execFileSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }); return true; } catch { return false; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const requests = (root: string, storeId: string) => (existsSync(join(root, "data", "durable", storeId, "requests.log")) ? readFileSync(join(root, "data", "durable", storeId, "requests.log"), "utf8").trim().split("\n") : []);

const isReady = (message: unknown) => typeof message === "object" && message !== null && "ready" in message;

/** A listener on `path` that announces `ready` and records whether anyone ever sent it a request. */
async function impostor(path: string, ready: object): Promise<{ server: Server; requested: () => boolean }> {
  let requested = false;
  const server = createServer((socket) => {
    socket.write(`${JSON.stringify({ ready })}\n`);
    socket.on("data", () => { requested = true; });
    socket.on("error", () => undefined);
  });
  const umask = process.umask(0o077);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  process.umask(umask);
  return { server, requested: () => requested };
}

describe.skipIf(process.platform !== "darwin")("Durable hosts as launchd jobs (Phase C1)", () => {
  it("starts the family's host as its own job; a daemon that goes away leaves it, the next one reattaches; stop unloads it", async () => {
    const { root, hostsDir, daemon } = await fixture();
    const first = daemon();
    const chat = await first.durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const label = `${PREFIX}.${chat.id}`;
    const host = first.locator.durable(chat.id)?.host;
    expect(host).toMatchObject({ label, socket: durableHostSocketPath(hostsDir, chat.id), revision: await realpath(root), ownerEpoch: 1 });
    expect(jobPid(label)).toBe(host?.pid);

    await first.durable.dispose();
    expect(alive(host?.pid ?? 0)).toBe(true);

    const second = daemon();
    await second.durable.reattach();
    await expect(second.durable.status(ref)).resolves.toMatchObject({ sessionId: chat.id, isStreaming: false });
    expect(second.locator.durable(chat.id)?.host).toEqual(host);
    expect(jobPid(label)).toBe(host?.pid);

    await second.durable.stop(ref);
    expect(alive(host?.pid ?? 0)).toBe(false);
    expect(loaded(label)).toBe(false);
    expect(existsSync(join(hostsDir, `${label}.plist`))).toBe(false);
    expect(second.locator.durable(chat.id)?.host).toBeUndefined();
    expect(requests(root, chat.id)).toEqual(["status", "close:end"]);
  }, 60_000);

  it("writes no secret-named variable into the job's plist; everything else the daemon has, the host gets", async () => {
    const { hostsDir, daemon } = await fixture();
    const saved = { ...process.env };
    Object.assign(process.env, { FOO_API_KEY: "synthetic-foo-value", BAR_TOKEN: "synthetic-bar-value", Baz_Secret: "synthetic-baz-value", DB_PASSWORD: "synthetic-db-value", CLOUD_CREDENTIALS: "synthetic-cloud-value", SSH_AUTH_SOCK: "/synthetic/agent.sock", PI_WEB_KEEP: "kept" });
    try {
      const { durable } = daemon();
      const chat = await durable.start("/work/a");
      const plist = readFileSync(join(hostsDir, `${PREFIX}.${chat.id}.plist`), "utf8");
      for (const name of ["FOO_API_KEY", "BAR_TOKEN", "Baz_Secret", "DB_PASSWORD", "CLOUD_CREDENTIALS"]) expect(plist).not.toContain(name);
      expect(plist).not.toMatch(/synthetic-[a-z]+-value/);
      expect(plist).toContain(`<key>PATH</key><string>${String(process.env["PATH"])}</string>`);
      expect(plist).toContain("<key>SSH_AUTH_SOCK</key><string>/synthetic/agent.sock</string>");
      expect(plist).toContain("<key>PI_WEB_KEEP</key><string>kept</string>");
      await durable.stop({ id: chat.id, cwd: chat.cwd });
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) Reflect.deleteProperty(process.env, name);
      Object.assign(process.env, saved);
    }
  }, 60_000);

  it("decodes a handshake and messages whose multi-byte characters are split across chunks at any byte", async () => {
    const { root, hostsDir } = await fixture();
    await mkdir(hostsDir, { mode: 0o700 });
    const locator = new SessionRuntimeLocator(join(root, "data"));
    const record = locator.create("/work/a");
    const socket = durableHostSocketPath(hostsDir, record.storeId);
    const ready = { protocol: DURABLE_HOST_PROTOCOL, storeId: record.storeId, ownerEpoch: 1, revision: "/revisions/ä-😀", pid: process.pid };
    const event = { event: { type: "assistant.delta", text: "grüße 😀 ä" } };
    const bytes = Buffer.from(`${JSON.stringify({ ready })}\n${JSON.stringify(event)}\n`);
    let split = 0;
    const server = createServer((connection) => {
      connection.on("error", () => undefined);
      connection.write(bytes.subarray(0, split));
      setTimeout(() => { connection.write(bytes.subarray(split)); }, 3);
    });
    const umask = process.umask(0o077);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    process.umask(umask);
    const launch = launchdDurableHost({ entry: join(root, "host.mjs"), model: "faux", agentDir: root, labelPrefix: PREFIX, hostsDir, locator, launchctl: () => Promise.resolve() });
    try {
      for (split = 1; split < bytes.length; split++) {
        locator.setHost(record.id, { label: `${PREFIX}.${record.id}`, socket, revision: ready.revision, ownerEpoch: 1, pid: process.pid });
        const host = launch(record, join(root, "store"), { attachOnly: true });
        const messages: unknown[] = [];
        host.on("error", () => undefined);
        await new Promise<void>((resolve) => {
          host.on("message", (message) => { messages.push(message); if (messages.length === 2) resolve(); });
          host.on("exit", () => { resolve(); });
        });
        host.detach?.();
        expect(messages, `split at byte ${String(split)}`).toEqual([{ ready }, event]);
      }
    } finally {
      server.close();
    }
  }, 60_000);

  it("round 4 F3: a refused safe close, its connection then lost, leaves the family's job loaded; an accepted one unloads it", async () => {
    const { root, hostsDir } = await fixture();
    await mkdir(hostsDir, { mode: 0o700 });
    const locator = new SessionRuntimeLocator(join(root, "data"));
    const record = locator.create("/work/a");
    const socket = durableHostSocketPath(hostsDir, record.storeId);
    const ready = { protocol: DURABLE_HOST_PROTOCOL, storeId: record.storeId, ownerEpoch: 1, revision: root, pid: process.pid };
    let reply: object = {};
    // A host that answers B's close, then drops the connection (as a refusing host that crashes right after would).
    const server = createServer((connection) => {
      connection.on("error", () => undefined);
      connection.write(`${JSON.stringify({ ready })}\n`);
      connection.on("data", (chunk) => { const { id } = JSON.parse(String(chunk)) as { id: number }; connection.end(`${JSON.stringify({ id, result: reply })}\n`); });
    });
    const umask = process.umask(0o077);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    process.umask(umask);
    const launchctl: string[][] = [];
    const launch = launchdDurableHost({ entry: join(root, "host.mjs"), model: "faux", agentDir: root, labelPrefix: PREFIX, hostsDir, locator, launchctl: (args) => { launchctl.push(args); return Promise.resolve(); } });
    try {
      for (const [result, unloaded] of [[{ closed: false, busy: "a turn is running" }, false], [{ closed: true }, true]] as const) {
        reply = result;
        launchctl.length = 0;
        locator.setHost(record.id, { label: `${PREFIX}.${record.id}`, socket, revision: root, ownerEpoch: 1, pid: process.pid });
        const host = launch(record, join(root, "store"), { attachOnly: true });
        host.on("error", () => undefined);
        await new Promise<void>((resolve) => { host.on("message", (message) => { if (isReady(message)) resolve(); }); });
        const exited = new Promise<unknown>((resolve) => { host.on("exit", (code) => { resolve(code); }); });
        host.send({ id: 1, method: "close", params: { reason: "upgrade", ifRestartSafe: true } });
        const code = await exited;
        expect(launchctl.some((args) => args[0] === "bootout"), JSON.stringify(result)).toBe(unloaded);
        expect(code, JSON.stringify(result)).toBe(unloaded ? 0 : null);
      }
    } finally {
      server.close();
    }
  }, 30_000);

  it("refuses a stale socket: nobody listening, or a live host of an older owner epoch; the family's own job takes over", async () => {
    const { root, daemon } = await fixture();
    const warnings: string[] = [];
    const first = daemon();
    const chat = await first.durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const host = first.locator.durable(chat.id)?.host;
    if (host === undefined) throw new Error("no host recorded");
    await first.durable.dispose();

    // The recorded host died (SIGKILL leaves its socket file): nobody accepts on it.
    process.kill(host.pid, "SIGKILL");
    await expect.poll(() => alive(host.pid)).toBe(false);
    expect(existsSync(host.socket)).toBe(true);
    const second = daemon(warnings);
    await second.durable.status(ref);
    const replaced = second.locator.durable(chat.id)?.host;
    expect(replaced?.ownerEpoch).toBe(2);
    expect(replaced?.pid).not.toBe(host.pid);
    expect(warnings).toContain("Durable Chat host process error");
    await second.durable.dispose();

    // A live listener that proves an older owner epoch than recorded is stale too: it never gets a request.
    process.kill(replaced?.pid ?? 0, "SIGKILL");
    await expect.poll(() => alive(replaced?.pid ?? 0)).toBe(false);
    await rm(host.socket, { force: true });
    const old = await impostor(host.socket, { protocol: DURABLE_HOST_PROTOCOL, storeId: chat.id, ownerEpoch: 1, revision: "/revisions/fake", pid: process.pid });
    const third = daemon();
    await third.durable.status(ref);
    expect(old.requested()).toBe(false);
    expect(third.locator.durable(chat.id)?.host?.ownerEpoch).toBe(3);
    await third.durable.stop(ref);
    old.server.close();
    expect(requests(root, chat.id).filter((method) => method === "status")).toHaveLength(2);
  }, 60_000);

  it("refuses a foreign socket: another family's handshake, or a folder others can reach", async () => {
    const { hostsDir, daemon } = await fixture();
    const first = daemon();
    const chat = await first.durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const host = first.locator.durable(chat.id)?.host;
    if (host === undefined) throw new Error("no host recorded");
    await first.durable.dispose();
    process.kill(host.pid, "SIGKILL");
    await expect.poll(() => alive(host.pid)).toBe(false);
    await rm(host.socket, { force: true });

    const foreign = await impostor(host.socket, { protocol: DURABLE_HOST_PROTOCOL, storeId: "another-family", ownerEpoch: 1, revision: "/revisions/fake", pid: process.pid });
    const second = daemon();
    await second.durable.status(ref);
    expect(foreign.requested()).toBe(false);
    expect(second.locator.durable(chat.id)?.host?.ownerEpoch).toBe(2);
    await second.durable.dispose();
    foreign.server.close();

    // The recorded socket's folder admits others: refused before connecting, and the job is started in an owner-only one.
    const current = second.locator.durable(chat.id)?.host;
    await chmod(hostsDir, 0o755);
    const warnings: string[] = [];
    const third = daemon(warnings);
    await third.durable.status(ref);
    expect(warnings).toContain("Durable Chat host process error");
    expect(third.locator.durable(chat.id)?.host?.ownerEpoch).toBe(3);
    expect(alive(current?.pid ?? 0)).toBe(false);
    await third.durable.stop(ref);
  }, 60_000);

  it("starts a host from the revision folder a *.installed link names, never from the link", async () => {
    const { root, hostsDir } = await fixture();
    const revision = join(root, "pi-workbench-abc123");
    await mkdir(revision);
    await writeFile(join(revision, "host.mjs"), HOST);
    await symlink(revision, join(root, "pi-workbench.installed"));
    const locator = new SessionRuntimeLocator(join(root, "data"));
    const durable = new DurableChatService({
      locator, events: new SessionEventHub(), storesDir: join(root, "data", "durable"),
      launch: launchdDurableHost({ entry: join(root, "pi-workbench.installed", "host.mjs"), model: "faux", agentDir: root, thinkingLevel: () => "medium", labelPrefix: PREFIX, hostsDir, locator }),
    });
    const chat = await durable.start("/work/a");
    const plist = readFileSync(join(hostsDir, `${PREFIX}.${chat.id}.plist`), "utf8");
    expect(plist).toContain(`<string>${await realpath(join(revision, "host.mjs"))}</string>`);
    expect(plist).not.toContain(".installed");
    await durable.stop({ id: chat.id, cwd: chat.cwd });

    const folder = join(root, "named.installed");
    await mkdir(folder);
    await writeFile(join(folder, "host.mjs"), HOST);
    expect(() => launchdDurableHost({ entry: join(folder, "host.mjs"), model: "faux", agentDir: root, labelPrefix: PREFIX, hostsDir, locator })).toThrow(/revision folder/);
  }, 60_000);
});

// Phase C3 lifetime rules (AC5) against the real launchd, trial labels only.
describe.skipIf(process.platform !== "darwin")("Durable host lifetime (Phase C3)", () => {
  const ended = (root: string, hostsDir: string, label: string, pid: number) => {
    expect(alive(pid)).toBe(false);
    expect(loaded(label)).toBe(false);
    expect(existsSync(join(hostsDir, `${label}.plist`))).toBe(false);
  };

  it("AC5 end: stopping a Chat, or all of them, reaches hosts this daemon never attached to; losing the transport does not", async () => {
    const { root, hostsDir, daemon } = await fixture();
    const first = daemon();
    const a = await first.durable.start("/work/a");
    const b = await first.durable.start("/work/b");
    const hostA = first.locator.durable(a.id)?.host;
    const hostB = first.locator.durable(b.id)?.host;
    if (hostA === undefined || hostB === undefined) throw new Error("no host recorded");

    // Transport loss: the daemon goes away; both hosts keep running and stay recorded.
    await first.durable.dispose();
    expect(alive(hostA.pid) && alive(hostB.pid)).toBe(true);

    // A new daemon that never reattached ends one Chat: its host closes in order and its job, plist and entry go.
    const second = daemon();
    await second.durable.stop({ id: a.id, cwd: a.cwd });
    ended(root, hostsDir, hostA.label, hostA.pid);
    expect(second.locator.durable(a.id)?.host).toBeUndefined();
    // An explicit end: the host cancels the family's background jobs before it closes (a restart-oriented close keeps them).
    expect(requests(root, a.id)).toEqual(["close:end"]);
    expect(alive(hostB.pid)).toBe(true);

    // Stop-all reaches every remaining family host the same way.
    await second.durable.stopAll();
    ended(root, hostsDir, hostB.label, hostB.pid);
    expect(second.locator.durable(b.id)?.host).toBeUndefined();
    expect(requests(root, b.id)).toEqual(["close:end"]);
  }, 60_000);

  it("AC5 end: an explicit end reaches background jobs whose family host is gone; stop and stop-all cancel them without starting a host", async () => {
    const { root, hostsDir, daemon } = await fixture();
    const jobs = join(root, "jobs");
    const saved = process.env["PI_BACKGROUND_BASH_ROOT"];
    process.env["PI_BACKGROUND_BASH_ROOT"] = jobs;
    const runners: ChildProcess[] = [];
    /** A detached runner for one of the family's jobs, registered as the Workbench registry records it (claimed, no exit). */
    const runner = async (family: string) => {
      const child = spawn("/bin/sh", ["-c", "while true; do sleep 0.1; done"], { detached: true, stdio: "ignore" });
      runners.push(child);
      const dir = join(jobs, `job-${family}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "job.json"), JSON.stringify({ id: `job-${family}`, sessionId: family, command: "loop" }));
      await writeFile(join(dir, "claim"), JSON.stringify({ pid: child.pid }));
      return { gone: () => child.exitCode !== null || child.signalCode !== null, cancelled: () => existsSync(join(dir, "exit")) };
    };
    try {
      const first = daemon();
      const a = await first.durable.start("/work/a");
      const b = await first.durable.start("/work/b");
      const [jobA, jobB] = [await runner(a.id), await runner(b.id)];
      const hosts = [first.locator.durable(a.id)?.host, first.locator.durable(b.id)?.host];
      await first.durable.dispose();
      // Both hosts die with their sockets (a crash, a reboot); B's attachment was already forgotten (a failed reattach).
      for (const host of hosts) {
        if (host === undefined) throw new Error("no host recorded");
        process.kill(host.pid, "SIGKILL");
        await expect.poll(() => alive(host.pid)).toBe(false);
        await rm(host.socket, { force: true });
      }
      first.locator.setHost(b.id, undefined);

      const second = daemon();
      await second.durable.stop({ id: a.id, cwd: a.cwd });
      await expect.poll(jobA.gone).toBe(true);
      expect(jobA.cancelled()).toBe(true);
      // Only the one-off cancel ran: no host served, so nothing undelivered could wake a model.
      expect(requests(root, a.id)).toEqual(["end-jobs"]);
      expect(loaded(`${PREFIX}.${a.id}`) || existsSync(join(hostsDir, `${PREFIX}.${a.id}.plist`))).toBe(false);
      expect(jobB.gone()).toBe(false);

      await second.durable.stopAll();
      await expect.poll(jobB.gone).toBe(true);
      expect(jobB.cancelled()).toBe(true);
      expect(requests(root, b.id)).toEqual(["end-jobs"]);
      expect(loaded(`${PREFIX}.${b.id}`) || existsSync(join(hostsDir, `${PREFIX}.${b.id}.plist`))).toBe(false);
      // A family with nothing left to cancel is not reached again.
      expect(requests(root, a.id)).toEqual(["end-jobs"]);
    } finally {
      for (const child of runners) { try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { /* gone */ } }
      if (saved === undefined) Reflect.deleteProperty(process.env, "PI_BACKGROUND_BASH_ROOT");
      else process.env["PI_BACKGROUND_BASH_ROOT"] = saved;
    }
  }, 90_000);

  it("AC5 idle: a host idle for the legacy 2 h window (injected clock) closes in order; running or waiting work and a watching browser keep it", async () => {
    const { root, hostsDir, daemon } = await fixture();
    let now = Date.parse("2026-11-17T08:00:00Z");
    let watching = false;
    const events = Object.assign(new SessionEventHub(), { hasSessionSubscribers: () => watching });
    const { durable, locator } = daemon([], { now: () => now, events });
    const chat = await durable.start("/work/a");
    const host = locator.durable(chat.id)?.host;
    if (host === undefined) throw new Error("no host recorded");
    const statusFile = join(root, "data", "durable", chat.id, "status.json");

    now += IDLE_HOST_CLOSE_MS - 1;
    await durable.closeIdleHosts();
    expect(alive(host.pid)).toBe(true);
    now += 1;

    const running = (key: string, value: object) => ({ extensionStatuses: { [key]: JSON.stringify({ schemaVersion: 1, ...value }) } });
    for (const busy of [
      { isStreaming: true },
      { pendingMessageCount: 1, queuedMessages: [{ kind: "followUp", text: "next" }] },
      { pendingAsks: [{ askId: "q1" }] },
      running("pi-workbench:activity", { items: [{ id: "delegate:1", startedAt: "2026-11-17T08:00:00Z" }] }),
      running("pi-workbench:background-bash", { jobs: [{ id: "job-1" }] }),
      running("pi-workbench:atelier", { serving: true }),
    ]) {
      await writeFile(statusFile, JSON.stringify(busy));
      await durable.closeIdleHosts();
      expect(alive(host.pid), JSON.stringify(busy)).toBe(true);
    }
    await rm(statusFile);
    watching = true;
    await durable.closeIdleHosts();
    expect(alive(host.pid)).toBe(true);

    watching = false;
    await durable.closeIdleHosts();
    ended(root, hostsDir, host.label, host.pid);
    expect(locator.durable(chat.id)?.host).toBeUndefined();
    expect(requests(root, chat.id).at(-1)).toBe("close");
  }, 60_000);

  /** A revision folder running the fake host, with the Pi Durable version it installs (none: unreadable) and one store schema. */
  const revision = async (root: string, name: string, durable?: string) => {
    const modules = join(root, name, "node_modules", "@earendil-works", "pi-durable");
    await mkdir(modules, { recursive: true });
    if (durable !== undefined) await writeFile(join(modules, "package.json"), JSON.stringify({ name: "@earendil-works/pi-durable", version: durable }));
    await writeFile(join(root, name, "store-schema.json"), JSON.stringify({ documents: { "workbench.delegation": 1 }, tasks: {} }));
    await writeFile(join(root, name, "host.mjs"), HOST);
    return join(await realpath(join(root, name)), "host.mjs");
  };

  it("AC5 upgrade: a family keeps its revision across daemon and host restarts, shows it, and moves only when asked while quiet", async () => {
    const { root, hostsDir, daemon } = await fixture();
    const [entryA, entryB] = [await revision(root, "rev-a", "1.4.0"), await revision(root, "rev-b", "1.5.2")];
    const first = daemon([], { entry: entryA });
    const chat = await first.durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    const label = `${PREFIX}.${chat.id}`;
    expect((await first.durable.status(ref)).durableHostPin).toBeUndefined();
    await first.durable.dispose();

    // A daemon with newer host code: the running family stays on rev-a and says so.
    const second = daemon([], { entry: entryB });
    await second.durable.reattach();
    expect((await second.durable.status(ref)).durableHostPin).toEqual({ revision: "rev-a", current: "rev-b", repeats: [] });

    // Its host closing (an end, an idle close) does not move it either: the next host starts from rev-a again.
    const pinnedPid = second.locator.durable(chat.id)?.host?.pid ?? 0;
    await second.durable.stop(ref);
    expect((await second.durable.status(ref)).durableHostPin).toEqual({ revision: "rev-a", current: "rev-b", repeats: [] });
    expect(readFileSync(join(hostsDir, `${label}.plist`), "utf8")).toContain(`<string>${entryA}</string>`);
    const reopened = second.locator.durable(chat.id)?.host;
    expect(reopened?.pid).not.toBe(pinnedPid);
    expect(reopened?.revision).toBe(join(await realpath(root), "rev-a"));

    // Asked while busy: refused, the host untouched.
    const statusFile = join(root, "data", "durable", chat.id, "status.json");
    await writeFile(statusFile, JSON.stringify({ isStreaming: true }));
    await expect(second.durable.upgradeHost(ref)).rejects.toThrow(/cannot move to new host code while a turn is running/);
    expect(second.locator.durable(chat.id)?.host?.pid).toBe(reopened?.pid);
    expect(alive(reopened?.pid ?? 0)).toBe(true);

    // Asked while quiet: the host closes in order and the family's next host runs rev-b.
    await rm(statusFile);
    const upgraded = await second.durable.upgradeHost(ref);
    expect(upgraded.durableHostPin).toBeUndefined();
    expect(alive(reopened?.pid ?? 0)).toBe(false);
    const current = second.locator.durable(chat.id)?.host;
    expect(current?.revision).toBe(join(await realpath(root), "rev-b"));
    expect(jobPid(label)).toBe(current?.pid);
    expect(readFileSync(join(hostsDir, `${label}.plist`), "utf8")).toContain(`<string>${entryB}</string>`);
    // The stop above ended the host (its jobs with it); the upgrade's close keeps the family's work.
    expect(requests(root, chat.id).filter((method) => method.startsWith("close"))).toEqual(["close:end", "close"]);

    // A later daemon on rev-b finds nothing pinned.
    await second.durable.dispose();
    const third = daemon([], { entry: entryB });
    expect((await third.durable.status(ref)).durableHostPin).toBeUndefined();
    await third.durable.stop(ref);
  }, 90_000);

  it("B9 rollback: Upgrade host refuses older Pi Durable code, or code whose version it cannot read; the family keeps its host, pin and transcript", async () => {
    const { root, daemon } = await fixture();
    const newer = await revision(root, "rev-new", "1.5.2");
    const first = daemon([], { entry: newer });
    const chat = await first.durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    await first.durable.dispose();

    // The instance rolls back: new families get the older build; this one, opened by 1.5.2, must stay there (1.4 cannot read its store).
    for (const [current, refusal] of [
      [await revision(root, "rev-old", "1.4.0"), "This Chat was opened by a newer Pi Durable (1.5.2); the current host is 1.4.0"],
      [await revision(root, "rev-unknown"), "the Pi Durable version of its host code cannot be read"],
    ] as const) {
      const { durable, locator } = daemon([], { entry: current });
      await durable.reattach();
      expect((await durable.status(ref)).durableHostPin?.revision).toBe("rev-new");
      const host = locator.durable(chat.id)?.host;
      if (host === undefined) throw new Error("no host recorded");
      await expect(durable.upgradeHost(ref)).rejects.toThrow(refusal);
      expect(alive(host.pid)).toBe(true);
      expect(locator.durable(chat.id)?.host?.pid).toBe(host.pid);
      expect(locator.durable(chat.id)?.hostEntry).toBe(newer);
      expect((await durable.transcriptSnapshot(ref)).page.messages).toEqual([]);
      expect(requests(root, chat.id).filter((method) => method.startsWith("close"))).toEqual([]);
      await durable.dispose();
    }
    await daemon([], { entry: newer }).durable.stop(ref);
  }, 90_000);

  it("A idle close upgrades: an idle-closed pinned Chat reopens on the current revision; one a newer Pi Durable opened stays pinned", async () => {
    const { root, daemon } = await fixture();
    const [entryA, entryB] = [await revision(root, "rev-a", "1.4.0"), await revision(root, "rev-b", "1.5.2")];
    const older = daemon([], { entry: entryA });
    const pinned = await older.durable.start("/work/a");
    await older.durable.dispose();
    const newer = daemon([], { entry: entryB });
    const opened = await newer.durable.start("/work/b");
    await newer.durable.dispose();

    // A daemon on rev-b: the first Chat is pinned to rev-a; idle, it closes and its pin goes, so it reopens on rev-b.
    let now = Date.parse("2026-11-18T08:00:00Z");
    const current = daemon([], { entry: entryB, now: () => now });
    await current.durable.reattach();
    const ref = { id: pinned.id, cwd: pinned.cwd };
    expect((await current.durable.status(ref)).durableHostPin).toEqual({ revision: "rev-a", current: "rev-b", repeats: [] });
    now += IDLE_HOST_CLOSE_MS;
    await current.durable.closeIdleHosts();
    expect(current.locator.durable(pinned.id)?.host).toBeUndefined();
    expect(current.locator.durable(pinned.id)?.hostEntry).toBe(entryB);
    expect((await current.durable.status(ref)).durableHostPin).toBeUndefined();
    expect(current.locator.durable(pinned.id)?.host?.revision).toBe(join(await realpath(root), "rev-b"));
    // The idle close keeps the family's work (no end).
    expect(requests(root, pinned.id).filter((method) => method.startsWith("close"))).toEqual(["close"]);
    await current.durable.dispose();

    // A rolled-back daemon on 1.4.0: the Chat 1.5.2 opened stays on rev-b through an idle close.
    const [entryOld] = [await revision(root, "rev-old", "1.4.0")];
    const rolledBack = daemon([], { entry: entryOld, now: () => now });
    await rolledBack.durable.reattach();
    const kept = { id: opened.id, cwd: opened.cwd };
    expect((await rolledBack.durable.status(kept)).durableHostPin?.revision).toBe("rev-b");
    now += IDLE_HOST_CLOSE_MS;
    await rolledBack.durable.closeIdleHosts();
    expect(rolledBack.locator.durable(opened.id)?.host).toBeUndefined();
    expect(rolledBack.locator.durable(opened.id)?.hostEntry).toBe(entryB);
    expect((await rolledBack.durable.status(kept)).durableHostPin?.revision).toBe("rev-b");
    await rolledBack.durable.stop(kept);
    await rolledBack.durable.stop(ref);
  }, 90_000);

  it("C Upgrade now: a busy pinned family closes in order (upgrade), restarts on the current revision at once and is resumed; quiet Upgrade host still refuses", async () => {
    const { root, hostsDir, daemon } = await fixture();
    const [entryA, entryB] = [await revision(root, "rev-a", "1.5.2"), await revision(root, "rev-b", "1.5.2")];
    const first = daemon([], { entry: entryA });
    const chat = await first.durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    await first.durable.dispose();
    const { durable, locator } = daemon([], { entry: entryB });
    await durable.reattach();
    const old = locator.durable(chat.id)?.host;
    // A turn runs, a child works and a question is open: Upgrade now names what repeats.
    await writeFile(join(root, "data", "durable", chat.id, "status.json"), JSON.stringify({ isStreaming: true, pendingAsks: [{ askId: "q1" }], extensionStatuses: { "pi-workbench:activity": JSON.stringify({ schemaVersion: 1, items: [{ id: "delegate:1", startedAt: "2026-11-18T08:00:00Z" }] }) } }));
    const pinned = await durable.status(ref);
    expect(pinned.durableHostPin?.repeats).toEqual(["the running turn: its answer is requested again; safe tools rerun, others wait for you", "running Subagents and Workers resume their current step"]);
    await expect(durable.upgradeHost(ref)).rejects.toThrow(/while a turn is running/);

    const upgraded = await durable.upgradeHost(ref, "now");
    expect(upgraded.durableHostPin).toBeUndefined();
    expect(alive(old?.pid ?? 0)).toBe(false);
    const current = locator.durable(chat.id)?.host;
    expect(current?.revision).toBe(join(await realpath(root), "rev-b"));
    expect(current?.ownerEpoch).toBe((old?.ownerEpoch ?? 0) + 1);
    expect(locator.durable(chat.id)?.hostEntry).toBe(entryB);
    expect(readFileSync(join(hostsDir, `${PREFIX}.${chat.id}.plist`), "utf8")).toContain(`<string>${entryB}</string>`);
    // The old host got the upgrade's close (its work is kept), the new one a resume before any other request.
    const log = requests(root, chat.id);
    expect(log.filter((method) => method.startsWith("close"))).toEqual(["close:upgrade"]);
    expect(log.slice(log.indexOf("close:upgrade") + 1)[0]).toBe("resume:upgrade-restart");
    await durable.stop(ref);
  }, 90_000);

  it("C Upgrade now rollback: a new host that does not start sends the family back to its old pin and host, and says so", async () => {
    const { root, daemon } = await fixture();
    const entryA = await revision(root, "rev-a", "1.5.2");
    const broken = await revision(root, "rev-broken", "1.5.2");
    // It writes to the store, then fails before it is ready.
    await writeFile(broken, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[process.argv.indexOf("--store") + 1] + "/migrated", "1.5.2");\nprocess.exit(3);\n');
    const first = daemon([], { entry: entryA });
    const chat = await first.durable.start("/work/a");
    const ref = { id: chat.id, cwd: chat.cwd };
    await first.durable.dispose();
    const { durable, locator } = daemon([], { entry: broken });
    await durable.reattach();
    expect((await durable.status(ref)).durableHostPin?.current).toBe("rev-broken");
    await expect(durable.upgradeHost(ref, "now")).rejects.toThrow(/^The new host code \(rev-broken\) did not start: .*\. This Chat is back on its old host code \(rev-a\)\.$/);
    expect(locator.durable(chat.id)?.hostEntry).toBe(entryA);
    // Only the pin goes back (both run Pi Durable 1.5.2): the store is the one store, never copied or moved.
    expect(existsSync(join(root, "data", "durable", chat.id, "migrated"))).toBe(true);
    expect((await readdir(join(root, "data", "durable"))).filter((name) => name.startsWith(chat.id))).toEqual([chat.id]);
    const back = locator.durable(chat.id)?.host;
    expect(back?.revision).toBe(join(await realpath(root), "rev-a"));
    expect(alive(back?.pid ?? 0)).toBe(true);
    expect((await durable.status(ref)).durableHostPin).toMatchObject({ revision: "rev-a", current: "rev-broken" });
    expect(requests(root, chat.id).filter((method) => method.startsWith("resume"))).toEqual(["resume:upgrade-restart"]);
    await durable.stop(ref);
  }, 120_000);

  it("B automatic upgrade (off by default): a pending family restarts by itself once only restart-surviving work remains; Cancel keeps it pinned", async () => {
    const { root, daemon } = await fixture();
    const [entryA, entryB] = [await revision(root, "rev-a", "1.5.2"), await revision(root, "rev-b", "1.5.2")];
    const first = daemon([], { entry: entryA });
    const [chat, other] = [await first.durable.start("/work/a"), await first.durable.start("/work/b")];
    const [ref, otherRef] = [{ id: chat.id, cwd: chat.cwd }, { id: other.id, cwd: other.cwd }];
    await first.durable.dispose();
    const statusFile = (id: string) => join(root, "data", "durable", id, "status.json");
    const running = (key: string, value: object) => ({ [key]: JSON.stringify({ schemaVersion: 1, ...value }) });

    // Off: nothing is pending and nothing restarts.
    const off = daemon([], { entry: entryB });
    await off.durable.reattach();
    const offPid = off.locator.durable(chat.id)?.host?.pid;
    expect((await off.durable.status(ref)).durableHostPin?.pending).toBeUndefined();
    await off.durable.upgradePendingHosts();
    expect(off.locator.durable(chat.id)?.host?.pid).toBe(offPid);
    await off.durable.dispose();

    const { durable, locator } = daemon([], { entry: entryB, autoUpgrade: true });
    await durable.reattach();
    const pid = locator.durable(chat.id)?.host?.pid;
    expect((await durable.status(ref)).durableHostPin).toMatchObject({ revision: "rev-a", pending: true });
    // The other Chat is busy meanwhile (a quiet pending family would move at the first check).
    await writeFile(statusFile(other.id), JSON.stringify({ isStreaming: true }));
    // A turn, queued input, a running tool or a child: it waits.
    for (const busy of [
      { isStreaming: true },
      { pendingMessageCount: 1, queuedMessages: [{ kind: "followUp", text: "next" }] },
      { activeToolExecutions: [{ id: "tool:1", kind: "shell", toolName: "bash", label: "Shell command", startedAt: "2026-11-18T08:00:00Z" }] },
      { extensionStatuses: running("pi-workbench:activity", { items: [{ id: "delegate:1", startedAt: "2026-11-18T08:00:00Z" }] }) },
    ]) {
      await writeFile(statusFile(chat.id), JSON.stringify(busy));
      await durable.upgradePendingHosts();
      expect(locator.durable(chat.id)?.host?.pid, JSON.stringify(busy)).toBe(pid);
    }
    expect((await durable.status(otherRef)).durableHostPin).toMatchObject({ revision: "rev-a", pending: true });
    // The other Chat's owner cancels; then both have only open questions, background bash, a watcher and a Page.
    await durable.upgradeHost(otherRef, "cancel");
    expect((await durable.status(otherRef)).durableHostPin?.pending).toBeUndefined();
    const survivors = JSON.stringify({ pendingAsks: [{ askId: "q1" }], extensionStatuses: { ...running("pi-workbench:background-bash", { jobs: [{ id: "job-1" }] }), ...running("pi-process-monitor:watchers", { watchers: [{ id: "w" }] }), ...running("pi-workbench:atelier", { serving: true }) } });
    await writeFile(statusFile(chat.id), survivors);
    await writeFile(statusFile(other.id), survivors);
    const otherPid = locator.durable(other.id)?.host?.pid;
    await durable.upgradePendingHosts();
    expect(alive(pid ?? 0)).toBe(false);
    expect(locator.durable(chat.id)?.host?.revision).toBe(join(await realpath(root), "rev-b"));
    expect((await durable.status(ref)).durableHostPin).toBeUndefined();
    const log = requests(root, chat.id);
    expect(log.slice(log.indexOf("close:upgrade"), log.indexOf("close:upgrade") + 2)).toEqual(["close:upgrade", "resume:upgrade-restart"]);
    expect(locator.durable(other.id)?.host?.pid).toBe(otherPid);
    expect((await durable.status(otherRef)).durableHostPin?.revision).toBe("rev-a");
    await durable.stop(ref);
    await durable.stop(otherRef);
  }, 120_000);
});
