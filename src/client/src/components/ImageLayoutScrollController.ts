import { captureScrollPosition, findVisibleScrollAnchor, hasUsableScrollViewport, type ChatAnchorScrollPosition, type ChatScrollController, type ChatScrollElement, type ChatScrollViewport } from "../chatScrollPosition";

interface ImageLayoutScrollContext {
  sessionKey: string;
  scroller: ChatScrollViewport | undefined;
  pinnedToBottom: boolean;
  imageViewport?: Pick<ChatScrollElement, "getBoundingClientRect"> | undefined;
}

interface ImageLayoutSnapshot {
  sessionKey: string;
  scroller: ChatScrollViewport;
  scrollTop: number;
  correction: { kind: "anchor"; position: ChatAnchorScrollPosition } | { kind: "above"; bottom: number };
}

/** A synchronous before/after image render pair, never a delayed history correction. */
export class ImageLayoutScrollController {
  private snapshots = new WeakMap<object, ImageLayoutSnapshot>();

  constructor(private readonly scroll: Pick<ChatScrollController, "restoreExplicitPosition">) {}

  reset(): void {
    this.snapshots = new WeakMap();
  }

  capture(image: object, context: ImageLayoutScrollContext, anchors: ChatScrollElement[]): void {
    this.snapshots.delete(image);
    const { scroller, sessionKey, pinnedToBottom } = context;
    if (pinnedToBottom || scroller === undefined || !hasUsableScrollViewport(scroller)) return;
    const viewportTop = scroller.getBoundingClientRect().top;
    const imageBottom = context.imageViewport?.getBoundingClientRect().bottom;
    // An article can still overlap the viewport by its border/padding even when
    // its image is entirely above it. Anchoring that article's unchanged top
    // would let the following text jump; compensate the image's growth instead.
    if (imageBottom !== undefined && imageBottom <= viewportTop) {
      this.snapshots.set(image, {
        sessionKey, scroller, scrollTop: scroller.scrollTop,
        correction: { kind: "above", bottom: imageBottom - viewportTop },
      });
      return;
    }
    const anchor = findVisibleScrollAnchor(scroller, anchors);
    if (anchor === undefined) return;
    this.snapshots.set(image, {
      sessionKey, scroller, scrollTop: scroller.scrollTop,
      correction: { kind: "anchor", position: captureScrollPosition(scroller, anchor) },
    });
  }

  restore(image: object, context: ImageLayoutScrollContext, anchors: ChatScrollElement[]): boolean {
    const snapshot = this.snapshots.get(image);
    this.snapshots.delete(image);
    if (snapshot === undefined || context.pinnedToBottom
      || snapshot.sessionKey !== context.sessionKey || snapshot.scroller !== context.scroller
      || snapshot.scrollTop !== context.scroller.scrollTop) return false;
    if (snapshot.correction.kind === "above") {
      const imageBottom = context.imageViewport?.getBoundingClientRect().bottom;
      if (imageBottom === undefined) return false;
      context.scroller.scrollTop += imageBottom - context.scroller.getBoundingClientRect().top - snapshot.correction.bottom;
      return true;
    }
    // A removed message must not turn an image correction into a jump to the tail.
    return this.scroll.restoreExplicitPosition(snapshot.correction.position, context.scroller, anchors, { fallbackToBottom: false }).status === "restored";
  }
}
