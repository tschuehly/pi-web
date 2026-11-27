// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { enhanceDiffBlocks, parseWordDiff, wordDiffLayout } from "./diffViews";
import { toSafeMarkdownHtml } from "./markdown";

function enhanced(markdown: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = toSafeMarkdownHtml(markdown);
  enhanceDiffBlocks(root);
  return root;
}

describe("worddiff layout", () => {
  it("shows word edits inline, even across several lines", () => {
    expect(wordDiffLayout("Ship on Friday.", "Ship on Monday.")).toBe("inline");
    expect(wordDiffLayout("The cache keeps ten entries.\nIt expires hourly.", "The cache keeps twenty entries.\nIt expires daily.")).toBe("inline");
  });

  it("shows mostly rewritten lines side by side", () => {
    expect(wordDiffLayout("Run the job nightly.\nEmail the owner.", "Trigger builds on every push.\nPost results to Slack.")).toBe("split");
  });

  it("needs a line holding only >>>", () => {
    expect(parseWordDiff("old\n>>>\nnew\n")).toEqual({ before: "old", after: "new" });
    expect(parseWordDiff("old >>> new")).toBeUndefined();
  });
});

describe("enhanceDiffBlocks", () => {
  it("colours diff fence lines like the edit tool's diff", () => {
    const root = enhanced("```diff\n@@ -1 +1 @@\n-old\n+new\n same\n```");
    const lines = [...root.querySelectorAll("pre.diff code span")].map((span) => [span.className, span.textContent]);
    expect(lines).toEqual([
      ["hunk", "@@ -1 +1 @@\n"],
      ["removed", "-old\n"],
      ["added", "+new\n"],
      ["context", " same\n"],
    ]);
  });

  it("renders a worddiff with struck removals and added words, in the chosen layout", () => {
    const inline = enhanced("```worddiff\nShip on Friday.\n>>>\nShip on Monday.\n```");
    expect(inline.querySelector("pre, .code-copy-button")).toBeNull();
    expect(inline.querySelector(".worddiff.inline del")?.textContent).toBe("Friday");
    expect(inline.querySelector(".worddiff.inline ins")?.textContent).toBe("Monday");

    const split = enhanced("```worddiff\nRun the job nightly.\nEmail the owner.\n>>>\nTrigger builds on every push.\nPost results to Slack.\n```");
    expect(split.querySelector(".worddiff-old")?.textContent).toBe("Run the job nightly.\nEmail the owner.");
    expect(split.querySelector(".worddiff-new")?.textContent).toBe("Trigger builds on every push.\nPost results to Slack.");
  });

  it("leaves a worddiff without >>> as a plain code block", () => {
    const root = enhanced("```worddiff\nold and new\n```");
    expect(root.querySelector("pre > code.language-worddiff")?.textContent).toBe("old and new\n");
    expect(root.querySelector(".worddiff")).toBeNull();
  });
});
