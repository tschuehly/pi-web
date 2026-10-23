import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
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
  /** Prompt templates (global, project and package `prompts/`), for `/name args` expansion and the command list. */
  promptList?: DurablePromptTemplate[];
}

/**
 * Skill and prompt paths a Durable host's bound Pi packages contributed through `resources_discover`, each with the
 * extension file that contributed it (Pi's `emitResourcesDiscover` entries). Themes are not used by PI WEB.
 */
export interface DurableContributedResources {
  skillPaths: { path: string; extensionPath: string }[];
  promptPaths: { path: string; extensionPath: string }[];
}

export interface DurablePromptTemplate { name: string; description?: string; argumentHint?: string; content: string }

/**
 * Load a Durable Chat's resources the way a legacy Chat's session does: Pi's `DefaultResourceLoader` for the
 * workspace and agent directory, honoring project trust, with the same skill roots and settings packages. Extensions
 * run in the host, not here: the resources its packages contributed are added as Pi's session adds them
 * (`extendResourcesFromExtensions`), with the contributing extension as their source.
 */
export async function loadDurableChatResources(cwd: string, agentDir: string, contributed?: DurableContributedResources): Promise<DurableChatResourceSet> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const trusted = await resolveWebProjectTrusted({ cwd, trustStore: new ProjectTrustStore(agentDir), settingsManager });
  const trustedSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: trustedSettings, noExtensions: true, noThemes: true });
  await loader.reload();
  if (contributed !== undefined) loader.extendResources({ skillPaths: contributed.skillPaths.map(extensionResource), promptPaths: contributed.promptPaths.map(extensionResource) });
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
    promptList: loader.getPrompts().prompts.map((template) => ({
      name: template.name, content: template.content,
      ...(template.description === "" ? {} : { description: template.description }),
      ...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
    })),
  };
}

/** Pi's `buildExtensionResourcePaths` for one contributed path. */
function extensionResource(entry: { path: string; extensionPath: string }) {
  return { path: entry.path, metadata: { source: `extension:${basename(entry.extensionPath).replace(/\.(ts|js)$/, "")}`, scope: "temporary" as const, origin: "top-level" as const, baseDir: dirname(entry.extensionPath) } };
}

/**
 * The thinking level of a new Durable Chat, as Pi picks one for a new session: the model's own setting, else the
 * default thinking level, else Pi's default (`medium`). The host clamps it to the model.
 */
export function durableThinkingLevel(cwd: string, agentDir: string, model: string): string {
  const settings = SettingsManager.create(cwd, agentDir);
  const [provider = "", id = ""] = model.split("/", 2);
  return settings.getModelThinkingLevel(provider, id) ?? settings.getDefaultThinkingLevel() ?? "medium";
}

/** `/name args` naming a template expands as Pi's `expandPromptTemplate` does (it is not exported); others stay. */
export function expandPromptTemplate(text: string, templates: readonly DurablePromptTemplate[]): string {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  const template = match === null ? undefined : templates.find((candidate) => candidate.name === match[1]);
  return template === undefined ? text : substituteArgs(template.content, parseCommandArgs(match?.[2] ?? ""));
}

/** Pi's `parseCommandArgs`: bash-style arguments, quotes kept together, quoted empty strings kept. */
function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let inQuote: string | undefined;
  for (const char of argsString) {
    if (inQuote !== undefined) {
      if (char === inQuote) inQuote = undefined;
      else current += char;
    } else if (char === "\"" || char === "'") {
      inQuote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) { args.push(current); current = ""; hasToken = false; }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/** Pi's `substituteArgs`: $1, $@, $ARGUMENTS, ${N:-default}, ${@:-default}, ${@:N}, ${@:N:L}; no recursive substitution. */
function substituteArgs(content: string, args: string[]): string {
  const all = args.join(" ");
  return content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g, (_match, defaultTarget: string | undefined, defaultValue: string, sliceStart: string | undefined, sliceLength: string | undefined, simple: string) => {
    if (defaultTarget !== undefined) {
      const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? all : args[Number.parseInt(defaultTarget, 10) - 1];
      return value !== undefined && value !== "" ? value : defaultValue;
    }
    if (sliceStart !== undefined) {
      const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
      return (sliceLength === undefined ? args.slice(start) : args.slice(start, start + Number.parseInt(sliceLength, 10))).join(" ");
    }
    if (simple === "ARGUMENTS" || simple === "@") return all;
    return args[Number.parseInt(simple, 10) - 1] ?? "";
  });
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
