// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as scrollPosition from "../chatScrollPosition";
import { ChatView } from "./ChatView";
import { TranscriptImage } from "./TranscriptImage";
import { settleImage } from "./imagePresentation.testSupport";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function readingHistory(imageCount = 1) {
  vi.stubGlobal("IntersectionObserver", undefined);
  // Existing frame-based transcript work is outside this synchronous image seam.
  const scheduleFrame = vi.fn<typeof requestAnimationFrame>().mockReturnValue(1);
  vi.stubGlobal("requestAnimationFrame", scheduleFrame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const view = new ChatView();
  view.sessionId = "image-history";
  view.messageStart = 10;
  view.messages = [
    ...Array.from({ length: imageCount }, (): ChatLine => ({ role: "user", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] })),
    { role: "user", parts: [{ type: "text", text: "Reading history" }] },
  ];
  document.body.append(view);
  await view.updateComplete;
  const images = [...view.renderRoot.querySelectorAll<TranscriptImage>("pi-web-transcript-image")];
  const presentations = await Promise.all(images.map(settleImage));
  const natives = presentations.map((presentation) => {
    const image = presentation.renderRoot.querySelector("img");
    if (image === null) throw new Error("Expected native image");
    return image;
  });
  const scroller = view.renderRoot.querySelector<HTMLDivElement>(".chat");
  const anchor = view.renderRoot.querySelector<HTMLElement>(`[data-scroll-anchor-id="m:${String(10 + imageCount)}"]`);
  if (scroller === null || anchor === null) throw new Error("Expected transcript and history anchor");
  // Stub geometry collaborators; happy-dom does not perform browser layout.
  Object.defineProperties(scroller, { clientHeight: { value: 300 }, scrollHeight: { value: 6000 } });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 600, 300));
  // These fixtures exercise visible-image anchoring; above-viewport growth has
  // its own geometry-injected coverage in ImageLayoutScrollController.test.ts.
  for (const presentation of presentations) {
    vi.spyOn(presentation, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 110, 320, 110));
  }
  scroller.scrollTop = 2445;
  scroller.dispatchEvent(new Event("scroll"));
  await view.updateComplete;
  const position = { mode: "anchor" as const, anchorId: anchor.dataset["scrollAnchorId"] ?? "", offset: -20 };
  const find = vi.spyOn(scrollPosition, "findVisibleScrollAnchor").mockReturnValue(anchor);
  const capture = vi.spyOn(scrollPosition, "captureScrollPosition").mockReturnValue(position);
  const restore = vi.spyOn(scrollPosition.ChatScrollController.prototype, "restoreExplicitPosition").mockImplementation((_position, viewport) => {
    if (viewport === undefined) throw new Error("Expected restoration viewport");
    viewport.scrollTop += 210;
    return { status: "restored" };
  });
  const bottom = vi.fn();
  Reflect.set(view, "scrollToBottom", bottom);
  scheduleFrame.mockClear();
  return { view, presentations, natives, scroller, anchor, position, find, capture, restore, bottom, scheduleFrame };
}

function layoutEvent(type: "image-will-layout" | "image-layout"): Event {
  return new Event(type, { bubbles: true, composed: true });
}

describe("ChatView image history anchoring", () => {
  it("captures before an image render and restores history immediately without following the tail", async () => {
    const { view, presentations, natives, scroller, anchor, position, find, capture, restore, bottom, scheduleFrame } = await readingHistory();
    natives[0]?.dispatchEvent(new Event("load"));
    await presentations[0]?.updateComplete;

    expect(find).toHaveBeenCalledWith(scroller, expect.arrayContaining([anchor]));
    expect(capture).toHaveBeenCalledExactlyOnceWith(scroller, anchor);
    expect(restore).toHaveBeenCalledExactlyOnceWith(position, scroller, expect.arrayContaining([anchor]), { fallbackToBottom: false });
    expect(bottom).not.toHaveBeenCalled();
    expect(scheduleFrame).not.toHaveBeenCalled();
    expect(Reflect.get(view, "lastScrollTop")).toBe(scroller.scrollTop);
  });

  it("captures afresh for each image update queued in the same microtask batch", async () => {
    const { presentations, natives, scroller, position, capture, restore, bottom, scheduleFrame } = await readingHistory(2);
    const capturedScrollTops: number[] = [];
    capture.mockImplementation(() => {
      capturedScrollTops.push(scroller.scrollTop);
      return position;
    });
    for (const native of natives) native.dispatchEvent(new Event("load"));
    await Promise.all(presentations.map((presentation) => presentation.updateComplete));

    expect(capturedScrollTops).toEqual([2445, 2655]);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(bottom).not.toHaveBeenCalled();
    expect(scheduleFrame).not.toHaveBeenCalled();
  });

  it("does not undo scrolling between the paired events and uses the new position on the next update", async () => {
    const { presentations, natives, scroller, position, capture, restore, bottom } = await readingHistory();
    const capturedScrollTops: number[] = [];
    capture.mockImplementation(() => {
      capturedScrollTops.push(scroller.scrollTop);
      return position;
    });
    scroller.addEventListener("image-will-layout", () => {
      scroller.scrollTop -= 60;
      scroller.dispatchEvent(new Event("scroll"));
    }, { once: true });
    natives[0]?.dispatchEvent(new Event("load"));
    await presentations[0]?.updateComplete;
    expect(restore).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(2385);

    natives[0]?.dispatchEvent(new Event("error"));
    await presentations[0]?.updateComplete;
    expect(capturedScrollTops).toEqual([2445, 2385]);
    expect(restore).toHaveBeenCalledOnce();
    expect(bottom).not.toHaveBeenCalled();
  });

  it.each(["session", "machine", "disconnect"] as const)("clears in-flight image captures on %s changes", async (change) => {
    const { view, scroller, capture, restore, bottom } = await readingHistory();
    scroller.dispatchEvent(layoutEvent("image-will-layout"));
    expect(capture).toHaveBeenCalledOnce();
    if (change === "disconnect") {
      view.remove();
      document.body.append(view);
      await view.updateComplete;
    } else {
      const previousSession = view.sessionId;
      const previousMachine = view.machineId;
      view.messages = [];
      if (change === "session") view.sessionId = "another-session";
      else view.machineId = "another-machine";
      await view.updateComplete;
      view.sessionId = previousSession;
      view.machineId = previousMachine;
      await view.updateComplete;
    }
    scroller.dispatchEvent(layoutEvent("image-layout"));
    expect(restore).not.toHaveBeenCalled();
    expect(bottom).not.toHaveBeenCalled();
  });
});
