import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandInlineSkillMentions, type InlineSkill } from "./inlineSkills.js";

let dir: string;
let skills: InlineSkill[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inline-skills-"));
  skills = [];
  for (const name of ["review", "deploy"]) {
    const filePath = join(dir, name, "SKILL.md");
    await mkdir(join(dir, name));
    await writeFile(filePath, `---\nname: ${name}\ndescription: d\n---\n\n${name} body\n`);
    skills.push({ name, filePath, baseDir: join(dir, name) });
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function block(name: string): string {
  return `<skill name="${name}" location="${join(dir, name, "SKILL.md")}">\nReferences are relative to ${join(dir, name)}.\n\n${name} body\n</skill>`;
}

describe("expandInlineSkillMentions", () => {
  it("expands a mid-text mention inline, keeping trailing punctuation", () => {
    expect(expandInlineSkillMentions("please use /skill:review, then stop", skills)).toBe(`please use ${block("review")}, then stop`);
  });

  it("expands two different skills, each at most once", () => {
    expect(expandInlineSkillMentions("a /skill:review b\n/skill:deploy c /skill:review", skills))
      .toBe(`a ${block("review")} b\n${block("deploy")} c /skill:review`);
  });

  it("keeps mentions in code spans, fences, unknown names, and non-boundaries literal", () => {
    for (const text of ["run `/skill:review` now", "x\n```\n/skill:review\n```", "use /skill:nope", "see src/skill:review"]) {
      expect(expandInlineSkillMentions(text, skills)).toBe(text);
    }
  });

  it("leaves a leading mention for Pi core and does not repeat it inline", () => {
    expect(expandInlineSkillMentions("/skill:review with /skill:deploy and /skill:review", skills))
      .toBe(`/skill:review with ${block("deploy")} and /skill:review`);
  });

  it("expands a leading mention Pi core rejects because no space or end follows it", () => {
    expect(expandInlineSkillMentions("/skill:review\nthen /skill:review", skills)).toBe(`${block("review")}\nthen /skill:review`);
    expect(expandInlineSkillMentions("/skill:review, then go", skills)).toBe(`${block("review")}, then go`);
  });

  it("keeps mentions in indented code blocks literal but expands indented paragraph continuations", () => {
    for (const text of ["    /skill:review", "x\n\n    run /skill:review\n\n\tthen /skill:deploy"]) {
      expect(expandInlineSkillMentions(text, skills)).toBe(text);
    }
    expect(expandInlineSkillMentions("x\n    /skill:review", skills)).toBe(`x\n    ${block("review")}`);
  });
});
