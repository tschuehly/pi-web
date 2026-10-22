import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "../../piSdk.js";
import { loadDurableChatResources } from "./durableChatResources.js";

const roots: string[] = [];
const home = process.env["HOME"];
afterEach(async () => {
  process.env["HOME"] = home;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function skill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody of ${name}.\n`);
}

// P108: Durable Chats load resources with `noExtensions: true`. An installed package's skills come from Pi's package
// manager, not from its extensions, so they appear exactly as in a legacy Chat's loader (extensions loaded).
describe("Durable Chat resources", () => {
  it("lists an installed package's skills as a legacy Chat's loader does, with the package's extensions not loaded", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-durable-resources-"));
    roots.push(root);
    process.env["HOME"] = root; // ~/.agents/skills is part of discovery: keep it hermetic
    const agentDir = join(root, "agent");
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
});
