import { describe, expect, it, vi } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE } from "../../shared/apiTypes.js";
import { createPiWebCustomToolDefinitions, PiSessionService } from "./piSessionService.js";
import { ASK_USER_CLOSED_CUSTOM_TYPE, ASK_USER_REMINDER_CUSTOM_TYPE, PendingAskStore, PendingAskValidationError } from "./pendingAskStore.js";
import type { PiSessionManager } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const ACTIVE_SESSION_ID = "session-1";

const questions = [{ id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] }];
const context = "Postgres is already deployed; I recommend it.";
const T0 = "2026-02-01T10:00:00.000Z";
const openedAsk = (askId: string, overrides: Record<string, unknown> = {}) => ({ askId, askedAt: T0, updatedAt: T0, revision: "r1", turnsSinceUpdate: 0, context, questions, ...overrides });
const postedAsk = (askId: string, sessionId = ACTIVE_SESSION_ID) => ({ type: "message", message: { role: "toolResult", toolName: "ask_user", details: { ask: openedAsk(askId), sessionId } } });

/**
 * Service over a clocked store with sequential ask ids and revisions (`r1`, …), so asks are named
 * `ask-1`, `bsk-2`, … (distinct ref prefixes) and timestamps are fixed. Pass
 * `withActiveSession` when the test needs a live runtime to deliver answers
 * into, and `branch` for a transcript the runtime reads and appends to.
 */
function askService(options: { withActiveSession?: boolean; branch?: unknown[]; manager?: Partial<PiSessionManager> } = {}) {
  const store = new PendingAskStore({
    now: () => new Date("2026-02-01T10:00:00.000Z"),
    createAskId: (() => {
      let next = 0;
      return () => { next += 1; return `${"abcdefghij".charAt(next - 1)}sk-${next.toString()}`; };
    })(),
    createRevision: (() => {
      let next = 0;
      return () => { next += 1; return `r${next.toString()}`; };
    })(),
  });
  const fake = fakeRuntime(ACTIVE_SESSION_ID);
  if (options.branch !== undefined) {
    const branch = options.branch;
    fake.session.sessionManager = fakeSessionManager("/workspace", {
      getBranch: () => branch,
      getEntries: () => branch,
      appendCustomEntry: (customType, data) => { branch.push({ type: "custom", customType, data }); return `e${branch.length.toString()}`; },
      ...options.manager,
    });
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
    expect(store.pendingAsks("session-2").map((ask) => ask.askId)).toEqual(["bsk-2"]);
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
      { type: "ask.opened", ask: openedAsk("ask-1", { context: "New finding.", revision: "r2" }) },
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
    await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", { revision: "r1", answers: [{ id: "db", values: ["pg"] }] });
    const after = await service.status(sessionRef(ACTIVE_SESSION_ID));

    expect(before).not.toHaveProperty("pendingAsks");
    expect(during.pendingAsks).toEqual([openedAsk("ask-1")]);
    expect(after).not.toHaveProperty("pendingAsks");
    expect(after).not.toHaveProperty("pendingAsk");
    await service.dispose();
  });

  it("keeps reporting the oldest open ask as the legacy pendingAsk for older browsers", async () => {
    const { service } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    const status = await service.status(sessionRef(ACTIVE_SESSION_ID));

    expect(status.pendingAsks?.map((ask) => ask.askId)).toEqual(["ask-1", "bsk-2"]);
    expect(status.pendingAsk).toEqual(openedAsk("ask-1"));
    await service.dispose();
  });

  it("counts every agent turn of a run against the open asks, matching a rebuild", async () => {
    const branch: unknown[] = [postedAsk("ask-1")];
    const { service, fake } = askService({ withActiveSession: true, branch });
    await service.status(sessionRef(ACTIVE_SESSION_ID));

    fake.emit({ type: "agent_start" });
    for (let turn = 0; turn < 3; turn += 1) {
      fake.emit({ type: "turn_start" });
      branch.push({ type: "message", message: { role: "assistant", content: [] } });
    }
    fake.emit({ type: "agent_end", messages: [] });

    expect((await service.status(sessionRef(ACTIVE_SESSION_ID))).pendingAsks?.[0]?.turnsSinceUpdate).toBe(3);
    const rebuilt = askService({ withActiveSession: true, branch });
    expect((await rebuilt.service.status(sessionRef(ACTIVE_SESSION_ID))).pendingAsks?.[0]?.turnsSinceUpdate).toBe(3);
    await service.dispose();
    await rebuilt.service.dispose();
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
    const branch = [
      postedAsk("kept"),
      postedAsk("answered"),
      { type: "custom_message", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, details: { askId: "answered" } },
      { type: "message", message: { role: "assistant", content: [] } },
    ];
    const { service, fake } = askService({ withActiveSession: true, branch });

    const status = await service.status(sessionRef(ACTIVE_SESSION_ID));

    expect(status.pendingAsks).toEqual([openedAsk("kept", { turnsSinceUpdate: 1 })]);
    expect(fake.calls.sendCustomMessage).toEqual([]);
    await expect(service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "kept", { revision: "r1", answers: [] })).resolves.toMatchObject({ result: "closed" });
    await service.dispose();
  });

  it("does not restore a parent's asks into a fork", async () => {
    const { service } = askService({ withActiveSession: true, branch: [postedAsk("parent-ask", "parent-session")] });

    expect(await service.status(sessionRef(ACTIVE_SESSION_ID))).not.toHaveProperty("pendingAsks");
    await service.dispose();
  });

  it("closes an ask a tree rewind leaves behind, and a reload does not restore it", async () => {
    const user = { type: "message", message: { role: "user", content: "start" } };
    const branch: unknown[] = [user, postedAsk("ask-x")];
    let leafId = "leaf-1";
    const { service, events, fake } = askService({ withActiveSession: true, branch, manager: { getLeafId: () => leafId } });
    fake.session.navigateTree = () => { leafId = "target-1"; branch.splice(1); return Promise.resolve({ cancelled: false }); };
    expect((await service.status(sessionRef(ACTIVE_SESSION_ID))).pendingAsks).toHaveLength(1);

    await service.navigateTree(sessionRef(ACTIVE_SESSION_ID), { targetId: "target-1", expectedLeafId: "leaf-1", summary: { mode: "none" } });

    expect(await service.status(sessionRef(ACTIVE_SESSION_ID))).not.toHaveProperty("pendingAsks");
    expect(askEvents(events).map(({ event }) => event)).toEqual([{ type: "ask.closed", askId: "ask-x", reason: "cancelled" }]);
    const reloaded = askService({ withActiveSession: true, branch });
    expect(await reloaded.service.status(sessionRef(ACTIVE_SESSION_ID))).not.toHaveProperty("pendingAsks");
    await service.dispose();
    await reloaded.service.dispose();
  });
});

