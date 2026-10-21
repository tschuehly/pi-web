import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_LONG_CHAT, E2E_MORE_CHATS, E2E_PROJECT_ID, E2E_SESSION_ID } from "./isolatedPiWeb";

// Set PI_WEB_E2E_SCREENSHOTS to a folder to keep review screenshots of the window tabs and grid.
const SHOTS = process.env["PI_WEB_E2E_SCREENSHOTS"];
const STORE_KEY = "pi-workbench.windows.v1";
const [NOTES, RELEASE, GUIDE] = [E2E_SESSION_ID, E2E_MORE_CHATS[0].id, E2E_MORE_CHATS[1].id];

/**
 * One window holding the three fixture Chats: two in a long-named Workstream, one in another (or all in one).
 * Crowded: one Workstream of eight long-titled tabs, five of them placeholders, NOTES last.
 */
function seededWindow(workspaceId: string, oneWorkstream = false, crowded = false, looseGuide = false) {
  const chat = (sessionId: string, title: string, workstream: { id: string; title: string } | undefined) => ({ sessionId, title, machineId: "local", projectId: E2E_PROJECT_ID, workspaceId, workstream });
  const dogfooding = { id: "ws-dogfooding", title: "Pi Workbench UI dogfooding and two-tier tab layout review" };
  const docs = { id: "ws-docs", title: "Docs" };
  if (crowded) {
    const filler = Array.from({ length: 5 }, (_, index) => chat(`crowded-${String(index)}`, `A long Chat title that has to ellipsize ${String(index)}`, dogfooding));
    return { e2e: { name: "Window 1", layout: "tabs", maximized: false, focused: NOTES, lastActive: {}, chats: [...filler, chat(RELEASE, "Draft the release notes", dogfooding), chat(GUIDE, "Review the install guide", dogfooding), chat(NOTES, "Where are the notes?", dogfooding)] } };
  }
  return {
    e2e: {
      name: "Window 1", layout: "tabs", maximized: false, focused: NOTES, lastActive: {},
      chats: [chat(NOTES, "Where are the notes?", dogfooding), chat(RELEASE, "Draft the release notes", dogfooding), chat(GUIDE, "Review the install guide", looseGuide ? undefined : oneWorkstream ? dogfooding : docs)],
    },
  };
}

async function openSeededWindow(page: Page, oneWorkstream = false, crowded = false, looseGuide = false): Promise<void> {
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (workspaceId === undefined || url === undefined) throw new Error("Isolated PI WEB was not started");
  // Only the first page seeds: a window this test opens later must find the store as the first one left it.
  await page.addInitScript(([key, value]) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, [STORE_KEY, JSON.stringify(seededWindow(workspaceId, oneWorkstream, crowded, looseGuide))] as const);
  const target = new URL(url);
  target.searchParams.set("win", "e2e");
  await page.goto(target.toString());
  await expect(shownChat(page)).toHaveAttribute("data-session", NOTES);
}

const shownChat = (page: Page) => page.locator("main.chat-shell").first();
const workstreamTab = (page: Page, name: string) => page.locator("workbench-window-tabs .workstream-tab", { hasText: name });
const chatTab = (page: Page, name: string) => page.locator("workbench-window-tabs .chat-tab", { hasText: name });
/** The selected Chat's toolbar, slotted into the window's tab row in Tabs. */
const tabRowTools = (page: Page) => page.locator("workbench-window-tabs > .chat-tools");

test("switches Workstreams back to their last Chat, lays them out as a grid, and moves a Chat to a new window", async ({ page, context }) => {
  await openSeededWindow(page);
  await expect(page.locator("workbench-window-tabs .workstream-tab .title")).toHaveText(["Pi Workbench UI dogfooding and two-tier tab layout review", "Docs"]);
  await expect(page.locator("workbench-window-tabs .chat-tab .title")).toHaveText(["Where are the notes?", "Draft the release notes"]);
  // The Chat's tools share the Chat tabs' row, its folder named only in the Files tooltip; the Chat keeps no header of its own.
  await expect(tabRowTools(page).locator(".files-toggle")).toHaveAttribute("title", /^Files — e2e · .+ \(\/.+\)$/);
  const row = await page.locator("workbench-window-tabs .bar").boundingBox();
  const files = await tabRowTools(page).locator(".files-toggle").boundingBox();
  expect(files !== null && row !== null && files.y >= row.y && files.y + files.height <= row.y + row.height).toBe(true);
  await expect(shownChat(page).locator("header")).toHaveCount(0);
  // Tabs keep between 120px and 200px, a long title ellipsized with the full title as the tooltip; × shows on every Chat tab.
  const widths = await page.locator("workbench-window-tabs .workstream-tab, workbench-window-tabs .chat-tab").evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
  expect(Math.max(...widths)).toBeLessThanOrEqual(200);
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(120);
  await expect(workstreamTab(page, "dogfooding")).toHaveAttribute("title", "Workstream: Pi Workbench UI dogfooding and two-tier tab layout review");
  expect(await workstreamTab(page, "dogfooding").locator(".title").evaluate((title) => title.scrollWidth > title.clientWidth)).toBe(true);
  await expect(chatTab(page, "Draft the release notes").locator(".close")).toBeVisible();

  await chatTab(page, "Draft the release notes").click();
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  await workstreamTab(page, "Docs").click();
  await expect(shownChat(page)).toHaveAttribute("data-session", GUIDE);
  // Docs holds one Chat: its Workstream tab stands for it, so no Chat tab repeats it beneath.
  await expect(page.locator("workbench-window-tabs .chat-tab")).toHaveCount(0);
  await expect(workstreamTab(page, "Docs").locator(".close")).toBeVisible();
  await workstreamTab(page, "dogfooding").focus();
  await page.keyboard.press("Enter");
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  expect(new URL(page.url()).searchParams.get("win")).toBe("e2e");

  await page.keyboard.press("Control+g");
  await expect(page.locator(".grid > .tile")).toHaveCount(3);
  await expect(page.locator("workbench-chat-pane")).toHaveCount(2);
  await expect(page.locator('.tile[data-focused="true"] main.chat-shell')).toHaveAttribute("data-session", RELEASE);
  await expect(tabRowTools(page)).toHaveCount(0);
  await expect(page.locator('.tile[data-focused="true"] > .tile-bar .files-toggle')).toBeVisible();
  await expect(page.locator(`.tile[data-session="${GUIDE}"] workbench-chat-pane chat-view`)).toContainText("Done.");
  await page.locator(`.tile[data-session="${NOTES}"] .tile-bar`).click();
  await expect(page.locator('.tile[data-focused="true"] main.chat-shell')).toHaveAttribute("data-session", NOTES);
  await page.locator('.tile[data-focused="true"] .cm-content').click();
  await page.keyboard.type("kept draft");
  await page.keyboard.press("Control+g");
  await expect(page.locator(".grid > .tile")).toHaveCount(1);
  await expect(page.locator("workbench-chat-pane")).toHaveCount(0);
  await expect(shownChat(page).locator(".cm-content")).toHaveText("kept draft");
  await page.keyboard.type(" and more");
  await expect(shownChat(page).locator(".cm-content")).toHaveText("kept draft and more");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");

  await chatTab(page, "Where are the notes?").click({ button: "right" });
  const popup = context.waitForEvent("page");
  await page.getByRole("menuitem", { name: "Move to new window" }).click();
  const moved = await popup;
  await expect(shownChat(moved)).toHaveAttribute("data-session", NOTES);
  await expect(moved.locator("workbench-window-tabs .chat-tab .title")).toHaveText(["Where are the notes?"]);
  // A single Workstream needs no Workstream row: one row of Chat tabs and tools.
  await expect(moved.locator("workbench-window-tabs .workstream-tab")).toHaveCount(0);
  await expect(tabRowTools(moved).locator(".files-toggle")).toBeVisible();
  expect(new URL(moved.url()).searchParams.get("win")).not.toBe("e2e");
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  // Both Workstreams now hold one Chat each: their tabs stand for those Chats, with no Chat row beneath.
  await expect(page.locator("workbench-window-tabs .chat-tab")).toHaveCount(0);
  await expect(workstreamTab(page, "dogfooding")).toHaveAttribute("data-session", RELEASE);
});

