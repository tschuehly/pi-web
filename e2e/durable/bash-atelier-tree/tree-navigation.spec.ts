import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";

// History navigation of a Durable Chat (Phase B slice 4, group C; P044 /tree, P046 go back to a message), against
// the host's scripted faux model. Needs PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts.
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const chat = (page: Page) => page.locator("chat-view");
const navigator = (page: Page) => page.locator("session-tree-navigator");

function fixture(): { base: string; workspaceId: string; project: string; root: string } {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  return { base, workspaceId, project, root: dirname(project) };
}

/** Replace the composer's text and send it. */
async function send(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

/** The scripted model's request labels of the Chat's store. */
async function labels(sessionId: string): Promise<string[]> {
  const stores = join(fixture().root, "data", "durable");
  for (const store of await readdir(stores)) {
    if (store !== sessionId) continue;
    const log = await readFile(join(stores, store, "requests.log"), "utf8").catch(() => "");
    return log.trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { label: string }).label);
  }
  return [];
}

test("AC-P044 AC-P046: a Durable Chat goes back with /tree and with Edit & resend, continues, and keeps every branch across a host restart", async ({ page }) => {
  test.setTimeout(120_000);
  const { base, workspaceId, project } = fixture();
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  await send(page, "alpha");
  await expect(chat(page).getByText("ok: alpha").first()).toBeVisible();
  await send(page, "beta");
  await expect(chat(page).getByText("ok: beta").first()).toBeVisible();

  // /tree: pick the second prompt and continue in this Chat. Forking and branch summaries are not offered yet.
  await send(page, "/tree");
  await expect(navigator(page).getByRole("tree")).toBeVisible();
  const rows = navigator(page).getByRole("treeitem");
  const row = (summary: string) => rows.filter({ has: page.locator(".summary", { hasText: new RegExp(`^${summary}$`) }) });
  await row("beta").click();
  await navigator(page).getByRole("button", { name: "Next" }).click();
  await expect(navigator(page).getByText("Continue in this session")).toBeVisible();
  await expect(navigator(page).getByText("Fork into a new session")).toHaveCount(0);
  await expect(navigator(page).getByText("Abandoned branch summary")).toHaveCount(0);
  await navigator(page).getByRole("button", { name: "Continue from here" }).click();
  await expect(navigator(page)).toHaveCount(0);
  await expect(editor(page)).toHaveText("beta");
  await expect(chat(page).getByText("ok: beta")).toHaveCount(0);
  await expect(chat(page).getByText("ok: alpha").first()).toBeVisible();

  // Continue on the new branch.
  await send(page, "gamma");
  await expect(chat(page).getByText("ok: gamma").first()).toBeVisible();
  expect(await labels(sessionId)).toEqual(["alpha", "beta", "gamma"]);

  // A host restart keeps the selected branch and the retained one.
  const stopped = await page.request.post(`${base}api/sessions/${encodeURIComponent(sessionId)}/stop`, { data: { cwd: project } });
  expect(stopped.ok()).toBe(true);
  await page.reload();
  await expect(chat(page).getByText("ok: gamma").first()).toBeVisible();
  await expect(chat(page).getByText("ok: beta")).toHaveCount(0);

  // Go back to a message (the Workbench's Edit & resend), on the first prompt: an empty branch, the prompt in the editor.
  // The first exchange is folded into "Earlier conversation"; open it.
  const earlier = chat(page).locator("details").filter({ hasText: "Earlier conversation" });
  if (await earlier.count() > 0 && !await earlier.first().evaluate((element) => (element as HTMLDetailsElement).open)) await earlier.first().locator("summary").first().click();
  const first = chat(page).locator("article").filter({ has: page.getByText("alpha", { exact: true }) });
  await first.getByRole("button", { name: "Message actions" }).click();
  await first.getByRole("button", { name: "Edit and resend" }).click();
  await expect(editor(page)).toHaveText("alpha");
  await expect(chat(page).getByText("ok: alpha")).toHaveCount(0);

  // Every branch is still in the tree.
  await send(page, "/tree");
  for (const text of ["alpha", "ok: alpha", "beta", "ok: beta", "gamma", "ok: gamma"]) await expect(row(text)).toHaveCount(1);
  await navigator(page).getByRole("button", { name: "Cancel" }).click();
});
