import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import type { QueuedSessionMessage } from "../api";
import { defaultApi, deferred, FakeSocket, oldSession, replacementSession, sessionLookupId, status, workspace, type AppState, type SessionStatus } from "./sessionController.testSupport";

function machine(id: string): NonNullable<AppState["selectedMachine"]> {
  return { id, name: id, kind: "remote", createdAt: "now", updatedAt: "now" };
}

describe("SessionController server queue mutation", () => {
  it("promotes one exact server-queued message and applies the returned status", async () => {
    const target = { kind: "followUp" as const, text: "send now" };
    const queuedStatus: SessionStatus = { ...status(oldSession.id), isStreaming: true, pendingMessageCount: 1, queuedMessages: [target] };
    const promotedStatus: SessionStatus = { ...queuedStatus, queuedMessages: [{ kind: "steer", text: "send now" }] };
    const calls: { target: QueuedSessionMessage; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(), selectedMachine: machine("remote-a"), selectedWorkspace: workspace,
      selectedSession: oldSession, sessions: [oldSession], status: queuedStatus, sessionStatuses: { [oldSession.id]: queuedStatus },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      promoteQueuedMessage: (_session, message, machineId) => {
        calls.push({ target: message, machineId: machineId ?? "local" });
        return Promise.resolve(promotedStatus);
      },
    };
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, { api, socket: new FakeSocket() });

    await controller.promoteQueuedMessage(target);

    expect(calls).toEqual([{ target, machineId: "remote-a" }]);
    expect(state.status).toEqual(promotedStatus);
  });

  it("does not apply promote-all status after the selected machine changes", async () => {
    const request = deferred<SessionStatus>();
    const oldStatus = { ...status(oldSession.id), queuedMessages: [{ kind: "followUp" as const, text: "old" }] };
    const replacementStatus = { ...status(oldSession.id), queuedMessages: [{ kind: "steer" as const, text: "other machine" }] };
    let state: AppState = {
      ...initialAppState(), selectedMachine: machine("remote-a"), selectedWorkspace: workspace,
      selectedSession: oldSession, sessions: [oldSession], status: oldStatus, sessionStatuses: { [oldSession.id]: oldStatus },
    };
    const api: typeof defaultApi = { ...defaultApi, promoteAllQueuedMessages: () => request.promise };
    const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, { api, socket: new FakeSocket() });

    const promoting = controller.promoteAllQueuedMessages();
    state = { ...state, selectedMachine: machine("remote-b"), status: replacementStatus, sessionStatuses: { [oldSession.id]: replacementStatus } };
    request.resolve({ ...oldStatus, queuedMessages: [{ kind: "steer", text: "old" }] });
    await promoting;

    expect(state.status).toBe(replacementStatus);
  });

  it("applies the returned status to the selected session without changing client-side queued sends", async () => {
    const queuedStatus: SessionStatus = {
      ...status(oldSession.id),
      isStreaming: true,
      pendingMessageCount: 2,
      queuedMessages: [
        { kind: "steer", text: "adjust course" },
        { kind: "followUp", text: "then summarize" },
      ],
    };
    const clearedStatus: SessionStatus = { ...queuedStatus, pendingMessageCount: 0, queuedMessages: [] };
    const clientQueuedSends = [{ kind: "followUp" as const, text: "waiting for session creation" }];
    const clearCalls: { sessionId: string; machineId: string }[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: machine("remote-a"),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      status: queuedStatus,
      sessionStatuses: { [oldSession.id]: queuedStatus },
      clientQueuedSessionMessages: { [oldSession.id]: clientQueuedSends },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      clearQueue: (session, machineId) => {
        clearCalls.push({ sessionId: sessionLookupId(session), machineId: machineId ?? "local" });
        return Promise.resolve(clearedStatus);
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.clearServerQueue();

    expect(clearCalls).toEqual([{ sessionId: oldSession.id, machineId: "remote-a" }]);
    expect(state.status).toEqual(clearedStatus);
    expect(state.sessionStatuses[oldSession.id]).toEqual(clearedStatus);
    expect(state.clientQueuedSessionMessages[oldSession.id]).toBe(clientQueuedSends);
  });

  it("does not apply a response after another session is selected", async () => {
    const request = deferred<SessionStatus>();
    const oldStatus: SessionStatus = { ...status(oldSession.id), pendingMessageCount: 1, queuedMessages: [{ kind: "followUp", text: "old queue" }] };
    const replacementStatus: SessionStatus = { ...status(replacementSession.id), pendingMessageCount: 3, queuedMessages: [{ kind: "steer", text: "new queue" }] };
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession, replacementSession],
      status: oldStatus,
      sessionStatuses: { [oldSession.id]: oldStatus, [replacementSession.id]: replacementStatus },
    };
    const api: typeof defaultApi = { ...defaultApi, clearQueue: () => request.promise };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const clearing = controller.clearServerQueue();
    state = { ...state, selectedSession: replacementSession, status: replacementStatus };
    request.resolve({ ...oldStatus, pendingMessageCount: 0, queuedMessages: [] });
    await clearing;

    expect(state.status).toBe(replacementStatus);
    expect(state.sessionStatuses[oldSession.id]).toBe(oldStatus);
    expect(state.sessionStatuses[replacementSession.id]).toBe(replacementStatus);
  });

  it("does not apply a response after the selected machine changes", async () => {
    const request = deferred<SessionStatus>();
    const machineBStatus: SessionStatus = { ...status(oldSession.id), pendingMessageCount: 4, queuedMessages: [{ kind: "followUp", text: "machine B queue" }] };
    let state: AppState = {
      ...initialAppState(),
      selectedMachine: machine("remote-a"),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      status: status(oldSession.id),
      sessionStatuses: { [oldSession.id]: status(oldSession.id) },
    };
    const api: typeof defaultApi = { ...defaultApi, clearQueue: () => request.promise };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const clearing = controller.clearServerQueue();
    state = {
      ...state,
      selectedMachine: machine("remote-b"),
      status: machineBStatus,
      sessionStatuses: { [oldSession.id]: machineBStatus },
    };
    request.resolve(status(oldSession.id));
    await clearing;

    expect(state.status).toBe(machineBStatus);
    expect(state.sessionStatuses[oldSession.id]).toBe(machineBStatus);
  });

  it("reports queue-clear failures through the application error state", async () => {
    const queuedStatus: SessionStatus = { ...status(oldSession.id), pendingMessageCount: 1, queuedMessages: [{ kind: "steer", text: "keep me" }] };
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      status: queuedStatus,
      sessionStatuses: { [oldSession.id]: queuedStatus },
    };
    const api: typeof defaultApi = { ...defaultApi, clearQueue: () => Promise.reject(new Error("queue clear failed")) };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.clearServerQueue();

    expect(Object.values(state.browserErrors).map((error) => error.message)).toContain("Error: queue clear failed");
    expect(state.status).toBe(queuedStatus);
  });

  it("does not send a server clear for a client-pending session or discard its queued sends", async () => {
    const pendingSession = { ...oldSession, id: "pending-session", clientPendingStart: true as const, machineId: "local" };
    const clientQueuedSends = [{ kind: "followUp" as const, text: "send after creation" }];
    let clearCalls = 0;
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: pendingSession,
      sessions: [pendingSession],
      clientQueuedSessionMessages: { [pendingSession.id]: clientQueuedSends },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      clearQueue: () => {
        clearCalls += 1;
        return Promise.resolve(status(pendingSession.id));
      },
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.clearServerQueue();

    expect(clearCalls).toBe(0);
    expect(state.clientQueuedSessionMessages[pendingSession.id]).toBe(clientQueuedSends);
  });
});
