import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  create(cwd: string, now = new Date()): DurableChatRecord {
    const id = randomUUID();
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
    && (value["nameSource"] === undefined || value["nameSource"] === "manual" || value["nameSource"] === "auto" || value["nameSource"] === "checkpoint");
}
