import { describe, expect, it } from "vitest";
import { GOAL_STATUS_STATE_VALUES, isTerminalDelegate, parseDelegateActivitySnapshot, parseGoalStatusSnapshot, parseWorkingModeSnapshot } from "./extensionStatusSnapshots";

describe("extension status snapshots", () => {
  it("accepts the exact bounded Goal schema and every state", () => {
    for (const state of GOAL_STATUS_STATE_VALUES) {
      expect(parseGoalStatusSnapshot(JSON.stringify({ schemaVersion: 1, goalId: "🚀".repeat(128), state, objective: "界".repeat(240) }))).toEqual({
        schemaVersion: 1, goalId: "🚀".repeat(128), state, objective: "界".repeat(240),
      });
    }
  });

  it("rejects malformed, untrimmed, unknown, and oversized Goal snapshots", () => {
    const valid = { schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship the Goal chip" };
    for (const invalid of [
      { ...valid, schemaVersion: 2 },
      { ...valid, state: "complete" },
      { ...valid, goalId: "" },
      { ...valid, goalId: " goal-1" },
      { ...valid, goalId: "🚀".repeat(129) },
      { ...valid, objective: "" },
      { ...valid, objective: "Ship " },
      { ...valid, objective: "界".repeat(241) },
      { schemaVersion: 1, goalId: "goal-1", state: "active" },
      { ...valid, extra: true },
    ]) expect(parseGoalStatusSnapshot(JSON.stringify(invalid))).toBeUndefined();
    expect(parseGoalStatusSnapshot("not json")).toBeUndefined();
    expect(parseGoalStatusSnapshot(undefined)).toBeUndefined();
  });

  it("rejects raw Goal status input above 2,048 UTF-8 bytes before parsing", () => {
    const valid = JSON.stringify({ schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship" });
    expect(parseGoalStatusSnapshot(valid.padStart(2_048, " "))).toEqual({ schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship" });
    expect(parseGoalStatusSnapshot(valid.padStart(2_049, " "))).toBeUndefined();

    const escapedUnicode = JSON.stringify({ schemaVersion: 1, goalId: "🚀".repeat(128), state: "active", objective: "🚀".repeat(240) })
      .replaceAll("🚀", "\\ud83d\\ude80");
    expect(new TextEncoder().encode(escapedUnicode).byteLength).toBeGreaterThan(2_048);
    expect(parseGoalStatusSnapshot(escapedUnicode)).toBeUndefined();
  });

  it("parses versioned Working Mode selected and applied state", () => {
    expect(parseWorkingModeSnapshot(JSON.stringify({
      schemaVersion: 1, phase: "selected",
      selected: { alignment: "Plan", checking: "tests" },
      applied: { alignment: "Align", checking: "light" },
    }))).toEqual({
      schemaVersion: 1, phase: "selected",
      selected: { alignment: "Plan", checking: "tests" },
      applied: { alignment: "Align", checking: "light" },
    });
    expect(parseWorkingModeSnapshot("not json")).toBeUndefined();
    expect(parseWorkingModeSnapshot(JSON.stringify({ schemaVersion: 2 }))).toBeUndefined();
  });

  it("accepts only bounded worker and subagent roster snapshots", () => {
    const items = parseDelegateActivitySnapshot(JSON.stringify({ schemaVersion: 1, items: [
      { id: "delegate:1", kind: "worker", name: "UI", role: "implementation", model: "openai-codex/gpt-5.6-sol", effort: "medium", objective: "Build controls", activity: "running tests" },
      { id: "delegate:2", kind: "subagent", role: "review", objective: "Review", activity: "success" },
    ] }));
    expect(items).toHaveLength(2);
    const running = items[0];
    const terminal = items[1];
    if (running === undefined || terminal === undefined) throw new Error("Expected parsed roster items");
    expect(running).toMatchObject({ model: "openai-codex/gpt-5.6-sol", effort: "medium" });
    expect(isTerminalDelegate(running)).toBe(false);
    expect(isTerminalDelegate(terminal)).toBe(true);
    expect(parseDelegateActivitySnapshot(JSON.stringify({ schemaVersion: 1, items: [{ id: "shell", kind: "shell" }] }))).toEqual([]);
  });
});
