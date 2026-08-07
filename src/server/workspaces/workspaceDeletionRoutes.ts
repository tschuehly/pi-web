import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import type { WorkspaceListing } from "../types.js";
import { workspaceDeletionMetadata } from "../../shared/workspaceDeletion.js";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import type { ProjectService } from "../projects/projectService.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { isNodeErrorWithCode } from "./pathSafety.js";
import type { WorkspaceService } from "./workspaceService.js";

/** Relative path, from a workspace root, of the optional repo-provided hook that runs before `git worktree remove`. */
export const WORKTREE_PRE_REMOVE_HOOK_RELATIVE_PATH = ".pi-web/hooks/worktree-pre-remove";

/** Executability probe for the pre-remove hook; injectable so deletion stays testable without a real filesystem. */
export interface WorktreePreRemoveHookProbe {
  isExecutable(path: string): Promise<boolean>;
}

const realWorktreePreRemoveHookProbe: WorktreePreRemoveHookProbe = {
  async isExecutable(path) {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "ENOTDIR") || isNodeErrorWithCode(error, "EACCES") || isNodeErrorWithCode(error, "EPERM")) return false;
      throw error;
    }
  },
};

export function registerWorkspaceDeletionRoutes(app: FastifyInstance, projects: ProjectService, workspaces: WorkspaceService, daemon: SessionProxyDaemon = new SessionDaemonClient(), prefix = "/api", preRemoveHook: WorktreePreRemoveHookProbe = realWorktreePreRemoveHookProbe): void {
  app.delete<{ Params: { projectId: string; workspaceId: string } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId`, async (request, reply) => {
    try {
      return await deleteWorkspace(projects, workspaces, daemon, preRemoveHook, request.params.projectId, request.params.workspaceId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function deleteWorkspace(projects: ProjectService, workspaces: WorkspaceService, daemon: SessionProxyDaemon, preRemoveHook: WorktreePreRemoveHookProbe, projectId: string, workspaceId: string): Promise<TerminalCommandRun> {
  const project = await projects.requireProject(projectId);
  const projectWorkspaces = await workspaces.list(project);
  const targetWorkspace = projectWorkspaces.find((workspace) => workspace.id === workspaceId);
  if (targetWorkspace === undefined) throw new Error("Workspace not found");
  if (!canDeleteWorkspace(targetWorkspace)) throw new Error("Only secondary Git worktrees can be deleted");

  const commandWorkspace = projectWorkspaces.find((workspace) => workspace.isMain) ?? projectWorkspaces.find((workspace) => workspace.id !== targetWorkspace.id);
  if (commandWorkspace === undefined) throw new Error("Project main workspace not found");

  // Probe before any side effect so an unexpected filesystem failure aborts before terminals are closed.
  const hookPath = join(commandWorkspace.path, WORKTREE_PRE_REMOVE_HOOK_RELATIVE_PATH);
  const hookExecutable = await preRemoveHook.isExecutable(hookPath);

  const closeResponse = await requestJson(daemon, "DELETE", `/terminals?cwd=${encodeURIComponent(targetWorkspace.path)}`);
  if (closeResponse.statusCode < 200 || closeResponse.statusCode >= 300) throw new Error(`Failed to close workspace terminals: ${responseError(closeResponse.body, closeResponse.statusCode)}`);

  // Single composed command: `&&` is the fail-closed guarantee — a non-zero hook exit prevents the removal.
  const quotedTargetPath = shellQuote(targetWorkspace.path);
  const removalCommand = `git worktree repair ${quotedTargetPath} && git worktree remove ${quotedTargetPath}`;
  const command = hookExecutable
    ? `${shellQuote(hookPath)} ${quotedTargetPath} && ${removalCommand}`
    : removalCommand;

  const deleteResponse = await requestJson(daemon, "POST", "/terminal-command-runs", {
    origin: "core",
    projectId: project.id,
    workspaceId: commandWorkspace.id,
    cwd: commandWorkspace.path,
    title: `Delete workspace: ${workspaceLabel(targetWorkspace)}`,
    command,
    metadata: workspaceDeletionMetadata(targetWorkspace),
  });
  if (deleteResponse.statusCode < 200 || deleteResponse.statusCode >= 300) throw new Error(`Failed to start workspace deletion: ${responseError(deleteResponse.body, deleteResponse.statusCode)}`);
  return parseTerminalCommandRun(deleteResponse.body);
}

function canDeleteWorkspace(workspace: WorkspaceListing): boolean {
  return workspace.isGitWorktree && !workspace.isMain;
}

function workspaceLabel(workspace: WorkspaceListing): string {
  return workspace.branch ?? workspace.label;
}

async function requestJson(daemon: SessionProxyDaemon, method: string, path: string, body?: unknown): Promise<{ statusCode: number; body: unknown }> {
  const response = await daemon.request(method, path, body);
  return { statusCode: response.statusCode, body: response.body === "" ? undefined : JSON.parse(response.body) };
}

function responseError(body: unknown, statusCode: number): string {
  if (isRecord(body) && typeof body["error"] === "string") return body["error"];
  return `HTTP ${String(statusCode)}`;
}

function parseTerminalCommandRun(value: unknown): TerminalCommandRun {
  if (!isRecord(value)) throw new Error("Invalid terminal command run response");
  const metadata = value["metadata"];
  if (!isRecord(metadata)) throw new Error("Invalid terminal command run response");
  const startedAt = optionalString(value, "startedAt");
  const exitCode = optionalNumber(value, "exitCode");
  const completedAt = optionalString(value, "completedAt");
  return {
    id: requireString(value, "id"),
    origin: requireString(value, "origin"),
    projectId: requireString(value, "projectId"),
    workspaceId: requireString(value, "workspaceId"),
    terminalId: requireString(value, "terminalId"),
    title: requireString(value, "title"),
    command: requireString(value, "command"),
    status: parseStatus(value["status"]),
    createdAt: requireString(value, "createdAt"),
    metadata: Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function parseStatus(value: unknown): TerminalCommandRun["status"] {
  if (value === "queued" || value === "running" || value === "succeeded" || value === "failed") return value;
  throw new Error("Invalid terminal command run response");
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error("Invalid terminal command run response");
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Invalid terminal command run response");
  return value;
}

function optionalNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error("Invalid terminal command run response");
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
