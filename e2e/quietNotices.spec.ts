import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_NOTICE_CHATS, E2E_NOTICE_FIRST_LINE_END, E2E_PROJECT_ID } from "./isolatedPiWeb";

// Set PI_WEB_E2E_SCREENSHOTS to a folder to keep review screenshots of quiet notices in a Chat and a 3-tile Grid.
const SHOTS = process.env["PI_WEB_E2E_SCREENSHOTS"];
const FOCUSED = E2E_NOTICE_CHATS[0].id;

async function openWindow(page: Page, layout: "tabs" | "grid"): Promise<void> {
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (workspaceId === undefined || url === undefined) throw new Error("Isolated PI WEB was not started");
  const workstream = { id: "ws-notices", title: "Notices" };
  const shown = layout === "grid" ? E2E_NOTICE_CHATS : E2E_NOTICE_CHATS.slice(0, 1);
  const chats = shown.map((chat) => ({ sessionId: chat.id, title: chat.question, machineId: "local", projectId: E2E_PROJECT_ID, workspaceId, workstream }));
  const store = { n: { name: "Window 1", layout, maximized: false, focused: FOCUSED, lastActive: {}, chats } };
  await page.addInitScript((value) => { if (localStorage.getItem("pi-workbench.windows.v1") === null) localStorage.setItem("pi-workbench.windows.v1", value); }, JSON.stringify(store));
  const target = new URL(url);
  target.searchParams.set("win", "n");
  target.searchParams.set("session", FOCUSED);
  await page.goto(target.toString());
  await expect(transcript(page)).toContainText("Release 2.0");
}

const transcript = (page: Page) => page.locator('.tile[data-focused="true"] main.chat-shell chat-view .chat');

test("captures quiet notices in a Chat and a 3-tile Grid for review", async ({ browser }) => {
  test.skip(SHOTS === undefined, "set PI_WEB_E2E_SCREENSHOTS to keep review screenshots");
  test.setTimeout(120_000);
  for (const scheme of ["light", "dark"] as const) {
    for (const layout of ["tabs", "grid"] as const) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const page = await context.newPage();
      await openWindow(page, layout);
      if (layout === "grid") await expect(page.locator(".grid > .tile")).toHaveCount(3);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SHOTS ?? "", `${layout === "tabs" ? "chat" : "grid"}-${scheme}.png`) });
      const fold = transcript(page).locator("details.notice-fold > summary");
      if (layout === "tabs" && await fold.count() === 1) {
        await fold.click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(SHOTS ?? "", `chat-${scheme}-expanded.png`) });
      }
      await context.close();
    }
  }
});

test("folds consecutive notices into one line, keeps a lone notice quiet and a failure visible", async ({ page }) => {
  await openWindow(page, "tabs");
  const fold = transcript(page).locator("details.notice-fold");
  await expect(fold).toHaveCount(1);
  await expect(fold.locator("> summary")).toContainText("3 notices");
  await expect(fold.locator("> summary")).toContainText("#73 Decision “Release layout”: Two columns");
  await expect(fold.locator("> summary")).not.toContainText("two-column layout for the release page");
  await expect(fold.locator(".notice")).toHaveCount(3);
  await expect(fold.locator(".notice").first()).toBeHidden();
  await fold.locator("> summary").click();
  await expect(fold.locator(".notice").first()).toContainText("Disk low: 9 GB free.");
  await expect(transcript(page).locator(".notice:not(.notice-fold .notice)")).toHaveText(["#74 Comment on the hero: make the headline shorter.", /#75 Decision/u]);
  await expect(transcript(page).locator("article.msg.system.error")).toContainText("Model response failed: rate limited, retry later");
});

/** Whether a notice's first line ends inside its row: nothing overflows and the last character lies within the article. */
async function firstLineEndVisible(preview: Locator): Promise<boolean> {
  return preview.evaluate((element, end) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null = null;
    for (let next = walker.nextNode(); next !== null; next = walker.nextNode()) if ((next.textContent ?? "").trim() !== "") node = next;
    const text = node?.textContent ?? "";
    if (node === null || !text.trimEnd().endsWith(end)) return false;
    const range = document.createRange();
    range.setStart(node, text.trimEnd().length - 1);
    range.setEnd(node, text.trimEnd().length);
    const last = range.getBoundingClientRect();
    const row = element.closest("article")?.getBoundingClientRect();
    return element.scrollWidth <= element.clientWidth && row !== undefined && last.width > 0 && last.right <= row.right && last.left >= row.left;
  }, E2E_NOTICE_FIRST_LINE_END);
}

test("an expanded notice or notice fold shows the whole first line in a Grid tile", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWindow(page, "grid");
  await expect(page.locator(".grid > .tile")).toHaveCount(3);
  const lone = transcript(page).locator("details.notice:not(.notice-fold .notice)");
  await expect(lone.locator("> summary")).toContainText("#75 Decision");
  // Collapsed, the long first line stays one ellipsized line.
  expect(await firstLineEndVisible(lone.locator("> summary .disclosure-preview"))).toBe(false);
  await lone.locator("> summary").click();
  expect(await firstLineEndVisible(lone.locator("> summary .disclosure-preview"))).toBe(true);

  const fold = transcript(page).locator("details.notice-fold");
  await fold.locator("> summary").click();
  const folded = fold.locator("details.notice", { hasText: "#73 Decision" });
  expect(await firstLineEndVisible(folded.locator("> summary .disclosure-preview"))).toBe(true);
  await folded.locator("> summary").click();
  expect(await firstLineEndVisible(folded.locator("> summary .disclosure-preview"))).toBe(true);
});

test("cards line up with message bars and one routine step needs no Activity fold", async ({ page }) => {
  await openWindow(page, "tabs");
  const card = transcript(page).locator(".background-bash-card").first();
  // The fixture's card sits in an earlier exchange; open it so both bars are laid out.
  await card.evaluate((element) => { const history = element.closest("details"); if (history !== null && history !== element) history.open = true; });
  await expect(card).toBeVisible();
  const [cardLeft, messageLeft] = await card.evaluate((element) => {
    // Under the Workbench rail the card's shell article draws the bar, as every block does.
    const shell = element.closest("article");
    const assistant = shell?.parentElement?.querySelector("article.msg.assistant");
    return [shell?.getBoundingClientRect().left, assistant?.getBoundingClientRect().left];
  });
  expect(cardLeft).toBe(messageLeft);
  await expect(transcript(page).locator("details.activity-group")).toHaveCount(0);
});
