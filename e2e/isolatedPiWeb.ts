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
export const E2E_ADHOC_SESSION_ID = "019ef4c0-0000-7000-8000-00000000e2e2";
/** More finished Chats in the fixture project, for multi-Chat layouts; long enough to scroll. */
export const E2E_MORE_CHATS = [
  { id: "019ef4c0-0000-7000-8000-00000000e2e3", question: "Draft the release notes" },
  { id: "019ef4c0-0000-7000-8000-00000000e2e4", question: "Review the install guide" },
] as const;
/** A Chat in the fixture project whose transcript leaves one `ask_user` set open; the daemon rebuilds it on open. */
export const E2E_ASK_CHAT = {
  id: "019ef4c0-0000-7000-8000-00000000e2e5",
  question: "Make question contexts shorter",
  ask: {
    askId: "q7k-1",
    context: "The short-context rule for `ask_user` is ready in two parts. Context is now at most five short lines of finding; each option states its own consequence and the recommended one is marked.\n- Workbench 14477be: the Switching guidance. Tests 17/17.\n- PI WEB 14a067f7: the tool's instructions. The new test failed on the old code and now passes 10/10.",
    questions: [
      { id: "golive", question: "How should the short-context rule go live?", options: [
        { value: "wb-now", label: "Workbench now, PI WEB with the next daemon restart", recommended: true, detail: "No interruption now; the tool's own instructions update at the next planned restart." },
        { value: "both-now", label: "Both now, with a full switch", detail: "Restarts the session daemon: every running session is interrupted." },
        { value: "later", label: "Not yet", detail: "Both branches stay pushed and unmerged." },
      ] },
      { id: "checks", question: "Which checks should run before it goes live?", multiple: true, options: [
        { value: "unit", label: "Unit tests", recommended: true },
        { value: "e2e", label: "End-to-end tests" },
        { value: "dogfood", label: "A day of dogfooding", detail: "Delays go-live by a day." },
      ] },
    ],
  },
} as const;
/** A Chat whose open set asks twelve questions at once, for a crowded grid. */
export const E2E_CROWDED_ASK_CHAT = {
  id: "019ef4c0-0000-7000-8000-00000000e2e6",
  question: "Plan the migration",
  ask: {
    askId: "m12-1",
    context: "Twelve choices decide the migration.",
    questions: Array.from({ length: 12 }, (_, index) => ({ id: `step${String(index + 1)}`, question: `Migration step ${String(index + 1)}: run it now or later?`, options: [{ value: "now", label: "Now", recommended: true }, { value: "later", label: "Later" }] })),
  },
};
type SeededAsk = { askId: string; context: string; questions: readonly unknown[] };
export const E2E_REPORT_BODY = "Seeded report body in an unregistered Chat folder.";
export const E2E_SIBLING_BODY = "export const seededSiblingBody = true;";
export const E2E_PLAN = [
  "# Release plan", "", "The launch is on Friday.", "",
  "- [ ] Write the release notes", "- [x] Tag the build", "  - nested item with `inline code`", "",
  "| Area | Owner | Notes | Status | A long header for a wide column | Another wide column |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Docs | Ana | Update the install guide and the changelog | open | more text that makes the table wide | even more text |",
  "", "```ts", "const ready = true;", "```", "", "## Risks", "", "Network flakiness could delay the rollout by a day or two.", "",
].join("\n");

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
    // An unregistered Chat folder shaped like the live failure: a long path through a dot directory.
    const adHocFolder = join(root, "embabel", "me-openapi-human-acceptance", ".scratch", "openapi-pr-delivery");
    if (encodeURIComponent(`folder:${adHocFolder}`).length <= 100) throw new Error("Ad-hoc fixture folder id must exceed 100 characters");
    const clientDist = join(root, "client");
    const socket = join(dataDir, "sessiond.sock");
    const port = await freePort();
    if (port === LIVE_PORT) throw new Error("Refusing to use the live PI WEB port");
    await Promise.all([mkdir(sessionDir, { recursive: true }), mkdir(join(project, "docs"), { recursive: true }), mkdir(join(project, "entries"), { recursive: true }), mkdir(adHocFolder, { recursive: true })]);
    await seedProject(project);
    await writeJson(join(dataDir, "projects.json"), { projects: [{ id: E2E_PROJECT_ID, name: "e2e", path: project, createdAt: new Date().toISOString() }] });
    await writeJson(join(root, "config.json"), { host: "127.0.0.1" });
    // A sibling of the Chat's folder outside every registered project, linked as ../sibling/...
    const siblingFile = join(root, "sibling", "src", "generator.ts");
    await mkdir(dirname(siblingFile), { recursive: true });
    await writeFile(siblingFile, `${E2E_SIBLING_BODY}\n`);
    await seedChat(sessionDir, project, E2E_SESSION_ID, "They are in [the notes](docs/notes.md). The generator is [the sibling file](../sibling/src/generator.ts). See [the lines](docs/long.md#L40-L42).");
    for (const chat of E2E_MORE_CHATS) await seedChat(sessionDir, project, chat.id, "Done.", chat.question, 24);
    await seedChat(sessionDir, project, E2E_ASK_CHAT.id, "One question on how they go live.", E2E_ASK_CHAT.question, 3, E2E_ASK_CHAT.ask);
    await seedChat(sessionDir, project, E2E_CROWDED_ASK_CHAT.id, "Twelve questions before it starts.", E2E_CROWDED_ASK_CHAT.question, 3, E2E_CROWDED_ASK_CHAT.ask);
    await writeFile(join(adHocFolder, "report.md"), `# Report\n\n${E2E_REPORT_BODY}\n`);
    await seedChat(sessionDir, adHocFolder, E2E_ADHOC_SESSION_ID, "It is in [the report](report.md).");

    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("GIT_")));
    Object.assign(env, {
      PI_WEB_DATA_DIR: dataDir,
      PI_WEB_CONFIG: join(root, "config.json"),
      PI_WEB_SESSIOND_SOCKET: socket,
      PI_WEB_HOST: "127.0.0.1",
      PI_WEB_PORT: String(port),
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
    process.env["PI_WEB_E2E_SIBLING_FILE"] = siblingFile;
    process.env["PI_WEB_E2E_PROJECT_DIR"] = project;
    process.env["PI_WEB_E2E_WORKSPACE_ID"] = workspaceId;
    process.env["PI_WEB_E2E_ADHOC_CHAT_URL"] = `${baseUrl}?${new URLSearchParams({ session: E2E_ADHOC_SESSION_ID, view: "chat" }).toString()}`;
    return teardown;
  } catch (error) {
    const logs = await Promise.all(["sessiond", "web"].map(async (name) => `--- ${name} ---\n${await readFile(join(root, `${name}.log`), "utf8").catch(() => "")}`));
    await teardown();
    throw new Error(`Isolated PI WEB did not start: ${String(error)}\n${logs.join("\n")}`, { cause: error });
  }
}

