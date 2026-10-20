import { readFileSync } from "node:fs";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { promptSlashMentions } from "../../shared/promptSlashMentions.js";

export interface InlineSkill {
  name: string;
  filePath: string;
  baseDir: string;
}

/**
 * Expand known `/skill:name` mentions past the start of a prompt into Pi's
 * skill block, in place. Pi core expands only a leading mention followed by a
 * space or the end, so that one is left for core; each skill expands at most
 * once and unreadable or unknown skills stay literal.
 */
export function expandInlineSkillMentions(text: string, skills: readonly InlineSkill[]): string {
  const byName = new Map(skills.map((skill) => [`skill:${skill.name}`, skill]));
  const expanded = new Set<InlineSkill>();
  let result = "";
  let cursor = 0;
  for (const mention of promptSlashMentions(text, new Set(byName.keys()))) {
    const skill = mention.skill ? byName.get(`skill:${mention.name}`) : undefined;
    if (skill === undefined || expanded.has(skill)) continue;
    expanded.add(skill);
    if (mention.from === 0 && (mention.nameTo === text.length || text.charAt(mention.nameTo) === " ")) continue;
    let body: string;
    try {
      body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
    } catch {
      continue;
    }
    // Same block format as Pi core's AgentSession._expandSkillCommand.
    result += `${text.slice(cursor, mention.from)}<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    cursor = mention.nameTo;
  }
  return result + text.slice(cursor);
}
