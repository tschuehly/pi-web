import { randomUUID } from "node:crypto";
import {
  ASK_USER_BOOLEAN_LABEL_MAX_LENGTH,
  ASK_USER_CONTEXT_MAX_LENGTH,
  ASK_USER_DETAIL_MAX_LENGTH,
  ASK_USER_ID_MAX_LENGTH,
  ASK_USER_OPTION_LIMIT,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  ASK_USER_QUESTION_LIMIT,
  ASK_USER_RECORD_QUESTION_LIMIT,
  ASK_USER_TEXT_MAX_LENGTH,
  type AskUserAnswer,
  type AskUserCloseReason,
  type AskUserOutcome,
  type AskUserImageTarget,
  type AskUserOutcomeImage,
  type AskUserQuestion,
  type AskUserQuestionOption,
  type AskUserQuestionRecord,
  type AskUserShowIf,
  type AskUserSubmission,
  type AskUserSubmissionImage,
  type PendingAskUser,
  ASK_USER_QUESTION_KINDS,
  askAnswerSelection,
  askQuestionRef,
  askBooleanLabel,
  askValueError,
  hiddenAskQuestionIds,
} from "../../shared/apiTypes.js";
import { appendInlineImageReferenceMapping } from "../../shared/promptAttachments.js";
import { parseAskUserSubmissionImages, sameAskImageTarget } from "../../shared/askUserImages.js";

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
  /** true adds an Approve button; on a revision, false drops it and absent keeps it. Anything else is rejected. */
  approval?: unknown;
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
  /** `ask` is present after a partial send: the ask stays open with its remaining questions. */
  { status: "closed"; outcome: AskUserOutcome; ask?: PendingAskUser } | { status: "stale" };

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
      throw new PendingAskValidationError("context is required: say what the questions share so the user can answer without reading the Chat");
    }
    const approval = validateApproval(input.approval);
    // Only an approval set may be the context alone.
    if (input.questions === undefined && approval !== true) throw new PendingAskValidationError("questions are required for a new question set");
    const questions = validateQuestions(input.questions ?? [], approval);
    const askedAt = this.timestamp();
    const ask: PendingAskUser = {
      askId: this.distinctAskId(sessionId),
      askedAt,
      updatedAt: askedAt,
      revision: this.createRevision(),
      turnsSinceUpdate: 0,
      context,
      contextFromAgent: true,
      ...(approval === undefined ? {} : { approval }),
      questions,
    };
    this.setAsk(sessionId, ask);
    return cloneAsk(ask);
  }

  /** Revise or confirm an open ask in place; `undefined` when it is not open. */
  update(input: PendingAskUpdateInput): PendingAskUser | undefined {
    const sessionId = requireSessionId(input.sessionId);
    const ask = this.asksOf(sessionId).get(input.askId);
    if (ask === undefined) return undefined;
    const supplied = validateContext(input.context);
    const context = supplied ?? ask.context;
    const approval = validateApproval(input.approval);
    // Given, approval replaces the set's; absent, it stays. Either way only an approval set may have no questions.
    const approved = input.approval === undefined ? ask.approval : approval;
    // Only replacement questions are validated: the open ones may follow a parent an earlier partial send already took.
    if (input.questions === undefined && ask.questions.length === 0 && approved !== true)
      throw new PendingAskValidationError("An ask must contain at least one question");
    const questions = input.questions === undefined ? ask.questions : validateQuestions(input.questions, approved);
    const updated: PendingAskUser = {
      ...ask,
      updatedAt: this.timestamp(),
      revision: this.createRevision(),
      turnsSinceUpdate: 0,
      ...(context === undefined ? {} : { context }),
      questions,
    };
    // The agent supplied this context, even when its text equals the user's earlier edit.
    if (supplied !== undefined) {
      delete updated.contextEdited;
      updated.contextFromAgent = true;
    }
    // Given, approval replaces the set's; absent, it stays.
    if (input.approval !== undefined) {
      if (approval === undefined) delete updated.approval;
      else updated.approval = approval;
    }
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
   *
   * A partial submit ({@link AskUserSubmission.partial}) records only the answered
   * questions (`outcome.partial`) and keeps the ask open with the rest under a new
   * revision, which the outcome carries so a transcript rebuild lands on the same
   * state. Answering every remaining question closes the ask as a full submit.
   */
  submit(sessionId: string, askId: string, submission: AskUserSubmission, recordOutcome?: RecordOutcome): PendingAskCloseResult {
    const ask = this.asksOf(requireSessionId(sessionId)).get(askId);
    if (ask === undefined || submission.revision !== ask.revision) return { status: "stale" };
    // A panel from before `noPreset` preselected and prefilled: what it sent equal to that may be untouched.
    const record = (outcome: AskUserOutcome): void => {
      if (submission.noPreset !== true) outcome.presetPanel = true;
      recordOutcome?.(outcome);
    };
    const answers = validateSubmission(ask, submission);
    // A question hidden by its condition is never answered: a stale draft answer to it is dropped.
    const hidden = hiddenAskQuestionIds(ask.questions, (id) => askAnswerSelection(answers.get(id)));
    for (const id of hidden) answers.delete(id);
    const note = normalizeNote(submission.note);
    const editedContext = normalizeEditedContext(ask, submission.context);
    const approved = submission.approved === true;
    if (approved && ask.approval !== true) throw new PendingAskValidationError(`Question set ${askId} asks for no approval`);
    const images = outcomeImages(ask, answers, submission);
    if (submission.partial === true) {
      if (approved) throw new PendingAskValidationError("A partial submit cannot approve; approve with the whole set");
      if (note !== undefined) throw new PendingAskValidationError("A partial submit takes no note; send the note with the whole set");
      if (answers.size === 0) throw new PendingAskValidationError("A partial submit needs at least one answer");
      // Hidden questions whose condition this send settles leave with it as skipped; the others wait for their parent.
      const skipped = new Set<string>();
      for (const question of ask.questions) {
        const parent = question.showIf?.question;
        if (hidden.has(question.id) && parent !== undefined && (answers.has(parent) || skipped.has(parent))) skipped.add(question.id);
      }
      const remaining = ask.questions.filter((question) => !answers.has(question.id) && !skipped.has(question.id));
      if (remaining.length > 0) {
        const revision = this.createRevision();
        const outcome = partialOutcome(ask, answers, skipped, remaining, revision, this.timestamp(), editedContext);
        if (images.length > 0) outcome.images = images;
        record(outcome);
        // The edited context goes out once, with this send; the questions left open then show the user's version (none when he cleared it).
        const updated: PendingAskUser = { ...ask, revision, questions: remaining };
        if (editedContext === "") delete updated.context;
        else if (editedContext !== undefined) updated.context = editedContext;
        if (editedContext !== undefined) {
          updated.contextEdited = true;
          delete updated.contextFromAgent;
        }
        this.setAsk(sessionId, updated);
        return { status: "closed", outcome, ask: cloneAsk(updated) };
      }
    }
    return closed(this.close(sessionId, askId, "submitted", answers, record, note, hidden, editedContext, approved, images));
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

  private close(
    sessionId: string,
    askId: string,
    reason: AskUserCloseReason,
    answers: RecordedAnswers,
    record?: RecordOutcome,
    note?: string,
    skipped: ReadonlySet<string> = new Set(),
    editedContext?: string,
    approved = false,
    images: AskUserOutcomeImage[] = [],
  ): AskUserOutcome | undefined {
    const asks = this.openBySessionId.get(sessionId);
    const ask = asks?.get(askId);
    if (asks === undefined || ask === undefined) return undefined;
    const outcome = askUserOutcome(ask, answers, reason, this.timestamp(), note, skipped, editedContext);
    if (approved) outcome.approved = true;
    if (images.length > 0) outcome.images = images;
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
  const lead =
    outcome.partial === true
      ? `The user answered ${outcome.answeredCount === 1 ? "one question" : `${outcome.answeredCount.toString()} questions`} of question set ${outcome.askId}; its other questions stay open.`
      : outcome.reason === "submitted"
        ? `The user submitted answers to question set ${outcome.askId}.`
        : `Question set ${outcome.askId} was closed (${outcome.reason}) before it was fully answered.`;
  const noteImages = imagesLine(outcome, { kind: "note" });
  const note =
    outcome.note === undefined && noteImages.length === 0
      ? []
      : ["", outcome.note === undefined ? "Note from the user: images only" : `Note from the user: ${JSON.stringify(outcome.note)}`, ...noteImages];
  const edited =
    outcome.editedContext === undefined
      ? []
      : outcome.editedContext === ""
        ? ["The user cleared the context.", ""]
        : ["The user edited the context:", fenced(outcome.editedContext), ""];
  return [
    ...(outcome.approved === true ? ["The user approved the context."] : []),
    lead,
    "",
    ...edited,
    ...outcome.questions
      .map((record) => [
        ...questionLines(outcome.askId, record, outcome.presetPanel === true),
        ...imagesLine(outcome, { kind: "question", id: record.question.id }),
      ])
      .flat(),
    ...note,
    "",
    outcome.summary,
  ].join("\n");
}

/**
 * The whole follow-up the model reads: the answers, the reminder of the sets still open, then the legend naming the
 * image blocks that follow the text, so it stays last.
 */
export function renderAskUserFollowUp(outcome: AskUserOutcome, openAsks: readonly PendingAskUser[]): string {
  const text = [renderAskUserAnswersText(outcome), renderOpenAsksReminder(openAsks)].filter((part) => part !== "").join("\n\n");
  return appendInlineImageReferenceMapping(
    text,
    (outcome.images ?? []).map((image) => image.reference),
  );
}

/** `  Images: [PIC_1], [PIC_2]` under an answer or the note; the placeholders never join the answer itself, so its length limits hold. */
function imagesLine(outcome: AskUserOutcome, target: AskUserImageTarget): string[] {
  const references = (outcome.images ?? []).filter((image) => sameAskImageTarget(image.target, target)).map((image) => image.reference);
  return references.length === 0 ? [] : [`  Images: ${references.join(", ")}`];
}

/**
 * The images of a submission as the outcome records them, numbered `[PIC_n]` in submission order. Each belongs to the
 * note of a whole-set send or to a `kind: "text"` question this send answers.
 */
function outcomeImages(ask: PendingAskUser, answers: RecordedAnswers, submission: AskUserSubmission): AskUserOutcomeImage[] {
  let images: AskUserSubmissionImage[];
  try {
    images = parseAskUserSubmissionImages(submission.images);
  } catch (error) {
    throw new PendingAskValidationError(error instanceof Error ? error.message : String(error));
  }
  return images.map((image, index) => {
    const { target } = image;
    if (target.kind === "note") {
      if (submission.partial === true) throw new PendingAskValidationError("A partial submit takes no note images; send them with the whole set");
    } else if (!answers.has(target.id) || ask.questions.find((question) => question.id === target.id)?.kind !== "text") {
      throw new PendingAskValidationError(`Image ${String(index + 1)} belongs to no answered text question: ${target.id}`);
    }
    return {
      target: image.target,
      reference: `[PIC_${String(index + 1)}]`,
      mimeType: image.mimeType,
      ...(image.name === undefined ? {} : { name: image.name }),
    };
  });
}

/**
 * One line per open ask, reminding the model to keep them current. Empty when
 * nothing is open, so callers never inject a reminder about nothing.
 */
export function renderOpenAsksReminder(asks: readonly PendingAskUser[]): string {
  if (asks.length === 0) return "";
  return [
    "Question sets still open for the user (answers arrive as a follow-up message):",
    ...asks.map(
      (ask) =>
        `- ${ask.askId} (${ask.questions.length === 0 ? "approval of the context" : ask.questions.map((question) => askQuestionRef(ask.askId, question.id)).join(", ")}; updated ${ask.updatedAt}, ${ask.turnsSinceUpdate.toString()} turns ago): ${ask.questions[0]?.question ?? ask.context?.split("\n")[0] ?? ""}`,
    ),
    "If one no longer matches the situation and ask_user is available, update or withdraw it; otherwise leave it.",
  ].join("\n");
}

/** A code fence longer than any backtick run in `text`, so fences inside it stay inside. */
function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length + 1)));
  return `${fence}markdown\n${text}\n${fence}`;
}

