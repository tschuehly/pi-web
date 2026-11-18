import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Which runtime owns a Chat. Legacy Chats have no record: the legacy runtime stays the default. A Durable Chat's
 * runtime is fixed when it is created and never toggled; its record names the store its own host opens.
 */
export interface DurableChatRecord {
  id: string;
  cwd: string;
  runtime: "durable";
  /** Directory name of the family store under `<data dir>/durable/`. */
  storeId: string;
  created: string;
  modified: string;
  /** Listing projection, refreshed from host events; the host's store stays the authority. */
  firstMessage: string;
  messageCount: number;
  /** Set with `/name`, a Workstream checkpoint, or generated from the first prompt. */
  name?: string;
  /** Who set `name`; absent means the owner (`/name`), which generated titles never replace. */
  nameSource?: "manual" | "auto" | "checkpoint";
  /** The family's launchd host the daemon last attached to (Phase C1); a restarted daemon reattaches through it. */
  host?: DurableHostAttachment;
  /**
   * The host entry (a real path in its revision folder) the family's launchd host last started from (Phase C3): its later
   * hosts start from it too, until the owner upgrades the family. Kept when the host stops, unlike `host`.
   */
  hostEntry?: string;
  /**
   * The store `hostEntry`'s code writes, recorded as it is pinned: a pin whose revision folder is gone (pruned) falls back
   * only to code that is not older (`storeCodeRefusal`).
   */
  hostStore?: StoreCode;
  /**
   * An Upgrade now under way: the entry it left (for a rollback). Its new host still owes a resume until one is
   * acknowledged; a daemon that restarts meanwhile finishes it (`reattach`).
   */
  upgrade?: { from?: string };
  /** The current host entry whose automatic upgrade the owner cancelled: no longer pending, until newer code is offered. */
  upgradeDeclined?: string;
}

/** The store format a host entry's code writes: its Pi Durable version and the Workbench store schema, when readable. */
export interface StoreCode {
  durable?: string;
  schema?: StoreSchema;
}

/** Every Workbench document and task kind with its version (the host's `store-schema.json`). */
export interface StoreSchema {
  documents: Record<string, number>;
  tasks: Record<string, number>;
}

/** What a launchd host's handshake proved, so a later daemon accepts only that host on that socket. */
export interface DurableHostAttachment {
  label: string;
  socket: string;
  /** The revision folder the host runs from. */
  revision: string;
  ownerEpoch: number;
  pid: number;
}

interface LocatorFile {
  version: 1;
  chats: Record<string, DurableChatRecord>;
}

/**
 * Persistent runtime locator: `<data dir>/session-runtimes.json`, owner-only, replaced atomically on every change.
 * Kept in memory so synchronous route reads can resolve a Chat's runtime without I/O.
 */
export class SessionRuntimeLocator {
  readonly #path: string;
  readonly #chats: Map<string, DurableChatRecord>;

  constructor(dataDir: string) {
    this.#path = join(dataDir, "session-runtimes.json");
    this.#chats = new Map(Object.entries(readLocator(this.#path).chats));
  }

  durable(sessionId: string): DurableChatRecord | undefined {
    return this.#chats.get(sessionId);
  }