interface SwitchFrame { phase: string; tabs: { session: string; width: number; selected: boolean; status: string; color: string; opacity: string }[]; shown: string; articles: number; scrollTop: number; atBottom: boolean }

/** Samples every frame: the Chat tabs' widths, colours and selection, and the Chat on screen with its transcript scroll. */
function sampleFrames(): void {
  const frames: unknown[] = [];
  Reflect.set(window, "switchFrames", frames);
  const sample = () => {
    const app = document.querySelector("pi-workbench-app")?.shadowRoot;
    const tabs = app?.querySelector("workbench-window-tabs")?.shadowRoot;
    const shell = app?.querySelector("main.chat-shell");
    const chat = shell?.querySelector("chat-view")?.shadowRoot?.querySelector(".chat");
    frames.push({
      phase: String(Reflect.get(window, "switchPhase")),
      tabs: [...tabs?.querySelectorAll<HTMLElement>(".chat-tab") ?? []].map((tab) => ({ session: tab.dataset["session"] ?? "", width: tab.getBoundingClientRect().width, selected: tab.getAttribute("aria-selected") === "true", status: tab.dataset["status"] ?? "", color: getComputedStyle(tab).color, opacity: getComputedStyle(tab).opacity })),
      shown: shell?.getAttribute("data-session") ?? "",
      articles: chat?.querySelectorAll("article").length ?? 0,
      scrollTop: chat?.scrollTop ?? -1,
      atBottom: chat === null || chat === undefined ? false : chat.scrollHeight - chat.scrollTop - chat.clientHeight < 2,
    });
    if (Reflect.get(window, "switchFrames") === frames) requestAnimationFrame(afterPaint);
  };
  // Read once the frame's animation callbacks (scroll restores among them) ran and it painted.
  const afterPaint = () => { setTimeout(sample, 0); };
  requestAnimationFrame(afterPaint);
}

test("switches tabs steadily: same tab widths, one selected tab, never a blank Chat, and each Chat's scroll kept", async ({ page }) => {
  await openSeededWindow(page, true);
  await expect(shownChat(page).locator("chat-view article").first()).toBeVisible();
  const transcript = (page: Page) => shownChat(page).locator("chat-view .chat");
  const phase = (name: string) => page.evaluate((value) => { Reflect.set(window, "switchPhase", value); }, name);
  const show = async (session: string, title: string) => {
    await chatTab(page, title).click();
    await expect(shownChat(page)).toHaveAttribute("data-session", session);
    await page.waitForTimeout(300);
  };
  await page.evaluate(sampleFrames);
  // First visits load each Chat; GUIDE stays at its bottom, RELEASE is scrolled up.
  await phase("first");
  await show(GUIDE, "Review the install guide");
  await show(RELEASE, "Draft the release notes");
  await transcript(page).hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(300);
  const releaseTop = await transcript(page).evaluate((chat) => chat.scrollTop);
  expect(releaseTop).toBeGreaterThan(0);
  await phase("again");
  for (const [session, title] of [[NOTES, "Where are the notes?"], [GUIDE, "Review the install guide"], [RELEASE, "Draft the release notes"], [NOTES, "Where are the notes?"], [RELEASE, "Draft the release notes"], [GUIDE, "Review the install guide"]] as const) await show(session, title);
  const frames = await page.evaluate(() => { const frames = Reflect.get(window, "switchFrames") as SwitchFrame[]; Reflect.set(window, "switchFrames", undefined); return frames; });

  expect(frames.length).toBeGreaterThan(30);
  for (const session of [NOTES, RELEASE, GUIDE]) {
    const widths = new Set(frames.map((frame) => frame.tabs.find((tab) => tab.session === session)?.width.toFixed(1)));
    expect(widths, `widths of tab ${session}`).toEqual(new Set([[...widths][0]]));
  }
  const unsteady = frames.filter((frame) => frame.tabs.filter((tab) => tab.selected).length !== 1 || frame.tabs.some((tab) => tab.opacity !== "1"));
  expect(unsteady, "frames without exactly one selected, fully opaque tab").toEqual([]);
  // The selected tab is in full text colour from its first frame: no fade through grey.
  expect(new Set(frames.flatMap((frame) => frame.tabs.filter((tab) => tab.selected).map((tab) => tab.color))).size, "selected tab colours").toBe(1);
  expect(frames.filter((frame) => frame.shown === "" || frame.articles === 0), "blank Chat frames").toEqual([]);
  const again = frames.filter((frame) => frame.phase === "again");
  expect(new Set(again.filter((frame) => frame.shown === RELEASE).map((frame) => Math.round(frame.scrollTop))), "RELEASE scroll in every frame").toEqual(new Set([Math.round(releaseTop)]));
  expect(frames.filter((frame) => frame.shown === GUIDE && !frame.atBottom).length, "GUIDE frames off its bottom").toBe(0);
});

