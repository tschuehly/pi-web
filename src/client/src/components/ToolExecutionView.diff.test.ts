// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionPart } from "../chatTypes";
import { ToolExecutionView } from "./ToolExecutionView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function renderTool(overrides: Partial<ToolExecutionPart>, orphan = false): Promise<ToolExecutionView> {
  const view = new ToolExecutionView();
  view.orphan = orphan;
  view.execution = { type: "toolExecution", toolName: "edit", summary: "file", status: "success", args: { path: "file.ts", edits: [{ oldText: "before", newText: "after" }] }, ...overrides };
  document.body.append(view);
  await view.updateComplete;
  return view;
}

// Workbench additions on upstream's tool card: action labels, a compact argument, the log button and orphan results.
describe("Workbench tool card details", () => {
  it("labels the action and summarizes a bash description while keeping the full command in the title", async () => {
    const args = { description: "Run the unit tests", command: "npm test -- --run" };
    const view = await renderTool({ toolName: "bash", summary: "npm test", args, details: { id: "job", logPath: "/Users/me/.pi-workbench/background-bash/jobs/job/output.log" }, resultText: "ok" });
    const header = view.shadowRoot?.querySelector(".tool-header");
    expect(header?.querySelector("strong")?.textContent).toBe("Ran bash command");
    expect(header?.querySelector(".summary")?.textContent).toBe("Run the unit tests");
    expect(header?.querySelector(".summary")?.getAttribute("title")).toBe("npm test -- --run");
    expect(header?.querySelector("bash-log-button")).toHaveProperty("logPath", "/Users/me/.pi-workbench/background-bash/jobs/job/output.log");
    const plain = await renderTool({ toolName: "bash", summary: "ls", args: { command: "ls" }, resultText: "ok" });
    expect(plain.shadowRoot?.querySelector("bash-log-button")).toBeNull();
  });

  it("shows an orphan result's diff and its output", async () => {
    const view = await renderTool({ toolName: "edit", summary: "", args: undefined, details: { diff: "-before\n+after" }, resultText: "Applied edit" }, true);
    expect(view.shadowRoot?.querySelector<HTMLDetailsElement>(".diff-details")?.open).toBe(true);
    expect(view.shadowRoot?.querySelector(".detail-result pre")?.textContent).toBe("Applied edit");
  });

  it("does not summarize output a diff already counts", async () => {
    const view = await renderTool({ details: { diff: "-before\n+after" }, resultText: "one\ntwo" });
    expect(view.shadowRoot?.querySelector(".row-result")).toBeNull();
    expect(view.shadowRoot?.querySelector(".diff-stats")?.textContent).toContain("+1");
  });
});
