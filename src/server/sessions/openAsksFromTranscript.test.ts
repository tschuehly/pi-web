import { describe, expect, it } from "vitest";
import { ASK_USER_ANSWERS_CUSTOM_TYPE } from "../../shared/apiTypes.js";
import { openAsksFromTranscript } from "./openAsksFromTranscript.js";
import { ASK_USER_CLOSED_CUSTOM_TYPE, PendingAskStore } from "./pendingAskStore.js";

const SESSION = "session-1";
const questions = [{ id: "db", question: "Which database?", options: [] }];

function ask(askId: string, revision = "r1") {
  return { askId, askedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", revision, turnsSinceUpdate: 0, context: "Why", questions };
}

const user = { type: "message", message: { role: "user", content: "hi" } };
const assistant = { type: "message", message: { role: "assistant", content: [] } };
const posted = (details: Record<string, unknown>, isError = false) => ({ type: "message", message: { role: "toolResult", toolName: "ask_user", details: { sessionId: SESSION, ...details }, isError } });
const answers = (askId: string) => ({ type: "custom_message", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, details: { askId } });
const closedRecord = (askId: string) => ({ type: "custom", customType: ASK_USER_CLOSED_CUSTOM_TYPE, data: { askId, reason: "submitted", questions: [] } });

describe("openAsksFromTranscript", () => {
  it("rebuilds every posted ask at its latest revision and counts the agent turns since", () => {
    const branch = [user, assistant, posted({ ask: ask("a1") }), assistant, posted({ ask: ask("a2") }), user, assistant, posted({ ask: { ...ask("a1", "r2"), context: "New" } }), assistant, assistant];

    expect(openAsksFromTranscript(branch, SESSION).open).toEqual([
      { ...ask("a1", "r2"), context: "New", turnsSinceUpdate: 2 },
      { ...ask("a2"), turnsSinceUpdate: 3 },
    ]);
  });

  it("does not resurrect answered, withdrawn, or failed asks", () => {
    const branch = [
      posted({ ask: ask("answered") }), answers("answered"),
      posted({ ask: ask("withdrawn") }), posted({ withdrawn: { askId: "withdrawn" } }),
      posted({ ask: ask("failed") }, true),
    ];

    expect(openAsksFromTranscript(branch, SESSION)).toEqual({ open: [], undelivered: [] });
  });

  it("treats a recorded close as closure, and as undelivered until its answers message follows", () => {
    const queued = [posted({ ask: ask("a1") }), closedRecord("a1"), assistant];

    expect(openAsksFromTranscript(queued, SESSION)).toEqual({ open: [], undelivered: [{ askId: "a1", reason: "submitted", questions: [] }] });
    expect(openAsksFromTranscript([...queued, answers("a1")], SESSION)).toEqual({ open: [], undelivered: [] });
  });

  it("rebuilds the questions left open after partial sends, at the revision they left, across a daemon restart", () => {
    let revision = 0;
    const live = new PendingAskStore({ createRevision: () => `r${(++revision).toString()}`, createAskId: () => "a1" });
    const three = ["db", "cache", "queue"].map((id) => ({ id, question: `Which ${id}?`, options: [] }));
    const opened = live.open({ sessionId: SESSION, context: "Why", questions: three });
    const branch: unknown[] = [posted({ ask: opened })];
    const send = (id: string, rev: string) => {
      const result = live.submit(SESSION, "a1", { revision: rev, answers: [{ id, values: [], otherText: "x" }], partial: true }, (outcome) => branch.push({ type: "custom", customType: ASK_USER_CLOSED_CUSTOM_TYPE, data: outcome }));
      if (result.status !== "closed") throw new Error("expected the answer to be sent");
      return result.outcome;
    };
    const first = send("db", "r1");
    branch.push({ type: "custom_message", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, details: first }, assistant);
    // The second answer's follow-up was still queued when the daemon stopped.
    const second = send("queue", "r2");

    const rebuilt = openAsksFromTranscript(branch, SESSION);
    expect(rebuilt.open).toEqual([{ ...opened, revision: "r3", questions: [three[1]], turnsSinceUpdate: 1 }]);
    expect(rebuilt.undelivered).toEqual([second]);

    const restarted = new PendingAskStore({ createRevision: () => "r4" });
    restarted.restore(SESSION, rebuilt.open);
    expect(restarted.submit(SESSION, "a1", { revision: "r2", answers: [{ id: "cache", values: [], otherText: "y" }], partial: true })).toEqual({ status: "stale" });
    expect(restarted.submit(SESSION, "a1", { revision: "r3", answers: [{ id: "cache", values: [], otherText: "y" }], partial: true }).status).toBe("closed");
    expect(restarted.pendingAsks(SESSION)).toEqual([]);

    branch.push({ type: "custom_message", customType: ASK_USER_ANSWERS_CUSTOM_TYPE, details: second });
    expect(openAsksFromTranscript(branch, SESSION).undelivered).toEqual([]);
  });

  it("restores only asks the session itself posted, so a fork does not inherit its parent's", () => {
    const branch = [posted({ ask: ask("parent") }), closedRecord("parent")];

    expect(openAsksFromTranscript(branch, "forked-session")).toEqual({ open: [], undelivered: [] });
  });
});
