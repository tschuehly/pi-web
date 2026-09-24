// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ChatView scroll-to-bottom control", () => {
  it("safely no-ops dialog, scroll, prepend, and metric paths before Lit renders queries", () => {
    const view = new ChatView();
    view.sessionId = "pre-render";

    expect(() => {
      invoke(view, "syncImageZoomDialog");
      invoke(view, "syncScrollMetrics");
      invoke(view, "alignOpenAskToTop");
      invoke(view, "alignOpenDialogToTop");
      invoke(view, "scrollToBottom");
      view.restoreScrollPosition();
      view.saveScrollPosition();
      expect(view.capturePrependScrollAnchor()).toBeUndefined();
      view.restorePrependScrollAnchor({ distanceFromBottom: 0 });
    }).not.toThrow();
  });

  it("keeps the live tail pinned on composer-driven resize without moving an unpinned transcript", async () => {
    const hadResizeObserver = Reflect.has(globalThis, "ResizeObserver");
    const previousResizeObserver: unknown = Reflect.get(globalThis, "ResizeObserver");
    let resizeCallback: ResizeObserverCallback | undefined;
    const constructed = vi.fn();
    class ResizeObserverStub implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; constructed(); }
      observe = vi.fn((target: Element) => { if (!(target instanceof Element)) throw new TypeError("ResizeObserver target must be an Element"); });
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = (): ResizeObserverEntry[] => [];
    }
    Reflect.set(globalThis, "ResizeObserver", ResizeObserverStub);
    try {
      const view = new ChatView();
      document.body.append(view);
      await view.updateComplete;
      const chat = view.shadowRoot?.querySelector<HTMLElement>(".chat");
      const resizeObserver: unknown = Reflect.get(view, "chatResizeObserver");
      if (chat === null || chat === undefined || resizeCallback === undefined || !(resizeObserver instanceof ResizeObserverStub)) throw new Error("Chat resize observer was not installed");
      expect(constructed).toHaveBeenCalledOnce();
      expect(resizeObserver.observe).toHaveBeenCalledOnce();
      expect(resizeObserver.observe).toHaveBeenCalledWith(chat);
      const scrollToBottom = vi.fn();
      Reflect.set(view, "scrollToBottom", scrollToBottom);

      resizeCallback([], resizeObserver);
      expect(scrollToBottom).toHaveBeenCalledOnce();

      Reflect.set(view, "pinnedToBottom", false);
      Reflect.set(view, "lastScrollTop", 120);
      chat.scrollTop = 80;
      resizeCallback([], resizeObserver);
      expect(chat.scrollTop).toBe(120);
      expect(scrollToBottom).toHaveBeenCalledOnce();
    } finally {
      if (hadResizeObserver) Reflect.set(globalThis, "ResizeObserver", previousResizeObserver);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });

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

function invoke(view: ChatView, name: string): unknown {
  const method: unknown = Reflect.get(view, name);
  if (typeof method !== "function") throw new Error(`ChatView.${name} is not callable`);
  return Reflect.apply(method, view, []);
}
