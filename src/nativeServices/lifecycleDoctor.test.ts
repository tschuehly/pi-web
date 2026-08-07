import { describe, expect, it } from "vitest";
import { createLifecycleDoctorReport, detectSessiondProcessTrees } from "./lifecycleDoctor.js";
import type { NativeProcessObservation, NativeServiceStatusReport } from "./nativeServiceStatus.js";

const processes: NativeProcessObservation[] = [
  { pid: 7001, ppid: 1, executable: "/usr/bin/npm", command: "npm run dev" },
  { pid: 7002, ppid: 7001, executable: "/bin/bash", command: "bash -c trap kill 0 EXIT; npm run dev:sessiond" },
  { pid: 7003, ppid: 7002, executable: "/opt/homebrew/bin/node", command: "tsx watch src/server/sessiond.ts" },
  { pid: 7101, ppid: 1, executable: "/usr/bin/npm", command: "npm run dev:sessiond" },
  { pid: 7102, ppid: 7101, executable: "/opt/homebrew/bin/node", command: "tsx watch src/server/sessiond.ts" },
  { pid: 7201, ppid: 1, executable: "/opt/homebrew/bin/node", command: "tsx src/server/sessiond.ts" },
];

describe("lifecycle doctor unmanaged process-tree detection", () => {
  it("identifies boot-dev, supervisor, and direct session-daemon trees deterministically", () => {
    expect(detectSessiondProcessTrees(processes)).toEqual([
      { kind: "boot-dev", rootPid: 7001, instancePid: 7003, pids: [7001, 7002, 7003] },
      { kind: "supervisor", rootPid: 7101, instancePid: 7102, pids: [7101, 7102] },
      { kind: "direct", rootPid: 7201, instancePid: 7201, pids: [7201] },
    ]);
  });

  it("reports duplicate trees as an unmanaged conflict with attended cleanup guidance only", () => {
    const status: NativeServiceStatusReport = {
      schemaVersion: 1,
      generatedAt: "2026-08-07T10:00:00.000Z",
      platform: "darwin",
      backend: "launchd",
      installMode: "development",
      components: [{
        component: "sessiond",
        ownership: "conflict",
        health: "unhealthy",
        instances: [
          { pid: 7003, executable: "/opt/homebrew/bin/node", serviceManagerLabel: null, componentVersion: "dev" },
          { pid: 7102, executable: "/opt/homebrew/bin/node", serviceManagerLabel: null, componentVersion: "dev" },
          { pid: 7201, executable: "/opt/homebrew/bin/node", serviceManagerLabel: null, componentVersion: "dev" },
        ],
        diagnostics: ["duplicate-instances"],
        processTrees: detectSessiondProcessTrees(processes),
      }],
    };

    const report = createLifecycleDoctorReport(status);

    expect(report).toMatchObject({
      ok: false,
      conflicts: [{
        component: "sessiond",
        kind: "unmanaged-process-conflict",
        cleanup: { attended: true, requiresAcknowledgement: true, performed: false },
      }],
    });
    expect(report.conflicts[0]?.message).toContain("No processes were stopped");
  });
});
