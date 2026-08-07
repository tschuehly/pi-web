import { setTimeout as sleep } from "node:timers/promises";
import { probeSessiondHealth, type SessiondHealthProbe } from "../sessiond/sessiondOwnership.js";

const DEFAULT_SHUTDOWN_DEADLINE_MS = 2_000;
const DEFAULT_STARTUP_DEADLINE_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export interface SessiondShutdownWaitDependencies {
  now(): number;
  probeHealth(socketPath: string, timeoutMs: number): Promise<SessiondHealthProbe>;
  sleep(durationMs: number): Promise<void>;
}

export interface SessiondShutdownWaitInput {
  socketPath: string;
  deadlineMs?: number;
  pollIntervalMs?: number;
  dependencies?: SessiondShutdownWaitDependencies;
}

export interface SessiondStartupWaitInput {
  socketPath: string;
  ensureStarted(): void;
  deadlineMs?: number;
  pollIntervalMs?: number;
  dependencies?: SessiondShutdownWaitDependencies;
}

export async function waitForSessiondStartup(input: SessiondStartupWaitInput): Promise<void> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const deadlineMs = input.deadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = dependencies.now() + deadlineMs;
  let lastProbe: SessiondHealthProbe | undefined;

  while (dependencies.now() < deadline) {
    const remainingMs = Math.max(1, Math.ceil(deadline - dependencies.now()));
    lastProbe = await dependencies.probeHealth(input.socketPath, Math.min(500, remainingMs));
    if (lastProbe.state === "responsive") return;
    if (lastProbe.state === "stale") input.ensureStarted();

    const remainingAfterProbeMs = deadline - dependencies.now();
    if (remainingAfterProbeMs <= 0) break;
    await dependencies.sleep(Math.min(pollIntervalMs, remainingAfterProbeMs));
  }

  const detail = lastProbe === undefined
    ? "health could not be checked"
    : lastProbe.state === "responsive"
      ? "health became responsive after the deadline"
      : lastProbe.detail;
  throw new Error(`Session daemon did not become responsive within ${String(deadlineMs)} ms: ${detail}. Run \`pi-web doctor\` in an attended terminal before retrying.`);
}

export async function waitForSessiondShutdown(input: SessiondShutdownWaitInput): Promise<void> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const deadlineMs = input.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = dependencies.now() + deadlineMs;
  let lastProbe: SessiondHealthProbe | undefined;

  while (dependencies.now() < deadline) {
    const remainingMs = Math.max(1, Math.ceil(deadline - dependencies.now()));
    lastProbe = await dependencies.probeHealth(input.socketPath, remainingMs);
    if (lastProbe.state === "stale") return;

    const remainingAfterProbeMs = deadline - dependencies.now();
    if (remainingAfterProbeMs <= 0) break;
    await dependencies.sleep(Math.min(pollIntervalMs, remainingAfterProbeMs));
  }

  const detail = lastProbe === undefined
    ? "health could not be checked before the deadline"
    : lastProbe.state === "responsive"
      ? `socket remained responsive${lastProbe.pid === undefined ? "" : ` (pid ${String(lastProbe.pid)})`}`
      : lastProbe.detail;
  throw new Error(`Session daemon shutdown could not be proven within ${String(deadlineMs)} ms: ${detail}. Replacement was not started. Run \`pi-web doctor\` in an attended terminal before retrying.`);
}

const defaultDependencies: SessiondShutdownWaitDependencies = {
  now: () => performance.now(),
  probeHealth: probeSessiondHealth,
  sleep: (durationMs) => sleep(durationMs),
};
