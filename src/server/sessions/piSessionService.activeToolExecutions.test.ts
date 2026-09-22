import { describe, expect, it } from "vitest";
import { ACTIVE_TOOL_EXECUTION_LABEL_MAX_LENGTH, ACTIVE_TOOL_EXECUTION_LIMIT } from "../../shared/apiTypes.js";
import { PiSessionService, type PiAgentSession } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, sessionGateway, sessionRecord, sessionRef, testModelRuntime, type RuntimeCreator, type SessionGateway } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-active-tool-executions-test";
const STARTED_AT = "2026-09-21T12:00:00.000Z";

interface BashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createService(hub: CapturingSessionEventHub, createAgentRuntime: RuntimeCreator, records = [sessionRecord("session-1")], sessionManager: SessionGateway = sessionGateway(records)) {
  return new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    archiveStore: emptyArchiveStore(),
    createAgentRuntime,
    sessionManager,
    heartbeatIntervalMs: 60_000,
    now: () => new Date(STARTED_AT),
  });
}

describe("PiSessionService active tool executions", () => {
  it("publishes and replays only the built-in bash execution until its terminal event", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime();
    const service = createService(hub, () => Promise.resolve(fake.runtime));
    try {
      await service.start("/workspace");
      fake.emit({ type: "tool_execution_start", toolCallId: "call-shell", toolName: "shell", args: { command: "printf super-secret" } });
      fake.emit({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "printenv TOKEN" } });
      fake.emit({ type: "tool_execution_start", toolCallId: "call-process", toolName: "process", args: { env: { TOKEN: "super-secret" } } });
      fake.emit({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "/secret" } });

      const first = await service.status(sessionRef("session-1"));
      expect(first.activeToolExecutions).toEqual([
        { id: "tool:call-bash", kind: "shell", toolName: "bash", label: "Shell command", startedAt: STARTED_AT },
      ]);
      expect(JSON.stringify(first.activeToolExecutions)).not.toContain("super-secret");
      await expect(service.status(sessionRef("session-1"))).resolves.toMatchObject({ activeToolExecutions: first.activeToolExecutions });
      expect(hub.globalEvents.filter((event) => event.type === "status.update").at(-1)).toMatchObject({
        type: "status.update",
        status: { activeToolExecutions: first.activeToolExecutions },
      });

      fake.emit({ type: "tool_execution_end", toolCallId: "call-shell", toolName: "shell", isError: true, result: { error: "secret failure" } });
      fake.emit({ type: "tool_execution_end", toolCallId: "call-missing", toolName: "bash", isError: false, result: {} });
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toEqual(first.activeToolExecutions);
      fake.emit({ type: "tool_execution_end", toolCallId: "call-bash", toolName: "bash", isError: false, result: {} });
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });

  it("keeps the bounded snapshot deterministic and labels generic", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime();
    const service = createService(hub, () => Promise.resolve(fake.runtime));
    try {
      await service.start("/workspace");
      for (let index = 0; index < ACTIVE_TOOL_EXECUTION_LIMIT + 4; index += 1) {
        fake.emit({
          type: "tool_execution_start",
          toolCallId: `call-${String(index).padStart(2, "0")}`,
          toolName: "bash",
          args: { command: `echo secret-${String(index)}` },
        });
      }

      const status = await service.status(sessionRef("session-1"));
      const executions = status.activeToolExecutions ?? [];
      expect(executions).toHaveLength(ACTIVE_TOOL_EXECUTION_LIMIT);
      expect(executions.map(({ id }) => id)).toEqual(Array.from(
        { length: ACTIVE_TOOL_EXECUTION_LIMIT },
        (_, index) => `tool:call-${String(index + 4).padStart(2, "0")}`,
      ));
      expect(executions.every(({ label }) => label === "Shell command" && label.length <= ACTIVE_TOOL_EXECUTION_LABEL_MAX_LENGTH)).toBe(true);
      expect(JSON.stringify(executions)).not.toContain("secret-");
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toEqual(executions);

      for (let index = 4; index < ACTIVE_TOOL_EXECUTION_LIMIT + 4; index += 1) {
        fake.emit({ type: "tool_execution_end", toolCallId: `call-${String(index).padStart(2, "0")}`, toolName: "bash", isError: false, result: {} });
      }
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });

  it("cleans up at agent end without affecting another session", async () => {
    const hub = new CapturingSessionEventHub();
    const records = [sessionRecord("session-1"), sessionRecord("session-2")];
    const gateway = sessionGateway(records);
    gateway.open = (path) => {
      const sessionId = path.includes("session-2") ? "session-2" : "session-1";
      return fakeSessionManager("/workspace", { getSessionId: () => sessionId, getSessionFile: () => path });
    };
    const first = fakeRuntime("session-1");
    const second = fakeRuntime("session-2");
    const createAgentRuntime: RuntimeCreator = (_createRuntime, options) => Promise.resolve(
      options.sessionManager.getSessionId() === "session-2" ? second.runtime : first.runtime,
    );
    const service = createService(hub, createAgentRuntime, records, gateway);
    try {
      await service.status(sessionRef("session-1"));
      await service.status(sessionRef("session-2"));
      first.emit({ type: "tool_execution_start", toolCallId: "first", toolName: "bash", args: { command: "sleep 60" } });
      second.emit({ type: "tool_execution_start", toolCallId: "second", toolName: "bash", args: { command: "sleep 60" } });

      first.emit({ type: "agent_end" });
      first.emit({ type: "tool_execution_end", toolCallId: "missing", toolName: "bash", isError: false, result: {} });
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toBeUndefined();
      expect((await service.status(sessionRef("session-2"))).activeToolExecutions?.map(({ id }) => id)).toEqual(["tool:second"]);

      second.emit({ type: "tool_execution_end", toolCallId: "second", toolName: "bash", isError: false, result: {} });
      expect((await service.status(sessionRef("session-2"))).activeToolExecutions).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });

  it("tracks interactive shell completion, error, and abort with daemon-owned ids", async () => {
    const runs: ReturnType<typeof deferred<BashResult>>[] = [];
    const fake = fakeRuntime("session-1", {
      executeBash: () => {
        const run = deferred<BashResult>();
        runs.push(run);
        return run.promise;
      },
      abort: () => {
        runs.at(-1)?.reject(new DOMException("aborted", "AbortError"));
        return Promise.resolve();
      },
    });
    const service = createService(new CapturingSessionEventHub(), () => Promise.resolve(fake.runtime));
    try {
      await service.start("/workspace");
      await service.shell(sessionRef("session-1"), "!printf super-secret");
      const first = (await service.status(sessionRef("session-1"))).activeToolExecutions?.[0];
      expect(first).toMatchObject({ kind: "shell", toolName: "shell", label: "Interactive shell", startedAt: STARTED_AT });
      expect(first?.id).toMatch(/^shell:\d+$/);
      expect(JSON.stringify(first)).not.toContain("super-secret");
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions?.[0]?.id).toBe(first?.id);

      runs[0]?.resolve({ output: "done", exitCode: 0, cancelled: false, truncated: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toBeUndefined();

      await service.shell(sessionRef("session-1"), "!false");
      runs[1]?.reject(new Error("failed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toBeUndefined();

      await service.shell(sessionRef("session-1"), "!sleep 60");
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toHaveLength(1);
      await service.abort(sessionRef("session-1"));
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });

  it("publishes cleared executions when a runtime rebinds", async () => {
    const hub = new CapturingSessionEventHub();
    const first = fakeRuntime("session-1");
    const replacement = fakeRuntime("session-1");
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    first.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const service = createService(hub, () => Promise.resolve(first.runtime));
    try {
      await service.start("/workspace");
      first.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep 60" } });
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toHaveLength(1);
      hub.globalEvents.length = 0;

      Object.defineProperty(first.runtime, "session", { configurable: true, value: replacement.session });
      if (rebindSession === undefined) throw new Error("Runtime replacement was not bound");
      await rebindSession(replacement.session);

      const statuses = hub.globalEvents.flatMap((event) => event.type === "status.update" ? [event.status] : []);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.activeToolExecutions).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });

  it("clears executions when a session closes and is reopened", async () => {
    const first = fakeRuntime("session-1");
    const reopened = fakeRuntime("session-1");
    const runtimes = [first.runtime, reopened.runtime];
    const createAgentRuntime: RuntimeCreator = () => {
      const runtime = runtimes.shift();
      return runtime === undefined
        ? Promise.reject(new Error("unexpected runtime creation"))
        : Promise.resolve(runtime);
    };
    const service = createService(new CapturingSessionEventHub(), createAgentRuntime);
    try {
      await service.start("/workspace");
      first.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep 60" } });
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toHaveLength(1);

      await service.stop(sessionRef("session-1"));
      expect(service.activeCount()).toBe(0);
      expect((await service.status(sessionRef("session-1"))).activeToolExecutions).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });
});
