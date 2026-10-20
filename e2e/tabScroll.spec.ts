import { expect, test, type Page } from "@playwright/test";
import { E2E_LONG_CHAT, E2E_MORE_CHATS, E2E_PROJECT_ID } from "./isolatedPiWeb";

const [LONG, RELEASE] = [E2E_LONG_CHAT.id, E2E_MORE_CHATS[0].id];
const titles = { [LONG]: "Migrate the build", [RELEASE]: "Draft the release notes" };

async function openWindow(page: Page): Promise<void> {
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (workspaceId === undefined || url === undefined) throw new Error("Isolated PI WEB was not started");
  const workstream = { id: "ws-scroll", title: "Scroll" };
  const chats = [LONG, RELEASE].map((sessionId) => ({ sessionId, title: titles[sessionId], machineId: "local", projectId: E2E_PROJECT_ID, workspaceId, workstream }));
  const store = { scroll: { name: "Window 1", layout: "tabs", maximized: false, focused: LONG, lastActive: {}, chats } };
  await page.addInitScript((value) => { if (localStorage.getItem("pi-workbench.windows.v1") === null) localStorage.setItem("pi-workbench.windows.v1", value); }, JSON.stringify(store));
  const target = new URL(url);
  target.searchParams.set("session", LONG);
  target.searchParams.set("win", "scroll");
  await page.goto(target.toString());
  await expect(shown(page)).toHaveAttribute("data-session", LONG);
}

const shown = (page: Page) => page.locator("main.chat-shell").first();
const transcript = (page: Page) => shown(page).locator("chat-view .chat");

async function show(page: Page, session: string): Promise<void> {
  await page.locator("workbench-window-tabs .chat-tab", { hasText: titles[session] }).click();
  await expect(shown(page)).toHaveAttribute("data-session", session);
}

/** The first message showing at the transcript's top edge and how far its top sits above that edge. */
function readingPlace(chat: Element): { anchor: string; offset: number; atBottom: boolean } {
  const top = chat.getBoundingClientRect().top;
  const first = [...chat.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]")].find((element) => element.getBoundingClientRect().bottom > top + 1);
  return { anchor: first?.dataset["scrollAnchorId"] ?? "", offset: Math.round((first?.getBoundingClientRect().top ?? 0) - top), atBottom: chat.scrollHeight - chat.scrollTop - chat.clientHeight < 2 };
}

test("keeps a long Chat's reading place across tab switches, and a bottom-pinned Chat at its bottom", async ({ page }) => {
  await openWindow(page);
  await expect(transcript(page).locator("article").first()).toBeVisible();
  // Scroll up past the loaded page so earlier history pages in, then settle mid-transcript.
  await transcript(page).hover();
  const firstIndex = () => transcript(page).evaluate((chat) => Math.min(...[...chat.querySelectorAll<HTMLElement>("[data-index]")].map((element) => Number(element.dataset["index"]))));
  const initialFirst = await firstIndex();
  for (let attempt = 0; attempt < 40 && await firstIndex() >= initialFirst; attempt += 1) {
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(150);
  }
  expect(await firstIndex(), "earlier history paged in").toBeLessThan(initialFirst);
  await page.waitForTimeout(500);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(800);
  const before = await transcript(page).evaluate(readingPlace);
  expect(before.atBottom).toBe(false);

  for (let round = 0; round < 3; round += 1) {
    await show(page, RELEASE);
    await page.waitForTimeout(400);
    // RELEASE opened at its bottom and stays there.
    expect((await transcript(page).evaluate(readingPlace)).atBottom, `RELEASE at bottom, round ${String(round)}`).toBe(true);
    await show(page, LONG);
    await page.waitForTimeout(1200);
    expect(await transcript(page).evaluate(readingPlace), `LONG reading place, round ${String(round)}`).toEqual(before);
  }
});

/** A Chat's transcript in Grid, whether its tile is the focused one or rests beside it. */
const tileTranscript = (page: Page, session: string) => page.locator(`.tile[data-session="${session}"]`)
  .or(page.locator('.tile[data-focused="true"]').filter({ has: page.locator(`main.chat-shell[data-session="${session}"]`) }))
  .locator("chat-view .chat");

test("keeps each Grid tile's reading place when focus moves between tiles", async ({ page }) => {
  await openWindow(page);
  await page.keyboard.press("Control+g");
  await expect(page.locator("workbench-chat-pane")).toHaveCount(1);
  const long = tileTranscript(page, LONG);
  await expect(long.locator("article").first()).toBeVisible();
  await expect(tileTranscript(page, RELEASE).locator("article").first()).toBeVisible();
  await long.hover();
  for (let step = 0; step < 4; step += 1) { await page.mouse.wheel(0, -1200); await page.waitForTimeout(200); }
  await page.waitForTimeout(800);
  const place = async () => ({ long: await long.evaluate(readingPlace), release: await tileTranscript(page, RELEASE).evaluate(readingPlace) });
  const near = (actual: Awaited<ReturnType<typeof place>>, expected: typeof actual, label: string) => {
    for (const key of ["long", "release"] as const) {
      // A bottom-pinned Chat stays at its bottom, whatever height its tile's chrome leaves the transcript.
      if (expected[key].atBottom) { expect(actual[key].atBottom, `${label}: ${key} at bottom`).toBe(true); continue; }
      expect(actual[key].anchor, `${label}: ${key} anchor`).toBe(expected[key].anchor);
      expect(Math.abs(actual[key].offset - expected[key].offset), `${label}: ${key} offset ${String(actual[key].offset)} vs ${String(expected[key].offset)}`).toBeLessThanOrEqual(2);
    }
  };
  const before = await place();
  expect(before.long.atBottom).toBe(false);

  await page.locator(`.tile[data-session="${RELEASE}"] .tile-bar .tile-title`).click();
  await expect(page.locator('.tile[data-focused="true"] main.chat-shell')).toHaveAttribute("data-session", RELEASE);
  await page.waitForTimeout(1200);
  near(await place(), before, "RELEASE focused");

  await page.locator(`.tile[data-session="${LONG}"] .tile-bar .tile-title`).click();
  await expect(page.locator('.tile[data-focused="true"] main.chat-shell')).toHaveAttribute("data-session", LONG);
  await page.waitForTimeout(1200);
  near(await place(), before, "LONG focused again");
});
