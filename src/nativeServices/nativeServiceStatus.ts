import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { packageVersion } from "../piWebVersionReport.js";
import { sessiondSocketPath } from "../sessiond/config.js";
import { probeSessiondHealth, sessiondLockPath, type SessiondHealthProbe } from "../sessiond/sessiondOwnership.js";
import {
  detectLegacyProcessTrees,
  detectSessiondProcessTrees,
  type LegacyProcessTree,
  type SessiondProcessTree,
} from "./lifecycleDoctor.js";
import { leafProcessOwners } from "./processTopology.js";
import { nativeServiceManagerRefs, type NativeServiceId } from "./servicePlan.js";

export interface NativeProcessObservation {
  pid: number;
  ppid: number;
  executable: string;
  command: string;
}

export interface NativeServiceInstance {
  pid: number;
  executable: string;
  serviceManagerLabel: string | null;
  componentVersion: string;
}

export interface NativeComponentStatus {
  component: NativeServiceId;
  ownership: "managed" | "unmanaged" | "conflict" | "absent";
  health: "healthy" | "starting" | "unhealthy" | "unknown";
  instances: NativeServiceInstance[];
  diagnostics: string[];
  processTrees: SessiondProcessTree[];
}

export interface NativeServiceStatusReport {
  schemaVersion: 1;
  generatedAt: string;
  platform: NodeJS.Platform;
  backend: "launchd" | "systemd" | "unsupported";
  installMode: string;
  components: NativeComponentStatus[];
  legacyProcessTrees?: LegacyProcessTree[];
}

interface ManagerInstance {
  serviceId: NativeServiceId;
  label: string;
  pid: number | null;
  state: string;
}

interface ObservedLock {
  state: "owned" | "stale" | "invalid" | "absent";
  pid: number | null;
}

export async function collectNativeServiceStatus(): Promise<NativeServiceStatusReport> {
  const backend = process.platform === "darwin" ? "launchd" : process.platform === "linux" ? "systemd" : "unsupported";
  const serviceIds = installedServiceIds(backend);
  const managers = collectManagerInstances(backend, serviceIds);
  const processes = collectProcesses();
  const socket = await probeSessiondHealth(sessiondSocketPath());
  const lock = readObservedLock(sessiondLockPath(sessiondSocketPath()));
  const observedServiceIds = new Set(processes.flatMap((process) => {
    const component = observedProcessComponent(process);
    return component === null ? [] : [component];
  }));
  const componentIds = (["sessiond", "web", "uiDev"] as const)
    .filter((serviceId) => serviceId === "sessiond" || serviceIds.includes(serviceId) || observedServiceIds.has(serviceId));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    backend,
    installMode: installMode(serviceIds),
    components: componentIds.map((serviceId) => serviceId === "sessiond"
      ? sessiondStatus(processes, managers, lock, socket)
      : componentStatus(serviceId, processes, managers)),
    legacyProcessTrees: detectLegacyProcessTrees(processes),
  };
}

export function sessiondStatus(
  processes: readonly NativeProcessObservation[],
  managers: readonly ManagerInstance[],
  lock: ObservedLock,
  socket: SessiondHealthProbe,
): NativeComponentStatus {
  const sessiondManagers = managers.filter((manager) => manager.serviceId === "sessiond");
  const instances = componentInstances("sessiond", processes, sessiondManagers);
  const diagnostics: string[] = [];
  if (lock.state === "stale") diagnostics.push("stale-lock");
  if (socket.state === "responsive" && socket.pid !== undefined && lock.pid !== null && socket.pid !== lock.pid) {
    diagnostics.push("socket-lock-owner-mismatch");
  }

  let ownership: NativeComponentStatus["ownership"];
  if (instances.length === 0) ownership = "absent";
  else if (instances.length > 1 || diagnostics.includes("socket-lock-owner-mismatch")) ownership = "conflict";
  else if (instances[0]?.serviceManagerLabel !== null) ownership = "managed";
  else ownership = "unmanaged";

  const solePid = instances[0]?.pid;
  const health = ownership !== "conflict"
    && solePid !== undefined
    && socket.state === "responsive"
    && (socket.pid === undefined || socket.pid === solePid)
    && lock.state === "owned"
    && lock.pid === solePid
    ? "healthy"
    : ownership !== "conflict" && sessiondManagers.some((manager) => managerIsStarting(manager.state))
      ? "starting"
      : "unhealthy";

  return {
    component: "sessiond",
    ownership,
    health,
    instances,
    diagnostics,
    processTrees: detectSessiondProcessTrees(processes),
  };
}

