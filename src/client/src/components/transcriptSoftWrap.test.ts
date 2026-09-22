// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { FormattedText } from "./FormattedText";
import { chatStyles, formattedTextStyles, type ToolExecutionPart } from "./shared";
import { ToolExecutionView } from "./ToolExecutionView";

let restoreClipboard = () => { /* No clipboard properties stubbed. */ };

afterEach(() => {
  restoreClipboard();
  restoreClipboard = () => { /* No clipboard properties stubbed. */ };
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("transcript preformatted soft wrapping", () => {
  it("wraps fenced Markdown without changing copied whitespace or copy-button clearance", async () => {
    const writeText = stubClipboard();
    const expected = `  indented\n    ${"unbroken".repeat(20)}\n`;
    const view = new FormattedText();
    view.text = `\`\`\`text\n${expected}\`\`\``;
    document.body.append(view);
    await view.updateComplete;

    const code = view.shadowRoot?.querySelector("pre code");
    const button = view.shadowRoot?.querySelector<HTMLButtonElement>(".code-copy-button");
    expect(code?.textContent).toBe(expected);
    expect(rule(formattedTextStyles.cssText, "pre")).toContain("white-space:pre-wrap");
    expect(rule(formattedTextStyles.cssText, "pre")).toContain("overflow-wrap:anywhere");
    expect(rule(formattedTextStyles.cssText, ".code-block-wrapper pre")).toContain("padding-right:40px");

    button?.click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith(expected); });
  });

  it("wraps Chat shell output and tool-call arguments without changing their text", async () => {
    const shell = `  output\n${"x".repeat(180)}`;
    const view = new ChatView();
    view.sessionId = "session-1";
    view.messages = [
      { role: "bash", parts: [{ type: "text", text: shell }] },
      { role: "assistant", parts: [{ type: "toolCall", toolName: "bash", summary: "run", args: { command: "  echo hi\nnext" } }] },
    ];
    document.body.append(view);
    await view.updateComplete;

    expect(rule(chatStyles.cssText, "pre")).toContain("white-space:pre-wrap");
    expect(rule(chatStyles.cssText, "pre")).toContain("overflow-wrap:anywhere");
    expect(view.shadowRoot?.querySelector("pre.shell-output")?.textContent).toBe(shell);
    expect(view.shadowRoot?.querySelector(".tool-line pre")?.textContent).toBe('{\n  "command": "  echo hi\\nnext"\n}');
  });

  it("wraps ToolExecution errors and results while keeping diff rows unwrapped", async () => {
    const error = `  failure\n${"e".repeat(180)}`;
    const failed = await renderTool({ status: "error", resultText: error });
    expect(failed.shadowRoot?.querySelector("pre.error-text")?.textContent).toBe(error);

    const result = `  result\n${"r".repeat(180)}`;
    const succeeded = await renderTool({ status: "success", resultText: result });
    expect(succeeded.shadowRoot?.querySelector(".detail-result pre")?.textContent).toBe(result);

    expect(rule(ToolExecutionView.styles.cssText, ".error-text")).toContain("white-space:pre-wrap");
    expect(rule(ToolExecutionView.styles.cssText, ".error-text")).toContain("overflow-wrap:anywhere");
    expect(rule(ToolExecutionView.styles.cssText, ".detail-result pre")).toContain("white-space:pre-wrap");
    expect(rule(ToolExecutionView.styles.cssText, ".detail-result pre")).toContain("overflow-wrap:anywhere");
    expect(rule(ToolExecutionView.styles.cssText, ".diff span")).toContain("white-space:pre");
  });
});

function stubClipboard() {
  const writeText = vi.fn(() => Promise.resolve());
  const secureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  const clipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  restoreClipboard = () => {
    restoreProperty(window, "isSecureContext", secureContext);
    restoreProperty(window.navigator, "clipboard", clipboard);
  };
  return writeText;
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key);
  else Object.defineProperty(target, key, descriptor);
}

async function renderTool(overrides: Partial<ToolExecutionPart>): Promise<ToolExecutionView> {
  const view = new ToolExecutionView();
  view.execution = { type: "toolExecution", toolName: "bash", summary: "run", status: "pending", ...overrides };
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function rule(cssText: string, selector: string): string {
  const pattern = new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return pattern.exec(cssText)?.[1]?.replace(/\s+/g, "") ?? "";
}
