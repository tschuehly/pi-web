import { promptSlashMentions } from "../../shared/promptSlashMentions";

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

// `/skill:name` anywhere, or a bare `/name` after the start, picks a skill;
// a bare leading `/` falls through to the full command picker.
function activeSkillDirective(draft: string, cursor: number, knownNames?: ReadonlySet<string>): PromptCompletionTrigger | undefined {
  for (const mention of promptSlashMentions(draft, knownNames)) {
    if (!mention.skill && mention.from === 0) continue;
    if (cursor < mention.nameFrom || cursor > mention.nameTo + (mention.nameTo < mention.tokenTo ? 1 : 0)) continue;
    return { kind: "command", query: draft.slice(mention.from + 1, Math.min(cursor, mention.nameTo)), from: mention.from, to: mention.nameTo };
  }
  return undefined;
}
