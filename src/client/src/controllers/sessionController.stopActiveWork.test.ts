import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { SessionController, type PromptEditorTextReplacement } from "./sessionController";
import { defaultApi, deferred, FakeSocket, oldSession, replacementSession, status, workspace, type AppState } from "./sessionController.testSupport";

describe("SessionController stopActiveWork", () => {
  it("restores every captured server-queued message in order after abort succeeds", async () => {
    const queuedStatus = {
      ...status(oldSession.id),
      queuedMessages: [
        { kind: "steer" as const, text: "Adjust course" },
        { kind: "followUp" as const, text: "Then summarize" },
      ],
      pendingMessageCount: 2,
    };
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      status: queuedStatus,
    };
    const replacePromptEditorText = vi.fn<(replacement: PromptEditorTextReplacement) => void>();
    const api: typeof defaultApi = { ...defaultApi, abort: () => Promise.resolve({ aborted: true }) };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    await controller.stopActiveWork();

    expect(replacePromptEditorText).toHaveBeenCalledWith({
      machineId: "local",
      sessionId: oldSession.id,
      text: "Adjust course\n\nThen summarize",
      mode: "prepend",
    });
  });

  it("does not restore captured queue text when abort fails or the selection changes", async () => {
    const queuedStatus = { ...status(oldSession.id), queuedMessages: [{ kind: "followUp" as const, text: "Keep me" }], pendingMessageCount: 1 };
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession, replacementSession],
      status: queuedStatus,
    };
    const replacePromptEditorText = vi.fn();
    const abort = deferred<{ aborted: true }>();
    const api: typeof defaultApi = { ...defaultApi, abort: () => abort.promise };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket(), replacePromptEditorText },
    );

    const stopping = controller.stopActiveWork();
    state = { ...state, selectedSession: replacementSession, status: status(replacementSession.id) };
    abort.resolve({ aborted: true });
    await stopping;
    expect(replacePromptEditorText).not.toHaveBeenCalled();

    state = { ...state, selectedSession: oldSession, status: queuedStatus };
    const failedController = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api: { ...defaultApi, abort: () => Promise.reject(new Error("abort failed")) }, socket: new FakeSocket(), replacePromptEditorText },
    );
    await failedController.stopActiveWork();
    expect(replacePromptEditorText).not.toHaveBeenCalled();
    expect(Object.values(state.browserErrors).at(-1)?.message).toBe("abort failed");
  });
});
