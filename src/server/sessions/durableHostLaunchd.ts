import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { DURABLE_HOST_PROTOCOL, durableHostLaunchArgs, type DurableHostLauncher, type DurableHostOptions, type DurableHostProcess } from "./durableChatService.js";
import { type DurableChatRecord, type DurableHostAttachment, type SessionRuntimeLocator, storeCode, storeCodeRefusal } from "./sessionRuntimeLocator.js";

/** Runs `launchctl` with these arguments; rejects with its output on failure. Tests may pass their own. */
export type Launchctl = (args: string[]) => Promise<void>;

const run = promisify(execFile);
const launchctl: Launchctl = async (args) => {
  await run("launchctl", args);
};

/**
 * Variables whose name says they hold a secret (case-insensitive; covers pi-ai's provider key variables, which it does
 * not export as a list) never go into a plist. A host needing one reads it from Pi's auth.json or a file it names instead;
 * Durable hosts drop provider key variables anyway (pi-workbench durable-pilot `openChatHost`).
 */
const SECRET_NAME = /_(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;

/** macOS's `sun_path` holds 104 bytes with the terminating NUL. */
const MAX_SOCKET_PATH = 103;

/** The family's socket: a short name, so the path fits a Unix socket under any data dir of a sane length. */
export function durableHostSocketPath(hostsDir: string, storeId: string): string {
  return join(hostsDir, `${createHash("sha256").update(storeId).digest("hex").slice(0, 16)}.sock`);
}

/**
 * Phase C1: each Chat family's host is its own launchd job `<labelPrefix>.<store ID>` in the owner's GUI domain, started
 * from the real path of the host entry (an installed revision folder, never a `*.installed` link), and reached over an
 * owner-only Unix socket in `hostsDir`, where the job's plist lives too. The daemon only connects: a daemon that dies
 * or stops leaves the host running, and the next one reattaches through the host the runtime locator recorded. A
 * socket is used only when its handshake names this daemon's protocol and the family's store, and, on reattach, the
 * recorded owner epoch and revision; a stale or foreign one is refused (never sent a request) and the family's own job
 * is started again in its place.
 */
export function launchdDurableHost(options: DurableHostOptions & {
  labelPrefix: string;
  hostsDir: string;
  locator: SessionRuntimeLocator;
  launchctl?: Launchctl;
  /** How long a started job may take to answer on its socket; default 60 s. */
  startTimeoutMs?: number;
}): DurableHostLauncher {
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(options.labelPrefix)) throw new Error(`Invalid Durable host launchd label prefix ${options.labelPrefix}`);
  const entry = realpathSync(options.entry);
  if (entry.split(sep).some((part) => part.endsWith(".installed"))) throw new Error(`Durable hosts start from a revision folder, not ${entry}`);
  const context: LaunchContext = { ...options, entry, launchctl: options.launchctl ?? launchctl, startTimeoutMs: options.startTimeoutMs ?? 60_000 };
  return (record, storeDir, launch) => launch?.endJobs === true ? endJobs(context, record, storeDir)
    : launch?.readTranscript === true ? readTranscript(context, record, storeDir)
    : new LaunchdHost(context, record, storeDir, launch?.attachOnly === true);
}

/**
 * Phase C3: a family stays on the code its host started from; only a revision folder that is gone (pruned) moves it to
 * the current one, and only when that writes no older store (`storeCodeRefusal`); else it throws, as it does for a pin
 * whose store code was never recorded: nothing proves the current code can read the store.
 */
function familyEntry(context: LaunchContext, record: DurableChatRecord): string {
  const durable = context.locator.durable(record.id);
  const pinned = durable?.hostEntry;
  if (pinned === undefined || existsSync(pinned)) return pinned ?? context.entry;
  const refusal = durable?.hostStore === undefined ? "Which store this Chat's host code wrote was never recorded" : storeCodeRefusal(durable.hostStore, storeCode(context.entry));
  if (refusal !== undefined) throw new Error(`${refusal}, and its host code (${dirname(pinned)}) is gone; reinstall it to open this Chat`);
  return context.entry;
}

/** The daemon's environment, as a forked host inherited it, less secret-named variables (a plist is a file on disk). */
function hostEnvironment(context: LaunchContext) {
  return Object.fromEntries(Object.entries({ ...process.env, PI_CODING_AGENT_DIR: context.agentDir }).filter(([name]) => !SECRET_NAME.test(name)));
}

