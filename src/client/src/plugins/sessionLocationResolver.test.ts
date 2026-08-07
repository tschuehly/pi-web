import { describe, expect, it, vi } from "vitest";
import type { Project, SessionInfo, Workspace } from "../api";
import { recheckSessionLocationEvidence, resolveSessionLocation, type SessionLocationCatalog } from "./sessionLocationResolver";

describe("plugin session location resolution", () => {
  it("returns one exact machine/session/catalog-cwd match only after scanning every registered workspace", async () => {
    const catalog = catalogFixture({
      projects: [project("project-a", "/a"), project("project-b", "/b")],
      workspaces: {
        "project-a": [workspace("workspace-a", "project-a", "/a")],
        "project-b": [workspace("workspace-b", "project-b", "/b")],
      },
      sessions: {
        "/a": [session("wanted", "/wrong-cwd"), session("other", "/a")],
        "/b": [session("wanted", "/b")],
      },
    });

    await expect(resolveSessionLocation({ machineId: "machine-a", sessionId: "wanted" }, catalog)).resolves.toEqual({
      type: "found",
      location: { machineId: "machine-a", projectId: "project-b", workspaceId: "workspace-b" },
      evidence: {
        machineId: "machine-a",
        sessionId: "wanted",
        location: { machineId: "machine-a", projectId: "project-b", workspaceId: "workspace-b" },
        catalogCwd: "/b",
        evidenceId: "wanted",
        matchedCwd: "/b",
        scannedScopeCount: 2,
        verifiedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    expect(catalog.sessions).toHaveBeenCalledTimes(2);
    expect(catalog.sessions).toHaveBeenNthCalledWith(1, "/a", "machine-a");
    expect(catalog.sessions).toHaveBeenNthCalledWith(2, "/b", "machine-a");
  });

  it("returns every exact location when the session identity is ambiguous", async () => {
    const catalog = catalogFixture({
      projects: [project("project-a", "/a")],
      workspaces: {
        "project-a": [workspace("workspace-a", "project-a", "/a"), workspace("workspace-b", "project-a", "/b")],
      },
      sessions: {
        "/a": [session("wanted", "/a")],
        "/b": [session("wanted", "/b")],
      },
    });

    await expect(resolveSessionLocation({ machineId: "machine-a", sessionId: "wanted" }, catalog)).resolves.toEqual({
      type: "ambiguous",
      locations: [
        {
          location: { machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-a" },
          evidence: { machineId: "machine-a", sessionId: "wanted", location: { machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-a" }, catalogCwd: "/a", evidenceId: "wanted", matchedCwd: "/a", scannedScopeCount: 2, verifiedAt: "2026-01-01T00:00:01.000Z" },
        },
        {
          location: { machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-b" },
          evidence: { machineId: "machine-a", sessionId: "wanted", location: { machineId: "machine-a", projectId: "project-a", workspaceId: "workspace-b" }, catalogCwd: "/b", evidenceId: "wanted", matchedCwd: "/b", scannedScopeCount: 2, verifiedAt: "2026-01-01T00:00:01.000Z" },
        },
      ],
    });
  });

  it("returns missing only after a successful complete scan", async () => {
    const catalog = catalogFixture({
      projects: [project("project-a", "/a")],
      workspaces: { "project-a": [workspace("workspace-a", "project-a", "/a")] },
      sessions: { "/a": [session("other", "/a")] },
    });

    await expect(resolveSessionLocation({ machineId: "machine-a", sessionId: "wanted" }, catalog)).resolves.toEqual({ type: "missing" });
  });

  it("fails closed with every failed scope after continuing the available part of a partial scan", async () => {
    const catalog = catalogFixture({
      projects: [project("project-a", "/a"), project("project-b", "/b"), project("project-c", "/c")],
      workspaces: {
        "project-a": [workspace("workspace-match", "project-a", "/a")],
        "project-c": [workspace("workspace-failed", "project-c", "/c"), workspace("workspace-scanned", "project-c", "/c-ok")],
      },
      sessions: {
        "/a": [session("wanted", "/a")],
        "/c-ok": [],
      },
      failedProjects: new Set(["project-b"]),
      failedCwds: new Set(["/c"]),
    });

    await expect(resolveSessionLocation({ machineId: "machine-a", sessionId: "wanted" }, catalog)).resolves.toEqual({
      type: "unavailable",
      failedScopes: [
        { type: "project", machineId: "machine-a", projectId: "project-b" },
        { type: "workspace", machineId: "machine-a", projectId: "project-c", workspaceId: "workspace-failed", cwd: "/c" },
      ],
    });
    expect(catalog.sessions).toHaveBeenCalledTimes(3);
  });

  it("never scans another machine implicitly", async () => {
    const catalog = catalogFixture({
      registeredMachines: new Set(["machine-a", "machine-b"]),
      projects: [project("project-a", "/a")],
      workspaces: { "project-a": [workspace("workspace-a", "project-a", "/a")] },
      sessions: { "/a": [session("wanted", "/a")] },
    });

    await resolveSessionLocation({ machineId: "machine-b", sessionId: "wanted" }, catalog);

    expect(catalog.projects).toHaveBeenCalledExactlyOnceWith("machine-b");
    expect(catalog.workspaces).toHaveBeenCalledExactlyOnceWith("project-a", "machine-b");
    expect(catalog.sessions).toHaveBeenCalledExactlyOnceWith("/a", "machine-b");
  });

  it("returns unavailable without scanning when the exactly requested machine is not registered", async () => {
    const catalog = catalogFixture({ registeredMachines: new Set(["machine-a"]), projects: [], workspaces: {}, sessions: {} });

    await expect(resolveSessionLocation({ machineId: "machine-b", sessionId: "wanted" }, catalog)).resolves.toEqual({
      type: "unavailable",
      failedScopes: [{ type: "machine", machineId: "machine-b" }],
    });
    expect(catalog.projects).not.toHaveBeenCalled();
  });

  it("reconfirms one explicitly selected ambiguous match after a fresh complete scan", async () => {
    const catalog = catalogFixture({
      projects: [project("project-a", "/a")],
      workspaces: { "project-a": [workspace("workspace-a", "project-a", "/a"), workspace("workspace-b", "project-a", "/b")] },
      sessions: { "/a": [session("wanted", "/a")], "/b": [session("wanted", "/b")] },
    });
    const resolution = await resolveSessionLocation({ machineId: "machine-a", sessionId: "wanted" }, catalog);
    if (resolution.type !== "ambiguous") throw new Error("Expected ambiguous evidence");
    const selected = resolution.locations[1];
    if (selected === undefined) throw new Error("Expected a second ambiguous candidate");

    await expect(recheckSessionLocationEvidence(selected.evidence, catalog)).resolves.toEqual({
      type: "confirmed",
      evidence: selected.evidence,
    });
  });

  it("can recheck bounded found evidence with a fresh complete scan immediately before append", async () => {
    let currentSessions = [session("wanted", "/a")];
    const catalog = catalogFixture({
      projects: [project("project-a", "/a")],
      workspaces: { "project-a": [workspace("workspace-a", "project-a", "/a")] },
      sessions: { "/a": () => currentSessions },
    });
    const resolution = await resolveSessionLocation({ machineId: "machine-a", sessionId: "wanted" }, catalog);
    if (resolution.type !== "found") throw new Error("Expected initial found evidence");
    await expect(recheckSessionLocationEvidence(resolution.evidence, catalog)).resolves.toEqual({
      type: "confirmed",
      evidence: resolution.evidence,
    });
    currentSessions = [];

    await expect(recheckSessionLocationEvidence(resolution.evidence, catalog)).resolves.toEqual({
      type: "stale",
      resolution: { type: "missing" },
    });
    expect(catalog.projects).toHaveBeenCalledTimes(3);
    expect(catalog.sessions).toHaveBeenCalledTimes(3);
  });
});

interface CatalogFixtureOptions {
  registeredMachines?: Set<string>;
  projects: Project[];
  workspaces: Record<string, Workspace[]>;
  sessions: Record<string, SessionInfo[] | (() => SessionInfo[])>;
  failedProjects?: Set<string>;
  failedCwds?: Set<string>;
}

function catalogFixture(options: CatalogFixtureOptions): SessionLocationCatalog & {
  projects: ReturnType<typeof vi.fn<SessionLocationCatalog["projects"]>>;
  workspaces: ReturnType<typeof vi.fn<SessionLocationCatalog["workspaces"]>>;
  sessions: ReturnType<typeof vi.fn<SessionLocationCatalog["sessions"]>>;
} {
  return {
    isMachineRegistered: (machineId) => (options.registeredMachines ?? new Set(["machine-a"])).has(machineId),
    now: () => "2026-01-01T00:00:01.000Z",
    projects: vi.fn(() => Promise.resolve(options.projects)),
    workspaces: vi.fn((projectId) => {
      if (options.failedProjects?.has(projectId) === true) return Promise.reject(new Error(`project ${projectId} failed`));
      return Promise.resolve(options.workspaces[projectId] ?? []);
    }),
    sessions: vi.fn((cwd) => {
      if (options.failedCwds?.has(cwd) === true) return Promise.reject(new Error(`workspace ${cwd} failed`));
      const value = options.sessions[cwd] ?? [];
      return Promise.resolve(typeof value === "function" ? value() : value);
    }),
  };
}

function project(id: string, path: string): Project {
  return { id, name: id, path, createdAt: "2026-01-01T00:00:00.000Z" };
}

function workspace(id: string, projectId: string, path: string): Workspace {
  return { id, projectId, path, label: id, isMain: false, isGitRepo: true, isGitWorktree: true, effectiveConfig: {} };
}

function session(id: string, cwd: string): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
  };
}
