import { describe, expect, it } from "vitest";
import { IDLE_SESSION_UNLOAD_MS, PiSessionService } from "./piSessionService.js";
import type { RealtimeSocket } from "../realtime/sessionEventHub.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const SESSION_ID = "session-1";

async function loadedSession(patch: Parameters<typeof fakeRuntime>[1] = {}) {
  let clock = Date.UTC(2026, 10, 3);
  const fake = fakeRuntime(SESSION_ID, patch);
  const hub = new CapturingSessionEventHub();
  const service = new PiSessionService(hub, {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
    archiveStore: emptyArchiveStore(),
    askUserEnabled: true,
    heartbeatIntervalMs: 60_000,
    now: () => new Date(clock),
  });
  await service.status(sessionRef(SESSION_ID));
  expect(service.activeCount()).toBe(1);
  return { service, fake, hub, advance: (ms: number) => { clock += ms; } };
}

function browserSocket() {
  const closeListeners: (() => void)[] = [];
  const socket: RealtimeSocket = { OPEN: 1, readyState: 1, send: () => undefined, terminate: () => undefined, on: (_event, listener) => { closeListeners.push(listener); } };
  return { socket, close: () => { for (const listener of closeListeners) listener(); } };
}

describe("PiSessionService idle unload", () => {
  it("unloads a session idle for the threshold and reopens it on next access", async () => {
    const { service, fake, advance } = await loadedSession();

    advance(IDLE_SESSION_UNLOAD_MS - 1);
    await service.unloadIdleSessions();
    expect(service.activeCount()).toBe(1);

    advance(1);
    await service.unloadIdleSessions();
    expect(service.activeCount()).toBe(0);
    expect(fake.calls.dispose).toBe(1);

    await service.status(sessionRef(SESSION_ID));
    expect(service.activeCount()).toBe(1);
    await service.dispose();
  });

  it("keeps a busy session", async () => {
    const { service, advance } = await loadedSession({ isStreaming: true });
    advance(IDLE_SESSION_UNLOAD_MS);
    await service.unloadIdleSessions();
    expect(service.activeCount()).toBe(1);
    await service.dispose();
  });

  it("keeps a session with an open ask", async () => {
    const { service, advance } = await loadedSession();
    await service.openAsk({ sessionId: SESSION_ID, context: "Pick one.", questions: [{ id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] }] });
    advance(IDLE_SESSION_UNLOAD_MS);
    await service.unloadIdleSessions();
    expect(service.activeCount()).toBe(1);
    await service.dispose();
  });

  it.each([
    ["a background bash job", "pi-workbench:background-bash", { schemaVersion: 1, jobs: [{ id: "j1" }] }],
    ["a watcher", "pi-process-monitor:watchers", { schemaVersion: 1, watchers: [{ logicalId: "w1" }] }],
    ["a running subagent", "pi-workbench:activity", { schemaVersion: 1, items: [{ id: "c1", kind: "subagent" }] }],
  ])("keeps a session with %s, and unloads it once that work ends", async (_label, key, busy) => {
    const { service, fake, advance } = await loadedSession();
    const ui = fake.calls.bindExtensions[0]?.uiContext;
    ui?.setStatus(key, JSON.stringify(busy));
    advance(IDLE_SESSION_UNLOAD_MS);
    await service.unloadIdleSessions();
    expect(service.activeCount()).toBe(1);

    ui?.setStatus(key, undefined);
    ui?.setStatus("pi-workbench:activity", JSON.stringify({ schemaVersion: 1, items: [{ id: "c1", kind: "subagent", endedAt: "2026-11-03T02:00:00.000Z" }] }));
    advance(IDLE_SESSION_UNLOAD_MS);
    await service.unloadIdleSessions();
    expect(service.activeCount()).toBe(0);
    await service.dispose();
  });

  it("keeps a session while a browser is connected to its events", async () => {
    const { service, hub, advance } = await loadedSession();
    const browser = browserSocket();
    hub.add(SESSION_ID, browser.socket);
    advance(IDLE_SESSION_UNLOAD_MS);
    await service.unloadIdleSessions();
    expect(service.activeCount()).toBe(1);

    browser.close();
    await service.unloadIdleSessions();
    expect(service.activeCount()).toBe(0);
    await service.dispose();
  });
});
