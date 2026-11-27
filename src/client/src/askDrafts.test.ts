import { afterEach, describe, expect, it } from "vitest";
import { ASK_USER_OTHER_TEXT_MAX_LENGTH, type AskUserQuestion } from "../../shared/apiTypes";
import {
  answeredCount,
  askedFingerprint,
  clearAskDraft,
  loadAskContext,
  loadAskDraft,
  saveAskContext,
  saveAskDraft,
  toSubmission,
  typedDraftValue,
  unansweredQuestions,
  visibleQuestions,
  type AskDraftAnswers,
} from "./askDrafts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error("storage blocked");
  }

  override setItem(): void {
    throw new Error("storage blocked");
  }

  override removeItem(): void {
    throw new Error("storage blocked");
  }
}

const singleSelect: AskUserQuestion = {
  id: "q1",
  question: "Which database?",
  options: [
    { value: "pg", label: "Postgres" },
    { value: "sqlite", label: "SQLite" },
  ],
};

const multiSelect: AskUserQuestion = {
  id: "q2",
  question: "Which extras?",
  options: [
    { value: "metrics", label: "Metrics" },
    { value: "tracing", label: "Tracing" },
  ],
  multiple: true,
};

const freeTextOnly: AskUserQuestion = {
  id: "q3",
  question: "Anything else?",
  options: [],
};

const questions = [singleSelect, multiSelect, freeTextOnly];

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
});