test("a crowded tab row keeps every tool clickable: only the Chat tabs shrink and scroll, the selected one in view", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 820 });
  await openSeededWindow(page, true, true);
  const controls = page.locator("workbench-window-tabs > .chat-tools").locator("button, summary").or(page.locator("workbench-window-tabs .actions button"));
  const expectClickable = async () => {
    await expect(tabRowTools(page).locator(".files-toggle")).toBeVisible();
    for (const control of await controls.all()) {
      // A trial click fails when another element (the tab strip) covers the control's centre.
      await control.click({ trial: true, timeout: 2000 });
      const box = await control.boundingBox();
      expect(box !== null && box.x >= 0 && box.x + box.width <= 900, `${await control.getAttribute("aria-label") ?? await control.innerText()} inside the window`).toBe(true);
    }
    const strip = await page.locator("workbench-window-tabs .tabs.chats").evaluate((tabs) => {
      const selected = tabs.querySelector('[aria-selected="true"]')?.getBoundingClientRect();
      const bounds = tabs.getBoundingClientRect();
      return { scrolls: tabs.scrollWidth > tabs.clientWidth, inView: selected !== undefined && selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1, widths: [...tabs.children].map((tab) => tab.getBoundingClientRect().width) };
    });
    expect(strip.scrolls).toBe(true);
    expect(strip.inView).toBe(true);
    expect(Math.min(...strip.widths)).toBeGreaterThanOrEqual(120);
  };
  await expectClickable();
  // A Workstream's drawer joins the tools: it takes its room from the tabs, not from the tools beside it.
  await page.locator("pi-workbench-app").evaluate((app) => { Reflect.set(app, "currentWorkstream", { id: "ws-dogfooding", title: "Pi Workbench UI dogfooding and two-tier tab layout review", sessions: [], closed: false }); });
  await expect(tabRowTools(page).locator("workstream-context-drawer")).toBeVisible();
  await expectClickable();
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "tabs-crowded-900.png") });
});

for (const scale of ["1", "1.25"]) {
  test(`the tab row's controls share one centre and one gap per group at interface scale ${scale}`, async ({ page }) => {
    await page.addInitScript((value) => { localStorage.setItem("pi-web-app-scale", value); }, scale);
    await page.setViewportSize({ width: 1000, height: 820 });
    await openSeededWindow(page, true);
    // The fixture has no Workstream service: once its lookup settles, show the drawer as a found Workstream would.
    await expect.poll(() => page.locator("pi-workbench-app").evaluate((app) => Reflect.get(app, "currentWorkstream"))).toBeNull();
    await page.locator("pi-workbench-app").evaluate((app) => { Reflect.set(app, "currentWorkstreamError", ""); Reflect.set(app, "currentWorkstream", { id: "ws-dogfooding", title: "Pi Workbench UI dogfooding and two-tier tab layout review", sessions: [], closed: false }); });
    await expect(tabRowTools(page).locator("workstream-context-drawer")).toBeVisible();
    const row = await page.locator("workbench-window-tabs").evaluate((tabs) => {
      const box = (element: Element) => element.getBoundingClientRect();
      const bar = tabs.shadowRoot?.querySelector(".bar");
      const actions = tabs.shadowRoot?.querySelectorAll(".actions button") ?? [];
      const tools = [...tabs.querySelectorAll(".chat-tools > *")];
      const gaps = (group: Element[]) => group.slice(1).map((element, index) => box(element).left - box(group[index] ?? element).right);
      return {
        centre: bar === null || bar === undefined ? NaN : box(bar).top + box(bar).height / 2,
        centres: [...tools, ...actions, ...(tabs.shadowRoot?.querySelectorAll(".chat-tab .title") ?? [])].map((element) => box(element).top + box(element).height / 2),
        toolGaps: gaps(tools),
        actionGaps: gaps([...actions]),
      };
    });
    for (const centre of row.centres) expect(Math.abs(centre - row.centre)).toBeLessThanOrEqual(1);
    for (const gaps of [row.toolGaps, row.actionGaps]) expect(Math.max(...gaps) - Math.min(...gaps), gaps.join(", ")).toBeLessThanOrEqual(1);
    // The Workstream control keeps the row's type, its full title as the tooltip.
    const summary = tabRowTools(page).locator("workstream-context-drawer summary");
    await expect(summary).toHaveAttribute("title", "Pi Workbench UI dogfooding and two-tier tab layout review");
    expect(await summary.evaluate((element) => getComputedStyle(element).fontSize)).toBe(await chatTab(page, "Where are the notes?").evaluate((element) => getComputedStyle(element).fontSize));
  });
}

