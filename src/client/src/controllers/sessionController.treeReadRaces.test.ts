import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import { machineSessionKey } from "../machineKeys";
import { SessionController } from "./sessionController";
import {
  defaultApi, deferred, EmitSocket, oldSession, status, transcriptSnapshotFixture, workspace,
  type AppState, type MessagePage, type SessionTranscriptSnapshot,
} from "./sessionController.testSupport";

const key = machineSessionKey("local", oldSession.id);
const oldTail = page("old branch", 200, 300);
const oldEarlier = page("old branch", 100, 300);
const newTail = page("new branch", 150, 250);

function fixture(cache = new Map<string, MessagePage>()) {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
  const transcripts = new ChatTranscriptStore({
    read: (id) => cache.get(id), write: (id, value) => { cache.set(id, value); }, remove: (id) => { cache.delete(id); },
  });
  const transcriptSnapshot = vi.fn<typeof defaultApi.transcriptSnapshot>()
    .mockImplementationOnce(() => transcriptSnapshotFixture(oldTail, status(oldSession.id)))
    .mockImplementation(() => transcriptSnapshotFixture(newTail, status(oldSession.id), { seq: 2, partial: null }));
  const messages = vi.fn<typeof defaultApi.messages>(() => Promise.resolve(oldEarlier));
  const socket = new EmitSocket();
  const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
    transcripts, socket,
    api: { ...defaultApi, transcriptSnapshot, messages, navigateTree: () => Promise.resolve({ cancelled: false }), thinkingLevels: () => Promise.resolve({ levels: [] }) },
  });
  function changeBranch(trigger: "observer" | "explicit") {
    if (trigger === "observer") {
      socket.emit({ type: "session.tree.changed", seq: 1 });
      return controller.refreshSelectedSession();
    }
    state = { ...state, treeDialog: { nodes: [{ id: "root", parentId: null, kind: "user", summary: "prompt" }], activeLeafId: "root", activePathIds: ["root"] } };
    return controller.navigateTree("root", { mode: "none" });
  }
  function expectNewBranch(current = newTail) {
    expect(state.selectedSession?.id).toBe(oldSession.id);
    expect(state.messagePageStart).toBe(current.start);
    expect(state.messagePageTotal).toBe(current.total);
    expect(transcripts.rawHistoryPage(key)).toEqual(current);
    expect(state.messages.every((message) => message.parts.some((part) => part.type === "text" && part.text.startsWith("new branch")))).toBe(true);
  }
  return { controller, cache, socket, transcripts, transcriptSnapshot, messages, changeBranch, expectNewBranch, state: () => state };
}

