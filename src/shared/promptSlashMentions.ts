/** A `/name` or `/skill:name` token in prompt prose; offsets are absolute into the scanned text. */
export interface PromptSlashMention {
  from: number;
  nameFrom: number;
  nameTo: number;
  tokenTo: number;
  name: string;
  skill: boolean;
}

/**
 * Slash tokens at line start or after whitespace, outside code spans, fences,
 * indented code blocks, quotes, and blockquotes. One trailing prose mark is not part of the name
 * unless `knownNames` (`skill:<name>` entries) says it is. Shared by composer
 * completion and server-side inline skill expansion so both agree on what counts.
 */
export function promptSlashMentions(text: string, knownNames?: ReadonlySet<string>): PromptSlashMention[] {
  const mentions: PromptSlashMention[] = [];
  let fence: { marker: string; length: number } | undefined;
  let inlineCodeRun = 0;
  let offset = 0;
  // Indented code starts after a blank line (or the text start) and cannot interrupt a paragraph.
  let indentedCode = false;
  let previousBlank = true;
  for (const line of text.split("\n")) {
    const blank = /^\s*$/.test(line);
    indentedCode = fence === undefined && inlineCodeRun === 0 && (blank ? indentedCode : /^( {4}|\t)/.test(line) && (previousBlank || indentedCode));
    previousBlank = blank;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch && (fence !== undefined || inlineCodeRun === 0)) {
      const marker = fenceMatch[1]?.charAt(0) ?? "";
      const length = fenceMatch[1]?.length ?? 0;
      if (fence === undefined) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length && /^\s*$/.test(line.slice(fenceMatch[0].length))) fence = undefined;
    } else if (fence === undefined && !indentedCode && !/^\s*>/.test(line)) {
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
        if (char !== "/" || (i > 0 && !/\s/.test(line.charAt(i - 1)))) continue;
        const skill = line.startsWith("/skill:", i);
        const nameStart = i + (skill ? 7 : 1);
        let tokenEnd = nameStart;
        while (tokenEnd < line.length && !/\s/.test(line.charAt(tokenEnd))) tokenEnd++;
        const candidate = line.slice(nameStart, tokenEnd);
        const name = knownNames?.has(`skill:${candidate}`) === true ? candidate : candidate.replace(/(?<![,.!?;:])[,.!?;:]$/, "");
        if ((candidate === "" || name !== "") && (knownNames?.has(`skill:${name}`) === true || /^[\p{L}\p{N}_-]*$/u.test(name))) {
          mentions.push({ from: offset + i, nameFrom: offset + nameStart, nameTo: offset + nameStart + name.length, tokenTo: offset + tokenEnd, name, skill });
        }
        // A skill directive token is opaque; a bare slash keeps scanning for quotes and code.
        if (skill) i = tokenEnd - 1;
      }
    }
    offset += line.length + 1;
  }
  return mentions;
}
