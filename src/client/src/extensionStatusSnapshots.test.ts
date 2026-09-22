import { describe, expect, it } from "vitest";
import { GOAL_STATUS_STATE_VALUES, isTerminalDelegate, parseDelegateActivitySnapshot, parseGoalStatusSnapshot, parseLegacyGoalStatus, parseWorkingModeSnapshot } from "./extensionStatusSnapshots";

describe("extension status snapshots", () => {
  it("accepts the exact bounded Goal schema and every state", () => {
    for (const state of GOAL_STATUS_STATE_VALUES) {
      expect(parseGoalStatusSnapshot(JSON.stringify({ schemaVersion: 1, goalId: "🚀".repeat(128), state, objective: "界".repeat(240) }))).toEqual({
        schemaVersion: 1, goalId: "🚀".repeat(128), state, objective: "界".repeat(240),
      });
    }
  });

  it("trims bounded fields and ignores additive schema-version-1 fields", () => {
    expect(parseGoalStatusSnapshot(JSON.stringify({
      schemaVersion: 1, goalId: "  goal-1  ", state: "active", objective: "  Ship the Goal chip  ", future: { value: true },
    }))).toEqual({ schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship the Goal chip" });
  });

  it("keeps required types, states, version, and post-trim bounds strict", () => {
    const valid = { schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship the Goal chip" };
    for (const invalid of [
      { ...valid, schemaVersion: 2 },
      { ...valid, schemaVersion: "1" },
      { ...valid, state: "complete" },
      { ...valid, goalId: "" },
      { ...valid, goalId: 1 },
      { ...valid, goalId: " 🚀".repeat(129) },
      { ...valid, objective: "  " },
      { ...valid, objective: 1 },
      { ...valid, objective: ` ${"界".repeat(241)} ` },
      { schemaVersion: 1, goalId: "goal-1", state: "active" },
    ]) expect(parseGoalStatusSnapshot(JSON.stringify(invalid))).toBeUndefined();
    expect(parseGoalStatusSnapshot("not json")).toBeUndefined();
    expect(parseGoalStatusSnapshot(undefined)).toBeUndefined();
  });

  it.each([
    ["hidden tag payload", String.fromCodePoint(0xe0067, 0xe0062, 0xe007f)],
    ...[0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f]
      .map((codePoint) => [`U+${codePoint.toString(16).toUpperCase()}`, String.fromCodePoint(codePoint)]),
    ...[0x115f, 0x2800, 0x3164, 0xffa0]
      .map((codePoint) => [`blank U+${codePoint.toString(16).toUpperCase()}`, String.fromCodePoint(codePoint)]),
  ])("rejects invisible spoof %s in identifiers and strips it from display text", (_name, spoof) => {
    const valid = { schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship safely" };
    expect(parseGoalStatusSnapshot(JSON.stringify({ ...valid, goalId: `goal${spoof}-1` }))).toBeUndefined();
    expect(parseGoalStatusSnapshot(JSON.stringify({ ...valid, objective: `Ship${spoof} safely` }))).toEqual(valid);
    expect(parseLegacyGoalStatus(`Goal${spoof} active`)).toBe("Goal active");
  });

  it("keeps blank and tag-only spoof payloads from becoming visible Goal text", () => {
    const valid = { schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship safely" };
    for (const spoof of ["\u3164", String.fromCodePoint(0xe0067, 0xe0062, 0xe007f)]) {
      expect(parseGoalStatusSnapshot(JSON.stringify({ ...valid, objective: spoof }))).toBeUndefined();
      expect(parseLegacyGoalStatus(spoof)).toBeUndefined();
    }
  });

  it("retains emoji ZWJ sequences and CJK text", () => {
    const valid = { schemaVersion: 1, goalId: "目標-1", state: "active", objective: "Ship 👩‍💻 safely 界" };
    expect(parseGoalStatusSnapshot(JSON.stringify(valid))).toEqual(valid);
    expect(parseLegacyGoalStatus("目標 👩‍💻 継続中")).toBe("目標 👩‍💻 継続中");
  });

  it("rejects identifier controls and normalizes objective controls", () => {
    const valid = { schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship safely" };
    expect(parseGoalStatusSnapshot(JSON.stringify({ ...valid, goalId: "goal\u0000-1" }))).toBeUndefined();
    expect(parseGoalStatusSnapshot(JSON.stringify({ ...valid, objective: " Ship\n\t safely\u0000 " }))).toEqual({
      schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship safely",
    });
  });

  it("accepts legal escaped Unicode while rejecting raw input above 8 KiB before parsing", () => {
    const valid = JSON.stringify({ schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship" });
    expect(parseGoalStatusSnapshot(valid.padStart(8_192, " "))).toEqual({ schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship" });
    expect(parseGoalStatusSnapshot(valid.padStart(8_193, " "))).toBeUndefined();

    const escapedUnicode = JSON.stringify({ schemaVersion: 1, goalId: "🚀".repeat(128), state: "active", objective: "🚀".repeat(240) })
      .replaceAll("🚀", "\\ud83d\\ude80");
    expect(new TextEncoder().encode(escapedUnicode).byteLength).toBeGreaterThan(4_096);
    expect(parseGoalStatusSnapshot(escapedUnicode)).toEqual({
      schemaVersion: 1, goalId: "🚀".repeat(128), state: "active", objective: "🚀".repeat(240),
    });
  });

  it("accepts only bounded opaque non-JSON legacy status", () => {
    expect(parseLegacyGoalStatus("  Goal 123 active\nwaiting for owner  ")).toBe("Goal 123 active waiting for owner");
    expect(parseLegacyGoalStatus("Goal\u0000 active")).toBe("Goal active");
    expect(parseLegacyGoalStatus(JSON.stringify({ schemaVersion: 2 }))).toBeUndefined();
    expect(parseLegacyGoalStatus("x".repeat(241))).toBeUndefined();
    expect(parseLegacyGoalStatus(" ")).toBeUndefined();
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
