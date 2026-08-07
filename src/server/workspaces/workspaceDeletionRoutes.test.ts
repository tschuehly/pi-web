import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import { ProjectService } from "../projects/projectService.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { ProjectStore } from "../storage/projectStore.js";
import type { Project, WorkspaceListing } from "../types.js";
import { registerWorkspaceDeletionRoutes, WORKTREE_PRE_REMOVE_HOOK_RELATIVE_PATH, type WorktreePreRemoveHookProbe } from "./workspaceDeletionRoutes.js";
import { WorkspaceService } from "./workspaceService.js";

let app: FastifyInstance;
let daemonRequests: DaemonRequest[];
let closeStatusCode: number;
let hookProbePaths: string[];
let hookExecutable: boolean;
let hookProbeError: Error | undefined;

const project: Project = {
  id: "p1",
  name: "Project",
  path: "/repo",
  createdAt: "2026-05-25T00:00:00.000Z",
};

const mainWorkspace: WorkspaceListing = {
  id: "main",
  projectId: project.id,
  path: "/repo",
  label: "main",
  branch: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
};

const targetWorkspace: WorkspaceListing = {
  id: "feature",
  projectId: project.id,
  path: "/repo/feature path",
  label: "feature",
  branch: "feature/branch",
  isMain: false,
  isGitRepo: true,
  isGitWorktree: true,
};

const specialProject: Project = {
  id: "p2",
  name: "Special Project",
  path: "/my repo",
  createdAt: "2026-05-25T00:00:00.000Z",
};

const specialMainWorkspace: WorkspaceListing = {
  id: "special-main",
  projectId: specialProject.id,
  path: "/my repo",
  label: "main",
  branch: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
};

const specialTargetWorkspace: WorkspaceListing = {
  id: "special-feature",
  projectId: specialProject.id,
  path: "/my repo/wt 'x'",
  label: "special",
  branch: "feature/special",
  isMain: false,
  isGitRepo: true,
  isGitWorktree: true,
};

// Probe paths are built with the same join() as the route, so expectations match on every platform.
const mainHookPath = join(mainWorkspace.path, WORKTREE_PRE_REMOVE_HOOK_RELATIVE_PATH);
const specialHookPath = join(specialMainWorkspace.path, WORKTREE_PRE_REMOVE_HOOK_RELATIVE_PATH);

interface AppOptions {
  project?: Project;
  workspaces?: WorkspaceListing[];
}

beforeEach(() => {
  daemonRequests = [];
  hookProbePaths = [];
  hookExecutable = false;
  hookProbeError = undefined;
  closeStatusCode = 200;
  registerApp();
});

afterEach(async () => {
  await app.close();
});

