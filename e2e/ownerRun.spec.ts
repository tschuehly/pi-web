import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "./isolatedPiWeb";

// The run button (src/server/sessions/ownerRuns.ts) of a Durable Chat, against the host's scripted faux model: it echoes
// a prompt as `ok: <text>`, so a pi-run block sent by the user comes back as the assistant's proposal.
// Needs PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts.
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

const chat = (page: Page) => page.locator("chat-view");

function fixture(): { base: string; workspaceId: string; project: string; root: string } {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  return { base, workspaceId, project, root: dirname(project) };
}

async function requests(sessionId: string): Promise<{ label: string; sections?: string[] }[]> {
  const log = await readFile(join(fixture().root, "data", "durable", sessionId, "requests.log"), "utf8").catch(() => "");
  return log.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { label: string });
}

test("a proposed pi-run block runs only after Run once, in its folder, and its exit code wakes the idle agent", async ({ page }) => {
  test.setTimeout(90_000);
  const { base, workspaceId, project } = fixture();
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  expect((await readdir(join(fixture().root, "data", "durable"))).includes(sessionId)).toBe(true);

  const text = `Run this:\n\n\`\`\`pi-run cwd="${project}"\npwd; exit 7\n\`\`\``;
  const sent = await page.request.post(`${base}api/sessions/${encodeURIComponent(sessionId)}/prompt`, { data: { cwd: project, text } });
  expect(sent.ok()).toBe(true);
  const proposal = chat(page).locator(".msg.assistant").filter({ hasText: "ok: Run this:" });
  const review = proposal.getByRole("button", { name: "Review command…" });
  await expect(review).toBeVisible();
  // The user's own copy of the block stays inert.
  await expect(chat(page).locator(".msg.user").getByRole("button", { name: "Review command…" })).toHaveCount(0);
  expect((await requests(sessionId)).at(-1)?.sections).toContain("addendum");

  // Cancel runs nothing: no request reaches the model.
  const before = (await requests(sessionId)).length;
  await review.click();
  const dialog = page.locator("owner-run-dialog");
  await expect(dialog.getByText(project, { exact: true })).toBeVisible();
  await expect(dialog.locator(".command")).toHaveText("pwd; exit 7");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await review.click();
  await dialog.getByRole("button", { name: "Run once" }).click();
  await expect(dialog).toHaveCount(0);

  // The idle Chat wakes with the host's background-job completion: exit code 7 and the folder it ran in (`pwd`).
  const answer = chat(page).locator(".msg.assistant").filter({ hasText: "ok: [Owner run result]" });
  await expect(answer).toContainText("(exit 7)");
  await expect(answer).toContainText(project);
  const after = await requests(sessionId);
  expect(after.slice(before).map((request) => request.label)).toEqual([expect.stringMatching(/^\[Owner run result\]/)]);

  // It runs once: the same proposal again is refused.
  const entryId = await proposal.first().getAttribute("data-entry-id");
  const again = await page.request.post(`${base}api/sessions/${encodeURIComponent(sessionId)}/owner-runs`, { data: { cwd: project, entryId, proposal: { mode: "run", cwd: project, command: "pwd; exit 7" } } });
  expect(again.status()).toBe(400);
  expect(await again.json()).toEqual({ error: "This command already ran" });
});
