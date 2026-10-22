import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DefaultResourceLoader, formatSkillsForPrompt, ProjectTrustStore, SettingsManager, stripFrontmatter } from "../../piSdk.js";
import { resolveWebProjectTrusted } from "./piSessionService.js";
import { expandInlineSkillMentions, type InlineSkill } from "./inlineSkills.js";

/** What a Durable Chat's host renders into its system prompt, resolved here with Pi's own loader and formatters. */
export interface DurableChatResources {
  /** APPEND_SYSTEM.md content (Pi's `<addendum>`). */
  addendum?: string;
  /** Global and project AGENTS.md/CLAUDE.md files in Pi's precedence (Pi's `<project_context>`). */
  projectContext?: string;
  /** The skill catalog as Pi formats it for the read tool (Pi's `<skills>`). */
  skills?: string;
  sources: { path: string; sha256: string }[];
}

export interface DurableChatResourceSet {
  resources: DurableChatResources;
  /** Pi's compaction settings for the workspace, applied to the host's automatic compaction. */
  compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  /** Every loaded skill, for `/skill:name` expansion and the command list. */
  skillList: (InlineSkill & { description?: string })[];
}

/**
 * Load a Durable Chat's resources the way a legacy Chat's session does: Pi's `DefaultResourceLoader` for the
 * workspace and agent directory, honoring project trust, with the same skill roots and settings packages. Extensions
 * are not loaded here (Durable Chats do not run Pi extensions), so resources an extension would add are absent.
 */
export async function loadDurableChatResources(cwd: string, agentDir: string): Promise<DurableChatResourceSet> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const trusted = await resolveWebProjectTrusted({ cwd, trustStore: new ProjectTrustStore(agentDir), settingsManager });
  const trustedSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: trustedSettings, noExtensions: true, noThemes: true, noPromptTemplates: true });
  await loader.reload();
  const agentsFiles = loader.getAgentsFiles().agentsFiles;
  const skills = loader.getSkills().skills;
  const addendum = loader.getAppendSystemPrompt().join("\n\n");
  // Pi's system-prompt.js `renderProjectContext`, which the package does not export.
  const projectContext = agentsFiles.length === 0 ? undefined : [
    "Project-specific instructions and guidelines:",
    ...agentsFiles.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
  ].join("\n\n");
  const skillsPrompt = formatSkillsForPrompt(skills, "read").trim();
  const hash = (content: string) => createHash("sha256").update(content).digest("hex");
  return {
    resources: {
      ...(addendum === "" ? {} : { addendum }),
      ...(projectContext === undefined ? {} : { projectContext }),
      ...(skillsPrompt === "" ? {} : { skills: skillsPrompt }),
      sources: [
        ...agentsFiles.map((file) => ({ path: file.path, sha256: hash(file.content) })),
        ...loader.getAppendSystemPromptSources().map((source) => ({ path: source.path, sha256: hash(addendum) })),
      ],
    },
    compaction: trustedSettings.getCompactionSettings(),
    skillList: skills.map((skill) => ({ name: skill.name, filePath: skill.filePath, baseDir: skill.baseDir, ...(skill.description === "" ? {} : { description: skill.description }) })),
  };
}

/**
 * Expand `/skill:name args` at the start of a prompt into Pi's skill block (AgentSession `_expandSkillCommand`), and
 * known `/skill:name` mentions further on (as legacy Chats do). Unknown or unreadable skills stay literal.
 */
export function expandSkills(text: string, skills: readonly InlineSkill[]): string {
  const inline = expandInlineSkillMentions(text, skills);
  if (!inline.startsWith("/skill:")) return inline;
  const space = inline.indexOf(" ");
  const name = space === -1 ? inline.slice(7) : inline.slice(7, space);
  const args = space === -1 ? "" : inline.slice(space + 1).trim();
  const skill = skills.find((candidate) => candidate.name === name);
  if (skill === undefined) return inline;
  let body: string;
  try {
    body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
  } catch {
    return inline;
  }
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return args === "" ? block : `${block}\n\n${args}`;
}
