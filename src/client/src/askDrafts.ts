import { ASK_USER_OTHER_TEXT_MAX_LENGTH, type AskUserAnswer, type AskUserQuestion, type AskUserSubmission, askAnswerSelection, askValueError, hiddenAskQuestionIds } from "../../shared/apiTypes";

/**
 * What the user has entered for one question but has not submitted yet. Kept in
 * the browser because the daemon owns "there is an open ask" while the browser
 * owns "what I have typed so far".
 */
export interface AskDraftAnswer {
  values: string[];
  /** A choice's Custom answer, or a yes/no answered in words (present while its field is open). */
  otherText?: string;
  /** A typed question's field as entered: a boolean for a switch, the input's text otherwise. */
  value?: boolean | string;
  /** {@link askedFingerprint} of the question as the user saw it; a revised question drops the answer. */
  asked?: string;
}

/** Identity of a question's wording and options, so an answer is never carried over to a changed question. */
export function askedFingerprint(question: AskUserQuestion): string {
  return JSON.stringify(question);
}

/** Draft answers of one ask, keyed by question id. */
export type AskDraftAnswers = Record<string, AskDraftAnswer>;

/** `record[key]` only when it is the record's own entry: a question id may be `constructor` or `__proto__`. */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const draftStoragePrefix = "pi-web:ask-draft:";

