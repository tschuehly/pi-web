import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteInstalledScript, registerInstallLatestRoutes } from "./installLatestRoutes.js";

const PREVIEW = {
  installed: { workbench: "1aa26dc8a2f9", piWeb: "6438f6977ca2" },
  latest: { workbench: "2bb37ed9b3fa", piWeb: "7549a7088db3" },
  merges: [{ repo: "pi-web", sha: "7549a7088db3", subject: "Install latest" }],
  upToDate: false,
};

let dir: string;
let script: string;

/** A fake promote-installed: records its arguments, prints $OUT, writes $ERR to stderr and exits $CODE. */
async function fake(out: string, code = 0, err = ""): Promise<void> {
  await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\nprintf '%s' '${out}'\nprintf '%s' '${err}' >&2\nexit ${String(code)}\n`);
  await chmod(script, 0o755);
}

async function app(path: string | undefined = script) {
  const server = Fastify({ logger: false });
  registerInstallLatestRoutes(server, path);
  await server.ready();
  return server;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-web-install-latest-"));
  script = join(dir, "promote-installed");
});
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

  it("POST runs the install with exactly the owner's installed and latest pairs", async () => {
    await fake("");
    const response = await (await app()).inject({ method: "POST", url: "/api/install/latest", payload: { from: PREVIEW.installed, to: PREVIEW.latest } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "scheduled" });
    expect(await readFile(join(dir, "args"), "utf8")).toBe("latest\n--from\n1aa26dc8a2f9\n6438f6977ca2\n--to\n2bb37ed9b3fa\n7549a7088db3\n");
  });

  it("POST returns the script's refusal as 409", async () => {
    await fake("", 9, "refusing: latest moved since you looked: now 3cc4 7549a70; review again");
    const response = await (await app()).inject({ method: "POST", url: "/api/install/latest", payload: { from: PREVIEW.installed, to: PREVIEW.latest } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "refusing: latest moved since you looked: now 3cc4 7549a70; review again" });
  });

  it("POST refuses a pair that is not two revisions without running the script", async () => {
    await fake("");
    const response = await (await app()).inject({ method: "POST", url: "/api/install/latest", payload: { from: { workbench: "--force", piWeb: "6438f69" }, to: PREVIEW.latest } });
    expect(response.statusCode).toBe(400);
    const noTo = await (await app()).inject({ method: "POST", url: "/api/install/latest", payload: { from: PREVIEW.installed } });
    expect(noTo.statusCode).toBe(400);
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
