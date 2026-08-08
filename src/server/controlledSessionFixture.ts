import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
export const CONTROLLED_FIXTURE_CLOCK = "2026-08-08T07:02:41.000Z";

const SESSION_IDS = [
  "019c8f10-1000-7000-8000-000000000001",
  "019c8f10-2000-7000-8000-000000000002",
  "019c8f10-3000-7000-8000-000000000003",
  "019c8f10-4000-7000-8000-000000000004",
  "019c8f10-5000-7000-8000-000000000005",
] as const;
const DISPLAY_NAMES = ["Atlas transcript", "Borealis files", "Cygnus git", "Draco terminal", "Equinox paging"] as const;

export interface ControlledSessionFixtureOptions {
  root: string;
  projectsFile: string;
  machinesFile: string;
  sessionDir: string;
}

export interface ControlledSessionAnchor {
  sessionId: string;
  machineId: "local";
  projectId: string;
  workspaceId: string;
  cwd: string;
  displayName: string;
  transcriptMarker: string;
}

export interface ControlledSessionFixture {
  fixedClock: string;
  anchors: ControlledSessionAnchor[];
  blockers: readonly ControlledFixtureBlocker[];
}

export interface ControlledFixtureBlocker {
  code: "LIVE_ASK_UNREACHABLE";
  state: "partial";
  message: string;
}

/**
 * Creates only ordinary persisted Pi sessions and registered git workspaces.
 * There is deliberately no fixture HTTP route: production project, workspace,
 * session, Files, Git, and Terminal controllers observe these files normally.
 */
export async function buildControlledSessionFixture(options: ControlledSessionFixtureOptions): Promise<ControlledSessionFixture> {
  const root = requireOwnedRoot(options.root);
  requireOwnedPath(root, options.projectsFile, "projectsFile");
  requireOwnedPath(root, options.machinesFile, "machinesFile");
  requireOwnedPath(root, options.sessionDir, "sessionDir");
  await Promise.all([mkdir(options.sessionDir, { recursive: true, mode: 0o700 }), mkdir(dirname(options.projectsFile), { recursive: true, mode: 0o700 })]);

  const anchors: ControlledSessionAnchor[] = [];
  const projects = [];
  for (let index = 0; index < SESSION_IDS.length; index += 1) {
    const ordinal = index + 1;
    const projectId = `fixture-project-${String(ordinal)}`;
    const projectDir = join(root, "workspaces", `anchor-${String(ordinal)}`);
    const cwd = await createDeterministicRepository(projectDir, ordinal);
    const workspaceId = workspaceIdentity(projectId, cwd);
    const sessionId = SESSION_IDS[index];
    const displayName = DISPLAY_NAMES[index];
    if (sessionId === undefined || displayName === undefined) throw new Error("Controlled fixture identity table is incomplete");
    const transcriptMarker = `controlled-transcript-${String(ordinal)}`;
    writeControlledSession(options.sessionDir, { sessionId, cwd, displayName, transcriptMarker, ordinal });
    projects.push({ id: projectId, name: `Controlled project ${String(ordinal)}`, path: cwd, createdAt: CONTROLLED_FIXTURE_CLOCK });
    anchors.push({ sessionId, machineId: "local", projectId, workspaceId, cwd, displayName, transcriptMarker });
  }
  await writeJson(options.projectsFile, { projects });
  await writeJson(options.machinesFile, { machines: [] });

  return {
    fixedClock: CONTROLLED_FIXTURE_CLOCK,
    anchors,
    blockers: [{
      code: "LIVE_ASK_UNREACHABLE",
      state: "partial",
      message: "PI WEB pending asks are daemon-memory state opened only by an executing ask_user tool call. Persisted transcript entries expose completed asks but cannot create a live pending ask through a bounded production seam without running an agent/model or substituting the real sessiond.",
    }],
  };
}