function questionLines(askId: string, record: AskUserQuestionRecord, presetPanel: boolean): string[] {
  const header = `- ${askQuestionRef(askId, record.question.id)}: ${record.question.question}`;
  const condition = record.question.showIf;
  if (record.skipped === true && condition !== undefined) {
    return [
      header,
      `  Skipped, not shown: it applies only when ${askQuestionRef(askId, condition.question)} is ${condition.values.join(" or ")}, which was not picked.`,
    ];
  }
  if (!record.answered) return [header, "  Unanswered."];
  const { value, question } = record;
  if (value !== undefined) {
    // An agent's labels are quoted like text; the default Yes/No read as plain words.
    const shown =
      typeof value === "boolean"
        ? question.labels === undefined
          ? value
            ? "yes"
            : "no"
          : JSON.stringify(askBooleanLabel(question, value))
        : question.kind === "text"
          ? JSON.stringify(value)
          : String(value);
    // That panel started a typed field on its default (a switch without one on off).
    const preset = presetPanel && value === (question.default ?? (question.kind === "boolean" ? false : undefined));
    return [header, `  Answered: ${shown}${preset ? ` (${PRESET_NOTE})` : ""}`];
  }
  const parts = [...record.values.map((value) => `selected ${value}`)];
  if (record.otherText !== undefined) parts.push(`custom: ${JSON.stringify(record.otherText)}`);
  // That panel started a choice on its recommended options (the first one for single choice).
  const recommended = record.question.options.filter((option) => option.recommended === true).map((option) => option.value);
  const preselected = record.question.multiple === true ? recommended : recommended.slice(0, 1);
  const preset =
    presetPanel
    && preselected.length > 0
    && record.otherText === undefined
    && record.values.length === preselected.length
    && preselected.every((value) => record.values.includes(value));
  return [header, `  Answered: ${parts.join("; ")}${preset ? ` (${PRESET_NOTE})` : ""}`];
}

