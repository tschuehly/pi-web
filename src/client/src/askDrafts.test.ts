import { afterEach, describe, expect, it } from "vitest";
import { ASK_USER_OTHER_TEXT_MAX_LENGTH, type AskUserQuestion } from "../../shared/apiTypes";
import { answeredCount, askedFingerprint, clearAskDraft, loadAskContext, loadAskDraft, saveAskContext, saveAskDraft, toSubmission, typedDraftValue, unansweredQuestions, visibleQuestions, type AskDraftAnswers } from "./askDrafts";

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
  options: [{ value: "pg", label: "Postgres" }, { value: "sqlite", label: "SQLite" }],
};

const multiSelect: AskUserQuestion = {
  id: "q2",
  question: "Which extras?",
  options: [{ value: "metrics", label: "Metrics" }, { value: "tracing", label: "Tracing" }],
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

    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1")).not.toBeNull();
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

    expect(storage.getItem("pi-web:ask-draft:local:s1:ask-1")).toBeNull();
    expect(loadAskDraft("local:s1", "ask-1", storage)).toEqual({});
  });

  it("starts an undrafted question on its recommended options but keeps a draft the user cleared", () => {
    const storage = new MemoryStorage();
    const single: AskUserQuestion = { ...singleSelect, options: [{ value: "pg", label: "Postgres", recommended: true }, { value: "sqlite", label: "SQLite", recommended: true }] };
    const multi: AskUserQuestion = { ...multiSelect, options: multiSelect.options.map((option) => ({ ...option, recommended: true })) };
    const preselected = loadAskDraft("local:s1", "ask-1", storage, [single, multi]);
    expect(preselected["q1"]?.values).toEqual(["pg"]);
    expect(preselected["q2"]?.values).toEqual(["metrics", "tracing"]);
    expect(answeredCount([single, multi], preselected)).toBe(2);

    saveAskDraft("local:s1", "ask-1", { ...preselected, q2: { values: [], asked: askedFingerprint(multi) } }, storage);

    expect(loadAskDraft("local:s1", "ask-1", storage, [single, multi])["q2"]?.values).toEqual([]);
  });

  it("starts typed questions on their defaults, a switch on off, and keeps a field the user cleared", () => {
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
    const [, text, number] = questions;
    if (text === undefined || number === undefined) throw new Error("expected the typed questions");
    const preset = loadAskDraft("local:s1", "ask-1", storage, questions);
    expect(toSubmission(questions, preset).answers).toEqual([
      { id: "on", values: [], value: false },
      { id: "t", values: [], value: "hi" },
      { id: "n", values: [], value: 7 },
      { id: "d", values: [], value: "2026-12-01" },
    ]);
    expect(answeredCount(questions, preset)).toBe(4);
    expect(visibleQuestions(questions, preset).map((question) => question.id)).not.toContain("child");
    expect(visibleQuestions(questions, { ...preset, on: { values: [], value: true } }).map((question) => question.id)).toContain("child");

    // An out-of-range number is not sent; the card shows why.
    expect(typedDraftValue(number, { values: [], value: "11" })).toEqual({ value: 11, error: "must be at most 10" });
    expect(toSubmission(questions, { ...preset, n: { values: [], value: "11" } }).answers.map((answer) => answer.id)).not.toContain("n");

    // Text goes as typed: a padded Markdown default fits its minimum and sends unchanged; blank sends nothing.
    const padded = typed("code", { kind: "text", multiline: true, minLength: 6, default: "  code" });
    expect(typedDraftValue(padded, loadAskDraft("local:s1", "ask-2", storage, [padded])["code"])).toEqual({ value: "  code" });
    expect(typedDraftValue(padded, { values: [], value: "   " })).toBeUndefined();

    saveAskDraft("local:s1", "ask-1", { ...preset, t: { values: [], value: "", asked: askedFingerprint(text) } }, storage);
    expect(loadAskDraft("local:s1", "ask-1", storage, questions)["t"]?.value).toBe("");
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
    expect(() => { saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, throwing); }).not.toThrow();
    expect(() => { clearAskDraft("local:s1", "ask-1", throwing); }).not.toThrow();
  });

  it("does nothing when the browser has no storage at all", () => {
    expect(loadAskDraft("local:s1", "ask-1", undefined)).toEqual({});
    expect(() => { saveAskDraft("local:s1", "ask-1", { q1: { values: ["pg"] } }, undefined); }).not.toThrow();
    expect(() => { clearAskDraft("local:s1", "ask-1", undefined); }).not.toThrow();
  });
});

describe("ask answer state", () => {
  it("counts and names answers exactly as the submission reports them", () => {
    const answers: AskDraftAnswers = { q1: { values: ["pg"] }, q3: { values: [], otherText: "  ship it  " } };

    expect(answeredCount(questions, answers)).toBe(2);
    expect(unansweredQuestions(questions, answers).map((question) => question.id)).toEqual(["q2"]);
    expect(toSubmission(questions, answers)).toEqual({
      answers: [{ id: "q1", values: ["pg"] }, { id: "q3", values: [], otherText: "ship it" }],
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
