import { describe, expect, it, vi } from "vitest";
import type { SessiondHealthProbe } from "../sessiond/sessiondOwnership.js";
import { waitForSessiondShutdown, waitForSessiondStartup, type SessiondShutdownWaitDependencies } from "./sessiondShutdownWait.js";

function harness(probes: Promise<SessiondHealthProbe>[]): {
  dependencies: SessiondShutdownWaitDependencies;
  probeHealth: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  let now = 0;
  const probeHealth = vi.fn(() => probes.shift() ?? Promise.reject(new Error("unexpected health probe")));
  const sleep = vi.fn((durationMs: number) => {
    now += durationMs;
    return Promise.resolve();
  });
  return {
    dependencies: { now: () => now, probeHealth, sleep },
    probeHealth,
    sleep,
  };
}

describe("session daemon startup wait", () => {
  it("retries an absent launchd job until the replacement responds", async () => {
    const { dependencies, probeHealth } = harness([
      Promise.resolve({ state: "stale", detail: "ENOENT" }),
      Promise.resolve({ state: "stale", detail: "ECONNREFUSED" }),
      Promise.resolve({ state: "responsive", pid: 35432 }),
    ]);
    const ensureStarted = vi.fn();

    await expect(waitForSessiondStartup({
      socketPath: "/tmp/pi-web/sessiond.sock",
      ensureStarted,
      deadlineMs: 100,
      pollIntervalMs: 25,
      dependencies,
    })).resolves.toBeUndefined();

    expect(probeHealth).toHaveBeenCalledTimes(3);
    expect(ensureStarted).toHaveBeenCalledTimes(2);
  });

  it("fails closed when replacement startup remains unproven", async () => {
    const { dependencies } = harness([
      Promise.resolve({ state: "unproven", detail: "health probe timed out" }),
      Promise.resolve({ state: "unproven", detail: "health probe timed out" }),
    ]);

    await expect(waitForSessiondStartup({
      socketPath: "/tmp/pi-web/sessiond.sock",
      ensureStarted: vi.fn(),
      deadlineMs: 50,
      pollIntervalMs: 25,
      dependencies,
    })).rejects.toThrow("Session daemon did not become responsive within 50 ms");
  });
});

describe("session daemon shutdown wait", () => {
  it("polls a responsive daemon until its socket becomes stale", async () => {
    const { dependencies, probeHealth, sleep } = harness([
      Promise.resolve({ state: "responsive", pid: 87402 }),
      Promise.resolve({ state: "stale", detail: "ECONNREFUSED" }),
    ]);

    await expect(waitForSessiondShutdown({
      socketPath: "/tmp/pi-web/sessiond.sock",
      deadlineMs: 200,
      pollIntervalMs: 25,
      dependencies,
    })).resolves.toBeUndefined();

    expect(probeHealth).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("returns immediately when the session daemon socket is already stale", async () => {
    const { dependencies, probeHealth, sleep } = harness([
      Promise.resolve({ state: "stale", detail: "ENOENT" }),
    ]);

    await expect(waitForSessiondShutdown({
      socketPath: "/tmp/pi-web/sessiond.sock",
      deadlineMs: 200,
      pollIntervalMs: 25,
      dependencies,
    })).resolves.toBeUndefined();

    expect(probeHealth).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails closed with attended doctor guidance when shutdown remains unproven", async () => {
    const { dependencies, probeHealth } = harness([
      Promise.resolve({ state: "unproven", detail: "health probe timed out" }),
      Promise.resolve({ state: "unproven", detail: "health probe timed out" }),
    ]);

    await expect(waitForSessiondShutdown({
      socketPath: "/tmp/pi-web/sessiond.sock",
      deadlineMs: 50,
      pollIntervalMs: 25,
      dependencies,
    })).rejects.toThrow("Replacement was not started. Run `pi-web doctor` in an attended terminal before retrying.");

    expect(probeHealth).toHaveBeenCalledTimes(2);
    expect(probeHealth).toHaveBeenNthCalledWith(1, "/tmp/pi-web/sessiond.sock", 50);
    expect(probeHealth).toHaveBeenNthCalledWith(2, "/tmp/pi-web/sessiond.sock", 25);
  });
});
