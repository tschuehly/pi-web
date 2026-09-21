// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { WORKING_MODE_STATUS_KEY } from "../extensionStatusSnapshots";
import { PromptEditor } from "./PromptEditor";
import { WorkingModeControls } from "./WorkingModeControls";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function status(): SessionStatus {
  return {
    sessionId: "session-1", isStreaming: false, isCompacting: false, isBashRunning: false,
    pendingMessageCount: 0, queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
    extensionStatuses: { [WORKING_MODE_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, phase: "selected", selected: { alignment: "Align", checking: "tests" }, applied: null }) },
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected test value");
  return value;
}

describe("PromptEditor Working Mode controls", () => {
  it("renders the Working Mode controls between the model selector and Send, and runs their commands", async () => {
    const run = vi.fn();
    const editor = new PromptEditor();
    editor.status = status();
    editor.onRunCommand = run;
    document.body.append(editor);
    await editor.updateComplete;

    const actions = required(editor.shadowRoot?.querySelector(".actions"));
    const order = [...actions.children].map((child) => child.classList.contains("compact-status") ? "status" : child.classList.contains("send-button") ? "send" : child.localName);
    expect(order.slice(0, 3)).toEqual(["status", "working-mode-controls", "send"]);

    const controls = required(actions.querySelector<WorkingModeControls>("working-mode-controls"));
    await controls.updateComplete;
    expect(controls.hasAttribute("compact")).toBe(true);
    const buttons = [...required(controls.shadowRoot).querySelectorAll("button")];
    expect(required(buttons.find((button) => button.textContent === "Align")).getAttribute("aria-pressed")).toBe("true");
    required(buttons.find((button) => button.textContent === "Plan")).click();
    expect(run).toHaveBeenCalledWith("/mode alignment plan");
  });
});
