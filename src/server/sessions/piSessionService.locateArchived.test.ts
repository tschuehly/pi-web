import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiSessionManagerGateway, defaultPiSessionDir } from "./piSessionManagerGateway.js";
import { PiSessionService, type PiSessionManagerGateway } from "./piSessionService.js";
import { CapturingSessionEventHub, testModelRuntime } from "./piSessionService.testSupport.js";
import { SessionArchiveStore } from "./sessionArchiveStore.js";
import { registerSessionRoutes } from "./sessionRoutes.js";

let tempDir: string;
let agentDir: string;
let archiveFile: string;
let cwdA: string;
let cwdB: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-locate-archived-test-"));
  agentDir = join(tempDir, "agent");
  archiveFile = join(tempDir, "data", "archived-sessions.json");
  cwdA = join(tempDir, "workspace-a");
  cwdB = join(tempDir, "workspace-b");
  await Promise.all([mkdir(cwdA, { recursive: true }), mkdir(cwdB, { recursive: true })]);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** A persisted Chat in the SDK's default session folder for `cwd`. */
async function writeChat(cwd: string, id: string): Promise<string> {
  const dir = defaultPiSessionDir(cwd, agentDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd };
  const message = { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: `hello ${id}` }], timestamp: 1 } };
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, "utf8");
  return path;
}

function archiveInput(cwd: string, id: string, path: string) {
  return { sessionId: id, cwd, path, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:01:00.000Z", messageCount: 1, firstMessage: `hello ${id}` };
}

/** The real settings-aware gateway and archive store behind a real service and its HTTP routes; counts runtime opens. */
async function harness(options: { archiveStore?: SessionArchiveStore; withoutGatewayLocate?: boolean } = {}) {
  const gateway = createPiSessionManagerGateway({ agentDir, env: {} });
  const create = vi.spyOn(gateway, "create");
  const open = vi.spyOn(gateway, "open");
  const listAll = vi.spyOn(gateway, "listAll");
  // A custom or older gateway: id lookup falls back to the whole listAll catalog.
  const sessionManager: PiSessionManagerGateway = options.withoutGatewayLocate === true
    ? new Proxy(gateway, { get: (target, key): unknown => (key === "locate" ? undefined : Reflect.get(target, key)) })
    : gateway;
  let runtimes = 0;
  const hub = new CapturingSessionEventHub();
  const service = new PiSessionService(hub, {
    agentDir,
    modelRuntime: testModelRuntime,
    archiveStore: options.archiveStore ?? new SessionArchiveStore(archiveFile),
    sessionManager,
    createAgentRuntime: () => {
      runtimes += 1;
      return Promise.reject(new Error("locate must not create a runtime"));
    },
    heartbeatIntervalMs: 60_000,
  });
  const app = Fastify();
  registerSessionRoutes(app, service, hub);
  await app.ready();
  const locateRoute = (id: string) => app.inject({ method: "GET", url: `/sessions/locate/${encodeURIComponent(id)}` });
  const close = async () => {
    expect({ create: create.mock.calls.length, open: open.mock.calls.length, runtimes }).toEqual({ create: 0, open: 0, runtimes: 0 });
    await service.dispose();
    await app.close();
  };
  return { gateway, service, app, locateRoute, listAll, close };
}

describe("PiSessionService.locate with archived Chats", () => {
  it("locates a Chat whose archive moved its file out of the SDK session folders", async () => {
    const path = await writeChat(cwdA, "moved-chat");
    await new SessionArchiveStore(archiveFile).archive(archiveInput(cwdA, "moved-chat", path));
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });

    const { gateway, service, app, locateRoute, close } = await harness();
    // Baseline: the SDK-folder-only gateway no longer sees the moved file.
    await expect(gateway.locate?.("moved-chat")).resolves.toBeUndefined();

    await expect(service.locate("moved-chat")).resolves.toEqual({ cwd: cwdA });
    const located = await locateRoute("moved-chat");
    expect({ status: located.statusCode, body: located.json<unknown>() }).toEqual({ status: 200, body: { cwd: cwdA } });
    const listed = await app.inject({ method: "GET", url: `/sessions?${new URLSearchParams({ cwd: cwdA, sessionId: "moved-chat" }).toString()}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ id: "moved-chat", cwd: cwdA, archived: true })]);
    await close();

    const legacy = await harness({ withoutGatewayLocate: true });
    await expect(legacy.service.locate("moved-chat")).resolves.toEqual({ cwd: cwdA });
    await legacy.close();
  });

  it("keeps an exact active Chat ahead of an archived prefix collision, and answers misses as 404", async () => {
    await writeChat(cwdB, "abc");
    const archivedPath = await writeChat(cwdA, "abc-archived");
    await new SessionArchiveStore(archiveFile).archive(archiveInput(cwdA, "abc-archived", archivedPath));

    for (const withoutGatewayLocate of [false, true]) {
      const { service, locateRoute, listAll, close } = await harness({ withoutGatewayLocate });
      await expect(service.locate("abc")).resolves.toEqual({ cwd: cwdB });
      expect(listAll.mock.calls.length > 0).toBe(withoutGatewayLocate);
      await expect(service.locate("abc-arch")).resolves.toEqual({ cwd: cwdA });
      await expect(service.locate("missing")).resolves.toBeUndefined();
      expect((await locateRoute("missing")).statusCode).toBe(404);
      await close();
    }
  });

  it("locates a legacy archive that left its file in place", async () => {
    const path = await writeChat(cwdA, "in-place");
    const inPlace = new SessionArchiveStore(archiveFile, defaultPiSessionDir(cwdA, agentDir));
    const [record] = await inPlace.archiveMany([archiveInput(cwdA, "in-place", path)]);
    expect(record?.archivePath).toBe(path);
    await access(path);

    const { service, close } = await harness({ archiveStore: inPlace });
    await expect(service.locate("in-place")).resolves.toEqual({ cwd: cwdA });
    await close();
  });

  it("fails closed on a malformed archive instead of guessing from the session folders", async () => {
    await writeChat(cwdB, "active-chat");
    await mkdir(join(tempDir, "data"), { recursive: true });
    await writeFile(archiveFile, "{ not json", "utf8");

    const { service, locateRoute, close } = await harness();
    await expect(service.locate("active-chat")).rejects.toThrow();
    expect((await locateRoute("active-chat")).statusCode).toBe(400);
    await close();
  });
});