describe("PiSessionService.submitAsk", () => {
  it("delivers a custom answer as a follow-up message that wakes the session", async () => {
    const { service, store, events, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });

    const response = await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", {
      answers: [{ id: "db", values: [], otherText: "DuckDB" }],
      revision: "r1",
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

    const response = await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "bsk-2", { revision: "r2", answers: [] });

    expect(response.outcome).toMatchObject({ askId: "bsk-2", answeredCount: 0, unansweredIds: ["cache"] });
    expect(fake.calls.sendCustomMessage[0]?.message.content).toContain("Answered 0 of 1; unanswered: cache");
    expect(fake.calls.sendCustomMessage[0]?.message.content).toContain("- ask-1 (ask.db;");
    expect(store.pendingAsks(ACTIVE_SESSION_ID).map((ask) => ask.askId)).toEqual(["ask-1"]);
    await service.dispose();
  });

  it("persists the answers before acknowledging a submit while the agent streams, so a rebuild neither reopens nor loses them", async () => {
    const branch: unknown[] = [];
    const { service, fake } = askService({ withActiveSession: true, branch });
    await service.status(sessionRef(ACTIVE_SESSION_ID));
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });
    branch.push(postedAsk("ask-1"));
    fake.session.isStreaming = true;
    const recordedBeforeDelivery: boolean[] = [];
    const deliver = fake.session.sendCustomMessage.bind(fake.session);
    fake.session.sendCustomMessage = (message, options) => {
      recordedBeforeDelivery.push(branch.some((entry) => typeof entry === "object" && entry !== null && Reflect.get(entry, "customType") === ASK_USER_CLOSED_CUSTOM_TYPE));
      return deliver(message, options);
    };

    // The follow-up only waits in Pi's memory and never reaches the branch before the daemon goes away.
    const response = await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }], revision: "r1" });
    expect(response.result).toBe("closed");
    expect(recordedBeforeDelivery).toEqual([true]);
    await service.dispose();

    const restarted = askService({ withActiveSession: true, branch });
    expect(await restarted.service.status(sessionRef(ACTIVE_SESSION_ID))).not.toHaveProperty("pendingAsks");
    await vi.waitFor(() => { expect(restarted.fake.calls.sendCustomMessage).toHaveLength(1); });
    const [redelivered] = restarted.fake.calls.sendCustomMessage;
    expect(redelivered?.message).toMatchObject({ customType: ASK_USER_ANSWERS_CUSTOM_TYPE, details: { askId: "ask-1", reason: "submitted" } });
    expect(redelivered?.message.content).toContain("Answered: selected pg");
    expect(redelivered?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    await restarted.service.dispose();
  });

  it("redelivers several recorded closes one at a time on runtime start, each exactly once", async () => {
    const closed = (askId: string) => ({ type: "custom", customType: ASK_USER_CLOSED_CUSTOM_TYPE, data: { askId, reason: "submitted", askedAt: T0, closedAt: T0, context, questions: [], answeredCount: 0, unansweredIds: [], summary: "Answered 0 of 0" } });
    const branch: unknown[] = [postedAsk("ask-1"), postedAsk("bsk-2"), closed("ask-1"), closed("bsk-2")];
    const { service, events, fake } = askService({ withActiveSession: true, branch });
    // Pi refuses a second triggered turn while the first still runs, as an idle runtime does on start.
    let running = false;
    const deliver = fake.session.sendCustomMessage.bind(fake.session);
    fake.session.sendCustomMessage = async (message, options) => {
      if (running) throw new Error("Agent is already processing a prompt.");
      running = true;
      await deliver(message, options);
      await new Promise((resolve) => setTimeout(resolve, 1));
      branch.push({ type: "custom_message", customType: message.customType, details: message.details });
      running = false;
    };

    await service.status(sessionRef(ACTIVE_SESSION_ID));

    await vi.waitFor(() => { expect(fake.calls.sendCustomMessage).toHaveLength(2); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.calls.sendCustomMessage.map(({ message }) => message.details)).toMatchObject([{ askId: "ask-1" }, { askId: "bsk-2" }]);
    expect(events.sessionEvents.filter(({ event }) => event.type === "session.error")).toEqual([]);
    await service.dispose();
  });

  it("stops redelivering once the runtime is disposed", async () => {
    const closed = (askId: string) => ({ type: "custom", customType: ASK_USER_CLOSED_CUSTOM_TYPE, data: { askId, reason: "submitted", askedAt: T0, closedAt: T0, context, questions: [], answeredCount: 0, unansweredIds: [], summary: "Answered 0 of 0" } });
    const branch: unknown[] = [postedAsk("ask-1"), postedAsk("bsk-2"), closed("ask-1"), closed("bsk-2")];
    const { service, fake } = askService({ withActiveSession: true, branch });
    let release: () => void = () => undefined;
    const deliver = fake.session.sendCustomMessage.bind(fake.session);
    fake.session.sendCustomMessage = async (message, options) => {
      await deliver(message, options);
      await new Promise<void>((resolve) => { release = resolve; });
    };

    await service.status(sessionRef(ACTIVE_SESSION_ID));
    await vi.waitFor(() => { expect(fake.calls.sendCustomMessage).toHaveLength(1); });
    await service.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fake.calls.sendCustomMessage).toHaveLength(1);
  });

  it("refuses answers to an older revision of a revised ask as stale", async () => {
    const { service, store, fake } = askService({ withActiveSession: true });
    await service.openAsk({ sessionId: ACTIVE_SESSION_ID, context, questions });
    await service.updateAsk({ sessionId: ACTIVE_SESSION_ID, askId: "ask-1", questions: [{ id: "db", question: "Which cache?", options: [{ value: "pg", label: "Redis" }] }] });

    const response = await service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", { answers: [{ id: "db", values: ["pg"] }], revision: "r1" });

    expect(response.result).toBe("stale");
    expect(response.sessionStatus.pendingAsks?.[0]).toMatchObject({ askId: "ask-1", revision: "r2" });
    expect(store.pendingAsks(ACTIVE_SESSION_ID)).toHaveLength(1);
    expect(fake.calls.sendCustomMessage).toEqual([]);
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

    await expect(service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", { revision: "r1", answers: [{ id: "nope", values: [] }] }))
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
    await expect(service.submitAsk(sessionRef(ACTIVE_SESSION_ID), "ask-1", { revision: "r1", answers: [{ id: "db", values: ["pg"] }] }))
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
