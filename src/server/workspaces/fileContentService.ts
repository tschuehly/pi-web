import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { DeleteWorkspaceFileResponse, FileContentMediaType, FileContentResponse, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, PiWebPathAccessConfig, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse } from "../../shared/apiTypes.js";
import { classifyWorkspaceFile, MAX_WORKSPACE_FILE_CONTENT_BYTES, type WorkspaceFileClassification } from "../../shared/workspaceFiles.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";
import { ensureInside, isNodeErrorWithCode, resolveInsideWorkspace, resolveParentInsideWorkspace } from "./pathSafety.js";

export async function readWorkspaceFile(rootPath: string, path: string | undefined, pathAccess?: PiWebPathAccessConfig): Promise<FileContentResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { target, displayPath } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Path is not a file");
  const bytesToRead = Math.min(s.size, MAX_WORKSPACE_FILE_CONTENT_BYTES);
  const buffer = await readFilePrefix(target, bytesToRead);
  const classification = classifyWorkspaceFile(displayPath);
  const media = mediaForClassification(classification);
  // Text-source formats (HTML, Markdown, SVG) retain capped literal UTF-8
  // source for Raw mode. Raster image and PDF bytes stay out of JSON and are
  // served only by the preview response.
  const binary = classification?.source === "stream" || (classification === undefined && isProbablyBinary(buffer));
  return {
    path: displayPath,
    ...languageForPath(displayPath),
    ...media,
    encoding: "utf8",
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    ...(s.size <= MAX_WORKSPACE_FILE_CONTENT_BYTES ? { version: fileVersion(buffer) } : {}),
    content: binary ? "" : buffer.toString("utf8"),
    truncated: s.size > MAX_WORKSPACE_FILE_CONTENT_BYTES,
    binary,
  };
}

