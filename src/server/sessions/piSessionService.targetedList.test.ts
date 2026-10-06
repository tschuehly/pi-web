import { describe, expect, it, vi } from "vitest";
import { PiSessionService, type PiSessionListEntry, type PiSessionServiceDependencies } from "./piSessionService.js";
import type { ArchivedSessionRecord } from "./sessionArchiveStore.js";
import { SessionUnreadStore } from "./sessionUnreadStore.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, resolveSessionFileFromList, runtimeCreator, sessionRecord, testModelRuntime, type SessionGateway } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const CWD = "/workspace";

/** A gateway that ignores the targeted option, like a custom or older implementation, and counts every SDK-facing call. */
function countingGateway(entries: PiSessionListEntry[]) {
  const calls: { list: unknown[][]; open: number; create: number } = { list: [], open: 0, create: 0 };
  const list = (cwd: string) => Promise.resolve(entries.filter((entry) => entry.cwd === cwd));
  const gateway: SessionGateway = {
    create: () => {
      calls.create += 1;
      return fakeSessionManager();
    },
    list: (cwd: string, options?: { sessionId?: string }) => {
      calls.list.push([cwd, options]);
      return list(cwd);
    },
    listAll: () => Promise.resolve(entries),
    invalidateSessionFile: () => undefined,
    resolveSessionFile: resolveSessionFileFromList(list),
    open: () => {
      calls.open += 1;
      return fakeSessionManager();
    },
  };
  return { gateway, calls };
}

function archiveStoreWith(records: ArchivedSessionRecord[]): NonNullable<PiSessionServiceDependencies["archiveStore"]> {
  return { ...emptyArchiveStore(), list: () => Promise.resolve(records), isArchived: (id) => Promise.resolve(records.some((record) => record.sessionId === id)) };
}

function serviceWith(deps: Partial<PiSessionServiceDependencies> & Pick<PiSessionServiceDependencies, "sessionManager">) {
  const hub = new CapturingSessionEventHub();
  let runtimesCreated = 0;
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: () => {
      runtimesCreated += 1;
      return Promise.reject(new Error("metadata lookup must not create a runtime"));
    },
    heartbeatIntervalMs: 60_000,
    ...deps,
  });
  return { service, hub, runtimesCreated: () => runtimesCreated };
}

const target = { ...sessionRecord("target-id"), messageCount: 3, firstMessage: "hello", name: "Latest" };
const sibling = sessionRecord("sibling-id");
const prefixed = sessionRecord("target-id-2");
const elsewhere = sessionRecord("target-id", "/elsewhere");

describe("PiSessionService targeted listing", () => {
  it("returns the ordinary listing's exact row and re-filters a gateway that ignores the target", async () => {
    const { gateway, calls } = countingGateway([target, sibling, prefixed, elsewhere]);
    const { service, runtimesCreated } = serviceWith({ sessionManager: gateway });
    const full = (await service.list(CWD)).find((session) => session.id === "target-id");

    await expect(service.list(CWD, { sessionId: "target-id" })).resolves.toEqual([full]);
    await expect(service.list(CWD, { sessionId: "target" })).resolves.toEqual([]);
    await expect(service.list(CWD, { sessionId: "missing" })).resolves.toEqual([]);
    expect(calls.list.at(-1)).toEqual([CWD, { sessionId: "missing" }]);
    expect({ open: calls.open, create: calls.create, runtimes: runtimesCreated() }).toEqual({ open: 0, create: 0, runtimes: 0 });
    await service.dispose();
  });

  it("projects current archive records exactly like the ordinary listing, ahead of the persisted row", async () => {
    const complete: ArchivedSessionRecord = { sessionId: "target-id", cwd: CWD, archivedAt: "2026-01-03T00:00:00.000Z", originalPath: "/sessions/target-id.jsonl", archivePath: "/archive/target-id.jsonl", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-02T00:00:00.000Z", messageCount: 5, firstMessage: "archived", name: "Archived" };
    const legacy: ArchivedSessionRecord = { sessionId: "sibling-id", cwd: CWD, archivedAt: "2026-01-03T00:00:00.000Z" };
    const unprojectable: ArchivedSessionRecord = { sessionId: "orphan-id", cwd: CWD, archivedAt: "2026-01-03T00:00:00.000Z" };
    const { gateway } = countingGateway([target, sibling]);
    const { service, runtimesCreated } = serviceWith({ sessionManager: gateway, archiveStore: archiveStoreWith([complete, legacy, unprojectable]) });
    const full = await service.list(CWD);

    const [archived] = await service.list(CWD, { sessionId: "target-id" });
    expect(archived).toEqual(full.find((session) => session.id === "target-id"));
    expect(archived).toMatchObject({ archived: true, name: "Archived" });
    // A legacy record without summary fields falls back to the persisted row, like the full listing.
    await expect(service.list(CWD, { sessionId: "sibling-id" })).resolves.toEqual([full.find((session) => session.id === "sibling-id")]);
    // An archive record nothing can project is never turned into a writable row.
    await expect(service.list(CWD, { sessionId: "orphan-id" })).resolves.toEqual([]);
    expect(runtimesCreated()).toBe(0);
    await service.dispose();
  });

  it("projects an already hosted, unpersisted Chat without publishing or touching its runtime", async () => {
    const hosted = fakeRuntime("blank-id", { sessionFile: undefined, sessionManager: fakeSessionManager(CWD, { getSessionId: () => "blank-id" }) });
    const { gateway } = countingGateway([]);
    const hub = new CapturingSessionEventHub();
    const service = new PiSessionService(hub, { agentDir: TEST_AGENT_DIR, modelRuntime: testModelRuntime, archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(hosted.runtime), sessionManager: gateway, heartbeatIntervalMs: 60_000 });
    const started = await service.start(CWD);
    const published = hub.globalEvents.length;
    const sessionEvents = hub.sessionEvents.length;

    const [listed] = await service.list(CWD, { sessionId: "blank-id" });
    expect(listed).toMatchObject({ id: "blank-id", cwd: CWD, path: "", persisted: false, messageCount: 0, firstMessage: "" });
    expect(listed).toEqual({ ...started, created: listed?.created, modified: listed?.modified });
    await expect(service.list("/elsewhere", { sessionId: "blank-id" })).resolves.toEqual([]);
    expect({ global: hub.globalEvents.length, session: hub.sessionEvents.length, bind: hosted.calls.bindExtensions.length }).toEqual({ global: published, session: sessionEvents, bind: 1 });
    await service.dispose();
  });

  it("leaves sibling unread and activity state alone, while the ordinary listing still reconciles", async () => {
    const unreadStore = new SessionUnreadStore();
    const reconcileCwd = vi.spyOn(unreadStore, "reconcileCwd");
    const workspaceActivity = { applySessionStatus: vi.fn(), applySessionActivity: vi.fn(), removeSession: vi.fn(), reconcileSessionActivity: vi.fn() };
    const { gateway } = countingGateway([target, sibling]);
    const { service } = serviceWith({ sessionManager: gateway, unreadStore, workspaceActivity });

    await service.list(CWD, { sessionId: "target-id" });
    expect(reconcileCwd).not.toHaveBeenCalled();
    expect(workspaceActivity.reconcileSessionActivity).not.toHaveBeenCalled();

    await service.list(CWD);
    expect(reconcileCwd).toHaveBeenCalledTimes(1);
    expect(workspaceActivity.reconcileSessionActivity).toHaveBeenCalledWith(CWD, ["target-id", "sibling-id"]);
    await service.dispose();
  });
});
