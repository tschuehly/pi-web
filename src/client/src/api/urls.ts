import type { SessionRef } from "../../../shared/apiTypes";
import { AD_HOC_FOLDER_PROJECT_ID } from "../../../shared/workspaceFiles";
import { SESSION_MEDIA_MODE } from "../../../shared/sessionMedia";
import { resolveAppUrl } from "../appUrl";

type SessionLookup = SessionRef | string;

function sessionId(session: SessionLookup): string {
  return typeof session === "string" ? session : session.id;
}

function sessionCwd(session: SessionLookup): string | undefined {
  return typeof session === "string" ? undefined : session.cwd;
}

function referenceSessionPath(session: SessionLookup, endpoint: string, options: { limit?: number; before?: number } | undefined, machineId: string): string {
  const params = new URLSearchParams();
  const cwd = sessionCwd(session);
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.before !== undefined) params.set("before", String(options.before));
  params.set("media", SESSION_MEDIA_MODE);
  return `api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(sessionId(session))}/${endpoint}?${params.toString()}`;
}

export function messagePath(session: SessionLookup, options?: { limit?: number; before?: number }, machineId = "local"): string {
  return referenceSessionPath(session, "messages", options, machineId);
}

export function transcriptSnapshotPath(session: SessionRef, options?: { limit?: number }, machineId = "local"): string {
  return referenceSessionPath(session, "transcript-snapshot", options, machineId);
}

export function streamSnapshotPath(session: SessionRef, machineId = "local"): string {
  return referenceSessionPath(session, "stream-snapshot", undefined, machineId);
}

export function sessionEventsPath(session: SessionRef, machineId = "local"): string {
  return referenceSessionPath(session, "events", undefined, machineId);
}

export function sessionMediaPath(session: SessionRef, mediaId: string, machineId = "local"): string {
  const params = new URLSearchParams({ cwd: session.cwd });
  return `api/machines/${encodeURIComponent(machineId)}/sessions/${encodeURIComponent(session.id)}/media/${encodeURIComponent(mediaId)}?${params.toString()}`;
}

/** Browser-ready URL for native image loading, always through the selected machine proxy. */
export function sessionMediaUrl(session: SessionRef, mediaId: string, machineId = "local"): string {
  return resolveAppUrl(sessionMediaPath(session, mediaId, machineId));
}

/** Base of the workspace file routes; an ad-hoc folder (empty project id) uses the server's folder project segment. */
export function workspaceFilesPath(machineId: string, projectId: string, workspaceId: string): string {
  return `api/machines/${encodeURIComponent(machineId)}/projects/${encodeURIComponent(projectId === "" ? AD_HOC_FOLDER_PROJECT_ID : projectId)}/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function workspaceFileWriteUrl(projectId: string, workspaceId: string, path: string, options?: { createDirs?: boolean; overwrite?: boolean; machineId?: string }): string {
  const params = new URLSearchParams({ path });
  if (options?.createDirs === false) params.set("createDirs", "false");
  if (options?.overwrite === false) params.set("overwrite", "false");
  return resolveAppUrl(`${workspaceFilesPath(options?.machineId ?? "local", projectId, workspaceId)}/file?${params.toString()}`);
}

export interface WorkspaceFilePreviewUrlOptions {
  modifiedAt?: string;
  machineId?: string;
  download?: boolean;
  /** Explicit user request to display a local image outside the workspace. */
  showImage?: boolean;
}

export function workspaceFilePreviewPath(projectId: string, workspaceId: string, path: string, options?: WorkspaceFilePreviewUrlOptions): string {
  const params = new URLSearchParams();
  params.set("path", path);
  if (options?.modifiedAt !== undefined) params.set("v", options.modifiedAt);
  if (options?.download === true) params.set("download", "1");
  if (options?.showImage === true) params.set("showImage", "1");
  return `${workspaceFilesPath(options?.machineId ?? "local", projectId, workspaceId)}/file/preview?${params.toString()}`;
}

export function workspaceFilePreviewUrl(projectId: string, workspaceId: string, path: string, options?: WorkspaceFilePreviewUrlOptions): string {
  return resolveAppUrl(workspaceFilePreviewPath(projectId, workspaceId, path, options));
}