const PRESET_NOTE = "what an older panel preset, sent unchanged: maybe not the user's choice";

function askUserOutcome(
  ask: PendingAskUser,
  answers: RecordedAnswers,
  reason: AskUserCloseReason,
  closedAt: string,
  note?: string,
  skipped: ReadonlySet<string> = new Set(),
  editedContext?: string,
): AskUserOutcome {
  const questions = ask.questions.map((question) => questionRecord(question, answers.get(question.id), skipped.has(question.id)));
  const unansweredIds = questions.filter((record) => !record.answered && record.skipped !== true).map((record) => record.question.id);
  const answeredCount = questions.filter((record) => record.answered).length;
  return {
    askId: ask.askId,
    reason,
    askedAt: ask.askedAt,
    closedAt,
    ...(ask.context === undefined ? {} : { context: ask.context }),
    ...(editedContext === undefined ? {} : { editedContext }),
    questions,
    ...(note === undefined ? {} : { note }),
    answeredCount,
    unansweredIds,
    summary: summaryLine(questions.length - skipped.size, answeredCount, unansweredIds) + skippedSummary(questions),
  };
}

/**
 * The browser's record of a set closed after partial sends: the final close's record with the questions the
 * earlier partial records closed, in `order` (the set's question ids; others keep send order), counts and summary
 * over all of them; `contextEdited` is the closed set's flag of that name. The transcript and the model keep each send's own record.
 */
