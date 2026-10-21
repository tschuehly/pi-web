import type { ReactiveController, ReactiveControllerHost } from "lit";

/** Subscribe to layout changes only while a menu is open; never poll idle menus. */
export class ActionMenuPositionController implements ReactiveController {
  style = "";
  private frame: number | undefined;
  private target: HTMLElement | undefined;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getTarget: () => HTMLElement | undefined,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    // Reconnecting a rendered Lit host does not necessarily schedule an update.
    // Resolve its current trigger after rendering, just as on the initial mount.
    this.host.requestUpdate();
  }

  hostUpdated(): void {
    const target = this.getTarget();
    if (target !== this.target) {
      this.stopTracking();
      if (target?.isConnected === true) this.startTracking(target);
    }
    // Lit has committed the reordered rows, so measure their new positions now.
    this.refresh();
  }

  hostDisconnected(): void {
    this.stopTracking();
  }

  private startTracking(target: HTMLElement): void {
    this.target = target;
    const listen = (source: EventTarget, type: string, capture = false): void => {
      source.addEventListener(type, this.scheduleRefresh, { capture, passive: true });
      this.cleanups.push(() => { source.removeEventListener(type, this.scheduleRefresh, capture); });
    };
    listen(window, "resize");
    listen(window, "scroll", true);
    const viewport = window.visualViewport;
    if (viewport) {
      listen(viewport, "resize");
      listen(viewport, "scroll");
    }

    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(this.scheduleRefresh);
    if (observer) this.cleanups.push(() => { observer.disconnect(); });
    observer?.observe(target);
    // Scroll events do not cross shadow boundaries. Subscribe in every ancestor
    // shadow root, including the navigation shell outside the list component.
    let ancestor: Element = target;
    for (;;) {
      const root = ancestor.getRootNode();
      if (!(root instanceof ShadowRoot)) break;
      listen(root, "scroll", true);
      observer?.observe(root.host);
      ancestor = root.host;
    }
  }

  private stopTracking(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.target = undefined;
  }

  private readonly scheduleRefresh = (): void => {
    this.frame ??= requestAnimationFrame(this.onFrame);
  };

  private readonly onFrame = (): void => {
    this.frame = undefined;
    this.refresh();
  };

  private refresh(): void {
    const target = this.target;
    if (target?.isConnected !== true) {
      this.stopTracking();
      return;
    }
    const style = actionMenuPanelStyle(target, { constrainTo: "viewport" });
    if (style !== this.style) {
      this.style = style;
      this.host.requestUpdate();
    }
  }
}

const ACTION_MENU_GAP_PX = 0;
const ACTION_MENU_MIN_USEFUL_HEIGHT_PX = 120;

interface ActionMenuRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface ActionMenuPanelStyleOptions {
  constrainTo?: "host" | "viewport";
}

export function actionMenuPanelStyle(target: EventTarget | null, options: ActionMenuPanelStyleOptions = {}): string {
  if (typeof HTMLElement === "undefined" || typeof window === "undefined" || !(target instanceof HTMLElement)) return "";
  const trigger = target.getBoundingClientRect();
  const bounds = options.constrainTo === "viewport" ? viewportBounds() : actionMenuBounds(target);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const viewport = viewportBounds();
  const leftBound = Math.max(viewport.left, bounds.left);
  const rightBound = Math.min(viewport.right, bounds.right);
  const topBound = Math.max(viewport.top, bounds.top);
  const bottomBound = Math.min(viewport.bottom, bounds.bottom);
  // Scrolling or keyboard panning can carry the trigger outside the visible
  // viewport. Keep its menu reachable at the nearest visible edge.
  const triggerRight = clamp(trigger.right, leftBound, rightBound);
  const triggerTop = clamp(trigger.top, topBound, bottomBound);
  const triggerBottom = clamp(trigger.bottom, topBound, bottomBound);
  const availableBelow = bottomBound - triggerBottom - ACTION_MENU_GAP_PX;
  const availableAbove = triggerTop - topBound - ACTION_MENU_GAP_PX;
  const placement = availableBelow < ACTION_MENU_MIN_USEFUL_HEIGHT_PX && availableAbove > availableBelow
    ? [`bottom: ${px(viewportHeight - triggerTop + ACTION_MENU_GAP_PX)};`, `max-height: ${px(Math.max(0, availableAbove))};`]
    : [`top: ${px(triggerBottom + ACTION_MENU_GAP_PX)};`, `max-height: ${px(Math.max(0, availableBelow))};`];

  return [
    ...placement,
    `right: ${px(Math.max(0, viewportWidth - triggerRight))};`,
    `max-width: ${px(Math.max(0, triggerRight - leftBound))};`,
  ].join(" ");
}

function actionMenuBounds(target: HTMLElement): ActionMenuRect {
  const root = target.getRootNode();
  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot && root.host instanceof HTMLElement) return root.host.getBoundingClientRect();
  return viewportBounds();
}

function viewportBounds(): ActionMenuRect {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  return { top, right: left + (viewport?.width ?? window.innerWidth), bottom: top + (viewport?.height ?? window.innerHeight), left };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function px(value: number): string {
  return `${String(Math.round(value))}px`;
}
