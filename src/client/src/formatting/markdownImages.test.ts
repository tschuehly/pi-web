// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localMarkdownImage } from "./markdownImages";
import { toSafeMarkdownHtml } from "./markdown";
import { MarkdownImage } from "../components/MarkdownImage";
import { imagePresentation, settleImage } from "../components/imagePresentation.testSupport";

beforeEach(() => { vi.stubGlobal("IntersectionObserver", undefined); });
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered image control");
  return value;
}

it.each([
  ["screenshots/a.png", "screenshots/a.png", false],
  ["/srv/work/a.png", "a.png", false],
  ["/srv/work/../outside.png", "/srv/outside.png", true],
  ["../a%20b.png", "/srv/a b.png", true],
  ["/tmp/a.png", "/tmp/a.png", true],
  ["~/a.png", "~/a.png", true],
])("classifies %s", (input, path, outside) => {
  expect(localMarkdownImage(input, "/srv/work")).toEqual({ path, outside });
});

it.each([
  ["C:/work", "screenshots/a.png", "screenshots/a.png", false],
  ["C:\\work", "screenshots/a.png", "screenshots/a.png", false],
  ["C:\\work\\", "./screenshots/../a.png", "a.png", false],
  ["C:/work", "../a%20b.png", "C:/a b.png", true],
  ["C:\\work", "/outside/a.png", "C:/outside/a.png", true],
  ["C:/", "../../a.png", "a.png", false],
  ["C:/work", "C:/work/a.png", "a.png", false],
  ["C:/work", "c:/work/a.png", "a.png", false],
  ["C:/work", "D:/outside/a.png", "D:/outside/a.png", true],
  ["\\\\server\\share\\work", "screenshots/a.png", "screenshots/a.png", false],
  ["//server/share/work", "../a.png", "//server/share/a.png", true],
  ["\\\\server\\share\\work", "../../../a.png", "//server/share/a.png", true],
])("classifies %s image %s using the workspace's Windows path syntax", (root, input, path, outside) => {
  expect(localMarkdownImage(input, root)).toEqual({ path, outside });
});

it.each(["https://example.com/a.png", "//example.com/a.png", "data:image/png,x", "bad%ZZ.png", "a%00.png"])("does not interpret %s as a local file", (input) => {
  for (const root of ["/srv/work", "C:/work", "\\\\server\\share\\work"]) {
    expect(localMarkdownImage(input, root)).toBeUndefined();
  }
});

it.each(["/srv/work", "C:/work", "C:\\work", "\\\\server\\share\\work"])("renders machine-aware nested preview URLs without approving outside images (%s)", (root) => {
  vi.stubEnv("BASE_URL", "/nested/pi/");
  const host = document.createElement("div");
  host.innerHTML = toSafeMarkdownHtml("![inside](a.png) ![outside](/tmp/a.png) ![external](https://example.com/a.png)", {
    machineId: "remote /1", projectId: "p", workspaceId: "w", root,
  });
  const images = host.querySelectorAll("pi-web-markdown-image");
  const first = required(images[0]);
  const second = required(images[1]);
  const inside = new URL(required(first.getAttribute("preview-url")));
  expect(inside.pathname).toBe("/nested/pi/api/machines/remote%20%2F1/projects/p/workspaces/w/file/preview");
  expect(inside.searchParams.get("path")).toBe("a.png");
  expect(inside.searchParams.has("showImage")).toBe(false);
  expect(first.hasAttribute("outside")).toBe(false);
  expect(second.hasAttribute("outside")).toBe(true);
  expect(new URL(required(second.getAttribute("preview-url"))).searchParams.get("showImage")).toBe("1");
  expect(host.querySelector("img")?.src).toBe("https://example.com/a.png");
});

it("restores only a clicked image on revisit within the code-block intent lifetime", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const context = { machineId: "local", projectId: "p", workspaceId: "w", root: "/srv/work" };
  const markdown = "![first](/tmp/same.png) ![second](/tmp/same.png)";
  async function visit(text = markdown, identity = "image-choice-test") {
    document.body.replaceChildren();
    const host = document.createElement("div");
    host.innerHTML = toSafeMarkdownHtml(text, context, identity);
    document.body.append(host);
    const images = [...host.querySelectorAll<MarkdownImage>("pi-web-markdown-image")];
    await Promise.all(images.map(settleImage));
    return images;
  }
  function isShown(images: MarkdownImage[], index = 0): boolean {
    return imagePresentation(required(images[index])).renderRoot.querySelector("img") !== null;
  }
  const initial = await visit();
  expect(initial).toHaveLength(2);
  const first = required(initial[0]);
  required(imagePresentation(first).renderRoot.querySelector("button")).click();
  await settleImage(first);
  expect(isShown(initial)).toBe(true);

  vi.setSystemTime(14 * 60_000);
  const returned = await visit();
  expect(isShown(returned)).toBe(true);
  expect(isShown(returned, 1)).toBe(false);
  expect(isShown(await visit(markdown, "different-message"))).toBe(false);

  vi.setSystemTime(15 * 60_000);
  const expired = await visit();
  expect(isShown(expired)).toBe(false);
  const again = required(expired[0]);
  required(imagePresentation(again).renderRoot.querySelector("button")).click();
  await settleImage(again);
  expect(isShown(await visit("![changed](/tmp/new.png)"))).toBe(false);
  expect(isShown(await visit())).toBe(false);
  expect(localStorage.length).toBe(0);
});

it("replaces the placeholder with just the image, reports failures, and resets approval for a different image", async () => {
  const image = new MarkdownImage();
  image.outside = true;
  image.path = "/tmp/example.png";
  image.previewUrl = "https://example.com/preview";
  document.body.append(image);
  const presentation = await settleImage(image);
  const root = presentation.renderRoot;
  expect(root.querySelector("img")).toBeNull();
  expect(root.textContent).toContain("/tmp/example.png");
  required(root.querySelector("button")).click();
  await settleImage(image);
  expect(root.querySelector("img")?.src).toBe(image.previewUrl);
  required(root.querySelector("img")).dispatchEvent(new Event("load"));
  await presentation.updateComplete;
  expect(root.querySelector(".placeholder")).toBeNull();
  expect(root.querySelector("code")).toBeNull();
  expect(root.textContent.trim()).toBe("");
  required(root.querySelector("img")).dispatchEvent(new Event("error"));
  await presentation.updateComplete;
  expect(root.querySelector('[role="status"]')?.textContent).toContain("Image unavailable");
  image.previewUrl = "https://example.com/another";
  await settleImage(image);
  expect(root.querySelector("img")).toBeNull();
  expect(required(root.querySelector("button")).textContent).toContain("Show image");
});