describe("workspace deletion routes", () => {
  it("closes target terminals and repairs moved worktree metadata before deletion", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/feature" });

    expect(response.statusCode).toBe(200);
    expect(response.json<TerminalCommandRun>()).toMatchObject({ id: "run1", workspaceId: "main", terminalId: "terminal1", status: "running" });
    expect(hookProbePaths).toEqual([mainHookPath]);
    expect(daemonRequests).toEqual([
      { method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(targetWorkspace.path)}` },
      {
        method: "POST",
        path: "/terminal-command-runs",
        body: {
          origin: "core",
          projectId: "p1",
          workspaceId: "main",
          cwd: "/repo",
          title: "Delete workspace: feature/branch",
          command: "git worktree repair '/repo/feature path' && git worktree remove '/repo/feature path'",
          metadata: {
            "pi.operation": "workspace.delete",
            "target.workspaceId": "feature",
            "target.workspacePath": "/repo/feature path",
          },
        },
      },
    ]);
  });

  it("runs the repo pre-remove hook before git worktree remove when the hook is executable", async () => {
    hookExecutable = true;

    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/feature" });

    expect(response.statusCode).toBe(200);
    expect(hookProbePaths).toEqual([mainHookPath]);
    expect(daemonRequests).toEqual([
      { method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(targetWorkspace.path)}` },
      {
        method: "POST",
        path: "/terminal-command-runs",
        body: {
          origin: "core",
          projectId: "p1",
          workspaceId: "main",
          cwd: "/repo",
          title: "Delete workspace: feature/branch",
          command: `'${mainHookPath}' '/repo/feature path' && git worktree repair '/repo/feature path' && git worktree remove '/repo/feature path'`,
          metadata: {
            "pi.operation": "workspace.delete",
            "target.workspaceId": "feature",
            "target.workspacePath": "/repo/feature path",
          },
        },
      },
    ]);
  });

  it("quotes hook and worktree paths when they contain spaces and single quotes and the hook is executable", async () => {
    await restartApp({ project: specialProject, workspaces: [specialMainWorkspace, specialTargetWorkspace] });
    hookExecutable = true;

    const response = await app.inject({ method: "DELETE", url: "/api/projects/p2/workspaces/special-feature" });

    expect(response.statusCode).toBe(200);
    expect(hookProbePaths).toEqual([specialHookPath]);
    expect(daemonRequests).toEqual([
      { method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(specialTargetWorkspace.path)}` },
      {
        method: "POST",
        path: "/terminal-command-runs",
        body: {
          origin: "core",
          projectId: "p2",
          workspaceId: "special-main",
          cwd: "/my repo",
          title: "Delete workspace: feature/special",
          command: `'${specialHookPath}' '/my repo/wt '\\''x'\\''' && git worktree repair '/my repo/wt '\\''x'\\''' && git worktree remove '/my repo/wt '\\''x'\\'''`,
          metadata: {
            "pi.operation": "workspace.delete",
            "target.workspaceId": "special-feature",
            "target.workspacePath": "/my repo/wt 'x'",
          },
        },
      },
    ]);
  });

  it("keeps the removal command unchanged for special-character paths when no hook is executable", async () => {
    await restartApp({ project: specialProject, workspaces: [specialMainWorkspace, specialTargetWorkspace] });

    const response = await app.inject({ method: "DELETE", url: "/api/projects/p2/workspaces/special-feature" });

    expect(response.statusCode).toBe(200);
    const dispatch = daemonRequests.at(1);
    expect(dispatch?.body).toMatchObject({ command: "git worktree repair '/my repo/wt '\\''x'\\''' && git worktree remove '/my repo/wt '\\''x'\\'''" });
  });

  it("fails the deletion before closing terminals when the hook probe hits an unexpected filesystem error", async () => {
    hookProbeError = Object.assign(new Error("probe I/O error"), { code: "EIO" });

    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/feature" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "probe I/O error" });
    expect(hookProbePaths).toEqual([mainHookPath]);
    expect(daemonRequests).toEqual([]);
  });

  it("does not start deletion when terminal cleanup fails", async () => {
    closeStatusCode = 500;

    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/feature" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Failed to close workspace terminals: cleanup failed" });
    expect(daemonRequests).toEqual([{ method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(targetWorkspace.path)}` }]);
  });

  it("rejects main workspace deletion before touching terminals", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/main" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Only secondary Git worktrees can be deleted" });
    expect(daemonRequests).toEqual([]);
  });
});

interface DaemonRequest {
  method: string;
  path: string;
  body?: unknown;
}

function registerApp(options: AppOptions = {}): void {
  app = Fastify({ logger: false });
  registerWorkspaceDeletionRoutes(
    app,
    fakeProjects(options.project ?? project),
    fakeWorkspaces(options.workspaces ?? [mainWorkspace, targetWorkspace]),
    fakeDaemon(),
    "/api",
    fakePreRemoveHookProbe(),
  );
}

async function restartApp(options: AppOptions): Promise<void> {
  await app.close();
  registerApp(options);
}

function fakeProjects(project: Project): ProjectService {
  return new FakeProjectService(project);
}

function fakeWorkspaces(workspaces: WorkspaceListing[]): WorkspaceService {
  return new FakeWorkspaceService(workspaces);
}

function fakePreRemoveHookProbe(): WorktreePreRemoveHookProbe {
  return {
    isExecutable: (path) => {
      hookProbePaths.push(path);
      return hookProbeError ? Promise.reject(hookProbeError) : Promise.resolve(hookExecutable);
    },
  };
}

class FakeProjectService extends ProjectService {
  constructor(private readonly project: Project) {
    super(new ProjectStore("/dev/null"));
  }

  override requireProject(projectId: string): Promise<Project> {
    return projectId === this.project.id ? Promise.resolve(this.project) : Promise.reject(new Error("Project not found"));
  }
}

class FakeWorkspaceService extends WorkspaceService {
  constructor(private readonly workspaces: WorkspaceListing[]) {
    super();
  }

  override list(): Promise<WorkspaceListing[]> {
    return Promise.resolve(this.workspaces);
  }
}

function fakeDaemon(): SessionProxyDaemon {
  return {
    request: (method, path, body) => {
      daemonRequests.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "DELETE") {
        return Promise.resolve({
          statusCode: closeStatusCode,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(closeStatusCode === 200 ? { closed: true } : { error: "cleanup failed" }),
        });
      }
      return Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "run1",
          origin: "core",
          projectId: project.id,
          workspaceId: mainWorkspace.id,
          terminalId: "terminal1",
          title: "Delete workspace: feature/branch",
          command: "git worktree remove '/repo/feature path'",
          status: "running",
          createdAt: "2026-05-25T00:00:00.000Z",
          metadata: {
            "pi.operation": "workspace.delete",
            "target.workspaceId": targetWorkspace.id,
            "target.workspacePath": targetWorkspace.path,
          },
        } satisfies TerminalCommandRun),
      });
    },
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
  };
}
