import { chmod, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizedGitEnv } from "../git/gitEnv.js";
import { listFromDescriptor, listWorkspaceTree, searchFromDescriptor, searchWorkspaceFiles } from "./fileTreeService.js";

const race = vi.hoisted(() => ({ afterResolve: () => Promise.resolve() }));
vi.mock("./pathAccessPolicy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pathAccessPolicy.js")>();
  return {
    ...actual,
    resolveWorkspacePathAccessTarget: async (...args: Parameters<typeof actual.resolveWorkspacePathAccessTarget>) => {
      const result = await actual.resolveWorkspacePathAccessTarget(...args);
      await race.afterResolve();
      return result;
    },
  };
});

const roots: string[] = [];

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-file-tree-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  race.afterResolve = () => Promise.resolve();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("searchWorkspaceFiles", () => {
  it("searches tracked, ignored and untracked paths with continuation, without following symlinks", async () => {
    const root = await tempWorkspace();
    const outside = await tempWorkspace();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "local");
    await writeFile(join(outside, "secret.txt"), "outside");
    await trySymlink(outside, join(root, "outside"));
    for (let i = 0; i < 120; i += 1) await writeFile(join(root, `untracked-${String(i).padStart(3, "0")}.txt`), "text");
    const first = await searchWorkspaceFiles(root, "txt");
    expect(first.paths).toHaveLength(100);
    expect(first.cursor).not.toBeNull();
    const second = await searchWorkspaceFiles(root, "txt", first.cursor ?? "");
    expect(second.paths).toHaveLength(20);
    expect(second.cursor).not.toBeNull(); // .git still remains searchable
    expect((await searchWorkspaceFiles(root, "txt", second.cursor ?? "")).cursor).toBeNull();
    expect([...first.paths, ...second.paths]).toContain("untracked-119.txt");
    expect([...first.paths, ...second.paths]).not.toContain("outside/secret.txt");
    expect((await searchWorkspaceFiles(root, ".git")).paths).toContain(".git/config");
    await expect(searchWorkspaceFiles(root, "a".repeat(257))).rejects.toThrow("Invalid file search query");
    for (const cursor of ["-1", "1.5", "a/file", "01", "1".repeat(11), "x123"]) {
      await expect(searchWorkspaceFiles(root, "", cursor)).rejects.toThrow("Invalid file search query");
    }
  });
  it("does not skip a root sibling whose path sorts before nested descendants at the 100-result boundary", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "a"));
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(root, "a", `file-${String(i).padStart(3, "0")}.txt`), "")));
    await writeFile(join(root, "a.txt"), "");
    const first = await searchWorkspaceFiles(root, "txt");
    expect(first.paths).toHaveLength(100);
    expect(first.paths).toContain("a.txt"); // root entries precede nested files
    expect(first.cursor).toBe("n101");
    const second = await searchWorkspaceFiles(root, "txt", first.cursor ?? "");
    expect(second.cursor).toBeNull();
    expect(second.paths).toHaveLength(1);
    expect(new Set([...first.paths, ...second.paths]).size).toBe(101);
  });

  it("shows src on page one ahead of >10k ignored entries, but still reaches ignored matches", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await writeFile(join(root, "src", "App.ts"), "");
    for (let dir = 0; dir < 101; dir += 1) {
      const folder = join(root, "node_modules", `package-${String(dir).padStart(3, "0")}`);
      await mkdir(folder);
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(folder, `item-${String(i).padStart(3, "0")}.txt`), "")));
    }
    const first = await searchWorkspaceFiles(root, "App.ts");
    expect(first.paths).toContain("src/App.ts");
    const ignored = await searchWorkspaceFiles(root, "item-099.txt");
    expect(ignored.paths.length).toBeGreaterThan(0);
    expect(ignored.cursor).not.toBeNull();
    const second = await searchWorkspaceFiles(root, "item-099.txt", ignored.cursor ?? "");
    expect(second.paths).toContain("node_modules/package-100/item-099.txt");
  }, 60_000);

  it("prioritizes paths outside custom Git ignored directories without excluding them", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await promisify(execFile)("git", ["init", "-q", root], { env: sanitizedGitEnv() });
    await mkdir(join(root, "generated"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "generated", "App.ts"), "");
    await writeFile(join(root, "src", "App.ts"), "");
    const first = await searchWorkspaceFiles(root, "App.ts");
    expect(first.paths).toEqual(["src/App.ts"]);
    expect(first.cursor).not.toBeNull();
    expect((await searchWorkspaceFiles(root, "App.ts", first.cursor ?? "")).paths).toEqual(["generated/App.ts"]);
  });

  it("rejects a later page when Git ordering becomes unavailable", async () => {
    const root = await tempWorkspace();
    await promisify(execFile)("git", ["init", "-q", root], { env: sanitizedGitEnv() });
    await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, "0")}.txt`), "")));
    const first = await searchWorkspaceFiles(root, "txt");
    expect(first.cursor).toMatch(/^g\d+$/u);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nexit 1\n");
    await chmod(join(bin, "git"), 0o755);
    const previous = process.env["PATH"];
    process.env["PATH"] = `${bin}:${previous ?? ""}`;
    try {
      await expect(searchWorkspaceFiles(root, "txt", first.cursor ?? "")).rejects.toThrow("Workspace search order changed");
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
  });

  it("prioritizes source before nested node_modules when Git is unavailable", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "package", "node_modules"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package", "node_modules", "App.ts"), "");
    await writeFile(join(root, "src", "App.ts"), "");
    const first = await searchWorkspaceFiles(root, "App.ts");
    expect(first.paths).toEqual(["src/App.ts"]);
    expect((await searchWorkspaceFiles(root, "App.ts", first.cursor ?? "")).paths).toEqual(["package/node_modules/App.ts"]);
  });

  it("cancels the Python search when its signal is aborted", async () => {
    const root = await tempWorkspace();
    const controller = new AbortController();
    controller.abort();
    await expect(searchWorkspaceFiles(root, "x", "", controller.signal)).rejects.toThrow("Workspace search cancelled");
  });

  it("skips locked and symlink-swapped children while retaining siblings", async () => {
    const root = await tempWorkspace();
    const outside = await tempWorkspace();
    await mkdir(join(root, "locked"));
    await writeFile(join(root, "kept.txt"), "");
    await writeFile(join(outside, "secret.txt"), "");
    // Inject the fault precisely at fd-relative child open, independent of user privileges.
    for (const fault of ["raise PermissionError('locked')", `os.rename('locked', 'moved', src_dir_fd=dir_fd, dst_dir_fd=dir_fd)\n        original_symlink('${outside}', 'locked', dir_fd=dir_fd)`]) {
      const patch = `import os\noriginal_open = os.open\noriginal_symlink = os.symlink\ndef fault_open(path, flags, *args, **kwargs):\n    dir_fd = kwargs.get('dir_fd')\n    if path == 'locked' and dir_fd is not None:\n        ${fault}\n    return original_open(path, flags, *args, **kwargs)\nos.open = fault_open\n`;
      const { stdout } = await promisify(execFile)("python3", ["-c", patch + searchFromDescriptor, await realpath(root), "", "txt", ""]);
      expect(JSON.parse(stdout)).toEqual({ paths: ["kept.txt"], cursor: null });
      await rm(join(root, "locked"), { force: true, recursive: true });
      await rm(join(root, "moved"), { force: true, recursive: true });
      await mkdir(join(root, "locked"));
    }
  });

  it("does not expose the root or Python command when the pinned root disappears", async () => {
    const root = await tempWorkspace();
    const displaced = `${root}-displaced`;
    race.afterResolve = async () => { await rename(root, displaced); };
    try {
      const error = await searchWorkspaceFiles(root, "x").catch((failure: unknown) => failure);
      if (!(error instanceof Error)) throw new Error("Expected a search failure");
      expect(error.message).toBe("Workspace search unavailable");
      expect(error.message).not.toContain(root);
    } finally {
      await rm(displaced, { recursive: true, force: true });
    }
  });
});

describe("listWorkspaceTree", () => {
  it("lists entries with directories first, sorted by name", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "z-dir"));
    await mkdir(join(root, "a-dir"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "a.txt"), "a");
    const createdSymlink = await trySymlink(join(root, "a.txt"), join(root, "link.txt"));

    const tree = await listWorkspaceTree(root, undefined);

    expect(tree.path).toBe("");
    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((entry) => [entry.name, entry.type])).toEqual([
      [".git", "directory"],
      ["a-dir", "directory"],
      ["node_modules", "directory"],
      ["z-dir", "directory"],
      ["a.txt", "file"],
      ["b.txt", "file"],
      ...(createdSymlink ? [["link.txt", "symlink"]] : []),
    ]);
    expect(Date.parse(tree.scannedAt)).not.toBeNaN();
  });

  it("lists nested directories using normalized relative paths", async () => {
    const root = await tempWorkspace();
    await mkdir(join(root, "src", "client"), { recursive: true });
    await writeFile(join(root, "src", "client", "main.ts"), "");

    const tree = await listWorkspaceTree(root, "./src//client");

    expect(tree.path).toBe("src/client");
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]).toMatchObject({ name: "main.ts", path: "src/client/main.ts", type: "file" });
  });

  it("lists allowed absolute directories outside the workspace", async () => {
    const root = await tempWorkspace();
    const external = await tempWorkspace();
    await mkdir(join(external, "docs"));
    await writeFile(join(external, "sdk.ts"), "export {};\n");

    const tree = await listWorkspaceTree(root, external, { allowedPaths: [external] });

    expect(tree.path).toBe(external);
    expect(tree.entries.map((entry) => [entry.name, entry.path, entry.type])).toEqual([
      ["docs", join(external, "docs"), "directory"],
      ["sdk.ts", join(external, "sdk.ts"), "file"],
    ]);
    await expect(listWorkspaceTree(root, external)).rejects.toThrow("Absolute paths are not allowed");
  });

  it("rejects a parent replaced by an outside symlink after resolution", async () => {
    const root = await tempWorkspace();
    const outside = await tempWorkspace();
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "inside.txt"), "inside");
    await writeFile(join(outside, "outside.txt"), "outside");
    race.afterResolve = async () => {
      await rename(join(root, "dir"), join(root, "old-dir"));
      await symlink(outside, join(root, "dir"));
    };
    await expect(listWorkspaceTree(root, "dir")).rejects.toThrow();
  });

  it("rejects a granted workspace root replaced by an outside symlink after resolution", async () => {
    const root = await tempWorkspace();
    const outside = await tempWorkspace();
    const displaced = `${root}-displaced`;
    await writeFile(join(root, "inside.txt"), "inside");
    await writeFile(join(outside, "outside.txt"), "outside");
    race.afterResolve = async () => { await rename(root, displaced); await symlink(outside, root); };
    try { await expect(listWorkspaceTree(root, "")).rejects.toThrow(); }
    finally { await rm(displaced, { recursive: true, force: true }); }
  });

  it("skips an entry deleted between enumeration and stat", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "gone.txt"), "gone");
    await writeFile(join(root, "kept.txt"), "kept");
    // Force deletion between fd-relative enumeration and a DirEntry stat.
    const deleteAfterList = `import os\noriginal_scandir = os.scandir\ndef scan_then_delete(fd):\n    entries = list(original_scandir(fd))\n    os.unlink('gone.txt', dir_fd=fd)\n    return entries\nos.scandir = scan_then_delete\n`;
    const { stdout } = await promisify(execFile)("python3", ["-c", deleteAfterList + listFromDescriptor, await realpath(root), ""]);
    expect(JSON.parse(stdout)).toEqual([expect.arrayContaining(["kept.txt", false, false])]);
  });

  it("bounds enumeration as well as the returned listing", async () => {
    const root = await tempWorkspace();
    for (let i = 0; i < 1003; i += 1) await writeFile(join(root, `file-${String(i)}.txt`), "x");
    const listing = await listWorkspaceTree(root, "");
    expect(listing.entries).toHaveLength(1000);
    expect(listing.truncated).toBe(true);
  });

  it("rejects non-directory targets and unsafe paths", async () => {
    const root = await tempWorkspace();
    await writeFile(join(root, "file.txt"), "content");

    await expect(listWorkspaceTree(root, "file.txt")).rejects.toThrow("Path is not a directory");
    await expect(listWorkspaceTree(root, "missing-dir")).rejects.toThrow("Path does not exist");
    await expect(listWorkspaceTree(root, "../outside")).rejects.toThrow("Path traversal is not allowed");
    await expect(listWorkspaceTree(root, "/tmp")).rejects.toThrow("Absolute paths are not allowed");
  });

  // Writing MAX_ENTRIES + 1 files is inherently I/O-heavy; slow filesystems (notably
  // Windows CI) can exceed Vitest's default 5s timeout, so give this case extra headroom.
  it("marks responses as truncated after the service entry limit", async () => {
    const root = await tempWorkspace();
    await Promise.all(Array.from({ length: 1001 }, (_, index) => writeFile(join(root, `${String(index).padStart(4, "0")}.txt`), "")));

    const tree = await listWorkspaceTree(root, undefined);

    expect(tree.entries).toHaveLength(1000);
    expect(tree.truncated).toBe(true);
  }, 30_000);
});

async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "EPERM")) return false;
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
