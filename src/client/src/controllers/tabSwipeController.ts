/** A trackpad's horizontal wheel samples: time (ms) and deltaX (px). */
export interface SwipeSample { t: number; dx: number }

/** A gesture ends after this long without wheel events; until then its momentum tail is swallowed. */
const QUIET_MS = 150;
/** The slide to the neighbour, or back, once a swipe is decided. */
const SETTLE_MS = 150;
/** A gesture picks its axis once it moved this far; sideways only if it went at least twice as far across as down. */
const AXIS_LOCK_PX = 10;
const HORIZONTAL_RATIO = 2;
/** Fingers lifted: this many samples in a row, each smaller than the last, ending under half the peak. */
const RELEASE_DECAY_SAMPLES = 3;
const COMMIT_FRACTION = 0.3;
const FLICK_PX_PER_MS = 0.8;
const FLICK_MIN_PX = 20;
const VELOCITY_WINDOW_MS = 100;

/** Whether a swipe of `distance` (summed deltaX) moves to the neighbour: a third of the width, or a flick that way. */
export function swipeCommits(distance: number, width: number, samples: readonly SwipeSample[]): boolean {
  const direction = Math.sign(distance);
  if (direction === 0) return false;
  const last = samples.at(-1)?.t ?? 0;
  const recent = samples.filter((sample) => last - sample.t <= VELOCITY_WINDOW_MS);
  const velocity = recent.reduce((sum, sample) => sum + sample.dx, 0) / Math.max(16, last - (recent[0]?.t ?? last));
  const flick = Math.abs(velocity) > FLICK_PX_PER_MS && Math.sign(velocity) === direction && Math.abs(distance) > FLICK_MIN_PX;
  return Math.abs(distance) > COMMIT_FRACTION * width || flick;
}

/** Whether the wheel starts over something that scrolls sideways itself (a code block, a table). */
function scrollsHorizontally(event: WheelEvent): boolean {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    const overflow = getComputedStyle(node).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollWidth > node.clientWidth + 1
      && (event.deltaX > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0)) return true;
  }
  return false;
}

export interface TabSwipeHost {
  /** The Chats to swipe through and the one on screen, or undefined where swiping does not apply. */
  track(): { order: readonly string[]; current: string } | undefined;
  /** The Chat on screen and the neighbour preview beside it, once rendered. */
  surfaces(): { current: HTMLElement; peek: HTMLElement | null } | undefined;
  /** Show (or with undefined hide) the neighbour preview. */
  peek(sessionId: string | undefined): void;
  /** Show the neighbour; the preview stays in place until this settles. */
  commit(sessionId: string): Promise<void>;
}

interface Swipe {
  order: readonly string[];
  index: number;
  distance: number;
  samples: SwipeSample[];
  /** Undecided until the gesture moved AXIS_LOCK_PX; a vertical gesture leaves every delta, momentum included, alone. */
  axis: "pending" | "horizontal" | "vertical";
  /** Movement while the axis is pending. */
  travel: { x: number; y: number };
  /** Over something that scrolls sideways itself: the gesture is left alone. */
  ignore: boolean;
  /** The direction whose neighbour preview shows. */
  peeked: number;
  /** Moved on or snapping back: the rest of the gesture, momentum included, is swallowed. */
  decided: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Whether the latest samples decay like momentum after the fingers lift. */
function released(samples: readonly SwipeSample[]): boolean {
  const tail = samples.slice(-RELEASE_DECAY_SAMPLES - 1).map((sample) => Math.abs(sample.dx));
  const peak = Math.max(...samples.map((sample) => Math.abs(sample.dx)));
  return tail.length > RELEASE_DECAY_SAMPLES && tail.every((dx, index) => index === 0 || dx < (tail[index - 1] ?? 0)) && (tail.at(-1) ?? 0) < peak / 2;
}

/**
 * Two-finger horizontal swipes between tabs: the Chat on screen follows the fingers and its neighbour's preview
 * slides in beside it. The moment the swipe goes past a third of the width or flicks that way, it moves to that
 * neighbour; fingers lifted before then snap it back. Either way the rest of the gesture is swallowed until a quiet
 * gap, so one swipe moves at most one tab however long its momentum runs. Like macOS, a gesture locks its axis after
 * its first few pixels: a vertical scroll's sideways drift never moves the Chat.
 */
export class TabSwipeController {
  private swipe: Swipe | undefined;

  constructor(private readonly host: TabSwipeHost, private readonly now: () => number = () => performance.now()) {}

