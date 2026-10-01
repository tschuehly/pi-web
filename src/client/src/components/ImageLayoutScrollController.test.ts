import { describe, expect, it, vi } from "vitest";
import { ChatScrollController, type ChatScrollElement, type ChatScrollViewport } from "../chatScrollPosition";
import { ImageLayoutScrollController } from "./ImageLayoutScrollController";

function history() {
  // Geometry is an injected collaborator, not browser layout under test.
  const scroller: ChatScrollViewport = {
    scrollTop: 2445, scrollHeight: 6000, clientHeight: 300,
    getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
  };
  let anchorTop = 80;
  const anchor: ChatScrollElement = {
    dataset: { scrollAnchorId: "m:11" },
    getBoundingClientRect: () => ({ top: anchorTop, bottom: anchorTop + 100 }),
  };
  const scroll = new ChatScrollController();
  const restore = vi.spyOn(scroll, "restoreExplicitPosition");
  const controller = new ImageLayoutScrollController(scroll);
  const context = { sessionKey: "local:session", scroller, pinnedToBottom: false };
  return { controller, context, scroller, anchor, restore, moveAnchor: (delta: number) => { anchorTop += delta; } };
}

describe("image layout history anchoring", () => {
  it("restores the visible message and offset without falling back to the bottom", () => {
    const { controller, context, scroller, anchor, restore, moveAnchor } = history();
    const image = {};
    controller.capture(image, context, [anchor]);
    moveAnchor(210);

    expect(controller.restore(image, context, [anchor])).toBe(true);
    expect(restore).toHaveBeenCalledExactlyOnceWith({ mode: "anchor", anchorId: "m:11", offset: -20 }, scroller, [anchor], { fallbackToBottom: false });
    expect(scroller.scrollTop).toBe(2655);
    expect(controller.restore(image, context, [anchor])).toBe(false);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("compensates an above-viewport image even while its article border is still visible", () => {
    const { controller, context, scroller, anchor, restore } = history();
    let bottom = 99;
    const imageViewport = { getBoundingClientRect: () => ({ top: -10, bottom }) };
    const image = {};
    const imageContext = { ...context, imageViewport };
    controller.capture(image, imageContext, [anchor]);
    bottom += 210;
    expect(controller.restore(image, imageContext, [anchor])).toBe(true);
    expect(scroller.scrollTop).toBe(2655);
    // The enclosing article's unchanged top cannot preserve text below the image.
    expect(restore).not.toHaveBeenCalled();
  });

  it("preserves text below an above-viewport image in the same article, including image shrinkage", () => {
    const { controller, context, scroller, restore } = history();
    let bottom = 95;
    const imageViewport = { getBoundingClientRect: () => ({ top: -300, bottom }) };
    const image = {};
    const imageContext = { ...context, imageViewport };
    controller.capture(image, imageContext, []);
    bottom -= 100;
    expect(controller.restore(image, imageContext, [])).toBe(true);
    expect(scroller.scrollTop).toBe(2345);
    expect(restore).not.toHaveBeenCalled();
  });

  it("leaves the viewport alone when the image is below the anchor or the message disappears", () => {
    const { controller, context, scroller, anchor, restore } = history();
    const image = {};
    controller.capture(image, context, [anchor]);
    expect(controller.restore(image, context, [anchor])).toBe(true);
    expect(scroller.scrollTop).toBe(2445);
    controller.capture(image, context, [anchor]);
    expect(controller.restore(image, context, [])).toBe(false);
    expect(restore.mock.results.at(-1)?.value).toMatchObject({ status: "missing" });
    expect(scroller.scrollTop).toBe(2445);
  });

  it.each(["capture", "restore"] as const)("does not correct history when pinned at %s", (phase) => {
    const { controller, context, anchor, restore } = history();
    const image = {};
    controller.capture(image, { ...context, pinnedToBottom: phase === "capture" }, [anchor]);
    expect(controller.restore(image, { ...context, pinnedToBottom: phase === "restore" }, [anchor])).toBe(false);
    expect(restore).not.toHaveBeenCalled();
  });

  it.each(["session", "viewport", "scroll", "reset"] as const)("discards a snapshot after a %s change", (change) => {
    const { controller, context, scroller, anchor, restore } = history();
    const image = {};
    controller.capture(image, context, [anchor]);
    const next = { ...context };
    if (change === "session") next.sessionKey = "remote:session";
    if (change === "viewport") next.scroller = { ...scroller };
    if (change === "scroll") scroller.scrollTop -= 60;
    if (change === "reset") controller.reset();

    expect(controller.restore(image, next, [anchor])).toBe(false);
    expect(restore).not.toHaveBeenCalled();
  });

  it("ignores unmatched image events, hidden viewports and missing visible anchors", () => {
    const { controller, context, scroller, anchor, restore } = history();
    const image = {};
    controller.capture(image, context, [anchor]);
    expect(controller.restore({}, context, [anchor])).toBe(false);
    controller.capture(image, context, []);
    expect(controller.restore(image, context, [anchor])).toBe(false);
    scroller.clientHeight = 0;
    controller.capture(image, context, [anchor]);
    expect(controller.restore(image, context, [anchor])).toBe(false);
    controller.capture(image, { ...context, scroller: undefined }, [anchor]);
    expect(controller.restore(image, context, [anchor])).toBe(false);
    expect(restore).not.toHaveBeenCalled();
  });
});
