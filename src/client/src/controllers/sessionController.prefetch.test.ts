import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { ChatTranscriptStore } from "../chatTranscriptStore";
import type { MessagePage } from "../api";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, EmitSocket, oldSession, workspace, type AppState } from "./sessionController.testSupport";

const page: MessagePage = { messages: [{ role: "user", content: "first question" }, { role: "assistant", content: [{ type: "text", text: "previous answer" }] }], start: 0, total: 2 };

function harness() {
  let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
  const messages = vi.fn(() => Promise.resolve(page));
  // Selection's own transcript read never answers: whatever shows at once came from the prefetch.
  const transcriptSnapshot = vi.fn(() => deferred<never>().promise);
  const pages = new Map<string, MessagePage>();
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    {
      socket: new EmitSocket(),
      transcripts: new ChatTranscriptStore({ read: (id) => pages.get(id), write: (id, value) => { pages.set(id, value); } }),
      api: { ...defaultApi, messages, transcriptSnapshot, thinkingLevels: () => Promise.resolve({ levels: [] }) },
    },
  );
  return { controller, messages, state: () => state };
}

describe("transcript prefetch", () => {
  it("lets a Chat never shown before paint its transcript the moment it is selected, fetching it only once", async () => {
    const { controller, messages, state } = harness();

    await controller.prefetchTranscript(oldSession, "local");
    await controller.prefetchTranscript(oldSession, "local");
    void controller.selectSession(oldSession, { updateUrl: false });

    expect(messages).toHaveBeenCalledOnce();
    expect(state().selectedSession?.id).toBe(oldSession.id);
    expect(state().messages).toHaveLength(2);
  });

  it("leaves unsaved and archived Chats to the usual selection", async () => {
    const { controller, messages } = harness();
    await controller.prefetchTranscript({ ...oldSession, persisted: false }, "local");
    await controller.prefetchTranscript({ ...oldSession, archived: true }, "local");
    expect(messages).not.toHaveBeenCalled();
  });
});
