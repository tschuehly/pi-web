import { describe, expect, it } from "vitest";
import { EXTENSION_STATUS_LIMIT } from "../../shared/apiTypes.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const SESSION_ID = "session-1";

function serviceWithRuntimes(...runtimes: ReturnType<typeof fakeRuntime>[]) {
  const events = new CapturingSessionEventHub();
  let next = 0;
  const service = new PiSessionService(events, {
    agentDir: "/tmp/pi-web-test-agent",
    modelRuntime: testModelRuntime,
    sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: () => {
      const runtime = runtimes[next]?.runtime;
      next += 1;
      return runtime === undefined ? Promise.reject(new Error("Missing test runtime")) : Promise.resolve(runtime);
    },
    heartbeatIntervalMs: 60_000,
  });
  return { service, events };
}

describe("PiSessionService extension status bridge", () => {
  it("retains setStatus values in status reads and publishes updates, then clears them", async () => {
    const fake = fakeRuntime(SESSION_ID);
    const { service, events } = serviceWithRuntimes(fake);
    await service.status(sessionRef(SESSION_ID));
    const ui = fake.calls.bindExtensions[0]?.uiContext;
    if (ui === undefined) throw new Error("Extension UI context was not bound");

    ui.setStatus("working-mode", "selected");
    expect((await service.status(sessionRef(SESSION_ID))).extensionStatuses).toEqual({ "working-mode": "selected" });
    expect(events.sessionEvents.some(({ event }) => event.type === "status.update" && event.status.extensionStatuses?.["working-mode"] === "selected")).toBe(true);

    ui.setStatus("working-mode", undefined);
    expect((await service.status(sessionRef(SESSION_ID))).extensionStatuses).toBeUndefined();
    await service.dispose();
  });

  it("bounds entries and clears status naturally when the live runtime is replaced", async () => {
    const first = fakeRuntime(SESSION_ID);
    const second = fakeRuntime(SESSION_ID);
    const { service } = serviceWithRuntimes(first, second);
    await service.status(sessionRef(SESSION_ID));
    const ui = first.calls.bindExtensions[0]?.uiContext;
    if (ui === undefined) throw new Error("Extension UI context was not bound");
    ui.setStatus("x".repeat(129), "value");
    ui.setStatus("oversized", "x".repeat(65_537));
    expect((await service.status(sessionRef(SESSION_ID))).extensionStatuses).toBeUndefined();
    for (let index = 0; index < EXTENSION_STATUS_LIMIT + 1; index += 1) ui.setStatus(`key-${String(index)}`, "value");
    expect(Object.keys((await service.status(sessionRef(SESSION_ID))).extensionStatuses ?? {})).toHaveLength(EXTENSION_STATUS_LIMIT);

    await service.stop(sessionRef(SESSION_ID));
    expect((await service.status(sessionRef(SESSION_ID))).extensionStatuses).toBeUndefined();
    await service.dispose();
  });
});
