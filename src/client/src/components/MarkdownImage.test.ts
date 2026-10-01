// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownImage } from "./MarkdownImage";
import { ImageIntersectionObserver, latestImageObserver, settleImage } from "./imagePresentation.testSupport";

beforeEach(() => {
  ImageIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", ImageIntersectionObserver);
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("automatically loads workspace markdown images only near the viewport", async () => {
  const image = new MarkdownImage();
  image.path = "screenshots/example.png";
  image.description = "Example screenshot";
  image.previewUrl = "https://example.test/nested/api/preview?path=screenshot.png";
  document.body.append(image);
  const presentation = await settleImage(image);
  expect(presentation.renderRoot.querySelector("img")).toBeNull();
  expect(presentation.renderRoot.textContent).toContain("Show image");
  expect(presentation.renderRoot.textContent).toContain("screenshots/example.png");
  latestImageObserver().notify();
  await settleImage(image);
  expect(presentation.renderRoot.querySelector("img")?.src).toBe(image.previewUrl);
  expect(presentation.renderRoot.querySelector("img")?.alt).toBe("Example screenshot");
});

it.each([true, false])("never auto-approves an outside-workspace image, including retries (observer: %s)", async (available) => {
  if (!available) vi.stubGlobal("IntersectionObserver", undefined);
  const image = new MarkdownImage();
  image.outside = true;
  image.path = "/private/example.png";
  image.previewUrl = "https://example.test/api/preview?path=private&showImage=1";
  document.body.append(image);
  const presentation = await settleImage(image);
  expect(ImageIntersectionObserver.instances).toHaveLength(0);
  expect(presentation.renderRoot.querySelector("img")).toBeNull();
  const show = presentation.renderRoot.querySelector<HTMLButtonElement>("button");
  if (show === null) throw new Error("Expected consent button");
  show.click();
  await settleImage(image);
  const native = presentation.renderRoot.querySelector("img");
  if (native === null) throw new Error("Expected approved image");
  native.dispatchEvent(new Event("error"));
  await presentation.updateComplete;
  const retry = presentation.renderRoot.querySelector<HTMLButtonElement>("button");
  expect(retry?.textContent).toBe("Retry");
  retry?.click();
  await presentation.updateComplete;
  expect(presentation.renderRoot.querySelector("img")?.src).toBe(image.previewUrl);
  image.previewUrl = "https://example.test/api/preview?path=different&showImage=1";
  await settleImage(image);
  expect(presentation.renderRoot.querySelector("img")).toBeNull();
  expect(presentation.renderRoot.textContent).toContain("Show image");
  expect(ImageIntersectionObserver.instances).toHaveLength(0);
});
