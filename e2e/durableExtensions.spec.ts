import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "./isolatedPiWeb";

// Slice 5 group A in a Durable Chat (parity rows P034, P073, P085, P086): the runtime identity tools see, the running
// shell in Activity, the /tmp write guard, and /quota-check. Needs PI_WEB_E2E_DURABLE_HOST (see durableChat.spec.ts).
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const chat = (page: Page) => page.locator("chat-view");

async function send(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test("a Durable Chat runs the Workbench extensions: identity, shell activity, /tmp guard, /quota-check", async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  test.setTimeout(90_000);
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";

  // P034 + P073: the command sees this Chat's ID; while it runs, Activity counts one shell.
  await send(page, 'call:bash {"command":"echo id=$PI_SESSION_ID > durable-identity.txt; sleep 30","description":"Identity","foreground":true}');
  await expect.poll(() => readFile(join(project, "durable-identity.txt"), "utf8").catch(() => "")).toBe(`id=${sessionId}\n`);
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByRole("button", { name: "Activity 1 shell" })).toBeVisible();
  await page.getByRole("button", { name: "Stop current work" }).click();
  await expect(activity).toHaveCount(0);

  // P085: a write into /tmp is blocked before it runs.
  await send(page, 'call:write {"path":"/tmp/pi-web-e2e-blocked.txt","content":"x"}');
  await expect(chat(page).getByText(/is under an OS temp folder/).first()).toBeVisible();
  await expect(chat(page).getByText("done after write").first()).toBeVisible();

  // P086: the host command is offered; a bad argument answers with its usage (no quota request is made).
  await send(page, "/quota-check bogus");
  await expect(chat(page).getByText("Usage: /quota-check [repair]").first()).toBeVisible();
  await page.reload();
  await expect(chat(page).getByText(/done after write/).first()).toBeVisible();
});