/** Each Grid tile, by Chat: its box, its transcript's box, its first visible message and where it sits, and its outline. */
function gridLayout() {
  const app = document.querySelector("pi-workbench-app")?.shadowRoot;
  const rect = (element: Element | null | undefined) => { const box = element?.getBoundingClientRect(); return box === undefined ? [] : [box.x, box.y, box.width, box.height].map(Math.round); };
  return [...app?.querySelectorAll<HTMLElement>(".grid > .tile") ?? []].map((tile) => {
    const view = tile.querySelector("main.chat-shell chat-view") ?? tile.querySelector("workbench-chat-pane")?.shadowRoot?.querySelector("chat-view");
    const chat = view?.shadowRoot?.querySelector(".chat");
    const top = chat?.getBoundingClientRect().top ?? 0;
    const first = [...chat?.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]") ?? []].find((element) => element.getBoundingClientRect().bottom > top + 1);
    return {
      session: tile.dataset["session"] ?? tile.querySelector<HTMLElement>("main.chat-shell")?.dataset["session"] ?? "",
      focused: tile.dataset["focused"] === "true",
      outlined: getComputedStyle(tile).outlineStyle !== "none",
      tile: rect(tile),
      transcript: rect(chat),
      anchor: first?.dataset["scrollAnchorId"] ?? "none",
      message: Math.round(first?.getBoundingClientRect().top ?? -1),
    };
  }).sort((a, b) => a.session.localeCompare(b.session));
}

type GridLayout = ReturnType<typeof gridLayout>;

/** Opens a Grid of `sessions` with `focused` outlined, at 1440×900, once every tile shows its transcript. */
async function openGrid(page: Page, sessions: readonly string[], focused = sessions[0]): Promise<void> {
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (workspaceId === undefined || url === undefined) throw new Error("Isolated PI WEB was not started");
  const workstreams = [{ id: "ws-dogfooding", title: "Dogfooding" }, { id: "ws-docs", title: "Docs" }, { id: "ws-grid", title: "Grid focus" }];
  const chats = sessions.map((sessionId, index) => ({ sessionId, title: `Chat ${String(index + 1)}`, machineId: "local", projectId: E2E_PROJECT_ID, workspaceId, workstream: workstreams[index % workstreams.length] }));
  await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [STORE_KEY, JSON.stringify({ e2e: { name: "Window 1", layout: "grid", maximized: false, focused, lastActive: {}, chats } })] as const);
  await page.setViewportSize({ width: 1440, height: 900 });
  const target = new URL(url);
  target.searchParams.set("win", "e2e");
  await page.goto(target.toString());
  await expect(page.locator(".grid > .tile")).toHaveCount(sessions.length);
  await expect.poll(async () => (await page.evaluate(gridLayout)).every((tile) => tile.anchor !== "none"), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(600);
}

/** The tiles that moved, within a pixel: their box, their transcript's box, or their first visible message and its top. */
function movedTiles(before: GridLayout, after: GridLayout) {
  return before.flatMap((was, index) => {
    const now = after[index];
    const numbers = [...was.tile, ...was.transcript, was.message];
    const nowNumbers = now === undefined ? [] : [...now.tile, ...now.transcript, now.message];
    return now?.session === was.session && now.anchor === was.anchor && numbers.every((value, at) => Math.abs(value - (nowNumbers[at] ?? NaN)) <= 1) ? [] : [{ was, now }];
  });
}

