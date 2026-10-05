import { appendFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiSessionManagerGateway, defaultPiSessionDir, defaultPiSessionsRoot, filterSessionsForCwd, locateSessionInDirs, resolveSessionFileInDir, SessionDirResolver } from "./piSessionManagerGateway.js";
import { DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT } from "./transcriptBranchCache.js";
import type { PiSessionListEntry } from "./piSessionService.js";
import type { PiSessionManager } from "./piSessionService.js";
import { readSessionHeaderSummary } from "./sessionFileHeader.js";
import { SessionSummaryScanner } from "./sessionSummaryScanner.js";

// Pass-through spy so tests can count the gateway's own header reads.
vi.mock("./sessionFileHeader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./sessionFileHeader.js")>();
  return { ...original, readSessionHeaderSummary: vi.fn(original.readSessionHeaderSummary) };
});
import { isRecord } from "./sessionFileFormat.js";
import { rewriteHeaderWithoutParentSession } from "./sessionFileRewrite.testSupport.js";
import { sep } from "node:path";

let tempDir: string;
let agentDir: string;
let cwd: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-session-gateway-test-"));
  agentDir = join(tempDir, "agent");
  cwd = join(tempDir, "workspace");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("SessionDirResolver", () => {
  it("uses Pi default session storage when no Pi override is configured", () => {
    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "pi-default", sessionDir: defaultPiSessionDir(cwd, agentDir), usesConfiguredSessionDir: false });
    expect(defaultPiSessionsRoot(agentDir)).toBe(join(agentDir, "sessions"));
  });

  it("uses Pi sessionDir settings and resolves relative paths against the session cwd", async () => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: ".pi/sessions" }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "settings", sessionDir: join(cwd, ".pi", "sessions"), usesConfiguredSessionDir: true });
  });

  it("lets project-local Pi sessionDir settings override global Pi settings for that cwd", async () => {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "global-sessions") }, null, 2)}\n`, "utf8");
    await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify({ sessionDir: ".workspace-sessions" }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions());

    expect(resolver.resolve(cwd)).toMatchObject({ source: "settings", sessionDir: join(cwd, ".workspace-sessions"), usesConfiguredSessionDir: true });
  });

  it("lets the Pi sessionDir environment override Pi settings", async () => {
    const envDir = join(tempDir, "env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: envDir }));

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: envDir, usesConfiguredSessionDir: true });
  });

  it("uses PI WEB sessionDir environment overrides before settings", async () => {
    const envDir = join(tempDir, "pi-web-env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions({ PI_WEB_AGENT_SESSION_DIR: envDir }));

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: envDir, usesConfiguredSessionDir: true });
  });

  it("prefers the deprecated PI WEB session directory alias over the canonical env var", async () => {
    const aliasDir = join(tempDir, "pi-web-env-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ sessionDir: join(tempDir, "settings-sessions") }, null, 2)}\n`, "utf8");

    const resolver = new SessionDirResolver(piProfileOptions({
      PI_WEB_AGENT_SESSION_DIR: aliasDir,
      PI_CODING_AGENT_SESSION_DIR: join(tempDir, "pi-env-sessions"),
    }));

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: aliasDir, usesConfiguredSessionDir: true });
  });

  it("snapshots the daemon epoch's injected session-directory environment", () => {
    const firstDir = join(tempDir, "first-env-sessions");
    const env = { PI_WEB_AGENT_SESSION_DIR: firstDir };
    const resolver = new SessionDirResolver({ agentDir, env });

    env.PI_WEB_AGENT_SESSION_DIR = join(tempDir, "mutated-env-sessions");

    expect(resolver.resolve(cwd)).toMatchObject({ source: "env", sessionDir: firstDir, usesConfiguredSessionDir: true });
  });
});

