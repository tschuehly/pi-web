import { describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const SESSION_ID = "session-1";

function attentionService() {
  const fake = fakeRuntime(SESSION_ID);
  const events = new CapturingSessionEventHub();
  const service = new PiSessionService(events, {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: runtimeCreator(fake.runtime),
    askUserEnabled: true,
    heartbeatIntervalMs: 60_000,
  });
  return { service, events, fake };
}

describe("PiSessionService attention requests", () => {
  it("publishes a bounded global attention preview with session metadata", async () => {
    const { service, events, fake } = attentionService();
    await service.status(sessionRef(SESSION_ID));
    fake.session.sessionName = "Build Chat";

    const request = service.requestAttention(SESSION_ID, `Log in to npm so I can publish.\n${"x".repeat(200)}`);

    expect(events.globalEvents).toContainEqual({ type: "session.attention", sessionId: SESSION_ID, cwd: "/workspace", sessionName: "Build Chat", kind: "attention", id: request.id, detail: "Log in to npm so I can publish." });
    await service.dispose();
  });

  it("keeps the latest request in status and the open-asks read until the owner acknowledges that request", async () => {
    const { service } = attentionService();
    await service.status(sessionRef(SESSION_ID));

    const first = service.requestAttention(SESSION_ID, "Review the PR");
    const latest = service.requestAttention(SESSION_ID, "Review the PR, now with tests");

    expect((await service.status(sessionRef(SESSION_ID))).attentionRequest).toEqual(latest);
    expect(service.attentionRequest(sessionRef(SESSION_ID))).toEqual(latest);
    expect(service.acknowledgeAttention(sessionRef(SESSION_ID), first.id)).toBe(false);
    expect((await service.status(sessionRef(SESSION_ID))).attentionRequest).toEqual(latest);
    expect(service.acknowledgeAttention(sessionRef(SESSION_ID), latest.id)).toBe(true);
    expect(await service.status(sessionRef(SESSION_ID))).not.toHaveProperty("attentionRequest");
    expect(service.attentionRequest(sessionRef(SESSION_ID))).toBeUndefined();
    await service.dispose();
  });

  it("clears the request when the owner sends a message in the Chat", async () => {
    const { service, events } = attentionService();
    await service.status(sessionRef(SESSION_ID));
    service.requestAttention(SESSION_ID, "Review the PR");
    events.sessionEvents.length = 0;

    await service.prompt(sessionRef(SESSION_ID), "Looks good, merge it");

    expect(await service.status(sessionRef(SESSION_ID))).not.toHaveProperty("attentionRequest");
    expect(events.sessionEvents.some(({ event }) => event.type === "status.update" && event.status.attentionRequest === undefined)).toBe(true);
    await service.dispose();
  });
});
