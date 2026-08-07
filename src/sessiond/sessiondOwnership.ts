import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SessiondLockRecord {
  version: 1;
  pid: number;
  executable: string;
  startedAt: string;
  socketPath: string;
  token: string;
}

export type SessiondHealthProbe =
  | { state: "responsive"; pid?: number; executable?: string; componentVersion?: string }
  | { state: "stale"; detail: string }
  | { state: "unproven"; detail: string };

export interface SessiondOwnershipDependencies {
  createLock: (record: SessiondLockRecord, lockPath: string) => Promise<boolean>;
  readLock: (lockPath: string) => Promise<SessiondLockRecord | null>;
  removeLock: (lockPath: string, expectedToken?: string) => Promise<void>;
  removeSocket: (socketPath: string) => Promise<void>;
  probeHealth: (socketPath: string) => Promise<SessiondHealthProbe>;
  isProcessAlive: (pid: number) => boolean;
  now: () => string;
  pid: number;
  executable: string;
}

export class SessiondDuplicateOwnerError extends Error {
  readonly code = "SESSIOND_DUPLICATE_OWNER";

  constructor(readonly socketPath: string, readonly ownerPid?: number) {
    super(`A responsive session daemon already owns ${socketPath}${ownerPid === undefined ? "" : ` (pid ${String(ownerPid)})`}.`);
    this.name = "SessiondDuplicateOwnerError";
  }
}

export class SessiondOwnershipUnprovenError extends Error {
  readonly code = "SESSIOND_OWNERSHIP_UNPROVEN";

  constructor(readonly socketPath: string, detail: string) {
    super(`Session daemon ownership for ${socketPath} could not be proven stale: ${detail}`);
    this.name = "SessiondOwnershipUnprovenError";
  }
}

export function sessiondLockPath(socketPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return env["PI_WEB_SESSIOND_LOCK"] ?? join(dirname(socketPath), "sessiond.lock");
}

export async function acquireSessiondOwnership(input: {
  socketPath: string;
  lockPath?: string;
  dependencies?: SessiondOwnershipDependencies;
}): Promise<SessiondLockRecord> {
  const dependencies = input.dependencies ?? defaultSessiondOwnershipDependencies;
  const lockPath = input.lockPath ?? sessiondLockPath(input.socketPath);
  const record: SessiondLockRecord = {
    version: 1,
    pid: dependencies.pid,
    executable: dependencies.executable,
    startedAt: dependencies.now(),
    socketPath: input.socketPath,
    token: randomUUID(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = await dependencies.createLock(record, lockPath);
    if (created) {
      const socket = await dependencies.probeHealth(input.socketPath);
      if (socket.state === "responsive") {
        await dependencies.removeLock(lockPath, record.token);
        throw new SessiondDuplicateOwnerError(input.socketPath, socket.pid);
      }
      if (socket.state === "unproven") {
        await dependencies.removeLock(lockPath, record.token);
        throw new SessiondOwnershipUnprovenError(input.socketPath, socket.detail);
      }
      await dependencies.removeSocket(input.socketPath);
      return record;
    }

    const priorOwner = await dependencies.readLock(lockPath);
    const socket = await dependencies.probeHealth(input.socketPath);
    if (socket.state === "responsive") {
      throw new SessiondDuplicateOwnerError(input.socketPath, socket.pid ?? priorOwner?.pid);
    }
    if (socket.state === "unproven") {
      throw new SessiondOwnershipUnprovenError(input.socketPath, socket.detail);
    }
    if (priorOwner === null) {
      throw new SessiondOwnershipUnprovenError(input.socketPath, `lock ${lockPath} is malformed or unreadable`);
    }
    if (dependencies.isProcessAlive(priorOwner.pid)) {
      throw new SessiondOwnershipUnprovenError(input.socketPath, `lock owner pid ${String(priorOwner.pid)} is still alive`);
    }

    // Both independent proofs agree: the recorded process is dead and the
    // socket refuses connections. Only this state permits artifact removal.
    await dependencies.removeLock(lockPath, priorOwner.token);
    await dependencies.removeSocket(input.socketPath);
  }

  throw new SessiondOwnershipUnprovenError(input.socketPath, "ownership changed repeatedly during startup");
}

export async function releaseSessiondOwnership(
  record: SessiondLockRecord,
  dependencies: Pick<SessiondOwnershipDependencies, "removeLock"> = defaultSessiondOwnershipDependencies,
): Promise<void> {
  // The listening server owns socket-path removal. Unlinking here after close
  // could race with a replacement owner that has already bound the path.
  await dependencies.removeLock(sessiondLockPath(record.socketPath), record.token);
}

export function probeSessiondHealth(socketPath: string, timeoutMs = 500): Promise<SessiondHealthProbe> {
  return new Promise((resolve) => {
    const probe = request({ socketPath, path: "/health", method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 500) {
          resolve({ state: "unproven", detail: `health endpoint returned ${String(response.statusCode)}` });
          return;
        }
        try {
          const parsed: unknown = JSON.parse(body);
          if (!isRecord(parsed) || parsed["ok"] !== true) {
            resolve({ state: "unproven", detail: "health response did not identify a session daemon" });
            return;
          }
          const version = isRecord(parsed["version"]) ? parsed["version"] : undefined;
          resolve({
            state: "responsive",
            ...(typeof parsed["pid"] === "number" ? { pid: parsed["pid"] } : {}),
            ...(typeof parsed["executable"] === "string" ? { executable: parsed["executable"] } : {}),
            ...(typeof version?.["runtimeVersion"] === "string" ? { componentVersion: version["runtimeVersion"] } : {}),
          });
        } catch {
          resolve({ state: "unproven", detail: "health response was not valid JSON" });
        }
      });
    });
    probe.setTimeout(timeoutMs, () => {
      probe.destroy(new Error("health probe timed out"));
    });
    probe.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        resolve({ state: "stale", detail: error.code });
      } else {
        resolve({ state: "unproven", detail: error.message });
      }
    });
    probe.end();
  });
}

const defaultSessiondOwnershipDependencies: SessiondOwnershipDependencies = {
  async createLock(record, lockPath) {
    await mkdir(dirname(lockPath), { recursive: true });
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error: unknown) {
      if (isErrno(error, "EEXIST")) return false;
      throw error;
    }
  },
  async readLock(lockPath) {
    try {
      const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
      return isSessiondLockRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  async removeLock(lockPath, expectedToken) {
    if (expectedToken !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        return;
      }
      if (!isSessiondLockRecord(parsed) || parsed.token !== expectedToken) return;
    }
    await rm(lockPath, { force: true });
  },
  removeSocket: (socketPath) => rm(socketPath, { force: true }),
  probeHealth: probeSessiondHealth,
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      return isErrno(error, "EPERM");
    }
  },
  now: () => new Date().toISOString(),
  pid: process.pid,
  executable: process.execPath,
};

function isSessiondLockRecord(value: unknown): value is SessiondLockRecord {
  return isRecord(value)
    && value["version"] === 1
    && Number.isInteger(value["pid"])
    && typeof value["executable"] === "string"
    && typeof value["startedAt"] === "string"
    && typeof value["socketPath"] === "string"
    && typeof value["token"] === "string";
}

function isErrno(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && Reflect.get(value, "code") === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