  readonly onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey) return;
    if (this.swipe === undefined) {
      const track = this.host.track();
      if (track === undefined) return;
      this.swipe = { order: track.order, index: track.order.indexOf(track.current), distance: 0, samples: [], axis: "pending", travel: { x: 0, y: 0 }, ignore: false, peeked: 0, decided: false, timer: undefined };
    }
    const swipe = this.swipe;
    clearTimeout(swipe.timer);
    swipe.timer = setTimeout(() => { this.end(swipe); }, QUIET_MS);
    if (swipe.axis === "pending") {
      swipe.travel.x += event.deltaX;
      swipe.travel.y += event.deltaY;
      swipe.distance += event.deltaX;
      swipe.samples.push({ t: this.now(), dx: event.deltaX });
      const { x, y } = swipe.travel;
      if (Math.abs(x) + Math.abs(y) < AXIS_LOCK_PX) return;
      swipe.axis = Math.abs(x) >= HORIZONTAL_RATIO * Math.abs(y) ? "horizontal" : "vertical";
      // Towards no tab (the first, the last or the only one) a swipe is not ours: the page keeps it.
      swipe.ignore = swipe.axis === "horizontal" && (this.neighbour(swipe) === undefined || scrollsHorizontally(event));
    } else if (swipe.axis === "horizontal" && !swipe.ignore && !swipe.decided) {
      swipe.distance += event.deltaX;
      swipe.samples.push({ t: this.now(), dx: event.deltaX });
    }
    if (swipe.axis === "vertical" || swipe.ignore) return;
    event.preventDefault();
    if (swipe.decided) return;
    if (Math.sign(swipe.distance) !== swipe.peeked) {
      swipe.peeked = Math.sign(swipe.distance);
      this.host.peek(this.neighbour(swipe));
    }
    const surfaces = this.host.surfaces();
    if (surfaces === undefined) return;
    const target = this.neighbour(swipe);
    if (target !== undefined && swipeCommits(swipe.distance, surfaces.current.offsetWidth, swipe.samples)) this.settle(swipe, target);
    else if (released(swipe.samples)) this.settle(swipe, undefined);
    else this.paint(swipe, surfaces);
  };

  cancel(): void {
    const swipe = this.swipe;
    this.swipe = undefined;
    if (swipe !== undefined) clearTimeout(swipe.timer);
    this.reset();
  }

  private neighbour(swipe: Swipe): string | undefined {
    return swipe.order[swipe.index + Math.sign(swipe.distance)];
  }

  private paint(swipe: Swipe, surfaces: { current: HTMLElement; peek: HTMLElement | null }): void {
    const width = surfaces.current.offsetWidth;
    // Turned back past where it started, towards no tab: the Chat rests.
    const x = this.neighbour(swipe) === undefined ? 0 : -swipe.distance;
    surfaces.current.style.transition = "none";
    surfaces.current.style.transform = `translateX(${String(x)}px)`;
    if (surfaces.peek !== null) {
      surfaces.peek.style.visibility = "visible";
      surfaces.peek.style.transition = "none";
      surfaces.peek.style.transform = `translateX(${String(Math.sign(swipe.distance) * width + x)}px)`;
    }
  }

  /** The gesture went quiet: one that never decided snaps back, and the next wheel event starts a new one. */
  private end(swipe: Swipe): void {
    if (this.swipe === swipe) this.swipe = undefined;
    if (swipe.axis === "horizontal" && !swipe.ignore && !swipe.decided) this.settle(swipe, undefined);
  }

  /** Slides to `target` and shows it at once, or with undefined slides back; the preview stays until both are done, unless a new swipe took over. */
  private settle(swipe: Swipe, target: string | undefined): void {
    swipe.decided = true;
    const surfaces = this.host.surfaces();
    if (surfaces === undefined) { this.reset(); return; }
    const width = surfaces.current.offsetWidth;
    const direction = Math.sign(swipe.distance);
    const ease = `transform ${String(SETTLE_MS)}ms cubic-bezier(.2,.8,.2,1)`;
    surfaces.current.style.transition = ease;
    surfaces.current.style.transform = target === undefined ? "" : `translateX(${String(-direction * width)}px)`;
    if (surfaces.peek !== null) {
      surfaces.peek.style.transition = ease;
      surfaces.peek.style.transform = target === undefined ? `translateX(${String(direction * width)}px)` : "translateX(0)";
    }
    const slid = new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });
    void Promise.all([slid, target === undefined ? undefined : this.host.commit(target)]).finally(() => { if (this.swipe === undefined || this.swipe === swipe) this.reset(); });
  }
  private reset(): void {
    const surfaces = this.host.surfaces();
    if (surfaces !== undefined) {
      surfaces.current.style.transition = "";
      surfaces.current.style.transform = "";
    }
    this.host.peek(undefined);
  }
}