async function createDeterministicRepository(path: string, ordinal: number): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(path, "README.md"), `# Controlled workspace ${String(ordinal)}\n\nFiles surface marker: fixture-file-${String(ordinal)}\n`, "utf8");
  await writeFile(join(path, "tracked.txt"), `committed-${String(ordinal)}\n`, "utf8");
  const gitEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? path,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(dirname(path), ".controlled-fixture-gitconfig"),
    GIT_AUTHOR_NAME: "PI WEB Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "PI WEB Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: CONTROLLED_FIXTURE_CLOCK,
    GIT_COMMITTER_DATE: CONTROLLED_FIXTURE_CLOCK,
  };
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=controlled"], { cwd: path, env: gitEnv });
  await execFileAsync("git", ["add", "README.md", "tracked.txt"], { cwd: path, env: gitEnv });
  await execFileAsync("git", ["commit", "--quiet", "-m", `Controlled fixture ${String(ordinal)}`], { cwd: path, env: gitEnv });
  await writeFile(join(path, "tracked.txt"), `committed-${String(ordinal)}\nworking-tree-change-${String(ordinal)}\n`, "utf8");
  await writeFile(join(path, `untracked-${String(ordinal)}.txt`), `git-surface-marker-${String(ordinal)}\n`, "utf8");
  return realpath(path);
}

function writeControlledSession(sessionDir: string, input: { sessionId: string; cwd: string; displayName: string; transcriptMarker: string; ordinal: number }): void {
  // SessionManager is the canonical Pi persistence writer. The fixture supplies
  // only its documented id option and append/branch APIs; no private JSONL
  // shape is fabricated. Message clocks are explicit and the manager's entry
  // clock is bounded to the same fixed instant for the duration of this write.
  withFixedDate(CONTROLLED_FIXTURE_CLOCK, () => {
    const manager = SessionManager.create(input.cwd, sessionDir, { id: input.sessionId });
    manager.appendModelChange("controlled-fixture", "no-model");
    manager.appendThinkingLevelChange("off");
    manager.appendSessionInfo(input.displayName);
    const baseMs = Date.parse(CONTROLLED_FIXTURE_CLOCK) + input.ordinal * 60_000;
    for (let turn = 0; turn < 64; turn += 1) {
      const userId = manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: `${input.transcriptMarker} page ${String(turn + 1)}` }],
        timestamp: baseMs + 100 + turn * 20,
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Deterministic reply ${String(turn + 1)} for anchor ${String(input.ordinal)}.` }],
        api: "anthropic-messages",
        provider: "controlled-fixture",
        model: "no-model",
        usage: usage(100 + turn, 20),
        stopReason: "stop",
        timestamp: baseMs + 110 + turn * 20,
      });
      if (turn === 20) {
        manager.branch(userId);
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: `Alternate deterministic branch for anchor ${String(input.ordinal)}.` }],
          api: "anthropic-messages",
          provider: "controlled-fixture",
          model: "no-model",
          usage: usage(10, 5),
          stopReason: "stop",
          timestamp: baseMs + 115 + turn * 20,
        });
      }
    }
  });
}

function usage(input: number, output: number) {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function withFixedDate<T>(timestamp: string, operation: () => T): T {
  const NativeDate = Date;
  const fixedMs = NativeDate.parse(timestamp);
  class FixedDate extends NativeDate {
    constructor(value?: string | number | Date) { super(value ?? fixedMs); }
    static override now(): number { return fixedMs; }
  }
  Object.defineProperty(globalThis, "Date", { configurable: true, writable: true, value: FixedDate });
  try { return operation(); }
  finally { Object.defineProperty(globalThis, "Date", { configurable: true, writable: true, value: NativeDate }); }
}
function workspaceIdentity(projectId: string, path: string): string { return createHash("sha1").update(`${projectId}:${path}`).digest("hex").slice(0, 12); }
async function writeJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function requireOwnedRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error("Controlled fixture root must be absolute");
  return resolve(value);
}
function requireOwnedPath(root: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const rel = relative(root, resolve(value));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return value;
  throw new Error(`${label} must stay under the controlled fixture root`);
}
