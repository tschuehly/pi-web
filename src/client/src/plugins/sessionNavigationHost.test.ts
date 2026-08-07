import { describe, expect, it, vi } from "vitest";
import type { Project, SessionInfo, Workspace } from "../api";
import { SessionNavigationController, type SessionNavigationCatalog, type SessionNavigationScope } from "./sessionNavigationHost";
import type { PluginMachine, SessionNavigationLocation } from "./types";

describe("SessionNavigationHost", () => {
  it("publishes an ordered immutable complete catalog across anchors and selects only complete locations", async () => {
    const select = vi.fn<(location: SessionNavigationLocation) => Promise<void>>(() => Promise.resolve());
    const catalog = catalogFixture({
      projects: [project("project-a"), project("project-b")],
      workspaces: {
        "project-a": [workspace("workspace-a", "project-a", "/a")],
        "project-b": [workspace("workspace-b", "project-b", "/b")],
      },
      sessions: {
        "/a": [session("session-a", "/a", "2026-01-02T00:00:00.000Z", { name: "Named chat", firstMessage: "Original prompt" })],
        "/b": [session("session-b", "/b", "2026-01-03T00:00:00.000Z", { archived: true, firstMessage: "Second chat" })],
      },
    });
    const controller = createController(catalog, select);
    const release = controller.host.watch(() => undefined);

    await vi.waitFor(() => { expect(controller.host.snapshot().reconnectComplete).toBe(true); });

    const snapshot = controller.host.snapshot();
    expect(snapshot.sessions.map((item) => ({
      sessionId: item.sessionId,
      title: item.title,
      summary: item.summary,
      status: item.status,
      location: item.location,
    }))).toEqual([
      {
        sessionId: "session-b",
        title: "Second chat",
        summary: "Second chat",
        status: "archived",
        location: { machineId: "machine-a", projectId: "project-b", workspaceId: "workspace-b", sessionId: "session-b" },
      },
      {
        sessionId: "session-a",
        title: "Named chat",
        summary: "Original prompt",
        status: "current",
        location: { machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-a", sessionId: "session-a" },
      },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.machine)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions[0]?.location)).toBe(true);

    const first = snapshot.sessions[0];
    if (first === undefined) throw new Error("Expected a catalog item");
    await controller.host.select(first.location);
    expect(select).toHaveBeenCalledExactlyOnceWith(first.location);
    release();
  });

  it("distinguishes initial loading, complete empty, reconnect, and failed reconciliation while retaining the last complete catalog", async () => {
    let currentSessions = [session("session-a", "/a", "2026-01-02T00:00:00.000Z")];
    let failSessions = false;
    const catalog = catalogFixture({
      projects: [project("project-a")],
      workspaces: { "project-a": [workspace("workspace-a", "project-a", "/a")] },
      sessions: { "/a": () => failSessions ? Promise.reject(new Error("offline")) : Promise.resolve(currentSessions) },
    });
    const controller = createController(catalog);
    const observed: { loading: boolean; reconnectComplete: boolean; ids: readonly string[] }[] = [];
    const release = controller.host.watch((snapshot) => {
      observed.push({ loading: snapshot.loading, reconnectComplete: snapshot.reconnectComplete, ids: snapshot.sessions.map((item) => item.sessionId) });
    });

    expect(observed[0]).toEqual({ loading: true, reconnectComplete: false, ids: [] });
    await vi.waitFor(() => { expect(controller.host.snapshot().reconnectComplete).toBe(true); });
    expect(controller.host.snapshot().sessions.map((item) => item.sessionId)).toEqual(["session-a"]);

    controller.sync(scope({ connected: false }));
    expect(controller.host.snapshot()).toMatchObject({ loading: false, reconnectComplete: false });
    expect(controller.host.snapshot().sessions.map((item) => item.sessionId)).toEqual(["session-a"]);

    currentSessions = [];
    controller.sync(scope({ connected: true }));
    expect(controller.host.snapshot()).toMatchObject({ loading: true, reconnectComplete: false });
    expect(controller.host.snapshot().sessions.map((item) => item.sessionId)).toEqual(["session-a"]);
    await vi.waitFor(() => {
      expect(controller.host.snapshot()).toMatchObject({ loading: false, reconnectComplete: true, sessions: [] });
    });

    currentSessions = [session("session-b", "/a", "2026-01-04T00:00:00.000Z")];
    controller.invalidate();
    expect(controller.host.snapshot()).toMatchObject({ loading: true, reconnectComplete: true, sessions: [] });
    await vi.waitFor(() => { expect(controller.host.snapshot().sessions.map((item) => item.sessionId)).toEqual(["session-b"]); });

    controller.sync(scope({ connected: false }));
    failSessions = true;
    controller.sync(scope({ connected: true }));
    await vi.waitFor(() => { expect(controller.host.snapshot().loading).toBe(false); });
    expect(controller.host.snapshot()).toMatchObject({ reconnectComplete: false });
    expect(controller.host.snapshot().sessions.map((item) => item.sessionId)).toEqual(["session-b"]);
    release();
  });

  it("bounds catalog reads and cancels stale selected-machine scans", async () => {
    const pendingWorkspaces = Array.from({ length: 6 }, () => deferred<Workspace[]>());
    let active = 0;
    let maximumActive = 0;
    let workspaceIndex = 0;
    const workspaceCalls = vi.fn<SessionNavigationCatalog["workspaces"]>((): Promise<Workspace[]> => {
      const pending = pendingWorkspaces[workspaceIndex++];
      if (pending === undefined) throw new Error("Missing deferred workspace response");
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return pending.promise.finally(() => { active -= 1; });
    });
    const machineAProjects = deferred<Project[]>();
    let machineASignal: AbortSignal | undefined;
    const projects = vi.fn<SessionNavigationCatalog["projects"]>((machineId, signal) => {
      if (machineId === "machine-a") {
        machineASignal = signal;
        return machineAProjects.promise;
      }
      return Promise.resolve([]);
    });
    const catalog: SessionNavigationCatalog = {
      projects,
      workspaces: workspaceCalls,
      sessions: vi.fn(() => Promise.resolve([])),
    };
    const controller = createController(catalog, undefined, 4);
    const release = controller.host.watch(() => undefined);
    machineAProjects.resolve(Array.from({ length: 6 }, (_, index) => project(`project-${String(index)}`)));

    await vi.waitFor(() => { expect(workspaceCalls).toHaveBeenCalledTimes(4); });
    expect(maximumActive).toBe(4);
    pendingWorkspaces.slice(0, 4).forEach((pending) => { pending.resolve([]); });
    await vi.waitFor(() => { expect(workspaceCalls).toHaveBeenCalledTimes(6); });
    pendingWorkspaces.slice(4).forEach((pending) => { pending.resolve([]); });
    await vi.waitFor(() => { expect(controller.host.snapshot().reconnectComplete).toBe(true); });

    const staleProjects = deferred<Project[]>();
    const cancellingProjects = vi.fn<SessionNavigationCatalog["projects"]>((machineId, signal) => {
      if (machineId === "machine-a") {
        machineASignal = signal;
        return staleProjects.promise;
      }
      return Promise.resolve([]);
    });
    const cancellingCatalog: SessionNavigationCatalog = {
      projects: cancellingProjects,
      workspaces: vi.fn(() => Promise.resolve([])),
      sessions: vi.fn(() => Promise.resolve([])),
    };
    const cancellingController = createController(cancellingCatalog);
    const releaseCancelling = cancellingController.host.watch(() => undefined);
    await vi.waitFor(() => { expect(cancellingProjects).toHaveBeenCalledOnce(); });
    cancellingController.sync(scope({ machine: machine("machine-b") }));

    expect(machineASignal?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(cancellingController.host.snapshot()).toMatchObject({ machine: { id: "machine-b" }, reconnectComplete: true, sessions: [] });
    });
    staleProjects.resolve([project("stale")]);
    expect(cancellingController.host.snapshot().machine.id).toBe("machine-b");
    releaseCancelling();
    release();
  });

  it("coalesces invalidations into one trailing scan without publishing the superseded result", async () => {
    const first = deferred<Project[]>();
    const trailing = deferred<Project[]>();
    const projects = vi.fn<SessionNavigationCatalog["projects"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => trailing.promise);
    const controller = createController({
      projects,
      workspaces: vi.fn(() => Promise.resolve([])),
      sessions: vi.fn(() => Promise.resolve([])),
    });
    const observedCompleteSequences: number[] = [];
    const release = controller.host.watch((snapshot) => {
      if (snapshot.reconnectComplete && !snapshot.loading) observedCompleteSequences.push(snapshot.sequence);
    });

    controller.invalidate();
    controller.invalidate();
    first.resolve([]);
    await vi.waitFor(() => { expect(projects).toHaveBeenCalledTimes(2); });
    expect(observedCompleteSequences).toEqual([]);

    trailing.resolve([]);
    await vi.waitFor(() => { expect(controller.host.snapshot().reconnectComplete).toBe(true); });
    expect(projects).toHaveBeenCalledTimes(2);
    expect(observedCompleteSequences).toHaveLength(1);
    release();
  });

  it("reports failed scopes, retries explicitly, and fails closed on duplicate session homes", async () => {
    let failWorkspace = true;
    const duplicate = session("duplicate", "/shared", "2026-01-02T00:00:00.000Z");
    const catalog = catalogFixture({
      projects: [project("project-a"), project("project-b")],
      workspaces: {
        "project-a": [workspace("workspace-a", "project-a", "/shared")],
        "project-b": [workspace("workspace-b", "project-b", "/shared")],
      },
      sessions: {
        "/shared": () => failWorkspace ? Promise.reject(new Error("offline")) : Promise.resolve([duplicate]),
      },
    });
    const controller = createController(catalog);
    const release = controller.host.watch(() => undefined);

    await vi.waitFor(() => { expect(controller.host.snapshot().loading).toBe(false); });
    expect(controller.host.snapshot().reconnectComplete).toBe(false);
    expect(controller.host.snapshot().failedScopes).toEqual([
      { type: "workspace", machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-a", cwd: "/shared" },
      { type: "workspace", machineId: "machine-a", projectId: "project-b", workspaceId: "workspace-b", cwd: "/shared" },
    ]);

    failWorkspace = false;
    controller.host.refresh();
    await vi.waitFor(() => { expect(controller.host.snapshot().loading).toBe(false); });
    expect(controller.host.snapshot().reconnectComplete).toBe(false);
    expect(controller.host.snapshot().sessions).toEqual([]);
    expect(controller.host.snapshot().failedScopes).toEqual([{
      type: "session",
      machineId: "machine-a",
      sessionId: "duplicate",
      locations: [
        { machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-a", sessionId: "duplicate" },
        { machineId: "machine-a", projectId: "project-b", workspaceId: "workspace-b", sessionId: "duplicate" },
      ],
    }]);
    release();
  });

  it("removes a formerly unique session when refresh discovers a duplicate native home", async () => {
    let duplicateHome = false;
    const catalog = catalogFixture({
      projects: [project("project-a"), project("project-b")],
      workspaces: {
        "project-a": [workspace("workspace-a", "project-a", "/a")],
        "project-b": [workspace("workspace-b", "project-b", "/b")],
      },
      sessions: {
        "/a": [session("duplicate", "/a", "2026-01-02T00:00:00.000Z")],
        "/b": () => Promise.resolve(duplicateHome ? [session("duplicate", "/b", "2026-01-03T00:00:00.000Z")] : []),
      },
    });
    const controller = createController(catalog);
    const release = controller.host.watch(() => undefined);
    await vi.waitFor(() => { expect(controller.host.snapshot().reconnectComplete).toBe(true); });
    expect(controller.host.snapshot().sessions.map((item) => item.sessionId)).toEqual(["duplicate"]);

    duplicateHome = true;
    controller.host.refresh();
    await vi.waitFor(() => { expect(controller.host.snapshot().failedScopes[0]?.type).toBe("session"); });
    expect(controller.host.snapshot().sessions).toEqual([]);
    expect(controller.host.snapshot().reconnectComplete).toBe(false);
    release();
  });

  it("settles loading when the final watcher disposes and sequences rapid selections", async () => {
    const first = deferred<undefined>();
    const selected: string[] = [];
    const select = vi.fn<(location: SessionNavigationLocation) => Promise<void>>(async (location) => {
      selected.push(location.sessionId);
      if (location.sessionId === "first") await first.promise;
    });
    const pendingProjects = deferred<Project[]>();
    const controller = createController({
      projects: () => pendingProjects.promise,
      workspaces: () => Promise.resolve([]),
      sessions: () => Promise.resolve([]),
    }, select);
    const release = controller.host.watch(() => undefined);
    const firstSelection = controller.host.select({ machineId: "machine-a", projectId: "p", workspaceId: "w", sessionId: "first" });
    const secondSelection = controller.host.select({ machineId: "machine-a", projectId: "p", workspaceId: "w", sessionId: "second" });
    await Promise.resolve();
    expect(selected).toEqual(["first"]);

    release();
    expect(controller.host.snapshot().loading).toBe(false);
    first.resolve(undefined);
    await Promise.all([firstSelection, secondSelection]);
    expect(selected).toEqual(["first", "second"]);
  });
});

function createController(
  catalog: SessionNavigationCatalog,
  select: (location: SessionNavigationLocation) => Promise<void> = () => Promise.resolve(),
  concurrency?: number,
): SessionNavigationController {
  return new SessionNavigationController({ catalog, select, ...(concurrency === undefined ? {} : { concurrency }) }, scope());
}

function scope(overrides: Partial<SessionNavigationScope> = {}): SessionNavigationScope {
  return { machine: machine("machine-a"), connected: true, ...overrides };
}

function machine(id: string): PluginMachine {
  return { id, name: id, kind: id === "machine-a" ? "local" : "remote" };
}

interface CatalogFixtureOptions {
  projects: Project[];
  workspaces: Record<string, Workspace[]>;
  sessions: Record<string, SessionInfo[] | (() => Promise<SessionInfo[]>)>;
}

function catalogFixture(options: CatalogFixtureOptions): SessionNavigationCatalog {
  return {
    projects: vi.fn<SessionNavigationCatalog["projects"]>(() => Promise.resolve(options.projects)),
    workspaces: vi.fn<SessionNavigationCatalog["workspaces"]>((projectId) => Promise.resolve(options.workspaces[projectId] ?? [])),
    sessions: vi.fn<SessionNavigationCatalog["sessions"]>((cwd) => {
      const value = options.sessions[cwd] ?? [];
      return typeof value === "function" ? value() : Promise.resolve(value);
    }),
  };
}

function project(id: string): Project {
  return { id, name: id, path: `/${id}`, createdAt: "2026-01-01T00:00:00.000Z" };
}

function workspace(id: string, projectId: string, path: string): Workspace {
  return { id, projectId, path, label: id, isMain: false, isGitRepo: true, isGitWorktree: true, effectiveConfig: {} };
}

function session(
  id: string,
  cwd: string,
  modified: string,
  overrides: Partial<Pick<SessionInfo, "name" | "firstMessage" | "archived">> = {},
): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-01-01T00:00:00.000Z",
    modified,
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("Deferred promise was unavailable");
      resolvePromise(value);
    },
  };
}
