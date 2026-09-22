import type { SessionModel } from "../../shared/apiTypes";

export type PromptCompletionTrigger =
  | { kind: "command"; query: string; from: number; to: number }
  | { kind: "file"; query: string; from: number; to: number; fileScope?: "tracked" | "all" | undefined; allPrefix?: "@ " | "!@" | undefined; quoted?: boolean }
  | { kind: "model"; query: string; from: number; to: number };

export function detectPromptCompletionTrigger(draft: string, cursor = draft.length, knownNames?: ReadonlySet<string>): PromptCompletionTrigger | undefined {
  const beforeCursor = draft.slice(0, cursor);
  const quotedTrigger = currentQuotedTrigger(beforeCursor, cursor);
  if (quotedTrigger !== undefined) return quotedTrigger;

  const tokenStart = beforeCursor.length - (/\S*$/.exec(beforeCursor)?.[0].length ?? 0);
  const token = beforeCursor.slice(tokenStart);
  const skill = activeSkillDirective(draft, cursor, knownNames);
  if (skill !== undefined) return skill;

  const allFileTrigger = currentUnquotedAllFileTrigger(beforeCursor, cursor);
  if (allFileTrigger !== undefined) return allFileTrigger;

  const beforeToken = beforeCursor.slice(0, tokenStart);
  if (beforeToken.endsWith("@ ")) return { kind: "file", query: token, from: tokenStart - 2, to: cursor, fileScope: "all", allPrefix: "@ " };
  if (token.startsWith("/") && tokenStart === 0 && !token.slice(1).includes("/")) {
    if (token.startsWith("/skill:")) return undefined;
    const end = draft.slice(cursor).search(/\s/);
    return { kind: "command", query: token.slice(1), from: tokenStart, to: end < 0 ? draft.length : cursor + end };
  }
  if (token.startsWith("!@")) return { kind: "file", query: token.slice(2), from: tokenStart, to: cursor, fileScope: "all", allPrefix: "!@" };
  if (token.startsWith("@")) return { kind: "file", query: token.slice(1), from: tokenStart, to: cursor, fileScope: "tracked" };
  if (token.startsWith("#")) return { kind: "model", query: token.slice(1), from: tokenStart, to: cursor };
  return undefined;
}

// Match Pi's literal-context and token rules without loading its filesystem skill scanner.
function activeSkillDirective(draft: string, cursor: number, knownNames?: ReadonlySet<string>): PromptCompletionTrigger | undefined {
  let fence: { marker: string; length: number } | undefined;
  let inlineCodeRun = 0;
  let offset = 0;
  for (const line of draft.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch && (fence !== undefined || inlineCodeRun === 0)) {
      const marker = fenceMatch[1]?.charAt(0) ?? "";
      const length = fenceMatch[1]?.length ?? 0;
      if (fence === undefined) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length && /^\s*$/.test(line.slice(fenceMatch[0].length))) fence = undefined;
    } else if (fence === undefined && !/^\s*>/.test(line)) {
      let quote: "'" | '"' | undefined;
      for (let i = 0; i < line.length; i++) {
        const char = line.charAt(i);
        if (inlineCodeRun === 0 && quote !== undefined) {
          if (char === quote && line[i - 1] !== "\\") quote = undefined;
          continue;
        }
        if (char === "`") {
          let end = i + 1;
          while (line[end] === "`") end++;
          let backslashes = 0;
          while (line[i - backslashes - 1] === "\\") backslashes++;
          if (backslashes % 2 === 0) {
            if (inlineCodeRun === end - i) inlineCodeRun = 0;
            else if (inlineCodeRun === 0) inlineCodeRun = end - i;
          }
          i = end - 1;
          continue;
        }
        if (inlineCodeRun !== 0) continue;
        if (char === '"' || (char === "'" && !/\w/.test(line[i - 1] ?? ""))) {
          // Unpaired prose quotes must not hide later directives.
          if (line.slice(i + 1).split("").some((next, index) => next === char && line[i + 1 + index - 1] !== "\\")) quote = char;
          if (quote !== undefined) continue;
        }
        if (!line.startsWith("/skill:", i) || (i > 0 && !/\s/.test(line.charAt(i - 1)))) continue;
        const start = i;
        i += 7;
        const nameStart = i;
        while (i < line.length && !/\s/.test(line.charAt(i))) i++;
        const candidate = line.slice(nameStart, i);
        const name = knownNames?.has(`skill:${candidate}`) === true ? candidate : candidate.replace(/(?<![,.!?;:])[,.!?;:]$/, "");
        const end = nameStart + name.length;
        if ((candidate === "" || name !== "") && (knownNames?.has(`skill:${name}`) === true || /^[\p{L}\p{N}_-]*$/u.test(name))
          && cursor >= offset + nameStart && cursor <= offset + end + (end < i ? 1 : 0)) {
          return { kind: "command", query: line.slice(start + 1, Math.min(cursor - offset, end)), from: offset + start, to: offset + end };
        }
        i--;
      }
    }
    offset += line.length + 1;
  }
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
