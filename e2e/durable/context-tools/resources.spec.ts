/** AC-P107 AC-P108 AC-P109 plus P056 skill-loading lens: trusted resources and fixture precedence. */
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test, expect, mock, root, project, fixture, settings, createChat, answer } from "./support";

test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });
test.setTimeout(60_000);

async function resources() {
  await fixture(join(root(), "agent", "AGENTS.md"), "GLOBAL_AGENT_MARKER");
  await fixture(join(root(), "AGENTS.md"), "ANCESTOR_AGENT_MARKER");
  await fixture(join(project(), "AGENTS.md"), "PROJECT_AGENT_MARKER");
  await fixture(join(root(), "agent", "APPEND_SYSTEM.md"), "GLOBAL_APPEND_MARKER");
  await fixture(join(project(), ".pi", "APPEND_SYSTEM.md"), "PROJECT_APPEND_MARKER");
  for (const [base, name] of [[join(root(), "agent"), "global-fixture"], [join(project(), ".pi"), "project-fixture"]]) {
    await fixture(join(base!, "skills", name!, "SKILL.md"), `---\nname: ${name}\ndescription: Read the ${name} acceptance fixture\n---\n${name}-BODY-MARKER\nSee references/notes.md.\n`);
  }
}

test.afterEach(async () => {
  for (const path of [join(root(), "AGENTS.md"), join(project(), "AGENTS.md"), join(project(), ".pi"), join(root(), "agent", "AGENTS.md"), join(root(), "agent", "APPEND_SYSTEM.md"), join(root(), "agent", "skills"), join(root(), "agent", "trust.json")]) await rm(path, { recursive: true, force: true });
});

for (const durable of [false, true]) {
  test(`AC-P107 global/ancestor/project context and append precedence (${durable ? "Durable" : "legacy"})`, async ({ page }) => {
    await resources();
    await mock.script({ turns: ["Resources loaded."] });
    const id = await createChat(page, durable);
    await answer(page, id, "Inspect fixture resources", "Resources loaded.");
    const body = (await mock.journal({ kind: "chat" }))[0]!.body as { system: unknown };
    const system = JSON.stringify(body.system);
    expect(system.match(/GLOBAL_AGENT_MARKER/g) ?? []).toHaveLength(1);
    expect(system.match(/ANCESTOR_AGENT_MARKER/g) ?? []).toHaveLength(1);
    expect(system.match(/PROJECT_AGENT_MARKER/g) ?? []).toHaveLength(1);
    expect(system.indexOf("GLOBAL_AGENT_MARKER")).toBeLessThan(system.indexOf("ANCESTOR_AGENT_MARKER"));
    expect(system.indexOf("ANCESTOR_AGENT_MARKER")).toBeLessThan(system.indexOf("PROJECT_AGENT_MARKER"));
    expect(system).toContain("PROJECT_APPEND_MARKER");
    expect(system).not.toContain("GLOBAL_APPEND_MARKER");
  });
}

test("AC-P108 installed Workbench, global gh-stack and package skill catalogs load", async ({ page }) => {
  const host = process.env["DURABLE_FLEET_REAL_HOST"] ?? process.env["PI_WEB_E2E_DURABLE_HOST"]!;
  const workbench = resolve(dirname(host), "../../..");
  await settings({ skills: [join(workbench, "skills"), "/Users/tschuehly/.pi/agent/skills/gh-stack", "/Users/tschuehly/.pi/agent/npm/node_modules/pi-process-monitor/skills"] });
  try {
    await mock.script({ turns: ["Catalog inspected."] });
    const id = await createChat(page);
    await answer(page, id, "inspect installed skill catalog", "Catalog inspected.");
    const body = JSON.stringify((await mock.journal({ kind: "chat" }))[0]!.body);
    for (const name of ["analyze-source-for-workbench", "atelier", "customize-pi-web-presentation", "define-goal", "model-orchestration", "orient", "workstreams", "gh-stack", "monitor"]) expect(body).toContain(`<name>${name}</name>`);
    // The eighth Workbench skill explicitly sets disable-model-invocation, so it is not model guidance.
    expect(body).not.toContain("<name>autonomous-grill</name>");
  } finally { await settings({ skills: [] }); }
});

for (const durable of [false, true]) test(`AC-P108 P056 skill catalog and leading/inline expansion (${durable ? "Durable" : "legacy"})`, async ({ page }) => {
  await resources();
    await mock.script({ turns: ["Skill expanded."] });
    const id = await createChat(page, durable);
    await answer(page, id, "/skill:project-fixture use /skill:global-fixture and /skill:global-fixture plus /skill:unknown", "Skill expanded.");
    const body = JSON.stringify((await mock.journal({ kind: "chat" })).at(-1)!.body);
    expect(body).toContain("project-fixture-BODY-MARKER");
    expect(body.match(/global-fixture-BODY-MARKER/g) ?? []).toHaveLength(1);
    expect(body).toContain("References are relative to");
    expect(body).toContain("/skill:unknown");
    expect(body).toContain("<available_skills>");
});

for (const trust of [{ name: "saved denial wins", saved: false, fallback: "always", trusted: false }, { name: "saved trust wins", saved: true, fallback: "never", trusted: true }, { name: "ask is untrusted", saved: null, fallback: "ask", trusted: false }]) {
  test(`AC-P109 ${trust.name}; project append cannot bypass trust`, async ({ page }) => {
    await resources();
    await fixture(join(root(), "agent", "trust.json"), JSON.stringify({ [project()]: trust.saved }));
    await settings({ defaultProjectTrust: trust.fallback });
    await mock.script({ turns: ["Trust checked."] });
    const id = await createChat(page);
    await answer(page, id, "Check trusted resource context", "Trust checked.");
    const system = JSON.stringify(((await mock.journal({ kind: "chat" }))[0]!.body as { system: unknown }).system);
    expect(system.includes("PROJECT_APPEND_MARKER")).toBe(trust.trusted);
    expect(system.includes("GLOBAL_APPEND_MARKER")).toBe(!trust.trusted);
    expect(system.includes("<name>project-fixture</name>")).toBe(trust.trusted);
  });
}
