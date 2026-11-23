import { expect, test, type Page, type Route } from "@playwright/test";
import type { ChatView } from "../../src/client/src/components/ChatView";

const view = (page: Page) => page.locator("chat-view");
const chat = (page: Page) => view(page).locator(".chat");
const gap = (page: Page) => chat(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
const pinned = (page: Page) => expect.poll(() => gap(page)).toBeLessThan(2);

test.beforeEach(async ({ page }) => {
  await page.goto("/overlays.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await view(page).evaluate((el: ChatView) => {
    el.workbench = true;
    el.behaviors = { ...el.behaviors, holdReadingPlace: true };
    el.sessionId = "stream";
    el.messageStart = 20;
    el.hasMore = true;
    // Bash lines render synchronously: later Markdown formatting must not accidentally repair the gap.
    el.messages = Array.from({ length: 40 }, (_, i) => ({ entryId: `e${String(i)}`, role: "bash", parts: [{ type: "text", text: "Message" }] }));
  });
  await expect.poll(() => chat(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await pinned(page);
});

test("follows an attachment above the viewport whose dimensions arrive after the message", async ({ page }) => {
  let received!: (route: Route) => void;
  const pending = new Promise<Route>((resolve) => { received = resolve; });
  await page.route("**/media/**", received);
  await view(page).evaluate((el: ChatView) => {
    el.messages = [...el.messages.slice(0, -8), { role: "user", parts: [{ type: "image", mediaId: "a".repeat(64), mimeType: "image/svg+xml", byteSize: 100 }] }, ...el.messages.slice(-8)];
  });
  const route = await pending;
  await pinned(page);
  const image = chat(page).locator("img");
  const box = await image.boundingBox();
  expect(box && box.y + box.height).toBeLessThan((await chat(page).boundingBox())?.y ?? 0);
  await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"/>' });
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(200);
  await pinned(page);
});

test("follows a status-only update that adds the compacting notice", async ({ page }) => {
  await view(page).evaluate((el: ChatView) => { el.isCompacting = true; });
  await expect(chat(page).locator(".compacting")).toBeVisible();
  await pinned(page);
});

test("follows a replacement snapshot with both earlier and newer messages", async ({ page }) => {
  await view(page).evaluate((el: ChatView) => {
    el.messageStart = 19;
    const lines = structuredClone(el.messages);
    el.messages = [{ entryId: "earlier", role: "bash", parts: [{ type: "text", text: "Earlier" }] }, ...lines,
      { entryId: "latest", role: "bash", parts: [{ type: "text", text: "Latest" }] }];
  });
  await expect(chat(page).locator('[data-entry-id="latest"]')).toHaveCount(1);
  await pinned(page);
});

test("scrolling within tool output does not pause the transcript", async ({ page }) => {
  await view(page).evaluate((el: ChatView) => {
    el.messages = [...el.messages, { role: "assistant", parts: [{ type: "backgroundBash", details: { id: "job", command: "build", state: "complete", elapsedSeconds: 2, logPath: "build.log" }, output: "output\n".repeat(80) }] }];
  });
  const card = chat(page).locator(".background-bash-card");
  await card.evaluate((el: HTMLDetailsElement) => { el.open = true; });
  const output = card.locator("pre");
  await output.evaluate((el) => { el.scrollTop = 500; });
  await pinned(page);
  await output.hover();
  await page.mouse.wheel(0, -80);
  await expect.poll(() => output.evaluate((el) => el.scrollTop)).toBeLessThan(500);
  await pinned(page);
  await view(page).evaluate((el: ChatView) => { el.messages = [...el.messages, { role: "assistant", parts: [{ type: "text", text: "more output" }] }]; });
  await pinned(page);
});

test("follows tool details expanded inside a child shadow root", async ({ page }) => {
  await view(page).evaluate((el: ChatView) => {
    el.messages = [...el.messages, { role: "assistant", parts: [{ type: "toolExecution", toolName: "bash", summary: "build", status: "success", resultText: "line\n".repeat(50) }] }];
  });
  const details = chat(page).locator("tool-execution-view .text-body");
  await expect(details).toHaveCount(1);
  await pinned(page);
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await pinned(page);
  await details.evaluate((el: HTMLDetailsElement) => { el.open = false; });
  await pinned(page);
  await expect(view(page).locator(".scroll-to-bottom")).toHaveCount(0);
});

test("keeps a reader's place during growth and follows again after jumping to the bottom", async ({ page }) => {
  await chat(page).hover();
  await page.mouse.wheel(0, -500);
  const jump = view(page).getByRole("button", { name: "Scroll to bottom" });
  await expect(jump).toBeVisible();
  await view(page).evaluate((el: ChatView) => { el.isCompacting = true; });
  await expect.poll(() => gap(page)).toBeGreaterThan(100);
  await jump.click();
  await pinned(page);
  await view(page).evaluate(async (el: ChatView) => {
    const history = el.messages;
    for (let i = 1; i <= 30; i++) {
      el.messages = [...history, { role: "assistant", streamId: "turn", parts: [{ type: "text", text: "streaming\n\n".repeat(i) }] }];
      await new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); }));
    }
  });
  await expect(jump).toHaveCount(0);
  await pinned(page);
});
