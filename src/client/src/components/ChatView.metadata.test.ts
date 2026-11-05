// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ChatView, chatMessageMetadataLabel } from "./ChatView";

const message = {
  role: "assistant" as const,
  entryId: "metadata-entry",
  parts: [{ type: "text" as const, text: "A reply." }],
  meta: { timestamp: "2026-10-15T20:10:00Z", model: { provider: "example", id: "model" }, thinkingLevel: "high" },
};

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

// ISSUE-106 follow-up: the Info button only repeated the time tooltip, so it is gone.
it("shows message metadata as the time tooltip, without an Info button", async () => {
  const view = new ChatView();
  view.workbench = true;
  view.messages = [message];
  document.body.append(view);
  await view.updateComplete;
  expect(view.shadowRoot?.querySelector(".msg-time")?.getAttribute("title")).toBe(chatMessageMetadataLabel(message));
  expect(view.shadowRoot?.querySelector('button[aria-label="Message information"]')).toBeNull();
});

it("keeps conversational roles available to assistive technology without repeated visual headings", async () => {
  const view = new ChatView();
  view.messages = [{ ...message, role: "user", entryId: "request" }, message, { ...message, role: "system", entryId: "notice", severity: "error" }]; // Plain text system lines are quiet notices without headers (ISSUE-099).
  document.body.append(view);
  await view.updateComplete;

  const headers = [...(view.shadowRoot?.querySelectorAll(".msg-header") ?? [])];
  expect(headers).toHaveLength(3);
  expect(headers[0]?.querySelector(".visually-hidden")?.textContent).toBe("user");
  expect(headers[1]?.querySelector(".visually-hidden")?.textContent).toBe("assistant");
  expect(headers[0]?.querySelector(".label")).toBeNull();
  expect(headers[1]?.querySelector(".label")).toBeNull();
  expect(headers[2]?.querySelector(".label")?.textContent).toBe("system");
});
