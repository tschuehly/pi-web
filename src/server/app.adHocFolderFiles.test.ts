import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AD_HOC_FOLDER_PROJECT_ID, adHocFolderWorkspaceId } from "../shared/workspaceFiles.js";
import type { FileContentResponse, FileTreeResponse } from "../shared/apiTypes.js";
import type { Project, WorkspaceProviderResolution } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

const folderUrl = (folder: string, route: string, prefix = "/api"): string =>
  `${prefix}/projects/${AD_HOC_FOLDER_PROJECT_ID}/workspaces/${encodeURIComponent(adHocFolderWorkspaceId(folder))}/${route}`;

/** A real-world shaped Chat folder: longer than Fastify's default 100-character parameter limit and inside a dot directory. */
async function longScratchFolder(): Promise<string> {
  const folder = join(appTestContext.tempDir, "embabel", "me-openapi-human-acceptance", ".scratch", "openapi-pr-delivery-with-a-deliberately-long-name");
  await mkdir(folder, { recursive: true });
  expect(encodeURIComponent(adHocFolderWorkspaceId(folder)).length).toBeGreaterThan(100);
  return folder;
}

describe("long workspace ids", () => {
  it("routes registered workspace ids longer than 100 characters", async () => {
    const project = (await appTestContext.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Long", path: appTestContext.projectDir, create: true } })).json<Project>();
    const workspaceId = `worktree-${"x".repeat(150)}`;
    appTestContext.workspaceCatalog.set(project.id, [{ id: workspaceId, projectId: project.id, path: appTestContext.projectDir, label: "long", isMain: true }]);
    await writeFile(join(appTestContext.projectDir, "note.md"), "long id");

    for (const prefix of ["/api", "/api/machines/local"]) {
      const response = await appTestContext.app.inject({ method: "GET", url: `${prefix}/projects/${project.id}/workspaces/${workspaceId}/file?path=note.md` });
      expect(response.statusCode).toBe(200);
      expect(response.json<FileContentResponse>().content).toBe("long id");
    }
    const workspaces = (await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` })).json<WorkspaceProviderResolution>();
    expect(workspaces.workspaces[0]?.id).toBe(workspaceId);
  });
});

describe("ad-hoc folder workspace file routes", () => {
  it("serves read, tree, search, preview, write, move and delete for a session cwd folder", async () => {
    const folder = await longScratchFolder();
    appTestContext.sessionCwds = [folder];
    await writeFile(join(folder, "report.md"), "# Report");
    await writeFile(join(folder, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    for (const prefix of ["/api", "/api/machines/local"]) {
      const read = await appTestContext.app.inject({ method: "GET", url: `${folderUrl(folder, "file", prefix)}?path=report.md` });
      expect(read.statusCode).toBe(200);
      expect(read.json<FileContentResponse>().content).toBe("# Report");
    }
    const tree = await appTestContext.app.inject({ method: "GET", url: folderUrl(folder, "tree") });
    expect(tree.statusCode).toBe(200);
    expect(tree.json<FileTreeResponse>().entries.map((entry) => entry.name).sort()).toEqual(["diagram.svg", "report.md"]);
    const search = await appTestContext.app.inject({ method: "GET", url: `${folderUrl(folder, "search")}?q=report` });
    expect(search.statusCode).toBe(200);
    expect(search.json<{ paths: string[] }>().paths).toEqual(["report.md"]);
    const preview = await appTestContext.app.inject({ method: "GET", url: `${folderUrl(folder, "file/preview")}?path=diagram.svg` });
    expect(preview.statusCode).toBe(200);

    const write = await appTestContext.app.inject({ method: "PUT", url: `${folderUrl(folder, "file")}?path=notes/new.md`, payload: "saved", headers: { "content-type": "text/plain" } });
    expect(write.statusCode).toBe(200);
    expect(await readFile(join(folder, "notes", "new.md"), "utf8")).toBe("saved");
    const move = await appTestContext.app.inject({ method: "POST", url: `${folderUrl(folder, "file/move")}?fromPath=notes/new.md&toPath=moved.md` });
    expect(move.statusCode).toBe(200);
    const remove = await appTestContext.app.inject({ method: "DELETE", url: `${folderUrl(folder, "file")}?path=moved.md` });
    expect(remove.statusCode).toBe(200);
  });

  it("refuses folders that are not exactly a session cwd", async () => {
    const folder = await longScratchFolder();
    const sibling = join(appTestContext.tempDir, "sibling");
    await mkdir(sibling);
    const elsewhere = join(appTestContext.tempDir, "elsewhere");
    await mkdir(elsewhere);
    const link = join(appTestContext.tempDir, "link-to-elsewhere");
    await symlink(elsewhere, link);
    appTestContext.sessionCwds = [folder];

    for (const denied of [sibling, join(folder, ".."), appTestContext.tempDir, link, join(folder, "missing")]) {
      const response = await appTestContext.app.inject({ method: "GET", url: `${folderUrl(denied, "file")}?path=x` });
      expect(response.statusCode, denied).toBe(403);
      expect(response.json<{ error: string }>().error).toContain("is not the working directory of a Pi session");
    }
  });

  it("refuses the filesystem root and home directory even when a session ran there", async () => {
    appTestContext.sessionCwds = ["/", homedir()];
    for (const denied of ["/", homedir()]) {
      const response = await appTestContext.app.inject({ method: "GET", url: folderUrl(denied, "tree") });
      expect(response.statusCode, denied).toBe(403);
    }
  });

  it("resolves a symlink alias to its canonical session cwd", async () => {
    const folder = await longScratchFolder();
    await writeFile(join(folder, "report.md"), "canonical");
    const alias = join(appTestContext.tempDir, "alias");
    await symlink(folder, alias);
    appTestContext.sessionCwds = [folder];

    const response = await appTestContext.app.inject({ method: "GET", url: `${folderUrl(alias, "file")}?path=report.md` });
    expect(response.statusCode).toBe(200);
    expect(response.json<FileContentResponse>().content).toBe("canonical");
  });

  it("keeps files outside the granted folder unreachable", async () => {
    const folder = await longScratchFolder();
    appTestContext.sessionCwds = [folder];
    await writeFile(join(appTestContext.tempDir, "secret.txt"), "secret");
    await symlink(join(appTestContext.tempDir, "secret.txt"), join(folder, "escape.txt"));

    for (const path of ["../../../../secret.txt", "escape.txt", join(appTestContext.tempDir, "secret.txt")]) {
      const response = await appTestContext.app.inject({ method: "GET", url: `${folderUrl(folder, "file")}?path=${encodeURIComponent(path)}` });
      expect(response.statusCode, path).toBe(400);
      expect(response.body).not.toContain("secret\"");
    }
  });

  it("rejects malformed folder workspace ids", async () => {
    appTestContext.sessionCwds = [appTestContext.tempDir];
    const response = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${AD_HOC_FOLDER_PROJECT_ID}/workspaces/relative-path/tree` });
    expect(response.statusCode).toBe(404);
  });
});
