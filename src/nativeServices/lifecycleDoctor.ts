import type { NativeProcessObservation, NativeServiceStatusReport } from "./nativeServiceStatus.js";
import { leafProcessOwners } from "./processTopology.js";

export interface SessiondProcessTree {
  kind: "boot-dev" | "supervisor" | "direct";
  rootPid: number;
  instancePid: number;
  pids: number[];
}

export interface LegacyProcessTree {
  kind: "workbench-supervisor" | "boot-dev";
  rootPid: number;
  supervisorPid: number | null;
  wrapperPids: number[];
  pids: number[];
}

interface AttendedCleanup {
  attended: true;
  requiresAcknowledgement: true;
  performed: false;
}

export type LifecycleDoctorConflict = {
  component: "sessiond";
  kind: "unmanaged-process-conflict";
  processTrees: SessiondProcessTree[];
  message: string;
  cleanup: AttendedCleanup;
} | {
  component: "legacy-wrapper";
  kind: "legacy-wrapper-conflict";
  processTrees: LegacyProcessTree[];
  message: string;
  cleanup: AttendedCleanup;
};

export interface LifecycleDoctorReport {
  schemaVersion: 1;
  ok: boolean;
  generatedAt: string;
  status: NativeServiceStatusReport;
  conflicts: LifecycleDoctorConflict[];
}

export function detectSessiondProcessTrees(processes: readonly NativeProcessObservation[]): SessiondProcessTree[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const runtimeProcesses = processes.filter((process) => isSessiondRuntime(process) && !isShellOrPackageRunner(process.executable));
  const instances = leafProcessOwners(processes, runtimeProcesses);
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

export function detectLegacyProcessTrees(processes: readonly NativeProcessObservation[]): LegacyProcessTree[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const candidates = processes.filter((process) => isLegacySupervisor(process.command) || isLegacyBootDev(process.command));
  const roots = candidates.filter((candidate) => !hasMatchingAncestor(candidate, byPid, (process) =>
    isLegacySupervisor(process.command) || isLegacyBootDev(process.command)));
  return roots.map<LegacyProcessTree>((root) => {
    const members = processTreeMembers(root, processes);
    const supervisor = members.find((process) => isLegacySupervisor(process.command));
    return {
      kind: supervisor === undefined ? "boot-dev" : "workbench-supervisor",
      rootPid: root.pid,
      supervisorPid: supervisor?.pid ?? null,
      wrapperPids: members.filter((process) => isLegacyWrapper(process.command)).map((process) => process.pid),
      pids: members.map((process) => process.pid),
    };
  }).sort((left, right) => left.rootPid - right.rootPid);
}

export function createLifecycleDoctorReport(status: NativeServiceStatusReport): LifecycleDoctorReport {
  const sessiond = status.components.find((component) => component.component === "sessiond");
  const unmanagedPids = new Set(sessiond?.instances
    .filter((instance) => instance.serviceManagerLabel === null)
    .map((instance) => instance.pid) ?? []);
  const allTrees = sessiond?.processTrees ?? [];
  const processTrees = allTrees.filter((tree) => unmanagedPids.has(tree.instancePid));
  const hasSessiondConflict = sessiond?.ownership === "conflict" && processTrees.length > 0;
  const conflicts: LifecycleDoctorConflict[] = [];
  if (hasSessiondConflict) {
    conflicts.push({
      component: "sessiond",
      kind: "unmanaged-process-conflict",
      processTrees,
      message: "Unmanaged session-daemon process trees conflict with the selected owner. Stop the listed development or direct process tree in an attended terminal, then rerun doctor. No processes were stopped.",
      cleanup: attendedCleanup(),
    });
  }
  const legacyProcessTrees = status.legacyProcessTrees ?? [];
  if (legacyProcessTrees.length > 0) {
    conflicts.push({
      component: "legacy-wrapper",
      kind: "legacy-wrapper-conflict",
      processTrees: legacyProcessTrees,
      message: "Legacy Pi Workbench wrapper or supervisor trees are still running. Close them in an attended session, then rerun doctor. Persisted transcripts remain available, but in-flight turns, asks, and terminals cannot be migrated. No processes were stopped.",
      cleanup: attendedCleanup(),
    });
  }
  return {
    schemaVersion: 1,
    ok: conflicts.length === 0,
    generatedAt: status.generatedAt,
    status,
    conflicts,
  };
}

export function formatLifecycleDoctorConflicts(report: LifecycleDoctorReport): string[] {
  return report.conflicts.flatMap((conflict) => {
    const processLines = conflict.kind === "unmanaged-process-conflict"
      ? conflict.processTrees.map((tree) => `  ${tree.kind} tree: ${tree.pids.join(" -> ")} (sessiond pid ${String(tree.instancePid)})`)
      : conflict.processTrees.map((tree) => `  ${tree.kind} tree: ${tree.pids.join(" -> ")} (wrapper pids ${tree.wrapperPids.join(", ") || "none"})`);
    return [
      `✗ ${conflict.message}`,
      ...processLines,
      "  Cleanup is attended and requires explicit acknowledgement; PI WEB will not kill these processes automatically.",
    ];
  });
}

function attendedCleanup(): AttendedCleanup {
  return {
    attended: true,
    requiresAcknowledgement: true,
    performed: false,
  };
}

function hasMatchingAncestor(
  process: NativeProcessObservation,
  byPid: ReadonlyMap<number, NativeProcessObservation>,
  predicate: (candidate: NativeProcessObservation) => boolean,
): boolean {
  let cursor = byPid.get(process.ppid);
  const seen = new Set([process.pid]);
  while (cursor !== undefined && !seen.has(cursor.pid)) {
    if (predicate(cursor)) return true;
    seen.add(cursor.pid);
    cursor = byPid.get(cursor.ppid);
  }
  return false;
}

function processTreeMembers(
  root: NativeProcessObservation,
  processes: readonly NativeProcessObservation[],
): NativeProcessObservation[] {
  const children = new Map<number, NativeProcessObservation[]>();
  for (const process of processes) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.pid - right.pid);

  const members: NativeProcessObservation[] = [];
  const seen = new Set<number>();
  const visit = (process: NativeProcessObservation): void => {
    if (seen.has(process.pid)) return;
    seen.add(process.pid);
    members.push(process);
    for (const child of children.get(process.pid) ?? []) visit(child);
  };
  visit(root);
  return members;
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

function isLegacySupervisor(command: string): boolean {
  return /(?:^|[\s/])PiWorkbenchSupervisor(?:\s|$)/u.test(command);
}

function isLegacyBootDev(command: string): boolean {
  return /(?:^|[\s/])boot-dev\.sh(?:\s|$)/u.test(command);
}

function isLegacyWrapper(command: string): boolean {
  return /(?:^|[\s/])PIWebMac(?:\s|$)/u.test(command);
}
