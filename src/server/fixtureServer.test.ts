import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControlledFixtureServer } from "./fixtureServer.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("controlled fixture server", () => {
  it("publishes five opaque sessions on distinct complete production anchors", async () => {
    const root = await tempRoot();
    const { app, fixture } = await buildControlledFixtureServer({
      root,
      projectsFile: join(root, "data/projects.json"),
      machinesFile: join(root, "data/machines.json"),
      sessionDir: join(root, "agent/sessions"),
      manifestFile: join(root, "fixture/manifest.json"),
      clientDist: false,
      appDependencies: { logger: false },
    });
    try {
      expect(fixture.anchors).toHaveLength(5);
      expect(new Set(fixture.anchors.map((anchor) => `${anchor.machineId}:${anchor.projectId}:${anchor.workspaceId}`)).size).toBe(5);
      expect(new Set(fixture.anchors.map((anchor) => anchor.sessionId)).size).toBe(5);
      expect(JSON.parse(await readFile(join(root, "fixture/manifest.json"), "utf8"))).toEqual(fixture);
      expect(fixture.anchors.every((anchor) => !anchor.sessionId.includes("session-") && anchor.displayName.length > 0)).toBe(true);
      const workstreams = await app.inject({ method: "POST", url: "/api/pi-web-plugins/pi-workbench/service", payload: { operation: "list", input: {} } });
      expect(workstreams.json()).toEqual({ ok: true, value: [] });
      const projects = await app.inject({ method: "GET", url: "/api/projects" });
      expect(projects.statusCode).toBe(200);
      expect(projects.json()).toHaveLength(5);
      for (const anchor of fixture.anchors) {
        const workspaces = await app.inject({ method: "GET", url: `/api/projects/${encodeURIComponent(anchor.projectId)}/workspaces` });
        expect(workspaces.statusCode).toBe(200);
        expect(workspaces.json()).toEqual(expect.objectContaining({ workspaces: [expect.objectContaining({ id: anchor.workspaceId, path: anchor.cwd, isMain: true })] }));
      }
    } finally {
      await app.close();
    }
  });

  it("seeds paging depth, stable transcript identities, and deterministic Files/Git state", async () => {
    const root = await tempRoot();
    const { app, fixture } = await buildControlledFixtureServer({
      root,
      projectsFile: join(root, "data/projects.json"),
      machinesFile: join(root, "data/machines.json"),
      sessionDir: join(root, "agent/sessions"),
      manifestFile: join(root, "fixture/manifest.json"),
      clientDist: false,
      appDependencies: { logger: false },
    });
    try {
      const sessionFiles = await Promise.all(fixture.anchors.map(async (anchor) => {
        const file = (await import("node:fs/promises")).readdir(join(root, "agent/sessions")).then((names) => names.find((name) => name.includes(anchor.sessionId)));
        const name = await file;
        if (name === undefined) throw new Error("fixture session file missing");
        return readFile(join(root, "agent/sessions", name), "utf8");
      }));
      for (let index = 0; index < fixture.anchors.length; index += 1) {
        const text = sessionFiles[index];
        const anchor = fixture.anchors[index];
        expect(text?.split("\n").filter(Boolean).length).toBeGreaterThan(120);
        expect(text).toContain(anchor?.transcriptMarker);
        expect(text).toContain(anchor?.displayName);
        expect(await readFile(join(anchor?.cwd ?? "", "README.md"), "utf8")).toContain(`fixture-file-${String(index + 1)}`);
        expect(await readFile(join(anchor?.cwd ?? "", "tracked.txt"), "utf8")).toContain(`working-tree-change-${String(index + 1)}`);
      }
      expect(fixture.blockers).toEqual([expect.objectContaining({ code: "LIVE_ASK_UNREACHABLE", state: "partial" })]);
    } finally {
      await app.close();
    }
  });

  it("refuses fixture paths outside its owned root", async () => {
    const root = await tempRoot();
    await expect(buildControlledFixtureServer({
      root,
      projectsFile: join(tmpdir(), "foreign-projects.json"),
      machinesFile: join(root, "machines.json"),
      sessionDir: join(root, "sessions"),
      manifestFile: join(root, "manifest.json"),
      clientDist: false,
      appDependencies: { logger: false },
    })).rejects.toThrow("must stay under the controlled fixture root");
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-controlled-fixture-test-"));
  roots.push(root);
  return root;
}
