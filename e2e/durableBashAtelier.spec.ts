import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "./isolatedPiWeb";

// Slice 4 group B in a Durable Chat (parity rows P078/P081 and P075/P076): a background bash job's completion card
// and its log, and an Atelier Comment round trip between a Page tab and the Chat. Needs PI_WEB_E2E_DURABLE_HOST (see
// durableChat.spec.ts).
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const chat = (page: Page) => page.locator("chat-view");

async function send(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

function fixture(): { base: string; workspaceId: string; project: string } {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  return { base, workspaceId, project };
}

async function newDurableChat(page: Page): Promise<string> {
  const { base, workspaceId } = fixture();
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  return new URL(page.url()).searchParams.get("session") ?? "";
}

test("a background bash job returns at once; its completion card shows the exit and output, and its log opens", async ({ page }) => {
  test.setTimeout(60_000);
  await newDurableChat(page);
  await send(page, 'call:bash {"command":"echo job-started; sleep 1; echo job-finished","description":"Finish in a second"}');
  await expect(chat(page).getByText("done after bash").first()).toBeVisible();
  const card = chat(page).locator(".background-bash-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("complete · exit 0");
  await expect(card).toContainText("Finish in a second");
  await expect(card.locator(".background-bash-output")).toContainText("job-finished");
  // The completion woke the Chat once.
  await expect(chat(page).getByText(/^ok: Background bash/).first()).toBeVisible();
  await card.getByRole("button", { name: "Show full log" }).click();
  const log = page.getByRole("dialog", { name: "Full log" });
  await expect(log.getByLabel("Log output")).toHaveText("job-started\njob-finished\n");
  await log.getByRole("button", { name: "Close log" }).click();
  await page.reload();
  await expect(chat(page).locator(".background-bash-card")).toHaveCount(1);
});

test("an Atelier Comment from the Page tab reaches the Chat once, and the agent's answer and update reach the tab", async ({ page, context }) => {
  test.setTimeout(60_000);
  const { base, project } = fixture();
  await writeFile(join(project, "atelier-e2e.html"), "<!doctype html><title>Atelier e2e</title><div atl-key='a' atl-ver='1'>Box A</div><script type='module' src='atelier.js'></script>\n");
  const sessionId = await newDurableChat(page);
  await send(page, 'call:tools_enable {"group":"atelier"}');
  await expect(chat(page).getByText("done after tools_enable").first()).toBeVisible();
  await send(page, 'call:atelier {"action":"open","page":"atelier-e2e.html"}');
  await expect(chat(page).getByText("done after atelier").first()).toBeVisible();
  let url = "";
  await expect.poll(async () => {
    const response = await page.request.get(`${base}api/sessions/${encodeURIComponent(sessionId)}/messages?${new URLSearchParams({ cwd: project }).toString()}`);
    url = /Page open: (http:\/\/127\.0\.0\.1:\d+\/atelier-e2e\.html)/.exec(await response.text())?.[1] ?? "";
    return url;
  }).not.toBe("");

  // The human's tab: the served Page, connected live to its page server.
  const tab = await context.newPage();
  await tab.goto(url);
  await expect(tab.getByText("Box A")).toBeVisible();
  const posted = await tab.evaluate(async () => {
    const response = await fetch("/.atelier/events?page=atelier-e2e.html", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "comment", key: "a", text: "Please make Box A bigger" }) });
    return ((await response.json()) as { entry: { seq: number } }).entry.seq;
  });
  // After its 3-second undo window, the Comment wakes the Chat once.
  await expect(chat(page).getByText(/Please make Box A bigger/).first()).toBeVisible({ timeout: 15_000 });
  await expect(chat(page).getByText(/^ok: Atelier/).first()).toBeVisible();

  await send(page, `call:atelier ${JSON.stringify({ action: "answer", page: "atelier-e2e.html", comment: posted, text: "Done: Box A is bigger" })}`);
  await expect(chat(page).getByText("done after atelier").nth(1)).toBeVisible();
  await send(page, 'call:atelier {"action":"update","page":"atelier-e2e.html","text":"Box A is bigger"}');
  await expect(chat(page).getByText("done after atelier").nth(2)).toBeVisible();
  const events = (await readFile(join(project, "atelier-e2e.html.events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; origin: string; of?: number[]; text?: string });
  expect(events.filter((e) => e.type === "received").flatMap((e) => e.of)).toEqual([posted]);
  expect(events.find((e) => e.type === "answer")?.text).toBe("Done: Box A is bigger");
  const listed = await tab.evaluate(async () => ((await (await fetch("/.atelier/events?page=atelier-e2e.html&since=0")).json()) as { entries: { type: string }[] }).entries.map((e) => e.type));
  expect(listed).toContain("answer");
  await expect.poll(async () => {
    const response = await page.request.get(`${base}api/sessions/${encodeURIComponent(sessionId)}/messages?${new URLSearchParams({ cwd: project }).toString()}`);
    return /Update sent to 1 connected tab/.test(await response.text());
  }).toBe(true);
  await tab.close();
});
