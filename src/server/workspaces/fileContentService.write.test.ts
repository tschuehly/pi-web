import { mkdir, readFile, readdir, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_WORKSPACE_FILE_CONTENT_BYTES } from "../../shared/workspaceFiles.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceFile, writeWorkspaceFile, WorkspaceFileConflictError, WorkspaceFileOutcomeUnknownError } from "./fileContentService.js";
import { cleanupTempWorkspaces, createTempWorkspace } from "./fileContentService.testSupport.js";

afterEach(async () => {
  await cleanupTempWorkspaces();
});

describe("writeWorkspaceFile", () => {
  it("writes text content to a new file with normalized paths", async () => {
    const root = await createTempWorkspace();

    const result = await writeWorkspaceFile(root, "./src//hello.ts", Buffer.from("const greeting = 'hello';\n"));

    expect(result).toMatchObject({ path: "src/hello.ts", created: true });
    expect(result.size).toBe(26);
    expect(Date.parse(result.modifiedAt)).not.toBeNaN();

    // Verify the file was actually written
    const content = await readFile(join(root, "src", "hello.ts"), "utf8");
    expect(content).toBe("const greeting = 'hello';\n");
  });

  it("writes binary content without text re-encoding", async () => {
    const root = await createTempWorkspace();
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

    const result = await writeWorkspaceFile(root, "image.png", binaryData);

    expect(result).toMatchObject({ path: "image.png", created: true, size: 6 });
    await expect(readFile(join(root, "image.png"))).resolves.toEqual(binaryData);
  });

  it("overwrites existing files by default", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "notes.txt"), "old content");

    const result = await writeWorkspaceFile(root, "notes.txt", Buffer.from("new content"));

    expect(result).toMatchObject({ path: "notes.txt", created: false, size: 11 });
    const content = await readFile(join(root, "notes.txt"), "utf8");
    expect(content).toBe("new content");
  });

  it("fails closed when the Python 3 save helper is unavailable", async () => {
    const root = await createTempWorkspace();
    vi.stubEnv("PATH", "/nonexistent");
    try {
      await expect(writeWorkspaceFile(root, "notes.md", Buffer.from("mine"))).rejects.toThrow("requires Python 3");
      await expect(readFile(join(root, "notes.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("throws when overwrite is false and file exists", async () => {
    const root = await createTempWorkspace();
    await writeFile(join(root, "existing.txt"), "data");

    await expect(writeWorkspaceFile(root, "existing.txt", Buffer.from("new"), { overwrite: false })).rejects.toThrow("File already exists");
  });

  it("preserves an external edit made after validation and before commit", async () => {
    const root = await createTempWorkspace();
    const target = join(root, "notes.md");
    await writeFile(target, "original");
    const version = (await readWorkspaceFile(root, "notes.md")).version;
    if (version === undefined) throw new Error("Expected a file version");

    await expect(writeWorkspaceFile(root, "notes.md", Buffer.from("mine"), { expectedVersion: version }, {
      beforeCommit: async () => { await writeFile(target, "external"); },
    })).rejects.toThrow(WorkspaceFileConflictError);
    await expect(readFile(target, "utf8")).resolves.toBe("external");
  });

  it("also detects external edits for an unversioned overwrite", async () => {
    const root = await createTempWorkspace();
    const target = join(root, "notes.md");
    await writeFile(target, "original");

    await expect(writeWorkspaceFile(root, "notes.md", Buffer.from("mine"), {}, {
      beforeCommit: async () => { await writeFile(target, "external"); },
    })).rejects.toThrow(WorkspaceFileConflictError);
    await expect(readFile(target, "utf8")).resolves.toBe("external");
  });

  it("does not follow a final-component symlink swapped in before commit", async () => {
    const root = await createTempWorkspace();
    const outside = await createTempWorkspace("pi-web-outside-");
    const target = join(root, "notes.md");
    const victim = join(outside, "victim.md");
    await writeFile(target, "original");
    await writeFile(victim, "untouched");
    const version = (await readWorkspaceFile(root, "notes.md")).version;
    if (version === undefined) throw new Error("Expected a file version");

    await expect(writeWorkspaceFile(root, "notes.md", Buffer.from("mine"), { expectedVersion: version }, {
      beforeCommit: async () => { await unlink(target); await symlink(victim, target); },
    })).rejects.toThrow(WorkspaceFileConflictError);
    await expect(readFile(victim, "utf8")).resolves.toBe("untouched");
    await expect(readlink(target)).resolves.toBe(victim);
  });

  it("does not redirect saves or cleanup through an ancestor swapped to an external symlink", async () => {
    const root = await createTempWorkspace();
    const outside = await createTempWorkspace("pi-web-outside-");
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "notes.md"), "original");
    await writeFile(join(outside, "notes.md"), "original");
    const version = (await readWorkspaceFile(root, "dir/notes.md")).version;
    if (version === undefined) throw new Error("Expected a file version");

    await expect(writeWorkspaceFile(root, "dir/notes.md", Buffer.from("mine"), { expectedVersion: version }, {
      beforeCommit: async () => {
        await rename(join(root, "dir"), join(root, "saved-dir"));
        await symlink(outside, join(root, "dir"));
      },
    })).rejects.toThrow(WorkspaceFileConflictError);
    await expect(readFile(join(outside, "notes.md"), "utf8")).resolves.toBe("original");
    expect((await readdir(outside)).sort()).toEqual(["notes.md"]);
  });

  it("does not install through an ancestor swapped after displacement", async () => {
    const root = await createTempWorkspace();
    const outside = await createTempWorkspace("pi-web-outside-");
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "notes.md"), "original");
    await writeFile(join(outside, "notes.md"), "untouched");

    await expect(writeWorkspaceFile(root, "dir/notes.md", Buffer.from("mine"), {}, {
      afterDisplacement: async () => {
        await rename(join(root, "dir"), join(root, "saved-dir"));
        await symlink(outside, join(root, "dir"));
      },
    })).rejects.toThrow(WorkspaceFileConflictError);
    await expect(readFile(join(outside, "notes.md"), "utf8")).resolves.toBe("untouched");
    expect((await readdir(outside)).sort()).toEqual(["notes.md"]);
    await expect(readFile(join(root, "saved-dir", "notes.md"), "utf8")).resolves.toBe("original");
  });

  it("does not create a new file through an ancestor swapped before installation", async () => {
    const root = await createTempWorkspace();
    const outside = await createTempWorkspace("pi-web-outside-");
    await mkdir(join(root, "dir"));

    await expect(writeWorkspaceFile(root, "dir/new.md", Buffer.from("mine"), {}, {
      beforeCommit: async () => {
        await rename(join(root, "dir"), join(root, "saved-dir"));
        await symlink(outside, join(root, "dir"));
      },
    })).rejects.toThrow(WorkspaceFileConflictError);
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(join(root, "saved-dir"))).toEqual([]);
  });

  it("rejects existing files too large to version before attempting a save", async () => {
    const root = await createTempWorkspace();
    const target = join(root, "large.md");
    await writeFile(target, Buffer.alloc(MAX_WORKSPACE_FILE_CONTENT_BYTES + 1, 65));

    await expect(writeWorkspaceFile(root, "large.md", Buffer.from("mine"))).rejects.toThrow(WorkspaceFileConflictError);
    expect((await readFile(target)).length).toBe(MAX_WORKSPACE_FILE_CONTENT_BYTES + 1);
  });

  it("retains a displaced original when an external writer takes the destination after displacement", async () => {
    const root = await createTempWorkspace();
    const target = join(root, "notes.md");
    await writeFile(target, "original");
    const version = (await readWorkspaceFile(root, "notes.md")).version;
    if (version === undefined) throw new Error("Expected a file version");

    await expect(writeWorkspaceFile(root, "notes.md", Buffer.from("mine"), { expectedVersion: version }, {
      afterDisplacement: async () => { await writeFile(target, "external"); },
    })).rejects.toThrow(WorkspaceFileConflictError);
    await expect(readFile(target, "utf8")).resolves.toBe("external");
    const backups = (await readdir(root)).filter((name) => name.startsWith(".pi-web-backup-"));
    expect(backups).toHaveLength(1);
    const backup = backups[0];
    if (backup === undefined) throw new Error("Expected displaced original");
    await expect(readFile(join(root, backup, "original"), "utf8")).resolves.toBe("original");
  });

  it("restores external changes made through an open handle after displacement", async () => {
    const root = await createTempWorkspace();
    const target = join(root, "notes.md");
    await writeFile(target, "original");

    await expect(writeWorkspaceFile(root, "notes.md", Buffer.from("mine"), {}, {
      afterDisplacement: async () => {
        const backup = (await readdir(root)).find((name) => name.startsWith(".pi-web-backup-"));
        if (backup === undefined) throw new Error("Expected displaced entry");
        await writeFile(join(root, backup, "original"), "external");
      },
    })).rejects.toThrow(WorkspaceFileConflictError);
    await expect(readFile(target, "utf8")).resolves.toBe("external");
  });

  it("reports an unknown outcome when validation fails after the new file is installed", async () => {
    const root = await createTempWorkspace();
    const target = join(root, "notes.md");
    await writeFile(target, "original");
    const version = (await readWorkspaceFile(root, "notes.md")).version;
    if (version === undefined) throw new Error("Expected a file version");

    await expect(writeWorkspaceFile(root, "notes.md", Buffer.from("mine"), { expectedVersion: version }, {
      afterInstallation: async () => {
        const backup = (await readdir(root)).find((name) => name.startsWith(".pi-web-backup-"));
        if (backup === undefined) throw new Error("Expected displaced entry");
        await writeFile(join(root, backup, "original"), "external");
      },
    })).rejects.toThrow(WorkspaceFileOutcomeUnknownError);
    await expect(readFile(target, "utf8")).resolves.toBe("mine");
    const backup = (await readdir(root)).find((name) => name.startsWith(".pi-web-backup-"));
    if (backup === undefined) throw new Error("Expected retained backup");
    await expect(readFile(join(root, backup, "original"), "utf8")).resolves.toBe("external");
  });

  it("creates intermediate directories by default", async () => {
    const root = await createTempWorkspace();

    await writeWorkspaceFile(root, "deep/nested/dir/file.txt", Buffer.from("deep content"));

    const content = await readFile(join(root, "deep", "nested", "dir", "file.txt"), "utf8");
    expect(content).toBe("deep content");
  });

  it("fails when createDirs is false and parent directory does not exist", async () => {
    const root = await createTempWorkspace();

    await expect(writeWorkspaceFile(root, "missing/dir/file.txt", Buffer.from("x"), { createDirs: false })).rejects.toThrow();
  });

  it("rejects missing paths, traversal, and absolute paths", async () => {
    const root = await createTempWorkspace();

    await expect(writeWorkspaceFile(root, undefined, Buffer.from("x"))).rejects.toThrow("path query parameter is required");
    await expect(writeWorkspaceFile(root, "../secret.txt", Buffer.from("x"))).rejects.toThrow("Path traversal is not allowed");
    await expect(writeWorkspaceFile(root, "/etc/passwd", Buffer.from("x"))).rejects.toThrow("Absolute paths are not allowed");
  });

  it("rejects writing to a directory path", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "mydir"), { recursive: true });

    await expect(writeWorkspaceFile(root, "mydir", Buffer.from("data"))).rejects.toThrow("Path is not a file");
  });

  it("does not follow an existing final-component symlink", async () => {
    const root = await createTempWorkspace();
    const outside = await createTempWorkspace("pi-web-outside-");
    const victim = join(outside, "victim.md");
    await writeFile(victim, "untouched");
    await symlink(victim, join(root, "notes.md"));

    await expect(writeWorkspaceFile(root, "notes.md", Buffer.from("mine"))).rejects.toThrow(WorkspaceFileConflictError);
    await expect(readFile(victim, "utf8")).resolves.toBe("untouched");
  });

  it("prevents writing through symlinks that escape the workspace", async () => {
    const root = await createTempWorkspace();
    await mkdir(join(root, "subdir"), { recursive: true });
    const outsideDir = await createTempWorkspace("pi-web-outside-");
    await symlink(outsideDir, join(root, "subdir", "escape"), "junction");

    await expect(writeWorkspaceFile(root, "subdir/escape/evil.txt", Buffer.from("evil"))).rejects.toThrow("Path escapes workspace");
    await expect(readFile(join(outsideDir, "evil.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(writeWorkspaceFile(root, "subdir/escape/new/evil.txt", Buffer.from("evil"))).rejects.toThrow("Path escapes workspace");
    await expect(readFile(join(outsideDir, "new", "evil.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
