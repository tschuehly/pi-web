import { execFileSync } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_DURABLE_LABEL_PREFIX, E2E_PROJECT_ID, restartSessiond } from "./isolatedPiWeb";
import { MOCK_CLAUDE_MODEL } from "./mockModels/agentConfig";
import { mockModels } from "./mockModels/client";

// AC5 (Phase C3), the visible part: a Chat whose family host runs older code than the daemon now starts shows its pinned
// revision and an "Upgrade host" action; the upgrade moves it to the new code. Ending, idle close, refusal while busy and
// pinning across host restarts: durableHostLaunchd.test.ts (real launchd).
// Run: PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts PI_WEB_E2E_DURABLE_LAUNCHD=1
//      TMPDIR=<a folder short enough for Unix sockets> npx playwright test e2e/durableHostLifetime.spec.ts
test.skip(process.env["PI_WEB_E2E_SESSIOND_ENV"] === undefined, "needs PI_WEB_E2E_DURABLE_HOST and PI_WEB_E2E_DURABLE_LAUNCHD=1");
test.skip(process.env["PI_WEB_E2E_MOCK_URL"] === undefined, "the mock model server is off (PI_WEB_E2E_MOCK_MODELS=0)");
const mock = mockModels();
test.beforeEach(async () => { await mock.reset(); });

const editor = (page: Page) => page.locator("chat-view");
const root = () => dirname(process.env["PI_WEB_E2E_PROJECT_DIR"] ?? "");

/** The one host process of this Chat's store and its command line, under this fixture's root only. */
function host(sessionId: string): { pid: number; command: string } {
  const store = join(root(), "data", "durable", sessionId);
  const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes(`--store ${store} `));
  expect(lines, `exactly one host under ${store}`).toHaveLength(1);
  const [pid, ...command] = lines[0]?.trim().split(/\s+/) ?? [];
  return { pid: Number(pid), command: command.join(" ") };
}

function launchdPid(sessionId: string): number | undefined {
  const printed = execFileSync("launchctl", ["print", `gui/${String(process.getuid?.())}/${E2E_DURABLE_LABEL_PREFIX}.${sessionId}`], { encoding: "utf8" });
  const pid = /^\s*pid = (\d+)$/m.exec(printed)?.[1];
  return pid === undefined ? undefined : Number(pid);
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("prompt-editor .cm-content").click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test("AC5: a Chat on older host code shows its pinned revision; Upgrade host moves it to the new code", async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"] ?? "";
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"] ?? "";
  const marker = `c3-${String(Date.now())}`;
  await mock.script({ provider: "anthropic", match: `${marker} before`, turns: [[{ text: "Answered on the old host." }]] });
  await mock.script({ provider: "anthropic", match: `${marker} after`, turns: [[{ text: "Answered on the new host." }]] });

  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(MOCK_CLAUDE_MODEL.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: MOCK_CLAUDE_MODEL.id, exact: true }).first().click();
  await send(page, `${marker} before`);
  await expect(editor(page).getByText("Answered on the old host.").first()).toBeVisible({ timeout: 30_000 });
  const old = host(sessionId);
  // Current code: nothing pinned, nothing to upgrade.
  await expect(page.getByRole("button", { name: "Upgrade host" })).toHaveCount(0);

  // Newer host code (another entry, as a promotion's new revision folder) under a restarted daemon.
  const entry = await realpath(process.env["PI_WEB_E2E_DURABLE_HOST"] ?? "");
  const next = join(root(), "rev-next", "chat-host-main.mjs");
  await mkdir(dirname(next), { recursive: true });
  await writeFile(next, `import ${JSON.stringify(entry)};\n`);
  // A revision folder ships its node_modules: Upgrade host reads its Pi Durable version there (and refuses an older one).
  await symlink(join(dirname(entry), "..", "node_modules"), join(dirname(next), "node_modules"));
  await restartSessiond({ PI_WEB_DURABLE_HOST: next });
  await page.reload();

  // The family stays on its old host and says so.
  const pin = page.locator(".durable-host-pin");
  await expect(pin).toContainText("new Chats run rev-next", { timeout: 20_000 });
  expect(host(sessionId).pid).toBe(old.pid);

  // Asked while quiet: the host closes in order and the next one runs the new entry.
  await pin.getByRole("button", { name: "Upgrade host" }).click();
  await expect(pin).toHaveCount(0, { timeout: 30_000 });
  const upgraded = host(sessionId);
  expect(upgraded.pid).not.toBe(old.pid);
  expect(upgraded.command).toContain(await realpath(next));
  expect(launchdPid(sessionId)).toBe(upgraded.pid);
  await send(page, `${marker} after`);
  await expect(editor(page).getByText("Answered on the new host.").first()).toBeVisible({ timeout: 30_000 });
});
