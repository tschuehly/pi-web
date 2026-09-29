import { describe, expect, it } from "vitest";
import { GOAL_STATUS_STATE_VALUES, isTerminalDelegate, parseBackgroundBashStatusSnapshot, parseDelegateActivitySnapshot, parseGoalStatusSnapshot, parseLegacyGoalStatus, parseWatcherStatusSnapshot, parseWorkingModeSnapshot, visibleShellExecutions, workingModePending, type WorkingModeState } from "./extensionStatusSnapshots";

describe("extension status snapshots", () => {
  it("accepts only bounded active background bash status", () => {
    const parse = (jobs: unknown[]) => parseBackgroundBashStatusSnapshot(JSON.stringify({ schemaVersion: 1, jobs }));
    expect(parse([{ id: "job-1", elapsedSeconds: 42, bytes: 1024, command: "TOKEN=secret" }])).toEqual([
      { id: "job-1", elapsedSeconds: 42, bytes: 1024 },
    ]);
    expect(parse([{ id: "job-1", command: "test", elapsedSeconds: -1, bytes: 0 }])).toEqual([]);
    expect(parse([{ id: "job-1", command: "test", elapsedSeconds: 1, bytes: 0 }, { id: "job-1", command: "test", elapsedSeconds: 1, bytes: 0 }])).toEqual([]);
    expect(parse(Array.from({ length: 9 }, (_, index) => ({ id: `job-${String(index)}`, command: "test", elapsedSeconds: 0, bytes: 0 })))).toEqual([]);
  });
  it("accepts the exact bounded Goal schema and every state", () => {
    for (const state of GOAL_STATUS_STATE_VALUES) {
      expect(parseGoalStatusSnapshot(JSON.stringify({ schemaVersion: 1, goalId: "🚀".repeat(128), state, objective: "界".repeat(240) }))).toEqual({
        schemaVersion: 1, goalId: "🚀".repeat(128), state, objective: "界".repeat(240),
      });
    }
  });

  it("normalizes display text and ignores additive schema-version-1 fields without rewriting IDs", () => {
    expect(parseGoalStatusSnapshot(JSON.stringify({
      schemaVersion: 1, goalId: "goal-1", state: "active", objective: "  Ship the Goal chip  ", future: { value: true },
    }))).toEqual({ schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship the Goal chip" });
  });

  it("keeps required types, states, version, and post-trim bounds strict", () => {
    const valid = { schemaVersion: 1, goalId: "goal-1", state: "active", objective: "Ship the Goal chip" };
    for (const invalid of [
      { ...valid, schemaVersion: 2 },
      { ...valid, schemaVersion: "1" },
      { ...valid, state: "complete" },
      { ...valid, goalId: "" },
      { ...valid, goalId: " goal-1" },
      { ...valid, goalId: "goal-1 " },
      { ...valid, goalId: "goal\u200d-1" },
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
    const selected = { alignment: "Plan", attention: "Phone", checking: "Test", orchestration: "Workers" };
    const applied = { alignment: "Align", attention: "Default", checking: "Exercise", orchestration: "Main" };
    expect(parseWorkingModeSnapshot(JSON.stringify({ schemaVersion: 2, phase: "selected", selected: { ...selected, extra: 1 }, applied }))).toEqual({
      schemaVersion: 2, phase: "selected", selected, applied,
    });
    expect(parseWorkingModeSnapshot("not json")).toBeUndefined();
    expect(parseWorkingModeSnapshot(JSON.stringify({ schemaVersion: 1, phase: "selected", selected: { alignment: "Plan", checking: "tests" }, applied: null }))).toBeUndefined();
    expect(parseWorkingModeSnapshot(JSON.stringify({ schemaVersion: 2, phase: "selected", selected: { ...selected, attention: "Away" }, applied: null }))).toBeUndefined();
  });

  it("treats a selection as pending until applied, using the transcript block and then the defaults before the first turn", () => {
    const defaults: WorkingModeState = { alignment: "Default", attention: "Default", checking: "Default", orchestration: "Main" };
    const focused: WorkingModeState = { ...defaults, attention: "Focused" };
    const snapshot = (selected: WorkingModeState, applied: WorkingModeState | null) => ({ schemaVersion: 2 as const, phase: "selected" as const, selected, applied });
    expect(workingModePending(snapshot(focused, focused), defaults)).toBe(false);
    expect(workingModePending(snapshot(focused, defaults), focused)).toBe(true);
    expect(workingModePending(snapshot(focused, null), focused)).toBe(false);
    expect(workingModePending(snapshot(defaults, null), focused)).toBe(true);
    expect(workingModePending(snapshot(defaults, null), undefined)).toBe(false);
    expect(workingModePending(snapshot(focused, null), undefined)).toBe(true);
  });

  it("accepts bounded source-owned watcher rows and rejects malformed snapshots atomically", () => {
    const watcher = { logicalId: "logical-1", handleId: "abc123", label: "Build", mode: "poll", scope: "gh run view 123", state: "retrying", consecutiveFailures: 2, startedAt: "2026-08-02T10:00:00.000Z" };
    const parse = (watchers: unknown[], schemaVersion = 1) => parseWatcherStatusSnapshot(JSON.stringify({ schemaVersion, watchers }));
    expect(parse([watcher])).toEqual([{ logicalId: "logical-1", handleId: "abc123", label: "Build", mode: "poll", scope: "gh run view 123", state: "retrying", consecutiveFailures: 2 }]);
    expect(parse([{ ...watcher, scope: "界\u200b\u202e\u0000 👩‍💻  ready\n" }, { ...watcher, logicalId: "other" }])).toEqual([
      { logicalId: "logical-1", handleId: "abc123", label: "Build", mode: "poll", scope: "界 👩💻 ready", state: "retrying", consecutiveFailures: 2 },
      { logicalId: "other", handleId: "abc123", label: "Build", mode: "poll", scope: "gh run view 123", state: "retrying", consecutiveFailures: 2 },
    ]);
    expect(parse([{ ...watcher, scope: "\u200b\u0000" }, { ...watcher, logicalId: "other" }])).toMatchObject([
      { logicalId: "logical-1", scope: "" }, { logicalId: "other", scope: "gh run view 123" },
    ]);
    expect(parse([{ ...watcher, label: "界\u200b\u00ad\u0000 ready\n<script>text</script>" }, { ...watcher, logicalId: "other" }])).toMatchObject([
      { logicalId: "logical-1", label: "界 ready <script>text</script>" }, { logicalId: "other", label: "Build" },
    ]);
    expect(parse([{ ...watcher, label: "\u200b\u00ad\u0000" }, { ...watcher, logicalId: "other" }])).toMatchObject([
      { logicalId: "logical-1" }, { logicalId: "other", label: "Build" },
    ]);
    expect(parse([{ ...watcher, label: "\u200b\u00ad\u0000" }])[0]).not.toHaveProperty("label");
    expect(parse([{ ...watcher, label: undefined, mode: "file", scope: "", state: "quarantined" }])[0]).not.toHaveProperty("label");
    expect(parse([{ ...watcher, mode: "spawn", state: "watching" }])).toHaveLength(1);
    for (const invalid of [
      { ...watcher, logicalId: "" }, { ...watcher, logicalId: "bad\u202eid" },
      { ...watcher, handleId: "bad\nhandle" }, { ...watcher, handleId: "x".repeat(65) },
      { ...watcher, label: "x".repeat(49) }, { ...watcher, scope: "x".repeat(241) },
      { ...watcher, scope: undefined }, { ...watcher, scope: 123 },
      { ...watcher, mode: "process" }, { ...watcher, state: "stopped" },
      { ...watcher, consecutiveFailures: -1 }, { ...watcher, consecutiveFailures: 1.5 },
      { ...watcher, startedAt: "eventually" }, { ...watcher, startedAt: undefined },
    ]) expect(parse([watcher, invalid])).toEqual([]);
    expect(parse([watcher, watcher])).toEqual([]);
    expect(parse(Array.from({ length: 65 }, (_, index) => ({ ...watcher, logicalId: String(index) })))).toEqual([]);
    expect(parse([watcher], 2)).toEqual([]);
    expect(parseWatcherStatusSnapshot(" ".repeat(65_537))).toEqual([]);
    expect(parseWatcherStatusSnapshot(undefined)).toEqual([]);
    expect(parseWatcherStatusSnapshot("not json")).toEqual([]);
  });

  it("accepts only bounded generic built-in shell rows, including older optional timestamps", () => {
    const shell = { id: "tool:one", kind: "shell", toolName: "bash", label: "Shell command", startedAt: "2026-08-02T10:00:00Z" };
    expect(visibleShellExecutions([shell, { id: "shell:two", kind: "shell", toolName: "shell", label: "Interactive shell" }])).toHaveLength(2);
    expect(visibleShellExecutions([shell, { id: "future", kind: "future", toolName: "custom", label: "Future tool" }, { ...shell, id: "unknown", label: "Future shell" }])).toEqual([shell]);
    for (const invalid of [
      { ...shell, id: "bad\u0000id" },
      { ...shell, startedAt: "eventually" }, { ...shell, startedAt: "x".repeat(65) },
    ]) expect(visibleShellExecutions([shell, invalid])).toEqual([]);
    expect(visibleShellExecutions([shell, shell])).toEqual([]);
    expect(visibleShellExecutions(Array.from({ length: 33 }, (_, index) => ({ ...shell, id: String(index) })))).toEqual([]);
    expect(visibleShellExecutions(undefined)).toEqual([]);
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
    expect(parseDelegateActivitySnapshot(JSON.stringify({ schemaVersion: 1, items: [{ id: "one", kind: "worker" }, { id: "one", kind: "worker" }] }))).toEqual([]);
  });
});
