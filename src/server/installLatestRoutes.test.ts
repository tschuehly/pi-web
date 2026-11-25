import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installConfirmText, promoteInstalledScript, registerInstallLatestRoutes } from "./installLatestRoutes.js";
import { nativeConfirm, type NativeConfirm } from "./nativeConfirm.js";

const PREVIEW = {
  installed: { workbench: "1aa26dc8a2f9", piWeb: "6438f6977ca2" },
  latest: { workbench: "2bb37ed9b3fa", piWeb: "7549a7088db3" },
  merges: [{ repo: "pi-web", sha: "7549a7088db3", subject: "Install latest" }],
  upToDate: false,
};

let dir: string;
let script: string;
let asked: string[];
const allow: NativeConfirm = (text) => { asked.push(text); return Promise.resolve(true); };

/** A fake promote-installed: records its arguments, prints $OUT, writes $ERR to stderr and exits $CODE. */
async function fake(out: string, code = 0, err = ""): Promise<void> {
  await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\nprintf '%s' '${out}'\nprintf '%s' '${err}' >&2\nexit ${String(code)}\n`);
  await chmod(script, 0o755);
}

async function app(path: string | undefined = script, confirm: NativeConfirm | undefined | "off" = allow) {
  const server = Fastify({ logger: false });
  registerInstallLatestRoutes(server, path, confirm === "off" ? undefined : confirm);
  await server.ready();
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-web-install-latest-"));
  script = join(dir, "promote-installed");
  asked = [];
});
const post = (payload: Record<string, unknown>, confirm?: NativeConfirm) => app(script, confirm).then((server) => server.inject({ method: "POST", url: "/api/install/latest", payload }));
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("install latest routes", () => {
  it("GET passes the dry-run JSON through", async () => {
    await fake(JSON.stringify(PREVIEW));
    const response = await (await app()).inject({ method: "GET", url: "/api/install/latest" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(PREVIEW);
    expect(await readFile(join(dir, "args"), "utf8")).toBe("latest\n--dry-run\n--json\n");
  });

  it("GET maps a script failure to 409 with its stderr and bad output to 502", async () => {
    await fake("", 2, "git fetch failed");
    expect((await (await app()).inject({ method: "GET", url: "/api/install/latest" })).json()).toEqual({ error: "git fetch failed" });
    await fake("not json");
    expect((await (await app()).inject({ method: "GET", url: "/api/install/latest" })).statusCode).toBe(502);
  });

  it("POST asks the owner naming both latest shas and the merge count, then runs the install with exactly the shown pairs", async () => {
    await fake("");
    const response = await post({ from: PREVIEW.installed, to: PREVIEW.latest, merges: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "scheduled" });
    expect(await readFile(join(dir, "args"), "utf8")).toBe("latest\n--from\n1aa26dc8a2f9\n6438f6977ca2\n--to\n2bb37ed9b3fa\n7549a7088db3\n");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Install Pi Workbench 2bb37ed9b3fa \+ PI WEB 7549a7088db3 and restart PI WEB\?/u);
    expect(asked[0]).toContain("1 new merge since 1aa26dc8a2f9 + 6438f6977ca2.");
  });

  it("POST answers 403 without running the script when the owner denies, the dialog times out or fails", async () => {
    await fake("");
    const answers: NativeConfirm[] = [() => Promise.resolve(false), () => Promise.resolve(false), () => Promise.reject(new Error("osascript died"))];
    for (const confirm of answers) {
      const response = await post({ from: PREVIEW.installed, to: PREVIEW.latest, merges: 1 }, confirm);
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: string }>().error).toMatch(/^not confirmed/u);
    }
    await expect(readFile(join(dir, "args"), "utf8")).rejects.toThrow();
  });

  it("POST answers 501 off macOS, and refuses a merge count that is not one, without asking", async () => {
    await fake("");
    expect((await post({ from: PREVIEW.installed, to: PREVIEW.latest })).statusCode).toBe(200);
    await rm(join(dir, "args"));
    const off = await (await app(script, "off")).inject({ method: "POST", url: "/api/install/latest", payload: { from: PREVIEW.installed, to: PREVIEW.latest } });
    expect(off.statusCode).toBe(501);
    expect(nativeConfirm("linux")).toBeUndefined();
    expect(nativeConfirm("darwin")).toBeTypeOf("function");
    expect((await post({ from: PREVIEW.installed, to: PREVIEW.latest, merges: "lots" })).statusCode).toBe(400);
    expect(asked).toHaveLength(1);
    await expect(readFile(join(dir, "args"), "utf8")).rejects.toThrow();
  });

  it("confirm text without a count names the pair only", () => {
    expect(installConfirmText({ workbench: "none", piWeb: "none" }, PREVIEW.latest, undefined)).not.toContain("merge");
  });

  it("POST returns the script's refusal as 409", async () => {
    await fake("", 9, "refusing: latest moved since you looked: now 3cc4 7549a70; review again");
    const response = await post({ from: PREVIEW.installed, to: PREVIEW.latest });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "refusing: latest moved since you looked: now 3cc4 7549a70; review again" });
  });

  it("POST refuses a pair that is not two revisions without running the script", async () => {
    await fake("");
    const response = await (await app()).inject({ method: "POST", url: "/api/install/latest", payload: { from: { workbench: "--force", piWeb: "6438f69" }, to: PREVIEW.latest } });
    expect(response.statusCode).toBe(400);
    const noTo = await (await app()).inject({ method: "POST", url: "/api/install/latest", payload: { from: PREVIEW.installed } });
    expect(noTo.statusCode).toBe(400);
    expect(asked).toEqual([]);
    await expect(readFile(join(dir, "args"), "utf8")).rejects.toThrow();
  });

  it("answers 503 without a script, or when it cannot start", async () => {
    expect((await (await app(undefined)).inject({ method: "GET", url: "/api/install/latest" })).statusCode).toBe(503);
    expect((await (await app(join(dir, "missing"))).inject({ method: "GET", url: "/api/install/latest" })).statusCode).toBe(503);
  });

  it("finds the script beside the Durable host entry, or the override", () => {
    expect(promoteInstalledScript({ PI_WEB_DURABLE_HOST: "/b/pi-workbench-1aa2/packages/durable-pilot/src/chat-host-main.ts" })).toBe("/b/pi-workbench-1aa2/scripts/promote-installed");
    expect(promoteInstalledScript({ PI_WEB_PROMOTE_INSTALLED: "/x/promote", PI_WEB_DURABLE_HOST: "/b/p/d/s/h.ts" })).toBe("/x/promote");
    expect(promoteInstalledScript({})).toBeUndefined();
  });
});
