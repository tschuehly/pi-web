import { describe, expect, it } from "vitest";
import { isTerminalDelegate, parseDelegateActivitySnapshot, parseWorkingModeSnapshot } from "./extensionStatusSnapshots";

describe("extension status snapshots", () => {
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
