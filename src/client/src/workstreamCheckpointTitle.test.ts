import { describe, expect, it, vi } from "vitest";
import type { WorkstreamSnapshot } from "./components/WorkstreamChooser";
import { applyCheckpointSessionTitle } from "./workstreamCheckpointTitle";

const checkpoint = (sessionTitle: string | null | undefined) => ({ id: "cp", whatChanged: "", remains: "", next: "", recordedAt: "2026-01-01T00:00:00Z", ...(sessionTitle === undefined ? {} : { sessionTitle }) });
const snapshotWith = (sessionTitle: string | null | undefined): Pick<WorkstreamSnapshot, "sessions"> => ({
  sessions: [{ id: "chat", status: "active", latestCheckpoint: checkpoint(sessionTitle) }],
});
const client = () => ({ runCommand: vi.fn(() => Promise.resolve({ type: "done" as const })) });

describe("applyCheckpointSessionTitle", () => {
  it("sends a differing checkpoint title once through the guarded server command", async () => {
    const api = client();
    const attempted = new Set<string>();
    const session = { id: "chat", cwd: "/workspace", name: "Orient to Codebase" };

    await applyCheckpointSessionTitle(snapshotWith(" Auth hardening "), session, "local", attempted, api);
    await applyCheckpointSessionTitle(snapshotWith("Auth hardening"), session, "local", attempted, api);

    expect(api.runCommand).toHaveBeenCalledTimes(1);
    expect(api.runCommand).toHaveBeenCalledWith({ id: "chat", cwd: "/workspace" }, "/workstream-checkpoint-title Auth hardening", "local");
  });

  it("does nothing without a title, for an equal name, or for another Chat", async () => {
    const api = client();
    const attempted = new Set<string>();
    await applyCheckpointSessionTitle(snapshotWith(null), { id: "chat", cwd: "/w" }, "local", attempted, api);
    await applyCheckpointSessionTitle(snapshotWith(undefined), { id: "chat", cwd: "/w" }, "local", attempted, api);
    await applyCheckpointSessionTitle(snapshotWith("Same"), { id: "chat", cwd: "/w", name: "Same" }, "local", attempted, api);
    await applyCheckpointSessionTitle(snapshotWith("Other"), { id: "other-chat", cwd: "/w" }, "local", attempted, api);
    expect(api.runCommand).not.toHaveBeenCalled();
  });
});
