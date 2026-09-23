import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { SessionEventHub } from "./realtime/sessionEventHub.js";
import { registerSessionRoutes } from "./sessions/sessionRoutes.js";
import { PiSessionService } from "./sessions/piSessionService.js";
import { emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, testModelRuntime } from "./sessions/piSessionService.testSupport.js";
import { openControlledPendingAskFixture } from "./controlledPendingAskFixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("opens a daemon-memory ask on an owned session through the normal status and ask routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-pending-fixture-"));
  roots.push(root);
  const cwd = join(root, "workspaces", "anchor-1");
  const sessionDir = join(root, "agent", "sessions");
  const dataDir = join(root, "data");
  const manifest = join(root, "manifest.json");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(dataDir, { recursive: true })]);
  await writeFile(manifest, JSON.stringify({ anchors: [{ sessionId: "019c8f10-1000-7000-8000-000000000001", cwd }] }));
  const env = { PI_WEB_FIXTURE_OWNED_ROOT: root, PI_WEB_FIXTURE_PENDING_ASK_MANIFEST: manifest, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_CODING_AGENT_DIR: join(root, "agent"), PI_WEB_DATA_DIR: dataDir, PI_WEB_SESSIOND_SOCKET: join(root, "data", "sessiond.sock") };
  const fake = fakeRuntime("019c8f10-1000-7000-8000-000000000001");
  const events = new SessionEventHub();
  const sessions = new PiSessionService(events, {
    agentDir: join(root, "agent"), modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([sessionRecord("019c8f10-1000-7000-8000-000000000001", cwd)]),
    archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime), heartbeatIntervalMs: 60_000,
  });
  const app = Fastify();
  registerSessionRoutes(app, sessions, events);
  try {
    await expect(openControlledPendingAskFixture(sessions, { ...env, PI_WEB_DATA_DIR: tmpdir() })).rejects.toThrow("data dir must be strictly inside");
    const before = await app.inject({ url: `/sessions/019c8f10-1000-7000-8000-000000000001/status?cwd=${encodeURIComponent(cwd)}` });
    expect(before.json()).not.toHaveProperty("pendingAsk");
    await openControlledPendingAskFixture(sessions, env);
    const during = await app.inject({ url: `/sessions/019c8f10-1000-7000-8000-000000000001/status?cwd=${encodeURIComponent(cwd)}` });
    expect(during.statusCode).toBe(200);
    const body: unknown = JSON.parse(during.body);
    expect(body).toMatchObject({ pendingAsk: { questions: [{ id: "fixture-choice" }] } });
    if (typeof body !== "object" || body === null || !("pendingAsk" in body)) throw new Error("Missing pending ask");
    const ask: unknown = body.pendingAsk;
    if (typeof ask !== "object" || ask === null || !("askId" in ask) || typeof ask.askId !== "string") throw new Error("Missing ask id");
    const response = await app.inject({ method: "POST", url: "/sessions/019c8f10-1000-7000-8000-000000000001/ask/submit", payload: { cwd, askId: ask.askId, answers: [{ id: "fixture-choice", values: ["one"] }] } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: "closed" });
    expect((await app.inject({ url: `/sessions/019c8f10-1000-7000-8000-000000000001/status?cwd=${encodeURIComponent(cwd)}` })).json()).not.toHaveProperty("pendingAsk");
    expect(fake.calls.sendCustomMessage).toHaveLength(1);
  } finally {
    await app.close();
    await sessions.dispose();
  }
});
