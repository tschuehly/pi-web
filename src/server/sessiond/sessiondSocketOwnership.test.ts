import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimSessiondSocketPath,
  releaseSessiondSocketPath,
  SessiondSocketOwnershipError,
  sessiondSocketIdentity,
} from "./sessiondSocketOwnership.js";

let root: string;
let socketPath: string;
const servers: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-web-sock-"));
  socketPath = join(root, "sessiond.sock");
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.close(resolve); })));
  await rm(root, { recursive: true, force: true });
});

async function listen(path: string): Promise<Server> {
  const server = createServer((socket) => { socket.end(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  servers.push(server);
  return server;
}

/** A socket file left behind by a daemon that died without closing its listener. */
function leaveStaleSocket(path: string): void {
  try {
    execFileSync(process.execPath, [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
      path,
    ], { stdio: "ignore" });
  } catch {
    // The SIGKILL exit is the point: the listener never closes, so its file stays.
  }
}

describe("session daemon socket ownership", () => {
  it("refuses, without unlinking, a socket a live peer accepts connections on", async () => {
    await listen(socketPath);
    const before = await lstat(socketPath);

    await expect(claimSessiondSocketPath(socketPath)).rejects.toBeInstanceOf(SessiondSocketOwnershipError);

    const after = await lstat(socketPath);
    expect(after.ino).toBe(before.ino);
  });

  it("refuses to remove a path that is not a socket", async () => {
    await writeFile(socketPath, "not a socket");
    await expect(claimSessiondSocketPath(socketPath)).rejects.toThrow(/not a socket/);
    expect(existsSync(socketPath)).toBe(true);
  });

  it("replaces a stale socket left by a dead daemon", async () => {
    leaveStaleSocket(socketPath);
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    await claimSessiondSocketPath(socketPath);

    expect(existsSync(socketPath)).toBe(false);
    await listen(socketPath);
  });

  it("creates the socket directory when nothing exists yet", async () => {
    const nested = join(root, "nested", "sessiond.sock");
    await claimSessiondSocketPath(nested);
    await listen(nested);
  });

  it("on exit unlinks its own socket but not one another instance bound in its place", async () => {
    const first = await listen(socketPath);
    const firstIdentity = sessiondSocketIdentity(socketPath);
    releaseSessiondSocketPath(socketPath, firstIdentity);
    expect(existsSync(socketPath)).toBe(false);

    // The first daemon's path was replaced by another instance before it exited.
    await new Promise((resolve) => { first.close(resolve); });
    await listen(socketPath);
    const replacement = await lstat(socketPath);

    releaseSessiondSocketPath(socketPath, firstIdentity);

    expect((await lstat(socketPath)).ino).toBe(replacement.ino);
    await expect(claimSessiondSocketPath(socketPath)).rejects.toBeInstanceOf(SessiondSocketOwnershipError);
  });
});
