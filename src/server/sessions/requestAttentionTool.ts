import { Type } from "pi-web-typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ASK_USER_TEXT_MAX_LENGTH, type SessionAttentionRequest } from "../../shared/apiTypes.js";

export interface RequestAttentionToolDeps {
  /** Records the session's attention request, replacing an earlier one, and notifies the user. */
  requestAttention(sessionId: string, reason: string): SessionAttentionRequest;
}

export interface RequestAttentionToolDetails { request: SessionAttentionRequest; sessionId: string }

const RequestAttentionParams = Type.Object({
  reason: Type.String({
    description: "One short, self-contained line: what you need from the user and why, readable without the Chat.",
  }),
});

/**
 * Custom tool that flags a Chat as needing the user, for when the agent has no
 * decision to ask. Like `ask_user` it never waits: the request becomes
 * daemon-owned state that notifies the user and marks the Chat until viewed.
 */
export function createRequestAttentionToolDefinition(deps: RequestAttentionToolDeps) {
  return defineTool<typeof RequestAttentionParams, RequestAttentionToolDetails>({
    name: "request_attention",
    exposure: "model-only",
    label: "Request attention",
    description: "Notify the user that this Chat needs them and mark it until they look, then return immediately. Use when you need the user but have no decision to ask: finished work that needs their review, a login or credential, a manual check only they can do, or being blocked. Decisions go to ask_user instead.",
    promptSnippet: "request_attention: notify the user that you need them (review, login or credential, manual check, blocked) without a decision to ask; returns immediately",
    promptGuidelines: [
      "Use request_attention when you need the user but have no decision to ask: finished work that needs their review, a login or credential, a manual check only they can do, or being blocked. Decisions go to ask_user instead. It returns immediately and does not wait.",
      "Do not call request_attention for routine progress or after every turn. Write the reason so the user can act without reading the Chat: what you need from them and why, in one short line.",
    ],
    parameters: RequestAttentionParams,
    // eslint-disable-next-line @typescript-eslint/require-await -- async so a blank reason becomes an error tool result rather than a synchronous throw.
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reason = params.reason.trim().slice(0, ASK_USER_TEXT_MAX_LENGTH);
      if (reason === "") throw new Error("request_attention needs a reason: what you need from the user and why");
      const sessionId = ctx.sessionManager.getSessionId();
      const request = deps.requestAttention(sessionId, reason);
      return {
        content: [{ type: "text", text: "Notified the user that this Chat needs them. This does not wait for a reply: keep working on anything that does not need them, or end your turn." }],
        details: { request, sessionId },
      };
    },
  });
}
