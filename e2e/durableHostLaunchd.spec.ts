import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_DURABLE_LABEL_PREFIX, E2E_PROJECT_ID, restartSessiond } from "./isolatedPiWeb";
import { MOCK_CLAUDE_MODEL } from "./mockModels/agentConfig";
import { mockModels } from "./mockModels/client";

// AC3 (Phase C1): a Durable Chat's host is its family's own launchd job on an owner-only socket, outside the session
// daemon. Killing the daemon while a lead streams leaves the host and its provider request alone; the restarted daemon
// reattaches through the runtime locator and the Chat converges. Stale and foreign sockets: durableHostLaunchd.test.ts.
// Run: PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts PI_WEB_E2E_DURABLE_LAUNCHD=1
//      TMPDIR=<a folder short enough for Unix sockets> npx playwright test e2e/durableHostLaunchd.spec.ts
test.skip(process.env["PI_WEB_E2E_SESSIOND_ENV"] === undefined, "needs PI_WEB_E2E_DURABLE_HOST and PI_WEB_E2E_DURABLE_LAUNCHD=1");
test.skip(process.env["PI_WEB_E2E_MOCK_URL"] === undefined, "the mock model server is off (PI_WEB_E2E_MOCK_MODELS=0)");
const mock = mockModels();
test.beforeEach(async () => {
  await mock.reset();
});

const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const chat = (page: Page) => page.locator("chat-view");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The one host process of this Chat's store, under this fixture's root only. */
function hostPid(sessionId: string): number {
  const store = join(dirname(process.env["PI_WEB_E2E_PROJECT_DIR"] ?? ""), "data", "durable", sessionId);
  const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  const matches = lines.filter((line) => line.includes(`--store ${store} `) && line.includes("chat-host-main.ts"));
  expect(matches, `exactly one host under ${store}`).toHaveLength(1);
  return Number(matches[0]?.trim().split(/\s+/)[0]);
}

/** The PID launchd reports for the family's job: launchd, not the daemon, owns the host. */
function launchdPid(sessionId: string): number | undefined {
  const printed = execFileSync("launchctl", ["print", `gui/${String(process.getuid?.())}/${E2E_DURABLE_LABEL_PREFIX}.${sessionId}`], { encoding: "utf8" });
  const pid = /^\s*pid = (\d+)$/m.exec(printed)?.[1];
  return pid === undefined ? undefined : Number(pid);
}

test("AC3: the daemon is killed while a lead streams; host and provider request survive and the Chat converges", async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"] ?? "";
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"] ?? "";
  const marker = `c1-${String(Date.now())}`;
  await mock.script({
    provider: "anthropic",
    match: marker,
    turns: [[{ text: "Before the daemon dies." }, { barrier: marker }, { text: " After the daemon is back." }]],
  });

  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(MOCK_CLAUDE_MODEL.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: MOCK_CLAUDE_MODEL.id, exact: true }).first().click();
  await editor(page).click();
  await page.keyboard.insertText(`${marker} stream`);
  await page.getByRole("button", { name: "Send message" }).click();

  // The lead streams: its first words are on screen and the provider response is held open.
  await mock.waitForBarrier(marker);
  // (The streaming view holds back the last word until more text arrives.)
  await expect(chat(page).getByText("Before the daemon").first()).toBeVisible();
  const pid = hostPid(sessionId);
  expect(launchdPid(sessionId)).toBe(pid);
  const requests = await mock.journal({ kind: "chat", contains: marker });
  expect(requests.map((entry) => entry.outcome)).toEqual(["pending"]);

  await restartSessiond();
  expect(alive(pid)).toBe(true);
  await mock.release(marker);

  // The restarted daemon reattached: the same turn finishes in the open Chat, from the same host and request.
  await expect(chat(page).getByText("After the daemon is back.").first()).toBeVisible({ timeout: 20_000 });
  expect(hostPid(sessionId)).toBe(pid);
  expect(launchdPid(sessionId)).toBe(pid);
  const after = await mock.journal({ kind: "chat", contains: marker });
  expect(after.map((entry) => [entry.seq, entry.outcome])).toEqual([[requests[0]?.seq, "completed"]]);
});
