import { describe, expect, it, vi } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE } from "../../shared/apiTypes.js";
import { createPiWebCustomToolDefinitions, PiSessionService } from "./piSessionService.js";
import { ASK_USER_REMINDER_CUSTOM_TYPE, PendingAskStore, PendingAskValidationError } from "./pendingAskStore.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const ACTIVE_SESSION_ID = "session-1";

const questions = [{ id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] }];
const context = "Postgres is already deployed; I recommend it.";
const T0 = "2026-02-01T10:00:00.000Z";
const openedAsk = (askId: string, overrides: Record<string, unknown> = {}) => ({ askId, askedAt: T0, updatedAt: T0, turnsSinceUpdate: 0, context, questions, ...overrides });

/**
 * Service over a clocked store with sequential ask ids, so asks are named
 * `ask-1`, `ask-2`, … and timestamps are fixed. Pass `withActiveSession` when the
 * test needs a live runtime to deliver answers into.
 */
function askService(options: { withActiveSession?: boolean; branch?: unknown[] } = {}) {
  const store = new PendingAskStore({
    now: () => new Date("2026-02-01T10:00:00.000Z"),
    createAskId: (() => {
      let next = 0;
      return () => { next += 1; return `ask-${next.toString()}`; };
    })(),
  });
  const fake = fakeRuntime(ACTIVE_SESSION_ID);
  if (options.branch !== undefined) {
    const branch = options.branch;
    fake.session.sessionManager = fakeSessionManager("/workspace", { getBranch: () => branch, getEntries: () => branch });
  }
  const events = new CapturingSessionEventHub();
  const service = new PiSessionService(events, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    sessionManager: sessionGateway(options.withActiveSession === true ? [sessionRecord(ACTIVE_SESSION_ID)] : []),
    archiveStore: emptyArchiveStore(),
    ...(options.withActiveSession === true ? { createAgentRuntime: runtimeCreator(fake.runtime) } : {}),
    pendingAskStore: store,
    askUserEnabled: true,
    heartbeatIntervalMs: 60_000,
  });
  return { service, store, events, fake };
}

function askEvents(events: CapturingSessionEventHub) {
  return events.sessionEvents
    .filter(({ event }) => event.type === "ask.opened" || event.type === "ask.closed")
    .map(({ sessionId, event }) => ({ sessionId, event }));
}


describe("ask_user registration", () => {
  it("offers ask_user whenever the capability is configured, including to restricted tracked children", () => {
    const askUser = { open: vi.fn(), update: vi.fn(), withdraw: vi.fn() };

    const unrestricted = createPiWebCustomToolDefinitions("/workspace", true, undefined, undefined, askUser);
    const restricted = createPiWebCustomToolDefinitions("/workspace", false, undefined, undefined, askUser);

    expect(unrestricted.map((definition) => definition.name)).toEqual(["edit", "ask_user"]);
    expect(restricted.map((definition) => definition.name)).toEqual(["edit", "ask_user"]);
  });

  it("omits ask_user when the capability is disabled", () => {
    const definitions = createPiWebCustomToolDefinitions("/workspace", true);

    expect(definitions.map((definition) => definition.name)).toEqual(["edit"]);
  });
});

describe("PiSessionService.openAsk", () => {
  it("adds every question set to the session's open asks instead of superseding", async () => {
    const { service, store, events } = askService();

    const first = await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });
    const second = await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions: [{ id: "again", question: "Still?", options: [] }] });

    expect(first).toEqual(openedAsk("ask-1"));
    expect(store.pendingAsks(ACTIVE_SESSION_ID).map((ask) => ask.askId)).toEqual([first.askId, second.askId]);
    expect(askEvents(events).map(({ event }) => event.type)).toEqual(["ask.opened", "ask.opened"]);
    await service.dispose();
  });

  it("keeps asks of different sessions independent", async () => {
    const { service, store } = askService();

    await service.openAsk({ sessionId: "session-1", context, questions });
    await service.openAsk({ sessionId: "session-2", context, questions });

    expect(store.pendingAsks("session-1").map((ask) => ask.askId)).toEqual(["ask-1"]);
    expect(store.pendingAsks("session-2").map((ask) => ask.askId)).toEqual(["ask-2"]);
    await service.dispose();
  });

  it("publishes ask.opened so a watching browser renders the card without refetching status", async () => {
    const { service, events } = askService();

    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    expect(askEvents(events)).toEqual([{ sessionId: ACTIVE_SESSION_ID, event: { type: "ask.opened", ask: openedAsk("ask-1") } }]);
    await service.dispose();
  });

  it("publishes a bounded global ask preview with session metadata", async () => {
    const { service, events, fake } = askService({ withActiveSession: true });
    await service.status(sessionRef(ACTIVE_SESSION_ID));
    fake.session.sessionName = "Build Chat";
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions: [{ id: "q", question: "x".repeat(150), options: [] }] });
    expect(events.globalEvents).toContainEqual({ type: "session.attention", sessionId: ACTIVE_SESSION_ID, cwd: "/workspace", sessionName: "Build Chat", kind: "ask", id: "ask-1", detail: "x".repeat(120) });
    await service.dispose();
  });
});

