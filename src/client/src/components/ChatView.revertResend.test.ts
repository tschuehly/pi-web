// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageActionAvailabilityContext } from "../../../plugin-api";
import { runWorkbenchMessageAction, WORKBENCH_MESSAGE_ACTIONS } from "../workbenchMessageActions";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatView revert-to-here and edit-and-resend actions (Workbench message actions)", () => {
  it("offers Revert on conversation entries and Edit & resend only on user entries, never Fork", async () => {
    const messages: ChatLine[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }], entryId: "entry-1" },
      { role: "assistant", parts: [{ type: "text", text: "hello" }], entryId: "entry-2" },
      { role: "user", parts: [{ type: "text", text: "no id yet" }] },
    ];
    const view = await renderView(messages, false, vi.fn(() => Promise.resolve()));

    expect(view.shadowRoot?.querySelectorAll('[aria-label="Revert to here"]')).toHaveLength(2);
    expect(view.shadowRoot?.querySelectorAll('[aria-label="Edit and resend"]')).toHaveLength(1);
    expect(view.shadowRoot?.querySelector('[title="Clone session from this message"]')).toBeNull();
  });

  it("disables both actions while the Chat is busy and goes back to the entry otherwise", async () => {
    const actOnMessage = vi.fn(() => Promise.resolve());
    const messages: ChatLine[] = [{ role: "user", parts: [{ type: "text", text: "hi" }], entryId: "entry-1" }];
    const view = await renderView(messages, true, actOnMessage);

    expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Revert to here"]')?.disabled).toBe(true);
    expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')?.disabled).toBe(true);

    view.messageActionContext = context(false);
    await view.updateComplete;
    view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Revert to here"]')?.click();
    await vi.waitFor(() => { expect(actOnMessage).toHaveBeenCalledTimes(1); });
    await vi.waitFor(() => { expect(view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')?.disabled).toBe(false); });
    view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')?.click();
    await vi.waitFor(() => { expect(actOnMessage).toHaveBeenCalledTimes(2); });
    expect(actOnMessage).toHaveBeenNthCalledWith(1, "entry-1", "back");
    expect(actOnMessage).toHaveBeenNthCalledWith(2, "entry-1", "back");
  });
});

function context(busy: boolean): Omit<MessageActionAvailabilityContext, "message"> {
  return { machine: { id: "local", name: "local", kind: "local" }, session: { id: "session-1", cwd: "/repo", archived: false, pending: false, busy } };
}

async function renderView(messages: ChatLine[], busy: boolean, actOnMessage: (entryId: string, action: "fork" | "back") => Promise<void>): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = messages;
  view.messageActions = WORKBENCH_MESSAGE_ACTIONS;
  view.messageActionContext = context(busy);
  view.onMessageAction = (input, actionId) => runWorkbenchMessageAction(actOnMessage, input, actionId);
  document.body.append(view);
  await view.updateComplete;
  return view;
}