function componentStatus(
  component: Extract<NativeServiceId, "web" | "uiDev">,
  processes: readonly NativeProcessObservation[],
  managers: readonly ManagerInstance[],
): NativeComponentStatus {
  const componentManagers = managers.filter((manager) => manager.serviceId === component);
  const instances = componentInstances(component, processes, componentManagers);
  const ownership = componentOwnership(instances);
  const health: NativeComponentStatus["health"] = ownership === "conflict"
    ? "unhealthy"
    : componentManagers.some((manager) => managerIsStarting(manager.state))
      ? "starting"
      : ownership === "managed" && componentManagers.some((manager) => managerIsRunning(manager.state))
        ? "healthy"
        : "unknown";
  return {
    component,
    ownership,
    health,
    instances,
    diagnostics: [],
    processTrees: [],
  };
}

function componentInstances(
  component: NativeServiceId,
  processes: readonly NativeProcessObservation[],
  managers: readonly ManagerInstance[],
): NativeServiceInstance[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const runtimeProcesses = processes.filter((process) => observedProcessComponent(process) === component);
  const detectedProcesses = [...leafProcessOwners(processes, runtimeProcesses)];
  for (const manager of managers) {
    const managerPid = manager.pid;
    if (managerPid === null || runtimeProcesses.some((process) => processOwnedByManager(process, managerPid, byPid))) continue;
    const managerProcess = byPid.get(managerPid);
    if (managerProcess !== undefined) detectedProcesses.push(managerProcess);
  }
  return detectedProcesses.map((process) => {
    const manager = managers.find((candidate) => candidate.pid === null
      ? false
      : processOwnedByManager(process, candidate.pid, byPid));
    return {
      pid: process.pid,
      executable: process.executable,
      serviceManagerLabel: manager?.label ?? null,
      componentVersion: process.command.includes("src/server/") ? "dev" : packageVersion(),
    };
  });
}

function processOwnedByManager(
  process: NativeProcessObservation,
  managerPid: number,
  byPid: ReadonlyMap<number, NativeProcessObservation>,
): boolean {
  let cursor: NativeProcessObservation | undefined = process;
  const seen = new Set<number>();
  while (cursor !== undefined && !seen.has(cursor.pid)) {
    if (cursor.pid === managerPid) return true;
    seen.add(cursor.pid);
    cursor = byPid.get(cursor.ppid);
  }
  return false;
}

function componentOwnership(instances: readonly NativeServiceInstance[]): NativeComponentStatus["ownership"] {
  if (instances.length === 0) return "absent";
  if (instances.length > 1) return "conflict";
  return instances[0]?.serviceManagerLabel === null ? "unmanaged" : "managed";
}

export function collectProcesses(): NativeProcessObservation[] {
  const result = captureStatusCommand("ps", ["-axo", "pid=,ppid=,comm=,command="]);
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), executable: match[3], command: match[4] }];
  });
}

function installedServiceIds(backend: NativeServiceStatusReport["backend"]): NativeServiceId[] {
  if (backend === "unsupported") return [];
  const root = backend === "launchd"
    ? join(homedir(), "Library", "LaunchAgents")
    : join(homedir(), ".config", "systemd", "user");
  return (["sessiond", "web", "uiDev"] as const).filter((id) => {
    const ref = nativeServiceManagerRefs[id];
    return existsSync(join(root, backend === "launchd" ? ref.launchdPlistName : ref.systemdName));
  });
}