describe("PiSessionService ask update and withdraw", () => {
  it("republishes an updated ask under the same id and closes a withdrawn one without waking the agent", async () => {
    const { service, store, events, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    const updated = await service.updateAsk({ sessionId: ACTIVE_SESSION_ID, askId: "ask-1", context: "New finding." });
    const withdrawn = await service.withdrawAsk(ACTIVE_SESSION_ID, "ask-1");

    expect(updated).toMatchObject({ askId: "ask-1", context: "New finding." });
    expect(withdrawn).toMatchObject({ askId: "ask-1", reason: "withdrawn" });
    expect(askEvents(events).map(({ event }) => event)).toEqual([
      { type: "ask.opened", ask: openedAsk("ask-1") },
      { type: "ask.opened", ask: openedAsk("ask-1", { context: "New finding." }) },
      { type: "ask.closed", askId: "ask-1", reason: "withdrawn" },
    ]);
    expect(store.pendingAsks(ACTIVE_SESSION_ID)).toEqual([]);
    expect(fake.calls.sendCustomMessage).toEqual([]);
    expect(await service.updateAsk({ sessionId: ACTIVE_SESSION_ID, askId: "ask-1" })).toBeUndefined();
    await service.dispose();
  });
});

describe("PiSessionService ask status projection", () => {
  it("reports the open asks in status so a reloading browser rehydrates them", async () => {
    const { service } = askService({ withActiveSession: true });

    const before = await service.status(sessionRef(ACTIVE_SESSION_ID));
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });
    const during = await service.status(sessionRef(ACTIVE_SESSION_ID));
    await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] });
    const after = await service.status(sessionRef(ACTIVE_SESSION_ID));

    expect(before).not.toHaveProperty("pendingAsks");
    expect(during.pendingAsks).toEqual([openedAsk("ask-1")]);
    expect(after).not.toHaveProperty("pendingAsks");
    await service.dispose();
  });

  it("counts each started agent turn against the open asks", async () => {
    const { service, fake } = askService({ withActiveSession: true });
    await service.status(sessionRef(ACTIVE_SESSION_ID));
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    fake.emit({ type: "agent_start" });
    fake.emit({ type: "turn_start" });
    fake.emit({ type: "agent_end", messages: [] });
    fake.emit({ type: "agent_start" });

    expect((await service.status(sessionRef(ACTIVE_SESSION_ID))).pendingAsks?.[0]?.turnsSinceUpdate).toBe(2);
    await service.dispose();
  });

  it("drops the open asks when the runtime that posted them is closed", async () => {
    const { service, store } = askService({ withActiveSession: true });
    await service.status(sessionRef(ACTIVE_SESSION_ID));
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    await service.stop(sessionRef(ACTIVE_SESSION_ID));

    expect(store.pendingAsks(ACTIVE_SESSION_ID)).toEqual([]);
    await service.dispose();
  });

  it("rebuilds still-open asks from the transcript when a session is opened, e.g. after a daemon restart", async () => {
    const toolResult = (details: unknown) => ({ type: "message", message: { role: "toolResult", toolName: "ask_user", details } });
    const branch = [
      { id: "e1", parentId: null, ...toolResult({ ask: openedAsk("kept") }) },
      { id: "e2", parentId: "e1", ...toolResult({ ask: openedAsk("answered") }) },
      { id: "e3", parentId: "e2", type: "custom_message", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, details: { askId: "answered" } },
      { id: "e4", parentId: "e3", type: "message", message: { role: "user", content: "go on" } },
    ];
    const { service } = askService({ withActiveSession: true, branch });

    const status = await service.status(sessionRef(ACTIVE_SESSION_ID));

    expect(status.pendingAsks).toEqual([openedAsk("kept", { turnsSinceUpdate: 1 })]);
    await expect(service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "kept", { answers: [] })).resolves.toMatchObject({ result: "closed" });
    await service.dispose();
  });
});

