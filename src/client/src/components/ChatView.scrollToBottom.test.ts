// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatView scroll-to-bottom control", () => {
  it("appears while the transcript is unpinned and returns to the live tail", async () => {
    const view = new ChatView();
    document.body.append(view);
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector(".scroll-to-bottom")).toBeNull();

    const scrollToBottom = vi.fn();
    Reflect.set(view, "scrollToBottom", scrollToBottom);
    Reflect.set(view, "pinnedToBottom", false);
    view.requestUpdate();
    await view.updateComplete;

    const button = view.shadowRoot?.querySelector<HTMLButtonElement>(".scroll-to-bottom");
    expect(button?.getAttribute("aria-label")).toBe("Scroll to bottom");
    button?.click();
    await view.updateComplete;

    expect(scrollToBottom).toHaveBeenCalledOnce();
    expect(view.shadowRoot?.querySelector(".scroll-to-bottom")).toBeNull();
  });
});
