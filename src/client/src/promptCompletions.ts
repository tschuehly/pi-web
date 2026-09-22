import type { SessionModel } from "../../shared/apiTypes";

export type PromptCompletionTrigger =
  | { kind: "command"; query: string; from: number; to: number }
  | { kind: "file"; query: string; from: number; to: number; fileScope?: "tracked" | "all" | undefined; allPrefix?: "@ " | "!@" | undefined; quoted?: boolean }
  | { kind: "model"; query: string; from: number; to: number };

export function detectPromptCompletionTrigger(draft: string, cursor = draft.length): PromptCompletionTrigger | undefined {
  const beforeCursor = draft.slice(0, cursor);
  const quotedTrigger = currentQuotedTrigger(beforeCursor, cursor);
  if (quotedTrigger !== undefined) return quotedTrigger;

  const tokenStart = beforeCursor.length - (/\S*$/.exec(beforeCursor)?.[0].length ?? 0);
  const token = beforeCursor.slice(tokenStart);
  // Pi only expands skill directives after the leading command. Never offer a
  // slash completion inside inline/fenced code or a larger path/URL token.
  const inCode = (beforeCursor.match(/(?<!\\)`/g)?.length ?? 0) % 2 !== 0;
  if (!inCode && token.startsWith("/skill:") && (tokenStart === 0 || /\s/.test(draft[tokenStart - 1] ?? ""))) {
    const end = draft.slice(cursor).search(/\s/);
    const to = end < 0 ? draft.length : cursor + end;
    if (!draft.slice(tokenStart + 1, to).includes("/")) return { kind: "command", query: token.slice(1), from: tokenStart, to };
  }

  const allFileTrigger = currentUnquotedAllFileTrigger(beforeCursor, cursor);
  if (allFileTrigger !== undefined) return allFileTrigger;

  const beforeToken = beforeCursor.slice(0, tokenStart);
  if (beforeToken.endsWith("@ ")) return { kind: "file", query: token, from: tokenStart - 2, to: cursor, fileScope: "all", allPrefix: "@ " };
  if (token.startsWith("/") && tokenStart === 0 && !token.slice(1).includes("/")) {
    const end = draft.slice(cursor).search(/\s/);
    return { kind: "command", query: token.slice(1), from: tokenStart, to: end < 0 ? draft.length : cursor + end };
  }
  if (token.startsWith("!@")) return { kind: "file", query: token.slice(2), from: tokenStart, to: cursor, fileScope: "all", allPrefix: "!@" };
  if (token.startsWith("@")) return { kind: "file", query: token.slice(1), from: tokenStart, to: cursor, fileScope: "tracked" };
  if (token.startsWith("#")) return { kind: "model", query: token.slice(1), from: tokenStart, to: cursor };
  return undefined;
}

export interface ModelCompletionChoice {
  insertText: string;
  detail: string;
  description?: string;
}

const MODEL_COMPLETION_LIMIT = 12;

export function modelCompletionChoices(models: readonly SessionModel[], query: string): ModelCompletionChoice[] {
  const needle = query.toLowerCase();
  const choices: ModelCompletionChoice[] = [];
  for (const model of models) {
    // A completion must produce a strict provider/model-id reference, so models
    // missing either half of the identity can never be inserted.
    if (!hasQualifiedModelId(model)) continue;
    if (!modelMatchesQuery(model, needle)) continue;
    choices.push({
      insertText: `#${model.provider}/${model.id}`,
      detail: model.provider,
      ...(model.name !== undefined && model.name !== "" && model.name !== model.id ? { description: model.name } : {}),
    });
    if (choices.length >= MODEL_COMPLETION_LIMIT) break;
  }
  return choices;
}

function hasQualifiedModelId(model: SessionModel): model is SessionModel & { provider: string; id: string } {
  return typeof model.provider === "string" && model.provider !== "" && typeof model.id === "string" && model.id !== "";
}

function modelMatchesQuery(model: SessionModel & { provider: string; id: string }, needle: string): boolean {
  return `${model.provider}/${model.id}`.toLowerCase().includes(needle)
    || model.id.toLowerCase().includes(needle)
    || (model.name?.toLowerCase().includes(needle) ?? false);
}

export function fileCompletionInsertText(path: string, quoted: boolean, allPrefix?: "@ " | "!@"): string {
  const prefix = allPrefix ?? "@";
  if (!quoted && !path.includes(" ")) return `${prefix}${path}`;
  return `${prefix}"${path}"`;
}

function currentQuotedTrigger(beforeCursor: string, cursor: number): PromptCompletionTrigger | undefined {
  const quoteStart = beforeCursor.lastIndexOf("\"");
  if (quoteStart === -1) return undefined;
  const prefix = beforeCursor.slice(0, quoteStart);
  if (prefix.endsWith("!@")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 2, to: cursor, fileScope: "all", allPrefix: "!@", quoted: true };
  if (prefix.endsWith("@")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 1, to: cursor, fileScope: "tracked", quoted: true };
  if (prefix.endsWith("@ ")) return { kind: "file", query: beforeCursor.slice(quoteStart + 1), from: prefix.length - 2, to: cursor, fileScope: "all", allPrefix: "@ ", quoted: true };
  return undefined;
}

function currentUnquotedAllFileTrigger(beforeCursor: string, cursor: number): PromptCompletionTrigger | undefined {
  const lineStart = beforeCursor.lastIndexOf("\n") + 1;
  const line = beforeCursor.slice(lineStart);
  const atSpaceIndex = lastTokenBoundarySequence(line, "@ ");
  const bangAtIndex = lastTokenBoundarySequence(line, "!@");
  const prefixStartInLine = Math.max(atSpaceIndex, bangAtIndex);
  if (prefixStartInLine === -1) return undefined;

  const allPrefix: "@ " | "!@" = prefixStartInLine === bangAtIndex ? "!@" : "@ ";
  const from = lineStart + prefixStartInLine;
  const queryStart = from + allPrefix.length;
  return { kind: "file", query: beforeCursor.slice(queryStart), from, to: cursor, fileScope: "all", allPrefix };
}

function lastTokenBoundarySequence(text: string, sequence: string): number {
  for (let index = text.lastIndexOf(sequence); index >= 0; index = text.lastIndexOf(sequence, index - 1)) {
    if (index === 0 || isWhitespace(text[index - 1])) return index;
  }
  return -1;
}

function isWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}
