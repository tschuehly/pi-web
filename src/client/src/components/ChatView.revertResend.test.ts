// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../api";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatView revert-to-here and edit-and-resend actions", () => {
  it("shows both icons only on a user message that carries an entry id", async () => {
    const messages: ChatLine[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }], entryId: "entry-1" },
      { role: "assistant", parts: [{ type: "text", text: "hello" }], entryId: "entry-2" },
      { role: "user", parts: [{ type: "text", text: "no id yet" }] },
    ];
    const view = await renderView(messages);

    const revertButtons = view.shadowRoot?.querySelectorAll<HTMLButtonElement>('[aria-label="Revert to here"]');
    const resendButtons = view.shadowRoot?.querySelectorAll<HTMLButtonElement>('[aria-label="Edit and resend"]');
    expect(revertButtons).toHaveLength(2);
    expect(resendButtons).toHaveLength(1);
  });

  it("disables both actions while the session is streaming and fires callbacks with the entry id otherwise", async () => {
    const onRevert = vi.fn();
    const onResend = vi.fn();
    const messages: ChatLine[] = [{ role: "user", parts: [{ type: "text", text: "hi" }], entryId: "entry-1" }];
    const view = await renderView(messages, { ...status(), isStreaming: true });
    view.onRevertToMessage = onRevert;
    view.onEditAndResendMessage = onResend;
    await view.updateComplete;

    const revertWhileStreaming = view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Revert to here"]');
    const resendWhileStreaming = view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]');
    expect(revertWhileStreaming?.disabled).toBe(true);
    expect(resendWhileStreaming?.disabled).toBe(true);

    view.status = { ...status(), isStreaming: false };
    await view.updateComplete;
    view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Revert to here"]')?.click();
    view.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')?.click();

    expect(onRevert).toHaveBeenCalledExactlyOnceWith("entry-1");
    expect(onResend).toHaveBeenCalledExactlyOnceWith("entry-1");
  });
});

async function renderView(messages: ChatLine[], sessionStatus: SessionStatus = status()): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = sessionStatus.sessionId;
  view.messages = messages;
  view.status = sessionStatus;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function status(): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}
