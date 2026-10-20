import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ASK_CHAT, E2E_PROJECT_ID, E2E_SESSION_ID } from "./isolatedPiWeb";

// Set PI_WEB_E2E_SCREENSHOTS to a folder to keep review screenshots of the question chips and drawer.
const SHOTS = process.env["PI_WEB_E2E_SCREENSHOTS"];
const STORE_KEY = "pi-workbench.windows.v1";
const [NOTES, ASKING] = [E2E_SESSION_ID, E2E_ASK_CHAT.id];

/** One window with the Chat that asks beside a Chat that does not, the asking one focused. */
async function openAskingWindow(page: Page, focused: string = ASKING, layout: "tabs" | "grid" = "tabs"): Promise<void> {
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (workspaceId === undefined || url === undefined) throw new Error("Isolated PI WEB was not started");
  const workstream = { id: "ws-ask", title: "Ask context" };
  const chat = (sessionId: string, title: string) => ({ sessionId, title, machineId: "local", projectId: E2E_PROJECT_ID, workspaceId, workstream });
  const store = { q: { name: "Window 1", layout, maximized: false, focused, lastActive: {}, chats: [chat(NOTES, "Where are the notes?"), chat(ASKING, E2E_ASK_CHAT.question)] } };
  await page.addInitScript(([key, value]) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, [STORE_KEY, JSON.stringify(store)] as const);
  const target = new URL(url);
  target.searchParams.set("win", "q");
  target.searchParams.set("session", focused);
  await page.goto(target.toString());
  await expect(shownChat(page)).toHaveAttribute("data-session", focused);
}

const shownChat = (page: Page) => page.locator("main.chat-shell").first();
const chips = (page: Page) => shownChat(page).locator("workbench-question-chips .chip");
const drawer = (page: Page) => shownChat(page).locator("workbench-question-chips .drawer");
const tabCount = (page: Page, sessionId: string) => page.locator(`workbench-window-tabs .chat-tab[data-session="${sessionId}"] .questions`);
const [GO_LIVE, CHECKS] = E2E_ASK_CHAT.ask.questions;

// Runs first: answering below closes the fixture's only open set.
test("captures the question chips and drawer for review", async ({ browser }) => {
  test.skip(SHOTS === undefined, "set PI_WEB_E2E_SCREENSHOTS to keep review screenshots");
  test.setTimeout(180_000);
  for (const scheme of ["dark", "light"] as const) {
    for (const width of [1440, 900] as const) {
      for (const layout of ["tabs", "grid"] as const) {
        const context = await browser.newContext({ viewport: { width, height: 820 }, colorScheme: scheme });
        const page = await context.newPage();
        await openAskingWindow(page, ASKING, layout);
        await expect(chips(page)).toHaveCount(2);
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(SHOTS ?? "", `${layout}-${String(width)}-${scheme}-closed.png`) });
        await chips(page).first().click();
        await expect(drawer(page)).toBeVisible();
        await page.waitForTimeout(600);
        // The drawer stays within its tile, the composer below it still on screen.
        const tile = await page.locator('.tile[data-focused="true"]').boundingBox();
        const open = await drawer(page).boundingBox();
        const composer = await shownChat(page).locator("prompt-editor").boundingBox();
        expect(tile !== null && open !== null && composer !== null && open.y >= tile.y && composer.y + composer.height <= tile.y + tile.height + 1).toBe(true);
        await page.screenshot({ path: join(SHOTS ?? "", `${layout}-${String(width)}-${scheme}-open.png`) });
        if (layout === "grid") {
          // Focusing the other tile leaves the asking Chat in a side tile, its chips above the compact composer.
          await page.locator(`.tile[data-session="${NOTES}"] .tile-bar`).click();
          await expect(page.locator(`.tile[data-session="${ASKING}"] workbench-chat-pane workbench-question-chips .chip`)).toHaveCount(2);
          await page.waitForTimeout(600);
          await page.screenshot({ path: join(SHOTS ?? "", `grid-${String(width)}-${scheme}-side-tile.png`) });
        }
        await context.close();
      }
    }
  }
});

test("answers a Chat's open questions from chips above its composer, through a drawer with the context beside them", async ({ page }) => {
  await openAskingWindow(page);
  await expect(chips(page)).toHaveText([GO_LIVE.question, CHECKS.question]);
  await expect(tabCount(page, ASKING)).toHaveText("2");
  await expect(tabCount(page, NOTES)).toHaveCount(0);
  await expect(page.locator(".questions-toggle, workbench-questions-pane")).toHaveCount(0);
  // The chips sit directly above the composer.
  const chipBox = await chips(page).first().boundingBox();
  const composerBox = await shownChat(page).locator("prompt-editor").boundingBox();
  expect(chipBox !== null && composerBox !== null && chipBox.y + chipBox.height <= composerBox.y + 1 && composerBox.y - chipBox.y < 60).toBe(true);

  // Keyboard: a chip opens the drawer at its question; Esc folds it back to the chip.
  await chips(page).nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator('input[value="unit"]')).toBeFocused();
  const context = await drawer(page).locator("ask-user-card .ask-context").boundingBox();
  const question = await drawer(page).locator("ask-user-card fieldset").first().boundingBox();
  expect(context !== null && question !== null && context.x + context.width <= question.x + 1).toBe(true);
  await expect(drawer(page).locator("ask-user-card")).toContainText("Recommended");
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(chips(page).nth(1)).toBeFocused();

  // Another Chat shows none of these chips, while the asking tab keeps its count.
  await page.locator(`workbench-window-tabs .chat-tab[data-session="${NOTES}"]`).click();
  await expect(shownChat(page)).toHaveAttribute("data-session", NOTES);
  await expect(chips(page)).toHaveCount(0);
  await expect(tabCount(page, ASKING)).toHaveText("2");

  await page.locator(`workbench-window-tabs .chat-tab[data-session="${ASKING}"]`).click();
  await expect(shownChat(page)).toHaveAttribute("data-session", ASKING);
  await chips(page).first().click();
  await drawer(page).locator('input[value="wb-now"]').check();
  await drawer(page).locator('input[value="unit"]').check();
  await drawer(page).locator('input[value="e2e"]').check();
  await drawer(page).getByRole("button", { name: "Send answers" }).click();
  await expect(chips(page)).toHaveCount(0);
  await expect(tabCount(page, ASKING)).toHaveCount(0);
  await expect(shownChat(page).locator("chat-view")).toContainText("Answers sent");
});
