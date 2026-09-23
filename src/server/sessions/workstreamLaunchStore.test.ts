import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkstreamLaunchStore } from "./workstreamLaunchStore.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function store(): Promise<{ root: string; store: WorkstreamLaunchStore }> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-workstream-launch-"));
  roots.push(root);
  return { root, store: new WorkstreamLaunchStore(join(root, "launches")) };
}

describe("Workstream launch token ledger", () => {
  it("keeps a pending reservation across store restart and never reuses it", async () => {
    const { root, store: first } = await store();
    const token = "pi-web:launch-one";
    await first.reserve(token, "/repo");
    const reopened = new WorkstreamLaunchStore(join(root, "launches"));
    await expect(reopened.lookup(token)).resolves.toEqual({ token, cwd: "/repo", status: "pending" });
    await expect(reopened.reserve(token, "/repo")).rejects.toThrow(/already reserved/);
    await expect(reopened.reserve(token, "/other")).rejects.toThrow(/already reserved/);
  });

  it("commits an exact id and cwd so a restarted daemon can find the same launch", async () => {
    const { root, store: first } = await store();
    const token = "launch-unique-key";
    await first.reserve(token, "/repo");
    await first.confirm(token, "/repo", "session-1");
    const reopened = new WorkstreamLaunchStore(join(root, "launches"));
    await expect(reopened.lookup(token)).resolves.toEqual({ token, cwd: "/repo", sessionId: "session-1", status: "created" });
    await expect(reopened.lookup("launch-different-key")).resolves.toBeUndefined();
    await expect(reopened.reserve(token, "/repo")).rejects.toThrow(/already reserved/);
    await expect(reopened.confirm(token, "/elsewhere", "session-2")).rejects.toThrow(/location changed/);
    await expect(reopened.confirm(token, "/repo", "session-1")).resolves.toBeUndefined();
  });

  it("rejects malformed or unbounded Workstream tokens before filesystem use", async () => {
    const { root, store: ledger } = await store();
    await expect(ledger.reserve("pi-web:../escape", "/repo")).rejects.toThrow(/invalid/i);
    await expect(ledger.reserve(`pi-web:${"a".repeat(200)}`, "/repo")).rejects.toThrow(/invalid/i);
    await expect(ledger.reserve("ordinary-progress-label", "/repo")).rejects.toThrow(/invalid/i);
    await expect(readFile(join(root, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
