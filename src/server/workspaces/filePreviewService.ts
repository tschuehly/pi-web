import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pipeline, Readable, Transform } from "node:stream";
import type { PiWebPathAccessConfig } from "../../shared/apiTypes.js";
import { classifyWorkspaceFile, MAX_INLINE_PREVIEW_BYTES, MAX_INLINE_PREVIEW_LABEL, workspaceFileName, type WorkspaceFileClassification } from "../../shared/workspaceFiles.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

export interface WorkspaceFilePreview {
  path: string;
  filename: string;
  mediaType?: WorkspaceFileClassification["mediaType"];
  /** Byte count of `body`, safe to advertise as `Content-Length`. */
  size: number;
  /** Set when `body` is the requested byte range of a `total`-byte file (HTTP 206). */
  range?: ByteRange & { total: number };
  modifiedAt: string;
  /**
   * Bytes taken from the descriptor that was validated: an exact snapshot for
   * inline previews, a size-bound stream for downloads.
   */
  body: Buffer | Readable;
}

export interface ReadWorkspaceFilePreviewOptions {
  download?: boolean;
  /** One-request image preview, including paths outside configured roots. Never grants download access. */
  explicitlyRequestedImage?: boolean;
  /** Raw HTTP `Range` request header. WebKit only plays and seeks video served by range. */
  range?: string;
}

/** Inclusive byte offsets. */
export interface ByteRange {
  start: number;
  end: number;
}

/** A `Range` that no byte of the file satisfies; answer 416 with `Content-Range: bytes *\/total`. */
export class RangeNotSatisfiableError extends Error {
  constructor(readonly total: number) {
    super("Requested range is not satisfiable");
  }
}

/**
 * The single byte range a `Range` header asks for, per RFC 9110 §14.1.2.
 * Undefined means "serve the whole file": no header, another unit, malformed
 * syntax, or several ranges (which a server may answer in full).
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | undefined {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) throw new RangeNotSatisfiableError(size);
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return undefined;
  if (start >= size) throw new RangeNotSatisfiableError(size);
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
}

export async function readWorkspaceFilePreview(
  rootPath: string,
  path: string | undefined,
  pathAccess?: PiWebPathAccessConfig,
  options: ReadWorkspaceFilePreviewOptions = {},
): Promise<WorkspaceFilePreview> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const explicitImage = options.explicitlyRequestedImage === true;
  if (explicitImage && options.download === true) throw new Error("Explicit image previews cannot be downloaded");
  const { target, displayPath } = explicitImage
    ? await resolveExplicitImageTarget(rootPath, path)
    : await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  if (explicitImage && classifyWorkspaceFile(displayPath)?.mediaType !== "image") {
    throw new Error("Explicit image preview requires an image file");
  }
  // Reject devices/directories before opening, and use nonblocking mode so a
  // regular file replaced by a FIFO cannot hang before descriptor validation.
  if (!(await stat(target)).isFile()) throw new Error("Path is not a file");

  // Serve only from this descriptor. Path resolution is a snapshot: a rename,
  // symlink swap, or resize after validation must not be able to change which
  // bytes this response carries, how many of them it carries, or whether they
  // are still inside the workspace or an allowed root.
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  let streamOwnsHandle = false;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Path is not a file");
    const metadata = { path: displayPath, filename: workspaceFileName(displayPath), modifiedAt: stats.mtime.toISOString() };

    // Download mode serves any file as an opaque octet-stream attachment. No
    // size cap: the response is streamed, and the browser writes it straight to
    // disk. The stream still cannot exceed the validated size.
    const classification = options.download === true ? undefined : classifyWorkspaceFile(displayPath);
    if (options.download !== true) {
      if (classification === undefined || !("previewMimeType" in classification)) throw new Error("Inline preview is not supported for this file type");
      if (classification.mediaType !== "video" && stats.size > MAX_INLINE_PREVIEW_BYTES) throw new Error(`File is too large to preview (limit ${MAX_INLINE_PREVIEW_LABEL})`);
    }
    const media = classification === undefined ? {} : { mediaType: classification.mediaType };
    const requested = parseByteRange(options.range, stats.size);
    const { start, end } = requested ?? { start: 0, end: stats.size - 1 };
    const range = requested === undefined ? {} : { range: { ...requested, total: stats.size } };
    const size = end - start + 1;

    // Images, HTML and PDF are capped and served as an exact snapshot. Downloads
    // and videos are uncapped and streamed, but never past the validated size.
    if (classification !== undefined && classification.mediaType !== "video") {
      const body = (await readValidatedSnapshot(handle, stats.size)).subarray(start, end + 1);
      return { ...metadata, ...media, ...range, size: body.byteLength, body };
    }
    if (size === 0) return { ...metadata, ...media, size: 0, body: Buffer.alloc(0) };
    streamOwnsHandle = true;
    return { ...metadata, ...media, ...range, size, body: validatedFileStream(handle, start, end) };
  } finally {
    if (!streamOwnsHandle) await handle.close();
  }
}

async function resolveExplicitImageTarget(rootPath: string, path: string): Promise<{ target: string; displayPath: string }> {
  const workspaceRoot = await realpath(rootPath);
  if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("Workspace path must be a directory");
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const target = await realpath(resolve(workspaceRoot, expanded));
  // Classify and serve using the canonical filename, not a symlink's extension.
  return { target, displayPath: target };
}

/**
 * Read exactly the validated number of bytes. Growth after validation is
 * ignored, and a file that shrank fails the request before any header is sent
 * instead of desynchronizing the advertised length.
 */
async function readValidatedSnapshot(handle: FileHandle, size: number): Promise<Buffer> {
  if (size === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) throw new Error("File changed while it was being read");
    offset += bytesRead;
  }
  return buffer;
}

/**
 * Stream the validated byte range from the open descriptor. Extra bytes written
 * after validation are never sent, and a short read fails the response instead
 * of silently truncating an advertised `Content-Length`.
 */
function validatedFileStream(handle: FileHandle, start: number, end: number): Readable {
  const size = end - start + 1;
  const source = handle.createReadStream({ start, end, autoClose: true });
  let streamed = 0;
  const exactLength = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      streamed += chunk.byteLength;
      done(null, chunk);
    },
    flush(done) {
      done(streamed === size ? null : new Error("File changed while it was being read"));
    },
  });
  // The callback keeps a teardown failure from becoming an unhandled error; the
  // returned stream still emits it, which fails the in-flight response.
  return pipeline(source, exactLength, () => { /* surfaced on the returned stream */ });
}