export function withEarlierAnswers(
  outcome: AskUserOutcome,
  earlier: readonly AskUserOutcome[],
  order: readonly string[] = [],
  contextEdited = false,
): AskUserOutcome {
  // shortcut: past the record limit the oldest earlier answers drop out (each send's own record keeps them; the summary
  // counts them and says how many are not shown), page the record if sets get revised that often.
  // Each earlier send's rows carry its revision, as its images do, so a question id a revision reused stays apart.
  const all = earlier
    .filter((each) => each.askId === outcome.askId && each.partial === true)
    .flatMap((each) => each.questions.map((record) => (each.revision === undefined ? record : { ...record, revision: each.revision })));
  const cut = Math.max(0, all.length + outcome.questions.length - ASK_USER_RECORD_QUESTION_LIMIT);
  const records = all.slice(cut);
  const hidden = all.slice(0, cut);
  if (outcome.partial === true || records.length === 0) return outcome;
  const rank = (record: AskUserQuestionRecord) => {
    const index = order.indexOf(record.question.id);
    return index < 0 ? order.length : index;
  };
  const questions = [...records, ...outcome.questions].sort((a, b) => rank(a) - rank(b));
  const answeredCount = questions.filter((record) => record.answered).length;
  const skipped = questions.filter((record) => record.skipped === true).length;
  // From the sorted records, not the final send's: a revision may list the open questions in another order.
  const unansweredIds = questions.filter((record) => !record.answered && record.skipped !== true).map((record) => record.question.id);
  // An edit goes out once, with the send that carried it, so the last send may carry none. It became the set's context, so
  // it still applies while the closed set's `contextEdited` says the user supplied its context: an agent's later revision wins.
  const lastEdit = [...earlier].reverse().find((each) => each.askId === outcome.askId && each.editedContext !== undefined)?.editedContext;
  const editedContext = outcome.editedContext ?? (contextEdited ? lastEdit : undefined);
  // Image metadata follows its questions (a hidden answer's images drop out). `[PIC_n]` restarts per send, so each earlier
  // send's images carry that send's revision, naming the answers entry that holds their bytes (as the Durable host's wholeRecord).
  const sendKey = (revision: string | undefined, id: string) => JSON.stringify([revision ?? null, id]);
  const shown = new Set(questions.map((record) => sendKey(record.revision, record.question.id)));
  const sentImages = (each: AskUserOutcome, revision?: string): AskUserOutcomeImage[] =>
    (each.images ?? []).map((image) => (revision === undefined ? image : { ...image, revision }));
  const images = [
    ...earlier.filter((each) => each.askId === outcome.askId && each.partial === true).flatMap((each) => sentImages(each, each.revision)),
    ...sentImages(outcome),
  ].filter((image) => image.target.kind === "note" || shown.has(sendKey(image.revision, image.target.id)));
  return {
    ...outcome,
    ...(editedContext === undefined ? {} : { editedContext }),
    ...(images.length === 0 ? {} : { images }),
    questions,
    answeredCount,
    unansweredIds,
    summary:
      summaryLine(
        questions.length + hidden.length - skipped - hidden.filter((record) => record.skipped === true).length,
        answeredCount + hidden.filter((record) => record.answered).length,
        unansweredIds,
      )
      + skippedSummary(questions)
      + (hidden.length === 0 ? "" : `; ${hidden.length.toString()} earlier ${hidden.length === 1 ? "answer" : "answers"} not shown`),
  };
}

