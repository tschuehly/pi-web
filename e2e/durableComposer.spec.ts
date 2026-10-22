import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "./isolatedPiWeb";

// The composer of a Durable Chat (Phase B slice 3, group A): queued-message edits across a host restart, image
// attachments, thinking levels, `!`/`!!` shell commands and prompt templates, against the host's scripted faux model.
// Needs PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts.
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const chat = (page: Page) => page.locator("chat-view");
const queued = (page: Page) => page.locator(".queued-message");

function fixture(): { base: string; workspaceId: string; project: string; root: string } {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  return { base, workspaceId, project, root: dirname(project) };
}

async function send(page: Page, text: string, button = "Send message"): Promise<void> {
  await editor(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: button }).click();
}

async function newDurableChat(page: Page): Promise<string> {
  const { base, workspaceId } = fixture();
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  return new URL(page.url()).searchParams.get("session") ?? "";
}

/** Stop the Chat's host (as a daemon restart would), then reload: the next read opens the store again, paused. */
async function restartHost(page: Page, sessionId: string): Promise<void> {
  const { base, project } = fixture();
  const stopped = await page.request.post(`${base}api/sessions/${encodeURIComponent(sessionId)}/stop`, { data: { cwd: project } });
  expect(stopped.ok()).toBe(true);
  await page.reload();
}

/** The scripted model's request log of the Chat's store (`<data>/durable/<store>/requests.log`). */
async function requests(sessionId: string): Promise<{ label: string; ran?: string[]; reasoning?: string; images?: number }[]> {
  const stores = join(fixture().root, "data", "durable");
  for (const store of await readdir(stores)) {
    if (store !== sessionId) continue;
    const log = await readFile(join(stores, store, "requests.log"), "utf8").catch(() => "");
    return log.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { label: string });
  }
  return [];
}

test("queued messages: send now and remove; after a host restart the queue is still there to recall, and Stop returns the rest to the composer", async ({ page }) => {
  test.setTimeout(90_000);
  const sessionId = await newDurableChat(page);
  await send(page, 'call:bash {"command":"echo running; sleep 30","description":"Run","foreground":true}');
  await expect(chat(page).getByText("running").first()).toBeVisible();
  for (const text of ["first follow-up", "second follow-up", "third follow-up"]) await send(page, text, "Queue follow-up");
  await expect(queued(page)).toHaveCount(3);

  // Send now: the follow-up becomes a steer. Remove: only that message goes.
  await page.getByRole("button", { name: "Send follow-up 2 now" }).click();
  await expect(queued(page).first()).toContainText("Steer 1");
  await expect(queued(page).first()).toContainText("second follow-up");
  await queued(page).filter({ hasText: "third follow-up" }).getByRole("button", { name: "Remove queued message" }).click();
  await expect(queued(page)).toHaveCount(2);

  // A host restart keeps the queue; the restored Chat waits paused, and the queue is still editable.
  await restartHost(page, sessionId);
  await expect(queued(page)).toHaveCount(2);
  await queued(page).filter({ hasText: "first follow-up" }).getByRole("button", { name: "Recall queued message" }).click();
  await expect(editor(page)).toHaveText("first follow-up");
  await expect(queued(page)).toHaveCount(1);

  // Stop with a queue, on the restored Chat: the queued text returns to the composer, before the draft, never sent.
  await page.getByRole("button", { name: "Stop current work" }).click();
  await expect(editor(page)).toContainText("second follow-up");
  await expect(editor(page)).toContainText("first follow-up");
  await expect(queued(page)).toHaveCount(0);
  const labels = (await requests(sessionId)).map((request) => request.label);
  for (const text of ["first follow-up", "second follow-up", "third follow-up"]) expect(labels).not.toContain(text);
});

test("an image attachment reaches the model and shows in the transcript after a reload and a host restart", async ({ page }) => {
  test.setTimeout(60_000);
  const sessionId = await newDurableChat(page);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.locator("prompt-editor input.attachment-image-input").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  await send(page, "describe the picture");
  // The composer names the image [PIC_1]; the model also gets PI WEB's legend, the user message shows without it.
  await expect(chat(page).getByText(/^ok: \[PIC_1\] describe the picture/).first()).toBeVisible();
  await expect(chat(page).getByText("[PIC_1] describe the picture", { exact: true })).toBeVisible();
  const image = chat(page).locator("img").first();
  await expect(image).toBeVisible();
  expect((await requests(sessionId)).at(-1)?.images).toBe(1);
  await page.reload();
  await expect(chat(page).locator("img").first()).toBeVisible();
  await restartHost(page, sessionId);
  const restored = chat(page).locator("img").first();
  await expect(restored).toBeVisible();
  await expect.poll(() => restored.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test("the thinking level is chosen per Chat, survives a host restart and is sent with the next request", async ({ page }) => {
  test.setTimeout(60_000);
  const sessionId = await newDurableChat(page);
  const trigger = page.getByRole("button", { name: /^Model: / });
  await trigger.click();
  await page.getByRole("radiogroup", { name: "Thinking" }).getByRole("radio", { name: "high" }).click();
  await expect(page.getByRole("button", { name: /thinking high/ })).toBeVisible();
  await restartHost(page, sessionId);
  await expect(page.getByRole("button", { name: /thinking high/ })).toBeVisible();
  await send(page, "think");
  await expect(chat(page).getByText("ok: think").first()).toBeVisible();
  expect((await requests(sessionId)).at(-1)).toMatchObject({ label: "think", reasoning: "high" });
});

test("!cmd and !!cmd run in the workspace, are recorded, and only !cmd reaches the model", async ({ page }) => {
  test.setTimeout(60_000);
  const sessionId = await newDurableChat(page);
  await send(page, "!echo shown-to-model");
  await expect(chat(page).getByText(/shown-to-model/).nth(1)).toBeVisible();
  await send(page, "!!echo kept-from-model");
  await expect(chat(page).getByText(/excluded from context/).first()).toBeVisible();
  await page.reload();
  await expect(chat(page).getByText(/\$ echo shown-to-model/).first()).toBeVisible();
  await expect(chat(page).getByText(/\$ echo kept-from-model/).first()).toBeVisible();
  await send(page, "what ran");
  await expect(chat(page).getByText("ok: what ran").first()).toBeVisible();
  expect((await requests(sessionId)).at(-1)?.ran).toEqual(["echo shown-to-model"]);
});

test("a prompt template from the agent directory is listed and expands with its arguments", async ({ page }) => {
  const prompts = join(fixture().root, "agent", "prompts");
  await mkdir(prompts, { recursive: true });
  await writeFile(join(prompts, "e2e-review.md"), "---\ndescription: Review a path\n---\nReview $1 carefully");
  await newDurableChat(page);
  await send(page, "/e2e-review src/app.ts");
  await expect(chat(page).getByText("ok: Review src/app.ts carefully").first()).toBeVisible();
});
