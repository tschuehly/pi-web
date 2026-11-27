import { marked } from "marked";

/**
 * A command the agent proposes for the owner to run outside the write fence: a closed, top-level fenced code block
 * whose info string is exactly ```pi-run cwd="/abs/dir"``` (output returns to the agent) or
 * ```pi-run terminal cwd="/abs/dir"``` (opens in Terminal, for password, Touch ID and hidden prompts).
 */
export interface OwnerRunProposal {
  mode: "run" | "terminal";
  cwd: string;
  command: string;
}

export const OWNER_RUN_MAX_COMMAND_BYTES = 8 * 1024;
// Markdown unescapes backslashes in an info string, so the folder is quoted literally: no quote or backslash inside.
const INFO = /^pi-run(?: (terminal))? cwd="([^"\\]*)"$/u;
// Controls (tab and newline are checked apart), format and default-ignorable characters (bidi marks, zero-width joiners,
// U+2060…), and line/paragraph separators: anything that makes the shown text differ from what runs.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const unsafe = (text: string) => UNSAFE.test(text.replace(/[\t\n]/gu, ""));

/** Whether a code block's info string asks for a run button at all (valid or not). */
export function isOwnerRunInfo(info: string | undefined): boolean {
  return info !== undefined && /^pi-run(?:\s|$)/u.test(info.trim());
}

/** The proposal of one pi-run code block, or why it cannot run. */
export function ownerRunProposal(info: string, command: string): OwnerRunProposal | { error: string } {
  const match = INFO.exec(info.trim());
  if (match === null) return { error: 'the first line must be exactly ```pi-run cwd="/absolute/folder"``` or ```pi-run terminal cwd="…"```' };
  const cwd = match[2] ?? "";
  if (!cwd.startsWith("/") || unsafe(cwd)) return { error: "cwd must be an absolute folder path" };
  if (command.trim() === "") return { error: "the command is empty" };
  if (unsafe(command)) return { error: "the command contains control or invisible characters" };
  if (new TextEncoder().encode(command).length > OWNER_RUN_MAX_COMMAND_BYTES) return { error: "the command is longer than 8 KiB" };
  return { mode: match[1] === "terminal" ? "terminal" : "run", cwd, command };
}

/** The runnable proposals of a Markdown message: closed top-level pi-run blocks only; quotes, lists and an unclosed fence stay inert. */
export function ownerRunProposals(markdown: string): OwnerRunProposal[] {
  return marked.lexer(markdown, { gfm: true }).flatMap((token) => {
    if (token.type !== "code") return [];
    const lang: unknown = token.lang;
    // Markdown unescapes the info string; a backslash in the authored line would show and run something else than written.
    if (typeof lang !== "string" || !isOwnerRunInfo(lang) || !closedFence(token.raw) || (token.raw.split("\n", 1)[0] ?? "").includes("\\")) return [];
    const proposal = ownerRunProposal(lang, typeof token.text === "string" ? token.text : "");
    return "error" in proposal ? [] : [proposal];
  });
}

/** A proposal named in a request body or a button's data, checked as the block itself would be. */
export function ownerRunFromJson(value: unknown): OwnerRunProposal | { error: string } {
  if (typeof value !== "object" || value === null) return { error: "proposal must name mode, cwd and command" };
  const mode: unknown = Reflect.get(value, "mode");
  const cwd: unknown = Reflect.get(value, "cwd");
  const command: unknown = Reflect.get(value, "command");
  if ((mode !== "run" && mode !== "terminal") || typeof cwd !== "string" || typeof command !== "string")
    return { error: "proposal must name mode, cwd and command" };
  return ownerRunProposal(`pi-run${mode === "terminal" ? " terminal" : ""} cwd="${cwd}"`, command);
}

export function sameOwnerRun(a: OwnerRunProposal, b: OwnerRunProposal): boolean {
  return a.mode === b.mode && a.cwd === b.cwd && a.command === b.command;
}

function closedFence(raw: string): boolean {
  const lines = raw.replace(/\n+$/u, "").split("\n");
  const open = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0] ?? "")?.[1];
  const close = lines.length > 1 ? /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(lines.at(-1) ?? "")?.[1] : undefined;
  return open !== undefined && close !== undefined && close.startsWith(open.charAt(0)) && close.length >= open.length;
}
