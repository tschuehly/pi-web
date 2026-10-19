// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swipeCommits, swipeOffset, TabSwipeController, type TabSwipeHost } from "./tabSwipeController";

describe("swipe decision", () => {
  const steady = (count: number, dx: number) => Array.from({ length: count }, (_, index) => ({ t: index * 16, dx }));

  it("moves on past a third of the width or on a flick that way, never past the last tab", () => {
    expect(swipeCommits(350, 1000, steady(40, 8.75), true)).toBe(true);
    expect(swipeCommits(250, 1000, steady(40, 6.25), true)).toBe(false);
    expect(swipeCommits(60, 1000, steady(3, 20), true)).toBe(true);
    expect(swipeCommits(60, 1000, [...steady(3, 20), { t: 48, dx: -40 }], true)).toBe(false);
    expect(swipeCommits(-400, 1000, steady(40, -10), true)).toBe(true);
    expect(swipeCommits(400, 1000, steady(40, 10), false)).toBe(false);
  });

  it("follows the fingers, with a rubber band past the ends", () => {
    expect(swipeOffset(100, true)).toBe(-100);
    expect(swipeOffset(100, false)).toBe(-25);
  });
});

describe("tab swipe", () => {
  let current: HTMLElement;
  let peek: HTMLElement | null;
  let host: TabSwipeHost & { peeked: (string | undefined)[]; committed: string[] };
  let time = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    current = document.createElement("main");
    Object.defineProperty(current, "offsetWidth", { value: 1000 });
    document.body.append(current);
    peek = null;
    host = {
      peeked: [],
      committed: [],
      track: () => ({ order: ["a", "b", "c"], current: "b" }),
      surfaces: () => ({ current, peek }),
      peek: (sessionId) => {
        host.peeked.push(sessionId);
        peek = sessionId === undefined ? null : document.createElement("div");
      },
      commit: (sessionId) => { host.committed.push(sessionId); return Promise.resolve(); },
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  const swipe = (controller: TabSwipeController, deltaX: number, deltaY = 0) => {
    const event = new WheelEvent("wheel", { deltaX, deltaY, cancelable: true });
    current.dispatchEvent(event);
    controller.onWheel(event);
    time += 16;
    vi.advanceTimersByTime(16);
    return event;
  };

  it("slides the neighbour in and moves to it once let go far enough", async () => {
    const controller = new TabSwipeController(host, () => time);
    for (let step = 0; step < 20; step += 1) expect(swipe(controller, 20).defaultPrevented).toBe(true);

    expect(host.peeked).toEqual(["c"]);
    expect(current.style.transform).toBe("translateX(-400px)");
    expect(peek?.style.transform).toBe("translateX(600px)");
    await vi.advanceTimersByTimeAsync(500);
    expect(host.committed).toEqual(["c"]);
    expect(current.style.transform).toBe("");
    expect(host.peeked.at(-1)).toBeUndefined();
  });

  it("snaps back from a short swipe, ignores vertical scrolling, and swipes only where the host allows", async () => {
    const controller = new TabSwipeController(host, () => time);
    for (let step = 0; step < 6; step += 1) swipe(controller, -5);
    await vi.advanceTimersByTimeAsync(500);
    expect(host.peeked).toEqual(["a", undefined]);
    expect(host.committed).toEqual([]);

    expect(swipe(controller, 5, 40).defaultPrevented).toBe(false);
    host.track = () => undefined;
    expect(swipe(controller, 40).defaultPrevented).toBe(false);
  });
});
