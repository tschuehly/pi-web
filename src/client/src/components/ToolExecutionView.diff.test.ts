// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionPart } from "./shared";
import { ToolExecutionView } from "./ToolExecutionView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function renderTool(overrides: Partial<ToolExecutionPart>): Promise<ToolExecutionView> {
  const view = new ToolExecutionView();
  view.execution = { type: "toolExecution", toolName: "edit", summary: "file", status: "success", args: { path: "file.ts", edits: [{ oldText: "before", newText: "after" }] }, ...overrides };
  document.body.append(view);
  await view.updateComplete;
  return view;
}

describe("tool execution diff details", () => {
  it.each([
    { label: "Applied diff", data: { details: { diff: "-before\n+after" }, preview: { diff: "-old\n+new" } } },
    { label: "Preview diff", data: { preview: { diff: "-before\n+after" } } },
  ])("shows $label first, with exact arguments closed until requested", async ({ label, data }) => {
    const view = await renderTool({ ...data, resultText: "Applied edit" });
    const card = view.shadowRoot?.querySelector<HTMLDetailsElement>(".tool-card");
    expect(card?.querySelector(".diff-heading")?.textContent).toContain(label);
    const body = card?.querySelector(".tool-body");
    const diff = body?.querySelector(".diff-details");
    const args = body?.querySelector<HTMLDetailsElement>("details.detail-target");
    expect(Array.from(body?.children ?? [], (element) => element.className).slice(0, 3)).toEqual(["tool-meta", "diff-details", "detail-target"]);
    expect(diff).not.toBeNull();
    expect(args?.open).toBe(false);
    expect(args?.querySelector("summary")?.textContent).toBe("Arguments");
    expect(args?.querySelector("pre")?.textContent).toBe(JSON.stringify(view.execution?.args, null, 2));
    args?.querySelector("summary")?.click();
    expect(args?.open).toBe(true);
    expect(card?.querySelector(".detail-result pre")?.textContent).toBeUndefined();
  });

  it("keeps failures and preview errors visible after the diff", async () => {
    const view = await renderTool({ status: "error", resultText: "Edit failed", details: { diff: "+after" }, preview: { error: "Preview failed" } });
    const body = view.shadowRoot?.querySelector(".tool-body");
    expect(Array.from(body?.children ?? [], (element) => element.className).slice(0, 3)).toEqual(["tool-meta", "diff-details", "detail-target"]);
    expect(Array.from(body?.querySelectorAll(".error-text") ?? [], (element) => element.textContent)).toEqual(["Edit failed", "Preview failed"]);
  });

  it("keeps no-diff arguments and result in their existing order", async () => {
    const view = await renderTool({ resultText: "No changes" });
    const body = view.shadowRoot?.querySelector(".tool-body");
    expect(body?.querySelector(".diff-details")).toBeNull();
    const args = body?.querySelector(".detail-target");
    expect(args?.tagName).toBe("DIV");
    expect(Array.from(body?.children ?? [], (element) => element.className)).toEqual(["tool-meta", "detail-target", "detail-result"]);
    expect(body?.querySelector(".detail-result pre")?.textContent).toBe("No changes");
  });

  it("can copy the full diff even while truncated, then show all lines", async () => {
    const diff = Array.from({ length: 181 }, (_, index) => `+line ${String(index)}`).join("\n");
    const writeText = vi.fn(() => Promise.resolve());
    const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      const view = await renderTool({ details: { diff } });
      const root = view.shadowRoot;
      expect(root?.querySelectorAll(".diff-content span")).toHaveLength(180);
      root?.querySelector<HTMLButtonElement>(".diff-toolbar button")?.click();
      await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith(diff); });
      root?.querySelector<HTMLButtonElement>(".show-more")?.click();
      await view.updateComplete;
      expect(root?.querySelectorAll(".diff-content span")).toHaveLength(181);
    } finally {
      if (secure === undefined) Reflect.deleteProperty(window, "isSecureContext");
      else Object.defineProperty(window, "isSecureContext", secure);
      if (clipboard === undefined) Reflect.deleteProperty(navigator, "clipboard");
      else Object.defineProperty(navigator, "clipboard", clipboard);
    }
  });

  it("offers the full log on a bash row whose details carry a log path, and keeps the full command on expand", async () => {
    const args = { description: "Run the unit tests", command: "npm test -- --run" };
    const view = await renderTool({ toolName: "bash", summary: "npm test", args, details: { id: "job", logPath: "/Users/me/.pi-workbench/background-bash/jobs/job/output.log" }, resultText: "ok" });
    const row = view.shadowRoot?.querySelector(".tool-row");
    expect(row?.querySelector(".row-argument")?.textContent).toBe("Run the unit tests");
    expect(row?.querySelector("bash-log-button")).toHaveProperty("logPath", "/Users/me/.pi-workbench/background-bash/jobs/job/output.log");
    expect(view.shadowRoot?.querySelector(".detail-target-value")?.textContent).toContain("npm test -- --run");
    const plain = await renderTool({ toolName: "bash", summary: "ls", args: { command: "ls" }, resultText: "ok" });
    expect(plain.shadowRoot?.querySelector("bash-log-button")).toBeNull();
  });
});
