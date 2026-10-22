import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";

// Subagents in a Durable Chat (parity rows P089, P092, P099): a background child's row in Activity with its own status
// line, routed model, elapsed and quiet time; the coalesced completion wake; collection clears the row. Needs
// PI_WEB_E2E_DURABLE_HOST (see durableChat.spec.ts).
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const chat = (page: Page) => page.locator("chat-view");

async function send(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test("AC-P092 AC-P099 a Durable Chat's Subagent shows in Activity with its status line, model, elapsed and quiet time, and leaves it once collected", async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const quota = process.env["PI_WEB_E2E_QUOTA_CACHE"];
  if (base === undefined || workspaceId === undefined || quota === undefined) throw new Error("Isolated PI WEB was not started with a Durable host");
  test.setTimeout(90_000);
  // A fresh, empty quota snapshot: routing admits on degraded telemetry and never runs quota-axi.
  await writeFile(quota, JSON.stringify({ version: 1, checkedAt: Date.now(), status: 0, stdout: JSON.stringify({ providers: [] }), stderr: "" }));
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"] ?? "";
  // Tool results sit in collapsed step groups; the transcript API shows them.
  const transcript = async () => JSON.stringify(await (await page.request.get(`${base}api/sessions/${encodeURIComponent(sessionId)}/messages?${new URLSearchParams({ cwd: project }).toString()}`)).json());

  const child = 'calls:[{"name":"report_status","arguments":{"status":"Reading the roster code"}},{"name":"bash","arguments":{"command":"sleep 8"}}]';
  await send(page, `call:subagent ${JSON.stringify({ name: "Roster probe", task: child, profile: "scout", cognitiveRole: "routine", background: true })}`);
  await expect.poll(transcript).toMatch(/Launched subagent \S+ in the background on openai-codex\/gpt-6-luna:medium/);

  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByRole("button", { name: "Activity 1 running" })).toBeVisible();
  const row = activity.locator('[data-row-key^="delegate:"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator(".name")).toHaveText("Roster probe");
  await expect(row.locator(".name")).toHaveAttribute("title", "Subagent · routine · gpt-6-luna · medium");
  await expect(row.locator(".report")).toHaveText("Status: Reading the roster code");
  await expect(row.locator(".elapsed")).toHaveAttribute("title", /^Running for \d+s$/);

  // Eleven minutes without a report: reloaded with a clock eleven minutes ahead, the row shows the child as quiet.
  await page.clock.setFixedTime(Date.now() + 11 * 60_000);
  await page.reload();
  await expect(row.locator(".status")).toContainText(/Quiet 1[01]m/);
  await expect(row.locator(".status")).toHaveAttribute("title", /^No status report for 1[01]m; it may be stuck$/);

  // The child ends: one completion wake, the lead collects, and the row goes.
  await expect(chat(page).locator("details.subagent-completion > summary", { hasText: "Subagents finished" })).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(transcript).toMatch(/Completion receipt: openai-codex\/gpt-6-luna:medium · subagent · scout · routine · outcome success/);
  await expect(activity).toHaveCount(0);
  await page.reload();
  await expect(chat(page).locator("details.subagent-completion > summary", { hasText: "Subagents finished" })).toHaveCount(1);
  expect((await transcript()).match(/Background children finished/g)).toHaveLength(1);
});