describe("SessionController branch read ownership", () => {
  it.each(["reconnect", "reselect", "reload"] as const)("recovers a changed branch by reads after %s without receiving its invalidation", async (trigger) => {
    const f = fixture();
    let restored: ReturnType<typeof fixture> | undefined;
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      await f.controller.loadEarlierMessages();
      expect(f.state().messagePageStart).toBe(100);
      // No session.tree.changed frame: the mutation happened while offline or
      // while another conversation was selected. Cached history is not truth.
      if (trigger === "reload") {
        f.controller.dispose();
        restored = fixture(f.cache);
        restored.transcriptSnapshot.mockReset().mockImplementation(() => transcriptSnapshotFixture(newTail, status(oldSession.id), { seq: 2, partial: null }));
        await restored.controller.selectSession(oldSession, { updateUrl: false });
        restored.expectNewBranch();
      } else {
        if (trigger === "reconnect") {
          f.socket.reconnect();
          await f.controller.refreshSelectedSession();
        } else {
          await f.controller.selectSession(oldSession, { updateUrl: false });
        }
        f.expectNewBranch();
      }
    } finally {
      restored?.controller.dispose();
      f.controller.dispose();
    }
  });

  it.each([250, 300])("retires an earlier-page response when a snapshot discovers a missed tree change (total=%s)", async (total) => {
    const f = fixture();
    const current = page("new branch", total - 100, total);
    const earlier = deferred<MessagePage>();
    f.messages.mockReturnValueOnce(earlier.promise);
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      f.transcriptSnapshot.mockImplementation(() => transcriptSnapshotFixture(current, status(oldSession.id), { seq: 2, partial: null }));
      const loading = f.controller.loadEarlierMessages();
      await vi.waitFor(() => { expect(f.messages).toHaveBeenCalledOnce(); });
      const revision = f.transcripts.historyRevision(key);
      f.socket.reconnect();
      await f.controller.refreshSelectedSession();
      f.expectNewBranch(current);
      expect(f.transcripts.historyRevision(key)).toBeGreaterThan(revision);
      earlier.resolve(oldEarlier);
      await loading;
      f.expectNewBranch(current);
      expect(f.state().isLoadingEarlierMessages).toBe(false);
    } finally {
      earlier.resolve(oldEarlier);
      f.controller.dispose();
    }
  });

  it("keeps earlier pages when same-branch pagination observes an append after a delayed snapshot's capture", async () => {
    const f = fixture();
    const snapshot = deferred<SessionTranscriptSnapshot>();
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      f.transcriptSnapshot.mockReturnValueOnce(snapshot.promise);
      const polling = f.controller.refreshSelectedSession();
      await vi.waitFor(() => { expect(f.transcriptSnapshot).toHaveBeenCalledTimes(2); });
      f.messages.mockResolvedValueOnce({ ...oldEarlier, total: 301 });
      await f.controller.loadEarlierMessages();
      expect(f.state().messagePageStart).toBe(100);
      expect(f.state().messagePageTotal).toBe(301);
      const revision = f.transcripts.historyRevision(key);
      snapshot.resolve({ page: oldTail, status: status(oldSession.id), seq: 0, partial: null });
      await polling;
      expect(f.state().messagePageStart).toBe(100);
      expect(f.state().messagePageTotal).toBe(300);
      expect(f.transcripts.rawHistoryPage(key)).toEqual({ start: 100, total: 300, messages: [...oldEarlier.messages, ...oldTail.messages] });
      expect(f.transcripts.historyRevision(key)).toBe(revision);
    } finally {
      snapshot.resolve({ page: oldTail, status: status(oldSession.id), seq: 0, partial: null });
      f.controller.dispose();
    }
  });

  it.each(["observer", "explicit"] as const)("retires an earlier-page response across %s tree changes without changing selection", async (trigger) => {
    const f = fixture();
    const earlier = deferred<MessagePage>();
    f.messages.mockReturnValueOnce(earlier.promise);
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      const loading = f.controller.loadEarlierMessages();
      await vi.waitFor(() => { expect(f.messages).toHaveBeenCalledOnce(); });
      await f.changeBranch(trigger);
      f.expectNewBranch();
      earlier.resolve(oldEarlier);
      await loading;
      expect(f.state().isLoadingEarlierMessages).toBe(false);
      f.expectNewBranch();
      await f.controller.refreshSelectedSession();
      f.expectNewBranch();
    } finally {
      earlier.resolve(oldEarlier);
      f.controller.dispose();
    }
  });

  it.each(["observer", "explicit"] as const)("retires an old snapshot rather than reseeding a discarded multi-page cache across %s tree changes", async (trigger) => {
    const f = fixture();
    const oldSnapshot = deferred<SessionTranscriptSnapshot>();
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      await f.controller.loadEarlierMessages();
      expect(f.state().messagePageStart).toBe(100);
      f.transcriptSnapshot.mockReturnValueOnce(oldSnapshot.promise);
      const polling = f.controller.refreshSelectedSession();
      await vi.waitFor(() => { expect(f.transcriptSnapshot).toHaveBeenCalledTimes(2); });
      const changing = f.changeBranch(trigger);
      // An explicit response invalidates immediately; socket invalidations are
      // buffered until the pending snapshot finishes and then retire its cache.
      if (trigger === "explicit") await vi.waitFor(() => { expect(f.cache.has(key)).toBe(false); });
      oldSnapshot.resolve({ page: oldTail, status: status(oldSession.id), seq: 0, partial: null });
      await Promise.all([polling, changing]);
      f.expectNewBranch();
      await f.controller.refreshSelectedSession();
      f.expectNewBranch();
    } finally {
      oldSnapshot.resolve({ page: oldTail, status: status(oldSession.id), seq: 0, partial: null });
      f.controller.dispose();
    }
  });
});

function page(branch: string, start: number, total: number): MessagePage {
  return { start, total, messages: Array.from({ length: 100 }, (_, index) => ({ role: "user", content: `${branch} ${String(start + index)}`, timestamp: start + index })) };
}

describe("SessionController earlier pages", () => {
  it("keeps a live reply delivered while an earlier page loads", async () => {
    const f = fixture();
    const earlier = deferred<MessagePage>();
    f.messages.mockReturnValueOnce(earlier.promise);
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      const loading = f.controller.loadEarlierMessages();
      await vi.waitFor(() => { expect(f.messages).toHaveBeenCalledOnce(); });
      f.socket.emit({ type: "message.append", message: { role: "user", content: "live reply", timestamp: 999 } });
      await vi.waitFor(() => { expect(f.state().messages).toHaveLength(101); });
      earlier.resolve(oldEarlier);
      await loading;
      expect(f.state().messagePageStart).toBe(100);
      expect(f.state().messages).toHaveLength(201);
      expect(f.state().messages.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "live reply" }));
    } finally {
      earlier.resolve(oldEarlier);
      f.controller.dispose();
    }
  });
});

describe("SessionController earlier pages join tool calls", () => {
  it("merges a tool result at the top of the visible tail into its call on the earlier page", async () => {
    const f = fixture();
    const call = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }], timestamp: 199 };
    const result = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 200 };
    f.transcriptSnapshot.mockReset().mockImplementation(() => transcriptSnapshotFixture({ ...oldTail, messages: [result, ...oldTail.messages.slice(1)] }, status(oldSession.id)));
    f.messages.mockResolvedValueOnce({ ...oldEarlier, messages: [...oldEarlier.messages.slice(0, -1), call] });
    try {
      await f.controller.selectSession(oldSession, { updateUrl: false });
      await f.controller.loadEarlierMessages();
      const tools = f.state().messages.filter((line) => line.parts.some((part) => part.type === "toolExecution" || part.type === "toolResult"));
      expect(tools).toHaveLength(1);
      expect(tools[0]?.parts[0]).toMatchObject({ type: "toolExecution", toolCallId: "c1" });
      expect(JSON.stringify(tools[0])).toContain("file body");
    } finally {
      f.controller.dispose();
    }
  });
});
