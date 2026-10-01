// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptImage } from "./TranscriptImage";
import type { ImagePresentation } from "./ImagePresentation";
import { ImageIntersectionObserver, latestImageObserver, settleImage } from "./imagePresentation.testSupport";

const mediaId = "abc012".repeat(10) + "abcd";
const reference = { type: "image" as const, mediaId, mimeType: "image/png", byteSize: 42 };

beforeEach(() => {
  ImageIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", ImageIntersectionObserver);
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function mount(parent?: HTMLElement) {
  const root = document.createElement("div");
  root.setAttribute("data-image-scroll-root", "");
  document.body.append(root);
  if (parent !== undefined) root.append(parent);
  const image = new TranscriptImage();
  image.imagePart = reference;
  image.session = { id: "session /?#%", cwd: "/repo with spaces/?#%" };
  image.machineId = "remote /?#%";
  (parent ?? root).append(image);
  const presentation = await settleImage(image);
  return { image, presentation, root };
}

function nativeImage(presentation: ImagePresentation): HTMLImageElement {
  const image = presentation.renderRoot.querySelector<HTMLImageElement>("img");
  if (image === null) throw new Error("Expected native image");
  return image;
}

function button(presentation: ImagePresentation, selector = "button"): HTMLButtonElement {
  const control = presentation.renderRoot.querySelector<HTMLButtonElement>(selector);
  if (control === null) throw new Error("Expected image button");
  return control;
}

describe("transcript image loading and presentation", () => {
  it("keeps references inert until near the chat viewport, then uses the encoded nested selected-machine URL", async () => {
    vi.stubEnv("BASE_URL", "/nested/pi-web/");
    const { image, presentation, root } = await mount();
    expect(presentation.renderRoot.querySelector("img")).toBeNull();
    expect(button(presentation).textContent).toContain("Show image");
    expect(button(presentation).textContent).toContain("attached image");
    const observer = latestImageObserver();
    expect(observer.root).toBe(root);
    expect(observer.rootMargin).toBe("300px 0px");
    expect(observer.observe).toHaveBeenCalledWith(image);
    observer.notify(false);
    await settleImage(image);
    expect(presentation.renderRoot.querySelector("img")).toBeNull();

    observer.notify();
    await settleImage(image);
    const native = nativeImage(presentation);
    const url = new URL(native.src);
    expect(url.pathname).toBe(`/nested/pi-web/api/machines/remote%20%2F%3F%23%25/sessions/session%20%2F%3F%23%25/media/${mediaId}`);
    expect(url.searchParams.get("cwd")).toBe("/repo with spaces/?#%");
    expect(native.getAttribute("decoding")).toBe("async");
    expect(presentation.renderRoot.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(presentation.renderRoot.querySelector('[role="status"]')?.textContent).toContain("Loading image");
    expect(observer.disconnect).toHaveBeenCalledOnce();
    native.dispatchEvent(new Event("load"));
    await presentation.updateComplete;
    expect(presentation.renderRoot.querySelector(".placeholder")).toBeNull();
    expect(presentation.renderRoot.querySelector("code")).toBeNull();
    expect(button(presentation, ".image-button").disabled).toBe(false);
  });

  it("supports Show image, error and Retry, then enlarges with click, Enter and Space", async () => {
    const { image, presentation } = await mount();
    const open = vi.fn<(event: Event) => void>();
    image.addEventListener("image-open", open);
    button(presentation).click();
    await settleImage(image);
    const failed = nativeImage(presentation);
    failed.dispatchEvent(new Event("error"));
    await presentation.updateComplete;
    expect(presentation.renderRoot.querySelector('[role="status"]')?.textContent).toContain("Image unavailable");
    expect(presentation.renderRoot.querySelector("img")).toBeNull();
    expect(button(presentation).textContent).toBe("Retry");
    button(presentation).click();
    await presentation.updateComplete;
    const retried = nativeImage(presentation);
    expect(retried).not.toBe(failed);
    expect(retried.src).toBe(failed.src);
    retried.dispatchEvent(new Event("load"));
    await presentation.updateComplete;
    const enlarge = button(presentation, ".image-button");
    expect(enlarge.getAttribute("aria-label")).toBe("Enlarge attached image");
    enlarge.click();
    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
      enlarge.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(open).toHaveBeenCalledTimes(3);
    for (const [event] of open.mock.calls) expect(event).toMatchObject({ detail: { src: retried.src, alt: "attached image" } });
  });

  it("keeps legacy inline images deferred and loads them without binary requests", async () => {
    const { image, presentation } = await mount();
    image.imagePart = { type: "image", mimeType: "image/jpeg", data: "QUJD" };
    await settleImage(image);
    expect(presentation.renderRoot.querySelector("img")).toBeNull();
    latestImageObserver().notify();
    await settleImage(image);
    expect(nativeImage(presentation).src).toBe("data:image/jpeg;base64,QUJD");
  });

  it("disconnects stale observers on source changes/removal and rearms on reconnect", async () => {
    const { image, presentation, root } = await mount();
    const stale = latestImageObserver();
    image.imagePart = { ...reference, mediaId: "f".repeat(64) };
    await settleImage(image);
    expect(stale.disconnect).toHaveBeenCalledOnce();
    stale.notify();
    await settleImage(image);
    expect(presentation.renderRoot.querySelector("img")).toBeNull();
    const current = latestImageObserver();
    image.remove();
    expect(current.disconnect).toHaveBeenCalledOnce();
    current.notify();
    await image.updateComplete;
    expect(presentation.renderRoot.querySelector("img")).toBeNull();
    root.append(image);
    await settleImage(image);
    latestImageObserver().notify();
    await settleImage(image);
    expect(nativeImage(presentation).src).toContain(`/media/${"f".repeat(64)}?`);
  });

  it("ignores a late native load from the previous source", async () => {
    const { image, presentation } = await mount();
    latestImageObserver().notify();
    await settleImage(image);
    const previous = nativeImage(presentation);
    image.machineId = "another machine";
    await settleImage(image);
    latestImageObserver().notify();
    await settleImage(image);
    previous.dispatchEvent(new Event("load"));
    await presentation.updateComplete;
    expect(presentation.renderRoot.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(nativeImage(presentation).src).toContain("/machines/another%20machine/");
  });

  it.each([true, false])("does not eagerly load collapsed nested details (observer available: %s)", async (available) => {
    if (!available) vi.stubGlobal("IntersectionObserver", undefined);
    const outer = document.createElement("details");
    const inner = document.createElement("details");
    inner.open = true;
    outer.append(inner);
    const { image, presentation } = await mount(outer);
    inner.append(image);
    // Moving across disclosure parents disconnects/reconnects the element.
    await settleImage(image);
    expect(ImageIntersectionObserver.instances).toHaveLength(0);
    expect(presentation.renderRoot.querySelector("img")).toBeNull();
    outer.open = true;
    outer.dispatchEvent(new Event("toggle"));
    await settleImage(image);
    if (available) {
      inner.open = false;
      inner.dispatchEvent(new Event("toggle"));
      latestImageObserver().notify();
      await settleImage(image);
      expect(presentation.renderRoot.querySelector("img")).toBeNull();
      inner.open = true;
      inner.dispatchEvent(new Event("toggle"));
      latestImageObserver().notify();
      await settleImage(image);
    }
    expect(nativeImage(presentation).src).toContain(`/media/${mediaId}?`);
  });
});
