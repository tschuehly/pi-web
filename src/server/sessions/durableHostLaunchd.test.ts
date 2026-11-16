import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { DURABLE_HOST_PROTOCOL, DurableChatService } from "./durableChatService.js";
import { durableHostSocketPath, launchdDurableHost } from "./durableHostLaunchd.js";
import { SessionRuntimeLocator } from "./sessionRuntimeLocator.js";

// Phase C1 against the real launchd (trial labels only): a family's host is its own job on an owner-only socket; a
// daemon that goes away leaves it running, the next one reattaches, and a stale or foreign socket is refused.
const PREFIX = "com.pi-workbench.durable-trial.host";
const domain = `gui/${String(process.getuid?.())}`;
const status = { persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], messageCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };

/**
 * A host speaking the socket protocol: each start owns the store with the next epoch, answers status and close, and
 * logs every request it gets to `<store>/requests.log`.
 */
const HOST = `
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const store = arg("--store"), socketPath = arg("--socket");
const epochFile = join(store, "epoch");
const ownerEpoch = (existsSync(epochFile) ? Number(readFileSync(epochFile, "utf8")) : 0) + 1;
writeFileSync(epochFile, String(ownerEpoch));
const server = createServer((socket) => {
  socket.write(JSON.stringify({ ready: { protocol: ${String(DURABLE_HOST_PROTOCOL)}, revision: "/revisions/fake", storeId: basename(store), ownerEpoch, pid: process.pid, capabilities: [] } }) + "\\n");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\\n"); end !== -1; end = buffer.indexOf("\\n")) {
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      appendFileSync(join(store, "requests.log"), request.method + "\\n");
      socket.write(JSON.stringify({ id: request.id, result: request.method === "status" ? ${JSON.stringify(status)} : null }) + "\\n", () => { if (request.method === "close") process.exit(0); });
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
async function fixture(): Promise<{ root: string; hostsDir: string; daemon: (warnings?: string[]) => { durable: DurableChatService; locator: SessionRuntimeLocator } }> {
  const short = tmpdir().length <= 60 ? tmpdir() : join(homedir(), ".pi-workbench", "tmp");
  await mkdir(short, { recursive: true });
  const root = await mkdtemp(join(short, "c1-"));
  roots.push(root);
  const entry = join(root, "host.mjs");
  await writeFile(entry, HOST);
  const hostsDir = join(root, "h");
  const daemon = (warnings: string[] = []) => {
    // A new locator per daemon: it reads only what the previous daemon persisted.
    const locator = new SessionRuntimeLocator(join(root, "data"));
    const durable = new DurableChatService({
      locator,
      events: new SessionEventHub(),
      launch: launchdDurableHost({ entry, model: "faux", agentDir: root, thinkingLevel: () => "medium", labelPrefix: PREFIX, hostsDir, locator, startTimeoutMs: 15_000 }),
      storesDir: join(root, "data", "durable"),
      logger: { warn: (_object, message) => { warnings.push(message); } },
      closeGraceMs: 2000,
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
    expect(host).toMatchObject({ label, socket: durableHostSocketPath(hostsDir, chat.id), revision: "/revisions/fake", ownerEpoch: 1 });
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
    expect(requests(root, chat.id)).toEqual(["status", "close"]);
  }, 60_000);

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