describe("ask draft storage", () => {
  it("round-trips a draft under a session- and ask-scoped key", () => {
    const storage = new MemoryStorage();
    const answers: AskDraftAnswers = { q1: { values: ["pg"] }, q2: { values: ["metrics"], otherText: "audit log" } };

    saveAskDraft("local:s1", "ask-1", answers, storage);

    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1:answers")).not.toBeNull();
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual(answers);
    // Another ask of the same session, and the same ask of another session, are
    // separate drafts.
    expect(loadAskDraft("local:s1", "ask-2", storage)).toEqual({});
    expect(loadAskDraft("local:s2", "ask-1", storage)).toEqual({});
  });

  it("removes the entry rather than storing a draft that says nothing", () => {
    const storage = new MemoryStorage();
    saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, storage);

    saveAskDraft("local:s1", "ask-1", { q1: { values: [], otherText: "" } }, storage);

    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1:answers")).toBeNull();
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({});
  });

  it("never preselects a recommended option, and an older panel's untouched preselection does not come back", () => {
    const storage = new MemoryStorage();
    const single: AskUserQuestion = {
      ...singleSelect,
      options: [
        { value: "pg", label: "Postgres", recommended: true },
        { value: "sqlite", label: "SQLite", recommended: true },
      ],
    };
    const multi: AskUserQuestion = { ...multiSelect, options: multiSelect.options.map((option) => ({ ...option, recommended: true })) };
    const fresh = loadAskDraft("local:s1", "ask-1", storage, [single, multi]);
    expect(fresh).toEqual({});
    expect(answeredCount([single, multi], fresh)).toBe(0);

    // The old key held the preselection with the user's own picks: q1 left as preselected, q2 changed by the user.
    storage.setItem(
      "pi-web:ask-draft:local:s1:ask-1",
      JSON.stringify({ q1: { values: ["pg"], asked: askedFingerprint(single) }, q2: { values: ["metrics"], asked: askedFingerprint(multi) } }),
    );
    expect(loadAskDraft("local:s1", "ask-1", storage, [single, multi])).toEqual({ q2: { values: ["metrics"], asked: askedFingerprint(multi) } });

    // A pick of the recommended option saved now is the user's own and stays.
    saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"], asked: askedFingerprint(single) } }, storage);
    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1")).toBeNull();
    expect(loadAskDraft("local:s1", "ask-1", storage, [single, multi])["q1"]?.values).toEqual(["pg"]);
  });

  it("drops a drafted selection of an option value the question does not offer", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web:ask-draft:local:s1:ask-1", JSON.stringify({ q1: { values: ["gone", "pg"], asked: askedFingerprint(singleSelect) } }));

    expect(loadAskDraft("local:s1", "ask-1", storage, [singleSelect])["q1"]?.values).toEqual(["pg"]);
  });

  it("keys answers by own question ids, so ids like constructor and __proto__ work", () => {
    const storage = new MemoryStorage();
    const untouched: AskUserQuestion = { ...singleSelect, id: "constructor" };
    const picked: AskUserQuestion = { ...singleSelect, id: "__proto__", options: [{ value: "pg", label: "Postgres", recommended: true }] };
    const asked = [untouched, picked];

    const draft = loadAskDraft("local:s1", "ask-1", storage, asked);
    expect(answeredCount(asked, draft)).toBe(0);
    expect(unansweredQuestions(asked, draft)).toEqual(asked);

    saveAskDraft(
      "local:s1",
      "ask-1",
      Object.fromEntries([
        ["constructor", { values: ["sqlite"], asked: askedFingerprint(untouched) }],
        ["__proto__", { values: ["pg"], asked: askedFingerprint(picked) }],
      ]),
      storage,
    );
    const loaded = loadAskDraft("local:s1", "ask-1", storage, asked);
    expect(unansweredQuestions(asked, loaded)).toEqual([]);
    expect(toSubmission(asked, loaded)).toEqual({
      answers: [
        { id: "constructor", values: ["sqlite"] },
        { id: "__proto__", values: ["pg"] },
      ],
    });
  });

  it("leaves typed questions and switches unanswered despite a default, and keeps what the user typed", () => {
    const storage = new MemoryStorage();
    const typed = (id: string, extra: Partial<AskUserQuestion>): AskUserQuestion => ({ id, question: `${id}?`, options: [], ...extra });
    const questions = [
      typed("on", { kind: "boolean" }),
      typed("t", { kind: "text", default: "hi" }),
      typed("n", { kind: "number", default: 7, maximum: 10 }),
      typed("d", { kind: "date", default: "2026-12-01" }),
      typed("empty", { kind: "text" }),
      typed("child", { kind: "text", showIf: { question: "on", values: ["true"] } }),
    ];
    const [on, text, number] = questions;
    if (on === undefined || text === undefined || number === undefined) throw new Error("expected the typed questions");
    const preset = loadAskDraft("local:s1", "ask-1", storage, questions);
    expect(toSubmission(questions, preset).answers).toEqual([]);
    expect(answeredCount(questions, preset)).toBe(0);
    // An older panel's draft that only held the defaults (and the switch's off) does not come back; a changed field does.
    storage.setItem(
      "pi-web:ask-draft:local:s1:ask-1",
      JSON.stringify({
        on: { values: [], value: false, asked: askedFingerprint(on) },
        t: { values: [], value: "hi", asked: askedFingerprint(text) },
        n: { values: [], value: "8", asked: askedFingerprint(number) },
      }),
    );
    expect(toSubmission(questions, loadAskDraft("local:s1", "ask-1", storage, questions)).answers).toEqual([{ id: "n", values: [], value: 8 }]);
    storage.removeItem("pi-web:ask-draft:local:s1:ask-1");
    // A yes/no answered in words sends them as its Custom answer; blank words leave the switch's value.
    expect(toSubmission(questions, { ...preset, on: { values: [], value: true, otherText: " Later " } }).answers[0]).toEqual({
      id: "on",
      values: [],
      otherText: "Later",
    });
    expect(toSubmission(questions, { ...preset, on: { values: [], value: true, otherText: "  " } }).answers[0]).toEqual({ id: "on", values: [], value: true });
    expect(visibleQuestions(questions, preset).map((question) => question.id)).not.toContain("child");
    expect(visibleQuestions(questions, { ...preset, on: { values: [], value: true } }).map((question) => question.id)).toContain("child");

    // An out-of-range number is not sent; the card shows why.
    expect(typedDraftValue(number, { values: [], value: "11" })).toEqual({ value: 11, error: "must be at most 10" });
    expect(toSubmission(questions, { ...preset, n: { values: [], value: "11" } }).answers.map((answer) => answer.id)).not.toContain("n");

    // Text goes as typed: padded Markdown fits its minimum and sends unchanged; blank sends nothing.
    const padded = typed("code", { kind: "text", multiline: true, minLength: 6, default: "  code" });
    expect(loadAskDraft("local:s1", "ask-2", storage, [padded])["code"]).toBeUndefined();
    expect(typedDraftValue(padded, { values: [], value: "  code" })).toEqual({ value: "  code" });
    expect(typedDraftValue(padded, { values: [], value: "   " })).toBeUndefined();
    // A one-line field cannot show a line break, so it does not send one; a multiline field does.
    expect(typedDraftValue(typed("line", { kind: "text" }), { values: [], value: "first\nsecond" })).toEqual({
      value: "first\nsecond",
      error: "must be one line",
    });
    expect(typedDraftValue(padded, { values: [], value: "first\nsecond" })).toEqual({ value: "first\nsecond" });

    saveAskDraft("local:s1", "ask-1", { ...preset, t: { values: [], value: "yo", asked: askedFingerprint(text) } }, storage);
    expect(loadAskDraft("local:s1", "ask-1", storage, questions)["t"]?.value).toBe("yo");
  });

  it("clears a draft once its ask is closed", () => {
    const storage = new MemoryStorage();
    saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, storage);

    clearAskDraft("local:s1", "ask-1", storage);

    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({});
  });

  it("keeps an edited context only for the context it was made from, and clears it with the draft", () => {
    const storage = new MemoryStorage();
    saveAskContext("local:s1", "ask-1", "Plan A", "Plan A, mine", storage);

    expect(loadAskContext("local:s1", "ask-1", "Plan A", storage)).toBe("Plan A, mine");
    expect(loadAskContext("local:s1", "ask-1", "Plan B", storage)).toBeUndefined();
    saveAskContext("local:s1", "ask-1", "Plan A", "Plan A", storage);
    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1:context")).toBeNull();
    saveAskContext("local:s1", "ask-1", "Plan A", "Plan A, mine", storage);
    clearAskDraft("local:s1", "ask-1", storage);
    expect(loadAskContext("local:s1", "ask-1", "Plan A", storage)).toBeUndefined();
    storage.setItem("pi-web:ask-draft:local:s1:ask-1:context", "{not json");
    expect(loadAskContext("local:s1", "ask-1", "Plan A", storage)).toBeUndefined();
  });

  it("treats unreadable and malformed drafts as empty instead of failing", () => {
    const storage = new MemoryStorage();
    storage.setItem("pi-web:ask-draft:local:s1:ask-1", "{not json");
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({});

    storage.setItem("pi-web:ask-draft:local:s1:ask-1", JSON.stringify({ q1: { values: "pg" }, q2: { values: ["metrics"] }, q3: 7 }));
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({ q2: { values: ["metrics"] } });

    const throwing = new ThrowingStorage();
    expect(loadAskDraft("local:s1", "ask-1", throwing)).toEqual({});
    expect(() => {
      saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, throwing);
    }).not.toThrow();
    expect(() => {
      clearAskDraft("local:s1", "ask-1", throwing);
    }).not.toThrow();
  });

  it("does nothing when the browser has no storage at all", () => {
    expect(loadAskDraft("local:s1", "ask-1", undefined)).toEqual({});
    expect(() => {
      saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, undefined);
    }).not.toThrow();
    expect(() => {
      clearAskDraft("local:s1", "ask-1", undefined);
    }).not.toThrow();
  });
});

