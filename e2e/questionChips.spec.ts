import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ASK_CHAT, E2E_CROWDED_ASK_CHAT, E2E_MORE_CHATS, E2E_PROJECT_ID, E2E_SESSION_ID } from "./isolatedPiWeb";

// Set PI_WEB_E2E_SCREENSHOTS to a folder to keep review screenshots of the question chips and drawer.
const SHOTS = process.env["PI_WEB_E2E_SCREENSHOTS"];
const STORE_KEY = "pi-workbench.windows.v1";
const [NOTES, ASKING, CROWDED, RELEASE] = [E2E_SESSION_ID, E2E_ASK_CHAT.id, E2E_CROWDED_ASK_CHAT.id, E2E_MORE_CHATS[0].id];

/** One window with the Chat that asks beside a Chat that does not, the asking one focused. */
async function openAskingWindow(page: Page, focused: string = ASKING, layout: "tabs" | "grid" = "tabs"): Promise<void> {
  await openWindow(page, [[NOTES, "Where are the notes?"], [ASKING, E2E_ASK_CHAT.question]], focused, layout);
}

/** Four Grid tiles: the Chat asking twelve questions focused, beside the one asking two and two that ask nothing. */
async function openCrowdedGrid(page: Page): Promise<void> {
  await openWindow(page, [[NOTES, "Where are the notes?"], [ASKING, E2E_ASK_CHAT.question], [RELEASE, E2E_MORE_CHATS[0].question], [CROWDED, E2E_CROWDED_ASK_CHAT.question]], CROWDED, "grid");
}

async function openWindow(page: Page, chats: readonly (readonly [string, string])[], focused: string, layout: "tabs" | "grid"): Promise<void> {
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (workspaceId === undefined || url === undefined) throw new Error("Isolated PI WEB was not started");
  const workstream = { id: "ws-ask", title: "Ask context" };
  const chat = (sessionId: string, title: string) => ({ sessionId, title, machineId: "local", projectId: E2E_PROJECT_ID, workspaceId, workstream });
  const store = { q: { name: "Window 1", layout, maximized: false, focused, lastActive: {}, chats: chats.map(([sessionId, title]) => chat(sessionId, title)) } };
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
    // Four tiles, the focused one asking twelve questions: one row of chips, a drawer with room for its forms.
    const crowded = await browser.newContext({ viewport: { width: 900, height: 820 }, colorScheme: scheme });
    const shot = await crowded.newPage();
    await openCrowdedGrid(shot);
    await expect(chips(shot)).toHaveCount(12);
    await shot.waitForTimeout(600);
    await shot.screenshot({ path: join(SHOTS ?? "", `crowded-grid-900-${scheme}-closed.png`) });
    await chips(shot).nth(4).click();
    await expect(drawer(shot)).toBeVisible();
    await shot.waitForTimeout(600);
    await shot.screenshot({ path: join(SHOTS ?? "", `crowded-grid-900-${scheme}-open.png`) });
    await crowded.close();
  }
});

/** Tabs view under an Activity strip, the second question long enough to wrap its id and an option with long details. */
async function openCrampedDrawer(page: Page): Promise<void> {
  await openAskingWindow(page);
  // Pins the roster's status: the live session status would replace a plain assignment.
  await shownChat(page).locator("delegate-roster").evaluate((element: HTMLElement & { requestUpdate: () => void }) => {
    const items = ["Reviewer", "Builder", "Scout", "Tester", "Writer", "Linter", "Designer", "Planner"].map((name, index) => ({ id: `d${String(index)}`, kind: "subagent", name, reportedStatus: `${name} is working on the next step` }));
    const status = { extensionStatuses: { "pi-workbench:activity": JSON.stringify({ schemaVersion: 1, items }) } };
    Object.defineProperty(element, "status", { configurable: true, get: () => status, set: () => undefined });
    element.requestUpdate();
  });
  await shownChat(page).locator("workbench-question-chips").evaluate((element: HTMLElement & { asks: { questions: { question: string; options: { detail?: string }[] }[] }[] }) => {
    const [ask] = element.asks;
    if (ask === undefined) return;
    const [first, second] = ask.questions;
    if (first === undefined || second === undefined) return;
    const long = "Restarts the session daemon, so every running session is interrupted and has to be resumed by hand afterwards. ".repeat(3);
    element.asks = [{ ...ask, questions: [{ ...first, options: first.options.map((option) => ({ ...option, detail: long })) }, { ...second, question: "Fix the support bot's prompt so it stops promising refunds it cannot grant, and which checks should run first?" }] }];
  });
  await expect(shownChat(page).locator("delegate-roster section")).toBeVisible();
  await chips(page).first().click();
  await expect(drawer(page)).toBeVisible();
}

