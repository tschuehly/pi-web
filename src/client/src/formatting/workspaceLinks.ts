import type { SessionRef, Workspace } from "../../../shared/apiTypes";

export interface MarkdownWorkspaceContext {
  machineId: string;
  projectId: string;
  workspaceId: string;
  root: string;
  sourcePath?: string;
}

/** Do not borrow a newly selected workspace while the old session is still rendered. */
export function markdownWorkspaceContext(machineId: string, workspace: Workspace | undefined, session: SessionRef): MarkdownWorkspaceContext | undefined {
  if (workspace === undefined || trimTrailingSlashes(workspace.path) !== trimTrailingSlashes(session.cwd)) return undefined;
  return { machineId, projectId: workspace.projectId, workspaceId: workspace.id, root: workspace.path };
}

export interface WorkspaceFileOpenRequest extends MarkdownWorkspaceContext {
  path: string;
}

/** Classification only: filesystem containment and symlink checks belong to the server. */
export function workspaceMarkdownFilePath(href: string, context: MarkdownWorkspaceContext): string | undefined {
  const reference = href.trim();
  if (reference === "" || /^[#?]/.test(reference) || reference.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(reference)) return undefined;
  // Markdown destinations are URL references. Decode the path once, after removing URL suffixes.
  let path: string;
  try {
    path = decodeURIComponent(reference.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return undefined;
  }
  // Reject URL paths containing control characters or platform-specific separators.
  // eslint-disable-next-line no-control-regex -- Explicitly reject control characters in file references.
  if (path === "" || /[\\\u0000-\u001f\u007f]/.test(path)) return undefined;
  const absolute = path.startsWith("/");
  if (absolute) {
    const prefix = `${trimTrailingSlashes(context.root)}/`;
    if (!path.startsWith(prefix)) return undefined;
    path = path.slice(prefix.length);
    if (path === "") return undefined;
  }
  if (context.sourcePath !== undefined) {
    const parts = absolute ? [] : context.sourcePath.split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) return undefined;
        parts.pop();
      } else parts.push(part);
    }
    return parts.length === 0 ? undefined : parts.join("/");
  }
  // Chat links retain their existing server-validated traversal behavior.
  const normalized = path.split("/").filter((part) => part !== "" && part !== ".").join("/");
  return normalized === "" ? undefined : normalized;
}

function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}
