import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import type { FileTreeEntry, FileTreeResponse, PiWebPathAccessConfig } from "../../shared/apiTypes.js";
import { WORKSPACE_SEARCH_CURSOR } from "../../shared/workspaceFiles.js";
import { sanitizedGitEnv } from "../git/gitEnv.js";
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

// Cursor counts visited entries in breadth-first order: nonignored paths first,
// then ignored paths. Empty pages are possible; each page re-traverses the tree.
// Filesystem or ignore-rule changes between pages can shift offsets.
// ponytail: offset paging retraverses earlier entries; use a snapshot only if late pages become too slow.
export async function searchWorkspaceFiles(rootPath: string, query: string, cursor = "", signal?: AbortSignal): Promise<{ paths: string[]; cursor: string | null }> {
  if (typeof query !== "string" || typeof cursor !== "string" || query.length > 256 || cursor.length > 10 || cursor !== "" && !WORKSPACE_SEARCH_CURSOR.test(cursor)) throw new Error("Invalid file search query");
  const { root } = await resolveWorkspacePathAccessTarget(rootPath, "");
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Safe workspace search is unavailable on this platform");
  let stdout: string;
  try {
    ({ stdout } = await run("python3", ["-c", searchFromDescriptor, root, "", query, cursor], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000, signal, env: sanitizedGitEnv() }));
  } catch (error) {
    if (signal?.aborted === true) throw new Error("Workspace search cancelled", { cause: error });
    // execFile errors include the command (and absolute root); never send them to the client.
    throw new Error("Workspace search unavailable", { cause: error });
  }
  const result: unknown = JSON.parse(stdout);
  if (typeof result === "object" && result !== null && "stale" in result && result.stale === true) throw new Error("Workspace search order changed; enter the query again.");
  if (typeof result !== "object" || result === null || !("paths" in result) || !Array.isArray(result.paths)
    || result.paths.length > 100 || !result.paths.every((path: unknown) => typeof path === "string")
    || !("cursor" in result) || result.cursor !== null && typeof result.cursor !== "string") throw new Error("Invalid workspace search response");
  return { paths: result.paths.map((path: unknown) => {
    if (typeof path !== "string") throw new Error("Invalid workspace search path");
    return path;
  }), cursor: result.cursor };
}

export const searchFromDescriptor = `${openDirectoryFromDescriptor}
import json, subprocess
from collections import deque
query = sys.argv[3].casefold()
offset = int(sys.argv[4][1:] or 0)
paths = []
seen = scanned = 0
normal = deque([''])
ignored = deque()
# Git ignore rules affect ordering only. Query once per page, not once per directory.
def ignored_directories():
    try:
        result = subprocess.run(['git', '-C', sys.argv[1], 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
        if result.returncode == 0: return set(os.fsdecode(path) for path in result.stdout.split(b'\\0') if path.endswith(b'/')), 'g'
    except (OSError, subprocess.TimeoutExpired): pass
    return set(), 'n'

def open_child_directory(prefix):
    directory = os.dup(fd)
    try:
        for part in prefix.split('/'):
            if not part: continue
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except OSError:
        os.close(directory)
        return None

try:
    ignored_paths, mode = ignored_directories()
    if sys.argv[4] and sys.argv[4][0] != mode:
        print(json.dumps({'stale': True}))
    else:
        more = False
        while normal or ignored:
            in_ignored = not normal
            prefix = (ignored if in_ignored else normal).popleft()
            directory = open_child_directory(prefix)
            if directory is None: continue  # disappeared, locked, or swapped for a symlink
            try:
                try:
                    with os.scandir(directory) as iterator: entries = sorted(iterator, key=lambda entry: entry.name)
                except OSError: continue
                children = []
                for entry in entries:
                    path = prefix + entry.name
                    try:
                        is_file = entry.is_file(follow_symlinks=False)
                        is_dir = entry.is_dir(follow_symlinks=False)
                    except OSError: continue
                    if seen >= offset and (scanned >= 10000 or len(paths) >= 100):
                        more = True
                        break
                    seen += 1
                    if seen > offset:
                        scanned += 1
                        if is_file and query in path.casefold(): paths.append(path)
                    if is_dir: children.append(path + '/')
                if more: break
                for child in children:
                    (ignored if in_ignored or child in ignored_paths or child.split('/')[-2] in ('.git', 'node_modules') else normal).append(child)
            finally:
                os.close(directory)
            # Return useful nonignored results without scanning a huge ignored subtree.
            if not in_ignored and not normal and ignored and paths and seen > offset:
                more = True
                break
        print(json.dumps({'paths': paths, 'cursor': mode + str(seen) if more else None}))
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
