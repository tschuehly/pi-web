import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_DURABLE_LABEL_PREFIX, E2E_PROJECT_ID, restartSessiond } from "./isolatedPiWeb";
import { MOCK_CLAUDE_MODEL } from "./mockModels/agentConfig";
import { mockModels, type JournalEntry, type Step } from "./mockModels/client";

// Seamless upgrade C, live proof (pi-workbench docs/plans/pi-durable-cutover-runbook.md "Host lifetime"): a Chat whose
// launchd host runs older code has a running Subagent (its provider request held) and a running background bash job.
// Upgrade now restarts it on the new code: the Chat resumes by itself, the Subagent's request is made again and its
// result reaches the lead once, and the bash job (launched once) completes once. Mocked providers only.
// Run: PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts PI_WEB_E2E_DURABLE_LAUNCHD=1
//      TMPDIR=<a folder short enough for Unix sockets> npx playwright test e2e/durableHostUpgradeNow.spec.ts
test.skip(process.env["PI_WEB_E2E_SESSIOND_ENV"] === undefined, "needs PI_WEB_E2E_DURABLE_HOST and PI_WEB_E2E_DURABLE_LAUNCHD=1");
test.skip(process.env["PI_WEB_E2E_MOCK_URL"] === undefined, "the mock model server is off (PI_WEB_E2E_MOCK_MODELS=0)");