async function seedProject(project: string): Promise<void> {
  await writeFile(join(project, "docs", "notes.md"), `# Seeded notes\n\n${E2E_NOTES_BODY}\n`);
  for (const name of ["plan.md", "conflict.md"]) await writeFile(join(project, "docs", name), E2E_PLAN);
  await writeFile(join(project, "docs", "long.md"), Array.from({ length: 80 }, (_, index) => `Line ${String(index + 1)} of the long file.`).join("\n"));
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

/** A finished Chat of `turns` exchanges: `question` first, `answer` last, filler paragraphs between; `ask` stays open before the answer. */
async function seedChat(sessionDir: string, cwd: string, sessionId: string, answer: string, question = "Where are the notes?", turns = 1, ask?: SeededAsk): Promise<void> {
  const ms = Date.now();
  const at = (offset: number) => new Date(ms + offset).toISOString();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const id = (index: number) => `e2e${String(index + 1).padStart(5, "0")}`;
  const filler = (turn: number) => `Step ${String(turn + 1)}. ${"This paragraph only makes the transcript long enough to scroll. ".repeat(4)}`;
  const entries: object[] = [{ type: "session", version: 3, id: sessionId, timestamp: at(0), cwd }];
  for (let turn = 0; turn < turns; turn += 1) {
    const [asked, answered] = [2 * turn, 2 * turn + 1];
    entries.push(
      { type: "message", id: id(asked), parentId: turn === 0 ? null : id(asked - 1), timestamp: at(1000 * (asked + 1)), message: { role: "user", content: [{ type: "text", text: turn === 0 ? question : `Continue with step ${String(turn + 1)}.` }], timestamp: ms + 1000 * (asked + 1) } },
      {
        type: "message", id: id(answered), parentId: id(asked), timestamp: at(1000 * (answered + 1)),
        message: { role: "assistant", content: [{ type: "text", text: turn === turns - 1 ? answer : filler(turn) }], api: "openai-responses", provider: "openai", model: "fixture", usage, stopReason: "stop", timestamp: ms + 1000 * (answered + 1) },
      },
    );
  }
  if (ask !== undefined) {
    // ask_user's own call and result, as askUserTool.ts records them, inserted before the final answer.
    const final = entries.pop() as { parentId: string };
    const asked = 1000 * (2 * turns - 1);
    const posted = { ...ask, askedAt: at(asked + 300), updatedAt: at(asked + 300), revision: "r1", turnsSinceUpdate: 0 };
    entries.push(
      { type: "message", id: "e2eask01", parentId: final.parentId, timestamp: at(asked + 300), message: { role: "assistant", content: [{ type: "toolCall", id: "call-ask", name: "ask_user", arguments: { context: ask.context, questions: ask.questions } }], api: "openai-responses", provider: "openai", model: "fixture", usage, stopReason: "toolUse", timestamp: ms + asked + 300 } },
      { type: "message", id: "e2eask02", parentId: "e2eask01", timestamp: at(asked + 600), message: { role: "toolResult", toolCallId: "call-ask", toolName: "ask_user", content: [{ type: "text", text: `Posted ask ${ask.askId}.` }], details: { ask: posted, sessionId }, isError: false, timestamp: ms + asked + 600 } },
      { ...final, parentId: "e2eask02" },
    );
  }
  await writeFile(join(sessionDir, `${at(0).replaceAll(":", "-")}_${sessionId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
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
