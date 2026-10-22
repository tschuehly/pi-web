import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";
import { MOCK_CLAUDE_MODEL, MOCK_CODEX_ACCOUNT, MOCK_CODEX_MODEL } from "../../mockModels/agentConfig";
import { mockModels } from "../../mockModels/client";

// Subagents in a Durable Chat (parity rows P089, P092, P099): a background child's row in Activity with its own status
// line, routed model, elapsed and quiet time; the coalesced completion wake; collection clears the row. The lead answers
// through mocked Claude and the routed child through mocked Codex (e2e/mockModels/README.md). Needs
// PI_WEB_E2E_DURABLE_HOST (see durableChat.spec.ts).
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");
test.skip(process.env["PI_WEB_E2E_MOCK_URL"] === undefined, "the mock model server is off (PI_WEB_E2E_MOCK_MODELS=0)");
const mock = mockModels();
test.beforeEach(async () => { await mock.reset(); });

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

  // The lead's marker is in its first prompt, the child's only in its assignment, so each script answers one conversation.
  const lead = `roster-lead-${String(Date.now())}`;
  const child = `roster-child-${String(Date.now())}`;
  const childDone = `${child}-done`;
  const task = `${child}: report your status, then finish.`;
  const leadScript = await mock.script({ provider: "anthropic", match: lead, turns: [
    [{ toolCall: { name: "subagent", args: { name: "Roster probe", task, profile: "scout", cognitiveRole: "routine", background: true } } }],
    "The probe runs in the background.",
    // The completion wake: collect once.
    [{ toolCall: { name: "subagent_collect", args: {} } }],
    "Collected the probe.",
  ] });
  // The child reports, then holds its answer until the spec has checked the running row.
  const childScript = await mock.script({ provider: "openai-codex", match: child, turns: [
    [{ toolCall: { name: "report_status", args: { status: "Reading the roster code" } } }],
    [{ barrier: childDone }, { text: "Roster probe finished." }],
  ] });

  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"] ?? "";
  // Tool results sit in collapsed step groups; the transcript API shows them.
  const transcript = async () => JSON.stringify(await (await page.request.get(`${base}api/sessions/${encodeURIComponent(sessionId)}/messages?${new URLSearchParams({ cwd: project }).toString()}`)).json());

  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(MOCK_CLAUDE_MODEL.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: MOCK_CLAUDE_MODEL.id, exact: true }).first().click();
  await expect(page.getByRole("button", { name: new RegExp(`^Model: ${MOCK_CLAUDE_MODEL.provider}/${MOCK_CLAUDE_MODEL.id}`) })).toBeVisible();
  await send(page, `${lead}: launch the roster probe.`);
  await expect.poll(transcript).toMatch(/Launched subagent \S+ in the background on openai-codex\/gpt-6-luna:medium/);

  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByRole("button", { name: "Activity 1 running" })).toBeVisible();
  const row = activity.locator('[data-row-key^="delegate:"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator(".name")).toHaveText("Roster probe");
  await expect(row.locator(".name")).toHaveAttribute("title", "Subagent · routine · gpt-6-luna · medium");
  await expect(row.locator(".report")).toHaveText("Status: Reading the roster code");
  await expect(row.locator(".elapsed")).toHaveAttribute("title", /^Running for \d+s$/);
  await mock.waitForBarrier(childDone);

  // Eleven minutes without a report: reloaded with a clock eleven minutes ahead, the row shows the child as quiet.
  await page.clock.setFixedTime(Date.now() + 11 * 60_000);
  await page.reload();
  await expect(row.locator(".status")).toContainText(/Quiet 1[01]m/);
  await expect(row.locator(".status")).toHaveAttribute("title", /^No status report for 1[01]m; it may be stuck$/);

  // The child ends: one completion wake, the lead collects, and the row goes.
  await mock.release(childDone);
  await expect(chat(page).locator("details.subagent-completion > summary", { hasText: "Subagents finished" })).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(transcript).toMatch(/Completion receipt: openai-codex\/gpt-6-luna:medium · subagent · scout · routine · outcome success/);
  await expect(activity).toHaveCount(0);
  await page.reload();
  await expect(chat(page).locator("details.subagent-completion > summary", { hasText: "Subagents finished" })).toHaveCount(1);
  expect((await transcript()).match(/Background children finished/g)).toHaveLength(1);

  // Journal: the child's two requests went to the ChatGPT subscription on the routed model; the lead's four to Claude.
  const childRequests = await mock.journal({ provider: "openai-codex", kind: "chat", contains: child });
  expect(childRequests.map((entry) => entry.answeredBy)).toEqual([{ script: childScript, turn: 0 }, { script: childScript, turn: 1 }]);
  for (const entry of childRequests) {
    expect(entry.violations).toEqual([]);
    expect(entry.model).toBe(MOCK_CODEX_MODEL.id);
    expect(entry.auth).toBe("jwt");
    expect(entry.headers["chatgpt-account-id"]).toBe(MOCK_CODEX_ACCOUNT);
  }
  const leadRequests = await mock.journal({ provider: "anthropic", kind: "chat", contains: lead });
  expect(leadRequests.map((entry) => entry.answeredBy)).toEqual([0, 1, 2, 3].map((turn) => ({ script: leadScript, turn })));
  expect(leadRequests.every((entry) => entry.violations.length === 0)).toBe(true);
});