/** Presses the middle of `session`'s tile transcript, which focuses it, and waits for the focus to settle. */
async function focusTile(page: Page, session: string): Promise<void> {
  const box = await page.locator(`.grid > .tile[data-session="${session}"]`).boundingBox();
  if (box === null) throw new Error(`tile ${session} is not on screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
  await expect(page.locator('.tile[data-focused="true"] main.chat-shell')).toHaveAttribute("data-session", session);
  await page.waitForTimeout(800);
}

for (const count of [2, 4]) {
  test(`every Grid tile looks the same focused or not: focusing another of ${String(count)} tiles only moves the outline`, async ({ page }) => {
    const sessions = [NOTES, RELEASE, GUIDE, E2E_LONG_CHAT.id].slice(0, count);
    await openGrid(page, sessions);
    const before = await page.evaluate(gridLayout);
    for (const session of [...sessions.slice(1), NOTES]) {
      // Anywhere in the tile focuses it: here, the middle of its transcript.
      await focusTile(page, session);
      const after = await page.evaluate(gridLayout);
      expect(movedTiles(before, after), `tiles that moved after focusing ${session}`).toEqual([]);
      expect(after.filter((tile) => tile.outlined).map((tile) => tile.session), "only the focused tile is outlined").toEqual([session]);
      await page.keyboard.type("typed here");
      await expect(page.locator('.tile[data-focused="true"] .cm-content')).toHaveText("typed here");
      await page.keyboard.press("Meta+a");
      await page.keyboard.press("Backspace");
    }
  });
}

test("focusing the full-width tile of three keeps the scrolled top-right tile where it was read", async ({ page }) => {
  const sessions = [NOTES, E2E_LONG_CHAT.id, GUIDE];
  await openGrid(page, sessions, E2E_LONG_CHAT.id);
  await page.locator('.tile[data-focused="true"] chat-view .chat').hover();
  for (let step = 0; step < 4; step += 1) { await page.mouse.wheel(0, -1200); await page.waitForTimeout(200); }
  await page.waitForTimeout(800);
  const before = await page.evaluate(gridLayout);
  for (const session of [GUIDE, E2E_LONG_CHAT.id]) {
    await focusTile(page, session);
    expect(movedTiles(before, await page.evaluate(gridLayout)), `tiles that moved after focusing ${session}`).toEqual([]);
  }
});

test("Files stays open beside the Grid when focus moves, and moves no tile", async ({ page }) => {
  await openGrid(page, [NOTES, RELEASE, GUIDE]);
  await page.locator('.tile[data-focused="true"] > .tile-bar .files-toggle').click();
  await expect(page.locator("workbench-files-pane")).toBeVisible();
  await page.waitForTimeout(600);
  const before = await page.evaluate(gridLayout);
  await focusTile(page, RELEASE);
  await expect(page.locator("workbench-files-pane")).toBeVisible();
  expect(movedTiles(before, await page.evaluate(gridLayout))).toEqual([]);
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "grid-3-files.png") });
});

test("a window-wide notice shows once above the Grid and stays put when focus moves", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "Notification", { configurable: true, value: class { static permission = "denied"; static requestPermission() { return Promise.resolve("denied"); } } }); });
  await openGrid(page, [NOTES, RELEASE]);
  // Shown once, above the Grid: not inside a tile, where it would move with focus.
  await expect(page.locator("p.error[role=alert]", { hasText: "notifications" })).toHaveCount(1);
  const notice = page.locator("pi-workbench-app .stage > p.error[role=alert]");
  await expect(notice).toHaveCount(1);
  await expect(page.locator(".grid p.error[role=alert]")).toHaveCount(0);
  const before = await page.evaluate(gridLayout);
  await focusTile(page, RELEASE);
  await expect(notice).toHaveCount(1);
  expect(movedTiles(before, await page.evaluate(gridLayout))).toEqual([]);
});

test("Edit Workstream in a quarter tile scrolls inside the tile, its Save in reach", async ({ page }) => {
  await openGrid(page, [NOTES, RELEASE, GUIDE, E2E_LONG_CHAT.id]);
  // The fixture has no Workstream service: show the focused tile's Workstream as a found one would.
  await expect.poll(() => page.locator("pi-workbench-app").evaluate((app) => Reflect.get(app, "currentWorkstream"))).toBeNull();
  await page.locator("pi-workbench-app").evaluate((app) => { Reflect.set(app, "currentWorkstreamError", ""); Reflect.set(app, "currentWorkstream", { id: "ws-dogfooding", title: "Dogfooding", revision: 1, updatedAt: "", sessions: [], humanTasks: [], links: [], closed: false, overview: { goal: "Dogfood the Grid", description: "Every tile looks the same.", doneWhen: "Focus moves only the outline." } }); });
  const drawer = page.locator('.tile[data-focused="true"] > .tile-bar workstream-context-drawer');
  await drawer.locator("summary").click();
  await drawer.getByRole("button", { name: "Edit Workstream" }).click();
  const save = drawer.getByRole("button", { name: "Save" });
  await expect(save).toBeAttached();
  const reach = await page.locator('.tile[data-focused="true"]').evaluate((tile) => {
    const drawerRoot = tile.querySelector("workstream-context-drawer")?.shadowRoot;
    const sheet = drawerRoot?.querySelector<HTMLElement>(".sheet");
    if (sheet === null || sheet === undefined) return undefined;
    sheet.scrollTop = sheet.scrollHeight;
    const button = [...drawerRoot?.querySelectorAll("button") ?? []].find((candidate) => candidate.textContent === "Save");
    const box = button?.getBoundingClientRect();
    const bounds = tile.getBoundingClientRect();
    const hit = box === undefined ? null : drawerRoot?.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { inside: box !== undefined && box.top >= bounds.top && box.bottom <= bounds.bottom, hit: hit === button, tileScroll: tile.scrollTop };
  });
  expect(reach).toEqual({ inside: true, hit: true, tileScroll: 0 });
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, "grid-4-drawer.png") });
});

test("one click on a resting tile's Files focuses the tile and opens its Files", async ({ page }) => {
  await openGrid(page, [NOTES, RELEASE, GUIDE]);
  const box = await page.locator(`.tile[data-session="${RELEASE}"] > .tile-bar .files-toggle`).boundingBox();
  if (box === null) throw new Error("the resting tile shows no Files button");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.tile[data-focused="true"] main.chat-shell')).toHaveAttribute("data-session", RELEASE);
  await expect(page.locator("workbench-files-pane")).toBeVisible();
  await expect(page.locator('.tile[data-focused="true"] > .tile-bar .files-toggle')).toHaveAttribute("aria-expanded", "true");
});

/** The Chat tile and the neighbour preview beside it during a swipe. */
const swipeStage = (page: Page) => page.locator("pi-workbench-app").evaluate((app) => {
  const tile = app.shadowRoot?.querySelector<HTMLElement>(".grid > .tile");
  const peek = app.shadowRoot?.querySelector<HTMLElement>(".swipe-peek");
  return { tileLeft: tile?.getBoundingClientRect().left, transform: tile?.style.transform, peekLeft: peek === null || peek === undefined ? undefined : peek.getBoundingClientRect().left, peekVisible: peek === null || peek === undefined ? false : getComputedStyle(peek).visibility === "visible" };
});

test("a swipe to a Chat that loads slowly shows its preview, and a vertical scroll meanwhile never strands the Chat offscreen", async ({ page }) => {
  await openSeededWindow(page, true);
  await expect(shownChat(page).locator("chat-view article").first()).toBeVisible();
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  await page.route((url) => url.pathname.includes(RELEASE) && url.pathname.includes("/messages"), async (route) => { await arrived; await route.continue(); });
  await shownChat(page).locator("chat-view .chat").hover();
  // One big sample is a flick: it moves on at once, and the neighbour's preview fills the stage while its Chat loads.
  await page.mouse.wheel(40, 0);
  await page.waitForTimeout(300);
  const pending = await swipeStage(page);
  await page.screenshot({ path: test.info().outputPath("swipe-pending.png") });
  expect(pending.peekVisible, "preview shows while the Chat loads").toBe(true);
  expect(pending.peekLeft).toBe(0);
  await expect(shownChat(page)).toHaveAttribute("data-session", NOTES);
  await page.mouse.wheel(0, 20);
  arrive();
  for (let step = 0; step < 12; step += 1) { await page.waitForTimeout(40); await page.mouse.wheel(0, 20); }
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  await expect.poll(() => swipeStage(page)).toMatchObject({ tileLeft: 0, transform: "", peekVisible: false });
  await chatTab(page, "Review the install guide").click();
  await expect(shownChat(page)).toHaveAttribute("data-session", GUIDE);
  await expect.poll(() => swipeStage(page)).toMatchObject({ tileLeft: 0, transform: "" });
});

test("a second page opened on a live window's id gets a window of its own", async ({ page, context }) => {
  await openSeededWindow(page);
  const duplicate = await context.newPage();
  const sameWindow = new URL(page.url());
  sameWindow.search = "?win=e2e";
  await duplicate.goto(sameWindow.toString());
  await expect.poll(() => new URL(duplicate.url()).searchParams.get("win")).not.toBe("e2e");
  await expect(page.locator("workbench-window-tabs .chat-tab .title")).toHaveText(["Where are the notes?", "Draft the release notes"]);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { chats: unknown[] }>, STORE_KEY);
  expect(stored["e2e"]?.chats).toHaveLength(3);
});

test("a notification opened in another window shows the Chat in the window holding it, which keeps it", async ({ page, context }) => {
  await openSeededWindow(page);
  const other = await context.newPage();
  const otherWindow = new URL(page.url());
  otherWindow.search = "?win=other";
  await other.goto(otherWindow.toString());
  await expect(other.locator('[data-view="chooser"]')).toBeVisible();
  // The macOS app loads a notification's Chat URL, without the window id, into the frontmost window.
  const notification = new URL(page.url());
  notification.searchParams.delete("win");
  notification.searchParams.set("session", RELEASE);
  await other.goto(notification.toString());

  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  await expect(other.locator('[data-view="chooser"]')).toBeVisible();
  expect(new URL(other.url()).searchParams.get("win")).toBe("other");
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { chats: unknown[] }>, STORE_KEY);
  expect(stored["e2e"]?.chats).toHaveLength(3);
  expect(stored["other"]?.chats).toHaveLength(0);
});

test("Back to a Chat moved to another window shows it there, which keeps it", async ({ page, context }) => {
  await openSeededWindow(page);
  await chatTab(page, "Where are the notes?").click({ button: "right" });
  const popup = context.waitForEvent("page");
  await page.getByRole("menuitem", { name: "Move to new window" }).click();
  const moved = await popup;
  await expect(shownChat(moved)).toHaveAttribute("data-session", NOTES);
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("session")).toBe(RELEASE);
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  await expect(moved.locator("workbench-window-tabs .chat-tab .title")).toHaveText(["Where are the notes?"]);
  await expect(shownChat(moved)).toHaveAttribute("data-session", NOTES);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { chats: { sessionId: string }[] }>, STORE_KEY);
  expect(stored["e2e"]?.chats.map((chat) => chat.sessionId)).not.toContain(NOTES);
});

test("places the move menu at the pointer under a larger interface scale", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("pi-web-app-scale", "1.25"); });
  await openSeededWindow(page);
  const tab = chatTab(page, "Draft the release notes");
  const box = await tab.boundingBox();
  if (box === null) throw new Error("missing tab geometry");
  await tab.click({ button: "right", position: { x: 20, y: 10 } });
  const menu = await page.locator(".window-menu").boundingBox();
  if (menu === null) throw new Error("missing menu geometry");
  expect(Math.abs(menu.x - (box.x + 20))).toBeLessThan(4);
  expect(Math.abs(menu.y - (box.y + 10))).toBeLessThan(4);
});

const composer = (page: Page) => page.locator("main.chat-shell prompt-editor .cm-content");

async function openWindow(page: Page, windowId: string, sessionId?: string): Promise<void> {
  const target = new URL(process.env["PI_WEB_E2E_CHAT_URL"] ?? "");
  target.searchParams.set("win", windowId);
  if (sessionId === undefined) target.search = `?win=${encodeURIComponent(windowId)}`;
  else target.searchParams.set("session", sessionId);
  await page.goto(target.toString());
  // The initial render is also a chooser: wait for the attempted selection before asserting it was refused.
  await expect.poll(() => page.locator("pi-workbench-app").evaluate((app) => Reflect.get(app, "loading"))).toBe(false);
}

/** A real WebKit quota, not a mocked setItem: draft writes and ownership writes compete for the same space. */
async function fillStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    let low = 0, high = 10 * 1024 * 1024;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      try { localStorage.setItem("ownership-quota", "x".repeat(length)); low = length; }
      catch { high = length - 1; }
    }
  });
}

test("r6–r7: full storage refuses both unrecorded owners and recovers", async ({ page, context }) => {
  const other = await context.newPage();
  await openWindow(page, "quota1");
  await expect(page.locator('[data-view="chooser"]')).toBeVisible();
  await openWindow(other, "quota2");
  await expect(other.locator('[data-view="chooser"]')).toBeVisible();
  await fillStorage(page);
  for (const [window, id] of [[page, "quota1"], [other, "quota2"]] as const) {
    await openWindow(window, id, NOTES);
    await expect(window.getByRole("alert").filter({ hasText: "storage is full" })).toBeVisible();
    await expect(composer(window)).toHaveCount(0);
  }
  await page.evaluate(() => { localStorage.removeItem("ownership-quota"); });
  await openWindow(page, "quota1", NOTES);
  await expect(composer(page)).toBeVisible();
});

test("r7: full storage keeps unsaved edits through heartbeats and a refused move", async ({ page, context }) => {
  test.setTimeout(60_000);
  await openWindow(page, "quota1", NOTES);
  await expect(composer(page)).toBeVisible();
  const other = await context.newPage();
  await openWindow(other, "quota2");
  await expect(other.locator('[data-view="chooser"]')).toBeVisible();
  await composer(page).click();
  await page.keyboard.type("stored prefix");
  await expect(composer(page)).toHaveText("stored prefix");
  await fillStorage(page);
  await composer(page).press("End");
  await page.keyboard.type(" and important unsaved edits");
  // Two genuine heartbeat intervals must not replay an older durable draft.
  await page.waitForTimeout(21_000);
  await expect(composer(page)).toHaveText("stored prefix and important unsaved edits");
  await page.locator("workbench-window-tabs .chat-tab").click({ button: "right" });
  const popup = context.waitForEvent("page");
  await page.getByRole("menuitem", { name: "Move to new window", exact: true }).click();
  const target = await popup;
  await expect(target.locator('[data-view="chooser"]')).toBeVisible();
  await expect(composer(target)).toHaveCount(0);
  await expect(composer(page)).toHaveText("stored prefix and important unsaved edits");
});

test("r7: a title update rejected by real quota does not retry itself", async ({ page }) => {
  await openWindow(page, "quota1", NOTES);
  await expect(composer(page)).toBeVisible();
  await fillStorage(page);
  const attempts = await page.locator("pi-workbench-app").evaluate(async (app) => {
    const original = Storage.prototype.setItem;
    let count = 0;
    Storage.prototype.setItem = function (key, value) { if (key === "pi-workbench.windows.v1") count++; original.call(this, key, value); };
    try {
      const sessions = Reflect.get(app, "sessions") as { applyGlobalEvent: (event: unknown) => void };
      const state = Reflect.get(app, "app") as { selectedSession: { id: string } };
      sessions.applyGlobalEvent({ type: "session.name", sessionId: state.selectedSession.id, name: "Long new title " + "x".repeat(100) });
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      return count;
    } finally { localStorage.removeItem("ownership-quota"); Storage.prototype.setItem = original; }
  });
  expect(attempts).toBeLessThanOrEqual(1);
});

test("without Web Locks a draft outlives its closed window", async ({ context }) => {
  // Plain-http LAN origins lack navigator.locks; window stores then live per tab, drafts must not.
  await context.addInitScript(() => { Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined, configurable: true }); });
  const page = await context.newPage();
  await openWindow(page, "plain1", NOTES);
  await composer(page).click();
  await page.keyboard.type("plain http draft");
  await expect(composer(page)).toHaveText("plain http draft");
  await page.close();
  const reopened = await context.newPage();
  await openWindow(reopened, "plain2", NOTES);
  await expect(composer(reopened)).toHaveText("plain http draft");
});

test("r9: a reload mid-creation reopens the created Chat with its draft", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let row: { id: string } | undefined;
  await page.route("**/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    row = await response.json() as typeof row;
    await gate;
    // The reload already dropped this request.
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await openWindow(page, "reload", NOTES);
    await page.locator("workbench-window-tabs button.add").click();
    await page.getByRole("button", { name: "New Chat", exact: true }).click();
    await expect(shownChat(page)).toHaveAttribute("data-session", /^creating:/);
    await expect.poll(() => row?.id).toBeTruthy();
    await composer(page).click();
    await page.keyboard.type("draft before reload");
    await expect(composer(page)).toHaveText("draft before reload");
    await page.reload();
    await expect(shownChat(page)).toHaveAttribute("data-session", row?.id ?? "");
    await expect(composer(page)).toHaveText("draft before reload");
    await expect(page.locator("workbench-window-tabs .chat-tab[data-session^='creating:']")).toHaveCount(0);
    await page.reload();
    await expect(shownChat(page)).toHaveAttribute("data-session", row?.id ?? "");
  } finally { release(); }
});

test("a Chat with an unacknowledged send stays in its window, which restores the refused prompt", async ({ page, context }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/prompt", async (route) => { await gate; await route.fulfill({ status: 503, json: { error: "busy" } }); });
  try {
    await openWindow(page, "sending", NOTES);
    await composer(page).click();
    await page.keyboard.type("do not lose me");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(composer(page)).not.toContainText("do not lose me");
    const pagesBefore = context.pages().length;
    await page.locator("workbench-window-tabs .chat-tab").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to new window", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "still being sent" })).toBeVisible();
    expect(context.pages()).toHaveLength(pagesBefore);
    await page.locator("workbench-window-tabs .chat-tab").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect(shownChat(page)).toHaveAttribute("data-session", NOTES);
    release();
    await expect(composer(page)).toHaveText("do not lose me");
    expect(await page.evaluate((id) => localStorage.getItem(`pi-web:prompt-draft:local:${id}`), NOTES)).toBe("do not lose me");
  } finally { release(); }
});

for (const scenario of ["move", "reselect", "missed-startup", "images-and-send"] as const) {
  test(`r5–r8: pending ownership stays exclusive through ${scenario}`, async ({ page, context }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let row: { id: string; startupToken?: string } | undefined;
    await page.route("**/sessions", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      row = await response.json() as typeof row;
      await gate;
      await route.fulfill({ response });
    });
    await openWindow(page, "source", NOTES);
    await expect(composer(page)).toBeVisible();
    if (scenario === "missed-startup") await page.locator("pi-workbench-app").evaluate((app) => { (Reflect.get(app, "realtime") as { close: () => void }).close(); });
    await page.locator("workbench-window-tabs button.add").click();
    await page.getByRole("button", { name: "New Chat", exact: true }).click();
    await expect(shownChat(page)).toHaveAttribute("data-session", /^creating:/);
    const tempId = await shownChat(page).getAttribute("data-session");
    await expect.poll(() => row?.id).toBeTruthy();
    if (row === undefined || tempId === null) throw new Error("New Chat did not start");
    try {
      if (scenario === "missed-startup") {
        await page.locator("pi-workbench-app").evaluate((app) => { (Reflect.get(app, "connectRealtime") as () => void).call(app); });
        await expect.poll(() => page.locator("pi-workbench-app").evaluate((app) => (Reflect.get(app, "realtime") as { socket?: WebSocket }).socket?.readyState)).toBe(1);
      }
      if (scenario === "missed-startup") {
        expect(await page.locator("pi-workbench-app").evaluate((app) => {
          const sessions = Reflect.get(app, "sessions") as { pendingSessionStarts: Map<string, { backendSessionId?: string }> };
          return [...sessions.pendingSessionStarts.values()].map((pending) => pending.backendSessionId ?? null);
        })).toEqual([null]);
      }
      await composer(page).click();
      await page.keyboard.type("source first prompt");
      await expect(composer(page)).toHaveText("source first prompt");
      // On the old implementation the tab changed identity early; on the fixed one it is the reservation.
      const pendingTab = page.locator(`workbench-window-tabs .chat-tab[data-session="${row.id}"], workbench-window-tabs .chat-tab[data-session="${tempId}"]`);
      if (scenario !== "missed-startup") await expect(pendingTab).toBeVisible();
      if (scenario === "move") {
        const pagesBefore = context.pages().length;
        await pendingTab.click({ button: "right" });
        await page.getByRole("menuitem", { name: "Move to new window", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "still being created" })).toBeVisible();
        expect(context.pages()).toHaveLength(pagesBefore);
      } else if (scenario === "reselect") {
        await page.locator("workbench-window-tabs button.add").click();
        await pendingTab.click();
        await expect(composer(page)).toHaveText("source first prompt");
        await expect(shownChat(page)).toHaveAttribute("data-session", tempId);
      } else if (scenario === "images-and-send") {
        await page.locator('prompt-editor input[type="file"]').setInputFiles({ name: "source.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64") });
        await expect(page.locator("prompt-editor .attachment-chip")).toHaveCount(1);
      }
      const target = await context.newPage();
      await openWindow(target, "target", row.id);
      await expect(target.locator('[data-view="chooser"]')).toBeVisible();
      await expect(composer(target)).toHaveCount(0);
      await expect(composer(page)).toContainText("source first prompt");
      release();
      await expect(shownChat(page)).toHaveAttribute("data-session", row.id);
      await expect(composer(page)).toContainText("source first prompt");
      await composer(page).press("End");
      await page.keyboard.type(" edit");
      await expect(composer(page)).toContainText("edit");
      if (scenario === "images-and-send") {
        let submitted: { text: string; attachments: { name: string; reference: string }[] } | undefined;
        await page.route("**/prompt", async (route) => { submitted = route.request().postDataJSON() as typeof submitted; await route.fulfill({ json: { accepted: true } }); });
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await expect.poll(() => submitted).toBeTruthy();
        expect(submitted?.attachments).toMatchObject([{ name: "source.png", reference: "[PIC_1]" }]);
        expect(submitted?.text).toContain("[PIC_1]");
        await expect(composer(page)).not.toContainText("source first prompt");
        await expect(page.locator("prompt-editor .attachment-chip")).toHaveCount(0);
        await target.evaluate(() => { localStorage.setItem("unrelated-setting", "yes"); });
        await expect(composer(page)).not.toContainText("source first prompt");
        expect(await page.evaluate((id) => localStorage.getItem(`pi-web:prompt-draft:local:${id}`), row.id)).toBeNull();
      } else {
        await page.locator("workbench-window-tabs button.add").click();
        await page.locator(`workbench-window-tabs .chat-tab[data-session="${row.id}"]`).click();
        await expect(composer(page)).toHaveText("source first prompt edit");
        if (scenario === "move") {
          await page.locator(`workbench-window-tabs .chat-tab[data-session="${row.id}"]`).click({ button: "right" });
          const popup = context.waitForEvent("page");
          await page.getByRole("menuitem", { name: "Move to new window", exact: true }).click();
          const moved = await popup;
          await expect(shownChat(moved)).toHaveAttribute("data-session", row.id);
          await expect(composer(moved)).toHaveText("source first prompt edit");
          await expect(shownChat(page)).not.toHaveAttribute("data-session", row.id);
        }
      }
    } finally { release(); }
  });
}

test("a Chat without a Workstream is a tab of its own beside the Workstreams, with no lower row", async ({ page }) => {
  await openSeededWindow(page, false, false, true);
  const top = page.locator("workbench-window-tabs .tabs.workstreams [role=tab] .title");
  await expect(top).toHaveText(["Pi Workbench UI dogfooding and two-tier tab layout review", "Review the install guide"]);
  await expect(page.locator("workbench-window-tabs")).not.toContainText("No Workstream");
  await expect(page.locator("workbench-window-tabs .bar .chat-tab .title")).toHaveText(["Where are the notes?", "Draft the release notes"]);
  const before = await page.locator("workbench-window-tabs .bar .add").boundingBox();
  await page.locator("workbench-window-tabs .tabs.workstreams .chat-tab", { hasText: "Review the install guide" }).click();
  await expect(shownChat(page)).toHaveAttribute("data-session", GUIDE);
  await expect(page.locator("workbench-window-tabs .bar .chat-tab")).toHaveCount(0);
  expect(await page.locator("workbench-window-tabs .bar .add").boundingBox()).toEqual(before);
  if (SHOTS !== undefined) {
    await page.screenshot({ path: join(SHOTS, "tabs-loose-selected.png") });
    await workstreamTab(page, "dogfooding").click();
    await expect(page.locator("workbench-window-tabs .bar .chat-tab")).toHaveCount(2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "tabs-loose-ws-selected.png") });
  }
});

test("captures the window layouts for review", async ({ browser }) => {
  test.skip(SHOTS === undefined, "set PI_WEB_E2E_SCREENSHOTS to keep review screenshots");
  test.setTimeout(120_000);
  for (const scheme of ["dark", "light"] as const) {
    for (const [label, width, scale] of [["1440", 1440, undefined], ["900", 900, undefined], ["scale125", 1440, "1.25"]] as const) {
      const single = await browser.newContext({ viewport: { width, height: 820 }, colorScheme: scheme });
      const singlePage = await single.newPage();
      if (scale !== undefined) await singlePage.addInitScript((value) => { localStorage.setItem("pi-web-app-scale", value); }, scale);
      await openSeededWindow(singlePage, true);
      await singlePage.waitForTimeout(400);
      await singlePage.screenshot({ path: join(SHOTS ?? "", `tabs-1ws-${label}-${scheme}.png`) });
      await single.close();

      const context = await browser.newContext({ viewport: { width, height: 820 }, colorScheme: scheme });
      const page = await context.newPage();
      if (scale !== undefined) await page.addInitScript((value) => { localStorage.setItem("pi-web-app-scale", value); }, scale);
      await openSeededWindow(page);
      await chatTab(page, "Draft the release notes").hover();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS ?? "", `tabs-2ws-${label}-${scheme}.png`) });
      await page.keyboard.press("Control+g");
      await expect(page.locator("workbench-chat-pane chat-view")).toHaveCount(2);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SHOTS ?? "", `grid-${label}-${scheme}.png`) });
      await context.close();
    }
  }
});
