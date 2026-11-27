import { describe, expect, it, vi } from "vitest";
import { pageMessagesAtSafeBoundary } from "../../../server/sessions/messagePaging";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, EmitSocket, oldSession, status, type MessagePage, type SessionTranscriptSnapshot } from "./sessionController.testSupport";

function branch(name: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({ role: "user", content: `${name} ${String(i)}` }));
}

function fixture(windowSizes = new Map<string, number>()) {
  const host = { rows: branch("old", 800), seq: 0, generation: "test-host" };
  const messages = vi.fn<typeof defaultApi.messages>((_, page) => Promise.resolve(pageMessagesAtSafeBoundary(host.rows, page)));
  const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>((_, page) => Promise.resolve({
    page: pageMessagesAtSafeBoundary(host.rows, page), status: status(oldSession.id), partial: null, seq: host.seq, generation: host.generation,
  }));
  let state = initialAppState();
  const socket = new EmitSocket();
  const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
    socket, windowSizes, api: { ...defaultApi, messages, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) },
  });
  return { controller, socket, host, messages, transcriptSnapshot, state: () => state };
}

describe("selected transcript window", () => {
  it("a missed branch change during Load earlier cannot stitch two branches together", async () => {
    const f = fixture();
    const cursor = deferred<MessagePage>();
    try {
      await f.controller.selectSession(oldSession);
      f.messages.mockReturnValueOnce(cursor.promise);
      const loading = f.controller.loadEarlierMessages();
      expect(f.messages).toHaveBeenCalledWith(oldSession, { before: 780, limit: 100 }, "local");
      const stale = pageMessagesAtSafeBoundary(f.host.rows, { before: 780, limit: 100 });
      f.host.rows = branch("new", 800); // Same length. Neither a cursor nor overlapping content identifies a branch.
      cursor.resolve(stale);
      await loading;
      expect(f.transcriptSnapshot).toHaveBeenLastCalledWith(oldSession, { limit: 120 }, "local");
      expect(f.state().messages.map((m) => m.parts)).toEqual(f.host.rows.slice(-120).map((m) => [{ type: "text", text: m.content }]));
    } finally { f.controller.dispose(); }
  });

  it("refocus retains all 141 raw messages including live appends, and the window can grow past 500", async () => {
    const sizes = new Map<string, number>();
    const f = fixture(sizes);
    try {
      await f.controller.selectSession(oldSession);
      expect(f.state().messages).toHaveLength(20);
      await f.controller.loadEarlierMessages();
      for (const message of branch("live", 21)) {
        f.host.rows.push(message);
        f.socket.emit({ type: "message.end", message, seq: ++f.host.seq });
      }
      const shown = f.state().messages;
      expect(shown).toHaveLength(141);
      // Off-page tabs release their controllers; the new one remembers only the size, not the old live tail.
      const rejoined = fixture(sizes);
      try {
        Object.assign(rejoined.host, f.host);
        await rejoined.controller.selectSession(oldSession);
        expect(rejoined.state().messages).toEqual(shown);
      } finally { rejoined.controller.dispose(); }
      await f.controller.refreshSelectedSession();
      expect(f.transcriptSnapshot).toHaveBeenLastCalledWith(oldSession, { limit: 141 }, "local");
      expect(f.state().messages).toEqual(shown);
      for (let i = 0; i < 4; i++) await f.controller.loadEarlierMessages();
      f.socket.reconnect();
      await f.controller.refreshSelectedSession();
      expect(f.state().messages).toHaveLength(541);
    } finally { f.controller.dispose(); }
  });

  it("does not rewind an accepted sequence when a fetch returns an older snapshot of the same host", async () => {
    const f = fixture();
    try {
      f.host.seq = 8;
      await f.controller.selectSession(oldSession);
      const stale = { generation: f.host.generation, seq: 7, partial: null, status: status(oldSession.id), page: { messages: [], start: 0, total: 0 } };
      f.transcriptSnapshot.mockResolvedValueOnce(stale);
      await f.controller.refreshSelectedSession();
      expect(f.transcriptSnapshot).toHaveBeenCalledTimes(3);
      expect(f.state().messages).toHaveLength(20);
    } finally { f.controller.dispose(); }
  });

  it.each(["restart", "gap", "unstamped"])("refetches instead of appending a doubtful frame (%s)", async (cause) => {
    const f = fixture();
    try {
      await f.controller.selectSession(oldSession);
      const response = deferred<SessionTranscriptSnapshot>();
      f.transcriptSnapshot.mockReturnValueOnce(response.promise);
      const before = f.state().messages;
      f.socket.emit({ type: "assistant.delta", text: "not for this transcript", streamId: "durable-1",
        generation: cause === "restart" ? "next-host" : cause === "unstamped" ? "" : f.host.generation, seq: cause === "gap" ? 3 : 1 });
      expect(f.state().messages).toBe(before);
      await vi.waitFor(() => { expect(f.transcriptSnapshot).toHaveBeenCalledTimes(2); });
      response.resolve({ generation: "next-host", seq: 1, partial: null, status: status(oldSession.id), page: { messages: branch("fresh", 1), start: 0, total: 1 } });
      await vi.waitFor(() => { expect(f.state().messages).toHaveLength(1); });
      f.socket.emit({ type: "message.append", generation: "next-host", seq: 2, message: { role: "user", content: "verified" } });
      expect(f.state().messages.at(-1)?.parts).toEqual([{ type: "text", text: "verified" }]);
    } finally { f.controller.dispose(); }
  });
});