/** Unload the family's job (bootout returns once its process is gone), remove its plist and forget the host. */
async function unload(context: LaunchContext, record: DurableChatRecord): Promise<void> {
  const label = `${context.labelPrefix}.${record.storeId}`;
  await context.launchctl(["bootout", `gui/${String(process.getuid?.())}/${label}`]).catch(() => undefined);
  rmSync(join(context.hostsDir, `${label}.plist`), { force: true });
  context.locator.setHost(record.id, undefined);
}

/**
 * End a family no host of which is reachable: unload whatever job its label still holds, then cancel its unfinished
 * background jobs with the family's host entry run once as a plain child with `--end-jobs`. No host starts.
 * shortcut: a family pinned to host code older than `--end-jobs` fails here (stop reports it); fall back to the current
 * entry if such pins outlive the cutover.
 */
function endJobs(context: LaunchContext, record: DurableChatRecord, storeDir: string): DurableHostProcess {
  const ended = Object.assign(new EventEmitter(), { send: () => false, kill: () => false });
  void unload(context, record).then(() => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(storeDir, "host.log"), "a", 0o600);
    try {
      spawn(process.execPath, [familyEntry(context, record), ...durableHostLaunchArgs(context, record, storeDir), "--end-jobs"], { cwd: storeDir, env: hostEnvironment(context), stdio: ["ignore", log, log] })
        .on("error", (error) => ended.emit("error", error))
        .on("exit", (code, signal) => ended.emit("exit", code, signal));
    } finally {
      closeSync(log);
    }
  }).catch((error: unknown) => ended.emit("error", error));
  return ended;
}

/**
 * Read the history of a family no host runs, with a plain child (`--read-transcript`, over its IPC channel), not a job.
 * From the current code when it can read the pin's store and runs the same Pi Durable (older pins have no reader; the
 * reader's read-only Harness writes no Workbench document, but another Pi Durable could migrate the store its pinned
 * host must still open), else from the pin while its folder is there. Otherwise (no pin, or a pruned one) the read
 * fails and the caller starts the host, whose start records the code that then writes the store.
 */
function readTranscript(context: LaunchContext, record: DurableChatRecord, storeDir: string): DurableHostProcess {
  const durable = context.locator.durable(record.id);
  const current = storeCode(context.entry);
  const same = durable?.hostStore !== undefined && current.durable === durable.hostStore.durable && storeCodeRefusal(durable.hostStore, current) === undefined;
  const entry = same ? context.entry : durable?.hostEntry !== undefined && existsSync(durable.hostEntry) ? durable.hostEntry : undefined;
  if (entry === undefined) {
    const refused = Object.assign(new EventEmitter(), { send: () => false, kill: () => false });
    queueMicrotask(() => refused.emit("exit", 1, null));
    return refused;
  }
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(storeDir, "host.log"), "a", 0o600);
  try {
    return spawn(process.execPath, [entry, ...durableHostLaunchArgs(context, record, storeDir), "--read-transcript"], { cwd: storeDir, env: hostEnvironment(context), stdio: ["ignore", log, log, "ipc"] });
  } finally {
    closeSync(log);
  }
}

type LaunchContext = DurableHostOptions & { labelPrefix: string; hostsDir: string; locator: SessionRuntimeLocator; launchctl: Launchctl; startTimeoutMs: number };

interface Ready { protocol: number; storeId: string; ownerEpoch: number; revision: string; pid: number }

/** A launchd host behind the `DurableHostProcess` shape: "exit" means the connection ended (after `close`, the job too). */
class LaunchdHost extends EventEmitter implements DurableHostProcess {
  readonly #label: string;
  readonly #domain = `gui/${String(process.getuid?.())}`;
  #socket: Socket | undefined;
  #pid: number | undefined;
  #closing = false;
  /** The id of B's conditional close in flight: the job ends with it only once the host answers `{ closed: true }`. */
  #conditionalClose: unknown;
  #detached = false;
  /** The entry this object launched its host from; a reattached host's is the locator's. */
  #entry: string | undefined;