test("fits one flat question drawer above the chips and composer in a short window", async ({ browser }) => {
  const sizes = SHOTS === undefined ? [[1000, 650]] as const : [[1000, 650], [1440, 900]] as const;
  for (const scheme of SHOTS === undefined ? ["light"] as const : ["dark", "light"] as const) {
    for (const [width, height] of sizes) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
      const page = await context.newPage();
      await openCrampedDrawer(page);
      await page.waitForTimeout(400);
      if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `flat-drawer-${String(width)}-${scheme}.png`) });
      // The chips row and the composer stay whole on screen; the drawer gives way and scrolls.
      for (const box of [await shownChat(page).locator("workbench-question-chips .chips").boundingBox(), await shownChat(page).locator("prompt-editor").boundingBox()]) {
        expect(box !== null && box.y >= 0 && box.y + box.height <= height + 0.5).toBe(true);
      }
      const layout = await drawer(page).evaluate((root) => {
        const all = (node: Element | ShadowRoot): Element[] => [...node.querySelectorAll("*")].flatMap((element) => [element, ...(element.shadowRoot === null ? [] : all(element.shadowRoot))]);
        const elements = [root, ...all(root)];
        const visible = (style: CSSStyleDeclaration, side: string) => parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 && style.getPropertyValue(`border-${side}-style`) !== "none" && !/rgba\(.*, 0\)$|transparent/.test(style.getPropertyValue(`border-${side}-color`));
        const framed = elements.filter((element) => !element.matches("button, input, textarea, label, code") && ["top", "right", "bottom", "left"].every((side) => visible(getComputedStyle(element), side)));
        const headings = elements.filter((element) => element.matches("legend")).map((element) => element.getBoundingClientRect());
        // A fieldset's top border paints through its legend, so separators must be elements of their own.
        const lines = elements.filter((element) => element.matches("fieldset") ? visible(getComputedStyle(element), "top") : element.matches("hr")).map((element) => element.getBoundingClientRect());
        const crossing = lines.filter((line) => headings.some((heading) => line.top < heading.bottom && line.bottom > heading.top && line.left < heading.right && line.right > heading.left));
        return { framed: framed.length, separators: lines.length, crossing: crossing.length };
      });
      expect(layout).toEqual({ framed: 1, separators: 1, crossing: 0 });
      await context.close();
    }
  }
});

test("counts an idle Chat's open questions on its tab right after a reload, without opening it", async ({ page }) => {
  // Anything but the read-only asks read would open the cold Chat in the daemon.
  const reads: string[] = [];
  page.on("request", (request) => { reads.push(new URL(request.url()).pathname); });
  page.on("websocket", (socket) => { reads.push(new URL(socket.url()).pathname); });
  await openAskingWindow(page, NOTES);
  await expect(tabCount(page, ASKING)).toHaveText("2");
  await expect(chips(page)).toHaveCount(0);
  expect(reads.filter((path) => path.includes(`/sessions/${ASKING}/`)).map((path) => path.split("/").at(-1))).toEqual(["asks"]);
});

test("keeps a long set's send action in view at the drawer's bottom while its questions scroll", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 820 });
  await openAskingWindow(page);
  await chips(page).first().click();
  await expect(drawer(page)).toBeVisible();
  // A long context and many questions: the drawer must scroll, or the check below proves nothing.
  await shownChat(page).locator("workbench-question-chips").evaluate((element: HTMLElement & { asks: { context: string; questions: unknown[] }[] }) => {
    const [ask] = element.asks;
    if (ask !== undefined) element.asks = [{ ...ask, context: `${ask.context}\n\n`.repeat(6), questions: [...ask.questions, ...ask.questions, ...ask.questions] }];
  });
  const sets = drawer(page).locator(".sets");
  expect(await sets.evaluate((element) => element.scrollHeight > element.clientHeight + 100)).toBe(true);
  const send = drawer(page).getByRole("button", { name: "Send answers" });
  const within = async () => {
    const [area, button] = await Promise.all([sets.boundingBox(), send.boundingBox()]);
    expect(area !== null && button !== null && button.y >= area.y && button.y + button.height <= area.y + area.height + 1).toBe(true);
  };
  await within();
  await sets.evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
  await within();
});

test("keeps twelve questions to one row of chips in a crowded grid, opens a side tile's question in one click, and answers through a drawer with room", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 820 });
  await openCrowdedGrid(page);
  await expect(chips(page)).toHaveCount(12);
  const composer = () => shownChat(page).locator("prompt-editor").boundingBox();
  const tile = () => page.locator('.tile[data-focused="true"]').boundingBox();
  const oneRow = async () => {
    const boxes = await Promise.all((await chips(page).all()).map((chip) => chip.boundingBox()));
    const strip = await shownChat(page).locator("workbench-question-chips .chips").boundingBox();
    const below = await composer();
    expect(new Set(boxes.map((box) => box?.y)).size).toBe(1);
    expect(strip !== null && below !== null && strip.height <= 40 && strip.y + strip.height <= below.y + 1).toBe(true);
  };
  await oneRow();

  // One click on a side tile's chip focuses that tile and opens its drawer at the question.
  const sideChip = page.locator(`.tile[data-session="${ASKING}"] workbench-chat-pane workbench-question-chips .chip`).nth(1);
  await expect(sideChip).toBeVisible();
  await sideChip.click();
  await expect(shownChat(page)).toHaveAttribute("data-session", ASKING);
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator('input[value="unit"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);

  await page.locator(`.tile[data-session="${CROWDED}"] .tile-bar`).click();
  await expect(shownChat(page)).toHaveAttribute("data-session", CROWDED);
  await chips(page).nth(4).click();
  await expect(drawer(page)).toBeVisible();
  await oneRow();
  // The drawer keeps a usable height inside its tile, above a composer still on screen; the transcript gives way.
  const [open, below, area] = await Promise.all([drawer(page).boundingBox(), composer(), tile()]);
  expect(open !== null && below !== null && area !== null).toBe(true);
  if (open === null || below === null || area === null) return;
  expect(open.height).toBeGreaterThanOrEqual(Math.min(160, area.height * 0.4));
  expect(open.y).toBeGreaterThanOrEqual(area.y);
  expect(below.y + below.height).toBeLessThanOrEqual(area.y + area.height + 1);
  const fieldsets = drawer(page).locator("ask-user-card fieldset");
  await expect(fieldsets).toHaveCount(12);
  for (const fieldset of await fieldsets.all()) await fieldset.locator('input[value="now"]').check();
  await drawer(page).getByRole("button", { name: "Send answers" }).click();
  await expect(chips(page)).toHaveCount(0);
  await expect(tabCount(page, CROWDED)).toHaveCount(0);
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