describe("Pi session manager gateway", () => {
  it("lists sessions across the default Pi session store", async () => {
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-a", cwd);
    await writeSessionFile(defaultPiSessionDir(otherCwd, agentDir), "session-b", otherCwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "session-a", cwd }), expect.objectContaining({ id: "session-b", cwd: otherCwd })]));
  });

  it("lists the newest sessions across every project with a global limit", async () => {
    const otherCwd = join(tempDir, "other-workspace");
    const oldestDir = defaultPiSessionDir(cwd, agentDir);
    const newestDir = defaultPiSessionDir(otherCwd, agentDir);
    await writeSessionFile(oldestDir, "oldest", cwd);
    await writeSessionFile(oldestDir, "middle", cwd);
    await writeSessionFile(newestDir, "newest", otherCwd);
    await utimes(join(oldestDir, "oldest.jsonl"), new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    await utimes(join(oldestDir, "middle.jsonl"), new Date("2026-01-02T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"));
    await utimes(join(newestDir, "newest.jsonl"), new Date("2026-01-03T00:00:00.000Z"), new Date("2026-01-03T00:00:00.000Z"));
    const gateway = createPiSessionManagerGateway(piProfileOptions());
    if (gateway.listRecent === undefined) throw new Error("Gateway recent listing is unavailable");

    await expect(gateway.listRecent(2)).resolves.toMatchObject([
      { id: "newest", cwd: otherCwd },
      { id: "middle", cwd },
    ]);
  });

  it("locates a session across projects from its file header without scanning transcripts", async () => {
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "other-session", cwd);
    await writeSessionFile(defaultPiSessionDir(otherCwd, agentDir), "target-session", otherCwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions());
    if (gateway.locate === undefined) throw new Error("Gateway locate is unavailable");

    await expect(gateway.locate("target-session")).resolves.toEqual({ cwd: otherCwd });
  });

  it("includes an absolute env-configured session directory in global listing", async () => {
    const envSessionDir = join(tempDir, "env-sessions");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "default-session", cwd);
    await writeSessionFile(envSessionDir, "env-session", cwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: envSessionDir }));

    await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "default-session", cwd }), expect.objectContaining({ id: "env-session", cwd })]));
  });

  it("includes generic env session directories in global listing", async () => {
    for (const envKey of ["PI_WEB_AGENT_SESSION_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
      const envSessionDir = join(tempDir, `${envKey.toLowerCase()}-sessions`);
      await writeSessionFile(envSessionDir, `${envKey.toLowerCase()}-session`, cwd);
      const gateway = createPiSessionManagerGateway({
        agentDir,
        env: { [envKey]: envSessionDir },
      });

      await expect(gateway.listAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: `${envKey.toLowerCase()}-session`, cwd })]));
    }
  });

  it("lists only sessions for the requested cwd when a custom Pi sessionDir is shared", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const otherCwd = join(tempDir, "other-workspace");
    await writeSessionFile(sharedSessionDir, "session-a", cwd);
    await writeSessionFile(sharedSessionDir, "session-b", otherCwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-a", cwd }]);
    const created = gateway.create(cwd);
    expect(hasSessionDir(created)).toBe(true);
    if (!hasSessionDir(created)) throw new Error("Expected SDK session manager");
    expect(created.getSessionDir()).toBe(sharedSessionDir);
  });

  it("lists sessions for cwds that differ from the server process cwd", async () => {
    // Regression: SessionManager.list("", dir) filtered against process.cwd(),
    // hiding every session outside the daemon's own launch directory.
    expect(cwd).not.toBe(process.cwd());
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-elsewhere", cwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-elsewhere", cwd }]);
  });

  it("summarizes sessions whose transcript bodies contain unreadable lines", async () => {
    // The lightweight listing reads header + summary fields only; a corrupt or
    // half-written transcript line must not break the listing.
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await mkdir(sharedSessionDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "session-rough", timestamp: "2026-01-01T00:00:00.000Z", cwd }),
      '{"type":"message","id":"half-written"',
      JSON.stringify({ type: "message", id: "m1", parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    ];
    await writeFile(join(sharedSessionDir, "rough.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-rough", cwd, messageCount: 1, firstMessage: "hello" }]);
  });

  it("keeps repeated listings fresh when a transcript grows", async () => {
    // The gateway keeps one memoized scanner for its lifetime, so a second
    // listing of the same directory must reflect appends, not stale cache.
    const sharedSessionDir = join(tempDir, "memo-sessions");
    const message = (id: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    const path = await writeNamedSessionFile(sharedSessionDir, "memo.jsonl", { id: "memo-session", cwd });
    await appendFile(path, `${message("m1", "user", "hello")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "memo-session", cwd, messageCount: 1, firstMessage: "hello" }]);

    await appendFile(path, `${message("m2", "assistant", "hi there")}\n${message("m3", "user", "follow-up")}\n`, "utf8");

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "memo-session", cwd, messageCount: 3, firstMessage: "hello" }]);
  });

  it("opens a fresh transcript snapshot after another process appends", async () => {
    const sharedSessionDir = join(tempDir, "snapshot-sessions");
    const path = await writeNamedSessionFile(sharedSessionDir, "snapshot.jsonl", { id: "snapshot-session", cwd });
    const message = (id: string, parentId: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    await appendFile(path, `${message("m1", "root", "user", "before")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");
    const before = await readFile(path);

    await expect(gateway.readBranch(path)).resolves.toHaveLength(1);
    await expect(readFile(path)).resolves.toEqual(before);
    await appendFile(path, `${message("m2", "m1", "assistant", "after")}\n`, "utf8");

    await expect(gateway.readBranch(path)).resolves.toHaveLength(2);
  });

  it("reads all branches for media from the same memoized, append-aware, read-only snapshot", async () => {
    const store = join(tempDir, "all-entries");
    const path = await writeNamedSessionFile(store, "media.jsonl", { id: "media-session", cwd });
    const entry = (id: string, parentId: string | null) => ({ type: "message", id, parentId, message: { role: "user", content: id } });
    await appendFile(path, [entry("root", null), entry("abandoned", "root"), entry("selected", "root")].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const before = await readFile(path);
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: store }));
    if (gateway.readEntries === undefined || gateway.readBranch === undefined) throw new Error("Expected transcript readers");
    const entries = await gateway.readEntries(path);
    expect(entries).toHaveLength(3);
    const branch = await gateway.readBranch(path);
    expect(branch).toEqual([entries?.[0], entries?.[2]]);
    expect(branch?.[0]).toBe(entries?.[0]);
    expect(await gateway.readEntries(path)).toBe(entries);
    await expect(readFile(path)).resolves.toEqual(before);
    await appendFile(path, JSON.stringify(entry("external", "abandoned")) + "\n");
    const appended = await gateway.readEntries(path);
    expect(appended).toHaveLength(4);
    expect(appended?.[0]).toBe(entries?.[0]);
    expect(await gateway.readBranch(path)).toEqual([appended?.[0], appended?.[1], appended?.[3]]);
  });

  it("serves repeated snapshots of an unchanged file from the memo", async () => {
    const sharedSessionDir = join(tempDir, "memoized-snapshots");
    const path = await writeNamedSessionFile(sharedSessionDir, "memoized.jsonl", { id: "memoized-session", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");

    const first = await gateway.readBranch(path);
    // Identity, not just equality: an unchanged file must not be re-parsed.
    expect(await gateway.readBranch(path)).toBe(first);
  });

  it("resolves no snapshot for a transcript path with no file on disk, without memoizing the miss", async () => {
    // A session created in memory and never persisted knows its future path,
    // but there is no file: absence must read as "no snapshot", not ENOENT.
    const sharedSessionDir = join(tempDir, "absent-snapshots");
    const path = join(sharedSessionDir, "absent.jsonl");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");

    await expect(gateway.readBranch(path)).resolves.toBeUndefined();

    // The miss is not memoized: once the file exists, the same path serves it.
    await writeNamedSessionFile(sharedSessionDir, "absent.jsonl", { id: "absent-session", cwd });
    await appendFile(path, `${JSON.stringify({ type: "message", id: "m1", parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "persisted later" }] } })}\n`, "utf8");

    await expect(gateway.readBranch(path)).resolves.toHaveLength(1);
  });

  it("bounds memoized snapshots, re-reading a file whose snapshot was evicted", async () => {
    // The daemon outlives any one session: polling many distinct sessions must
    // not accumulate their parsed transcripts without limit. Filling the memo
    // past its bound evicts the least recently used snapshot, so the next read
    // of that file parses it again (fresh instance, same content).
    const sharedSessionDir = join(tempDir, "bounded-snapshots");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");
    const firstPath = await writeNamedSessionFile(sharedSessionDir, "bounded-0.jsonl", { id: "bounded-0", cwd });
    await appendFile(firstPath, `${JSON.stringify({ type: "message", id: "m1", parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "evicted and re-read" }] } })}\n`, "utf8");

    const first = await gateway.readBranch(firstPath);
    for (let i = 1; i < DEFAULT_TRANSCRIPT_BRANCH_CACHE_LIMIT; i += 1) {
      await gateway.readBranch(await writeNamedSessionFile(sharedSessionDir, `bounded-${String(i)}.jsonl`, { id: `bounded-${String(i)}`, cwd }));
    }
    // One read beyond the bound evicts the oldest snapshot (firstPath's).
    await gateway.readBranch(await writeNamedSessionFile(sharedSessionDir, "bounded-overflow.jsonl", { id: "bounded-overflow", cwd }));

    const reread = await gateway.readBranch(firstPath);
    expect(reread).not.toBe(first);
    expect(reread).toEqual(first);
  });

  it("extends a memoized snapshot from only the appended bytes when the file grows", async () => {
    const sharedSessionDir = join(tempDir, "growing-snapshots");
    const path = await writeNamedSessionFile(sharedSessionDir, "growing.jsonl", { id: "growing-session", cwd });
    await appendFile(path, `${snapshotMessage("m1", "root", "before")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");

    const first = await gateway.readBranch(path);
    await appendFile(path, `${snapshotMessage("m2", "m1", "middle")}\n`, "utf8");
    const second = await gateway.readBranch(path);
    await appendFile(path, `${snapshotMessage("m3", "m2", "after")}\n`, "utf8");
    const third = await gateway.readBranch(path);

    expect(branchIds(second)).toEqual(["m1", "m2"]);
    expect(branchIds(third)).toEqual(["m1", "m2", "m3"]);
    // Identity, not just equality: re-reading the whole file would mint fresh
    // objects for the prefix, so identical instances prove only the appended
    // bytes were parsed and folded into the memoized entries.
    expect(second).not.toBe(first);
    expect(second?.[0]).toBe(first?.[0]);
    expect(third?.[0]).toBe(first?.[0]);
    expect(third?.[1]).toBe(second?.[1]);
  });

  it("re-reads the whole transcript when the file shrinks", async () => {
    // Truncation breaks the append assumption: the memoized size no longer
    // marks a prefix of the file, so the snapshot must be rebuilt whole.
    const sharedSessionDir = join(tempDir, "shrinking-snapshots");
    const path = await writeNamedSessionFile(sharedSessionDir, "shrinking.jsonl", { id: "shrinking-session", cwd });
    await appendFile(path, `${snapshotMessage("m1", "root", "kept")}\n${snapshotMessage("m2", "m1", "dropped")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");
    const first = await gateway.readBranch(path);

    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "shrinking-session", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n${snapshotMessage("m1", "root", "kept")}\n`, "utf8");
    const second = await gateway.readBranch(path);

    expect(branchIds(second)).toEqual(["m1"]);
    // A full re-read mints fresh objects even where content is unchanged.
    expect(second?.[0]).not.toBe(first?.[0]);
  });

  it("re-reads the whole transcript when the file is replaced", async () => {
    // A rename swaps the inode, so the memoized prefix belongs to a different
    // file and the replacement must be parsed whole.
    const sharedSessionDir = join(tempDir, "replaced-snapshots");
    const path = await writeNamedSessionFile(sharedSessionDir, "replaced.jsonl", { id: "replaced-session", cwd });
    await appendFile(path, `${snapshotMessage("m1", "root", "original")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");
    const first = await gateway.readBranch(path);

    const replacement = join(sharedSessionDir, "replacement.jsonl");
    await writeFile(replacement, `${JSON.stringify({ type: "session", version: 3, id: "replaced-session", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n${snapshotMessage("n1", "root", "replacement")}\n`, "utf8");
    await rename(replacement, path);
    const second = await gateway.readBranch(path);

    expect(branchIds(second)).toEqual(["n1"]);
    expect(second?.[0]).not.toBe(first?.[0]);
  });

  it("re-reads the whole transcript when the appended bytes do not start with a parseable line", async () => {
    // A corrupt first appended line means the memoized size did not mark a
    // real line boundary (or a writer emitted garbage): fall back to a full
    // re-read, which skips the corrupt line the way it always has.
    const sharedSessionDir = join(tempDir, "corrupt-append-snapshots");
    const path = await writeNamedSessionFile(sharedSessionDir, "corrupt-append.jsonl", { id: "corrupt-append-session", cwd });
    await appendFile(path, `${snapshotMessage("m1", "root", "before")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");
    const first = await gateway.readBranch(path);

    await appendFile(path, `{"type":"message","id":"broken"\n${snapshotMessage("m2", "m1", "after")}\n`, "utf8");
    const second = await gateway.readBranch(path);

    expect(branchIds(second)).toEqual(["m1", "m2"]);
    expect(second?.[0]).not.toBe(first?.[0]);
  });

  it("re-reads the whole transcript when the memoized prefix no longer ends on a line boundary", async () => {
    // The byte before the append offset must be a newline; otherwise the
    // cached size is not a line boundary in the file's current content and
    // the tail read cannot be trusted. Here the cached parse ended at an
    // unterminated last line, so the next append lands mid-line.
    const sharedSessionDir = join(tempDir, "unterminated-snapshots");
    const path = await writeNamedSessionFile(sharedSessionDir, "unterminated.jsonl", { id: "unterminated-session", cwd });
    await appendFile(path, snapshotMessage("m1", "root", "unterminated"), "utf8"); // no trailing newline
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    if (gateway.readBranch === undefined) throw new Error("Expected transcript snapshot reader");
    const first = await gateway.readBranch(path);

    await appendFile(path, `\n${snapshotMessage("m2", "m1", "after")}\n`, "utf8");
    const second = await gateway.readBranch(path);

    expect(branchIds(second)).toEqual(["m1", "m2"]);
    expect(second?.[0]).not.toBe(first?.[0]);
  });

  it("invalidateSessionFile drops the memo for a header rewritten in place", async () => {
    // Detach rewrites the header with a truncate+write that keeps the inode
    // (mirrored here, padded back to the memoized size) — the one rewrite the
    // memo's identity + size key cannot see, so without an explicit
    // invalidation the stat-only fast path keeps serving the old parent link.
    const sharedSessionDir = join(tempDir, "detach-sessions");
    const message = (id: string, role: string, text: string) =>
      JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
    const path = await writeNamedSessionFile(sharedSessionDir, "detached.jsonl", { id: "detached-session", cwd, parentSession: "/parents/detached.jsonl" });
    await appendFile(path, `${message("m1", "user", "first")}\n${message("m2", "assistant", "second")}\n`, "utf8");
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "detached-session", cwd, messageCount: 2, parentSessionPath: "/parents/detached.jsonl" }]);

    await rewriteHeaderWithoutParentSession(path);
    gateway.invalidateSessionFile(path);

    const [listed] = await gateway.list(cwd);
    expect(listed).toMatchObject({ id: "detached-session", cwd, messageCount: 2 });
    expect(listed).not.toHaveProperty("parentSessionPath");
    // Invalidating a path that was never memoized is a no-op.
    expect(() => {
      gateway.invalidateSessionFile(join(sharedSessionDir, "missing.jsonl"));
    }).not.toThrow();
  });
});

describe("gateway session-file resolution by id", () => {
  it("resolves a session from the id embedded in its file name without scanning other headers", async () => {
    // Directory enumeration chooses candidates; the injected reader proves an
    // exact filename match does not read unrelated session headers.
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const targetPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_target-id.jsonl", { id: "target-id", cwd });
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-01-000Z_other-id.jsonl", { id: "other-id", cwd });
    const readPaths: string[] = [];
    const readHeader = async (sessionFile: string) => {
      readPaths.push(sessionFile);
      return readSessionHeaderSummary(sessionFile);
    };

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "target-id", readHeader)).resolves.toEqual({ id: "target-id", cwd, path: targetPath });
    expect(readPaths).toEqual([targetPath]);
  });

  it("resolves through the session directory the gateway is configured with", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const targetPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_configured-id.jsonl", { id: "configured-id", cwd });
    await writeNamedSessionFile(join(tempDir, "unconfigured-sessions"), "2026-01-01T00-00-00-000Z_elsewhere-id.jsonl", { id: "elsewhere-id", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));

    await expect(gateway.resolveSessionFile(cwd, "configured-id")).resolves.toEqual({ id: "configured-id", cwd, path: targetPath });
    await expect(gateway.resolveSessionFile(cwd, "elsewhere-id")).resolves.toBeUndefined();
  });

  it("resolveSessionFile does not call list while a listing is in flight", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const targetPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_direct-id.jsonl", { id: "direct-id", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sharedSessionDir }));
    let releaseList!: (sessions: PiSessionListEntry[]) => void;
    const pendingList = new Promise<PiSessionListEntry[]>((resolve) => {
      releaseList = resolve;
    });
    let reportUnexpectedListCall!: () => void;
    const unexpectedListCall = new Promise<void>((resolve) => {
      reportUnexpectedListCall = () => {
        resolve();
      };
    });
    let listCallCount = 0;
    const list = vi.spyOn(gateway, "list").mockImplementation(() => {
      listCallCount += 1;
      if (listCallCount > 1) reportUnexpectedListCall();
      return pendingList;
    });

    // Hold one public listing open. A resolver coupled through `this.list`
    // makes a second call and loses this race while both calls remain pending.
    // This pins that coupling only: it does not detect a resolver that reaches
    // past `list` into the scanner, or one that awaits a shared in-flight
    // listing promise without calling `list` itself.
    const inFlightList = gateway.list(cwd);
    const resolution = gateway.resolveSessionFile(cwd, "direct-id");
    const firstOutcome = await Promise.race([
      resolution.then((match) => ({ kind: "resolved" as const, match })),
      unexpectedListCall.then(() => ({ kind: "list-called" as const })),
    ]);
    releaseList([]);
    await Promise.allSettled([inFlightList, resolution]);

    expect(firstOutcome).toEqual({ kind: "resolved", match: { id: "direct-id", cwd, path: targetPath } });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("resolves an id prefix the same way a listing match would", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const targetPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_0199f3a2-prefix-session.jsonl", { id: "0199f3a2-prefix-session", cwd });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "0199f3a2", readSessionHeaderSummary)).resolves.toEqual({ id: "0199f3a2-prefix-session", cwd, path: targetPath });
  });

  it("falls back to header reads when the file name does not embed the id", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const renamedPath = await writeNamedSessionFile(sharedSessionDir, "hand-renamed.jsonl", { id: "renamed-session", cwd });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "renamed-session", readSessionHeaderSummary)).resolves.toEqual({ id: "renamed-session", cwd, path: renamedPath });
  });

  it("trusts the header over a file name that embeds a different session id", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const copiedPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_original-id.jsonl", { id: "copied-id", cwd });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "original-id", readSessionHeaderSummary)).resolves.toBeUndefined();
    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "copied-id", readSessionHeaderSummary)).resolves.toEqual({ id: "copied-id", cwd, path: copiedPath });
  });

  it("does not let a failing filename candidate shadow a renamed file that really holds the session", async () => {
    // A copy whose name embeds the requested id but whose header holds another
    // session must not end the search: the remaining files are checked too.
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_target-session.jsonl", { id: "unrelated-session", cwd });
    const renamedPath = await writeNamedSessionFile(sharedSessionDir, "hand-renamed.jsonl", { id: "target-session", cwd });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "target-session", readSessionHeaderSummary)).resolves.toEqual({ id: "target-session", cwd, path: renamedPath });
  });

  it("prefers an exact header id over a newer prefix match", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-02T00-00-00-000Z_abc123-extended.jsonl", { id: "abc123-extended", cwd });
    const exactPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_abc123.jsonl", { id: "abc123", cwd });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "abc123", readSessionHeaderSummary)).resolves.toEqual({ id: "abc123", cwd, path: exactPath });
  });

  it("prefers an exact header id in a renamed file over a prefix-matching filename candidate", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_target-session.jsonl", { id: "target-session-extended", cwd });
    const renamedPath = await writeNamedSessionFile(sharedSessionDir, "archived.jsonl", { id: "target-session", cwd });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "target-session", readSessionHeaderSummary)).resolves.toEqual({ id: "target-session", cwd, path: renamedPath });
  });

  it("resolves ambiguous prefixes deterministically by newest embedded timestamp, then plain name order", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    // Written newest-last on purpose: readdir order must not influence the outcome.
    const newestPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-02T00-00-00-000Z_abc-two.jsonl", { id: "abc-two", cwd });
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_abc-one.jsonl", { id: "abc-one", cwd });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "abc", readSessionHeaderSummary)).resolves.toEqual({ id: "abc-two", cwd, path: newestPath });

    // Same embedded timestamp: plain (non-locale) code-unit order decides, so
    // the id starting with a lowercase letter sorts after the uppercase one
    // and wins. The names must differ by more than case: case-insensitive
    // filesystems (Windows CI) collapse case-only variants into one file. A
    // locale-aware comparison would rank Z after a and flip the winner, so
    // this still catches a drift away from code-unit order.
    const tiedDir = join(tempDir, "tied-sessions");
    await writeNamedSessionFile(tiedDir, "2026-01-03T00-00-00-000Z_abc-ZZZ.jsonl", { id: "abc-ZZZ", cwd });
    const tiedWinnerPath = await writeNamedSessionFile(tiedDir, "2026-01-03T00-00-00-000Z_abc-aaa.jsonl", { id: "abc-aaa", cwd });

    await expect(resolveSessionFileInDir(tiedDir, cwd, "abc", readSessionHeaderSummary)).resolves.toEqual({ id: "abc-aaa", cwd, path: tiedWinnerPath });
  });

  it("does not resolve sessions that belong to another cwd", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    const otherCwd = join(tempDir, "other-workspace");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_elsewhere.jsonl", { id: "elsewhere", cwd: otherCwd });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "elsewhere", readSessionHeaderSummary)).resolves.toBeUndefined();
  });

  it("ignores sessions whose header has no cwd, like a listing would", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_legacy.jsonl", { id: "legacy" });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "legacy", readSessionHeaderSummary)).resolves.toBeUndefined();
  });

  it("canonicalizes the header cwd it reports", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_messy.jsonl", { id: "messy", cwd: `${cwd}${sep}.${sep}` });

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "messy", readSessionHeaderSummary)).resolves.toMatchObject({ id: "messy", cwd });
  });

  it("resolves nothing when the session directory does not exist", async () => {
    await expect(resolveSessionFileInDir(join(tempDir, "missing-sessions"), cwd, "any-session", readSessionHeaderSummary)).resolves.toBeUndefined();
  });

  it("reads the headers of a miss concurrently, within a bound", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    for (let index = 0; index < 60; index += 1) {
      await writeNamedSessionFile(sharedSessionDir, `2026-01-01T00-00-${String(index).padStart(2, "0")}-000Z_other-${String(index)}.jsonl`, { id: `other-${String(index)}`, cwd });
    }
    const reader = concurrencyTrackingReader();

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "missing-id", reader.read)).resolves.toBeUndefined();
    expect(reader.reads()).toBe(60);
    expect(reader.maxInFlight()).toBeGreaterThan(1);
    expect(reader.maxInFlight()).toBeLessThanOrEqual(32);
  });

  it("keeps bucket, exact-over-prefix, and newest-first order when header reads finish out of order", async () => {
    const sharedSessionDir = join(tempDir, "shared-sessions");
    await writeNamedSessionFile(sharedSessionDir, "2026-01-01T00-00-00-000Z_abc-one.jsonl", { id: "abc-one", cwd });
    const newestPath = await writeNamedSessionFile(sharedSessionDir, "2026-01-02T00-00-00-000Z_abc-two.jsonl", { id: "abc-two", cwd });
    await writeNamedSessionFile(sharedSessionDir, "hand-1.jsonl", { id: "abc-hand-1", cwd });
    await writeNamedSessionFile(sharedSessionDir, "hand-2.jsonl", { id: "abc-hand-2", cwd });
    // Later candidates finish first, so completion order cannot pick the winner.
    const reader = reverseCompletionReader(["abc-two", "abc-one", "hand-2", "hand-1", "renamed"]);

    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "abc", reader)).resolves.toEqual({ id: "abc-two", cwd, path: newestPath });

    const exactPath = await writeNamedSessionFile(sharedSessionDir, "renamed.jsonl", { id: "abc", cwd });
    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "abc", reader)).resolves.toEqual({ id: "abc", cwd, path: exactPath });

    // No filename candidate: the remaining files decide, tied timestamps by plain name order.
    await expect(resolveSessionFileInDir(sharedSessionDir, cwd, "abc-hand", reader)).resolves.toEqual({ id: "abc-hand-2", cwd, path: join(sharedSessionDir, "hand-2.jsonl") });
  });
});

describe("locating sessions across session directories", () => {
  it("reads the headers of a miss concurrently across directories, within a bound", async () => {
    const dirs = ["a", "b", "c"].map((name) => join(tempDir, "store", name));
    for (const dir of dirs) {
      for (let index = 0; index < 20; index += 1) await writeNamedSessionFile(dir, `2026-01-01T00-00-${String(index).padStart(2, "0")}-000Z_s-${String(index)}.jsonl`, { id: `s-${String(index)}`, cwd });
    }
    const reader = concurrencyTrackingReader();

    await expect(locateSessionInDirs(dirs, "missing-id", reader.read)).resolves.toBeUndefined();
    expect(reader.reads()).toBe(60);
    expect(reader.maxInFlight()).toBeGreaterThan(1);
    expect(reader.maxInFlight()).toBeLessThanOrEqual(32);
  });

  it("prefers an exact header id over a newer prefix match across directories when reads finish out of order", async () => {
    const otherCwd = join(tempDir, "other-workspace");
    const dirs = [join(tempDir, "store", "a"), join(tempDir, "store", "b")];
    await writeNamedSessionFile(dirs[0] ?? "", "2026-01-02T00-00-00-000Z_abc-newer.jsonl", { id: "abc-newer", cwd });
    await writeNamedSessionFile(dirs[1] ?? "", "2026-01-01T00-00-00-000Z_abc.jsonl", { id: "abc", cwd: `${otherCwd}${sep}` });
    await writeNamedSessionFile(dirs[1] ?? "", "2026-01-03T00-00-00-000Z_abc-no-cwd.jsonl", { id: "abc-no-cwd" });
    const reader = reverseCompletionReader(["abc-no-cwd", "abc-newer", "abc"]);

    await expect(locateSessionInDirs(dirs, "abc", reader)).resolves.toEqual({ cwd: otherCwd });
    await expect(locateSessionInDirs(dirs, "abc-n", reader)).resolves.toEqual({ cwd });
  });

  it("shares header reads between concurrent lookups instead of repeating them", async () => {
    for (let index = 0; index < 40; index += 1) await writeSessionFile(defaultPiSessionDir(cwd, agentDir), `stored-${String(index)}`, cwd);
    const gateway = createPiSessionManagerGateway(piProfileOptions());
    if (gateway.locate === undefined) throw new Error("Gateway locate is unavailable");
    const locate = gateway.locate.bind(gateway);
    const readSpy = vi.mocked(readSessionHeaderSummary);
    readSpy.mockClear();

    const located = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((index) => locate(`missing-${String(index)}`)));

    expect(located).toEqual(Array.from({ length: 8 }, () => undefined));
    // Eight independent misses would read every header eight times.
    expect(readSpy.mock.calls.length).toBeLessThanOrEqual(80);
    // Sharing is in flight only: a later lookup reads the headers again.
    readSpy.mockClear();
    await locate("missing-again");
    expect(readSpy.mock.calls.length).toBe(40);
  });

  it("finds a session created after a miss, with no remembered miss", async () => {
    const gateway = createPiSessionManagerGateway(piProfileOptions());
    if (gateway.locate === undefined) throw new Error("Gateway locate is unavailable");
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "existing", cwd);

    await expect(gateway.locate("late-session")).resolves.toBeUndefined();
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "late-session", cwd);
    await expect(gateway.locate("late-session")).resolves.toEqual({ cwd });
  });
});

/** A real header reader that records how many reads overlap. */
function concurrencyTrackingReader() {
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  return {
    read: async (sessionFile: string) => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await readSessionHeaderSummary(sessionFile);
      } finally {
        inFlight -= 1;
      }
    },
    reads: () => reads,
    maxInFlight: () => maxInFlight,
  };
}

/** A real header reader whose reads finish in reverse of the listed file-stem order. */
function reverseCompletionReader(stemsInCandidateOrder: readonly string[]) {
  return async (sessionFile: string) => {
    const stem = sessionFile.slice(sessionFile.lastIndexOf(sep) + 1, -".jsonl".length);
    const order = stemsInCandidateOrder.findIndex((candidate) => stem === candidate || stem.endsWith(`_${candidate}`));
    await new Promise((resolve) => setTimeout(resolve, (stemsInCandidateOrder.length - Math.max(order, 0)) * 5));
    return readSessionHeaderSummary(sessionFile);
  };
}

describe("targeted session listing", () => {
  // Spies on the shared scanner prove the targeted path never lists a directory
  // and summarizes only the one verified file; restored after each test.
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const message = (id: string, role: string, text: string) =>
    JSON.stringify({ type: "message", id, parentId: "root", timestamp: "2026-01-01T00:01:00.000Z", message: { role, content: [{ type: "text", text }] } });
  const sessionInfo = (name: string) => JSON.stringify({ type: "session_info", id: `info-${name}`, parentId: "root", timestamp: "2026-01-01T00:02:00.000Z", name });

  async function targetedStore() {
    const sessionDir = join(tempDir, "targeted-sessions");
    const targetPath = await writeNamedSessionFile(sessionDir, "2026-01-02T00-00-00-000Z_target-id.jsonl", { id: "target-id", cwd });
    await appendFile(targetPath, `${message("m1", "user", "hello")}\n`, "utf8");
    await writeNamedSessionFile(sessionDir, "2026-01-01T00-00-00-000Z_sibling-id.jsonl", { id: "sibling-id", cwd });
    const options = piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sessionDir });
    return { sessionDir, targetPath, gateway: createPiSessionManagerGateway(options), options };
  }

  // Directory scans and single-file summaries are the scanner's only ways to read transcripts.
  function countScannerWork() {
    const directoryScans = vi.spyOn(SessionSummaryScanner.prototype, "scanSessionSummariesInDir");
    const summaryReads = vi.spyOn(SessionSummaryScanner.prototype, "summarizeSessionFile");
    spies.push(directoryScans, summaryReads);
    return { directoryScans, summaryReads };
  }

  it("returns the full listing's exact row from one summary read and no directory scan", async () => {
    const { targetPath, gateway, options } = await targetedStore();
    const full = (await createPiSessionManagerGateway(options).list(cwd)).find((session) => session.id === "target-id");
    expect(full).toBeDefined();
    const { directoryScans, summaryReads } = countScannerWork();

    await expect(gateway.list(cwd, { sessionId: "target-id" })).resolves.toEqual([full]);
    expect(directoryScans).not.toHaveBeenCalled();
    expect(summaryReads.mock.calls).toEqual([[targetPath]]);
  });

  it("stays fresh across appends, renames, and a cleared name", async () => {
    const { targetPath, gateway } = await targetedStore();
    await expect(gateway.list(cwd, { sessionId: "target-id" })).resolves.toMatchObject([{ id: "target-id", messageCount: 1, firstMessage: "hello" }]);

    await appendFile(targetPath, `${message("m2", "assistant", "hi")}\n${sessionInfo("Renamed")}\n`, "utf8");
    await expect(gateway.list(cwd, { sessionId: "target-id" })).resolves.toMatchObject([{ id: "target-id", messageCount: 2, name: "Renamed" }]);

    await appendFile(targetPath, `${sessionInfo("")}\n`, "utf8");
    const [cleared] = await gateway.list(cwd, { sessionId: "target-id" });
    expect(cleared).toMatchObject({ id: "target-id", messageCount: 2 });
    expect(cleared).not.toHaveProperty("name");
  });

  it("stops answering for a session whose file was replaced by another session", async () => {
    const { sessionDir, targetPath, gateway } = await targetedStore();
    await gateway.list(cwd, { sessionId: "target-id" });
    const replacement = await writeNamedSessionFile(sessionDir, "replacement.tmp", { id: "replacement-id", cwd });
    await rename(replacement, targetPath);

    await expect(gateway.list(cwd, { sessionId: "target-id" })).resolves.toEqual([]);
    await expect(gateway.list(cwd, { sessionId: "replacement-id" })).resolves.toMatchObject([{ id: "replacement-id", path: targetPath }]);
  });

  it("re-verifies the summarized file when it is replaced between the header and summary reads", async () => {
    const { sessionDir, targetPath, gateway } = await targetedStore();
    const intruder = await writeNamedSessionFile(sessionDir, "intruder.tmp", { id: "intruder-id", cwd });
    const resolve = gateway.resolveSessionFile.bind(gateway);
    spies.push(vi.spyOn(gateway, "resolveSessionFile").mockImplementationOnce(async (refCwd, sessionId) => {
      const resolved = await resolve(refCwd, sessionId);
      await rename(intruder, targetPath);
      return resolved;
    }));

    await expect(gateway.list(cwd, { sessionId: "target-id" })).resolves.toEqual([]);
  });

  it("never treats an id prefix as the exact requested session", async () => {
    const { gateway } = await targetedStore();
    await expect(gateway.resolveSessionFile(cwd, "target")).resolves.toMatchObject({ id: "target-id" });

    await expect(gateway.list(cwd, { sessionId: "target" })).resolves.toEqual([]);
  });

  it("does not answer for the same id under another cwd", async () => {
    const { gateway } = await targetedStore();
    const otherCwd = join(tempDir, "other-workspace");
    await mkdir(otherCwd, { recursive: true });

    await expect(gateway.list(otherCwd, { sessionId: "target-id" })).resolves.toEqual([]);
  });

  it("finds the real session behind a file name that embeds its id but holds another session", async () => {
    const sessionDir = join(tempDir, "collision-sessions");
    await writeNamedSessionFile(sessionDir, "2026-01-02T00-00-00-000Z_wanted-id.jsonl", { id: "decoy-id", cwd });
    const realPath = await writeNamedSessionFile(sessionDir, "hand-named.jsonl", { id: "wanted-id", cwd });
    const gateway = createPiSessionManagerGateway(piProfileOptions({ PI_CODING_AGENT_SESSION_DIR: sessionDir }));

    await expect(gateway.list(cwd, { sessionId: "wanted-id" })).resolves.toMatchObject([{ id: "wanted-id", path: realPath }]);
  });

  it("keeps the ordinary listing when no session id is given", async () => {
    const { gateway } = await targetedStore();
    const { directoryScans } = countScannerWork();

    expect((await gateway.list(cwd, {})).map((session) => session.id).sort()).toEqual(["sibling-id", "target-id"]);
    expect(directoryScans).toHaveBeenCalledTimes(1);
  });
});

describe("filterSessionsForCwd", () => {
  it("matches cwds that differ only by trailing separator or redundant segments", () => {
    const sessions = [sessionEntry("a", cwd)];

    expect(filterSessionsForCwd(sessions, `${cwd}${sep}`)).toHaveLength(1);
    expect(filterSessionsForCwd(sessions, join(cwd, "."))).toHaveLength(1);
  });

  it("excludes sessions with an empty cwd instead of matching the process cwd", () => {
    expect(filterSessionsForCwd([sessionEntry("a", "")], process.cwd())).toHaveLength(0);
  });

  it("excludes sessions from other cwds", () => {
    expect(filterSessionsForCwd([sessionEntry("a", join(tempDir, "other"))], cwd)).toHaveLength(0);
  });
});

describe("session listing canonicalization", () => {
  it("canonicalizes session header cwds written by external tools", async () => {
    // Headers are written by the Pi CLI / SDK consumers and may contain
    // unnormalized paths (trailing separators, redundant segments).
    await writeSessionFile(defaultPiSessionDir(cwd, agentDir), "session-messy", `${cwd}${sep}.${sep}`);
    const gateway = createPiSessionManagerGateway(piProfileOptions());

    await expect(gateway.list(cwd)).resolves.toMatchObject([{ id: "session-messy", cwd }]);
  });
});

function piProfileOptions(env: NodeJS.ProcessEnv = {}) {
  return { agentDir, env };
}

function hasSessionDir(manager: PiSessionManager): manager is PiSessionManager & { getSessionDir(): string } {
  return "getSessionDir" in manager && typeof manager.getSessionDir === "function";
}

function sessionEntry(id: string, sessionCwd: string): PiSessionListEntry {
  return { path: join(tempDir, `${id}.jsonl`), id, cwd: sessionCwd, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" };
}

/** One transcript message line, as the SDK would append it. */
function snapshotMessage(id: string, parentId: string, text: string): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text }] } });
}

/** The entry ids of a transcript snapshot branch, for content assertions. */
function branchIds(branch: unknown[] | undefined): unknown[] {
  return (branch ?? []).map((entry) => (isRecord(entry) ? entry["id"] : undefined));
}

async function writeSessionFile(dir: string, id: string, sessionCwd: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: sessionCwd })}\n`, "utf8");
}

async function writeNamedSessionFile(dir: string, fileName: string, header: { id: string; cwd?: string; parentSession?: string }): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  const line = { type: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z", ...header };
  await writeFile(path, `${JSON.stringify(line)}\n`, "utf8");
  return path;
}
