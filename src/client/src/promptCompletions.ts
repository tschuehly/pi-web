export type PromptCompletionTrigger =
  | { kind: "command"; query: string; from: number; to: number };

export function detectPromptCompletionTrigger(draft: string, cursor = draft.length, knownNames?: ReadonlySet<string>): PromptCompletionTrigger | undefined {
  const beforeCursor = draft.slice(0, cursor);
  const tokenStart = beforeCursor.length - (/\S*$/.exec(beforeCursor)?.[0].length ?? 0);
  const token = beforeCursor.slice(tokenStart);
  const skill = activeSkillDirective(draft, cursor, knownNames);
  if (skill !== undefined) return skill;

  if (token.startsWith("/") && tokenStart === 0 && !token.slice(1).includes("/")) {
    if (token.startsWith("/skill:")) return undefined;
    const end = draft.slice(cursor).search(/\s/);
    return { kind: "command", query: token.slice(1), from: tokenStart, to: end < 0 ? draft.length : cursor + end };
  }
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
