// Shared shapes of the mock model server's control API (server.ts) and its spec client (client.ts).

export type MockProvider = "anthropic" | "openai-codex";

/** Anthropic stop reasons; the Codex dialect maps them (max_tokens → incomplete, the rest → completed). */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn";

/** `title`: PI WEB's session-naming request (sessionNameGenerator.ts system prompt); everything else is `chat`. */
export type RequestKind = "chat" | "title";

export type ErrorPreset = "overloaded" | "rate_limit" | "server" | "invalid_request" | "auth";

export type Step =
  | { text: string }
  | { thinking: string }
  /** Script tools by their Pi name (`read`, `ask_user`); the mock answers with the name the request declared (`Read`, `mcp__pi__ask_user`). */
  | { toolCall: { name: string; args?: Record<string, unknown>; id?: string } }
  /** Hold the response here until the spec releases this barrier (see client.ts `waitForBarrier`/`release`). */
  | { barrier: string }
  /** Server-side pause; specs must assert through barriers or the UI, never through this delay. */
  | { delayMs: number }
  /** Before any output: an HTTP error response. After output started: a streamed error event. */
  | { error: ErrorPreset | { status: number; type?: string; message?: string; headers?: Record<string, string> } }
  /** Cut the connection mid-response (network failure). */
  | { drop: true };

export type Turn = string | Step[] | { steps: Step[]; stopReason?: StopReason; usage?: Usage };

export type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

export type Script = {
  /** Optional stable name; returned ids are otherwise generated. */
  id?: string;
  /** Answer only this provider's requests. */
  provider?: MockProvider;
  /** Default `chat`: session-naming requests never consume a chat script (they get "Mock title" unless a `title` script matches). */
  kind?: RequestKind;
  /** Answer only requests whose user-side text (prompts and tool results) contains this; a marker in the first prompt keys a whole Chat. */
  match?: string;
  /** One turn per matching request, in order; when they run out, requests fall through to later scripts and then the echo default. */
  turns: Turn[];
};

export type ScriptStatus = { id: string; provider?: MockProvider; kind: RequestKind; match?: string; total: number; used: number };

export type JournalEntry = {
  seq: number;
  at: string;
  provider: MockProvider;
  kind: RequestKind;
  transport: "http" | "websocket";
  method: string;
  path: string;
  model?: string;
  /** Request headers; credential headers are replaced with `[redacted]`. */
  headers: Record<string, string>;
  /** `oauth` for an sk-ant-oat bearer, `jwt` for a ChatGPT token, `api-key`, or `none`; the value itself is never recorded. */
  auth: "oauth" | "jwt" | "api-key" | "none";
  body: unknown;
  /** Subscription-shape violations; a non-empty list made the mock answer 400. */
  violations: string[];
  /** The script turn that answered; `echo` for an unscripted request: `echo: <first line of the last user text, ≤ 60 chars>`, or `Mock title`. */
  answeredBy: { script: string; turn: number } | "echo" | "rejected";
  /** Wire tool names the mock answered with, in order (after aliasing to the request's declared names). */
  toolCalls: string[];
  status: number;
  /** `pending` while streaming or held at a barrier; `client-closed` when the caller went away first (Stop, a killed host). */
  outcome: "pending" | "completed" | "error" | "dropped" | "client-closed";
  /** Last user-side text of the request (prompt or tool result). */
  lastUserText: string;
};

export type BarrierState = { name: string; reached: boolean; released: boolean };
