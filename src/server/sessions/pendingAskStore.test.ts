import { describe, expect, it } from "vitest";
import { ASK_USER_CONTEXT_MAX_LENGTH, ASK_USER_DETAIL_MAX_LENGTH, ASK_USER_OPTION_LIMIT, ASK_USER_OTHER_TEXT_MAX_LENGTH, ASK_USER_TEXT_MAX_LENGTH, ASK_USER_QUESTION_LIMIT, type AskUserQuestion } from "../../shared/apiTypes.js";
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

  it("strips the model's own numbering from question text, never leaving it empty", () => {
    const store = testStore();
    const texts = ["1. Which store?", "2) Which store?", "3–4. Which store?", "3-4. Which store?", "12. ", "1.5 GB enough?", "Which store?"];
    const ask = store.open({ sessionId, context, questions: texts.map((text, index) => question(`q${index.toString()}`, { question: text })) });
    expect(ask.questions.map((entry) => entry.question)).toEqual(["Which store?", "Which store?", "Which store?", "Which store?", "12. ", "1.5 GB enough?", "Which store?"]);
  });

  it("bounds a question's detail longer than other prose, and an option's detail as before", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1", { detail: "x".repeat(ASK_USER_DETAIL_MAX_LENGTH) })] });
    expect(ask.questions[0]?.detail).toHaveLength(ASK_USER_DETAIL_MAX_LENGTH);
    expect(() => store.open({ sessionId, context, questions: [question("q1", { detail: "x".repeat(ASK_USER_DETAIL_MAX_LENGTH + 1) })] }))
      .toThrow(/detail of question q1 exceeds its length limit/);
    expect(() => store.open({ sessionId, context, questions: [question("q1", { options: [{ value: "a", label: "A", detail: "x".repeat(ASK_USER_TEXT_MAX_LENGTH + 1) }] })] }))
      .toThrow(/detail of option a in question q1 exceeds its length limit/);
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

describe("PendingAskStore partial submit", () => {
  it("records only the sent answer and keeps the rest open under a new revision, the old one now stale", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1"), question("q2"), question("q3")] });
    const recorded: unknown[] = [];

    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q2", values: ["no"] }], partial: true }, (outcome) => recorded.push(outcome));

    expect(result).toEqual({
      status: "closed",
      outcome: {
        askId: "ask-1", reason: "submitted", askedAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-01T00:00:01.000Z", context,
        questions: [{ question: ask.questions[1], answered: true, values: ["no"] }],
        answeredCount: 1, unansweredIds: [], summary: "Answered 1; still open: ask.q1, ask.q3", partial: true, revision: "r2",
      },
      ask: { ...ask, revision: "r2", questions: [ask.questions[0], ask.questions[2]] },
    });
    expect(recorded).toEqual([result.status === "closed" ? result.outcome : undefined]);
    expect(store.pendingAsks(sessionId)).toEqual([{ ...ask, revision: "r2", questions: [ask.questions[0], ask.questions[2]] }]);
    expect(store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes"] }], partial: true })).toEqual({ status: "stale" });
    expect(() => store.submit(sessionId, ask.askId, { revision: "r2", answers: [{ id: "q2", values: ["no"] }], partial: true })).toThrow(/Unknown question id q2/);
  });

  it("closes the ask as a full submit once a partial send answers every remaining question", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes"] }], partial: true });

    const result = store.submit(sessionId, ask.askId, { revision: "r2", answers: [{ id: "q2", values: ["no"] }], partial: true });

    expect(result.status === "closed" && result.outcome.partial === undefined && result.ask === undefined ? result.outcome.summary : undefined).toBe("Answered 1 of 1; none left unanswered");
    expect(store.pendingAsks(sessionId)).toEqual([]);
  });

  it("sends the rest with Send all, closing what is still unanswered", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1"), question("q2"), question("q3")] });
    store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes"] }], partial: true });

    const result = store.submit(sessionId, ask.askId, { revision: "r2", answers: [{ id: "q2", values: ["no"] }], note: "Later" });

    expect(result.status === "closed" ? [result.outcome.summary, result.outcome.note] : undefined).toEqual(["Answered 1 of 2; unanswered: q3", "Later"]);
    expect(store.pendingAsks(sessionId)).toEqual([]);
  });

  it("rejects a partial submit without an answer or with a note, keeping the ask unchanged", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);

    expect(() => store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: [] }], partial: true })).toThrow(/needs at least one answer/);
    expect(() => store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes"] }], note: "Hi", partial: true })).toThrow(/takes no note/);
    expect(store.pendingAsks(sessionId)).toEqual([ask]);
  });

  it("keeps the ask unchanged when recording a partial send fails", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);

    expect(() => store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes"] }], partial: true }, () => { throw new Error("disk full"); })).toThrow("disk full");
    expect(store.pendingAsks(sessionId)).toEqual([ask]);
  });

  it("tells the model which answer arrived and that the set stays open", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q2", values: [], otherText: "Maybe" }], partial: true });
    if (result.status !== "closed") throw new Error("expected the answer to be sent");

    expect(renderAskUserAnswersText(result.outcome)).toBe([
      "The user answered one question of question set ask-1; its other questions stay open.",
      "",
      "- ask.q2: Question q2?",
      `  Answered: custom: "Maybe"`,
      "",
      "Answered 1; still open: ask.q1",
    ].join("\n"));
  });
});

