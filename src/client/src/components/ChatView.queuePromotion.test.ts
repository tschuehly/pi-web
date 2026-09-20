// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedSessionMessage, SessionStatus } from "../api";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatView queued-message promotion", () => {
  it("wires Send now for an exact queued message and Send all now for the server queue", async () => {
    const messages: QueuedSessionMessage[] = [
      { kind: "steer", text: "same text" },
      { kind: "followUp", text: "same text" },
    ];
    const promoteOne = vi.fn();
    const promoteAll = vi.fn();
    const view = await renderView(status(messages));
    view.onPromoteQueuedMessage = promoteOne;
    view.onPromoteAllQueuedMessages = promoteAll;
    await view.updateComplete;

    const sendNowButtons = Array.from(view.shadowRoot?.querySelectorAll<HTMLButtonElement>(".queued-send-now-button") ?? []);
    expect(sendNowButtons).toHaveLength(1);
    expect(sendNowButtons[0]?.getAttribute("aria-label")).toBe("Send follow-up 2 now");
    sendNowButtons[0]?.click();
    view.shadowRoot?.querySelector<HTMLButtonElement>(".queued-send-all-button")?.click();

    expect(sendNowButtons[0]?.title).toBe("Move to steering");
    expect(promoteOne).toHaveBeenCalledExactlyOnceWith(messages[1]);
    expect(promoteAll).toHaveBeenCalledOnce();
  });

  it("removes promotion controls once every queued message is already steering", async () => {
    const view = await renderView(status([{ kind: "steer", text: "already steering" }]));
    view.onPromoteQueuedMessage = vi.fn();
    view.onPromoteAllQueuedMessages = vi.fn();
    await view.updateComplete;

    expect(view.shadowRoot?.querySelector(".queued-send-now-button")).toBeNull();
    expect(view.shadowRoot?.querySelector(".queued-send-all-button")).toBeNull();
  });

  it("shows promotion controls disabled during compaction without claiming immediate delivery", async () => {
    const view = await renderView({ ...status([{ kind: "followUp", text: "after compaction" }]), isCompacting: true });
    view.onPromoteQueuedMessage = vi.fn();
    view.onPromoteAllQueuedMessages = vi.fn();
    await view.updateComplete;

    const controls = Array.from(view.shadowRoot?.querySelectorAll<HTMLButtonElement>(".queued-send-now-button, .queued-send-all-button") ?? []);
    expect(controls).toHaveLength(2);
    expect(controls.every((button) => button.disabled)).toBe(true);
    expect(controls.every((button) => button.title === "Available after compaction finishes")).toBe(true);
  });
});

async function renderView(sessionStatus: SessionStatus): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = sessionStatus.sessionId;
  view.status = sessionStatus;
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function status(queuedMessages: QueuedSessionMessage[]): SessionStatus {
  return {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: queuedMessages.length,
    queuedMessages,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}
