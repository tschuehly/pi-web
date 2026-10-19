import { randomUUID } from "node:crypto";
import {
  ASK_USER_CONTEXT_MAX_LENGTH,
  ASK_USER_ID_MAX_LENGTH,
  ASK_USER_OPTION_LIMIT,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  ASK_USER_QUESTION_LIMIT,
  ASK_USER_TEXT_MAX_LENGTH,
  type AskUserAnswer,
  type AskUserCloseReason,
  type AskUserOutcome,
  type AskUserQuestion,
  type AskUserQuestionOption,
  type AskUserQuestionRecord,
  type AskUserSubmission,
  type PendingAskUser,
  askQuestionRef,
} from "../../shared/apiTypes.js";

export interface PendingAskStoreOptions {
  now?: (() => Date) | undefined;
  createAskId?: (() => string) | undefined;
  createRevision?: (() => string) | undefined;
}

/** A question set an agent wants to post to the user of one session. */
export interface PendingAskOpenInput {
  sessionId: string;
  context?: string | undefined;
  questions?: AskUserQuestion[] | undefined;
}

/** A revision of one open ask; omitted fields keep their value, so an empty revision only confirms it. */
export interface PendingAskUpdateInput extends PendingAskOpenInput {
  askId: string;
}

/**
 * Result of submitting or cancelling an ask. `"stale"` means the ask named by the
 * caller is no longer open (already submitted, withdrawn, or gone with its
 * daemon-side session), which is an ordinary race a browser can lose — not an error.
 */
export type PendingAskCloseResult =
  | { status: "closed"; outcome: AskUserOutcome }
  | { status: "stale" };

/** Rejected input: a question set is malformed, or an answer does not fit its question. */
export class PendingAskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingAskValidationError";
  }
}

/** `customType` of the hidden context message that reminds the agent of its open asks. */
export const ASK_USER_REMINDER_CUSTOM_TYPE = "pi-web.ask.reminder";

/**
 * `customType` of the transcript entry that records a submitted or cancelled ask
 * (its data is the {@link AskUserOutcome}). It is written before the browser is
 * told the ask closed, so the outcome survives even when the delivery to the
 * model is still queued in memory.
 */
export const ASK_USER_CLOSED_CUSTOM_TYPE = "pi-web.ask.closed";

/** Attempts at an ask id whose question-ref prefix no open ask of the session uses. */
const ASK_ID_ATTEMPTS = 20;

type RecordedAnswers = ReadonlyMap<string, AskUserAnswer>;

/** Durably records a closing ask's outcome; throwing keeps the ask open. */
export type RecordOutcome = (outcome: AskUserOutcome) => void;

/**
 * Daemon-owned open-ask state: any number of unanswered question sets per session.
 *
 * The store is pure domain logic — no Fastify, no Pi session, no I/O, no timers.
 * It validates asks and answers, owns the open/update/withdraw/submit/cancel
 * transitions, counts agent turns for staleness, and computes the
 * answered-versus-unanswered outcome that both the model-facing message and the
 * browser record are rendered from. Callers publish the returned asks and
 * outcomes; the store never emits anything itself.
 *
 * State is in-memory; the transcript is the durable record, and
 * {@link openAsksFromTranscript} rebuilds it when a session runtime is opened.
 */
export class PendingAskStore {
  private readonly now: () => Date;
  private readonly createAskId: () => string;
  private readonly createRevision: () => string;
  private readonly openBySessionId = new Map<string, Map<string, PendingAskUser>>();

  constructor(options: PendingAskStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createAskId = options.createAskId ?? randomUUID;
    this.createRevision = options.createRevision ?? randomUUID;
  }

  /** The session's open asks, oldest first, for {@link SessionStatus} projection. */
  pendingAsks(sessionId: string): PendingAskUser[] {
    return [...this.asksOf(sessionId).values()].map(cloneAsk);
  }

  open(input: PendingAskOpenInput): PendingAskUser {
    const sessionId = requireSessionId(input.sessionId);
    const context = validateContext(input.context);
    if (context === undefined) {
      throw new PendingAskValidationError("context is required: explain the finding, the options, their consequences, and your recommendation so the user can answer without reading the Chat");
    }
    if (input.questions === undefined) throw new PendingAskValidationError("questions are required for a new question set");
    const questions = validateQuestions(input.questions);
    const askedAt = this.timestamp();
    const ask: PendingAskUser = { askId: this.distinctAskId(sessionId), askedAt, updatedAt: askedAt, revision: this.createRevision(), turnsSinceUpdate: 0, context, questions };
    this.setAsk(sessionId, ask);
    return cloneAsk(ask);
  }

