import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readlink, realpath, rename, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
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

const activeWrites = new Map<string, Promise<void>>();

export async function writeWorkspaceFile(rootPath: string, path: string | undefined, content: Buffer, options: WriteWorkspaceFileOptions = {}, hooks?: { beforeCommit?: () => Promise<void>; afterDisplacement?: () => Promise<void> }): Promise<WriteWorkspaceFileResponse> {
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

async function writeWorkspaceFileUnlocked(rootPath: string, path: string, content: Buffer, options: WriteWorkspaceFileOptions, hooks?: { beforeCommit?: () => Promise<void>; afterDisplacement?: () => Promise<void> }): Promise<WriteWorkspaceFileResponse> {
  const { root, target, relativePath } = await resolveParentInsideWorkspace(rootPath, path);
  let parent = root;
  if (options.createDirs ?? true) {
    // Check each component before creating the next; recursive mkdir could create directories through an escaping symlink.
    for (const part of relative(root, dirname(target)).split(sep).filter((part) => part !== "" && part !== ".")) {
      const next = join(parent, part);
      try { await mkdir(next); } catch (error) { if (!isNodeErrorWithCode(error, "EEXIST")) throw error; }
      parent = await realpath(next);
      ensureInside(root, parent);
    }
  } else {
    parent = await realpath(dirname(target));
    ensureInside(root, parent);
  }
  const destination = join(parent, basename(target));
  ensureInside(root, destination);
  const initial = await snapshotForWrite(destination);
  if (initial !== undefined && options.overwrite === false) throw new Error(`File already exists: ${relativePath}`);
  if (options.expectedVersion !== undefined && options.overwrite !== true && initial?.version !== options.expectedVersion) {
    throw new WorkspaceFileConflictError("File changed or was deleted since it was loaded");
  }

  const temp = join(parent, `.pi-web-write-${randomUUID()}`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, initial?.mode ?? 0o666);
  let backupDir: string | undefined;
  try {
    if (initial !== undefined) await handle.chmod(initial.mode);
    await handle.writeFile(content);
    const written = await handle.stat();
    await handle.close();
    await hooks?.beforeCommit?.();

    if (initial !== undefined) {
      backupDir = await mkdtemp(join(parent, ".pi-web-backup-"));
      const backup = join(backupDir, "original");
      try {
        await rename(destination, backup);
      } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) throw new WorkspaceFileConflictError("File changed or was deleted since it was loaded");
        throw error;
      }
      try {
        await hooks?.afterDisplacement?.();
        const moved = await snapshotForWrite(backup);
        if (moved?.dev !== initial.dev || moved.ino !== initial.ino || moved.version !== initial.version) {
          throw new WorkspaceFileConflictError("File changed or was deleted since it was loaded");
        }
        await link(temp, destination); // EEXIST leaves any external replacement untouched.
        const afterInstall = await snapshotForWrite(backup);
        if (afterInstall?.version !== initial.version) {
          throw new WorkspaceFileConflictError(`File changed after installation; displaced entry retained at ${backup}`);
        }
      } catch (error) {
        try {
          // macOS link() follows a symlink source; restore symlinks by their literal target instead.
          if ((await lstat(backup)).isSymbolicLink()) await symlink(await readlink(backup), destination);
          else await link(backup, destination); // Exclusive: never replace an external entry.
          await unlink(backup);
        } catch (restoreError) {
          throw new WorkspaceFileConflictError(`File changed; displaced entry retained at ${backup}: ${String(restoreError)}`, { cause: error });
        }
        if (isNodeErrorWithCode(error, "EEXIST")) throw new WorkspaceFileConflictError("File changed or was deleted since it was loaded");
        throw error;
      }
      await unlink(backup);
    } else {
      try { await link(temp, destination); }
      catch (error) {
        if (isNodeErrorWithCode(error, "EEXIST")) throw new WorkspaceFileConflictError("File changed or was deleted since it was loaded");
        throw error;
      }
    }
    return { path: relativePath, size: written.size, modifiedAt: written.mtime.toISOString(), created: !initial };
  } finally {
    await handle.close();
    await unlink(temp);
    if (backupDir !== undefined) {
      // A conflict can retain the displaced entry here; never delete it during cleanup.
      await rmdir(backupDir).catch((error: unknown) => {
        if (!isNodeErrorWithCode(error, "ENOTEMPTY")) return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        return undefined;
      });
    }
  }
}

async function snapshotForWrite(path: string): Promise<{ version: string; dev: number; ino: number; mode: number } | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return undefined;
    if (isNodeErrorWithCode(error, "ELOOP")) throw new WorkspaceFileConflictError("File changed or is a symlink");
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Path is not a file");
    const version = fileVersion(await handle.readFile());
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new WorkspaceFileConflictError("File changed or was deleted since it was loaded");
    }
    return { version, dev: after.dev, ino: after.ino, mode: after.mode & 0o777 };
  } finally {
    await handle.close();
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