function draftStorageKey(sessionId: string, askId: string): string {
  return `${draftStoragePrefix}${sessionId}:${askId}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Read the stored draft. Any unreadable or malformed payload yields an empty
 * draft: a half-typed answer set is a convenience, never a reason to fail
 * rendering the questions. Given the ask's current questions, answers made for
 * a different wording of their question are dropped.
 */
export function loadAskDraft(sessionId: string, askId: string, storage = browserStorage(), questions?: readonly AskUserQuestion[]): AskDraftAnswers {
  let answers: AskDraftAnswers;
  try {
    const stored = storage?.getItem(draftStorageKey(sessionId, askId));
    answers = stored === null || stored === undefined ? {} : draftAnswersFromJson(stored);
  } catch {
    answers = {};
  }
  if (questions === undefined) return answers;
  const current = new Map(questions.map((question) => [question.id, askedFingerprint(question)]));
  return { ...presetAnswers(questions), ...Object.fromEntries(Object.entries(answers).filter(([id, answer]) => answer.asked !== undefined && answer.asked === current.get(id))) };
}

/**
 * A question with no draft starts with its recommended options selected (the first one if single choice), a typed one
 * on its default (a switch without one on off); any draft, even a cleared one, wins.
 */
function presetAnswers(questions: readonly AskUserQuestion[]): AskDraftAnswers {
  // Built with fromEntries: assigning `answers["__proto__"]` would set the prototype instead of an entry.
  const answers: [string, AskDraftAnswer][] = [];
  for (const question of questions) {
    if ((question.kind ?? "choice") !== "choice") {
      const preset = question.kind === "boolean" ? question.default === true : question.default === undefined ? undefined : String(question.default);
      if (preset !== undefined) answers.push([question.id, { values: [], value: preset, asked: askedFingerprint(question) }]);
      continue;
    }
    const recommended = question.options.filter((option) => option.recommended === true).map((option) => option.value);
    if (recommended.length > 0) answers.push([question.id, { values: question.multiple === true ? recommended : recommended.slice(0, 1), asked: askedFingerprint(question) }]);
  }
  return Object.fromEntries(answers);
}

export function saveAskDraft(sessionId: string, askId: string, answers: AskDraftAnswers, storage = browserStorage()): void {
  try {
    // An answer the user cleared keeps its entry (it has `asked`), so recommendations do not come back over it.
    const entries = Object.entries(answers).filter(([, answer]) => answer.values.length > 0 || (answer.otherText ?? "") !== "" || answer.value !== undefined || answer.asked !== undefined);
    if (entries.length === 0) storage?.removeItem(draftStorageKey(sessionId, askId));
    else storage?.setItem(draftStorageKey(sessionId, askId), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

/** The unsent note on the whole set; kept apart from the answers, whose keys are question ids. */
export function loadAskNote(sessionId: string, askId: string, storage = browserStorage()): string {
  try {
    return storage?.getItem(`${draftStorageKey(sessionId, askId)}:note`) ?? "";
  } catch {
    return "";
  }
}

export function saveAskNote(sessionId: string, askId: string, note: string, storage = browserStorage()): void {
  try {
    if (note.trim() === "") storage?.removeItem(`${draftStorageKey(sessionId, askId)}:note`);
    else storage?.setItem(`${draftStorageKey(sessionId, askId)}:note`, note);
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

/** The user's unsent edit of the set's context, or `undefined`; an edit of another wording of the context is dropped. */
export function loadAskContext(sessionId: string, askId: string, original: string, storage = browserStorage()): string | undefined {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(`${draftStorageKey(sessionId, askId)}:context`) ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const { original: stored, edited }: Record<string, unknown> = { ...parsed };
    return stored === original && typeof edited === "string" && edited !== original ? edited : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the edit with the context it was made from, so a revision that changes the context resets it. */
export function saveAskContext(sessionId: string, askId: string, original: string, edited: string, storage = browserStorage()): void {
  try {
    if (edited === original) storage?.removeItem(`${draftStorageKey(sessionId, askId)}:context`);
    else storage?.setItem(`${draftStorageKey(sessionId, askId)}:context`, JSON.stringify({ original, edited }));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

/**
 * After a partial send carried the context edit `sent` (`""` = cleared), the set's context is `sent`: an edit equal to
 * it is consumed, so a later revision back to the old context does not bring it back; newer typing stays, as an edit of `sent`.
 */
export function rebaseAskContext(sessionId: string, askId: string, sent: string, storage = browserStorage()): void {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(`${draftStorageKey(sessionId, askId)}:context`) ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const { edited }: Record<string, unknown> = { ...parsed };
    if (typeof edited === "string") saveAskContext(sessionId, askId, sent, edited.trim() === "" ? "" : edited, storage);
  } catch {
    // Ignore unreadable drafts and localStorage quota/privacy errors.
  }
}

export function clearAskDraft(sessionId: string, askId: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(draftStorageKey(sessionId, askId));
    storage?.removeItem(`${draftStorageKey(sessionId, askId)}:note`);
    storage?.removeItem(`${draftStorageKey(sessionId, askId)}:context`);
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

function draftAnswersFromJson(stored: string): AskDraftAnswers {
  const parsed: unknown = JSON.parse(stored);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const answers: [string, AskDraftAnswer][] = [];
  for (const [id, value] of Object.entries(parsed)) {
    const answer = draftAnswerFromValue(value);
    if (answer !== undefined) answers.push([id, answer]);
  }
  return Object.fromEntries(answers);
}

function draftAnswerFromValue(value: unknown): AskDraftAnswer | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  const values = record["values"];
  const otherText = record["otherText"];
  const asked = record["asked"];
  const field = record["value"];
  if (!Array.isArray(values) || !values.every((entry) => typeof entry === "string")) return undefined;
  if (otherText !== undefined && typeof otherText !== "string") return undefined;
  return {
    values: [...values],
    ...(otherText === undefined ? {} : { otherText }),
    ...(typeof field === "boolean" || typeof field === "string" ? { value: field } : {}),
    ...(typeof asked === "string" ? { asked } : {}),
  };
}

/**
 * The questions the user sees: those whose `showIf` the draft meets. A hidden question is not rendered, counted,
 * required, or sent, though its draft answer stays stored in case the condition is met again.
 */
export function visibleQuestions(questions: readonly AskUserQuestion[], answers: AskDraftAnswers): AskUserQuestion[] {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const hidden = hiddenAskQuestionIds(questions, (id) => {
    const question = byId.get(id);
    return question === undefined ? [] : askAnswerSelection(submittableAnswer(question, ownEntry(answers, id)));
  });
  return questions.filter((question) => !hidden.has(question.id));
}

/**
 * How many visible questions the draft currently answers. A question counts as answered
 * exactly when {@link toSubmission} would send an answer for it, so the progress
 * the user reads matches what the model is told.
 */
export function answeredCount(questions: readonly AskUserQuestion[], answers: AskDraftAnswers): number {
  return visibleQuestions(questions, answers).filter((question) => submittableAnswer(question, ownEntry(answers, question.id)) !== undefined).length;
}

/** The visible questions left untouched, in the order they were asked. */
export function unansweredQuestions(questions: readonly AskUserQuestion[], answers: AskDraftAnswers): AskUserQuestion[] {
  return visibleQuestions(questions, answers).filter((question) => submittableAnswer(question, ownEntry(answers, question.id)) === undefined);
}

/**
 * The submission for the current draft: one answer per answered visible question, and
 * nothing for the untouched or hidden ones, since an empty answer and an untouched
 * question mean the same thing to the daemon.
 */
export function toSubmission(questions: readonly AskUserQuestion[], answers: AskDraftAnswers): AskUserSubmission {
  const submitted: AskUserAnswer[] = [];
  for (const question of visibleQuestions(questions, answers)) {
    const answer = submittableAnswer(question, ownEntry(answers, question.id));
    if (answer !== undefined) submitted.push(answer);
  }
  return { answers: submitted };
}

/**
 * Normalize one draft entry against the question it answers, or `undefined` when
 * it says nothing. The draft is browser-local storage that a previous version of
 * the app, another tab, or a user could have left in a shape the question no
 * longer accepts, so values the question does not offer are dropped and a
 * single-select question keeps only its first selection rather than sending a
 * submission the daemon would reject as a whole.
 */
function submittableAnswer(question: AskUserQuestion, answer: AskDraftAnswer | undefined): AskUserAnswer | undefined {
  if (answer === undefined) return undefined;
  if ((question.kind ?? "choice") !== "choice") {
    // A yes/no answered in words sends them as its Custom answer; blank words fall back to the switch.
    const words = question.kind === "boolean" ? normalizedOtherText(answer.otherText) : undefined;
    if (words !== undefined) return { id: question.id, values: [], otherText: words };
    const typed = typedDraftValue(question, answer);
    // A field with an error sends nothing: it counts as unanswered while the card shows why.
    return typed === undefined || typed.error !== undefined ? undefined : { id: question.id, values: [], value: typed.value };
  }
  const offered = new Set(question.options.map((option) => option.value));
  const values = [...new Set(answer.values)].filter((value) => offered.has(value));
  const otherText = normalizedOtherText(answer.otherText);
  if (question.multiple !== true && values.length + (otherText === undefined ? 0 : 1) > 1) {
    const single = values[0];
    if (single !== undefined) return { id: question.id, values: [single] };
    return otherText === undefined ? undefined : { id: question.id, values: [], otherText };
  }
  if (values.length === 0 && otherText === undefined) return undefined;
  return { id: question.id, values, ...(otherText === undefined ? {} : { otherText }) };
}

function normalizedOtherText(otherText: string | undefined): string | undefined {
  if (otherText === undefined) return undefined;
  const trimmed = otherText.trim().slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH);
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A typed question's draft as the value it would send and, when that value does not fit the question, why
 * ("must be at most 10"); `undefined` while the field is empty.
 */
export function typedDraftValue(question: AskUserQuestion, answer: AskDraftAnswer | undefined): { value: boolean | number | string; error?: string } | undefined {
  const raw = answer?.value;
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return question.kind === "boolean" ? { value: raw } : undefined;
  const text = raw.trim();
  if (text === "" || question.kind === "boolean") return undefined;
  // Text goes as typed, so Markdown and a default compare unchanged; numbers and dates drop stray spaces.
  const value = question.kind === "number" ? Number(text) : question.kind === "text" ? raw : text;
  const error = askValueError(question, value);
  return error === undefined ? { value } : { value, error };
}
