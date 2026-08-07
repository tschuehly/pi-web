import type { Project, SessionInfo, Workspace } from "../api";
import type { PluginSessionLocationFailedScope } from "./types";

const DEFAULT_CONCURRENCY = 4;

export interface SessionCatalogTraversalReader {
  projects(machineId: string, signal?: AbortSignal): Promise<Project[]>;
  workspaces(projectId: string, machineId: string, signal?: AbortSignal): Promise<Workspace[]>;
  sessions(cwd: string, machineId: string, signal?: AbortSignal): Promise<SessionInfo[]>;
}

export interface SessionCatalogWorkspaceScope {
  project: Project;
  workspace: Workspace;
  sessions: SessionInfo[];
}

export interface SessionCatalogTraversalResult {
  scopes: SessionCatalogWorkspaceScope[];
  failedScopes: PluginSessionLocationFailedScope[];
}

/** Shared fail-closed traversal used by session location resolution and navigation inventory scans. */
export async function traverseSessionCatalog(
  machineId: string,
  catalog: SessionCatalogTraversalReader,
  options: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<SessionCatalogTraversalResult> {
  const { signal } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  throwIfAborted(signal);

  let projects: Project[];
  try {
    projects = await (signal === undefined ? catalog.projects(machineId) : catalog.projects(machineId, signal));
  } catch {
    throwIfAborted(signal);
    return { scopes: [], failedScopes: [{ type: "machine", machineId }] };
  }

  const workspaceResults = await mapBoundedSettled(projects, concurrency, signal, async (project) => ({
    project,
    workspaces: await (signal === undefined
      ? catalog.workspaces(project.id, machineId)
      : catalog.workspaces(project.id, machineId, signal)),
  }));
  const failedScopes: PluginSessionLocationFailedScope[] = [];
  const workspaceScopes: { project: Project; workspace: Workspace }[] = [];
  workspaceResults.forEach((result, index) => {
    const project = projects[index];
    if (project === undefined) return;
    if (result.status === "rejected") {
      failedScopes.push({ type: "project", machineId, projectId: project.id });
      return;
    }
    for (const workspace of result.value.workspaces) workspaceScopes.push({ project, workspace });
  });

  const sessionResults = await mapBoundedSettled(workspaceScopes, concurrency, signal, async (scope) => ({
    ...scope,
    sessions: await (signal === undefined
      ? catalog.sessions(scope.workspace.path, machineId)
      : catalog.sessions(scope.workspace.path, machineId, signal)),
  }));
  const scopes: SessionCatalogWorkspaceScope[] = [];
  sessionResults.forEach((result, index) => {
    const scope = workspaceScopes[index];
    if (scope === undefined) return;
    if (result.status === "rejected") {
      failedScopes.push({
        type: "workspace",
        machineId,
        projectId: scope.project.id,
        workspaceId: scope.workspace.id,
        cwd: scope.workspace.path,
      });
      return;
    }
    scopes.push(result.value);
  });
  throwIfAborted(signal);
  return { scopes, failedScopes };
}

async function mapBoundedSettled<T, R>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  operation: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      throwIfAborted(signal);
      const index = nextIndex++;
      const value = values[index];
      if (value === undefined) return;
      try {
        results[index] = { status: "fulfilled", value: await operation(value) };
      } catch (reason) {
        throwIfAborted(signal);
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  throwIfAborted(signal);
  return results;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException("Session catalog traversal was cancelled.", "AbortError");
}