/** The record of a partial send: only the answered questions, plus the revision the ask continues under. */
function partialOutcome(
  ask: PendingAskUser,
  answers: RecordedAnswers,
  skipped: ReadonlySet<string>,
  remaining: readonly AskUserQuestion[],
  revision: string,
  closedAt: string,
  editedContext?: string,
): AskUserOutcome {
  const questions = ask.questions
    .filter((question) => answers.has(question.id) || skipped.has(question.id))
    .map((question) => questionRecord(question, answers.get(question.id), skipped.has(question.id)));
  return {
    askId: ask.askId,
    reason: "submitted",
    askedAt: ask.askedAt,
    closedAt,
    ...(ask.context === undefined ? {} : { context: ask.context }),
    ...(editedContext === undefined ? {} : { editedContext }),
    questions,
    answeredCount: answers.size,
    unansweredIds: [],
    summary: `Answered ${answers.size.toString()}${skippedSummary(questions)}; still open: ${remaining.map((question) => askQuestionRef(ask.askId, question.id)).join(", ")}`,
    partial: true,
    revision,
  };
}

function questionRecord(question: AskUserQuestion, answer: AskUserAnswer | undefined, skipped = false): AskUserQuestionRecord {
  if (skipped) return { question: cloneQuestion(question), answered: false, values: [], skipped: true };
  const values = answer?.values ?? [];
  const otherText = answer?.otherText;
  const value = answer?.value;
  return {
    question: cloneQuestion(question),
    answered: values.length > 0 || otherText !== undefined || value !== undefined,
    values: [...values],
    ...(otherText === undefined ? {} : { otherText }),
    ...(value === undefined ? {} : { value }),
  };
}

