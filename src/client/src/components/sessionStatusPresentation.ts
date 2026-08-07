import type { SessionStatus } from "../api";
import { formatCost, formatTokenCount } from "../utils/format";

export const HIGH_CONTEXT_USAGE_PERCENT = 80;

export interface SessionWarningControlContent {
  countText: string;
  accessibleLabel: string;
}

export function sessionWarningControlContent(count: number, expanded: boolean): SessionWarningControlContent | undefined {
  if (!Number.isInteger(count) || count <= 0) return undefined;
  const warningText = `${String(count)} ${count === 1 ? "warning" : "warnings"}`;
  return {
    countText: String(count),
    accessibleLabel: expanded ? `Minimise ${warningText}` : `Show ${warningText} in the warning area`,
  };
}

export interface SessionStatusPresentation {
  contextText: string;
  contextSummaryText: string;
  contextCompactText: string;
  contextStatusText: string;
  contextAccessibleLabel: string;
  contextHighUsage: boolean;
  inputText: string;
  outputText: string;
  costText: string;
  queuedText?: string;
  detailText: string;
}

export function sessionStatusPresentation(status: SessionStatus): SessionStatusPresentation {
  const context = status.contextUsage;
  const contextText = context === undefined
    ? "context unknown"
    : context.percent === null
      ? `context ${formatTokenCount(context.contextWindow)}`
      : `${context.percent.toFixed(1)}%/${formatTokenCount(context.contextWindow)}`;
  const contextHighUsage = context?.percent !== null && context?.percent !== undefined && context.percent >= HIGH_CONTEXT_USAGE_PERCENT;
  const contextSummaryText = context?.percent == null
    ? contextText
    : `${contextHighUsage ? "⚠ " : ""}${context.percent.toFixed(1)}% context`;
  const contextCompactText = context?.percent == null
    ? contextText
    : `${contextHighUsage ? "⚠ " : ""}${context.percent.toFixed(1)}%`;
  const contextAccessibleLabel = context === undefined
    ? "Context usage unknown"
    : context.percent === null
      ? `Context window: ${formatTokenCount(context.contextWindow)}`
      : `${contextHighUsage ? "High context usage" : "Context usage"}: ${context.percent.toFixed(1)}% of ${formatTokenCount(context.contextWindow)} context window`;
  const inputText = `↑${formatTokenCount(status.tokens.input)}`;
  const outputText = `↓${formatTokenCount(status.tokens.output)}`;
  const costText = formatCost(status.cost);
  const queuedText = status.pendingMessageCount > 0 ? `${String(status.pendingMessageCount)} queued` : undefined;
  return {
    contextText,
    contextSummaryText,
    contextCompactText,
    contextStatusText: `${contextHighUsage ? "⚠ " : ""}${contextText}`,
    contextAccessibleLabel,
    contextHighUsage,
    inputText,
    outputText,
    costText,
    ...(queuedText === undefined ? {} : { queuedText }),
    detailText: [inputText, outputText, costText, queuedText].filter((part) => part !== undefined).join(" · "),
  };
}
