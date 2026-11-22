import { describe, expect, it } from "vitest";
import { runningWork, type CloseBusyStatus } from "./closeBusy";

const quiet: CloseBusyStatus = { isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0 };

describe("closing a busy Chat", () => {
  it("counts background bash jobs and running children, else names why the Chat is not quiet", () => {
    const status = (jobs: number, items: object[], extra: Partial<CloseBusyStatus> = {}): CloseBusyStatus => ({ ...quiet, ...extra, extensionStatuses: {
      "pi-workbench:background-bash": JSON.stringify({ schemaVersion: 1, jobs: Array.from({ length: jobs }, (_, index) => ({ id: `job-${String(index)}` })) }),
      "pi-workbench:activity": JSON.stringify({ schemaVersion: 1, items }),
    } });
    const ended = { id: "done", kind: "subagent", endedAt: "2026-10-21T10:00:00.000Z" };
    expect(runningWork(status(2, [{ id: "s1", kind: "subagent" }, ended]))).toBe("2 background bash jobs and 1 subagent are running; closing ends them.");
    expect(runningWork(status(0, [{ id: "w1", kind: "worker" }]))).toBe("1 worker is running; closing ends it.");
    expect(runningWork(status(1, [{ id: "s1", kind: "subagent" }, { id: "w1", kind: "worker" }]))).toBe("1 background bash job, 1 subagent and 1 worker are running; closing ends them.");
    // A running turn warns although no job or child runs.
    expect(runningWork(status(0, [ended], { isStreaming: true }))).toBe("A turn is running; closing ends it.");
    expect(runningWork({ ...quiet, isCompacting: true })).toBe("A turn is running; closing ends it.");
    expect(runningWork({ ...quiet, pendingMessageCount: 1 })).toBe("Input is queued; closing ends it.");
    expect(runningWork(status(0, [ended]))).toBeUndefined();
    expect(runningWork(quiet)).toBeUndefined();
  });
});