function summaryLine(total: number, answeredCount: number, unansweredIds: string[]): string {
  const answered = `Answered ${answeredCount.toString()} of ${total.toString()}`;
  return unansweredIds.length === 0 ? `${answered}; none left unanswered` : `${answered}; unanswered: ${unansweredIds.join(", ")}`;
}

function skippedSummary(questions: readonly AskUserQuestionRecord[]): string {
  const ids = questions.filter((record) => record.skipped === true).map((record) => record.question.id);
  return ids.length === 0 ? "" : `; skipped (condition not met): ${ids.join(", ")}`;
}

/** true asks the user to approve the context (an Approve button); false or absent asks none. The Durable host checks it the same way. */
export function validateApproval(value: unknown): true | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  throw new PendingAskValidationError("approval must be true or false");
}

/** Blank context reads as absent; a new ask then rejects it as missing. */
function validateContext(context: string | undefined): string | undefined {
  if (context === undefined || context.trim() === "") return undefined;
  if (context.length > ASK_USER_CONTEXT_MAX_LENGTH) throw new PendingAskValidationError("context exceeds its length limit");
  return context;
}

function validateQuestions(questions: readonly AskUserQuestion[], approval?: true): AskUserQuestion[] {
  if (questions.length === 0 && approval !== true) throw new PendingAskValidationError("An ask must contain at least one question");
  if (questions.length > ASK_USER_QUESTION_LIMIT) {
    throw new PendingAskValidationError(`An ask must not contain more than ${ASK_USER_QUESTION_LIMIT.toString()} questions`);
  }
  const earlier = new Map<string, AskUserQuestion>();
  return questions.map((question) => {
    const id = requireId(question.id, "question id");
    if (earlier.has(id)) throw new PendingAskValidationError(`Duplicate question id ${id}`);
    const validated = validateQuestion(question, id);
    const showIf = question.showIf === undefined ? undefined : validateShowIf(question.showIf, id, earlier);
    earlier.set(id, validated);
    return showIf === undefined ? validated : { ...validated, showIf };
  });
}