const mock = mockModels();
const base = () => process.env["PI_WEB_E2E_BASE_URL"] ?? "";
const project = () => process.env["PI_WEB_E2E_PROJECT_DIR"] ?? "";
const chat = (page: Page) => page.locator("chat-view");
const tc = (name: string, args: Record<string, unknown> = {}): Step => ({ toolCall: { name, args } });
type Message = { role?: string; toolName?: string; customType?: string; content?: string | { type: string; text?: string }[]; details?: Record<string, unknown> };
const textOf = (message: Message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");

/** The one host process of this Chat's store and its command line. */
function host(sessionId: string): { pid: number; command: string } {
  const store = join(dirname(project()), "data", "durable", sessionId);
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
async function messages(page: Page, sessionId: string): Promise<Message[]> {
  const response = await page.request.get(`${base()}api/sessions/${encodeURIComponent(sessionId)}/messages?${new URLSearchParams({ cwd: project(), limit: "1000" }).toString()}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { messages: Message[] }).messages;
}
async function requests(script: string): Promise<JournalEntry[]> {
  return (await mock.journal({ kind: "chat" })).filter((entry) => typeof entry.answeredBy === "object" && entry.answeredBy.script === script);
}

let gate = "";
test.afterEach(async ({ page }, info) => {
  // Background bash outlives its host by design: open the gate so no job stays behind.
  if (gate !== "") await writeFile(`${gate}.go`, "go").catch(() => undefined);
  const sessionId = new URL(page.url()).searchParams.get("session");
  await writeFile(info.outputPath("mock-journal.json"), JSON.stringify(await mock.journal().catch(() => []), null, 2));
  if (sessionId !== null) {
    await writeFile(info.outputPath("transcript.json"), JSON.stringify(await messages(page, sessionId).catch(() => []), null, 2));
    await page.request.post(`${base()}api/sessions/${encodeURIComponent(sessionId)}/stop`, { data: { cwd: project() } }).catch(() => undefined);
  }
});

test("Upgrade now: a Chat with a running Subagent and background bash moves to the new host code; both finish once", async ({ page }) => {
  test.setTimeout(240_000);
  await mock.reset();
  await writeFile(process.env["PI_WEB_E2E_QUOTA_CACHE"] ?? "", JSON.stringify({ version: 1, checkedAt: Date.now(), status: 0, stdout: JSON.stringify({ providers: [] }), stderr: "" }));
  const id = Date.now().toString(36);
  const [lead, sub] = [`up-lead-${id}`, `up-sub-${id}`];
  gate = join(project(), `up-bash-${id}`);

  await page.goto(`${base()}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: process.env["PI_WEB_E2E_WORKSPACE_ID"] ?? "" }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(MOCK_CLAUDE_MODEL.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: MOCK_CLAUDE_MODEL.id, exact: true }).first().click();

  const leadScript = await mock.script({ provider: "anthropic", match: lead, turns: [
    [tc("subagent", { task: sub, profile: "scout", cognitiveRole: "routine", background: true }),
      tc("bash", { description: "Wait for the gate", command: `echo launch >> '${gate}'; while [ ! -e '${gate}.go' ]; do sleep .1; done; echo up-bash-done` })],
    "Both launched.",
  ] });
  // The first request is held at the barrier (cut by the upgrade); the new host's request answers.
  const subScript = await mock.script({ match: sub, turns: [[{ text: "Subagent working." }, { barrier: sub }, { text: " Subagent result." }], "Subagent result after the upgrade."] });

  await page.locator("prompt-editor .cm-content").click();
  await page.keyboard.insertText(`${lead} run both`);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await mock.waitForBarrier(sub, 60_000);
  await expect(chat(page).getByText("Both launched.").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await readFile(gate, "utf8").catch(() => "")).trim()).toBe("launch");
  const old = host(sessionId);

  // Newer host code (a promotion's revision folder) under a restarted daemon; the family stays pinned.
  const entry = await realpath(process.env["PI_WEB_E2E_DURABLE_HOST"] ?? "");
  const next = join(dirname(project()), `rev-up-${id}`, "chat-host-main.mjs");
  await mkdir(dirname(next), { recursive: true });
  await writeFile(next, `import ${JSON.stringify(entry)};\n`);
  await symlink(join(dirname(entry), "..", "node_modules"), join(dirname(next), "node_modules"));
  await restartSessiond({ PI_WEB_DURABLE_HOST: next });
  await page.reload();
  const pin = page.locator(".durable-host-pin");
  await expect(pin).toContainText(`new Chats run rev-up-${id}`, { timeout: 20_000 });
  expect(host(sessionId).pid).toBe(old.pid);
  // Upgrade host refuses while children run; Upgrade now names what it repeats.
  const now = pin.getByRole("button", { name: /^Upgrade now/ });
  await expect(now).toContainText("running Subagents and Workers resume");

  await now.click();
  await expect(pin).toHaveCount(0, { timeout: 60_000 });
  const upgraded = host(sessionId);
  expect(upgraded.pid).not.toBe(old.pid);
  expect(upgraded.command).toContain(await realpath(next));
  expect(launchdPid(sessionId)).toBe(upgraded.pid);

  // Both finish, without another message: the Subagent's result reaches the lead once, the bash job completes once.
  await mock.release(sub);
  await writeFile(`${gate}.go`, "go");
  const delivered = (list: Message[]) => list.filter((m) => m.customType === "pi-workbench:child-completion").flatMap((m) => (m.details?.["delivered"] ?? []) as string[]);
  await expect.poll(async () => delivered(await messages(page, sessionId)).length, { timeout: 90_000 }).toBe(1);
  await expect.poll(async () => (await messages(page, sessionId)).filter((m) => m.customType === "background-bash").length, { timeout: 90_000 }).toBe(1);
  const transcript = await messages(page, sessionId);
  const subagent = transcript.find((m) => m.toolName === "subagent")?.details?.["executionId"];
  expect(delivered(transcript)).toEqual([String(subagent)]);
  expect(transcript.filter((m) => m.toolName === "subagent")).toHaveLength(1);
  const completion = transcript.find((m) => m.customType === "background-bash") ?? {};
  expect(textOf(completion)).toContain("up-bash-done");
  expect(transcript.filter((m) => m.customType === "pi-workbench:child-completion" && textOf(m).includes("Subagent result"))).toHaveLength(1);
  expect((await readFile(gate, "utf8")).trim()).toBe("launch");
  const journal = await mock.journal();
  expect(journal.flatMap((e) => e.violations)).toEqual([]);
  await writeFile(test.info().outputPath("upgrade-now.json"), JSON.stringify({
    sessionId, oldHost: old, newHost: upgraded, launchdPid: launchdPid(sessionId),
    subagentRequests: (await requests(subScript)).map((r) => ({ seq: r.seq, outcome: r.outcome })),
    leadRequests: (await requests(leadScript)).map((r) => ({ seq: r.seq, outcome: r.outcome })),
    deliveries: delivered(transcript), bashCompletions: transcript.filter((m) => m.customType === "background-bash").length,
    bashLaunches: (await readFile(gate, "utf8")).trim().split("\n").length, completionText: textOf(completion).slice(0, 300),
  }, null, 2));
});
