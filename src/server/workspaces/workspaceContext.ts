import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
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

/**
 * Resolves a registered project's workspace, or with `folders` an ad-hoc
 * `folder:<absolute directory>` workspace. A registered project always wins,
 * even one persisted with the reserved `folder` ID; a folder id it does not
 * list still resolves as an ad-hoc folder.
 */
export async function resolveWorkspaceContext(
  projects: ProjectService,
  workspaces: WorkspaceCatalog,
  projectId: string,
  workspaceId: string,
  folders = false,
): Promise<WorkspaceContext> {
  const adHoc = folders && projectId === AD_HOC_FOLDER_PROJECT_ID;
  const project = await projects.requireProject(projectId).catch((error: unknown) => {
    if (adHoc) return undefined;
    throw error;
  });
  if (project !== undefined) {
    try {
      const workspace = await workspaces.resolve(project.id, workspaceId);
      return { project, workspace, root: workspace.path };
    } catch (error) {
      if (!adHoc || adHocFolderPath(workspaceId) === undefined) throw error;
    }
  }
  const workspace = await resolveAdHocFolder(workspaceId);
  return { project: undefined, workspace, root: workspace.path };
}

/**
 * Any existing directory may be opened: only the owner's browser reaches PI WEB
 * (see requestSourceGuard) and Pi sessions can already read and write any file.
 */
async function resolveAdHocFolder(workspaceId: string): Promise<WorkspaceListing> {
  const requested = adHocFolderPath(workspaceId);
  if (requested === undefined || !isAbsolute(requested)) throw new WorkspaceAccessError("Folder workspace id must be folder:<absolute path>", 404);
  const missing = new WorkspaceAccessError(`Folder ${requested} is not an existing directory`, 404);
  const root = await realpath(requested).catch(() => { throw missing; });
  if (!(await stat(root)).isDirectory()) throw missing;
  return { id: workspaceId, projectId: "", path: root, label: basename(root), isMain: false };
}
