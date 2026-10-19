/** A trackpad's horizontal wheel samples: time (ms) and deltaX (px). */
export interface SwipeSample { t: number; dx: number }

const SWIPE_END_MS = 150;
const SETTLE_MS = 230;
const COMMIT_FRACTION = 0.3;
const FLICK_PX_PER_MS = 0.8;
const FLICK_MIN_PX = 20;
const VELOCITY_WINDOW_MS = 100;
/** Past the first or last tab the Chat follows the fingers at a quarter of their distance. */
const RUBBER_BAND = 0.25;

/** Whether a swipe of `distance` (summed deltaX) moves to the neighbour: a third of the width, or a flick that way. */
export function swipeCommits(distance: number, width: number, samples: readonly SwipeSample[], hasNeighbour: boolean): boolean {
  const direction = Math.sign(distance);
  if (direction === 0 || !hasNeighbour) return false;
  const last = samples.at(-1)?.t ?? 0;
  const recent = samples.filter((sample) => last - sample.t <= VELOCITY_WINDOW_MS);
  const velocity = recent.reduce((sum, sample) => sum + sample.dx, 0) / Math.max(16, last - (recent[0]?.t ?? last));
  const flick = Math.abs(velocity) > FLICK_PX_PER_MS && Math.sign(velocity) === direction && Math.abs(distance) > FLICK_MIN_PX;
  return Math.abs(distance) > COMMIT_FRACTION * width || flick;
}

export function swipeOffset(distance: number, hasNeighbour: boolean): number {
  return -distance * (hasNeighbour ? 1 : RUBBER_BAND);
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

/**
 * Two-finger horizontal swipes between tabs: the Chat on screen follows the fingers and its neighbour's preview
 * slides in beside it; letting go past a third of the width, or flicking, moves to that neighbour.
 */
export class TabSwipeController {
  private swipe: { order: readonly string[]; index: number; distance: number; samples: SwipeSample[]; ignore: boolean; timer: ReturnType<typeof setTimeout> | undefined } | undefined;

  constructor(private readonly host: TabSwipeHost, private readonly now: () => number = () => performance.now()) {}

  readonly onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey) return;
    if (this.swipe === undefined) {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const track = this.host.track();
      if (track === undefined) return;
      this.swipe = { order: track.order, index: track.order.indexOf(track.current), distance: 0, samples: [], ignore: scrollsHorizontally(event), timer: undefined };
    }
    const swipe = this.swipe;
    clearTimeout(swipe.timer);
    swipe.timer = setTimeout(() => { this.end(); }, SWIPE_END_MS);
    if (swipe.ignore) return;
    event.preventDefault();
    const before = Math.sign(swipe.distance);
    swipe.distance += event.deltaX;
    swipe.samples.push({ t: this.now(), dx: event.deltaX });
    if (Math.sign(swipe.distance) !== before) this.host.peek(this.neighbour(swipe));
    this.paint();
  };

  cancel(): void {
    const swipe = this.swipe;
    this.swipe = undefined;
    if (swipe !== undefined) clearTimeout(swipe.timer);
    this.reset();
  }

  private neighbour(swipe: { order: readonly string[]; index: number; distance: number }): string | undefined {
    return swipe.order[swipe.index + Math.sign(swipe.distance)];
  }

  private paint(): void {
    const swipe = this.swipe;
    const surfaces = this.host.surfaces();
    if (swipe === undefined || surfaces === undefined) return;
    const width = surfaces.current.offsetWidth;
    const neighbour = this.neighbour(swipe);
    const x = swipeOffset(swipe.distance, neighbour !== undefined);
    surfaces.current.style.transition = "none";
    surfaces.current.style.transform = `translateX(${String(x)}px)`;
    if (surfaces.peek !== null) {
      surfaces.peek.style.visibility = "visible";
      surfaces.peek.style.transition = "none";
      surfaces.peek.style.transform = `translateX(${String(Math.sign(swipe.distance) * width + x)}px)`;
    }
  }

  private end(): void {
    const swipe = this.swipe;
    this.swipe = undefined;
    const surfaces = this.host.surfaces();
    if (swipe === undefined || swipe.ignore || swipe.samples.length === 0 || surfaces === undefined) { this.reset(); return; }
    const width = surfaces.current.offsetWidth;
    const direction = Math.sign(swipe.distance);
    const target = this.neighbour(swipe);
    const commit = target !== undefined && swipeCommits(swipe.distance, width, swipe.samples, true);
    const ease = "transform .22s cubic-bezier(.2,.8,.2,1)";
    surfaces.current.style.transition = ease;
    surfaces.current.style.transform = commit ? `translateX(${String(-direction * width)}px)` : "";
    if (surfaces.peek !== null) {
      surfaces.peek.style.transition = ease;
      surfaces.peek.style.transform = commit ? "translateX(0)" : `translateX(${String(direction * width)}px)`;
    }
    setTimeout(() => {
      if (commit) void this.host.commit(target).finally(() => { this.reset(); });
      else this.reset();
    }, SETTLE_MS);
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
