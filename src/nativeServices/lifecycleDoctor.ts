import type { NativeProcessObservation, NativeServiceStatusReport } from "./nativeServiceStatus.js";

export interface SessiondProcessTree {
  kind: "boot-dev" | "supervisor" | "direct";
  rootPid: number;
  instancePid: number;
  pids: number[];
}

export interface LifecycleDoctorConflict {
  component: "sessiond";
  kind: "unmanaged-process-conflict";
  processTrees: SessiondProcessTree[];
  message: string;
  cleanup: {
    attended: true;
    requiresAcknowledgement: true;
    performed: false;
  };
}

export interface LifecycleDoctorReport {
  schemaVersion: 1;
  ok: boolean;
  generatedAt: string;
  status: NativeServiceStatusReport;
  conflicts: LifecycleDoctorConflict[];
}

export function detectSessiondProcessTrees(processes: readonly NativeProcessObservation[]): SessiondProcessTree[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const instances = processes.filter((process) => isSessiondRuntime(process) && !isShellOrPackageRunner(process.executable));
  return instances.map((instance) => {
    const chain = [instance];
    const seen = new Set([instance.pid]);
    let cursor = instance;
    while (cursor.ppid > 1) {
      const parent = byPid.get(cursor.ppid);
      if (parent === undefined || seen.has(parent.pid)) break;
      chain.unshift(parent);
      seen.add(parent.pid);
      cursor = parent;
    }
    const commands = chain.map((process) => process.command);
    const kind: SessiondProcessTree["kind"] = commands.some(isBootDevCommand)
      ? "boot-dev"
      : commands.some((command) => /(?:npm run dev:sessiond|tsx\s+watch)/u.test(command))
        ? "supervisor"
        : "direct";
    return {
      kind,
      rootPid: chain[0]?.pid ?? instance.pid,
      instancePid: instance.pid,
      pids: chain.map((process) => process.pid),
    };
  }).sort((left, right) => left.rootPid - right.rootPid || left.instancePid - right.instancePid);
}

export function createLifecycleDoctorReport(status: NativeServiceStatusReport): LifecycleDoctorReport {
  const sessiond = status.components.find((component) => component.component === "sessiond");
  const unmanagedPids = new Set(sessiond?.instances
    .filter((instance) => instance.serviceManagerLabel === null)
    .map((instance) => instance.pid) ?? []);
  const allTrees = sessiond?.processTrees ?? [];
  const processTrees = allTrees.filter((tree) => unmanagedPids.has(tree.instancePid));
  const hasConflict = sessiond?.ownership === "conflict" && processTrees.length > 0;
  const conflicts: LifecycleDoctorConflict[] = hasConflict ? [{
    component: "sessiond",
    kind: "unmanaged-process-conflict",
    processTrees,
    message: "Unmanaged session-daemon process trees conflict with the selected owner. Stop the listed development or direct process tree in an attended terminal, then rerun doctor. No processes were stopped.",
    cleanup: {
      attended: true,
      requiresAcknowledgement: true,
      performed: false,
    },
  }] : [];
  return {
    schemaVersion: 1,
    ok: conflicts.length === 0,
    generatedAt: status.generatedAt,
    status,
    conflicts,
  };
}

export function formatLifecycleDoctorConflicts(report: LifecycleDoctorReport): string[] {
  return report.conflicts.flatMap((conflict) => [
    `✗ ${conflict.message}`,
    ...conflict.processTrees.map((tree) => `  ${tree.kind} tree: ${tree.pids.join(" -> ")} (sessiond pid ${String(tree.instancePid)})`),
    "  Cleanup is attended and requires explicit acknowledgement; PI WEB will not kill these processes automatically.",
  ]);
}

function isSessiondRuntime(process: NativeProcessObservation): boolean {
  return /(?:dist\/server\/sessiond\.js|src\/server\/sessiond\.ts|\bpi-web-sessiond\b)/u.test(process.command);
}

function isShellOrPackageRunner(executable: string): boolean {
  return /(?:^|\/)(?:npm|bash|sh)$/u.test(executable);
}

function isBootDevCommand(command: string): boolean {
  return /(?:^|\s)npm\s+run\s+dev(?:\s|$|;)/u.test(command);
}