describe("ask answer state", () => {
  it("counts and names answers exactly as the submission reports them", () => {
    const answers: AskDraftAnswers = { q1: { values: ["pg"] }, q3: { values: [], otherText: "  ship it  " } };

    expect(answeredCount(questions, answers)).toBe(2);
    expect(unansweredQuestions(questions, answers).map((question) => question.id)).toEqual(["q2"]);
    expect(toSubmission(questions, answers)).toEqual({
      answers: [
        { id: "q1", values: ["pg"] },
        { id: "q3", values: [], otherText: "ship it" },
      ],
    });
  });

  it("treats untouched, empty, and whitespace-only answers as unanswered", () => {
    const answers: AskDraftAnswers = { q1: { values: [] }, q3: { values: [], otherText: "   " } };

    expect(answeredCount(questions, answers)).toBe(0);
    expect(unansweredQuestions(questions, answers).map((question) => question.id)).toEqual(["q1", "q2", "q3"]);
    expect(toSubmission(questions, answers)).toEqual({ answers: [] });
  });

  it("submits answers in the order the questions were asked", () => {
    const answers: AskDraftAnswers = { q3: { values: [], otherText: "later" }, q1: { values: ["sqlite"] } };

    expect(toSubmission(questions, answers).answers.map((answer) => answer.id)).toEqual(["q1", "q3"]);
  });

  it("keeps several values and custom text together for a multi-select question", () => {
    const answers: AskDraftAnswers = { q2: { values: ["metrics", "tracing"], otherText: "profiling" } };

    expect(toSubmission(questions, answers)).toEqual({
      answers: [{ id: "q2", values: ["metrics", "tracing"], otherText: "profiling" }],
    });
  });

  it("drops draft entries the question would reject rather than losing the whole submission", () => {
    // Drafts are browser-local and survive a superseding ask, another tab, or an
    // older app version, so an entry that no longer fits its question is
    // narrowed instead of poisoning every other answer.
    const answers: AskDraftAnswers = {
      q1: { values: ["mysql", "pg", "pg"], otherText: "custom" },
      q2: { values: ["metrics", "mongo"] },
      q3: { values: ["nope"], otherText: "note" },
    };

    expect(toSubmission(questions, answers)).toEqual({
      answers: [
        { id: "q1", values: ["pg"] },
        { id: "q2", values: ["metrics"] },
        { id: "q3", values: [], otherText: "note" },
      ],
    });
  });

  it("keeps custom text for every single-select question when no option is selected", () => {
    expect(toSubmission([singleSelect], { q1: { values: [], otherText: "neither" } })).toEqual({
      answers: [{ id: "q1", values: [], otherText: "neither" }],
    });
  });

  it("bounds custom text at the shared limit", () => {
    const answers: AskDraftAnswers = { q3: { values: [], otherText: "a".repeat(ASK_USER_OTHER_TEXT_MAX_LENGTH + 10) } };

    expect(toSubmission(questions, answers).answers[0]?.otherText).toHaveLength(ASK_USER_OTHER_TEXT_MAX_LENGTH);
  });
});
