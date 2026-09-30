import type { SessionRef, Workspace } from "../../../shared/apiTypes";

export interface MarkdownWorkspaceContext {
  machineId: string;
  projectId: string;
  workspaceId: string;
  root: string;
  sourcePath?: string;
}

/** Value identity: parents rebuild contexts on every render, which must not re-render the transcript. */
export function workspaceContextKey(context: MarkdownWorkspaceContext | undefined): string {
  return context === undefined ? "" : JSON.stringify([context.machineId, context.projectId, context.workspaceId, context.root, context.sourcePath]);
}

export function workspaceContextChanged(next: MarkdownWorkspaceContext | undefined, previous: MarkdownWorkspaceContext | undefined): boolean {
  return workspaceContextKey(next) !== workspaceContextKey(previous);
}

/** Do not borrow a newly selected workspace while the old session is still rendered. */
export function markdownWorkspaceContext(machineId: string, workspace: Workspace | undefined, session: SessionRef): MarkdownWorkspaceContext | undefined {
  if (workspace === undefined || trimTrailingSlashes(workspace.path) !== trimTrailingSlashes(session.cwd)) return undefined;
  return { machineId, projectId: workspace.projectId, workspaceId: workspace.id, root: workspace.path };
}

export interface WorkspaceFileOpenRequest extends MarkdownWorkspaceContext {
  path: string;
}

/** A Chat file link that leaves the Chat's folder; `path` is absolute on `machineId`. */
export interface OutsideFileOpenRequest {
  machineId: string;
  path: string;
}

/** Classification only: filesystem containment and symlink checks belong to the server. */
export function workspaceMarkdownFilePath(href: string, context: MarkdownWorkspaceContext): string | undefined {
  const decoded = decodedFileReference(href);
  if (decoded === undefined) return undefined;
  let path = decoded;
  const absolute = path.startsWith("/");
  if (context.sourcePath === undefined) {
    const target = chatLinkTarget(path, context.root);
    return target?.startsWith("/") === true ? undefined : target;
  }
  if (absolute) {
    const prefix = `${trimTrailingSlashes(context.root)}/`;
    if (!path.startsWith(prefix)) return undefined;
    path = path.slice(prefix.length);
    if (path === "") return undefined;
  }
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

/** The absolute path of a Chat file link that leaves the Chat's folder (`../x` or `/elsewhere/x`). */
export function outsideChatFilePath(href: string, context: MarkdownWorkspaceContext): string | undefined {
  if (context.sourcePath !== undefined) return undefined;
  const path = decodedFileReference(href);
  const target = path === undefined ? undefined : chatLinkTarget(path, context.root);
  return target?.startsWith("/") === true ? target : undefined;
}

/** A Markdown destination decoded once to a file path, or undefined for URLs, fragments and unsafe characters. */
function decodedFileReference(href: string): string | undefined {
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
  return path === "" || /[\\\u0000-\u001f\u007f]/.test(path) ? undefined : path;
}

/** Relative path for a Chat link inside `root`, the normalized absolute path for one outside it, undefined for `root` itself. */
function chatLinkTarget(path: string, root: string): string | undefined {
  const base = trimTrailingSlashes(root);
  const parts = path.startsWith("/") ? [] : base.split("/").filter((part) => part !== "");
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const absolute = `/${parts.join("/")}`;
  if (absolute === (base === "" ? "/" : base)) return undefined;
  return absolute.startsWith(`${base}/`) ? absolute.slice(base.length + 1) : absolute;
}

function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}