  /** Revise or confirm an open ask in place; `undefined` when it is not open. */
  update(input: PendingAskUpdateInput): PendingAskUser | undefined {
    const sessionId = requireSessionId(input.sessionId);
    const ask = this.asksOf(sessionId).get(input.askId);
    if (ask === undefined) return undefined;
    const context = validateContext(input.context) ?? ask.context;
    const questions = input.questions === undefined ? ask.questions : validateQuestions(input.questions);
    const updated: PendingAskUser = { ...ask, updatedAt: this.timestamp(), revision: this.createRevision(), turnsSinceUpdate: 0, ...(context === undefined ? {} : { context }), questions };
    this.setAsk(sessionId, updated);
    return cloneAsk(updated);
  }

  /** Close an open ask the agent no longer needs answered; `undefined` when it is not open. */
  withdraw(sessionId: string, askId: string): AskUserOutcome | undefined {
    return this.close(requireSessionId(sessionId), askId, "withdrawn", new Map());
  }

  /**
   * Record what the user replied and close the ask. Answers are validated against
   * the open ask, so a submission that does not fit its questions is rejected
   * rather than silently truncated; the ask stays open in that case. A submission
   * naming no revision or another one is stale: the user answered questions that
   * changed, or a browser too old to say which questions it answered.
   * `record` runs before the ask closes; when it throws, the ask stays open.
   */
  submit(sessionId: string, askId: string, submission: AskUserSubmission, record?: RecordOutcome): PendingAskCloseResult {
    const ask = this.asksOf(requireSessionId(sessionId)).get(askId);
    if (ask === undefined || submission.revision !== ask.revision) return { status: "stale" };
    const answers = validateSubmission(ask, submission);
    return closed(this.close(sessionId, askId, "submitted", answers, record));
  }

  /**
   * Close one open ask without a submission. The outcome reports every question as
   * unanswered, because answers only ever reach the daemon through a submit.
   */
  cancel(sessionId: string, askId: string, record?: RecordOutcome): PendingAskCloseResult {
    return closed(this.close(requireSessionId(sessionId), askId, "cancelled", new Map(), record));
  }

  /** Close every open ask of the session, e.g. because the user moved to another branch. */
  cancelAll(sessionId: string): AskUserOutcome[] {
    const asks = [...this.asksOf(requireSessionId(sessionId)).keys()];
    return asks.flatMap((askId) => this.close(sessionId, askId, "cancelled", new Map()) ?? []);
  }

  /** Count one started agent turn against every open ask; true when the session has any. */
  countAgentTurn(sessionId: string): boolean {
    const asks = this.asksOf(requireSessionId(sessionId));
    for (const ask of asks.values()) ask.turnsSinceUpdate += 1;
    return asks.size > 0;
  }

  /** Adopt asks rebuilt from the transcript, unless the session already has live state. */
  restore(sessionId: string, asks: readonly PendingAskUser[]): boolean {
    if (this.asksOf(requireSessionId(sessionId)).size > 0 || asks.length === 0) return false;
    for (const ask of asks) this.setAsk(sessionId, cloneAsk(ask));
    return true;
  }

  /** Drop the open asks of a session that is going away, without reporting outcomes. */
  forgetSession(sessionId: string): void {
    this.openBySessionId.delete(requireSessionId(sessionId));
  }

  private asksOf(sessionId: string): Map<string, PendingAskUser> {
    return this.openBySessionId.get(sessionId) ?? new Map<string, PendingAskUser>();
  }

  /** A fresh ask id whose 3-character question-ref prefix no open ask of the session shares. */
  private distinctAskId(sessionId: string): string {
    const taken = new Set([...this.asksOf(sessionId).keys()].map((askId) => askId.slice(0, 3)));
    let askId = requireId(this.createAskId(), "askId");
    // ponytail: bounded retries, then a colliding prefix is accepted rather than failing the agent's ask.
    for (let attempt = 1; attempt < ASK_ID_ATTEMPTS && taken.has(askId.slice(0, 3)); attempt += 1) askId = requireId(this.createAskId(), "askId");
    return askId;
  }

  private setAsk(sessionId: string, ask: PendingAskUser): void {
    const asks = this.openBySessionId.get(sessionId) ?? new Map<string, PendingAskUser>();
    asks.set(ask.askId, ask);
    this.openBySessionId.set(sessionId, asks);
  }