/** A condition names an earlier question of the set and only option values it offers, so it can be met. */
function validateShowIf(showIf: AskUserShowIf, id: string, earlier: ReadonlyMap<string, AskUserQuestion>): AskUserShowIf {
  const parent = earlier.get(showIf.question);
  if (parent === undefined) throw new PendingAskValidationError(`showIf of question ${id} must name an earlier question of this set, not ${showIf.question}`);
  if (showIf.values.length === 0) throw new PendingAskValidationError(`showIf of question ${id} must list at least one option value of question ${parent.id}`);
  const kind = parent.kind ?? "choice";
  if (kind !== "choice" && kind !== "boolean")
    throw new PendingAskValidationError(`showIf of question ${id}: question ${parent.id} is a ${kind} question; showIf needs a choice or boolean question`);
  const offered = new Set(kind === "boolean" ? ["true", "false"] : parent.options.map((option) => option.value));
  const unknown = showIf.values.find((value) => !offered.has(value));
  if (unknown !== undefined && kind === "boolean")
    throw new PendingAskValidationError(`showIf of question ${id}: question ${parent.id} is a boolean; use "true" or "false", not ${unknown}`);
  if (unknown !== undefined) throw new PendingAskValidationError(`showIf of question ${id}: question ${parent.id} has no option ${unknown}`);
  return { question: parent.id, values: [...new Set(showIf.values)] };
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
  // Asks stored before `detail` was required restore without one.
  const detail = question.detail;
  return {
    id,
    question: stripNumbering(requireText(question.question, `text of question ${id}`)),
    ...(detail === undefined ? {} : { detail: requireText(detail, `detail of question ${id}`, ASK_USER_DETAIL_MAX_LENGTH) }),
    options,
    ...(question.multiple === true ? { multiple: true } : {}),
    ...validateTyped(question, id),
  };
}

/** A typed question's kind and the fields that kind takes; other fields are dropped, as unknown ones are. */
function validateTyped(question: AskUserQuestion, id: string): Partial<AskUserQuestion> {
  const kind = question.kind ?? "choice";
  const { labels } = question;
  if (labels !== undefined && kind !== "boolean") throw new PendingAskValidationError(`labels of question ${id} need kind boolean, not ${kind}`);
  if (kind === "choice") return {};
  if (!ASK_USER_QUESTION_KINDS.includes(kind)) throw new PendingAskValidationError(`Question ${id} has unknown kind ${kind}`);
  if (question.options.length > 0 || question.multiple === true)
    throw new PendingAskValidationError(`Question ${id} of kind ${kind} takes no options or multiple`);
  const { minLength, maxLength, minimum, maximum } = question;
  const typed: Partial<AskUserQuestion> =
    kind === "text"
      ? {
          kind,
          ...(question.multiline === true ? { multiline: true } : {}),
          ...(minLength === undefined ? {} : { minLength }),
          ...(maxLength === undefined ? {} : { maxLength }),
        }
      : kind === "number"
        ? {
            kind,
            ...(minimum === undefined ? {} : { minimum }),
            ...(maximum === undefined ? {} : { maximum }),
            ...(question.integer === true ? { integer: true } : {}),
          }
        : kind === "boolean" && labels !== undefined
          ? { kind, labels: validateLabels(labels, id) }
          : { kind };
  for (const [field, bound] of Object.entries({ minLength: typed.minLength, maxLength: typed.maxLength })) {
    if (bound !== undefined && !(Number.isInteger(bound) && bound >= 0 && bound <= ASK_USER_OTHER_TEXT_MAX_LENGTH))
      throw new PendingAskValidationError(`${field} of question ${id} must be a whole number from 0 to ${ASK_USER_OTHER_TEXT_MAX_LENGTH.toString()}`);
  }
  for (const [field, bound] of Object.entries({ minimum: typed.minimum, maximum: typed.maximum })) {
    if (bound !== undefined && !Number.isFinite(bound)) throw new PendingAskValidationError(`${field} of question ${id} must be a number`);
  }
  if ((typed.minLength ?? 0) > (typed.maxLength ?? Infinity)) throw new PendingAskValidationError(`minLength of question ${id} exceeds its maxLength`);
  if ((typed.minimum ?? -Infinity) > (typed.maximum ?? Infinity)) throw new PendingAskValidationError(`minimum of question ${id} exceeds its maximum`);
  if (question.default === undefined) return typed;
  const error = askValueError(typed, question.default);
  if (error !== undefined) throw new PendingAskValidationError(`default of question ${id} ${error}`);
  return { ...typed, default: question.default };
}

