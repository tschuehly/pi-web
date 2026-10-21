import type { AskUserOutcome } from "../../shared/apiTypes";
import type { ImageDimensions, SessionMediaReference } from "../../shared/sessionMedia";

export interface ToolPreview {
  diff?: string;
  firstChangedLine?: number;
  error?: string;
}

export interface ToolExecutionPart {
  type: "toolExecution";
  toolCallId?: string;
  toolName: string;
  summary: string;
  args?: unknown;
  status: "pending" | "running" | "success" | "error";
  resultText?: string;
  content?: unknown;
  details?: unknown;
  preview?: ToolPreview;
}

export interface GoalLifecycleDetails {
  schemaVersion: 1;
  goalId: string;
  transition: "start" | "resume" | "pause" | "wait" | "block" | "usage_limit" | "budget_limit" | "complete" | "clear";
  state: "active" | "waiting" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete" | "cleared";
  reason?: string;
  summary?: string;
}

/** One Working Mode dial; guidance is present only when the dial differs from its starting value. */
export interface WorkingModeDial { label: string; value: string; guidance?: string }

/** A reference never carries base64; inline images remain compatible with older machines. */
export type ChatImagePart =
  | ({ type: "image"; mimeType: string; data: string; mediaId?: never; byteSize?: never } & Partial<ImageDimensions>)
  | (SessionMediaReference & { data?: never });

export type ChatPart =
  | { type: "text"; text: string; displayText?: string }
  | ChatImagePart
  | { type: "thinking"; text: string; displayText?: string }
  | { type: "skillInvocation"; name: string; location: string; content: string }
  | { type: "skillRead"; name: string; path: string; toolCallId?: string }
  | { type: "askUserRecord"; outcome: AskUserOutcome }
  | { type: "goalLifecycle"; details: GoalLifecycleDetails }
  | { type: "subagentCompletion"; text: string }
  | { type: "backgroundBash"; details: { id: string; command: string; description?: string; state: "complete" | "failed" | "cancelled"; elapsedSeconds: number; logPath: string; exitCode?: number }; output: string }
  | { type: "workingMode"; dials: WorkingModeDial[] }
  /** Retain a coalesced result's conversation position without repeating its UI. */
  | { type: "toolResultBoundary"; toolCallId?: string }
  | { type: "toolCall"; toolCallId?: string; toolName: string; summary: string; args?: unknown }
  | ToolExecutionPart
  | { type: "toolResult"; toolCallId?: string; toolName: string; text: string; isError: boolean; content?: unknown; details?: unknown }
  | { type: "empty" };

export interface ChatLine {
  /** Identity of one live assistant message, retained through finalization. */
  streamId?: string;
  /** Durable session-tree entry; absent for optimistic or in-flight messages. */
  entryId?: string;
  role: "user" | "assistant" | "tool" | "system" | "bash" | "skill";
  parts: ChatPart[];
  source?: "compaction" | "branch_summary";
  severity?: "error" | "warning";
  meta?: {
    timestamp?: string;
    model?: { provider?: string; id?: string; responseId?: string };
    /** Thinking level the assistant message was generated with, when known. */
    thinkingLevel?: string;
  };
}
