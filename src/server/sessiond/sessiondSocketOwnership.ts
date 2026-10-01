/**
 * Session daemon Unix socket ownership.
 *
 * The state-ownership marker is scoped to one data directory, so two instances
 * with different data directories but the same socket path would otherwise
 * steal each other's endpoint. Before binding, the daemon therefore removes an
 * existing socket path only when it is provably stale (a socket nobody accepts
 * connections on) and fails closed otherwise. On exit it unlinks the path only
 * while it still names the socket this process bound.
 */

import { lstatSync, unlinkSync, type Stats } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";

export class SessiondSocketOwnershipError extends Error {
  constructor(readonly socketPath: string, detail: string) {
    super(
      `cannot claim the session daemon socket ${socketPath}: ${detail}\n\n` +
        `Another pi-web session daemon may own this endpoint. Stop it, or give this instance its own ` +
        `PI_WEB_SESSIOND_SOCKET (or PI_WEB_SESSIOND_PORT / PI_WEB_SESSIOND_HOST). ` +
        `If nothing owns the path, remove it and start again.`,
    );
    this.name = "SessiondSocketOwnershipError";
  }
}

export interface SessiondSocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

type SocketProbe = "absent" | "stale" | "live" | { readonly unproven: string };

/** Connect once: refused means stale, accepted means a live peer, anything else is unproven. */
function probeSocket(socketPath: string, timeoutMs: number): Promise<SocketProbe> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve({ unproven: `connection attempt timed out after ${String(timeoutMs)}ms` });
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve("live");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve("absent");
      else if (error.code === "ECONNREFUSED") resolve("stale");
      else resolve({ unproven: error.message });
    });
  });
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Prepare `socketPath` for binding: create its directory and remove a stale
 * socket left by a dead daemon. Throws {@link SessiondSocketOwnershipError}
 * without touching the path when a peer accepts connections, the path is not a
 * socket, or staleness cannot be proven.
 */
export async function claimSessiondSocketPath(socketPath: string, options: { timeoutMs?: number } = {}): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true });
  const existing = await lstatOrUndefined(socketPath);
  if (existing === undefined) return;
  if (!existing.isSocket()) throw new SessiondSocketOwnershipError(socketPath, "the path exists and is not a socket");
  const probe = await probeSocket(socketPath, options.timeoutMs ?? 1_000);
  if (probe === "live") throw new SessiondSocketOwnershipError(socketPath, "a live process is accepting connections on it");
  if (typeof probe === "object") throw new SessiondSocketOwnershipError(socketPath, `staleness could not be proven (${probe.unproven})`);
  if (probe === "stale") await rm(socketPath, { force: true });
}

/** Identity of the socket file this process bound; capture right after listen. */
export function sessiondSocketIdentity(socketPath: string): SessiondSocketIdentity {
  const { dev, ino } = lstatSync(socketPath);
  return { dev, ino };
}

/**
 * Synchronously unlink `socketPath` only if it still names the bound socket,
 * so an exiting daemon never removes a replacement owner's endpoint. Safe to
 * call from a process `exit` handler.
 */
export function releaseSessiondSocketPath(socketPath: string, identity: SessiondSocketIdentity): void {
  try {
    const current = lstatSync(socketPath);
    if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(socketPath);
  } catch {
    // Already gone or unreadable: nothing of ours left to remove.
  }
}
