import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "../../piSdk.js";
import { loadDurableChatResources } from "./durableChatResources.js";

const roots: string[] = [];
const saved = { HOME: process.env["HOME"], PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"] };
afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A fixture root that sees none of the owner's resources: HOME and Pi's agent directory point into it, and it is a
 * repository root, so Pi's ancestor `.agents/skills` walk stops there even when TMPDIR is under the real home.
 */
async function hermeticRoot(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-durable-resources-"));
  roots.push(root);
  await mkdir(join(root, ".git"));
  const agentDir = join(root, "agent");
  process.env["HOME"] = root;
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  return { root, agentDir };
}

async function skill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody of ${name}.\n`);
}

// P108: Durable Chats load resources with `noExtensions: true`. An installed package's skills come from Pi's package
// manager, not from its extensions, so they appear exactly as in a legacy Chat's loader (extensions loaded).
describe("Durable Chat resources", () => {
  it("lists an installed package's skills as a legacy Chat's loader does, with the package's extensions not loaded", async () => {
    const { root, agentDir } = await hermeticRoot();
    const pkg = join(root, "fixture-package");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    await skill(join(pkg, "skills"), "package-skill");
    await mkdir(join(pkg, "extensions"), { recursive: true });
    await writeFile(join(pkg, "extensions", "marker.ts"), "export default function marker() {}\n");
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture-package", version: "1.0.0", pi: { skills: ["./skills"], extensions: ["./extensions"] } }));
    await skill(join(agentDir, "skills"), "user-skill");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const durable = await loadDurableChatResources(cwd, agentDir);
    const legacy = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir), noThemes: true, noPromptTemplates: true });
    await legacy.reload();

    const names = durable.skillList.map((entry) => entry.name).sort();
    expect(names).toEqual(["package-skill", "user-skill"]);
    expect(names).toEqual(legacy.getSkills().skills.map((entry) => entry.name).sort());
    expect(legacy.getExtensions().extensions.map((extension) => extension.path)).toEqual([join(pkg, "extensions", "marker.ts")]);
    expect(durable.resources.skills).toContain("<name>package-skill</name>");
  });

  // P110: a host's packages contribute resources through `resources_discover`; they load as Pi's session extends them.
  it("adds the skills and prompts a host's packages contributed, with their extension as the source", async () => {
    const { root, agentDir } = await hermeticRoot();
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    await skill(join(agentDir, "skills"), "user-skill");
    const contributed = join(root, "package", "contributed");
    await skill(contributed, "contributed-skill");
    await mkdir(join(root, "package", "prompts"), { recursive: true });
    await writeFile(join(root, "package", "prompts", "contributed-prompt.md"), "---\ndescription: Contributed prompt\n---\nDo $1.\n");
    const extensionPath = join(root, "package", "probe.ts");

    const durable = await loadDurableChatResources(cwd, agentDir, {
      skillPaths: [{ path: contributed, extensionPath }],
      promptPaths: [{ path: join(root, "package", "prompts"), extensionPath }],
    });

    expect(durable.skillList.map((entry) => entry.name).sort()).toEqual(["contributed-skill", "user-skill"]);
    expect(durable.resources.skills).toContain("<name>contributed-skill</name>");
    expect(durable.promptList?.map((template) => template.name)).toContain("contributed-prompt");
    // Without contributions nothing extra appears.
    expect((await loadDurableChatResources(cwd, agentDir)).skillList.map((entry) => entry.name)).toEqual(["user-skill"]);
  });
});
