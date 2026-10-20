import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createAskUserToolDefinition } from "./askUserTool.js";
import { PendingAskStore, PendingAskValidationError, type PendingAskOpenInput, type PendingAskUpdateInput } from "./pendingAskStore.js";
import { stubExtensionToolContext } from "./piSessionService.testSupport.js";

function ctxFor(sessionId: string): ExtensionToolContext {
  return stubExtensionToolContext({
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
    },
  });
}

function firstText(content: readonly (TextContent | ImageContent)[]): string {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

/** The tool over a real store, so the schema and the store's contract stay aligned. */
function toolOverStore(askIds: string[] = ["abc-1", "def-2"]) {
  const remaining = [...askIds];
  const store = new PendingAskStore({
    now: () => new Date("2026-02-01T10:00:00.000Z"),
    createAskId: () => remaining.shift() ?? "ask-exhausted",
  });
  const open = vi.fn((input: PendingAskOpenInput) => Promise.resolve(store.open(input)));
  const update = vi.fn((input: PendingAskUpdateInput) => Promise.resolve(store.update(input)));
  const withdraw = vi.fn((sessionId: string, askId: string) => Promise.resolve(store.withdraw(sessionId, askId)));
  return { store, open, update, tool: createAskUserToolDefinition({ open, update, withdraw }) };
}

const context = "**Finding:** the cache is stale. Postgres keeps one store; SQLite is lighter. I recommend Postgres.";
const twoQuestions = {
  context,
  questions: [
    { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres", recommended: true }, { value: "sqlite", label: "SQLite" }] },
    { id: "why", question: "Why?", options: [] },
  ],
};

describe("createAskUserToolDefinition", () => {
  it("advertises an asynchronous, self-contained question set without claiming to end the run", () => {
    const { tool } = toolOverStore();
    const advertised = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");

    expect(tool.name).toBe("ask_user");
    expect(tool.exposure).toBe("model-only");
    expect(advertised).toContain("returns immediately");
    expect(advertised).toContain("without reading the Chat");
    expect(advertised).toContain("at most five short lines");
    expect(advertised).toContain("consequence in `detail`");
    expect(advertised).toContain("update: <askId>");
    expect(advertised).toContain("withdraw: <askId>");
    expect(advertised).not.toMatch(/ends? (this|the) run|alone and last/);
  });

  it("makes every field optional in the schema so one tool can post, update, or withdraw", () => {
    const { tool } = toolOverStore();

    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        context: { type: "string", maxLength: 4000 },
        questions: { type: "array", minItems: 1, maxItems: 20 },
        update: { type: "string" },
        withdraw: { type: "string" },
      },
    });
    expect(tool.parameters).not.toHaveProperty("required");
    expect(tool.parameters).toHaveProperty("properties.questions.items.properties.options.items.properties.recommended.type", "boolean");
  });

  it("posts the set for the calling session and returns without terminating the run", async () => {
    const { open, tool } = toolOverStore();

    const result = await tool.execute("call-1", twoQuestions, undefined, undefined, ctxFor("session-1"));

    expect(open).toHaveBeenCalledWith({
      sessionId: "session-1",
      context,
      questions: [
        { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres", recommended: true }, { value: "sqlite", label: "SQLite" }] },
        { id: "why", question: "Why?", options: [] },
      ],
    });
    expect(result).not.toHaveProperty("terminate");
    // The posting session id lets a rebuild skip asks a fork copied from its parent.
    expect(result.details).toMatchObject({ ask: { askId: "abc-1", context, questions: [{ id: "db" }, { id: "why" }] }, sessionId: "session-1" });
    expect(firstText(result.content)).toContain("Posted 2 questions to the user as question chips above their composer, ask abc-1 (abc.db, abc.why). You are not paused");
  });

  it("keeps earlier sets open when another is posted", async () => {
    const { store, tool } = toolOverStore();
    await tool.execute("call-1", twoQuestions, undefined, undefined, ctxFor("session-1"));

    const result = await tool.execute("call-2", { context, questions: [{ id: "again", question: "Still there?" }] }, undefined, undefined, ctxFor("session-1"));

    expect(result.details).not.toHaveProperty("superseded");
    expect(store.pendingAsks("session-1").map((ask) => ask.askId)).toEqual(["abc-1", "def-2"]);
  });

  it("requires a self-contained context for a new set", async () => {
    const { tool } = toolOverStore();

    await expect(tool.execute("call-bare", { questions: twoQuestions.questions }, undefined, undefined, ctxFor("session-1")))
      .rejects.toThrow(/context is required/);
  });

  it("revises an open set in place, or confirms it when nothing else is sent", async () => {
    const { tool, update, store } = toolOverStore();
    await tool.execute("call-1", twoQuestions, undefined, undefined, ctxFor("session-1"));

    const revised = await tool.execute("call-2", { update: "abc-1", questions: [{ id: "db", question: "Which store now?" }] }, undefined, undefined, ctxFor("session-1"));
    const confirmed = await tool.execute("call-3", { update: "abc-1" }, undefined, undefined, ctxFor("session-1"));

    expect(update).toHaveBeenLastCalledWith({ sessionId: "session-1", askId: "abc-1", context: undefined, questions: undefined });
    expect(firstText(revised.content)).toContain("Updated open question set abc-1 (abc.db)");
    expect(confirmed.details).toMatchObject({ ask: { askId: "abc-1", context, questions: [{ question: "Which store now?" }] } });
    expect(store.pendingAsks("session-1")).toHaveLength(1);
    await expect(tool.execute("call-4", { update: "gone" }, undefined, undefined, ctxFor("session-1"))).rejects.toThrow(/No open question set gone/);
  });

  it("withdraws an open set, recording the outcome for the transcript", async () => {
    const { tool, store } = toolOverStore();
    await tool.execute("call-1", twoQuestions, undefined, undefined, ctxFor("session-1"));

    const result = await tool.execute("call-2", { withdraw: "abc-1" }, undefined, undefined, ctxFor("session-1"));

    expect(result.details).toMatchObject({ withdrawn: { askId: "abc-1", reason: "withdrawn", unansweredIds: ["db", "why"] } });
    expect(store.pendingAsks("session-1")).toEqual([]);
    await expect(tool.execute("call-3", { withdraw: "abc-1" }, undefined, undefined, ctxFor("session-1"))).rejects.toThrow(/No open question set abc-1/);
    await expect(tool.execute("call-4", { withdraw: "abc-1", context }, undefined, undefined, ctxFor("session-1"))).rejects.toThrow(/withdraw takes no other parameters/);
  });

  it("defaults a question without options to an empty option list so free text alone is expressible", async () => {
    const { open, tool } = toolOverStore();

    await tool.execute("call-free", { context, questions: [{ id: "note", question: "Anything else?" }] }, undefined, undefined, ctxFor("session-1"));

    expect(open).toHaveBeenCalledWith({ sessionId: "session-1", context, questions: [{ id: "note", question: "Anything else?", options: [] }] });
  });

  it("preserves detail, option detail, and multi-select", async () => {
    const { open, tool } = toolOverStore();
    const rich = {
      id: "targets",
      question: "Which targets?",
      detail: "Pick every platform we should build for.",
      options: [{ value: "web", label: "Web", detail: "Chromium and Firefox" }, { value: "cli", label: "CLI" }],
      multiple: true,
    };

    await tool.execute("call-rich", { context, questions: [rich] }, undefined, undefined, ctxFor("session-1"));

    expect(open).toHaveBeenCalledWith({ sessionId: "session-1", context, questions: [rich] });
  });

  it("propagates a rejected question set so the agent loop reports it to the model", async () => {
    const { tool } = toolOverStore();

    await expect(tool.execute("call-dup", {
      context,
      questions: [
        { id: "same", question: "First?", options: [{ value: "a", label: "A" }] },
        { id: "same", question: "Second?", options: [{ value: "b", label: "B" }] },
      ],
    }, undefined, undefined, ctxFor("session-1"))).rejects.toThrow(PendingAskValidationError);
  });
});
