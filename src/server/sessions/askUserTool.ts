import { Type, type Static } from "pi-web-typebox";
import { defineTool } from "../../piSdk.js";
import {
  ASK_USER_CONTEXT_MAX_LENGTH,
  ASK_USER_DETAIL_MAX_LENGTH,
  ASK_USER_ID_MAX_LENGTH,
  ASK_USER_OPTION_LIMIT,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  ASK_USER_QUESTION_LIMIT,
  ASK_USER_TEXT_MAX_LENGTH,
  type AskUserOutcome,
  type AskUserQuestion,
  type AskUserQuestionOption,
  type PendingAskUser,
  askQuestionRef,
} from "../../shared/apiTypes.js";
import type { PendingAskOpenInput, PendingAskUpdateInput } from "./pendingAskStore.js";

export interface AskUserToolDeps {
  /** Opens a new ask; rejects malformed or incomplete question sets. */
  open(input: PendingAskOpenInput): Promise<PendingAskUser>;
  /** Revises or confirms an open ask; `undefined` when it is no longer open. */
  update(input: PendingAskUpdateInput): Promise<PendingAskUser | undefined>;
  /** Withdraws an open ask; `undefined` when it is no longer open. */
  withdraw(sessionId: string, askId: string): Promise<AskUserOutcome | undefined>;
}

/**
 * Tool-result details; the transcript rebuild of open asks reads them back.
 * `sessionId` names the session that posted the ask, so a fork that copied the
 * entry does not restore it.
 */
export type AskUserToolDetails = { ask: PendingAskUser; sessionId: string } | { withdrawn: AskUserOutcome };

const AskUserOptionParams = Type.Object({
  value: Type.String({
    maxLength: ASK_USER_ID_MAX_LENGTH,
    description: "Stable machine value reported back to you when the user picks this option.",
  }),
  label: Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "Short label the user reads, ideally a few words.",
  }),
  detail: Type.Optional(Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "Optional clarification shown under the label.",
  })),
  recommended: Type.Optional(Type.Boolean({
    description: "Mark the option you recommend; it starts selected.",
  })),
});

const AskUserQuestionParams = Type.Object({
  id: Type.String({
    maxLength: ASK_USER_ID_MAX_LENGTH,
    description: "Unique within this call; used as the answer key reported back to you.",
  }),
  question: Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "The question itself, as one plain-text line. Do not number it; the panel numbers the questions.",
  }),
  detail: Type.String({
    maxLength: ASK_USER_DETAIL_MAX_LENGTH,
    description: "Markdown shown under the question: what the item is, an example, and where it stands, so the question is answerable from the set alone.",
  }),
  options: Type.Optional(Type.Array(AskUserOptionParams, {
    maxItems: ASK_USER_OPTION_LIMIT,
    description: "Options to choose from. Omit when free text is the whole answer; the browser always adds a Custom choice.",
  })),
  multiple: Type.Optional(Type.Boolean({
    description: "Allow several options at once. Default: one answer per question.",
  })),
  showIf: Type.Optional(Type.Object({
    question: Type.String({ maxLength: ASK_USER_ID_MAX_LENGTH, description: "id of an earlier question in this set." }),
    values: Type.Array(Type.String({ maxLength: ASK_USER_ID_MAX_LENGTH }), { minItems: 1, maxItems: ASK_USER_OPTION_LIMIT, description: "Its option values (boolean: \"true\"/\"false\") that show this question." }),
  }, { description: "Show this question only while that earlier question has one of these options picked; hidden, it is skipped." })),
  kind: Type.Optional(Type.Union([Type.Literal("choice"), Type.Literal("boolean"), Type.Literal("text"), Type.Literal("number"), Type.Literal("date")], { description: "Default choice; other kinds take no options." })),
  default: Type.Optional(Type.Union([Type.Boolean(), Type.Number(), Type.String({ maxLength: ASK_USER_OTHER_TEXT_MAX_LENGTH })], { description: "Prefilled answer; date as YYYY-MM-DD." })),
  labels: Type.Optional(Type.Array(Type.String({ maxLength: ASK_USER_TEXT_MAX_LENGTH }), { maxItems: ASK_USER_OPTION_LIMIT, description: "boolean: [true, false] labels, default [\"Yes\", \"No\"]." })),
  multiline: Type.Optional(Type.Boolean({ description: "text: a textarea." })),
  minLength: Type.Optional(Type.Integer({ minimum: 0, maximum: ASK_USER_OTHER_TEXT_MAX_LENGTH })),
  maxLength: Type.Optional(Type.Integer({ minimum: 0, maximum: ASK_USER_OTHER_TEXT_MAX_LENGTH })),
  minimum: Type.Optional(Type.Number()),
  maximum: Type.Optional(Type.Number()),
  integer: Type.Optional(Type.Boolean()),
});

