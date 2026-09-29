import { describe, expect, it, vi } from "vitest";
import type { MessagePage, SessionRef } from "./api";
import type { WorkstreamSnapshot } from "./components/WorkstreamChooser";
import { workstreamOrientationDepth } from "./workstreamOrientation";

const now = Date.parse("2026-01-01T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const user = (timestamp: unknown) => ({ role: "user", timestamp });
const snapshot: Pick<WorkstreamSnapshot, "sessions"> = {
  sessions: ["older", "newer", "new-chat"].map((id) => ({ id, status: "active", latestCheckpoint: null })),
};

function clientFor(histories: Record<string, unknown[]>, machines: Record<string, string> = {}) {
  return {
    locate: vi.fn((id: string, machineId?: string) => {
      if (machineId !== (machines[id] ?? "remote") || !(id in histories)) return Promise.reject(new Error("unavailable"));
      return Promise.resolve({ cwd: `/workspace/${id}` });
    }),
    messages: vi.fn((ref: SessionRef, options?: { limit?: number; before?: number }, machineId?: string): Promise<MessagePage> => {
      if (machineId !== (machines[ref.id] ?? "remote") || ref.cwd !== `/workspace/${ref.id}`) return Promise.reject(new Error("wrong anchor"));
      const messages = histories[ref.id];
      if (messages === undefined) return Promise.reject(new Error("unreadable"));
      const end = options?.before ?? messages.length;
      const start = Math.max(0, end - (options?.limit ?? 100));
      return Promise.resolve({ messages: messages.slice(start, end), start, total: messages.length });
    }),
  };
}

describe("workstreamOrientationDepth", () => {
  it("compares the newest user message across associated sessions, without reading the new chat", async () => {
    const client = clientFor({ older: [user(hoursAgo(5))], newer: [user(hoursAgo(2))] });
    expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", client, now)).toBe("brief");
    expect(client.locate).toHaveBeenCalledTimes(1);
    expect(client.locate).not.toHaveBeenCalledWith("older", "remote");
    expect(client.messages).toHaveBeenCalledWith({ id: "newer", cwd: "/workspace/newer" }, { limit: 100 }, "remote");
    expect(client.locate).not.toHaveBeenCalledWith("new-chat", "remote");

    const oldClient = clientFor({ older: [user(hoursAgo(5))], newer: [user(hoursAgo(4))] });
    expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", oldClient, now)).toBe("full");
  });

  it("uses an inclusive three-hour boundary and pages past non-user messages", async () => {
    const messages = [user(hoursAgo(3)), ...Array.from({ length: 110 }, () => ({ role: "assistant", timestamp: hoursAgo(1) }))];
    const client = clientFor({ older: messages, newer: [user(hoursAgo(4))] });
    expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", client, now)).toBe("full");
    expect(client.messages).toHaveBeenCalledWith({ id: "older", cwd: "/workspace/older" }, { limit: 100, before: 11 }, "remote");
    const justNewer = clientFor({ older: [user(new Date(now - 3 * 3_600_000 + 1).toISOString())], newer: [user(hoursAgo(4))] });
    expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", justNewer, now)).toBe("brief");
  });

  it("asks for full orientation when history is missing or unreadable, and skips past an unreadable Chat", async () => {
    expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", clientFor({ older: [user(hoursAgo(4))] }), now)).toBe("full");
    const unreadable = clientFor({ older: [user(hoursAgo(1))], newer: [user(hoursAgo(1))] });
    unreadable.messages.mockRejectedValueOnce(new Error("history unreadable"));
    expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", unreadable, now)).toBe("brief");
    expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", clientFor({ older: [user(hoursAgo(1))] }), now)).toBe("brief");
    expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", clientFor({ older: [], newer: [] }), now)).toBe("full");
    expect(await workstreamOrientationDepth({ sessions: [] }, "new-chat", "remote", clientFor({}), now)).toBe("full");
  });

  it("does not treat a malformed or future newest user timestamp as recent", async () => {
    for (const invalid of ["invalid", hoursAgo(-1)]) {
      const client = clientFor({ older: [user(hoursAgo(1)), user(invalid)], newer: [user(hoursAgo(5))] });
      expect(await workstreamOrientationDepth(snapshot, "new-chat", "remote", client, now)).toBe("full");
    }
  });

  it("uses each associated Chat's machine anchor rather than the new Chat's machine", async () => {
    const crossMachine = { sessions: snapshot.sessions.map((session) => session.id === "older" ? { ...session, machineId: "remote-b" } : session) };
    const client = clientFor({ older: [user(hoursAgo(1))], newer: [user(hoursAgo(5))] }, { older: "remote-b" });
    expect(await workstreamOrientationDepth(crossMachine, "new-chat", "remote", client, now)).toBe("brief");
    expect(client.locate).toHaveBeenCalledWith("older", "remote-b");
    expect(client.messages).toHaveBeenCalledWith({ id: "older", cwd: "/workspace/older" }, { limit: 100 }, "remote-b");
  });
});
