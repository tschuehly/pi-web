import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_MORE_CHATS, E2E_PROJECT_ID, E2E_SESSION_ID } from "./isolatedPiWeb";

// Set PI_WEB_E2E_SCREENSHOTS to a folder to keep review screenshots of the window tabs and grid.
const SHOTS = process.env["PI_WEB_E2E_SCREENSHOTS"];
const STORE_KEY = "pi-workbench.windows.v1";
const [NOTES, RELEASE, GUIDE] = [E2E_SESSION_ID, E2E_MORE_CHATS[0].id, E2E_MORE_CHATS[1].id];

/** One window holding the three fixture Chats: two in a long-named Workstream, one in another. */
function seededWindow(workspaceId: string) {
  const chat = (sessionId: string, title: string, workstream: { id: string; title: string }) => ({ sessionId, title, machineId: "local", projectId: E2E_PROJECT_ID, workspaceId, workstream });
  const dogfooding = { id: "ws-dogfooding", title: "Pi Workbench UI dogfooding and two-tier tab layout review" };
  const docs = { id: "ws-docs", title: "Docs" };
  return {
    e2e: {
      name: "Window 1", layout: "tabs", maximized: false, focused: NOTES, lastActive: {},
      chats: [chat(NOTES, "Where are the notes?", dogfooding), chat(RELEASE, "Draft the release notes", dogfooding), chat(GUIDE, "Review the install guide", docs)],
    },
  };
}

async function openSeededWindow(page: Page): Promise<void> {
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (workspaceId === undefined || url === undefined) throw new Error("Isolated PI WEB was not started");
  // Only the first page seeds: a window this test opens later must find the store as the first one left it.
  await page.addInitScript(([key, value]) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, [STORE_KEY, JSON.stringify(seededWindow(workspaceId))] as const);
  const target = new URL(url);
  target.searchParams.set("win", "e2e");
  await page.goto(target.toString());
  await expect(shownChat(page)).toHaveAttribute("data-session", NOTES);
}

const shownChat = (page: Page) => page.locator("main.chat-shell").first();
const workstreamTab = (page: Page, name: string) => page.locator("workbench-window-tabs .workstream-tab", { hasText: name });
const chatTab = (page: Page, name: string) => page.locator("workbench-window-tabs .chat-tab", { hasText: name });

test("switches Workstreams back to their last Chat, lays them out as a grid, and moves a Chat to a new window", async ({ page, context }) => {
  await openSeededWindow(page);
  await expect(page.locator("workbench-window-tabs .workstream-tab .title")).toHaveText(["Pi Workbench UI dogfooding and two-tier tab layout review", "Docs"]);
  await expect(page.locator("workbench-window-tabs .chat-tab .title")).toHaveText(["Where are the notes?", "Draft the release notes"]);

  await chatTab(page, "Draft the release notes").click();
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  await workstreamTab(page, "Docs").click();
  await expect(shownChat(page)).toHaveAttribute("data-session", GUIDE);
  await expect(page.locator("workbench-window-tabs .chat-tab .title")).toHaveText(["Review the install guide"]);
  await workstreamTab(page, "dogfooding").focus();
  await page.keyboard.press("Enter");
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  expect(new URL(page.url()).searchParams.get("win")).toBe("e2e");

  await page.keyboard.press("Control+g");
  await expect(page.locator(".grid > .tile")).toHaveCount(3);
  await expect(page.locator("workbench-chat-pane")).toHaveCount(2);
  await expect(page.locator('.tile[data-focused="true"] main.chat-shell')).toHaveAttribute("data-session", RELEASE);
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
  expect(new URL(moved.url()).searchParams.get("win")).not.toBe("e2e");
  await expect(shownChat(page)).toHaveAttribute("data-session", RELEASE);
  await expect(page.locator("workbench-window-tabs .chat-tab .title")).toHaveText(["Draft the release notes"]);
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

test("captures the window layouts for review", async ({ browser }) => {
  test.skip(SHOTS === undefined, "set PI_WEB_E2E_SCREENSHOTS to keep review screenshots");
  test.setTimeout(120_000);
  for (const scheme of ["dark", "light"] as const) {
    for (const [label, width, scale] of [["1440", 1440, undefined], ["900", 900, undefined], ["scale125", 1440, "1.25"]] as const) {
      const context = await browser.newContext({ viewport: { width, height: 820 }, colorScheme: scheme });
      const page = await context.newPage();
      if (scale !== undefined) await page.addInitScript((value) => { localStorage.setItem("pi-web-app-scale", value); }, scale);
      await openSeededWindow(page);
      await chatTab(page, "Draft the release notes").hover();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS ?? "", `tabs-${label}-${scheme}.png`) });
      await page.keyboard.press("Control+g");
      await expect(page.locator("workbench-chat-pane chat-view")).toHaveCount(2);
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SHOTS ?? "", `grid-${label}-${scheme}.png`) });
      await context.close();
    }
  }
});
