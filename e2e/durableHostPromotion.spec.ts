import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { E2E_DURABLE_LABEL_PREFIX, E2E_PROJECT_ID, restartServices } from "./isolatedPiWeb";
import { MOCK_CLAUDE_MODEL } from "./mockModels/agentConfig";
import { mockModels, type JournalEntry, type Step } from "./mockModels/client";

// AC4 (Phase C4, pi-workbench docs/plans/pi-durable-cutover-spec.md): one Durable Chat runs a streaming lead, a Worker
// with a leaf, a Subagent, background bash, an open question and a queued follow-up. Two full promotions and one
// failed-health rollback leave its launchd host (same PID), its held provider requests (same mock journal seq) and
// every queue item, answer and child receipt alone; the open page converges without a reload.
// Two modes:
// - Isolated (default): promotion is simulated by restartServices(): SIGTERM the daemon and web service, start them
//   again with a new revision folder's host entry; the rollback starts a daemon whose web never answers, then the
//   previous one. Run: PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts
//   PI_WEB_E2E_DURABLE_LAUNCHD=1 TMPDIR=<a short folder> npx playwright test e2e/durableHostPromotion.spec.ts
// - Trial: against a running trial instance that pi-workbench `scripts/promote-installed --instance durable` installed
//   (PI_PROMOTE_DURABLE_TRIAL); PI_WEB_E2E_PROMOTE=<command> runs the real promotion: `<command> promote-1|promote-2|
//   rollback`. Also set PI_WEB_E2E_BASE_URL, PI_WEB_E2E_PROJECT_DIR, PI_WEB_E2E_WORKSPACE_ID, PI_WEB_E2E_DATA_DIR,
//   PI_WEB_E2E_MOCK_URL and PI_WEB_E2E_QUOTA_CACHE, and run with -c e2e/durableHostPromotion.trial.config.ts.
const trialPromote = process.env["PI_WEB_E2E_PROMOTE"];
test.skip(trialPromote === undefined && process.env["PI_WEB_E2E_SESSIOND_ENV"] === undefined, "needs PI_WEB_E2E_DURABLE_HOST and PI_WEB_E2E_DURABLE_LAUNCHD=1, or a trial");
test.skip(process.env["PI_WEB_E2E_MOCK_URL"] === undefined, "the mock model server is off (PI_WEB_E2E_MOCK_MODELS=0)");

const mock = mockModels();
const base = () => process.env["PI_WEB_E2E_BASE_URL"] ?? "";
const project = () => process.env["PI_WEB_E2E_PROJECT_DIR"] ?? "";
const dataDir = () => process.env["PI_WEB_E2E_DATA_DIR"] ?? join(dirname(project()), "data");
const chat = (page: Page) => page.locator("chat-view");
const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const questions = (page: Page) => page.locator("workbench-question-chips .bar");
const drawer = (page: Page) => page.locator("workbench-question-chips .drawer");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tc = (name: string, args: Record<string, unknown> = {}): Step => ({ toolCall: { name, args } });
type Message = { role?: string; toolName?: string; customType?: string; content?: string | { type: string; text?: string }[]; details?: Record<string, unknown> };
const textOf = (message: Message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("");

/** The one host process of this Chat's store, under this run's data folder only. */
function hostPid(sessionId: string): number {
  const store = join(dataDir(), "durable", sessionId);
  const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes(`--store ${store} `));
  expect(lines, `exactly one host under ${store}`).toHaveLength(1);
  return Number(lines[0]?.trim().split(/\s+/)[0]);
}

