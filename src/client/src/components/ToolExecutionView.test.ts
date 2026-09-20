import { describe, expect, it } from "vitest";
import type { ToolExecutionPart } from "./shared";
import { toolRowSummary } from "./ToolExecutionView";

describe("toolRowSummary", () => {
  it("shortens file paths to their last two segments", () => {
    expect(toolRowSummary(execution({
      toolName: "read",
      args: { path: "/Users/example/project/src/file.ts" },
      status: "success",
      resultText: "contents",
    }))).toEqual({ argument: "src/file.ts", result: "contents" });
  });

  it("keeps command and generic argument previews short and single-line", () => {
    const command = `printf first\nsecond ${"x".repeat(80)}`;
    const bashSummary = toolRowSummary(execution({ toolName: "bash", args: { command }, summary: command })).argument;
    expect(bashSummary).not.toContain("\n");
    expect(bashSummary).toHaveLength(70);
    expect(bashSummary?.endsWith("…")).toBe(true);
    expect(toolRowSummary(execution({ toolName: "search", summary: `query ${"y".repeat(80)}` })).argument).toHaveLength(70);
  });

  it("summarizes multiline output only after a tool finishes", () => {
    expect(toolRowSummary(execution({ status: "running", resultText: "one\ntwo" }))).toEqual({ argument: "input" });
    expect(toolRowSummary(execution({ status: "success", resultText: "one\ntwo" }))).toEqual({ argument: "input", result: "2 lines" });
  });
});

function execution(overrides: Partial<ToolExecutionPart>): ToolExecutionPart {
  return {
    type: "toolExecution",
    toolName: "tool",
    summary: "input",
    status: "pending",
    ...overrides,
  };
}
