import { describe, expect, it } from "vitest";
import { detectPromptCompletionTrigger } from "./promptCompletions";

describe("detectPromptCompletionTrigger", () => {
  it("detects leading slash command queries and leaves @ and # as plain text", () => {
    expect(detectPromptCompletionTrigger("/model")).toEqual({ kind: "command", query: "model", from: 0, to: 6 });
    for (const draft of ["open @src/main", "open @ A FILE", "open !@A", "open @\"src", "#", "use #claude", "# Title"]) expect(detectPromptCompletionTrigger(draft)).toBeUndefined();
  });

  it("completes skill directives at whitespace boundaries throughout a prompt", () => {
    for (const draft of ["/skill:a /skill:rev", "/template task /skill:rev", "Please\t/skill:rev", "Please\n/skill:rev"]) {
      const from = draft.lastIndexOf("/skill:rev");
      expect(detectPromptCompletionTrigger(draft)).toEqual({ kind: "command", query: "skill:rev", from, to: draft.length });
    }
    // A bare mid-prompt slash is a skill-name query; the editor offers only skills there.
    expect(detectPromptCompletionTrigger("review /model")).toEqual({ kind: "command", query: "model", from: 7, to: 13 });
    expect(detectPromptCompletionTrigger("https://host/skill:rev")).toBeUndefined();
    expect(detectPromptCompletionTrigger("review src/skill:rev")).toBeUndefined();
    expect(detectPromptCompletionTrigger("review `/skill:rev")).toBeUndefined();
    expect(detectPromptCompletionTrigger("review /skill:rev/path")).toBeUndefined();
  });

  it("excludes one trailing prose mark from skill replacement, even when the cursor is on it", () => {
    for (const mark of [",", ".", "!", "?", ";", ":"]) {
      const draft = `/skill:other ask /skill:Re_V${mark} later`;
      const from = draft.indexOf("/skill:Re_V");
      const expected = { kind: "command", query: "skill:Re_V", from, to: from + 11 };
      expect(detectPromptCompletionTrigger(draft, from + 11)).toEqual(expected);
      expect(detectPromptCompletionTrigger(draft, from + 12)).toEqual(expected);
      expect(detectPromptCompletionTrigger(draft, from + 9)).toEqual({ ...expected, query: "skill:Re" });
    }
  });

  it("leaves literal examples alone across lines but accepts later real directives", () => {
    for (const example of [
      'say "/skill:rev"', "say '/skill:rev'", "say `/skill:rev`",
      "> /skill:rev", "```ts\n/skill:rev\n```", "~~~\n/skill:rev\n~~~", "x\n\n    /skill:rev",
    ]) {
      const inside = example.indexOf("/skill:rev");
      expect(detectPromptCompletionTrigger(example, inside + 10)).toBeUndefined();
      const draft = `${example}\nplease /skill:rev`;
      expect(detectPromptCompletionTrigger(draft)).toEqual({ kind: "command", query: "skill:rev", from: draft.lastIndexOf("/skill:rev"), to: draft.length });
    }
    expect(detectPromptCompletionTrigger("unmatched ' prose /skill:rev")).toEqual({ kind: "command", query: "skill:rev", from: 18, to: 28 });
    expect(detectPromptCompletionTrigger('unmatched " prose /skill:rev')).toEqual({ kind: "command", query: "skill:rev", from: 18, to: 28 });
  });

  it("keeps skill directives inside matched multi-backtick spans literal", () => {
    const draft = "say `` /skill:rev ` /skill:rev `` then /skill:rev";
    const first = draft.indexOf("/skill:rev");
    const second = draft.indexOf("/skill:rev", first + 1);
    expect(detectPromptCompletionTrigger(draft, first + 10)).toBeUndefined();
    expect(detectPromptCompletionTrigger(draft, second + 10)).toBeUndefined();
    expect(detectPromptCompletionTrigger(draft)).toEqual({ kind: "command", query: "skill:rev", from: draft.lastIndexOf("/skill:rev"), to: draft.length });
  });

  it("keeps inline-code state across lines and ignores mismatched runs and apparent fences", () => {
    const draft = "say ``\n/skill:rev\n` /skill:rev\n```\n/skill:rev\n``\nplease /skill:rev, later";
    let from = draft.indexOf("/skill:rev");
    for (let i = 0; i < 3; i++) {
      expect(detectPromptCompletionTrigger(draft, from + 10)).toBeUndefined();
      from = draft.indexOf("/skill:rev", from + 1);
    }
    expect(detectPromptCompletionTrigger(draft, from + 9)).toEqual({ kind: "command", query: "skill:re", from, to: from + 10 });
    expect(detectPromptCompletionTrigger(draft, from + 11)).toEqual({ kind: "command", query: "skill:rev", from, to: from + 10 });
  });

  it("does not treat escaped opening backticks as code spans", () => {
    const escaped = "say \\` /skill:rev";
    expect(detectPromptCompletionTrigger(escaped)).toEqual({ kind: "command", query: "skill:rev", from: escaped.indexOf("/skill:rev"), to: escaped.length });
    expect(detectPromptCompletionTrigger("say \\\\` /skill:rev")).toBeUndefined();
  });

  it("does not suggest malformed, ambiguous, URL or code-like tokens", () => {
    for (const draft of ["/skill:rev!!", "/skill:rev,more", "/skill:rev/path", "/skill:rev.ts", "/skill:rev=foo", "/skill:rev()",  "read https://host/skill:rev", "read src/skill:rev", "run `/skill:rev` now", "foo/skill:rev"]) {
      expect(detectPromptCompletionTrigger(draft)).toBeUndefined();
    }
    expect(detectPromptCompletionTrigger("/skill:rev!!", 10)).toBeUndefined();
    expect(detectPromptCompletionTrigger("/skill:Rev_Name", 15, new Set(["skill:Rev_Name"]))).toEqual({ kind: "command", query: "skill:Rev_Name", from: 0, to: 15 });
    expect(detectPromptCompletionTrigger("/skill:legacy.name", 18, new Set(["skill:legacy.name"]))).toEqual({ kind: "command", query: "skill:legacy.name", from: 0, to: 18 });
  });

  it("opens the skill picker for a bare slash after whitespace or at a later line start", () => {
    expect(detectPromptCompletionTrigger("please /")).toEqual({ kind: "command", query: "", from: 7, to: 8 });
    expect(detectPromptCompletionTrigger("please /rev")).toEqual({ kind: "command", query: "rev", from: 7, to: 11 });
    expect(detectPromptCompletionTrigger("first\n/re")).toEqual({ kind: "command", query: "re", from: 6, to: 9 });
    expect(detectPromptCompletionTrigger("ask /rev, later", 8)).toEqual({ kind: "command", query: "rev", from: 4, to: 8 });
    for (const draft of ["and/or", "see https://host/rev", "open /usr/bin", "run `/rev", "```\n/rev", "say \"/rev\" ok"]) {
      expect(detectPromptCompletionTrigger(draft)).toBeUndefined();
    }
  });

  it("replaces the entire active skill token even with the cursor in its middle", () => {
    expect(detectPromptCompletionTrigger("/skill:a /skill:rev later", 17)).toEqual({ kind: "command", query: "skill:r", from: 9, to: 19 });
    expect(detectPromptCompletionTrigger("/template later", 4)).toEqual({ kind: "command", query: "tem", from: 0, to: 9 });
  });
});
