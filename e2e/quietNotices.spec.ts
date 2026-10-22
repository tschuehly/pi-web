import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_NOTICE_CHATS, E2E_PROJECT_ID } from "./isolatedPiWeb";

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
  await expect(transcript(page).locator(".notice:not(.notice-fold .notice)")).toHaveText("#74 Comment on the hero: make the headline shorter.");
  await expect(transcript(page).locator("article.msg.system.error")).toContainText("Model response failed: rate limited, retry later");
});