  all(): DurableChatRecord[] {
    return [...this.#chats.values()];
  }

  /** Record a new Durable Chat before its host opens the store, so a crash in between leaves a findable record. */
  create(cwd: string, id: string = randomUUID(), now = new Date()): DurableChatRecord {
    const at = now.toISOString();
    const record: DurableChatRecord = { id, cwd, runtime: "durable", storeId: id, created: at, modified: at, firstMessage: "", messageCount: 0 };
    this.#chats.set(id, record);
    this.#persist();
    return record;
  }

  update(sessionId: string, change: Partial<Pick<DurableChatRecord, "modified" | "firstMessage" | "messageCount" | "name" | "nameSource">>): void {
    const record = this.#chats.get(sessionId);
    if (record === undefined) return;
    this.#chats.set(sessionId, { ...record, ...change });
    this.#persist();
  }

  /** Record the family host the daemon attached to, or forget it once that host is gone. */
  setHost(sessionId: string, host: DurableHostAttachment | undefined): void {
    const record = this.#chats.get(sessionId);
    if (record === undefined) return;
    const next: DurableChatRecord = { ...record };
    if (host === undefined) delete next.host;
    else next.host = host;
    this.#chats.set(sessionId, next);
    this.#persist();
  }

  /** Pin the family to the host entry its host started from (or, as it moves, the one its next host starts from), or unpin it so its next host runs the current code. */
  setHostEntry(sessionId: string, entry: string | undefined): void {
    const record = this.#chats.get(sessionId);
    if (record === undefined || record.hostEntry === entry) return;
    const next: DurableChatRecord = { ...record };
    delete next.hostStore;
    if (entry === undefined) delete next.hostEntry;
    else {
      next.hostEntry = entry;
      const store = storeCode(entry);
      if (store.durable !== undefined) next.hostStore = store;
    }
    this.#chats.set(sessionId, next);
    this.#persist();
  }

  /** Record or clear (undefined) an upgrade's persisted state. */
  setUpgradeState<K extends "upgrade" | "upgradeDeclined">(sessionId: string, key: K, value: DurableChatRecord[K] | undefined): void {
    const record = this.#chats.get(sessionId);
    if (record === undefined || (value === undefined && record[key] === undefined)) return;
    const next: DurableChatRecord = { ...record };
    if (key === "upgrade") delete next.upgrade;
    else delete next.upgradeDeclined;
    if (value !== undefined) next[key] = value;
    this.#chats.set(sessionId, next);
    this.#persist();
  }

  remove(sessionId: string): void {
    if (this.#chats.delete(sessionId)) this.#persist();
  }

  #persist(): void {
    const file: LocatorFile = { version: 1, chats: Object.fromEntries(this.#chats) };
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}

function readLocator(path: string): LocatorFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, chats: {} };
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  // Unknown versions or records fail closed: a newer locator may name runtimes this daemon cannot route.
  if (!isRecord(parsed) || parsed["version"] !== 1 || !isRecord(parsed["chats"])) throw new Error(`Unsupported session runtime locator ${path}`);
  const chats: Record<string, DurableChatRecord> = {};
  for (const [id, record] of Object.entries(parsed["chats"])) {
    if (!isDurableChatRecord(record) || record.id !== id) throw new Error(`Unsupported session runtime record ${id} in ${path}`);
    chats[id] = record;
  }
  return { version: 1, chats };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDurableChatRecord(value: unknown): value is DurableChatRecord {
  return isRecord(value) && value["runtime"] === "durable"
    && ["id", "cwd", "storeId", "created", "modified", "firstMessage"].every((key) => typeof value[key] === "string")
    && typeof value["messageCount"] === "number"
    && (value["name"] === undefined || typeof value["name"] === "string")
    && (value["nameSource"] === undefined || value["nameSource"] === "manual" || value["nameSource"] === "auto" || value["nameSource"] === "checkpoint")
    && (value["host"] === undefined || isHostAttachment(value["host"]))
    && (value["hostEntry"] === undefined || typeof value["hostEntry"] === "string")
    && (value["hostStore"] === undefined || isRecord(value["hostStore"]))
    && (value["upgrade"] === undefined || isUpgrade(value["upgrade"]))
    && (value["upgradeDeclined"] === undefined || typeof value["upgradeDeclined"] === "string");
}

function isUpgrade(value: unknown): boolean {
  return isRecord(value) && (value["from"] === undefined || typeof value["from"] === "string");
}

function isHostAttachment(value: unknown): value is DurableHostAttachment {
  return isRecord(value) && ["label", "socket", "revision"].every((key) => typeof value[key] === "string")
    && typeof value["ownerEpoch"] === "number" && typeof value["pid"] === "number";
}

/** The folder whose `node_modules` Node resolves `@earendil-works/pi-durable` from for a host entry. */
function durableFolder(entry: string): string | undefined {
  for (let folder = dirname(entry); ; folder = dirname(folder)) {
    if (existsSync(join(folder, "node_modules", "@earendil-works", "pi-durable", "package.json"))) return folder;
    if (dirname(folder) === folder) return undefined;
  }
}

/**
 * The `@earendil-works/pi-durable` version a host entry runs, from the package.json Node resolves from the entry's folder
 * (the package exports no `./package.json`); undefined when none is found or it names no numeric version.
 */
export function durableVersion(entry: string): string | undefined {
  const folder = durableFolder(entry);
  if (folder === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(folder, "node_modules", "@earendil-works", "pi-durable", "package.json"), "utf8"));
    const version = isRecord(parsed) ? parsed["version"] : undefined;
    return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The store schema a host entry writes, from the Workbench host's `store-schema.json` beside that `node_modules`, with
 * its kinds sorted (comparable as JSON); undefined when it is missing or unreadable.
 */
export function storeSchema(entry: string): StoreSchema | undefined {
  const folder = durableFolder(entry);
  if (folder === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(folder, "store-schema.json"), "utf8"));
    const [documents, tasks] = isRecord(parsed) ? [parsed["documents"], parsed["tasks"]] : [];
    if (!isVersions(documents) || !isVersions(tasks)) return undefined;
    const sorted = (value: Record<string, number>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    return { documents: sorted(documents), tasks: sorted(tasks) };
  } catch {
    return undefined;
  }
}

function isVersions(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((version) => typeof version === "number");
}

function storeCode(entry: string): StoreCode {
  const [durable, schema] = [durableVersion(entry), storeSchema(entry)];
  return { ...(durable === undefined ? {} : { durable }), ...(schema === undefined ? {} : { schema }) };
}

/**
 * Why `entry`'s code must not open a store the `pinned` code wrote, undefined when it may: never older Pi Durable code,
 * nor, at the same version, a Workbench document or task kind the pin writes at a version the entry's code lacks or
 * writes older (it would refuse or misread the store).
 */
export function storeCodeRefusal(pinned: StoreCode, entry: string): string | undefined {
  if (pinned.durable === undefined) return undefined;
  const current = storeCode(entry);
  if (current.durable === undefined || compareVersions(current.durable, pinned.durable) < 0) {
    return `This Chat was opened by a newer Pi Durable (${pinned.durable}); the current host is ${current.durable ?? "of unknown version"}`;
  }
  if (compareVersions(current.durable, pinned.durable) > 0 || pinned.schema === undefined) return undefined;
  const older = (section: "documents" | "tasks") => Object.entries(pinned.schema?.[section] ?? {}).some(([kind, version]) => (current.schema?.[section][kind] ?? -1) < version);
  return current.schema === undefined || older("documents") || older("tasks") ? "This Chat was opened by host code with a newer Workbench store schema than the current host" : undefined;
}

/** Orders two versions by major.minor.patch. shortcut: pre-release tags are ignored; Pi Durable ships none today. */
export function compareVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => version.split(/[.+-]/).slice(0, 3).map(Number));
  for (let index = 0; index < 3; index++) {
    const difference = (left?.[index] ?? 0) - (right?.[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
