// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
import { normalizeMessages } from "../chatMessages";
import { createContentRenderingService } from "../formatting/contentRendering";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["```text\ndisplayed\n```", "", undefined])("renders display text while copying original text (%s)", async (displayText) => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("isSecureContext", true);
  const select = vi.fn(() => []);
  const view = new ChatView();
  view.contentRendering = createContentRenderingService(select);
  view.messages = normalizeMessages([{ role: "assistant", content: [
    { type: "text", text: "original", displayText },
    { type: "thinking", thinking: "original reasoning", displayText },
  ] }]);
  document.body.append(view);
  await view.updateComplete;
  const group = view.renderRoot.querySelector<HTMLDetailsElement>("details.msg");
  if (group !== null) {
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    await view.updateComplete;
  }
  const formatted = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
  await Promise.all(formatted.map((element) => element.updateComplete));
  if (displayText === "") {
    expect(formatted).toHaveLength(0);
    expect(view.renderRoot.querySelector("details.part")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  } else {
    // The fork renders reasoning in its own thinking group after the reply text.
    expect(formatted.map((element) => element.text)).toEqual(displayText === undefined
      ? ["original", "original reasoning"] : [displayText, displayText]);
    expect(formatted.map((element) => element.renderRoot.textContent)).toEqual(displayText === undefined
      ? [expect.stringContaining("original"), expect.stringContaining("original reasoning")]
      : [expect.stringContaining("displayed"), expect.stringContaining("displayed")]);
    if (displayText !== undefined) {
      expect(select).toHaveBeenCalledWith(expect.objectContaining({ text: "displayed" }));
      expect(formatted.every((element) => !element.renderRoot.textContent.includes("original"))).toBe(true);
    }
  }
  expect(view.messages[0]?.parts).toEqual([
    { type: "text", text: "original", ...(displayText === undefined ? {} : { displayText }) },
    { type: "thinking", text: "original reasoning", ...(displayText === undefined ? {} : { displayText }) },
  ]);
  const copy = view.renderRoot.querySelector<HTMLButtonElement>('[aria-label="Copy assistant message"]');
  expect(copy).not.toBeNull();
  copy?.click();
  await view.updateComplete;
  expect(writeText).toHaveBeenCalledWith("original");
});