async function readFilePrefix(target: string, bytesToRead: number): Promise<Buffer> {
  if (bytesToRead === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function fileVersion(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class WorkspaceFileConflictError extends Error {}
export class WorkspaceFileOutcomeUnknownError extends Error {}

interface WriteHelperEvent { kind: string; message?: string; conflict?: boolean; uncertain?: boolean; size?: number; modifiedAt?: number; created?: boolean }

function isWriteHelperEvent(value: unknown): value is WriteHelperEvent {
  if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string") return false;
  if ("message" in value && typeof value.message !== "string") return false;
  if ("conflict" in value && typeof value.conflict !== "boolean") return false;
  if ("uncertain" in value && typeof value.uncertain !== "boolean") return false;
  if ("size" in value && typeof value.size !== "number") return false;
  if ("modifiedAt" in value && typeof value.modifiedAt !== "number") return false;
  if ("created" in value && typeof value.created !== "boolean") return false;
  return true;
}

const activeWrites = new Map<string, Promise<void>>();

export async function writeWorkspaceFile(rootPath: string, path: string | undefined, content: Buffer, options: WriteWorkspaceFileOptions = {}, hooks?: { beforeCommit?: () => Promise<void>; afterDisplacement?: () => Promise<void>; afterInstallation?: () => Promise<void> }): Promise<WriteWorkspaceFileResponse> {
  // The optional hook is only used by deterministic filesystem race tests.
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  // In-process serialization does not coordinate external writers; the filesystem commit below detects changed entries.
  const key = `${rootPath}\0${path}`;
  const previous = activeWrites.get(key);
  let release!: () => void;
  const complete = new Promise<void>((resolve) => { release = resolve; });
  activeWrites.set(key, complete);
  await previous;
  try {
    return await writeWorkspaceFileUnlocked(rootPath, path, content, options, hooks);
  } finally {
    if (activeWrites.get(key) === complete) activeWrites.delete(key);
    release();
  }
}

async function writeWorkspaceFileUnlocked(rootPath: string, path: string, content: Buffer, options: WriteWorkspaceFileOptions, hooks?: { beforeCommit?: () => Promise<void>; afterDisplacement?: () => Promise<void>; afterInstallation?: () => Promise<void> }): Promise<WriteWorkspaceFileResponse> {
  const { root, relativePath } = await resolveParentInsideWorkspace(rootPath, path);
  // Node does not expose openat/linkat/renameat. The helper pins a directory fd
  // and uses *at operations so a swapped ancestor cannot redirect mutations.
  const helper = new URL("../../../scripts/workspace-file-write.py", import.meta.url);
  const child = spawn("python3", [fileURLToPath(helper)], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => { /* Python may reject the request before consuming content. */ });
  const exit = new Promise<number | Error>((resolve) => {
    child.once("error", (error) => { resolve(error); });
    child.once("close", (code) => { resolve(code ?? -1); });
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  child.stdin.write(JSON.stringify({
    root, path: relativePath, size: content.length,
    createDirs: options.createDirs ?? true,
    overwrite: options.overwrite !== false,
    forceOverwrite: options.overwrite === true,
    expectedVersion: options.expectedVersion,
  }) + "\n");
  child.stdin.write(content);
  let result: WriteWorkspaceFileResponse | undefined;
  let failure: Error | undefined;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const event: unknown = JSON.parse(line);
      if (!isWriteHelperEvent(event)) throw new Error("Invalid workspace file helper response");
      if (event.kind === "beforeCommit" || event.kind === "afterDisplacement" || event.kind === "afterInstallation") {
        try { await (event.kind === "beforeCommit" ? hooks?.beforeCommit?.() : event.kind === "afterDisplacement" ? hooks?.afterDisplacement?.() : hooks?.afterInstallation?.()); }
        catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
        child.stdin.write(failure === undefined ? "go\n" : "abort\n");
      } else if (event.kind === "error") {
        failure ??= event.uncertain === true ? new WorkspaceFileOutcomeUnknownError(event.message) : event.conflict === true ? new WorkspaceFileConflictError(event.message) : new Error(event.message);
      } else if (event.kind === "result" && event.size !== undefined && event.modifiedAt !== undefined) {
        result = { path: relativePath, size: event.size, modifiedAt: new Date(event.modifiedAt).toISOString(), created: event.created === true };
      }
    }
    const code = await exit;
    if (failure !== undefined) throw failure;
    if (code instanceof Error) throw new Error(`Workspace file save requires Python 3 on the web/API PATH: ${code.message}`, { cause: code });
    if (code !== 0 || result === undefined) throw new Error(`Workspace file helper failed (${String(code)}): ${stderr || "no response"}`);
    return result;
  } finally {
    child.stdin.end();
  }
}

export async function deleteWorkspaceFile(rootPath: string, path: string | undefined): Promise<DeleteWorkspaceFileResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  // Use resolveParentInsideWorkspace + lstat so that deleting a symlink
  // deletes the symlink itself, not the target it points to.
  // resolveInsideWorkspace would call realpath on the target, following
  // symlinks and resolving the symlink's destination instead.
  const { root, target, relativePath } = await resolveParentInsideWorkspace(rootPath, path);
  try {
    // Resolve symlinks in the parent path to prevent escape via a symlinked
    // parent directory. The final path component is intentionally NOT resolved
    // so that lstat/unlink act on the entry itself (deleting a symlink rather
    // than the file it points to).
    const realParent = await realpath(dirname(target));
    const realTarget = join(realParent, basename(target));
    ensureInside(root, realTarget);
    const s = await lstat(realTarget);
    // Allow deleting regular files and symlinks, but not directories
    if (s.isDirectory()) throw new Error("Path is a directory, use directory deletion instead");
    await unlink(realTarget);
    return { path: relativePath, existed: true };
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) return { path: relativePath, existed: false };
    if (error instanceof Error && error.message === "Path does not exist") return { path: relativePath, existed: false };
    throw error;
  }
}

export async function moveWorkspaceFile(rootPath: string, fromPath: string | undefined, toPath: string | undefined, options: MoveWorkspaceFileOptions = {}): Promise<MoveWorkspaceFileResponse> {
  if (fromPath === undefined || fromPath === "") throw new Error("fromPath query parameter is required");
  if (toPath === undefined || toPath === "") throw new Error("toPath query parameter is required");

  const createDirs = options.createDirs ?? true;
  const overwrite = options.overwrite ?? false;

  // Source: must exist and be a file (uses realpath via resolveInsideWorkspace)
  const { target: source, relativePath: fromRelative } = await resolveInsideWorkspace(rootPath, fromPath);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) throw new Error("Source path is not a file");

  // Target: uses resolveParentInsideWorkspace + realpath(dirname) pattern (same as writeFile)
  const { root, target: dest, relativePath: destRelative } = await resolveParentInsideWorkspace(rootPath, toPath);

  if (createDirs) await mkdir(dirname(dest), { recursive: true });

  // Resolve symlinks in the parent path to prevent escape via symlink
  const realParent = await realpath(dirname(dest));
  const realDest = join(realParent, basename(dest));
  ensureInside(root, realDest);

  if (!overwrite) {
    try {
      const destStat = await stat(realDest);
      if (destStat.isFile()) throw new Error(`File already exists: ${destRelative}`);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) { /* expected — target doesn't exist */ }
      else if (error instanceof Error && error.message.startsWith("File already exists")) throw error;
      else throw error;
    }
  }

  await rename(source, realDest);
  const finalStat = await stat(realDest);
  return { fromPath: fromRelative, toPath: destRelative, size: finalStat.size, modifiedAt: finalStat.mtime.toISOString() };
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function languageForPath(path: string): { language?: string } {
  const ext = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string | undefined> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    markdown: "markdown",
    css: "css",
    htm: "html",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
  };
  const language = ext === undefined ? undefined : languages[ext];
  return language === undefined ? {} : { language };
}

function mediaForClassification(classification: WorkspaceFileClassification | undefined): { mediaType?: FileContentMediaType; mimeType?: string } {
  if (classification === undefined) return {};
  return {
    mediaType: classification.mediaType,
    ...("previewMimeType" in classification ? { mimeType: classification.previewMimeType } : {}),
  };
}