/** A boolean question's [true, false] labels, each one non-blank line of at most ASK_USER_BOOLEAN_LABEL_MAX_LENGTH characters. */
function validateLabels(labels: unknown, id: string): [string, string] {
  const fits = (label: unknown): label is string =>
    typeof label === "string" && label.trim() !== "" && !/[\r\n]/u.test(label) && label.length <= ASK_USER_BOOLEAN_LABEL_MAX_LENGTH;
  if (!Array.isArray(labels) || labels.length !== 2 || !fits(labels[0]) || !fits(labels[1]))
    throw new PendingAskValidationError(
      `labels of question ${id} must be two one-line texts of at most ${ASK_USER_BOOLEAN_LABEL_MAX_LENGTH.toString()} characters, [true, false]`,
    );
  return [labels[0], labels[1]];
}

function validateOption(option: AskUserQuestionOption, value: string, questionId: string): AskUserQuestionOption {
  const detail = option.detail;
  const label = requireText(option.label, `label of option ${value} in question ${questionId}`);
  // The panel adds its own Custom choice; an agent's second one could never be picked as Custom.
  if (/^custom$|\(custom\)$/iu.test(label.trim()))
    throw new PendingAskValidationError(`Option ${value} is labelled Custom; a Custom choice is always added, so drop this option`);
  return {
    value,
    label,
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
  if ((question.kind ?? "choice") !== "choice") {
    // A yes/no may be answered in words instead, checked as a choice's Custom answer.
    const words = question.kind === "boolean" ? normalizeOtherText(question, answer.otherText) : undefined;
    if (words !== undefined) {
      if (answer.values.length > 0 || answer.value !== undefined) throw new PendingAskValidationError(`Question ${question.id} accepts a single answer`);
      return { id: question.id, values: [], otherText: words };
    }
    if (answer.values.length > 0 || (answer.otherText !== undefined && question.kind !== "boolean"))
      throw new PendingAskValidationError(`Question ${question.id} takes a value, not options`);
    // Blank reads as untouched; other text is kept as typed (Markdown indentation, a default left unchanged).
    const value = typeof answer.value === "string" && question.kind !== "text" ? answer.value.trim() : answer.value;
    if (value === undefined || (typeof value === "string" && value.trim() === "")) return undefined;
    const error = askValueError(question, value);
    if (error !== undefined) throw new PendingAskValidationError(`Answer to question ${question.id} ${error}`);
    return { id: question.id, values: [], value };
  }
  if (answer.value !== undefined) throw new PendingAskValidationError(`Question ${question.id} takes options, not a value`);
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

/** The panel numbers questions, so a model's own "1. " / "1) " / "3–4. " prefix is dropped; text that is only a number stays. */
function stripNumbering(text: string): string {
  const stripped = text.replace(/^\s*\d+(?:\s*[-–]\s*\d+)?[.)]\s+/u, "");
  return stripped.trim() === "" ? text : stripped;
}

/** The user's edit of the ask's context; unchanged reads as no edit, blank as `""`: he cleared it. */
function normalizeEditedContext(ask: PendingAskUser, context: string | undefined): string | undefined {
  if (context === undefined || context === ask.context) return undefined;
  if (context.length > ASK_USER_CONTEXT_MAX_LENGTH) throw new PendingAskValidationError("context exceeds its length limit");
  return context.trim() === "" ? "" : context;
}

function normalizeNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  if (note.length > ASK_USER_OTHER_TEXT_MAX_LENGTH) throw new PendingAskValidationError("note exceeds its length limit");
  const trimmed = note.trim();
  return trimmed === "" ? undefined : trimmed;
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
  return {
    ...question,
    options: question.options.map((option) => ({ ...option })),
    ...(question.showIf === undefined ? {} : { showIf: { ...question.showIf, values: [...question.showIf.values] } }),
  };
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

function requireText(value: string, field: string, maxLength = ASK_USER_TEXT_MAX_LENGTH): string {
  if (value.trim() === "") throw new PendingAskValidationError(`${field} must not be empty`);
  if (value.length > maxLength) throw new PendingAskValidationError(`${field} exceeds its length limit`);
  return value;
}
