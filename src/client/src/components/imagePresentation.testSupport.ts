import type { LitElement } from "lit";
import { vi } from "vitest";
import { ImagePresentation } from "./ImagePresentation";

export function imagePresentation(host: LitElement): ImagePresentation {
  const presentation = host.renderRoot.querySelector<ImagePresentation>("pi-web-image-presentation");
  if (presentation === null) throw new Error("Expected image presentation");
  return presentation;
}

export async function settleImage(host: LitElement): Promise<ImagePresentation> {
  await host.updateComplete;
  await host.updateComplete;
  const presentation = imagePresentation(host);
  await presentation.updateComplete;
  return presentation;
}

/** Observer notifications, not simulated layout, are the component's browser boundary. */
export class ImageIntersectionObserver implements IntersectionObserver {
  static instances: ImageIntersectionObserver[] = [];
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = "0px";
  readonly thresholds: readonly number[] = [0];
  private target: Element | undefined;
  readonly disconnect = vi.fn();
  readonly unobserve = vi.fn();
  readonly observe = vi.fn((target: Element) => { this.target = target; });

  constructor(private readonly callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    ImageIntersectionObserver.instances.push(this);
  }

  takeRecords(): IntersectionObserverEntry[] { return []; }

  notify(isIntersecting = true): void {
    if (this.target === undefined) throw new Error("Expected observed image");
    this.callback([{
      target: this.target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
      time: 0, rootBounds: null, boundingClientRect: new DOMRectReadOnly(), intersectionRect: new DOMRectReadOnly(),
    }], this);
  }
}

export function latestImageObserver(): ImageIntersectionObserver {
  const observer = ImageIntersectionObserver.instances.at(-1);
  if (observer === undefined) throw new Error("Expected image observer");
  return observer;
}
