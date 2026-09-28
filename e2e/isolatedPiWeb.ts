import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Starts a throwaway PI WEB (session daemon + web/API serving a fresh client build)
 * on its own data dir, socket, port and Pi agent dir, seeded with a fixture project
 * and one finished Chat. Inherited PI_* variables point at the live instance, so the
 * child environment drops all of them before setting its own.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_PORT = 8505;
export const E2E_PROJECT_ID = "e2e-project";
export const E2E_SESSION_ID = "019ef4c0-0000-7000-8000-00000000e2e1";
export const E2E_SEARCH_MATCHES = 150;
export const E2E_NOTES_BODY = "Seeded notes body for the file-link check.";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-web-e2e-")));
  const children: ChildProcess[] = [];
  const teardown = async (): Promise<void> => {
    await Promise.all(children.map(stop));
    await rm(root, { recursive: true, force: true });
  };
  try {
    const dataDir = join(root, "data");
    const sessionDir = join(root, "agent", "sessions");
    const project = join(root, "project");
    const clientDist = join(root, "client");
    const socket = join(dataDir, "sessiond.sock");
    const port = await freePort();
    if (port === LIVE_PORT) throw new Error("Refusing to use the live PI WEB port");
    await Promise.all([mkdir(sessionDir, { recursive: true }), mkdir(join(project, "docs"), { recursive: true }), mkdir(join(project, "entries"), { recursive: true })]);
    await seedProject(project);
    await writeJson(join(dataDir, "projects.json"), { projects: [{ id: E2E_PROJECT_ID, name: "e2e", path: project, createdAt: new Date().toISOString() }] });
    await writeJson(join(root, "config.json"), { host: "127.0.0.1", allowedHosts: true });
    await seedChat(sessionDir, project);

    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("GIT_")));
    Object.assign(env, {
      PI_WEB_DATA_DIR: dataDir,
      PI_WEB_CONFIG: join(root, "config.json"),
      PI_WEB_SESSIOND_SOCKET: socket,
      PI_WEB_HOST: "127.0.0.1",
      PI_WEB_PORT: String(port),
      PI_WEB_ALLOWED_HOSTS: "true",
      PI_WEB_CLIENT_DIST: clientDist,
      PI_WEB_SKIP_VERSION_CHECK: "1",
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_OFFLINE: "1",
      NO_COLOR: "1",
    });

    // Bundled plugins (the daemon requires Terminal) load from the worktree's dist/; the client goes to the temp root.
    build("npm", ["run", "build:plugins"], env);
    build(bin("vite"), ["build", "--outDir", clientDist, "--emptyOutDir", "--logLevel", "error"], env);
    children.push(start("sessiond", ["src/server/sessiond.ts"], env, root));
    await waitFor(() => existsSync(socket), "session daemon socket");
    children.push(start("web", ["src/server/index.ts"], env, root));
    const baseUrl = `http://127.0.0.1:${String(port)}/`;
    await waitFor(async () => (await fetch(`${baseUrl}api/projects`).catch(() => undefined))?.ok === true, "web/API server");

    const listing: unknown = await (await fetch(`${baseUrl}api/projects/${E2E_PROJECT_ID}/workspaces`)).json();
    const workspaceId = mainWorkspaceId(listing);
    process.env["PI_WEB_E2E_CHAT_URL"] = `${baseUrl}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId, session: E2E_SESSION_ID, view: "chat" }).toString()}`;
    return teardown;
  } catch (error) {
    const logs = await Promise.all(["sessiond", "web"].map(async (name) => `--- ${name} ---\n${await readFile(join(root, `${name}.log`), "utf8").catch(() => "")}`));
    await teardown();
    throw new Error(`Isolated PI WEB did not start: ${String(error)}\n${logs.join("\n")}`, { cause: error });
  }
}

async function seedProject(project: string): Promise<void> {
  await writeFile(join(project, "docs", "notes.md"), `# Seeded notes\n\n${E2E_NOTES_BODY}\n`);
  await Promise.all(Array.from({ length: E2E_SEARCH_MATCHES }, (_, index) => writeFile(join(project, "entries", `entry-${String(index).padStart(3, "0")}.txt`), "")));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-C", project, ...args], {
      encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
}

async function seedChat(sessionDir: string, cwd: string): Promise<void> {
  const ms = Date.now();
  const at = (offset: number) => new Date(ms + offset).toISOString();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const entries = [
    { type: "session", version: 3, id: E2E_SESSION_ID, timestamp: at(0), cwd },
    { type: "message", id: "e2e00001", parentId: null, timestamp: at(1000), message: { role: "user", content: [{ type: "text", text: "Where are the notes?" }], timestamp: ms + 1000 } },
    {
      type: "message", id: "e2e00002", parentId: "e2e00001", timestamp: at(2000),
      message: { role: "assistant", content: [{ type: "text", text: "They are in [the notes](docs/notes.md)." }], api: "openai-responses", provider: "openai", model: "fixture", usage, stopReason: "stop", timestamp: ms + 2000 },
    },
  ];
  await writeFile(join(sessionDir, `${at(0).replaceAll(":", "-")}_${E2E_SESSION_ID}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function mainWorkspaceId(listing: unknown): string {
  const workspaces = typeof listing === "object" && listing !== null && "workspaces" in listing ? listing.workspaces : listing;
  if (!Array.isArray(workspaces)) throw new Error(`Unexpected workspace listing: ${JSON.stringify(listing)}`);
  const [first]: unknown[] = workspaces;
  if (typeof first !== "object" || first === null || !("id" in first) || typeof first.id !== "string") throw new Error(`No fixture workspace: ${JSON.stringify(listing)}`);
  return first.id;
}

function build(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
}

function bin(name: string): string {
  return join(REPO_ROOT, "node_modules", ".bin", name);
}

function start(name: string, args: string[], env: NodeJS.ProcessEnv, root: string): ChildProcess {
  // Own process group, so teardown also reaches the node child tsx spawns.
  const child = spawn(bin("tsx"), args, { cwd: REPO_ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = join(root, `${name}.log`);
  const append = (chunk: Buffer) => { void writeFile(log, chunk, { flag: "a" }).catch(() => undefined); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  const signal = (name: NodeJS.Signals) => { try { process.kill(-(child.pid ?? 0), name); } catch { /* already gone */ } };
  signal("SIGTERM");
  const timer = setTimeout(() => { signal("SIGKILL"); }, 3000);
  await exited;
  clearTimeout(timer);
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => { if (typeof address === "object" && address !== null) done(address.port); else fail(new Error("No free port")); });
    });
    server.on("error", fail);
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
