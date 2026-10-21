// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { MANUAL_CHAT_BEHAVIORS } from "../chatBehaviors.testSupport";
import { ChatView } from "./ChatView";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

async function mount(messages: ChatLine[], live = false): Promise<ChatView> {
  const view = new ChatView();
  view.behaviors = MANUAL_CHAT_BEHAVIORS;
  view.messages = messages;
  view.isSendingPrompt = live;
  document.body.append(view);
  await view.updateComplete;
  return view;
}


describe("ChatView durable DOM scroll anchors", () => {
  it("renders unidentified readable messages and tool images without index anchors", async () => {
    const question: ChatLine = { role: "user", parts: [{ type: "text", text: "Question" }] };
    const image: ChatLine = { entryId: "", role: "tool", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] };
    const view = await mount([question, image]);
    expect(view.renderRoot.querySelectorAll("article.msg")).toHaveLength(2);
    expect(view.renderRoot.querySelector("article.tool-image-output")).not.toBeNull();
    expect(view.renderRoot.querySelector("[data-scroll-anchor-id]")).toBeNull();

    view.messages = [{ ...question, entryId: "question" }, image];
    await view.updateComplete;
    expect(view.renderRoot.querySelector("article.user")?.getAttribute("data-scroll-anchor-id"))
      .toBe('m:["question","user","message"]');
    view.messages = [{ ...question, entryId: "" }, image];
    await view.updateComplete;
    expect(view.renderRoot.querySelector("[data-scroll-anchor-id]")).toBeNull();
  });

});