describe("PiSessionService.submitAsk", () => {
  it("delivers a custom answer as a follow-up message that wakes the session", async () => {
    const { service, store, events, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    const response = await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", {
      answers: [{ id: "db", values: [], otherText: "DuckDB" }],
    });

    expect(response).toMatchObject({ result: "closed", outcome: { askId: "ask-1", reason: "submitted", answeredCount: 1, unansweredIds: [] } });
    expect(response.sessionStatus.sessionId).toBe(ACTIVE_SESSION_ID);
    expect(fake.calls.sendCustomMessage).toHaveLength(1);
    const [delivered] = fake.calls.sendCustomMessage;
    expect(delivered?.message.customType).toBe(ASK_USER_ANSWERS_CUSTOM_TYPE);
    expect(delivered?.message.display).toBe(true);
    expect(delivered?.message.content).toContain("The user submitted answers to question set ask-1.");
    expect(delivered?.message.content).toContain(`- ask.db: Which database?\n  Answered: custom: "DuckDB"`);
    expect(delivered?.message.content).toContain("Answered 1 of 1");
    expect(delivered?.message.content).not.toContain("still open");
    expect(delivered?.message.details).toMatchObject({ askId: "ask-1", reason: "submitted" });
    expect(delivered?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(askEvents(events).map(({ event }) => event.type)).toEqual(["ask.opened", "ask.closed"]);
    expect(store.pendingAsks(ACTIVE_SESSION_ID)).toEqual([]);
    await service.dispose();
  });

  it("answers one of several open sets and reminds the agent of the others", async () => {
    const { service, store, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions: [{ id: "cache", question: "Which cache?", options: [] }] });

    const response = await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-2", { answers: [] });

    expect(response.outcome).toMatchObject({ askId: "ask-2", answeredCount: 0, unansweredIds: ["cache"] });
    expect(fake.calls.sendCustomMessage[0]?.message.content).toContain("Answered 0 of 1; unanswered: cache");
    expect(fake.calls.sendCustomMessage[0]?.message.content).toContain("- ask-1 (ask.db;");
    expect(store.pendingAsks(ACTIVE_SESSION_ID).map((ask) => ask.askId)).toEqual(["ask-1"]);
    await service.dispose();
  });

  it("reports a stale ask id without delivering anything or closing the open ask", async () => {
    const { service, store, events, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    const response = await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-gone", { answers: [] });

    expect(response.result).toBe("stale");
    expect(response).not.toHaveProperty("outcome");
    expect(response.sessionStatus.pendingAsks).toEqual([openedAsk("ask-1")]);
    expect(fake.calls.sendCustomMessage).toEqual([]);
    expect(askEvents(events).map(({ event }) => event.type)).toEqual(["ask.opened"]);
    expect(store.pendingAsks(ACTIVE_SESSION_ID)).toHaveLength(1);
    await service.dispose();
  });

  it("leaves the ask open when the submitted answers do not fit its questions", async () => {
    const { service, store, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    await expect(service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", { answers: [{ id: "nope", values: [] }] }))
      .rejects.toThrow(PendingAskValidationError);

    expect(store.pendingAsks(ACTIVE_SESSION_ID)).toHaveLength(1);
    expect(fake.calls.sendCustomMessage).toEqual([]);
    await service.dispose();
  });
});

describe("PiSessionService prompts and commands with open asks", () => {
  it("keeps open asks when the user sends an ordinary chat message, and reminds the agent of them", async () => {
    const { service, store, events, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    await service.prompt(sessionRef(ACTIVE_SESSION_ID), "Use DuckDB");

    expect(store.pendingAsks(ACTIVE_SESSION_ID).map((ask) => ask.askId)).toEqual(["ask-1"]);
    expect(askEvents(events).map(({ event }) => event.type)).toEqual(["ask.opened"]);
    expect(fake.calls.sendCustomMessage).toHaveLength(1);
    const [reminder] = fake.calls.sendCustomMessage;
    expect(reminder?.message).toMatchObject({ customType: ASK_USER_REMINDER_CUSTOM_TYPE, display: false });
    expect(reminder?.message.content).toContain("- ask-1 (ask.db; updated 2026-02-01T10:00:00.000Z, 0 turns ago): Which database?");
    expect(reminder?.options).toEqual({ deliverAs: "nextTurn" });
    expect(fake.calls.prompt.map((call) => call.text)).toEqual(["Use DuckDB"]);
    await service.dispose();
  });

  it("injects no reminder when no ask is open", async () => {
    const { service, events, fake } = askService({ withActiveSession: true });

    await service.prompt(sessionRef(ACTIVE_SESSION_ID), "hello");

    expect(fake.calls.sendCustomMessage).toEqual([]);
    expect(fake.calls.prompt.map((call) => call.text)).toEqual(["hello"]);
    expect(askEvents(events)).toEqual([]);
    await service.dispose();
  });

  it.each(["followUp", "steer"])("keeps open asks when a queued %s message reaches the model", async (behavior) => {
    const { service, store, fake } = askService({ withActiveSession: true });
    await service.status(sessionRef(ACTIVE_SESSION_ID));
    fake.session.isStreaming = true;
    await service.prompt(sessionRef(ACTIVE_SESSION_ID), "Use DuckDB", behavior);
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    const message = { role: "user", content: [{ type: "text", text: "Use DuckDB" }] };
    fake.emit({ type: "message_start", message });
    fake.emit({ type: "message_end", message });

    expect(store.pendingAsks(ACTIVE_SESSION_ID).map((ask) => ask.askId)).toEqual(["ask-1"]);
    expect(fake.calls.sendCustomMessage).toEqual([]);
    await service.dispose();
  });

  it("keeps open asks answerable across conversation commands", async () => {
    const { service, store, fake } = askService({ withActiveSession: true });
    fake.session.extensionRunner.getRegisteredCommands = () => [{ invocationName: "mode" }, { invocationName: "discuss" }];
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    await expect(service.runCommand(sessionRef(ACTIVE_SESSION_ID), "/mode alignment plan")).resolves.toEqual({ type: "done" });
    await service.runCommand(sessionRef(ACTIVE_SESSION_ID), "/discuss alternatives");

    expect(store.pendingAsks(ACTIVE_SESSION_ID)).toHaveLength(1);
    expect(fake.calls.sendCustomMessage).toEqual([]);
    await expect(service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }] }))
      .resolves.toMatchObject({ result: "closed", outcome: { reason: "submitted" } });
    expect(fake.calls.prompt.map((call) => call.text)).toEqual(["/mode alignment plan", "/discuss alternatives"]);
    await service.dispose();
  });
});

describe("PiSessionService.cancelAsk", () => {
  it("tells the model every question went unanswered rather than leaving it waiting", async () => {
    const { service, store, events, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    const response = await service.cancelAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1");

    expect(response).toMatchObject({ result: "closed", outcome: { reason: "cancelled", answeredCount: 0, unansweredIds: ["db"] } });
    expect(fake.calls.sendCustomMessage[0]?.message.content).toContain("closed (cancelled) before it was fully answered");
    expect(fake.calls.sendCustomMessage[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(askEvents(events).at(-1)?.event).toEqual({ type: "ask.closed", askId: "ask-1", reason: "cancelled" });
    expect(store.pendingAsks(ACTIVE_SESSION_ID)).toEqual([]);
    await service.dispose();
  });

  it("reports a stale cancel of an ask that is already gone", async () => {
    const { service, fake } = askService({ withActiveSession: true });

    const response = await service.cancelAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1");

    expect(response.result).toBe("stale");
    expect(fake.calls.sendCustomMessage).toEqual([]);
    await service.dispose();
  });
});
