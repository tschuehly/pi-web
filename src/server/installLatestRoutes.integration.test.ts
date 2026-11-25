// Install latest against the REAL pi-workbench `scripts/promote-installed` (path in PI_WEB_TEST_PROMOTE_INSTALLED; skipped
// without it), in a temp HOME and project folder built like the script's own promote-installed.latest.test.mjs:
// bare remotes with integration checkouts, prepared builds the switch reuses, launchctl and lsof shims, an empty ps.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallLatestPreview } from "../shared/installLatest.js";
import { registerInstallLatestRoutes } from "./installLatestRoutes.js";

const real = process.env["PI_WEB_TEST_PROMOTE_INSTALLED"] ?? "";
const put = (path: string, data: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function harness(script: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-install-latest-real-"));
  roots.push(root);
  const home = join(root, "home"), projects = join(root, "projects"), bin = join(root, "bin");
  const store = join(home, ".pi-workbench/installed-durable");
  const genv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, env: genv, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, subject: string, file = "f", content = subject) => {
    writeFileSync(join(cwd, file), content); git(cwd, "add", "."); git(cwd, "commit", "-qm", subject); return git(cwd, "rev-parse", "HEAD");
  };
  const seeds = { "pi-workbench": "", "pi-web": "" }, first = { "pi-workbench": "", "pi-web": "" };
  for (const [name, branch] of [["pi-workbench", "main"], ["pi-web", "pi-workbench"]] as const) {
    git(root, "init", "-q", "--bare", "-b", branch, `${name}.git`);
    const seed = join(root, `seed-${name}`);
    git(root, "clone", "-q", join(root, `${name}.git`), seed);
    git(seed, "checkout", "-q", "-b", branch);
    seeds[name] = seed; first[name] = commit(seed, `${name} one`);
    git(seed, "push", "-q", "origin", `HEAD:${branch}`);
    git(root, "clone", "-q", "-b", branch, join(root, `${name}.git`), join(projects, name));
  }
  const shim = (name: string, body: string) => { put(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  shim("launchctl", `echo "$*" >> "$HOME/launchctl.log"`);
  shim("lsof", "exit 0");
  put(join(root, "ps.txt"), "");
  mkdirSync(home, { recursive: true });
  // The route runs this wrapper with PI WEB's environment; env -i keeps only the temp setup, so the real HOME,
  // projects and launchd are out of reach.
  const bash = spawnSync("sh", ["-c", "command -v bash"], { env: genv, encoding: "utf8" }).stdout.trim();
  const wrapper = join(root, "promote-installed");
  const vars = { ...genv, HOME: home, PI_WORKBENCH_PROJECTS: projects, PI_PROMOTE_PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    PI_PROMOTE_PS: `cat ${join(root, "ps.txt")}`, PI_PROMOTE_ETIME_PS: `cat ${join(root, "ps.txt")}` };
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  put(wrapper, `#!/bin/sh\nexec env -i ${Object.entries(vars).map(([k, v]) => `${k}=${quote(v)}`).join(" ")} ${quote(bash)} ${quote(script)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  /** A prepared build the switch reuses as is (no install), linked live when `live`. */
  const build = (product: "pi-workbench" | "pi-web", rev: string, live = false) => {
    const dir = join(store, `${product}-${rev.slice(0, 12)}`);
    if (product === "pi-web") put(join(dir, "dist/server/sessiond.js"), 'env["PI_WEB_DURABLE_HOST_LAUNCHD"]\n');
    else mkdirSync(dir, { recursive: true });
    put(`${dir}.prepared`, "");
    if (live) { rmSync(join(projects, `${product}.durable-installed`), { force: true }); symlinkSync(dir, join(projects, `${product}.durable-installed`)); }
    return dir;
  };
  /** pi-workbench main gains a merged branch pinning PI WEB's second commit. */
  const moveOn = () => {
    const pw2 = commit(seeds["pi-web"], "pi-web two");
    git(seeds["pi-web"], "push", "-q", "origin", "HEAD:pi-workbench");
    const wb = seeds["pi-workbench"];
    git(wb, "checkout", "-q", "-b", "feature");
    commit(wb, "feature work", "g");
    git(wb, "checkout", "-q", "main");
    git(wb, "merge", "-q", "--no-ff", "-m", "Merge branch 'feature'", "feature");
    const wbPin = commit(wb, "pin pi-web", "pi-web.rev", `${pw2}\n`);
    git(wb, "push", "-q", "origin", "HEAD:main");
    return { wbPin, pw2 };
  };
  /** Someone merges to pi-workbench main after the owner looked. */
  const mergeLater = () => { const sha = commit(seeds["pi-workbench"], "later merge", "h"); git(seeds["pi-workbench"], "push", "-q", "origin", "HEAD:main"); return sha; };
  const jobs = () => (existsSync(join(store, "jobs")) ? readdirSync(join(store, "jobs")) : []);
  const launchctl = () => (existsSync(join(home, "launchctl.log")) ? readFileSync(join(home, "launchctl.log"), "utf8") : "");
  return { wrapper, store, first, build, moveOn, mergeLater, jobs, launchctl };
}

async function app(script: string) {
  const server = Fastify({ logger: false });
  registerInstallLatestRoutes(server, script);
  await server.ready();
  return server;
}

describe.skipIf(real === "" || !existsSync(real))("install latest routes with the real promote-installed", () => {
  it("GET previews the real merges; POST with a stale pair is the script's 409; POST with the shown pair schedules the switch", async () => {
    const h = harness(real);
    const wb1 = h.first["pi-workbench"], pw1 = h.first["pi-web"];
    h.build("pi-workbench", wb1, true);
    h.build("pi-web", pw1, true);
    const { wbPin, pw2 } = h.moveOn();
    const wbDir = h.build("pi-workbench", wbPin), pwDir = h.build("pi-web", pw2);
    const server = await app(h.wrapper);

    const preview = await server.inject({ method: "GET", url: "/api/install/latest" });
    expect(preview.statusCode, preview.body).toBe(200);
    const shown = preview.json<InstallLatestPreview>();
    expect(shown).toMatchObject({ installed: { workbench: wb1, piWeb: pw1 }, latest: { workbench: wbPin, piWeb: pw2 }, upToDate: false });
    expect(shown.merges.map((m) => `${m.repo}: ${m.subject}`))
      .toEqual(["pi-workbench: pin pi-web", "pi-workbench: Merge branch 'feature'", "pi-web: pi-web two"]);

    const stale = await server.inject({ method: "POST", url: "/api/install/latest", payload: { from: { workbench: pw1, piWeb: pw1 }, to: shown.latest } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toMatch(/^refusing: installed now is .*not the --from pair.*fresh approval/su);
    expect(h.jobs()).toEqual([]);

    const scheduled = await server.inject({ method: "POST", url: "/api/install/latest", payload: { from: shown.installed, to: shown.latest } });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(scheduled.json()).toEqual({ status: "scheduled" });
    const jobs = h.jobs();
    expect(jobs).toHaveLength(1);
    expect(readFileSync(join(h.store, "jobs", String(jobs[0]), "job.sh"), "utf8")).toContain(`wb=${wbDir} pw=${pwDir}`);
    expect(h.launchctl()).toMatch(/^bootstrap gui\/\d+ .*job\.plist$/mu);
  });

  it("nothing installed yet: GET reports none and no merges; POST with none none schedules the first install", async () => {
    const h = harness(real);
    const { wbPin, pw2 } = h.moveOn();
    h.build("pi-workbench", wbPin);
    h.build("pi-web", pw2);
    const server = await app(h.wrapper);

    const preview = await server.inject({ method: "GET", url: "/api/install/latest" });
    expect(preview.statusCode, preview.body).toBe(200);
    const shown = preview.json<InstallLatestPreview>();
    expect(shown).toEqual({ installed: { workbench: "none", piWeb: "none" }, latest: { workbench: wbPin, piWeb: pw2 }, merges: [], upToDate: false });

    const scheduled = await server.inject({ method: "POST", url: "/api/install/latest", payload: { from: shown.installed, to: shown.latest } });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(h.jobs()).toHaveLength(1);
  });

  it("POST refuses with 409 when origin/main moved after the preview, without scheduling", async () => {
    const h = harness(real);
    h.build("pi-workbench", h.first["pi-workbench"], true);
    h.build("pi-web", h.first["pi-web"], true);
    const { wbPin } = h.moveOn();
    h.build("pi-workbench", wbPin);
    const server = await app(h.wrapper);
    const shown = (await server.inject({ method: "GET", url: "/api/install/latest" })).json<InstallLatestPreview>();
    expect(shown.latest.workbench).toBe(wbPin);
    const later = h.mergeLater();

    const moved = await server.inject({ method: "POST", url: "/api/install/latest", payload: { from: shown.installed, to: shown.latest } });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json<{ error: string }>().error).toMatch(new RegExp(`^refusing: latest moved since you looked: now ${later.slice(0, 12)} .*review again`, "u"));
    expect(h.jobs()).toEqual([]);
  });
});
