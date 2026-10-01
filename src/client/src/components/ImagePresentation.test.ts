// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ImagePresentation } from "./ImagePresentation";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

function nativeImage(presentation: ImagePresentation): HTMLImageElement {
  const image = presentation.renderRoot.querySelector("img");
  if (image === null) throw new Error("Expected native image");
  return image;
}

it("pairs composed layout events around source, load, error and retry DOM changes", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const presentation = new ImagePresentation();
  presentation.source = "https://example.test/first.png";
  const events: { type: string; frame: string | undefined; image: EventTarget | undefined }[] = [];
  for (const type of ["image-will-layout", "image-layout"]) {
    root.addEventListener(type, (event) => {
      events.push({ type, frame: presentation.renderRoot.querySelector(".frame")?.className, image: event.composedPath()[0] });
    });
  }
  root.append(presentation);
  await presentation.updateComplete;

  nativeImage(presentation).dispatchEvent(new Event("load"));
  await presentation.updateComplete;
  presentation.source = "https://example.test/second.png";
  await presentation.updateComplete;
  nativeImage(presentation).dispatchEvent(new Event("error"));
  await presentation.updateComplete;
  presentation.renderRoot.querySelector<HTMLButtonElement>("button")?.click();
  await presentation.updateComplete;
  nativeImage(presentation).dispatchEvent(new Event("load"));
  await presentation.updateComplete;
  presentation.source = undefined;
  await presentation.updateComplete;

  expect(events.map(({ type, frame }) => [type, frame])).toEqual([
    ["image-will-layout", undefined], ["image-layout", "frame loading"],
    ["image-will-layout", "frame loading"], ["image-layout", "frame loaded"],
    ["image-will-layout", "frame loaded"], ["image-layout", "frame loading"],
    ["image-will-layout", "frame loading"], ["image-layout", "frame error"],
    ["image-will-layout", "frame error"], ["image-layout", "frame loading"],
    ["image-will-layout", "frame loading"], ["image-layout", "frame loaded"],
    ["image-will-layout", "frame loaded"], ["image-layout", "frame pending"],
  ]);
  expect(events.every(({ image }) => image === presentation)).toBe(true);

  events.length = 0;
  presentation.description = "Another accessible description";
  await presentation.updateComplete;
  expect(events).toEqual([]);
});
