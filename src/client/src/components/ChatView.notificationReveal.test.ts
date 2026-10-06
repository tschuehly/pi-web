// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

const frames = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
};

const messages: ChatLine[] = [
  { entryId: "u1", role: "user", parts: [{ type: "text", text: "question" }] },
  { entryId: "a1", role: "assistant", parts: [{ type: "text", text: "the reply" }] },
  { entryId: "u2", role: "user", parts: [{ type: "text", text: "later" }] },
];

async function mountedView(): Promise<{ view: ChatView; chat: HTMLElement }> {
  const view = new ChatView();
  view.sessionId = "s1";
  view.messages = messages;
  document.body.append(view);
  await view.updateComplete;
  await frames();
  const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
  if (chat == null) throw new Error("Chat scroller missing");
  Object.defineProperty(chat, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(chat, "clientHeight", { configurable: true, value: 300 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this === chat ? 100 : this.getAttribute("data-entry-id") === "a1" ? 700 - chat.scrollTop : 0;
    return { top, bottom: top + 50, left: 0, right: 0, width: 0, height: 50, x: 0, y: top, toJSON: () => ({}) };
  });
  chat.scrollTop = 50;
  return { view, chat };
}

describe("ChatView notification reveal", () => {
  it("scrolls the anchored message to the top of the transcript and flashes it", async () => {
    const { view, chat } = await mountedView();
    view.revealTarget = { machineId: "local", sessionId: "s1", anchor: "entry:a1" };
    await view.updateComplete;
    await frames();

    const article = view.shadowRoot?.querySelector<HTMLElement>('[data-entry-id="a1"]');
    expect(chat.scrollTop).toBe(600);
    expect(article?.hasAttribute("data-notification-reveal")).toBe(true);
  });

  it("leaves the scroll position alone without a target or for another Chat", async () => {
    const { view, chat } = await mountedView();
    view.revealTarget = { machineId: "local", sessionId: "other", anchor: "entry:a1" };
    await view.updateComplete;
    await frames();

    expect(chat.scrollTop).toBe(50);
    expect(view.shadowRoot?.querySelector("[data-notification-reveal]")).toBeNull();
  });
});
