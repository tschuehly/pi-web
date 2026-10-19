import { Type, type Static } from "pi-web-typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_CONTEXT_MAX_LENGTH,
  ASK_USER_ID_MAX_LENGTH,
  ASK_USER_OPTION_LIMIT,
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
    description: "Mark the option you recommend.",
  })),
});

const AskUserQuestionParams = Type.Object({
  id: Type.String({
    maxLength: ASK_USER_ID_MAX_LENGTH,
    description: "Unique within this call; used as the answer key reported back to you.",
  }),
  question: Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "The question itself, as one plain-text line.",
  }),
  detail: Type.Optional(Type.String({
    maxLength: ASK_USER_TEXT_MAX_LENGTH,
    description: "Optional supporting context shown under the question.",
  })),
  options: Type.Optional(Type.Array(AskUserOptionParams, {
    maxItems: ASK_USER_OPTION_LIMIT,
    description: "Options to choose from. Omit when free text is the whole answer; the browser always adds a Custom choice.",
  })),
  multiple: Type.Optional(Type.Boolean({
    description: "Allow several options at once. Default: one answer per question.",
  })),
});

const AskUserParams = Type.Object({
  context: Type.Optional(Type.String({
    maxLength: ASK_USER_CONTEXT_MAX_LENGTH,
    description: "Required for a new set. Markdown shown above the questions, at most five short lines: only the finding the decision rests on, so the user can answer without reading the Chat. Put each option's consequence in its `detail` and mark the recommended option there; do not restate the options, the history, or check results here.",
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
});

/** Shapes one schema question into the domain question; the store owns validation. */
function toQuestion(param: Static<typeof AskUserQuestionParams>): AskUserQuestion {
  const { detail, options, multiple } = param;
  return {
    id: param.id,
    question: param.question,
    ...(detail === undefined ? {} : { detail }),
    options: (options ?? []).map(toOption),
    ...(multiple === undefined ? {} : { multiple }),
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
  return `Posted ${count.toString()} question${count === 1 ? "" : "s"} to the user's Questions pane as ask ${ask.askId} (${refs(ask)}). You are not paused: keep working on whatever does not depend on the answers, and end your turn if nothing does. The answers arrive later as a follow-up message. Do not repost these questions; revise them with update or drop them with withdraw.`;
}

function closedAskError(askId: string): Error {
  return new Error(`No open question set ${askId}: it was already answered, withdrawn, or closed.`);
}

/**
 * Custom tool that posts, revises, or withdraws a question set in the user's
 * Questions pane.
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
    description: "Post a self-contained question set to the user's Questions pane and return immediately. Answers arrive later as a follow-up message; the user may leave any question unanswered. Pass update: <askId> to revise or confirm an open set, or withdraw: <askId> to drop one.",
    promptSnippet: "ask_user: post, revise, or withdraw a self-contained question set for the user; returns immediately, answers arrive later as a follow-up",
    promptGuidelines: [
      "Use ask_user to batch the decisions you need from the user into one question set rather than asking in prose. It returns immediately: keep working on anything that does not depend on the answers, and end your turn if nothing does. The answers come back as a follow-up message that wakes you; do not poll or repost.",
      "Keep each ask_user set self-contained and short: context is at most five short lines with only the finding the decision rests on; each option states its own consequence in `detail`, and the recommended option is marked. The user must be able to answer without reading the Chat.",
      "Keep open ask_user sets current: when the facts change, call ask_user with update: <askId> (no other fields just confirms it) or withdraw: <askId>.",
    ],
    parameters: AskUserParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const content = params.context;
      const questions = params.questions?.map(toQuestion);
      if (params.withdraw !== undefined) {
        if (params.update !== undefined || content !== undefined || questions !== undefined) throw new Error("withdraw takes no other parameters");
        const withdrawn = await deps.withdraw(sessionId, params.withdraw);
        if (withdrawn === undefined) throw closedAskError(params.withdraw);
        return { content: [{ type: "text", text: `Withdrew question set ${withdrawn.askId}; it is gone from the user's Questions pane.` }], details: { withdrawn } };
      }
      if (params.update !== undefined) {
        const ask = await deps.update({ sessionId, askId: params.update, context: content, questions });
        if (ask === undefined) throw closedAskError(params.update);
        return { content: [{ type: "text", text: `Updated open question set ${ask.askId} (${refs(ask)}). The answers still arrive later as a follow-up message.` }], details: { ask, sessionId } };
      }
      const ask = await deps.open({ sessionId, context: content, questions });
      return { content: [{ type: "text", text: postedText(ask) }], details: { ask, sessionId } };
    },
  });
}