const AskUserParams = Type.Object({
  context: Type.Optional(Type.String({
    maxLength: ASK_USER_CONTEXT_MAX_LENGTH,
    description: "Required for a new set. Markdown shown above the questions: what all the questions share, so the user can answer without reading the Chat. Put each question's specifics in its `detail` and each option's consequence in the option's `detail`.",
  })),
  questions: Type.Optional(Type.Array(AskUserQuestionParams, {
    minItems: 1,
    maxItems: ASK_USER_QUESTION_LIMIT,
    description: "Required for a new set: the questions in reading order. Every question may be left unanswered.",
  })),
  update: Type.Optional(Type.String({
    maxLength: ASK_USER_ID_MAX_LENGTH,
    description: "askId of an open set to revise in place. Given context/questions replace the old ones; send neither to confirm the set is still current.",
  })),
  withdraw: Type.Optional(Type.String({
    maxLength: ASK_USER_ID_MAX_LENGTH,
    description: "askId of an open set to withdraw because it no longer matters. Send nothing else.",
  })),
  approval: Type.Optional(Type.Boolean({
    description: "true for a plan or text in context to approve, instead of a separate confirm question: adds an Approve button.",
  })),
});

/** Shapes one schema question into the domain question; the store owns validation. */
function toQuestion(param: Static<typeof AskUserQuestionParams>): AskUserQuestion {
  const { options, multiple, showIf, kind, labels, multiline, minLength, maxLength, minimum, maximum, integer } = param;
  // Typed-kind fields copy as given; the store keeps those the kind takes.
  const typed = {
    ...(kind === undefined ? {} : { kind }),
    ...(param.default === undefined ? {} : { default: param.default }),
    // The store checks the shape; the schema's array type cannot say "exactly two".
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    ...(labels === undefined ? {} : { labels: [...labels] as [string, string] }),
    ...(multiline === undefined ? {} : { multiline }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
    ...(integer === undefined ? {} : { integer }),
  };
  return {
    id: param.id,
    question: param.question,
    detail: param.detail,
    options: (options ?? []).map(toOption),
    ...(multiple === undefined ? {} : { multiple }),
    ...(showIf === undefined ? {} : { showIf: { question: showIf.question, values: [...showIf.values] } }),
    ...typed,
  };
}

function toOption(param: Static<typeof AskUserOptionParams>): AskUserQuestionOption {
  const { detail, recommended } = param;
  return { value: param.value, label: param.label, ...(detail === undefined ? {} : { detail }), ...(recommended === true ? { recommended } : {}) };
}

function refs(ask: PendingAskUser): string {
  return ask.questions.map((question) => askQuestionRef(ask.askId, question.id)).join(", ");
}

function postedText(ask: PendingAskUser): string {
  const count = ask.questions.length;
  return `Posted ${count.toString()} question${count === 1 ? "" : "s"} to the user as question chips above their composer, ask ${ask.askId} (${refs(ask)}). You are not paused: keep working on whatever does not depend on the answers, and end your turn if nothing does. The answers arrive later as a follow-up message. Do not repost these questions; revise them with update or drop them with withdraw.`;
}

function closedAskError(askId: string): Error {
  return new Error(`No open question set ${askId}: it was already answered, withdrawn, or closed.`);
}

/**
 * Custom tool that posts, revises, or withdraws a question set shown to the
 * user as question chips above the composer.
 *
 * It never awaits the user and never ends the run. Awaiting would pin the agent
 * run for an unbounded human-scale wait; instead the ask becomes daemon-owned
 * state and the agent keeps working. Submitted answers return later as a
 * follow-up message that wakes or queues behind the session's work.
 *
 * Rejected calls throw: the agent loop turns the thrown message into an error
 * tool result, so the model can fix the call and try again.
 */
export function createAskUserToolDefinition(deps: AskUserToolDeps) {
  return defineTool<typeof AskUserParams, AskUserToolDetails>({
    name: "ask_user",
    exposure: "model-only",
    label: "Ask user",
    description: "Post a self-contained question set, shown as question chips above the user's composer, and return immediately. Unlike ask_human (Telegram, blocks until he replies), it stays in this Chat. The set carries all explanation; your Chat message only says that questions were posted. Answers arrive later as a follow-up message; the user may leave any question unanswered. Give a follow-up question `showIf` instead of writing 'If X:' in its text. `context` and `detail` may hold Markdown images (https or workspace file path) and ```mermaid diagrams, including pie and xychart-beta charts, each shown folded until opened; to approve a code or text change, show it as ```diff or ```worddiff (old text, a `>>>` line, new text). The user can edit the context; treat an edited context as his version, so put text for approval (a plan, draft or message) there. Pass update: <askId> to revise or confirm an open set, or withdraw: <askId> to drop one.",
    promptSnippet: "ask_user: post, revise, or withdraw a self-contained question set for the user; returns immediately, answers arrive later as a follow-up",
    promptGuidelines: [
      "Use ask_user to batch the decisions you need from the user into one question set rather than asking in prose. It returns immediately: keep working on anything that does not depend on the answers, and end your turn if nothing does. The answers come back as a follow-up message that wakes you; do not poll or repost.",
      "Put all explanation into the ask_user set and none into your Chat message, which only says that questions were posted: the panel covers the Chat. `context` holds what all questions share; each question's `detail` says what the item is, gives an example, and where it stands; each option's `detail` states its consequence, and the recommended option starts selected. Do not number the question text; the panel numbers it. When one decision covers several independent items, use multiple: true with one option per item.",
      "Keep open ask_user sets current: when the facts change, call ask_user with update: <askId> (no other fields just confirms it) or withdraw: <askId>.",
    ],
    parameters: AskUserParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const content = params.context;
      const questions = params.questions?.map(toQuestion);
      if (params.withdraw !== undefined) {
        if (params.update !== undefined || content !== undefined || questions !== undefined || params.approval !== undefined) throw new Error("withdraw takes no other parameters");
        const withdrawn = await deps.withdraw(sessionId, params.withdraw);
        if (withdrawn === undefined) throw closedAskError(params.withdraw);
        return { content: [{ type: "text", text: `Withdrew question set ${withdrawn.askId}; its question chips are gone from the user's composer.` }], details: { withdrawn } };
      }
      if (params.update !== undefined) {
        const ask = await deps.update({ sessionId, askId: params.update, context: content, questions, approval: params.approval });
        if (ask === undefined) throw closedAskError(params.update);
        return { content: [{ type: "text", text: `Updated open question set ${ask.askId} (${refs(ask)}). The answers still arrive later as a follow-up message.` }], details: { ask, sessionId } };
      }
      const ask = await deps.open({ sessionId, context: content, questions, approval: params.approval });
      return { content: [{ type: "text", text: postedText(ask) }], details: { ask, sessionId } };
    },
  });
}