/** The PID launchd reports for the family's job; undefined when no such job runs (a forked host). */
function launchdPid(sessionId: string): number | undefined {
  try {
    const printed = execFileSync("launchctl", ["print", `gui/${String(process.getuid?.())}/${E2E_DURABLE_LABEL_PREFIX}.${sessionId}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pid = /^\s*pid = (\d+)$/m.exec(printed)?.[1];
    return pid === undefined ? undefined : Number(pid);
  } catch { return undefined; }
}

async function api(page: Page, sessionId: string, path: string, data?: object) {
  const url = `${base()}api/sessions/${encodeURIComponent(sessionId)}/${path}`;
  return data === undefined ? page.request.get(`${url}?${new URLSearchParams({ cwd: project(), limit: "1000" }).toString()}`) : page.request.post(url, { data: { cwd: project(), ...data } });
}
async function messages(page: Page, sessionId: string): Promise<Message[]> {
  const response = await api(page, sessionId, "messages");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { messages: Message[] }).messages;
}
async function status(page: Page, sessionId: string): Promise<{ isStreaming: boolean; queuedMessages: { text: string }[] }> {
  return (await api(page, sessionId, "status")).json() as Promise<{ isStreaming: boolean; queuedMessages: { text: string }[] }>;
}
async function send(page: Page, text: string, button = "Send message") {
  await editor(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: button, exact: true }).click();
}
/** A tool call from the lead, answered then acknowledged (each with its own marker). */
let calls = 0;
async function call(page: Page, sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<Message> {
  const marker = `c4-call-${String(++calls)}-${String(Date.now())}`;
  const before = (await messages(page, sessionId)).filter((m) => m.toolName === name).length;
  await mock.script({ provider: "anthropic", match: marker, turns: [[tc(name, args)], `ack ${marker}`] });
  await send(page, marker);
  await expect.poll(async () => (await messages(page, sessionId)).filter((m) => m.toolName === name).length).toBe(before + 1);
  await expect(chat(page).getByText(`ack ${marker}`, { exact: true })).toBeVisible();
  return (await messages(page, sessionId)).filter((m) => m.toolName === name).at(-1) ?? {};
}
async function requests(script: string): Promise<JournalEntry[]> {
  return (await mock.journal({ kind: "chat" })).filter((entry) => typeof entry.answeredBy === "object" && entry.answeredBy.script === script);
}

/** Isolated mode: each promotion's Workbench revision folder, a host entry that loads this run's host. */
async function revision(name: string): Promise<string> {
  const entry = await realpath(process.env["PI_WEB_E2E_DURABLE_HOST"] ?? "");
  const next = join(dirname(project()), `rev-${name}`, "chat-host-main.mjs");
  await mkdir(dirname(next), { recursive: true });
  await writeFile(next, `import ${JSON.stringify(entry)};\n`);
  return next;
}
let services: NodeJS.ProcessEnv | undefined;
async function promote(step: "promote-1" | "promote-2" | "rollback"): Promise<void> {
  if (trialPromote !== undefined) {
    await promisify(execFile)(trialPromote, [step], { timeout: 600_000 });
    return;
  }
  if (step !== "rollback") { services = await restartServices({ PI_WEB_DURABLE_HOST: await revision(step) }); return; }
  // The new revision's daemon starts, its web service never answers: after the health window the previous services return.
  await restartServices({ PI_WEB_DURABLE_HOST: await revision("bad") }, { web: false });
  for (let i = 0; i < 10; i += 1) {
    expect((await fetch(`${base()}api/projects`).catch(() => undefined))?.ok ?? false, "the failed revision is unhealthy").toBe(false);
    await new Promise((done) => setTimeout(done, 300));
  }
  await restartServices(services);
}

let gate = "";
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  // Background bash outlives its host by design: open the gate so a failed run leaves no job behind.
  if (gate !== "") await writeFile(`${gate}.go`, "go").catch(() => undefined);
  const sessionId = new URL(page.url()).searchParams.get("session");
  await writeFile(info.outputPath("mock-journal.json"), JSON.stringify(await mock.journal().catch(() => []), null, 2));
  if (sessionId !== null) await writeFile(info.outputPath("transcript.json"), JSON.stringify(await messages(page, sessionId).catch(() => []), null, 2));
});

test("AC4: two promotions and a failed-health rollback keep host, requests, queue, answer and receipts; the page converges", async ({ page }) => {
  test.setTimeout(trialPromote === undefined ? 300_000 : 1_200_000);
  await mock.reset();
  await writeFile(process.env["PI_WEB_E2E_QUOTA_CACHE"] ?? "", JSON.stringify({ version: 1, checkedAt: Date.now(), status: 0, stdout: JSON.stringify({ providers: [] }), stderr: "" }));
  const id = Date.now().toString(36);
  const [lead, worker, leaf, sub] = ["lead", "worker", "leaf", "sub"].map((name) => `c4-${name}-${id}`) as [string, string, string, string];
  gate = join(project(), `c4-bash-${id}`);

  await page.goto(`${base()}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: process.env["PI_WEB_E2E_WORKSPACE_ID"] ?? "" }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(MOCK_CLAUDE_MODEL.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: MOCK_CLAUDE_MODEL.id, exact: true }).first().click();
  await call(page, sessionId, "tools_enable", { group: "workers" });
  const workerId = String((await call(page, sessionId, "worker_create", { name: "Survivor", scope: "promotion", profile: "coordinator" })).details?.["workerId"]);
  // Gone after any reload or navigation: proves the page converged on its own.
  await page.evaluate(() => { (window as unknown as { c4Page?: string }).c4Page = "unreloaded"; });

  // The lead's second turn streams in four parts; each promotion releases one more.
  const leadScript = await mock.script({ provider: "anthropic", match: lead, turns: [
    [tc("worker_dispatch", { workerId, task: worker, cognitiveRole: "coordination", background: true }),
      tc("subagent", { task: sub, profile: "scout", cognitiveRole: "routine", background: true }),
      tc("bash", { description: "Wait for the gate", command: `echo launch >> '${gate}'; while [ ! -e '${gate}.go' ]; do sleep .1; done; echo c4-bash-done` }),
      tc("ask_user", { context: "Promotion survival.", questions: [{ id: "target", question: "Which target?", detail: "Where the build goes.", options: [{ value: "prod", label: "Production", detail: "Live now." }, { value: "stage", label: "Staging", detail: "Test first." }] }] })],
    [{ text: "Lead zero alpha." }, { barrier: `${lead}-1` }, { text: " Lead one beta." }, { barrier: `${lead}-2` }, { text: " Lead two gamma." }, { barrier: `${lead}-3` }, { text: " Lead three delta." }],
  ] });
  const workerScript = await mock.script({ provider: "anthropic", match: worker, turns: [[tc("subagent", { task: leaf, profile: "scout", cognitiveRole: "routine", background: true })], "Worker waits for its leaf.", "Worker result after the leaf."] });
  // Children route by profile; without a quota snapshot the scout falls back to the Claude mock, so they match by marker only.
  const leafScript = await mock.script({ match: leaf, turns: [[{ text: "Leaf working." }, { barrier: leaf }, { text: " Leaf complete." }]] });
  const subScript = await mock.script({ match: sub, turns: [[{ text: "Subagent working." }, { barrier: sub }, { text: " Subagent result." }]] });

  await send(page, `${lead} run the workload`);
  for (const barrier of [`${lead}-1`, leaf, sub]) await mock.waitForBarrier(barrier, 60_000);
  await expect(chat(page).getByText("Lead zero").first()).toBeVisible();
  await expect(questions(page)).toHaveText("1 open question");
  await expect.poll(async () => (await readFile(gate, "utf8").catch(() => "")).trim()).toBe("launch");
  const queued = `c4-queued-${id}`;
  await send(page, queued, "Queue follow-up");
  await expect(page.locator(".queued-message")).toHaveCount(1);
  await expect.poll(async () => (await status(page, sessionId)).queuedMessages.map((m) => m.text)).toEqual([queued]);
  // The worker's first two turns finish; then only the three held requests stay open.
  await expect.poll(async () => (await requests(workerScript)).map((r) => r.outcome)).toEqual(["completed", "completed"]);

  const pid = hostPid(sessionId);
  const launchd = launchdPid(sessionId);
  const held = async () => Object.fromEntries((await Promise.all([leadScript, leafScript, subScript].map(requests))).map((entries, index) => [["lead", "leaf", "sub"][index], entries.map((e) => [e.seq, e.outcome])]));
  /** Promote, then: same host, no new or lost provider request, queue and open question as they were. */
  const survive = async (step: "promote-1" | "promote-2" | "rollback") => {
    // Wakes of children that finished just before are still being queued: promote once the queue is still.
    let last = "", still = 0;
    await expect.poll(async () => {
      const now = JSON.stringify((await status(page, sessionId)).queuedMessages.map((m) => m.text));
      still = now === last ? still + 1 : 0;
      last = now;
      return still;
    }, { intervals: [500], timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    const journal = (await mock.journal({ kind: "chat" })).map((e) => [e.seq, e.outcome]);
    const before = { held: await held(), queue: (await status(page, sessionId)).queuedMessages.map((m) => m.text) };
    await promote(step);
    expect(alive(pid), `${step}: the host process lives`).toBe(true);
    expect(hostPid(sessionId), `${step}: the same host`).toBe(pid);
    expect(launchdPid(sessionId), `${step}: the same launchd job PID`).toBe(launchd);
    expect((await mock.journal({ kind: "chat" })).map((e) => [e.seq, e.outcome]), `${step}: no provider request issued, closed or lost`).toEqual(journal);
    expect(await held()).toEqual(before.held);
    await expect.poll(async () => (await status(page, sessionId)).queuedMessages.map((m) => m.text), { timeout: 30_000 }).toEqual(before.queue);
    steps.push({ step, hostPid: hostPid(sessionId), launchdPid: launchdPid(sessionId), held: await held(), queue: before.queue.map((text) => text.slice(0, 60)) });
  };
  const steps: object[] = [];

  await survive("promote-1");
  // The page follows the restarted services on its own: the stream goes on, the question is answered once.
  await mock.release(`${lead}-1`);
  await expect(chat(page).getByText("Lead one").first()).toBeVisible({ timeout: 30_000 });
  await expect(questions(page)).toHaveText("1 open question");
  await questions(page).click();
  await drawer(page).locator('input[value="stage"]').check();
  await drawer(page).getByRole("button", { name: /^Send/ }).click();
  await expect(questions(page)).toHaveCount(0, { timeout: 30_000 });
  await mock.release(sub);
  await expect.poll(async () => (await requests(subScript)).map((r) => r.outcome)).toEqual(["completed"]);
  await expect.poll(async () => (await status(page, sessionId)).queuedMessages.some((m) => m.text.includes("Subagent result."))).toBe(true);

  await survive("promote-2");
  await mock.release(`${lead}-2`);
  await expect(chat(page).getByText("Lead two").first()).toBeVisible({ timeout: 30_000 });
  await mock.release(leaf);
  await expect.poll(async () => (await requests(workerScript)).map((r) => r.outcome), { timeout: 30_000 }).toEqual(["completed", "completed", "completed"]);
  await writeFile(`${gate}.go`, "go");
  // The job ends now; its completion notice waits for the lead's turn.
  const log = /Output log: (\S+)/.exec(textOf((await messages(page, sessionId)).find((m) => m.toolName === "bash") ?? {}))?.[1] ?? "";
  await expect.poll(async () => (await readFile(join(dirname(log), "exit"), "utf8").catch(() => "")) !== "", { timeout: 30_000 }).toBe(true);

  await survive("rollback");
  await mock.release(`${lead}-3`);
  await expect(chat(page).getByText("Lead three").first()).toBeVisible({ timeout: 30_000 });
  // The queued follow-up, the answer and the wakes run after the held turn; unscripted requests get the mock's echo.
  await expect(page.locator(".queued-message")).toHaveCount(0, { timeout: 60_000 });
  await expect(chat(page).getByText(queued, { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await status(page, sessionId)).isStreaming, { timeout: 60_000 }).toBe(false);
  await expect.poll(async () => (await status(page, sessionId)).queuedMessages).toEqual([]);

  const transcript = await messages(page, sessionId);
  // No queue item or answer lost or doubled.
  expect(transcript.filter((m) => m.role === "user" && textOf(m).includes(queued))).toHaveLength(1);
  expect(transcript.filter((m) => textOf(m).includes("stage") && m.toolName !== "ask_user" && m.role !== "assistant")).toHaveLength(1);
  // One terminal receipt per child: each lead child in exactly one completion notice, the leaf once to its Worker, the bash job once.
  const dispatch = transcript.find((m) => m.toolName === "worker_dispatch")?.details?.["executionId"];
  const subagent = transcript.find((m) => m.toolName === "subagent")?.details?.["executionId"];
  const delivered = transcript.filter((m) => m.customType === "pi-workbench:child-completion").flatMap((m) => (m.details?.["delivered"] ?? []) as string[]);
  expect([...delivered].sort()).toEqual([String(dispatch), String(subagent)].sort());
  const workerRequests = await requests(workerScript);
  expect(workerRequests).toHaveLength(3);
  expect(workerRequests[2]?.lastUserText.split("Leaf complete.").length).toBe(2);
  expect(transcript.filter((m) => m.customType === "background-bash")).toHaveLength(1);
  expect((await readFile(gate, "utf8")).trim()).toBe("launch");
  // Every held provider request finished once, under its first seq; nothing was cut or retried.
  for (const script of [leadScript, leafScript, subScript]) expect((await requests(script)).map((r) => r.outcome)).toEqual(script === leadScript ? ["completed", "completed"] : ["completed"]);
  const journal = await mock.journal();
  expect(journal.filter((e) => e.outcome !== "completed")).toEqual([]);
  expect(journal.flatMap((e) => e.violations)).toEqual([]);
  const record = (await call(page, sessionId, "worker_status", { workerId })).details?.["worker"] as { receipts: unknown[]; lock: unknown };
  expect(record.receipts).toHaveLength(1);
  expect(record.lock).toBeNull();
  // The same host throughout, owned by launchd, and the page never reloaded.
  expect(hostPid(sessionId)).toBe(pid);
  expect(launchd).toBe(pid);
  expect(await page.evaluate(() => (window as unknown as { c4Page?: string }).c4Page)).toBe("unreloaded");
  await writeFile(test.info().outputPath("survival.json"), JSON.stringify({ sessionId, steps, hostPid: pid, launchdPid: launchd, held: await held(), journal: journal.map((e) => ({ seq: e.seq, provider: e.provider, answeredBy: e.answeredBy, outcome: e.outcome })) }, null, 2));
});