function collectManagerInstances(
  backend: NativeServiceStatusReport["backend"],
  serviceIds: readonly NativeServiceId[],
): ManagerInstance[] {
  if (backend === "unsupported") return [];
  return serviceIds.flatMap((serviceId) => {
    const ref = nativeServiceManagerRefs[serviceId];
    if (backend === "launchd") {
      const label = ref.launchdLabel;
      const target = `gui/${String(userInfo().uid)}/${label}`;
      const result = captureStatusCommand("launchctl", ["print", target]);
      if (result.status !== 0) return [];
      const pid = /^\s*pid\s*=\s*(\d+)\s*$/mu.exec(result.stdout)?.[1];
      const state = /^\s*state\s*=\s*(.+)\s*$/mu.exec(result.stdout)?.[1]?.trim() ?? "unknown";
      return [{ serviceId, label, pid: pid === undefined ? null : Number(pid), state }];
    }
    const result = captureStatusCommand("systemctl", [
      "--user", "--no-pager", "show", ref.systemdName,
      "--property=MainPID", "--property=ActiveState", "--property=SubState",
    ]);
    if (result.status !== 0) return [];
    const pid = Number(/^MainPID=(\d+)$/mu.exec(result.stdout)?.[1]);
    const activeState = /^ActiveState=(.+)$/mu.exec(result.stdout)?.[1]?.trim() ?? "unknown";
    const subState = /^SubState=(.+)$/mu.exec(result.stdout)?.[1]?.trim();
    return [{ serviceId, label: ref.systemdName, pid: pid > 0 ? pid : null, state: activeState === "active" ? subState ?? activeState : activeState }];
  });
}

function captureStatusCommand(command: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

function readObservedLock(lockPath: string): ObservedLock {
  if (!existsSync(lockPath)) return { state: "absent", pid: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!isRecord(parsed) || typeof parsed["pid"] !== "number") return { state: "invalid", pid: null };
    if (parsed["state"] === "stale") return { state: "stale", pid: parsed["pid"] };
    if (parsed["state"] === "owned" || parsed["version"] === 1) {
      const alive = captureStatusCommand("kill", ["-0", String(parsed["pid"])]).status === 0;
      return { state: alive ? "owned" : "stale", pid: parsed["pid"] };
    }
    return { state: "invalid", pid: parsed["pid"] };
  } catch {
    return { state: "invalid", pid: null };
  }
}

function observedProcessComponent(process: NativeProcessObservation): NativeServiceId | null {
  if (/(?:npm|bash|sh)(?:\s|$)/u.test(process.executable)) return null;
  if (/(?:dist\/server\/sessiond\.js|src\/server\/sessiond\.ts|\bpi-web-sessiond\b)/u.test(process.command)) return "sessiond";
  if (process.command.includes("src/server/index.ts")) return "uiDev";
  if (/(?:dist\/server\/index\.js|\bpi-web-server\b)/u.test(process.command)) return "web";
  return null;
}

function managerIsStarting(state: string): boolean {
  return /^(?:activating|start(?:ing|-pre|-post))$/u.test(state.trim().toLowerCase());
}

function managerIsRunning(state: string): boolean {
  return /^(?:active|running)$/u.test(state.trim().toLowerCase());
}

function installMode(ids: readonly NativeServiceId[]): string {
  const installed = new Set(ids);
  if (installed.size === 0) return "not-installed";
  if (installed.has("web") && installed.has("uiDev")) return "mixed";
  if (installed.has("uiDev")) return installed.has("sessiond") ? "development" : "development-incomplete";
  if (installed.has("web")) return installed.has("sessiond") ? "production" : "production-incomplete";
  return "partial";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
