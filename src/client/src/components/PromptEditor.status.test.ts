// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { PromptEditor, PromptEditorSessionStatus } from "./PromptEditor";
import { promptEditorStyles } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("PromptEditor hosted Chat status", () => {
  it("shows compact high-context status with expandable metrics and a warning toggle", async () => {
    const editor = new PromptEditor();
    const onToggleWarnings = vi.fn();
    editor.status = status({ percent: 80, input: 12_400, output: 987, cost: 0.125, queued: 2 });
    editor.chatStatusPlacement = "prompt-editor";
    editor.warningCount = 3;
    editor.warningsExpanded = false;
    editor.onToggleWarnings = onToggleWarnings;
    document.body.append(editor);
    await editor.updateComplete;

    const compactStatus = requiredElement(editor.shadowRoot, "prompt-editor-session-status", PromptEditorSessionStatus);
    await compactStatus.updateComplete;
    const summary = requiredElement(compactStatus.shadowRoot, "summary", HTMLElement);
    expect(summary.querySelector(".context-summary-wide")?.textContent).toBe("⚠ 80.0% context");
    expect(summary.querySelector(".context-summary-narrow")?.textContent).toBe("⚠ 80.0%");
    expect(summary.title).toContain("↑12k · ↓987 · $0.13 · 2 queued");
    expect(compactStatus.shadowRoot?.querySelector(".status-details")?.textContent).toContain("2 queued");

    requiredElement(compactStatus.shadowRoot, ".warning-toggle", HTMLButtonElement).click();
    expect(onToggleWarnings).toHaveBeenCalledOnce();
  });

  it("updates hosted metrics without replacing the prompt editor DOM during token churn", async () => {
    const editor = new PromptEditor();
    editor.status = status({ percent: 42, output: 1 });
    editor.chatStatusPlacement = "prompt-editor";
    document.body.append(editor);
    await editor.updateComplete;

    const markdownEditor = requiredElement(editor.shadowRoot, ".markdown-editor", HTMLDivElement);
    const compactStatus = requiredElement(editor.shadowRoot, "prompt-editor-session-status", PromptEditorSessionStatus);
    editor.status = status({ percent: 42.1, output: 2 });
    await compactStatus.updateComplete;

    expect(requiredElement(editor.shadowRoot, ".markdown-editor", HTMLDivElement)).toBe(markdownEditor);
    expect(requiredElement(editor.shadowRoot, "prompt-editor-session-status", PromptEditorSessionStatus)).toBe(compactStatus);
    expect(compactStatus.shadowRoot?.querySelector(".context-summary-wide")?.textContent).toBe("42.1% context");
    expect(compactStatus.shadowRoot?.querySelector(".status-details")?.textContent).toContain("↓2");
  });

  it("renders truthful loading status and keeps the model affordance when hosted status is nullish", async () => {
    for (const nullishStatus of [undefined, null] as const) {
      const editor = new PromptEditor();
      editor.chatStatusPlacement = "prompt-editor";
      editor.status = nullishStatus;
      document.body.append(editor);
      await editor.updateComplete;

      const compactStatus = requiredElement(editor.shadowRoot, "prompt-editor-session-status", PromptEditorSessionStatus);
      await compactStatus.updateComplete;
      const loading = compactStatus.shadowRoot?.querySelector("[role='status']");
      expect(loading?.textContent).toBe("Loading…");
      expect(loading?.getAttribute("aria-label")).toBe("Session status loading");
      expect(requiredElement(editor.shadowRoot, ".select-model", HTMLButtonElement).disabled).toBe(false);
      expect(requiredElement(editor.shadowRoot, ".select-thinking", HTMLButtonElement).disabled).toBe(true);
      editor.remove();
    }
  });

  it("labels expandable details, announces changes, and closes them on Escape", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const hostedStatus = new PromptEditorSessionStatus();
    hostedStatus.status = status({ percent: 80 });
    document.body.append(hostedStatus);
    await hostedStatus.updateComplete;

    const details = requiredElement(hostedStatus.shadowRoot, "details", HTMLDetailsElement);
    const summary = requiredElement(hostedStatus.shadowRoot, "summary", HTMLElement);
    expect(summary.querySelector(".context-summary-wide")?.textContent).toBe("⚠ 80.0% context");
    expect(summary.getAttribute("aria-label")).toContain("High context usage");
    expect(summary.title).toContain("200k context window");

    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await hostedStatus.updateComplete;
    expect(hostedStatus.shadowRoot?.querySelector("[aria-live='polite']")?.textContent).toContain("expanded");

    details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await hostedStatus.updateComplete;
    expect(details.open).toBe(false);
    expect(hostedStatus.shadowRoot?.activeElement).toBe(summary);
  });

  it("keeps usage details reachable while narrow layouts prioritise compact status over the model label", () => {
    const hostedStatusCss = PromptEditorSessionStatus.styles.cssText;
    const editorCss = promptEditorStyles.cssText;

    expect(hostedStatusCss).not.toMatch(/\.context-status[^{}]*\{[^}]*display:\s*none/);
    expect(hostedStatusCss).toMatch(/@media \(max-width: 430px\)[\s\S]*\.context-summary-wide\s*\{[^}]*display:\s*none/);
    expect(editorCss).toMatch(/@media \(max-width: 390px\)[\s\S]*\.model-label-wide\s*\{[^}]*display:\s*none/);
    expect(hostedStatusCss).toContain("min-width: max(44px, var(--pi-control-min-size)); min-height: max(44px, var(--pi-control-min-size))");
    expect(editorCss).toContain("button { min-height: max(44px, var(--pi-control-min-size)); }");
    expect(editorCss).toContain(".icon-button { min-width: max(44px, var(--pi-control-min-size)); width: max(44px, var(--pi-control-min-size)); height: max(44px, var(--pi-control-min-size)); }");
    expect(editorCss).not.toContain(".icon-button, .select-model");
  });

  it("does not render hosted status in the default bar placement", async () => {
    const editor = new PromptEditor();
    editor.status = status({ percent: 50 });
    document.body.append(editor);
    await editor.updateComplete;

    expect(editor.shadowRoot?.querySelector("prompt-editor-session-status")).toBeNull();
  });
});

function status(options: { percent: number; input?: number; output?: number; cost?: number; queued?: number }): SessionStatus {
  const input = options.input ?? 0;
  const output = options.output ?? 0;
  return {
    sessionId: "session-1",
    model: { provider: "anthropic", id: "claude", contextWindow: 200_000 },
    thinkingLevel: "medium",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: options.queued ?? 0,
    queuedMessages: [],
    tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
    cost: options.cost ?? 0,
    contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: options.percent },
  };
}

function requiredElement<T extends Element>(root: ParentNode | null, selector: string, constructor: abstract new (...args: never[]) => T): T {
  const element = root?.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Expected ${selector}`);
  return element;
}
