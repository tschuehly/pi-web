import { describe, expect, it } from "vitest";
import { ASK_USER_CONTEXT_MAX_LENGTH, ASK_USER_OPTION_LIMIT, ASK_USER_QUESTION_LIMIT, type AskUserQuestion } from "../../shared/apiTypes.js";
import {
  PendingAskStore,
  PendingAskValidationError,
  renderAskUserAnswersText,
  renderOpenAsksReminder,
} from "./pendingAskStore.js";

const sessionId = "session-1";
const context = "Found two options; I recommend yes.";

/** Ask ids `ask-1`, `bsk-2`, `csk-3`, …: distinct question-ref prefixes, as the store requires. Revisions `r1`, `r2`, …. */
function testStore() {
  let askCount = 0;
  let revisionCount = 0;
  let tick = 0;
  return new PendingAskStore({
    createAskId: () => `${"abcdefghij".charAt(askCount)}sk-${(++askCount).toString()}`,
    createRevision: () => `r${(++revisionCount).toString()}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}

function question(id: string, overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    id,
    question: `Question ${id}?`,
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    ...overrides,
  };
}

function openTwoQuestions(store: PendingAskStore) {
  return store.open({ sessionId, context, questions: [question("q1"), question("q2")] });
}

describe("PendingAskStore validation", () => {
  it("normalizes an accepted ask and reports it as the session's pending ask", () => {
    const store = testStore();
    const result = store.open({
      sessionId,
      context,
      questions: [
        {
          id: "q1",
          question: "Which database?",
          detail: "Only the primary store matters here.",
          options: [{ value: "pg", label: "Postgres", detail: "Existing cluster" }],
          multiple: false,
        },
      ],
    });

    expect(result).toEqual({
      askId: "ask-1",
      askedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: "r1",
      turnsSinceUpdate: 0,
      context,
      questions: [
        {
          id: "q1",
          question: "Which database?",
          detail: "Only the primary store matters here.",
          options: [{ value: "pg", label: "Postgres", detail: "Existing cluster" }],
        },
      ],
    });
    expect(store.pendingAsks(sessionId)).toEqual([result]);
    expect(store.pendingAsks("other-session")).toEqual([]);
  });

  it("rejects asks the user could not meaningfully answer", () => {
    const store = testStore();
    const reject = (questions: AskUserQuestion[]) => () => store.open({ sessionId, context, questions });

    expect(() => store.open({ sessionId, questions: [question("q1")] })).toThrow(/context is required/);
    expect(() => store.open({ sessionId, context })).toThrow(/questions are required/);

    expect(reject([])).toThrow(PendingAskValidationError);
    expect(reject(Array.from({ length: ASK_USER_QUESTION_LIMIT + 1 }, (_, index) => question(`q${index.toString()}`))))
      .toThrow(/more than 20 questions/);
    expect(reject([question("q1"), question("q1")])).toThrow(/Duplicate question id q1/);
    expect(reject([question(" ")])).toThrow(/question id must not be empty/);
    expect(reject([question("q1", { question: "  " })])).toThrow(/text of question q1 must not be empty/);
    expect(reject([question("q1", { options: [{ value: "a", label: "A" }, { value: "a", label: "Again" }] })]))
      .toThrow(/Duplicate option value a in question q1/);
    expect(reject([question("q1", { options: [{ value: "a", label: " " }] })]))
      .toThrow(/label of option a in question q1 must not be empty/);
    expect(reject([question("q1", {
      options: Array.from({ length: ASK_USER_OPTION_LIMIT + 1 }, (_, index) => ({ value: `v${index.toString()}`, label: "L" })),
    })])).toThrow(/more than 12 options/);
    expect(store.pendingAsks(sessionId)).toEqual([]);
  });

  it("accepts an optionless question", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1", { options: [] })] });
    expect(ask.questions[0]).toEqual({ id: "q1", question: "Question q1?", options: [] });
  });

  it("keeps the ask's context through the pending ask and its close outcome", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context: "Found **two** options.", questions: [question("q1")] });

    expect(ask.context).toBe("Found **two** options.");
    expect(store.pendingAsks(sessionId)[0]?.context).toBe("Found **two** options.");
    const cancelled = store.cancel(sessionId, ask.askId);
    expect(cancelled).toMatchObject({ outcome: { context: "Found **two** options." } });
  });

  it("rejects blank context and context over its length limit", () => {
    const store = testStore();

    expect(() => store.open({ sessionId, context: "  ", questions: [question("q1")] })).toThrow(/context is required/);
    expect(() => store.open({ sessionId, context: "x".repeat(ASK_USER_CONTEXT_MAX_LENGTH + 1), questions: [question("q1")] }))
      .toThrow(/context exceeds its length limit/);
  });

  it("keeps a recommended option flag", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1", { options: [{ value: "a", label: "A", recommended: true }] })] });
    expect(ask.questions[0]?.options[0]).toEqual({ value: "a", label: "A", recommended: true });
  });
});

describe("PendingAskStore submit", () => {
  it("reports answered and unanswered questions for a partial submit", () => {
    const store = testStore();
    const ask = store.open({
      sessionId,
      context,
      questions: [question("q1"), question("q2"), question("q3")],
    });

    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q2", values: ["no"] }] });

    expect(result).toEqual({
      status: "closed",
      outcome: {
        askId: "ask-1",
        reason: "submitted",
        askedAt: "2026-01-01T00:00:00.000Z",
        closedAt: "2026-01-01T00:00:01.000Z",
        context,
        questions: [
          { question: ask.questions[0], answered: false, values: [] },
          { question: ask.questions[1], answered: true, values: ["no"] },
          { question: ask.questions[2], answered: false, values: [] },
        ],
        answeredCount: 1,
        unansweredIds: ["q1", "q3"],
        summary: "Answered 1 of 3; unanswered: q1, q3",
      },
    });
    expect(store.pendingAsks(sessionId)).toEqual([]);
  });

  it("summarizes a fully answered ask without an unanswered list", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);

    const result = store.submit(sessionId, ask.askId, {
      revision: ask.revision,
      answers: [{ id: "q1", values: ["yes"] }, { id: "q2", values: ["no"] }],
    });

    expect(result).toMatchObject({
      status: "closed",
      outcome: { answeredCount: 2, unansweredIds: [], summary: "Answered 2 of 2; none left unanswered" },
    });
  });

  it("treats an empty answer as leaving the question untouched", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1"), question("q2")] });

    const result = store.submit(sessionId, ask.askId, {
      revision: ask.revision,
      answers: [{ id: "q1", values: [] }, { id: "q2", values: [], otherText: "   " }],
    });

    expect(result).toMatchObject({ status: "closed", outcome: { answeredCount: 0, unansweredIds: ["q1", "q2"] } });
  });

  it("rejects several values for a single-select question and keeps the ask open", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);

    expect(() => store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes", "no"] }] }))
      .toThrow(/Question q1 accepts a single answer/);
    expect(store.pendingAsks(sessionId)[0]?.askId).toBe(ask.askId);
  });

  it("accepts several values and coexisting custom text for a multi-select question", () => {
    const store = testStore();
    const ask = store.open({
      sessionId,
      context,
      questions: [question("q1", { multiple: true })],
    });

    const result = store.submit(sessionId, ask.askId, {
      revision: ask.revision,
      answers: [{ id: "q1", values: ["yes", "no"], otherText: "  maybe later  " }],
    });

    expect(result).toMatchObject({
      status: "closed",
      outcome: {
        questions: [{ answered: true, values: ["yes", "no"], otherText: "maybe later" }],
        answeredCount: 1,
      },
    });
  });

  it("accepts custom text for every question", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);

    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: [], otherText: "custom" }] });

    expect(result).toMatchObject({ status: "closed", outcome: { answeredCount: 1 } });
    if (result.status !== "closed") throw new Error("expected the ask to close");
    expect(result.outcome.questions[0]).toMatchObject({ answered: true, values: [], otherText: "custom" });
  });

  it("answers a free-text-only question with custom text alone", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1", { options: [] })] });

    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: [], otherText: "a note" }] });

    expect(result).toMatchObject({ status: "closed", outcome: { questions: [{ answered: true, values: [], otherText: "a note" }] } });
  });

  it("rejects unknown, duplicated, and unoffered answers", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    const reject = (answers: Parameters<typeof store.submit>[2]["answers"]) => () => store.submit(sessionId, ask.askId, { revision: ask.revision, answers });

    expect(reject([{ id: "q9", values: ["yes"] }])).toThrow(/Unknown question id q9/);
    expect(reject([{ id: "q1", values: ["yes"] }, { id: "q1", values: ["no"] }])).toThrow(/Duplicate answer for question q1/);
    expect(reject([{ id: "q1", values: ["nope"] }])).toThrow(/Question q1 has no option nope/);
    expect(reject([{ id: "q1", values: ["yes", "yes"] }])).toThrow(/Duplicate value yes for question q1/);
    expect(store.pendingAsks(sessionId)[0]?.askId).toBe(ask.askId);
  });

  it("refuses a submit for an older revision as stale and keeps the revised ask open", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    store.update({ sessionId, askId: ask.askId, questions: [question("q1", { question: "Changed q1?" }), question("q2")] });

    expect(store.submit(sessionId, ask.askId, { answers: [{ id: "q1", values: ["yes"] }], revision: "r1" })).toEqual({ status: "stale" });
    expect(store.pendingAsks(sessionId).map((open) => open.revision)).toEqual(["r2"]);
    expect(store.submit(sessionId, ask.askId, { answers: [{ id: "q1", values: ["yes"] }], revision: "r2" })).toMatchObject({ status: "closed" });
  });

  it("refuses a submit without a revision as stale, so an old browser cannot answer a revised ask", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    store.update({ sessionId, askId: ask.askId, questions: [question("q1", { question: "Delete production database?" })] });

    expect(store.submit(sessionId, ask.askId, { answers: [{ id: "q1", values: ["yes"] }] })).toEqual({ status: "stale" });
    expect(store.pendingAsks(sessionId)).toHaveLength(1);
  });

  it("never reissues a revision after a rewind restores an older one, so an answer from the abandoned branch stays stale", () => {
    const store = testStore();
    const posted = openTwoQuestions(store);
    const branchA = store.update({ sessionId, askId: posted.askId, questions: [question("q1", { question: "Keep staging?" })] });
    store.cancelAll(sessionId);
    store.restore(sessionId, [posted]);
    const branchB = store.update({ sessionId, askId: posted.askId, questions: [question("q1", { question: "Delete production database?" })] });

    expect(branchB?.revision).not.toEqual(branchA?.revision);
    expect(store.submit(sessionId, posted.askId, { answers: [{ id: "q1", values: ["yes"] }], revision: branchA?.revision ?? "" })).toEqual({ status: "stale" });
  });

  it("keeps the ask open when recording its outcome fails", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    const recorded: string[] = [];

    expect(() => store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [] }, () => { throw new Error("disk full"); })).toThrow("disk full");
    expect(store.pendingAsks(sessionId)).toHaveLength(1);
    store.cancel(sessionId, ask.askId, (outcome) => { recorded.push(outcome.askId); });
    expect(recorded).toEqual([ask.askId]);
  });

  it("treats a submit or cancel for an ask that is no longer open as stale", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);

    expect(store.submit(sessionId, "ask-other", { answers: [] })).toEqual({ status: "stale" });
    expect(store.cancel(sessionId, "ask-other")).toEqual({ status: "stale" });
    expect(store.submit("session-2", ask.askId, { revision: ask.revision, answers: [] })).toEqual({ status: "stale" });

    store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [] });
    expect(store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [] })).toEqual({ status: "stale" });
  });
});

describe("PendingAskStore open asks", () => {
  it("keeps several asks of one session open, oldest first", () => {
    const store = testStore();
    const first = openTwoQuestions(store);
    const second = store.open({ sessionId, context, questions: [question("q3")] });

    expect(store.pendingAsks(sessionId).map((ask) => ask.askId)).toEqual([first.askId, second.askId]);
    expect(store.submit(sessionId, first.askId, { revision: first.revision, answers: [] })).toMatchObject({ status: "closed" });
    expect(store.pendingAsks(sessionId).map((ask) => ask.askId)).toEqual([second.askId]);
  });

  it("keeps each session's asks separate", () => {
    const store = testStore();
    const first = openTwoQuestions(store);
    const second = store.open({ sessionId: "session-2", context, questions: [question("q3")] });

    expect([store.pendingAsks(sessionId), store.pendingAsks("session-2")]).toEqual([[first], [second]]);
  });

  it("revises an open ask in place, keeping omitted fields and resetting its staleness", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    store.countAgentTurn(sessionId);
    store.countAgentTurn(sessionId);
    expect(store.pendingAsks(sessionId)[0]?.turnsSinceUpdate).toBe(2);

    const reworded = store.update({ sessionId, askId: ask.askId, questions: [question("q1", { question: "Still q1?" })] });

    expect(reworded).toEqual({ ...ask, updatedAt: "2026-01-01T00:00:01.000Z", revision: "r2", turnsSinceUpdate: 0, questions: [question("q1", { question: "Still q1?" })] });
    const confirmed = store.update({ sessionId, askId: ask.askId });
    expect(confirmed).toMatchObject({ askId: ask.askId, context, updatedAt: "2026-01-01T00:00:02.000Z", revision: "r3", questions: reworded?.questions });
    expect(store.update({ sessionId, askId: "ask-other" })).toBeUndefined();
    expect(() => store.update({ sessionId, askId: ask.askId, questions: [] })).toThrow(PendingAskValidationError);
  });

  it("withdraws an open ask as unanswered and treats a second withdraw as gone", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);

    expect(store.withdraw(sessionId, ask.askId)).toMatchObject({ askId: ask.askId, reason: "withdrawn", unansweredIds: ["q1", "q2"] });
    expect(store.pendingAsks(sessionId)).toEqual([]);
    expect(store.withdraw(sessionId, ask.askId)).toBeUndefined();
  });

  it("counts agent turns only while asks are open", () => {
    const store = testStore();
    expect(store.countAgentTurn(sessionId)).toBe(false);
    openTwoQuestions(store);
    expect(store.countAgentTurn(sessionId)).toBe(true);
    expect(store.pendingAsks(sessionId)[0]?.turnsSinceUpdate).toBe(1);
  });

  it("cancels one ask by id, or every open ask at once", () => {
    const store = testStore();
    const first = openTwoQuestions(store);
    openTwoQuestions(store);
    openTwoQuestions(store);

    expect(store.cancel(sessionId, first.askId)).toMatchObject({
      status: "closed",
      outcome: { reason: "cancelled", answeredCount: 0, unansweredIds: ["q1", "q2"] },
    });
    expect(store.cancelAll(sessionId).map((outcome) => [outcome.askId, outcome.reason])).toEqual([["bsk-2", "cancelled"], ["csk-3", "cancelled"]]);
    expect(store.pendingAsks(sessionId)).toEqual([]);
  });

  it("regenerates an ask id whose 3-character ref prefix an open ask already uses", () => {
    const ids = ["abc-1", "abd-2", "abd-3", "abe-4"];
    const store = new PendingAskStore({ createAskId: () => ids.shift() ?? "never" });
    store.restore(sessionId, [{ askId: "abc-rebuilt", askedAt: "t0", updatedAt: "t0", revision: "r1", turnsSinceUpdate: 0, context, questions: [question("q1")] }]);

    const first = store.open({ sessionId, context, questions: [question("q1")] });
    const second = store.open({ sessionId, context, questions: [question("q1")] });

    expect([first.askId, second.askId]).toEqual(["abd-2", "abe-4"]);
    expect(store.open({ sessionId: "other-session", context, questions: [question("q1")] }).askId).toBe("never");
  });

  it("restores rebuilt asks only into a session without live asks", () => {
    const store = testStore();
    const rebuilt = { askId: "old", askedAt: "t0", updatedAt: "t1", revision: "r2", turnsSinceUpdate: 3, context, questions: [question("q1")] };

    expect(store.restore(sessionId, [rebuilt])).toBe(true);
    expect(store.pendingAsks(sessionId)).toEqual([rebuilt]);
    expect(store.restore(sessionId, [{ ...rebuilt, askId: "other" }])).toBe(false);
    expect(store.pendingAsks(sessionId).map((ask) => ask.askId)).toEqual(["old"]);
  });

  it("forgets the open asks of a session that goes away without reporting an outcome", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);

    store.forgetSession(sessionId);

    expect(store.pendingAsks(sessionId)).toEqual([]);
    expect(store.cancel(sessionId, ask.askId)).toEqual({ status: "stale" });
  });
});

describe("ask outcome rendering", () => {
  it("names answered and unanswered questions by their short refs in the model-facing text", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1"), question("q2"), question("q3")] });
    const result = store.submit(sessionId, ask.askId, {
      revision: ask.revision,
      answers: [{ id: "q1", values: ["yes"] }, { id: "q2", values: [], otherText: "something else" }],
    });
    if (result.status !== "closed") throw new Error("expected the ask to close");

    expect(renderAskUserAnswersText(result.outcome)).toBe([
      "The user submitted answers to question set ask-1.",
      "",
      "- ask.q1: Question q1?",
      "  Answered: selected yes",
      "- ask.q2: Question q2?",
      `  Answered: custom: "something else"`,
      "- ask.q3: Question q3?",
      "  Unanswered.",
      "",
      "Answered 2 of 3; unanswered: q3",
    ].join("\n"));
  });

  it("tells the model a cancelled ask was closed before it was answered", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    const result = store.cancel(sessionId, ask.askId);
    if (result.status !== "closed") throw new Error("expected the ask to close");

    expect(renderAskUserAnswersText(result.outcome)).toContain("closed (cancelled) before it was fully answered");
  });

  it("reminds with one line per open ask, and with nothing when none is open", () => {
    const store = testStore();
    expect(renderOpenAsksReminder(store.pendingAsks(sessionId))).toBe("");
    openTwoQuestions(store);
    store.countAgentTurn(sessionId);

    const lines = renderOpenAsksReminder(store.pendingAsks(sessionId)).split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("- ask-1 (ask.q1, ask.q2; updated 2026-01-01T00:00:00.000Z, 1 turns ago): Question q1?");
    expect(lines[2]).toContain("update or withdraw");
  });
});
