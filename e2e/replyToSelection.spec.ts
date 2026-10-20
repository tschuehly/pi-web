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