  constructor(private readonly context: LaunchContext, private readonly record: DurableChatRecord, private readonly storeDir: string, attachOnly: boolean) {
    super();
    this.#label = `${context.labelPrefix}.${record.storeId}`;
    void this.#open(attachOnly).catch((error: unknown) => {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      this.emit("exit", null, null);
    });
  }

  async #open(attachOnly: boolean): Promise<void> {
    const recorded = this.context.locator.durable(this.record.id)?.host;
    if (recorded !== undefined) {
      try {
        // The same host the last daemon attached to: same socket, owner epoch and revision.
        if (await this.#attach(recorded.socket, (ready) => ready.ownerEpoch === recorded.ownerEpoch && ready.revision === recorded.revision)) return;
        this.emit("error", new Error(`Refused stale Durable host socket ${recorded.socket}: another owner epoch or revision than recorded`));
      } catch (error) {
        this.emit("error", new Error(`Refused Durable host socket ${recorded.socket}: ${error instanceof Error ? error.message : String(error)}`));
      }
      // Gone or not ours: unload the family's job (a refused process under our label goes with it), forget the host.
      await unload(this.context, this.record);
    }
    if (attachOnly) throw new Error("No running Durable host to reattach to");
    await this.#launch(recorded?.ownerEpoch);
  }

  async #launch(previousEpoch: number | undefined): Promise<void> {
    const { hostsDir } = this.context;
    // Phase C3: a family stays on the code its host started from until the owner upgrades it.
    const entry = familyEntry(this.context, this.record);
    mkdirSync(hostsDir, { recursive: true, mode: 0o700 });
    chmodSync(hostsDir, 0o700);
    mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    const socket = durableHostSocketPath(hostsDir, this.record.storeId);
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw new Error(`Durable host socket path is too long for a Unix socket: ${socket}`);
    await this.context.launchctl(["bootout", `${this.#domain}/${this.#label}`]).catch(() => undefined);
    rmSync(socket, { force: true });
    const plist = join(hostsDir, `${this.#label}.plist`);
    this.#entry = entry;
    writeFileSync(plist, launchdPlist({
      Label: this.#label,
      ProgramArguments: [process.execPath, entry, ...durableHostLaunchArgs(this.context, this.record, this.storeDir), "--socket", socket],
      EnvironmentVariables: hostEnvironment(this.context),
      WorkingDirectory: this.storeDir,
      StandardOutPath: join(this.storeDir, "host.log"),
      StandardErrorPath: join(this.storeDir, "host.log"),
      RunAtLoad: true,
      // Started on demand, never restarted by launchd: a crashed host reopens paused at the Chat's next use.
      KeepAlive: false,
      // Background jobs and children the host detached outlive it, as they did under a forking daemon.
      AbandonProcessGroup: true,
      ExitTimeOut: 10,
      MaterializeDatalessFiles: true,
    }), { mode: 0o600 });
    await this.context.launchctl(["bootstrap", this.#domain, plist]);
    const deadline = Date.now() + this.context.startTimeoutMs;
    for (;;) {
      try {
        // A new owner of the store: a later epoch than any host this family had.
        if (await this.#attach(socket, (ready) => previousEpoch === undefined || ready.ownerEpoch > previousEpoch, true)) {
          this.context.locator.setHostEntry(this.record.id, entry);
          return;
        }
        throw new Error("the started host did not prove a new owner epoch");
      } catch (error) {
        if (!(error instanceof NotListening) || Date.now() > deadline) throw new Error(`Durable host ${this.#label} did not start (see ${join(this.storeDir, "host.log")}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Connect and check the handshake before anything is sent. Resolves true once attached (the ready message is
   * forwarded), false when `accept` rejects it; throws NotListening when nobody listens, or why the socket is refused.
   */
  async #attach(path: string, accept: (ready: Ready) => boolean, record = false): Promise<boolean> {
    ownerOnly(path);
    const socket = connect({ path });
    // One decoder for the connection's life: a character split across chunks (or handshake and messages) stays whole.
    socket.setEncoding("utf8");
    let buffer = "";
    const first = await new Promise<string>((resolve, reject) => {
      const fail = (error: Error) => { socket.destroy(); reject(error); };
      const timer = setTimeout(() => { fail(new Error("no handshake within 5 s")); }, 5000);
      socket.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? new NotListening(error.message) : error);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end === -1) return;
        clearTimeout(timer);
        // Hold what follows the handshake until it is accepted and has its reader.
        socket.pause();
        socket.removeAllListeners("data");
        resolve(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      });
    });
    const message = parse(first);
    const ready = isRecord(message) && isRecord(message["ready"]) ? message["ready"] : undefined;
    if (ready?.["protocol"] !== DURABLE_HOST_PROTOCOL || ready["storeId"] !== this.record.storeId
      || typeof ready["ownerEpoch"] !== "number" || typeof ready["revision"] !== "string" || typeof ready["pid"] !== "number") {
      socket.destroy();
      throw new Error(`not this family's host (handshake ${JSON.stringify({ protocol: ready?.["protocol"], storeId: ready?.["storeId"] })})`);
    }
    const proven: Ready = { protocol: DURABLE_HOST_PROTOCOL, storeId: this.record.storeId, ownerEpoch: ready["ownerEpoch"], revision: ready["revision"], pid: ready["pid"] };
    if (!accept(proven)) {
      socket.destroy();
      return false;
    }
    this.#socket = socket;
    this.#pid = proven.pid;
    socket.on("error", () => undefined);
    socket.on("close", () => { void this.#closed(); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (isRecord(line) && this.#conditionalClose !== undefined && line["id"] === this.#conditionalClose) {
          this.#conditionalClose = undefined;
          if (isRecord(line["result"]) && line["result"]["closed"] === true) this.#closing = true;
        }
        if (line !== undefined) this.emit("message", line);
      }
    });
    if (record) this.context.locator.setHost(this.record.id, { label: this.#label, socket: path, revision: proven.revision, ownerEpoch: proven.ownerEpoch, pid: proven.pid } satisfies DurableHostAttachment);
    this.emit("message", message);
    // Lines that arrived with the handshake, then the rest.
    socket.emit("data", "");
    socket.resume();
    return true;
  }

  async #closed(): Promise<void> {
    if (this.#detached) return;
    // After `close` (or the kill that enforces it) the job is done: unload it, so launchd holds nothing for the family.
    if (this.#closing) await unload(this.context, this.record);
    this.emit("exit", this.#closing ? 0 : null, null);
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    const socket = this.#socket;
    if (socket === undefined || socket.destroyed) {
      callback?.(new Error("Durable host connection is closed"));
      return false;
    }
    if (isRecord(message) && message["method"] === "close") {
      // A refused conditional close keeps the host running: its job and socket stay until it says it closed.
      if (isRecord(message["params"]) && message["params"]["ifRestartSafe"] === true) this.#conditionalClose = message["id"];
      else this.#closing = true;
    }
    return socket.write(`${JSON.stringify(message)}\n`, (error) => { callback?.(error ?? null); });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.#pid === undefined) return false;
    // Only ever the PID this family's own host proved in its handshake; ending it ends the job.
    this.#closing = true;
    try {
      process.kill(this.#pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** The entry this family's host runs from and the one new families get (Phase C3 pinning). */
  get code(): { entry: string; current: string } {
    return { entry: this.#entry ?? this.context.locator.durable(this.record.id)?.hostEntry ?? this.context.entry, current: this.context.entry };
  }

  detach(): void {
    this.#detached = true;
    this.#socket?.destroy();
  }
}

class NotListening extends Error {}

/** The socket and its folder belong to this user and admit nobody else; otherwise the socket is foreign. */
function ownerOnly(path: string): void {
  const uid = process.getuid?.();
  const folder = lstatSync(dirname(path), { throwIfNoEntry: false });
  if (folder === undefined) throw new NotListening(`no folder ${dirname(path)}`);
  if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o077) !== 0) throw new Error(`folder ${dirname(path)} is not owner-only`);
  const socket = lstatSync(path, { throwIfNoEntry: false });
  if (socket === undefined) throw new NotListening(`no socket ${path}`);
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) throw new Error(`${path} is not an owner-only socket`);
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A launchd property list (XML). */
type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
function launchdPlist(values: Record<string, PlistValue>): string {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const value = (item: PlistValue): string =>
    typeof item === "string" ? `<string>${escape(item)}</string>`
    : typeof item === "number" ? `<integer>${String(item)}</integer>`
    : typeof item === "boolean" ? (item ? "<true/>" : "<false/>")
    : Array.isArray(item) ? `<array>${item.map(value).join("")}</array>`
    : `<dict>${Object.entries(item).map(([key, entry]) => `<key>${escape(key)}</key>${value(entry)}`).join("")}</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${value(values)}</plist>\n`;
}