describe("PendingAskStore edited context", () => {
  it("records the user's edited context and shows it to the model before the answers, fenced", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    const edited = "My plan:\n```diff\n-a\n+b\n```";
    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes"] }], context: edited });
    if (result.status !== "closed") throw new Error("expected closed");
    expect(result.outcome).toMatchObject({ context, editedContext: edited });
    expect(renderAskUserAnswersText(result.outcome)).toContain(["set ask-1.", "", "The user edited the context:", "````markdown", edited, "````", "", "- ask.q1"].join("\n"));
  });

  it("adds nothing when the context comes back unchanged", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [], context });
    if (result.status !== "closed") throw new Error("expected closed");
    expect(result.outcome).not.toHaveProperty("editedContext");
    expect(renderAskUserAnswersText(result.outcome)).not.toContain("edited the context");
  });

  it("records a blank context as cleared and tells the model, never falling back to the original", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1")] });
    const blank = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [], context: "  " });
    if (blank.status !== "closed") throw new Error("expected closed");
    expect(blank.outcome).toMatchObject({ context, editedContext: "" });
    expect(renderAskUserAnswersText(blank.outcome)).toContain(["set ask-1.", "", "The user cleared the context.", "", "- ask.q1"].join("\n"));

    // A partial send that clears it leaves the rest of the set without a context.
    const two = openTwoQuestions(store);
    const partial = store.submit(sessionId, two.askId, { revision: two.revision, answers: [{ id: "q1", values: ["yes"] }], partial: true, context: "" });
    if (partial.status !== "closed") throw new Error("expected closed");
    expect(partial.outcome.editedContext).toBe("");
    expect(partial.ask).not.toHaveProperty("context");
  });

  it("rejects an edited context over the context limit, keeping the ask open", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    expect(() => store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [], context: "x".repeat(ASK_USER_CONTEXT_MAX_LENGTH + 1) })).toThrow(/context exceeds/);
    expect(store.pendingAsks(sessionId)).toHaveLength(1);
  });

  it("sends the edit once with a partial send, which makes it the open ask's context", () => {
    const store = testStore();
    const ask = openTwoQuestions(store);
    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes"] }], partial: true, context: "Mine" });
    if (result.status !== "closed") throw new Error("expected closed");
    expect(result.outcome.editedContext).toBe("Mine");
    expect(result.ask?.context).toBe("Mine");
    const rest = store.submit(sessionId, ask.askId, { revision: "r2", answers: [{ id: "q2", values: ["no"] }], context: "Mine" });
    expect(rest.status === "closed" && rest.outcome).not.toHaveProperty("editedContext");
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

  it("tells the model when the user left the recommended options as they were", () => {
    const store = testStore();
    const recommended = { options: [{ value: "a", label: "A", recommended: true }, { value: "b", label: "B", recommended: true }, { value: "c", label: "C" }], multiple: true };
    const ask = store.open({ sessionId, context, questions: [question("q1", recommended), question("q2", recommended)] });
    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["a", "b"] }, { id: "q2", values: ["a"] }] });
    if (result.status !== "closed") throw new Error("expected the ask to close");

    const text = renderAskUserAnswersText(result.outcome);
    expect(text).toContain("  Answered: selected a; selected b (recommended, unchanged)\n");
    expect(text).toContain("  Answered: selected a\n");
  });

  it("records typed answers as values, marks a default left unchanged, and rejects values that do not fit", () => {
    const store = testStore();
    const typed = (id: string, kind: NonNullable<AskUserQuestion["kind"]>, extra: Partial<AskUserQuestion> = {}) => question(id, { options: [], kind, ...extra });
    const ask = store.open({ sessionId, context, questions: [
      typed("on", "boolean"),
      typed("off", "boolean", { default: true }),
      typed("n", "number", { default: 7, minimum: 1, maximum: 10, integer: true }),
      typed("t", "text", { maxLength: 5 }),
      typed("d", "date", { default: "2026-12-01" }),
      question("c"),
    ] });
    const send = (answers: { id: string; values: string[]; value?: boolean | number | string }[]) => () => store.submit(sessionId, ask.askId, { revision: ask.revision, answers });
    expect(send([{ id: "n", values: [], value: 11 }])).toThrow("Answer to question n must be at most 10");
    expect(send([{ id: "n", values: [], value: 2.5 }])).toThrow("Answer to question n must be a whole number");
    expect(send([{ id: "n", values: [], value: "7" }])).toThrow("Answer to question n must be a number");
    expect(send([{ id: "t", values: [], value: "toolong" }])).toThrow("Answer to question t must be at most 5 characters");
    expect(send([{ id: "d", values: [], value: "2026-02-30" }])).toThrow("Answer to question d must be a date as YYYY-MM-DD");
    expect(send([{ id: "on", values: ["yes"] }])).toThrow("Question on takes a value, not options");
    expect(send([{ id: "c", values: [], value: true }])).toThrow("Question c takes options, not a value");

    const result = send([
      { id: "on", values: [], value: false },
      { id: "off", values: [], value: false },
      { id: "n", values: [], value: 7 },
      { id: "t", values: [], value: "  hi " },
      { id: "d", values: [], value: "2026-12-01" },
    ])();
    if (result.status !== "closed") throw new Error("expected the ask to close");
    expect(result.outcome.questions.map((record) => [record.answered, record.value])).toStrictEqual([[true, false], [true, false], [true, 7], [true, "  hi "], [true, "2026-12-01"], [false, undefined]]);
    const text = renderAskUserAnswersText(result.outcome);
    expect(text).toContain("- ask.on: Question on?\n  Answered: off (default, unchanged)\n");
    expect(text).toContain("- ask.off: Question off?\n  Answered: off\n");
    expect(text).toContain("  Answered: 7 (default, unchanged)\n");
    expect(text).toContain("  Answered: \"  hi \"\n");
    expect(text).toContain("  Answered: 2026-12-01 (default, unchanged)\n");
  });

  it("keeps typed text verbatim, so a padded Markdown default opens, passes its minimum and reads as unchanged; blank is no answer and no default", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("code", { options: [], kind: "text", multiline: true, minLength: 6, default: "  code" }), question("other", { options: [], kind: "text" })] });
    expect(() => store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "other", values: [], value: "   " }] })).not.toThrow();
    const again = store.open({ sessionId, context, questions: [question("code", { options: [], kind: "text", multiline: true, minLength: 6, default: "  code" })] });
    const result = store.submit(sessionId, again.askId, { revision: again.revision, answers: [{ id: "code", values: [], value: "  code" }] });
    if (result.status !== "closed") throw new Error("expected closed");
    expect(result.outcome.questions[0]?.value).toBe("  code");
    expect(renderAskUserAnswersText(result.outcome)).toContain("  Answered: \"  code\" (default, unchanged)\n");
    expect(() => store.open({ sessionId, context, questions: [question("t", { options: [], kind: "text", default: "  " })] })).toThrow("default of question t must not be blank");
  });

  it("shows a question under a boolean only while that switch has the listed state", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [
      question("backup", { options: [], kind: "boolean" }),
      question("folder", { options: [], kind: "text", showIf: { question: "backup", values: ["true"] } }),
    ] });
    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "backup", values: [], value: false }, { id: "folder", values: [], value: "~/b" }] });
    if (result.status !== "closed") throw new Error("expected the ask to close");
    expect(result.outcome.questions[1]).toMatchObject({ answered: false, skipped: true });
  });

  it("carries the user's trimmed note on the outcome and into the model-facing text", () => {
    const store = testStore();
    const ask = store.open({ sessionId, context, questions: [question("q1")] });
    expect(() => store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [], note: "x".repeat(ASK_USER_OTHER_TEXT_MAX_LENGTH + 1) }))
      .toThrow(/note exceeds its length limit/);
    const result = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "q1", values: ["yes"] }], note: "  Ship it\nthis week.  " });
    if (result.status !== "closed") throw new Error("expected the ask to close");

    expect(result.outcome.note).toBe("Ship it\nthis week.");
    expect(renderAskUserAnswersText(result.outcome)).toContain(`  Answered: selected yes\n\nNote from the user: "Ship it\\nthis week."\n\nAnswered 1 of 1`);
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

