import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import type { FileTreeEntry, FileTreeResponse, PiWebPathAccessConfig } from "../../shared/apiTypes.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

const MAX_ENTRIES = 1000;
const run = promisify(execFile);

// Node's opendir/readdir cannot operate on a pinned directory fd. Walk the
// canonical policy root without symlinks, then stay beneath its descriptor.
// Python 3 is already required for workspace writes; missing Python fails closed.
export const openDirectoryFromDescriptor = `
import os, sys
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NONBLOCK)
for part in sys.argv[1].split('/'):
    if not part: continue
    next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    os.close(fd)
    fd = next_fd
for part in sys.argv[2].split('/'):
    if not part: continue
    if part in ('.', '..'): raise ValueError('Path escapes granted root')
    next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    os.close(fd)
    fd = next_fd
`;

export function relativeToGrantedRoot(root: string, target: string): string {
  const part = relative(root, target);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("Path escapes granted root");
  return part;
}

export const listFromDescriptor = `${openDirectoryFromDescriptor}
import json, stat
try:
    rows = []
    for entry in os.scandir(fd):
        try: info = entry.stat(follow_symlinks=False)
        except FileNotFoundError: continue
        rows.append([entry.name, stat.S_ISDIR(info.st_mode), stat.S_ISLNK(info.st_mode), info.st_size, info.st_mtime * 1000])
        if len(rows) > ${String(MAX_ENTRIES)}: break
    print(json.dumps(rows))
finally:
    os.close(fd)
`;

export async function listWorkspaceTree(rootPath: string, path: string | undefined, pathAccess?: PiWebPathAccessConfig): Promise<FileTreeResponse> {
  const { root, target, displayPath } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Safe workspace listing is unavailable on this platform");
  let stdout: string;
  try {
    ({ stdout } = await run("python3", ["-c", listFromDescriptor, root, relativeToGrantedRoot(root, target)], { maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.includes("NotADirectoryError")) throw new Error("Path is not a directory", { cause: error });
    throw error;
  }
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length > MAX_ENTRIES + 1 || !rows.every(isListingRow)) throw new Error("Invalid workspace listing response");
  const sorted = rows.sort((a, b) => {
    if (a[1] !== b[1]) return a[1] ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });
  const selected = sorted.slice(0, MAX_ENTRIES);
  const entries: FileTreeEntry[] = selected.map(([name, directory, symlink, size, mtime]) => ({
    name,
    path: appendRequestPath(displayPath, name),
    type: directory ? "directory" : symlink ? "symlink" : "file",
    size,
    modifiedAt: new Date(mtime).toISOString(),
  }));

  return { path: displayPath, entries, scannedAt: new Date().toISOString(), truncated: sorted.length > selected.length };
}

function isListingRow(value: unknown): value is [string, boolean, boolean, number, number] {
  if (!Array.isArray(value) || value.length !== 5) return false;
  const fields: unknown[] = value;
  return typeof fields[0] === "string" && fields[0] !== "" && !/[\\/\\\\]/.test(fields[0]) && fields[0] !== "." && fields[0] !== ".."
    && typeof fields[1] === "boolean" && typeof fields[2] === "boolean"
    && typeof fields[3] === "number" && Number.isSafeInteger(fields[3]) && fields[3] >= 0
    && typeof fields[4] === "number" && Number.isFinite(fields[4]);
}

function appendRequestPath(base: string, name: string): string {
  if (base === "") return name;
  if (isAbsolute(base) || win32.isAbsolute(base)) return join(base, name);
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${name}`;
  return `${base}/${name}`;
}
