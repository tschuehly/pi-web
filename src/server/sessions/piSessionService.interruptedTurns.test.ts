import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_RESTART_CUSTOM_TYPE } from "./interruptedTurns.js";
import { PiSessionService, type PiSessionRuntime } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const SHUTDOWN_AT = "2026-03-01T12:00:00.000Z";
let dir: string;
let recordFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.env["PI_TMP"] ?? tmpdir(), "pi-web-interrupted-turns-"));
  recordFile = join(dir, "interrupted-turns.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A daemon whose sessions open, in order, onto the given fake runtimes. */
function daemon(sessionIds: string[], runtimes: PiSessionRuntime[]) {
  const queue = [...runtimes];
  return new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: "/agent",
    modelRuntime: testModelRuntime,
    sessionManager: sessionGateway(sessionIds.map((id) => sessionRecord(id))),
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: () => {
      const runtime = queue.shift();
      return runtime === undefined ? Promise.reject(new Error("no runtime left")) : Promise.resolve(runtime);
    },
    interruptedTurnsFile: recordFile,
    heartbeatIntervalMs: 60_000,
    now: () => new Date(SHUTDOWN_AT),
  });
}

describe("resume after a daemon restart", () => {
  it("shutdown records only the sessions that were mid-turn", async () => {
    const busy = fakeRuntime("busy");
    const idle = fakeRuntime("idle");
    const service = daemon(["busy", "idle"], [busy.runtime, idle.runtime]);
    await service.status(sessionRef("busy"));
    await service.status(sessionRef("idle"));
    busy.session.isStreaming = true;

    await service.dispose();

    expect(JSON.parse(await readFile(recordFile, "utf8"))).toEqual({
      shutdownAt: SHUTDOWN_AT,
      sessions: [{ sessionId: "busy", cwd: "/workspace", sessionFile: "/tmp/busy.jsonl" }],
    });
  });

  it("shutdown with only idle sessions records nothing", async () => {
    const idle = fakeRuntime("idle");
    const service = daemon(["idle"], [idle.runtime]);
    await service.status(sessionRef("idle"));

    await service.dispose();

    await expect(readFile(recordFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("startup consumes the record once, wakes each reopenable session with one system message, and skips the rest", async () => {
    await writeFile(recordFile, JSON.stringify({
      shutdownAt: SHUTDOWN_AT,
      sessions: [
        { sessionId: "gone", cwd: "/workspace" },
        { sessionId: "busy", cwd: "/workspace", sessionFile: join(dir, "missing.jsonl") },
      ],
    }));
    const busy = fakeRuntime("busy");
    const service = daemon(["busy"], [busy.runtime]);

    await service.resumeInterruptedTurns();
    await service.resumeInterruptedTurns();

    expect(busy.calls.sendCustomMessage).toHaveLength(1);
    const [delivered] = busy.calls.sendCustomMessage;
    expect(delivered?.message).toMatchObject({ customType: DAEMON_RESTART_CUSTOM_TYPE, display: true });
    expect(delivered?.message.content).toBe(
      `The PI WEB session daemon restarted at ${SHUTDOWN_AT}; your previous turn was interrupted. `
      + "Check what had finished (files, background jobs, subagents) before continuing, then continue where you left off.",
    );
    expect(delivered?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(busy.calls.prompt).toEqual([]);
    await expect(readFile(recordFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await service.dispose();
  });

  it("a malformed record is discarded without resuming anything", async () => {
    await writeFile(recordFile, "{not json");
    const service = daemon([], []);

    await service.resumeInterruptedTurns();

    await expect(readFile(recordFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await service.dispose();
  });
});
