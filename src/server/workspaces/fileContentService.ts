import { isUtf8 } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { DeleteWorkspaceFileResponse, FileContentMediaType, FileContentResponse, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, PiWebPathAccessConfig, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse } from "../../shared/apiTypes.js";
import { classifyWorkspaceFile, MAX_WORKSPACE_FILE_CONTENT_BYTES, type WorkspaceFileClassification } from "../../shared/workspaceFiles.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";
import { openDirectoryFromDescriptor, relativeToGrantedRoot } from "./fileTreeService.js";
import { ensureInside, isNodeErrorWithCode, resolveInsideWorkspace, resolveParentInsideWorkspace } from "./pathSafety.js";

export async function readWorkspaceFile(rootPath: string, path: string | undefined, pathAccess?: PiWebPathAccessConfig): Promise<FileContentResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { root, target, displayPath } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Safe workspace reads are unavailable on this platform");
  // Walk the canonical parent using pinned directory descriptors, then open
  // the leaf without following symlinks. No path lookup after the final open.
  const { stdout } = await promisify(execFile)("python3", ["-c", readFromDescriptor, root, relativeToGrantedRoot(root, dirname(target)), basename(target)], {
    maxBuffer: Math.ceil(MAX_WORKSPACE_FILE_CONTENT_BYTES * 4 / 3) + 4096,
  });
  const result: unknown = JSON.parse(stdout);
  if (!isReadResult(result)) throw new Error("Invalid workspace file helper response");
  if ("error" in result) throw new Error(result.error);
  const s = result;
  const buffer = Buffer.from(s.content, "base64");
  if (buffer.length !== Math.min(s.size, MAX_WORKSPACE_FILE_CONTENT_BYTES)) throw new Error("Incomplete workspace file read");
  const classification = classifyWorkspaceFile(displayPath);
  const media = mediaForClassification(classification);
  // Text-source formats (HTML, Markdown, SVG) retain capped literal UTF-8
  // source for Raw mode. Raster image and PDF bytes stay out of JSON and are
  // served only by the preview response.
  const binary = classification?.source === "stream" || isProbablyBinary(buffer)
    || (s.size <= MAX_WORKSPACE_FILE_CONTENT_BYTES && !isUtf8(buffer));
  return {
    path: displayPath,
    ...languageForPath(displayPath),
    ...media,
    encoding: "utf8",
    size: s.size,
    modifiedAt: new Date(s.mtime).toISOString(),
    ...(s.size <= MAX_WORKSPACE_FILE_CONTENT_BYTES ? { version: fileVersion(buffer) } : {}),
    content: binary ? "" : buffer.toString("utf8"),
    truncated: s.size > MAX_WORKSPACE_FILE_CONTENT_BYTES,
    binary,
  };
}

const readFromDescriptor = `${openDirectoryFromDescriptor}
import base64, json, stat
try:
    leaf = os.open(sys.argv[3], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(leaf)
        if not stat.S_ISREG(info.st_mode):
            print(json.dumps({'error': 'Path is not a file'}))
        else:
            remaining = min(info.st_size, ${String(MAX_WORKSPACE_FILE_CONTENT_BYTES)})
            chunks = []
            while remaining:
                chunk = os.read(leaf, remaining)
                if not chunk: raise OSError('Incomplete workspace file read')
                chunks.append(chunk)
                remaining -= len(chunk)
            print(json.dumps({'size': info.st_size, 'mtime': info.st_mtime * 1000, 'content': base64.b64encode(b''.join(chunks)).decode('ascii')}))
    finally:
        os.close(leaf)
finally:
    os.close(fd)
`;

function isReadResult(value: unknown): value is { size: number; mtime: number; content: string } | { error: string } {
  if (typeof value !== "object" || value === null) return false;
  if ("error" in value) return value.error === "Path is not a file";
  return "size" in value && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0
    && "mtime" in value && typeof value.mtime === "number" && Number.isFinite(value.mtime)
    && "content" in value && typeof value.content === "string";
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

  if (createDirs) await mkdirInside(root, dirname(dest));

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

/** Creates `dir` only after its deepest existing ancestor resolves inside `root`, so a symlink cannot make it create folders elsewhere. */
async function mkdirInside(root: string, dir: string): Promise<void> {
  let existing = dir;
  for (;;) {
    try {
      ensureInside(root, await realpath(existing));
      break;
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, "ENOENT") || existing === root) throw error;
      existing = dirname(existing);
    }
  }
  await mkdir(dir, { recursive: true });
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13);
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