  private close(sessionId: string, askId: string, reason: AskUserCloseReason, answers: RecordedAnswers, record?: RecordOutcome): AskUserOutcome | undefined {
    const asks = this.openBySessionId.get(sessionId);
    const ask = asks?.get(askId);
    if (asks === undefined || ask === undefined) return undefined;
    const outcome = askUserOutcome(ask, answers, reason, this.timestamp());
    record?.(outcome);
    asks.delete(askId);
    if (asks.size === 0) this.openBySessionId.delete(sessionId);
    return outcome;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function closed(outcome: AskUserOutcome | undefined): PendingAskCloseResult {
  return outcome === undefined ? { status: "stale" } : { status: "closed", outcome };
}

/**
 * Model-facing text of a closed ask. The model reads this, so it must name the
 * unanswered questions as plainly as the answered ones.
 */
export function renderAskUserAnswersText(outcome: AskUserOutcome): string {
  const lead = outcome.reason === "submitted"
    ? `The user submitted answers to question set ${outcome.askId}.`
    : `Question set ${outcome.askId} was closed (${outcome.reason}) before it was fully answered.`;
  return [lead, "", ...outcome.questions.map((record) => questionLines(outcome.askId, record)).flat(), "", outcome.summary].join("\n");
}

/**
 * One line per open ask, reminding the model to keep them current. Empty when
 * nothing is open, so callers never inject a reminder about nothing.
 */
export function renderOpenAsksReminder(asks: readonly PendingAskUser[]): string {
  if (asks.length === 0) return "";
  return [
    "Question sets still open for the user (answers arrive as a follow-up message):",
    ...asks.map((ask) => `- ${ask.askId} (${ask.questions.map((question) => askQuestionRef(ask.askId, question.id)).join(", ")}; updated ${ask.updatedAt}, ${ask.turnsSinceUpdate.toString()} turns ago): ${ask.questions[0]?.question ?? ""}`),
    "If one no longer matches the situation and ask_user is available, update or withdraw it; otherwise leave it.",
  ].join("\n");
}

function questionLines(askId: string, record: AskUserQuestionRecord): string[] {
  const header = `- ${askQuestionRef(askId, record.question.id)}: ${record.question.question}`;
  if (!record.answered) return [header, "  Unanswered."];
  const parts = [...record.values.map((value) => `selected ${value}`)];
  if (record.otherText !== undefined) parts.push(`custom: ${JSON.stringify(record.otherText)}`);
  return [header, `  Answered: ${parts.join("; ")}`];
}

function askUserOutcome(
  ask: PendingAskUser,
  answers: RecordedAnswers,
  reason: AskUserCloseReason,
  closedAt: string,
): AskUserOutcome {
  const questions = ask.questions.map((question) => questionRecord(question, answers.get(question.id)));
  const unansweredIds = questions.filter((record) => !record.answered).map((record) => record.question.id);
  const answeredCount = questions.length - unansweredIds.length;
  return {
    askId: ask.askId,
    reason,
    askedAt: ask.askedAt,
    closedAt,
    ...(ask.context === undefined ? {} : { context: ask.context }),
    questions,
    answeredCount,
    unansweredIds,
    summary: summaryLine(questions.length, answeredCount, unansweredIds),
  };
}

function questionRecord(question: AskUserQuestion, answer: AskUserAnswer | undefined): AskUserQuestionRecord {
  const values = answer?.values ?? [];
  const otherText = answer?.otherText;
  return {
    question: cloneQuestion(question),
    answered: values.length > 0 || otherText !== undefined,
    values: [...values],
    ...(otherText === undefined ? {} : { otherText }),
  };
}

function summaryLine(total: number, answeredCount: number, unansweredIds: string[]): string {
  const answered = `Answered ${answeredCount.toString()} of ${total.toString()}`;
  return unansweredIds.length === 0 ? `${answered}; none left unanswered` : `${answered}; unanswered: ${unansweredIds.join(", ")}`;
}

/** Blank context reads as absent; a new ask then rejects it as missing. */
function validateContext(context: string | undefined): string | undefined {
  if (context === undefined || context.trim() === "") return undefined;
  if (context.length > ASK_USER_CONTEXT_MAX_LENGTH) throw new PendingAskValidationError("context exceeds its length limit");
  return context;
}

function validateQuestions(questions: AskUserQuestion[]): AskUserQuestion[] {
  if (questions.length === 0) throw new PendingAskValidationError("An ask must contain at least one question");
  if (questions.length > ASK_USER_QUESTION_LIMIT) {
    throw new PendingAskValidationError(`An ask must not contain more than ${ASK_USER_QUESTION_LIMIT.toString()} questions`);
  }
  const seenIds = new Set<string>();
  return questions.map((question) => {
    const id = requireId(question.id, "question id");
    if (seenIds.has(id)) throw new PendingAskValidationError(`Duplicate question id ${id}`);
    seenIds.add(id);
    return validateQuestion(question, id);
  });
}

function validateQuestion(question: AskUserQuestion, id: string): AskUserQuestion {
  if (question.options.length > ASK_USER_OPTION_LIMIT) {
    throw new PendingAskValidationError(`Question ${id} must not offer more than ${ASK_USER_OPTION_LIMIT.toString()} options`);
  }
  const seenValues = new Set<string>();
  const options = question.options.map((option) => {
    const value = requireId(option.value, `option value of question ${id}`);
    if (seenValues.has(value)) throw new PendingAskValidationError(`Duplicate option value ${value} in question ${id}`);
    seenValues.add(value);
    return validateOption(option, value, id);
  });
  const detail = question.detail;
  return {
    id,
    question: requireText(question.question, `text of question ${id}`),
    ...(detail === undefined ? {} : { detail: requireText(detail, `detail of question ${id}`) }),
    options,
    ...(question.multiple === true ? { multiple: true } : {}),
  };
}

function validateOption(option: AskUserQuestionOption, value: string, questionId: string): AskUserQuestionOption {
  const detail = option.detail;
  return {
    value,
    label: requireText(option.label, `label of option ${value} in question ${questionId}`),
    ...(detail === undefined ? {} : { detail: requireText(detail, `detail of option ${value} in question ${questionId}`) }),
    ...(option.recommended === true ? { recommended: true } : {}),
  };
}

function validateSubmission(ask: PendingAskUser, submission: AskUserSubmission): Map<string, AskUserAnswer> {
  const questionsById = new Map(ask.questions.map((question) => [question.id, question]));
  const answers = new Map<string, AskUserAnswer>();
  for (const answer of submission.answers) {
    const question = questionsById.get(answer.id);
    if (question === undefined) throw new PendingAskValidationError(`Unknown question id ${answer.id}`);
    if (answers.has(answer.id)) throw new PendingAskValidationError(`Duplicate answer for question ${answer.id}`);
    const validated = validateAnswer(question, answer);
    // Untouched questions and explicitly empty answers are the same thing, so an
    // empty answer is dropped rather than recorded as answered.
    if (validated !== undefined) answers.set(answer.id, validated);
  }
  return answers;
}

function validateAnswer(question: AskUserQuestion, answer: AskUserAnswer): AskUserAnswer | undefined {
  const optionValues = new Set(question.options.map((option) => option.value));
  const values: string[] = [];
  for (const value of answer.values) {
    if (!optionValues.has(value)) throw new PendingAskValidationError(`Question ${question.id} has no option ${value}`);
    if (values.includes(value)) throw new PendingAskValidationError(`Duplicate value ${value} for question ${question.id}`);
    values.push(value);
  }
  const otherText = normalizeOtherText(question, answer.otherText);
  const selectionCount = values.length + (otherText === undefined ? 0 : 1);
  if (question.multiple !== true && selectionCount > 1) {
    throw new PendingAskValidationError(`Question ${question.id} accepts a single answer`);
  }
  if (selectionCount === 0) return undefined;
  return { id: question.id, values, ...(otherText === undefined ? {} : { otherText }) };
}

function normalizeOtherText(question: AskUserQuestion, otherText: string | undefined): string | undefined {
  if (otherText === undefined) return undefined;
  if (otherText.length > ASK_USER_OTHER_TEXT_MAX_LENGTH) {
    throw new PendingAskValidationError(`Other text of question ${question.id} exceeds its length limit`);
  }
  const trimmed = otherText.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cloneAsk(ask: PendingAskUser): PendingAskUser {
  return { ...ask, questions: ask.questions.map(cloneQuestion) };
}

function cloneQuestion(question: AskUserQuestion): AskUserQuestion {
  return { ...question, options: question.options.map((option) => ({ ...option })) };
}

function requireSessionId(sessionId: string): string {
  if (sessionId === "") throw new Error("sessionId must not be empty");
  return sessionId;
}

function requireId(value: string, field: string): string {
  if (value.trim() === "") throw new PendingAskValidationError(`${field} must not be empty`);
  if (value.length > ASK_USER_ID_MAX_LENGTH) throw new PendingAskValidationError(`${field} exceeds its length limit`);
  return value;
}

function requireText(value: string, field: string): string {
  if (value.trim() === "") throw new PendingAskValidationError(`${field} must not be empty`);
  if (value.length > ASK_USER_TEXT_MAX_LENGTH) throw new PendingAskValidationError(`${field} exceeds its length limit`);
  return value;
}