describe("PendingAskStore dependent questions (showIf)", () => {
  const location = question("location", { options: [{ value: "home", label: "Home" }, { value: "vps", label: "VPS" }] });
  const machine = question("machine", { question: "Which machine?", showIf: { question: "location", values: ["home"] } });
  const disk = question("disk", { showIf: { question: "machine", values: ["yes"] } });
  const openDependent = (store: PendingAskStore) => store.open({ sessionId, context, questions: [location, machine, disk, question("other")] });

  it("rejects a condition on an unknown or later question, on an option the question lacks, or without values", () => {
    const store = testStore();
    const reject = (questions: AskUserQuestion[]) => () => store.open({ sessionId, context, questions });
    expect(reject([location, question("m", { showIf: { question: "nope", values: ["home"] } })])).toThrow(/showIf of question m must name an earlier question of this set, not nope/);
    expect(reject([question("m", { showIf: { question: "location", values: ["home"] } }), location])).toThrow(/must name an earlier question/);
    expect(reject([question("m", { showIf: { question: "m", values: ["yes"] } })])).toThrow(/must name an earlier question/);
    expect(reject([location, question("m", { showIf: { question: "location", values: ["moon"] } })])).toThrow(/question location has no option moon/);
    expect(reject([location, question("m", { showIf: { question: "location", values: [] } })])).toThrow(/at least one option value/);
    expect(store.pendingAsks(sessionId)).toEqual([]);
    expect(openDependent(store).questions[1]?.showIf).toEqual({ question: "location", values: ["home"] });
  });

  it("reports unmet dependents, and their own dependents, as skipped rather than unanswered, dropping their stale answers", () => {
    const store = testStore();
    const ask = openDependent(store);
    const result = store.submit(sessionId, ask.askId, {
      revision: ask.revision,
      answers: [{ id: "location", values: ["vps"] }, { id: "machine", values: ["yes"] }, { id: "disk", values: ["no"] }],
    });
    if (result.status !== "closed") throw new Error("expected closed");
    expect(result.outcome.questions.map((record) => [record.question.id, record.answered, record.skipped])).toEqual([
      ["location", true, undefined], ["machine", false, true], ["disk", false, true], ["other", false, undefined],
    ]);
    expect(result.outcome.unansweredIds).toEqual(["other"]);
    expect(result.outcome.summary).toBe("Answered 1 of 2; unanswered: other; skipped (condition not met): machine, disk");
    const text = renderAskUserAnswersText(result.outcome);
    expect(text).toContain("- ask.machine: Which machine?\n  Skipped, not shown: it applies only when ask.location is home, which was not picked.");
    expect(text).toContain("- ask.other: Question other?\n  Unanswered.");
  });

  it("counts a met dependent like any question, and a Custom answer never meets a condition", () => {
    const store = testStore();
    const ask = openDependent(store);
    const met = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "location", values: ["home"] }, { id: "machine", values: ["yes"] }] });
    expect(met.status === "closed" ? met.outcome.summary : undefined).toBe("Answered 2 of 4; unanswered: disk, other");
    const second = openDependent(store);
    const custom = store.submit(sessionId, second.askId, { revision: second.revision, answers: [{ id: "location", values: [], otherText: "home" }] });
    expect(custom.status === "closed" ? custom.outcome.summary : undefined).toBe("Answered 1 of 2; unanswered: other; skipped (condition not met): machine, disk");
  });

  it("a partial send skips the dependents it settles, keeps those it shows, and leaves those of an unsent parent open", () => {
    const store = testStore();
    const ask = openDependent(store);
    const vps = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "location", values: ["vps"] }], partial: true });
    if (vps.status !== "closed") throw new Error("expected closed");
    expect(vps.outcome.questions.map((record) => record.question.id)).toEqual(["location", "machine", "disk"]);
    expect(vps.outcome.summary).toBe("Answered 1; skipped (condition not met): machine, disk; still open: ask.other");
    expect(vps.ask?.questions.map((q) => q.id)).toEqual(["other"]);

    const second = openDependent(store);
    const home = store.submit(sessionId, second.askId, { revision: second.revision, answers: [{ id: "location", values: ["home"] }], partial: true });
    expect(home.status === "closed" ? home.ask?.questions.map((q) => q.id) : undefined).toEqual(["machine", "disk", "other"]);
    // machine's parent left the set, so machine now shows unconditionally; disk still waits on machine.
    const rest = store.submit(sessionId, second.askId, { revision: home.status === "closed" ? home.ask?.revision ?? "" : "", answers: [{ id: "machine", values: ["no"] }] });
    expect(rest.status === "closed" ? rest.outcome.summary : undefined).toBe("Answered 1 of 2; unanswered: other; skipped (condition not met): disk");

    const third = openDependent(store);
    const other = store.submit(sessionId, third.askId, { revision: third.revision, answers: [{ id: "other", values: ["yes"] }], partial: true });
    expect(other.status === "closed" ? other.ask?.questions.map((q) => q.id) : undefined).toEqual(["location", "machine", "disk"]);
    expect(() => store.submit(sessionId, third.askId, { revision: other.status === "closed" ? other.ask?.revision ?? "" : "", answers: [{ id: "machine", values: ["yes"] }], partial: true })).toThrow(/needs at least one answer/);
  });

  it("keeps a follow-up's answer sent alone with the choice or boolean parent answer that shows it", () => {
    const store = testStore();
    const ask = openDependent(store);
    const choice = store.submit(sessionId, ask.askId, { revision: ask.revision, answers: [{ id: "location", values: ["home"] }, { id: "machine", values: ["no"] }], partial: true });
    if (choice.status !== "closed") throw new Error("expected closed");
    expect(choice.outcome.questions.map((record) => [record.question.id, record.answered, record.skipped])).toEqual([["location", true, undefined], ["machine", true, undefined], ["disk", false, true]]);
    expect(choice.ask?.questions.map((q) => q.id)).toEqual(["other"]);

    const typed = store.open({ sessionId, context, questions: [
      question("backup", { options: [], kind: "boolean" }),
      question("folder", { options: [], kind: "text", showIf: { question: "backup", values: ["true"] } }),
      question("other"),
    ] });
    const toggled = store.submit(sessionId, typed.askId, { revision: typed.revision, answers: [{ id: "backup", values: [], value: true }, { id: "folder", values: [], value: "~/b" }], partial: true });
    if (toggled.status !== "closed") throw new Error("expected closed");
    expect(toggled.outcome.questions.map((record) => [record.question.id, record.answered, record.value])).toEqual([["backup", true, true], ["folder", true, "~/b"]]);
  });
});
