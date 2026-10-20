// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swipeCommits, TabSwipeController, type TabSwipeHost } from "./tabSwipeController";

describe("swipe decision", () => {
  const steady = (count: number, dx: number) => Array.from({ length: count }, (_, index) => ({ t: index * 16, dx }));

  it("moves on past a third of the width or on a flick that way", () => {
    expect(swipeCommits(350, 1000, steady(40, 8.75))).toBe(true);
    expect(swipeCommits(250, 1000, steady(40, 6.25))).toBe(false);
    expect(swipeCommits(60, 1000, steady(3, 20))).toBe(true);
    expect(swipeCommits(60, 1000, [...steady(3, 20), { t: 48, dx: -40 }])).toBe(false);
    expect(swipeCommits(-400, 1000, steady(40, -10))).toBe(true);
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

  /** Plays deltaX samples 16ms apart; returns the clock (Date.now) at each sample. */
  const play = (controller: TabSwipeController, deltas: readonly number[]) => deltas.map((deltaX) => { const at = Date.now(); swipe(controller, deltaX); return at; });
  /** The first sample at which the swipe so far qualifies to move on. */
  const qualifying = (deltas: readonly number[]) => deltas.findIndex((_, index) => {
    const samples = deltas.slice(0, index + 1).map((dx, at) => ({ t: at * 16, dx }));
    return swipeCommits(samples.reduce((sum, sample) => sum + sample.dx, 0), 1000, samples);
  });

  it("follows the fingers, then moves to the neighbour the moment the swipe goes past a third of the width", async () => {
    const controller = new TabSwipeController(host, () => time);
    // The first 8px leave the axis undecided, so that event still goes to the page.
    for (let step = 0; step < 20; step += 1) expect(swipe(controller, 8).defaultPrevented).toBe(step > 0);

    expect(host.peeked).toEqual(["c"]);
    expect(current.style.transform).toBe("translateX(-160px)");
    expect(peek?.style.transform).toBe("translateX(840px)");
    for (let step = 0; step < 17; step += 1) swipe(controller, 8);
    expect(host.committed).toEqual([]);
    swipe(controller, 8);
    expect(host.committed).toEqual(["c"]);
    expect(current.style.transform).toBe("translateX(-1000px)");
    expect(peek?.style.transform).toBe("translateX(0)");
    await vi.advanceTimersByTimeAsync(200);
    expect(current.style.transform).toBe("");
    expect(host.peeked.at(-1)).toBeUndefined();
  });

  it("moves exactly one tab on a flick, without waiting for its momentum tail, and the next swipe moves again", async () => {
    const commits: number[] = [];
    host.commit = (sessionId) => { commits.push(Date.now()); host.committed.push(sessionId); return Promise.resolve(); };
    const controller = new TabSwipeController(host, () => time);
    const flick = [10, 20, 30, 40, 40, 35, 30, 25, 20, 16, 13, 10, 8, 6, 5, 4, 3, 2, 1, 1, 1, 1];
    const times = play(controller, flick);

    expect(host.committed).toEqual(["c"]);
    const delay = (commits[0] ?? Number.NaN) - (times[qualifying(flick)] ?? Number.NaN);
    expect(delay).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(host.committed).toEqual(["c"]);

    play(controller, flick);
    expect(host.committed).toEqual(["c", "c"]);
  });

  it("snaps back from a slow small drag, or one let go before it went far enough, ignoring its momentum", async () => {
    const controller = new TabSwipeController(host, () => time);
    play(controller, Array.from({ length: 20 }, () => -2));
    expect(current.style.transform).toBe("translateX(40px)");
    await vi.advanceTimersByTimeAsync(500);
    expect(host.peeked).toEqual(["a", undefined]);
    expect(host.committed).toEqual([]);
    expect(current.style.transform).toBe("");

    // Steady 6px samples, then decaying ones: the fingers lifted at 60px, and the momentum must not carry it on.
    play(controller, [...Array.from({ length: 10 }, () => 6), 5, 4, 3, 2]);
    expect(current.style.transform).toBe("");
    play(controller, Array.from({ length: 30 }, () => 12));
    await vi.advanceTimersByTimeAsync(500);
    expect(host.committed).toEqual([]);
  });

  it("never moves the Chat for a vertical scroll with sideways jitter, momentum included, and still swipes at once after it", () => {
    const controller = new TabSwipeController(host, () => time);
    // The first event alone leans sideways; the gesture still locks vertical once it moved 10px.
    const scroll = [[3, 1], [-3, 8], [3, 15], ...Array.from({ length: 30 }, (_, index) => [index % 2 === 0 ? 3 : -3, 20]), [30, 2], [30, 2], [-3, 6], [3, 3], [-3, 1]];
    const prevented = scroll.map(([deltaX = 0, deltaY = 0]) => {
      const event = swipe(controller, deltaX, deltaY);
      expect(current.style.transform).toBe("");
      return event.defaultPrevented;
    });

    expect(prevented.some(Boolean)).toBe(false);
    expect(host.peeked).toEqual([]);
    expect(host.committed).toEqual([]);
    vi.advanceTimersByTime(200);
    play(controller, [10, 20, 30]);
    expect(host.committed).toEqual(["c"]);
  });

  it("leaves the Chat still until the gesture locks sideways", () => {
    const controller = new TabSwipeController(host, () => time);
    expect(swipe(controller, 6).defaultPrevented).toBe(false);
    expect(current.style.transform).toBe("");
    expect(host.peeked).toEqual([]);
    expect(swipe(controller, 6).defaultPrevented).toBe(true);
    expect(host.peeked).toEqual(["c"]);
    expect(current.style.transform).toBe("translateX(-12px)");
  });

  it.each([
    ["the last tab, swiping on", ["a", "b", "c"], "c", 20],
    ["the first tab, swiping back", ["a", "b", "c"], "a", -20],
    ["the only tab, swiping on", ["a"], "a", 20],
    ["the only tab, swiping back", ["a"], "a", -20],
  ] as const)("does nothing at all on %s: no movement, no commit, the page keeps the events", async (_, order, at, deltaX) => {
    host.track = () => ({ order, current: at });
    const controller = new TabSwipeController(host, () => time);
    const prevented = Array.from({ length: 30 }, () => {
      const event = swipe(controller, deltaX);
      expect(current.style.transform).toBe("");
      return event.defaultPrevented;
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(prevented.some(Boolean)).toBe(false);
    expect(current.style.transform).toBe("");
    expect(host.peeked).toEqual([]);
    expect(host.committed).toEqual([]);
  });

  it("puts the Chat back once a slow move lands, though a vertical scroll began meanwhile, and swallows sideways gestures until then", async () => {
    let land!: () => void;
    host.commit = (sessionId) => { host.committed.push(sessionId); return new Promise<void>((resolve) => { land = resolve; }); };
    const controller = new TabSwipeController(host, () => time);
    swipe(controller, 40);
    expect(host.committed).toEqual(["c"]);
    expect(current.style.transform).toBe("translateX(-1000px)");
    await vi.advanceTimersByTimeAsync(300);
    // A new sideways gesture while the move is pending neither moves the Chat nor moves on again.
    for (let step = 0; step < 10; step += 1) expect(swipe(controller, 40).defaultPrevented).toBe(true);
    expect(host.committed).toEqual(["c"]);
    expect(current.style.transform).toBe("translateX(-1000px)");
    await vi.advanceTimersByTimeAsync(300);
    for (let step = 0; step < 5; step += 1) swipe(controller, 0, 20);
    land();
    for (let step = 0; step < 5; step += 1) swipe(controller, 0, 20);
    await vi.advanceTimersByTimeAsync(0);
    expect(current.style.transform).toBe("");
    expect(host.peeked.at(-1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300);
    play(controller, [10, 20, 30]);
    expect(host.committed).toEqual(["c", "c"]);
  });

  it("shows the neighbour's preview before the Chat slides away, while moving on at once", async () => {
    // The host renders the preview on its next update, as Lit does.
    host.peek = (sessionId) => {
      host.peeked.push(sessionId);
      return Promise.resolve().then(() => { peek = sessionId === undefined ? null : document.createElement("div"); });
    };
    const controller = new TabSwipeController(host, () => time);
    swipe(controller, 40);
    expect(host.committed).toEqual(["c"]);
    expect(current.style.transform).not.toBe("translateX(-1000px)");
    await vi.advanceTimersByTimeAsync(0);
    expect(peek?.style.visibility).toBe("visible");
    expect(peek?.style.transform).toBe("translateX(0)");
    expect(current.style.transform).toBe("translateX(-1000px)");
    await vi.advanceTimersByTimeAsync(200);
    expect(current.style.transform).toBe("");
  });

  it("ignores vertical scrolling, and swipes only where the host allows", () => {
    const controller = new TabSwipeController(host, () => time);
    expect(swipe(controller, 5, 40).defaultPrevented).toBe(false);
    host.track = () => undefined;
    expect(swipe(controller, 40).defaultPrevented).toBe(false);
  });
});
