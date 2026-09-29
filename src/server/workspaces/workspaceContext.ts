import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, parse } from "node:path";
import { AD_HOC_FOLDER_PROJECT_ID, adHocFolderPath } from "../../shared/workspaceFiles.js";
import type { ProjectService } from "../projects/projectService.js";
import type { Project, WorkspaceListing } from "../types.js";
import type { WorkspaceCatalog } from "./workspaceCatalog.js";
import { WorkspaceAccessError } from "./workspaceRouteErrors.js";

export interface WorkspaceContext {
  /** Undefined for an ad-hoc folder, which has no project config or extra path access. */
  project: Project | undefined;
  workspace: WorkspaceListing;
  root: string;
}

/** Cwds of the existing Pi sessions whose recorded cwd is exactly `cwd`. */
export type SessionCwdLookup = (cwd: string) => Promise<readonly string[]>;

export async function resolveWorkspaceContext(
  projects: ProjectService,
  workspaces: WorkspaceCatalog,
  projectId: string,
  workspaceId: string,
  sessionCwds?: SessionCwdLookup,
): Promise<WorkspaceContext> {
  if (projectId === AD_HOC_FOLDER_PROJECT_ID && sessionCwds !== undefined) {
    const workspace = await resolveAdHocFolder(workspaceId, sessionCwds);
    return { project: undefined, workspace, root: workspace.path };
  }
  const project = await projects.requireProject(projectId);
  const workspace = await workspaces.resolve(project.id, workspaceId);
  return { project, workspace, root: workspace.path };
}

/**
 * Grant a folder outside every registered project only when its canonical path
 * is exactly the cwd of an existing Pi session: never a parent or prefix, never
 * a client-supplied list. The filesystem root and home directory are refused
 * outright because they would expose everything beneath them.
 */
async function resolveAdHocFolder(workspaceId: string, sessionCwds: SessionCwdLookup, home = homedir()): Promise<WorkspaceListing> {
  const requested = adHocFolderPath(workspaceId);
  if (requested === undefined || !isAbsolute(requested)) throw new WorkspaceAccessError("Folder workspace id must be folder:<absolute path>", 404);
  const denied = new WorkspaceAccessError(`Folder ${requested} is not the working directory of a Pi session`, 403);
  const root = await realpath(requested).catch(() => { throw denied; });
  if (!(await stat(root)).isDirectory()) throw denied;
  if (root === parse(root).root || root === await realpath(home).catch(() => home)) {
    throw new WorkspaceAccessError(`Folder ${root} is too broad to browse; add it as a project instead`, 403);
  }
  if (!(await sessionCwds(root)).includes(root)) throw denied;
  return { id: workspaceId, projectId: "", path: root, label: basename(root), isMain: false };
}
