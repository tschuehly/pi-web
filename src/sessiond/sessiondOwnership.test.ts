import { describe, expect, it, vi } from "vitest";
import {
  acquireSessiondOwnership,
  SessiondOwnershipUnprovenError,
  type SessiondHealthProbe,
  type SessiondLockRecord,
  type SessiondOwnershipDependencies,
} from "./sessiondOwnership.js";

function dependencies(overrides: Partial<SessiondOwnershipDependencies> = {}): SessiondOwnershipDependencies {
  return {
    createLock: vi.fn(() => Promise.resolve(true)),
    readLock: vi.fn(() => Promise.resolve(null)),
    removeLock: vi.fn(() => Promise.resolve()),
    removeSocket: vi.fn(() => Promise.resolve()),
    probeHealth: vi.fn(() => Promise.resolve({ state: "stale", detail: "connection refused" } satisfies SessiondHealthProbe)),
    isProcessAlive: vi.fn(() => false),
    now: () => "2026-08-07T10:00:00.000Z",
    pid: 6102,
    executable: "/opt/homebrew/bin/node",
    ...overrides,
  };
}

describe("session daemon ownership proof", () => {
  it("removes stale lock and socket artifacts only after both owner death and socket staleness are proven", async () => {
    const deps = dependencies({
      createLock: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      readLock: vi.fn(() => Promise.resolve({
        version: 1,
        pid: 6101,
        executable: "/opt/homebrew/bin/node",
        startedAt: "2026-08-07T09:00:00.000Z",
        socketPath: "/tmp/isolated/sessiond.sock",
        token: "old-owner",
      } satisfies SessiondLockRecord)),
      isProcessAlive: vi.fn(() => false),
    });

    await expect(acquireSessiondOwnership({
      socketPath: "/tmp/isolated/sessiond.sock",
      lockPath: "/tmp/isolated/sessiond.lock",
      dependencies: deps,
    })).resolves.toMatchObject({ pid: 6102 });

    const removeLock = vi.mocked(deps.removeLock);
    const removeSocket = vi.mocked(deps.removeSocket);
    expect(removeLock).toHaveBeenCalledOnce();
    expect(removeSocket).toHaveBeenCalledWith("/tmp/isolated/sessiond.sock");
  });

  it("returns a typed unproven error and removes nothing when a prior owner is alive but unhealthy", async () => {
    const deps = dependencies({
      createLock: vi.fn(() => Promise.resolve(false)),
      readLock: vi.fn(() => Promise.resolve({
        version: 1,
        pid: 6101,
        executable: "/opt/homebrew/bin/node",
        startedAt: "2026-08-07T09:00:00.000Z",
        socketPath: "/tmp/isolated/sessiond.sock",
        token: "live-owner",
      } satisfies SessiondLockRecord)),
      isProcessAlive: vi.fn(() => true),
    });

    const failure = await acquireSessiondOwnership({
      socketPath: "/tmp/isolated/sessiond.sock",
      lockPath: "/tmp/isolated/sessiond.lock",
      dependencies: deps,
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(SessiondOwnershipUnprovenError);
    expect(errorCode(failure)).toBe("SESSIOND_OWNERSHIP_UNPROVEN");
    const removeLock = vi.mocked(deps.removeLock);
    const removeSocket = vi.mocked(deps.removeSocket);
    expect(removeLock).not.toHaveBeenCalled();
    expect(removeSocket).not.toHaveBeenCalled();
  });
});

function errorCode(value: unknown): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, "code") : undefined;
}
