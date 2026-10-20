import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Set PI_WEB_E2E_SCREENSHOTS to a folder to keep review screenshots of the Reply button and inline quotes.
const SHOTS = process.env["PI_WEB_E2E_SCREENSHOTS"];

// Real selections inside nested shadow roots differ per engine, so this needs a browser.
test("quotes selections from two messages inline and sends them with the reply", async ({ page }) => {
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  let sent: unknown;
  await page.route("**/prompt", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { accepted: true } });
  });
  await page.goto(url);
  const reply = page.getByRole("button", { name: "Reply to selection" });
  const quotes = page.locator("prompt-editor .cm-reply-quote");

  const question = page.locator('chat-view article[data-entry-id="e2e00001"] formatted-text p').getByText("Where are the notes?");
  const answer = page.locator('chat-view article[data-entry-id="e2e00002"] formatted-text p');

  // A selection extended by Shift-click into the next message belongs to neither.
  await question.dblclick({ position: { x: 8, y: 6 } });
  await answer.click({ modifiers: ["Shift"], position: { x: 8, y: 6 } });
  await page.waitForTimeout(400);
  await expect(reply).toHaveCount(0);

  await question.dblclick({ position: { x: 8, y: 6 } });
  await reply.click();
  await expect(quotes).toHaveCount(1);
  await answer.dblclick({ position: { x: 8, y: 6 } });
  await expect(reply).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reply).toHaveCount(0);
  await answer.dblclick({ position: { x: 8, y: 6 } });
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "reply-button.png") });
  await reply.click();
  await expect(quotes).toHaveText(["> Where", "> They"]);
  for (const quote of await quotes.all()) await expect(quote).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.type("Why there?");
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "reply-quotes-collapsed.png") });
  await quotes.first().click();
  await expect(page.locator("prompt-editor .cm-content")).toContainText("> [msg e2e00001](#entry:e2e00001) Where");
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "reply-quotes-expanded.png") });

  await page.locator("prompt-editor").evaluate((editor) => { (editor as HTMLElement & { focusInput(): void }).focusInput(); });
  await page.keyboard.press("Enter");
  await expect.poll(() => sent).toMatchObject({ text: "> [msg e2e00001](#entry:e2e00001) Where\n\n> [msg e2e00002](#entry:e2e00002) They\n\nWhy there?" });
  await expect(quotes).toHaveCount(0);
});

test("keeps a long collapsed quote on one row in a narrow composer", async ({ page }) => {
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(url);
  await page.locator("prompt-editor").evaluate((editor) => {
    (editor as HTMLElement & { insertReplyQuote(quote: { entryId: string; excerpt: string }): void }).insertReplyQuote({ entryId: "e2e00002", excerpt: "They are in the docs folder next to the install guide and the release plan" });
  });
  const quote = page.locator("prompt-editor .cm-reply-quote");
  await expect(quote).toHaveAttribute("aria-expanded", "false");
  const box = await quote.boundingBox();
  if (box === null) throw new Error("missing geometry");
  expect(box.height).toBeLessThan(30);
});

test("puts text typed right of a collapsed quote on its own visible line", async ({ page }) => {
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  await page.goto(url);
  const editor = page.locator("prompt-editor");
  await editor.evaluate((element) => {
    (element as HTMLElement & { insertReplyQuote(quote: { entryId: string; excerpt: string }): void }).insertReplyQuote({ entryId: "e2e00002", excerpt: "They are in the docs folder next to the install guide and the release plan" });
  });
  const line = page.locator("prompt-editor .cm-line").first();
  const box = await line.boundingBox();
  if (box === null) throw new Error("missing geometry");
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await page.keyboard.type("Typed");
  await expect(page.locator("prompt-editor .cm-content")).toContainText("Typed");
  await expect(page.locator("prompt-editor .cm-reply-quote")).toHaveAttribute("aria-expanded", "false");
  expect(await editor.evaluate((element) => (element as HTMLElement & { view: { state: { doc: { toString(): string } } } }).view.state.doc.toString()))
    .toBe("> [msg e2e00002](#entry:e2e00002) They are in the docs folder next to the install guide and the release plan\n\nTyped\n\n");
});

test("formats the composer's Markdown like the Files editor next to a collapsed quote, in light and dark", async ({ page }) => {
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(url);
  await page.locator("prompt-editor").evaluate((element) => {
    const editor = element as HTMLElement & { insertReplyQuote(quote: { entryId: string; excerpt: string }): void; replaceText(text: string): void };
    editor.replaceText("# Release check\n\n- run `npm test` first\n- then tag\n\n```ts\nconst ready: boolean = true;\n```\n\n");
    editor.insertReplyQuote({ entryId: "e2e00002", excerpt: "They are in the docs folder next to the install guide and the release plan" });
  });
  await page.keyboard.type("Is that still right?");
  const content = page.locator("prompt-editor .cm-content");
  await expect(page.locator("prompt-editor .cm-reply-quote")).toHaveAttribute("aria-expanded", "false");
  const color = (text: string) => content.getByText(text, { exact: true }).evaluate((span) => getComputedStyle(span).color);
  const plain = await content.evaluate((element) => getComputedStyle(element).color);
  expect(await color("const")).not.toBe(plain);
  expect(await content.getByText("Release check").evaluate((span) => getComputedStyle(span).fontWeight)).toBe("650");
  if (SHOTS !== undefined) await page.locator("prompt-editor").screenshot({ path: join(SHOTS, "composer-light.png") });
  const lightKeyword = await color("const");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => color("const")).not.toBe(lightKeyword);
  if (SHOTS !== undefined) await page.locator("prompt-editor").screenshot({ path: join(SHOTS, "composer-dark.png") });
});

test("places the Reply button at the selection under a larger interface scale", async ({ page }) => {
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (url === undefined) throw new Error("Isolated PI WEB was not started");
  await page.addInitScript(() => { localStorage.setItem("pi-web-app-scale", "1.5"); });
  await page.goto(url);
  const line = page.locator('chat-view article[data-entry-id="e2e00002"] formatted-text p');
  await line.dblclick({ position: { x: 8, y: 6 } });
  const reply = page.getByRole("button", { name: "Reply to selection" });
  await expect(reply).toBeVisible();
  // A double-click selects the paragraph's first word, so the button belongs just below its start.
  const text = await line.boundingBox();
  const button = await reply.boundingBox();
  if (text === null || button === null) throw new Error("missing geometry");
  expect(button.x - text.x).toBeGreaterThan(0);
  expect(button.x - text.x).toBeLessThan(150);
  expect(Math.abs(button.y - (text.y + text.height))).toBeLessThan(40);
});
