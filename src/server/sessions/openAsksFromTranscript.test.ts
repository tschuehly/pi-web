import { describe, expect, it } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE } from "../../shared/apiTypes.js";
import { openAsksFromTranscript } from "./openAsksFromTranscript.js";

const questions = [{ id: "db", question: "Which database?", options: [] }];

function ask(askId: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return { askId, askedAt: "2026-01-01T00:00:00.000Z", updatedAt, turnsSinceUpdate: 0, context: "Why", questions };
}

/** Entries chained parent → child in order, like one linear Pi branch. */
function chain(...entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return entries.map((entry, index) => ({ id: `e${index.toString()}`, parentId: index === 0 ? null : `e${(index - 1).toString()}`, ...entry }));
}

const user = { type: "message", message: { role: "user", content: "hi" } };
const toolResult = (details: unknown, isError = false) => ({ type: "message", message: { role: "toolResult", toolName: "ask_user", details, isError } });
const answers = (askId: string) => ({ type: "custom_message", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, details: { askId } });

describe("openAsksFromTranscript", () => {
  it("rebuilds every posted ask with its latest revision and counts later user turns", () => {
    const branch = chain(user, toolResult({ ask: ask("a1") }), toolResult({ ask: ask("a2") }), user, toolResult({ ask: { ...ask("a1", "2026-01-02T00:00:00.000Z"), context: "New" } }), user);

    expect(openAsksFromTranscript(branch, branch)).toEqual([
      { ...ask("a1", "2026-01-02T00:00:00.000Z"), context: "New", turnsSinceUpdate: 1 },
      { ...ask("a2"), turnsSinceUpdate: 2 },
    ]);
  });

  it("does not resurrect answered, withdrawn, superseded, or failed asks", () => {
    const branch = chain(
      toolResult({ ask: ask("answered") }), answers("answered"),
      toolResult({ ask: ask("withdrawn") }), toolResult({ withdrawn: { askId: "withdrawn" } }),
      toolResult({ ask: ask("old") }), toolResult({ ask: ask("new"), superseded: { askId: "old" } }),
      toolResult({ ask: ask("failed") }, true),
    );

    expect(openAsksFromTranscript(branch, branch).map((open) => open.askId)).toEqual(["new"]);
  });

  it("does not resurrect asks a tree rewind closed, detected by the branch it left behind", () => {
    const branch = chain(toolResult({ ask: ask("before") }), user, toolResult({ ask: ask("rewound") }), user, user);
    // The user rewound to e3 after a reply had been appended to it, then continued on e4.
    const abandoned = { id: "x1", parentId: "e3", type: "message", message: { role: "assistant", content: [] } };

    expect(openAsksFromTranscript(branch, [...branch, abandoned])).toEqual([]);
    const earlierFork = { id: "x0", parentId: null, type: "message", message: user.message };
    expect(openAsksFromTranscript(branch, [...branch, earlierFork]).map((open) => open.askId)).toEqual(["before", "rewound"]);
  });

  it("reads legacy ask details without updatedAt", () => {
    const legacy = { askId: "old", askedAt: "2025-12-31T00:00:00.000Z", questions };
    expect(openAsksFromTranscript(chain(toolResult({ ask: legacy })), [])).toEqual([{ ...legacy, updatedAt: legacy.askedAt, turnsSinceUpdate: 0 }]);
  });
});
