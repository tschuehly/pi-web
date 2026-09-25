// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { writeClipboardText } from "../clipboard";
import { FormattedText } from "./FormattedText";

vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn().mockResolvedValue(true) }));
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.clearAllMocks(); vi.useRealTimers(); });

async function renderQuote(text: string): Promise<FormattedText> {
  const view = new FormattedText();
  view.text = text;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

it("copies the quote's Markdown source without outer quote markers", async () => {
  const view = await renderQuote("Paste this as your answer:\n\n> First `command`\n>\n> Second paragraph\n> - one\n> - two");
  const button = view.shadowRoot?.querySelector<HTMLButtonElement>("blockquote .quote-copy-button");
  expect(button?.getAttribute("aria-label")).toBe("Copy quote");
  button?.click();
  await vi.waitFor(() => { expect(writeClipboardText).toHaveBeenCalledWith("First `command`\n\nSecond paragraph\n- one\n- two"); });
  expect(button?.getAttribute("aria-label")).toBe("Copied quote");
});

it("gives a nested quote just one copy button", async () => {
  const view = await renderQuote("> Outer\n> > Inner");
  expect(view.shadowRoot?.querySelectorAll(".quote-copy-button")).toHaveLength(1);
  expect(view.shadowRoot?.querySelector("blockquote blockquote .quote-copy-button")).toBeNull();
});

it("lets a focused quote button activate by keyboard", async () => {
  const view = await renderQuote("> Keyboard `text`");
  const button = view.shadowRoot?.querySelector<HTMLButtonElement>(".quote-copy-button");
  expect(button?.tabIndex).toBe(0);
  button?.focus();
  expect(view.shadowRoot?.activeElement).toBe(button);
  // happy-dom does not synthesize a click from Enter; browsers dispatch a detail=0 click.
  button?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 0 }));
  await vi.waitFor(() => { expect(writeClipboardText).toHaveBeenCalledWith("Keyboard `text`"); });
});

it("reports a failed copy and restores its label", async () => {
  vi.mocked(writeClipboardText).mockResolvedValueOnce(false);
  const view = await renderQuote("> Uncopyable");
  const button = view.shadowRoot?.querySelector<HTMLButtonElement>(".quote-copy-button");
  button?.click();
  await vi.waitFor(() => { expect(button?.getAttribute("aria-label")).toBe("Failed to copy quote"); });
  await vi.waitFor(() => { expect(button?.getAttribute("aria-label")).toBe("Copy quote"); }, { timeout: 2000 });
});
