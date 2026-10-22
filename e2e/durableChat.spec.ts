import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "./isolatedPiWeb";

// A Durable Chat beside the seeded legacy Chats: create → send → stream → tool → queued follow-up → Stop → reload.
// Needs the Workbench Durable host: PI_WEB_E2E_DURABLE_HOST=<pi-workbench>/packages/durable-pilot/src/chat-host-main.ts.
// The host runs its scripted faux model (packages/durable-pilot/src/faux.ts): `gen` streams a long answer,
// `call:<tool> <json>` calls a tool, and a tool result is answered with `done after <tool>`.
test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const chat = (page: Page) => page.locator("chat-view");

async function send(page: Page, text: string, button = "Send message"): Promise<void> {
  await editor(page).click();
  // Inserted whole: typed braces would trigger the editor's bracket closing.
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: button }).click();
}

/** The Chat's rendered text through its shadow roots, without clock times. */
function transcriptText(page: Page): Promise<string> {
  return chat(page).first().evaluate((root) => {
    const walk = (node: Node): string => node.nodeType === Node.TEXT_NODE
      ? node.textContent ?? ""
      : [...(node instanceof Element && node.shadowRoot !== null ? node.shadowRoot.childNodes : []), ...node.childNodes].map(walk).join(" ");
    return walk(root).replace(/\s+/g, " ").replace(/\d+:\d+ [AP]M|[A-Z][a-z]{2} \d+, \d+ at [^·]*/g, "").replace(/Showing messages \S+ – \S+ of \S+ /, "").trim();
  });
}

test("a Durable Chat streams, runs tools, queues, stops and reloads to the same state", async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  test.setTimeout(60_000);
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);

  // Streaming: a partial answer shows while the run is still going.
  await send(page, "gen");
  await expect(chat(page).getByText(/word3 /).first()).toBeVisible();
  const partial = await transcriptText(page);
  await expect(chat(page).getByText(/word119/).first()).toBeVisible();
  expect(partial).not.toContain("word119");

  // A core tool in the Chat's workspace.
  await send(page, 'call:bash {"command":"echo tool-ran > durable-tool.txt; cat durable-tool.txt"}');
  await expect(chat(page).getByText("done after bash").first()).toBeVisible();
  expect(await readFile(join(project, "durable-tool.txt"), "utf8")).toBe("tool-ran\n");

  // A running tool, a queued follow-up, then Stop: the follow-up returns to the composer and is never sent.
  await send(page, 'call:bash {"command":"echo running; sleep 30"}');
  await expect(chat(page).getByText("running").first()).toBeVisible();
  await send(page, "the follow-up", "Queue follow-up");
  await expect(page.getByText("the follow-up").first()).toBeVisible();
  await page.getByRole("button", { name: "Stop current work" }).click();
  await expect(editor(page)).toHaveText("the follow-up");
  await expect(chat(page).getByText(/Tool bash was aborted/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop current work" })).toBeDisabled();
  const before = await transcriptText(page);
  expect(before).not.toMatch(/user the follow-up/);

  await page.reload();
  await expect(chat(page).getByText(/Tool bash was aborted/).first()).toBeVisible();
  await expect.poll(() => transcriptText(page)).toBe(before);
});

const ASK = {
  context: "Two deploy targets match the request.",
  questions: [{ id: "target", question: "Which target?", options: [{ value: "prod", label: "Production", recommended: true }, { value: "staging", label: "Staging" }] }],
};

test("a Durable Chat keeps Working Mode, answers a question, switches models and resolves an interrupted call", async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  test.setTimeout(90_000);
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  await send(page, "start");
  await expect(chat(page).getByText("ok: start").first()).toBeVisible();

  // Working Mode: the selection survives a reload and rides with the next prompt as a Working Mode card.
  const modeTrigger = page.getByRole("button", { name: /^Working Mode — / });
  await modeTrigger.click();
  await page.getByRole("dialog", { name: "Working Mode" }).getByRole("radio", { name: "Focused" }).click();
  await expect(modeTrigger).toHaveAttribute("title", /Attention: Focused|Focused/);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Working Mode — / })).toHaveAttribute("title", /Focused/);
  await send(page, "with mode");
  await expect(chat(page).getByText("ok: with mode").first()).toBeVisible();
  await expect(chat(page).locator("details.working-mode-card").first()).toContainText("Focused");

  // A question round-trip: chips above the composer, an answer, the model hears it once.
  await send(page, `call:ask_user ${JSON.stringify(ASK)}`);
  const chip = page.locator("workbench-question-chips .chip");
  await expect(chip).toHaveCount(1);
  await page.reload();
  await expect(chip).toHaveCount(1);
  await chip.first().click();
  const drawer = page.locator("workbench-question-chips .drawer");
  await drawer.locator('input[value="staging"]').check();
  await drawer.getByRole("button", { name: "Send answers" }).click();
  await expect(chip).toHaveCount(0);
  await expect(chat(page).getByText(/ok: The user submitted answers to question set/).first()).toBeVisible();

  // Model switching: a Claude subscription model is stored for the Chat (no request is sent), then back to the scripted one.
  const modelTrigger = page.getByRole("button", { name: /^Model: / });
  await modelTrigger.click();
  await page.getByRole("combobox", { name: "Search models" }).fill("claude");
  await page.getByRole("listbox", { name: "Models" }).getByRole("option").first().click();
  await expect(page.getByRole("button", { name: /^Model: anthropic\// })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Model: anthropic\// })).toBeVisible();
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill("faux");
  await page.getByRole("listbox", { name: "Models" }).getByRole("option").first().click();
  await expect(page.getByRole("button", { name: /^Model: faux\// })).toBeVisible();
  await send(page, "after switch");
  await expect(chat(page).getByText("ok: after switch").first()).toBeVisible();

  // An unsafe bash interrupted by a host restart blocks bash until the user resolves it in the Chat.
  // Barrier: the effect itself, so the tool is running when the host is stopped.
  await send(page, 'call:bash {"command":"echo deploy >> resolve-effects.log; sleep 30"}');
  await expect.poll(() => readFile(join(project, "resolve-effects.log"), "utf8").catch(() => "")).toBe("deploy\n");
  const stopped = await page.request.post(`${base}api/sessions/${encodeURIComponent(sessionId)}/stop`, { data: { cwd: project } });
  expect(stopped.ok()).toBe(true);
  await page.reload();
  const card = chat(page).locator(".unresolved-effects");
  await expect(card).toContainText("Needs reconciliation");
  await expect(card).toContainText("echo deploy");
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card).toHaveCount(0);
  await expect(chat(page).getByText(/The user resolved the interrupted bash call/).first()).toBeVisible();
  await page.reload();
  await expect(chat(page).locator(".unresolved-effects")).toHaveCount(0);
  expect((await readFile(join(project, "resolve-effects.log"), "utf8")).trim().split("\n")).toEqual(["deploy"]);
});

test("a Durable Chat shows the controls its host names, hides unsupported ones, takes /name, marks unread and needs-you on its tab, and refuses archiving", async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  test.setTimeout(90_000);
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const first = new URL(page.url()).searchParams.get("session") ?? "";

  // Capability gating from the host's ready list: a capability it names (attachments) shows its control; one it does
  // not name (fork, tree) stays hidden while copy, which needs none, shows.
  await send(page, "start");
  await expect(chat(page).getByText("ok: start").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
  await expect(chat(page).locator('[aria-label="Copy user message"]').first()).toBeAttached();
  await expect(chat(page).locator('[aria-label="Clone session from this message"], [aria-label="Go back to this message"]')).toHaveCount(0);

  // /name names the Chat in the catalog.
  await send(page, "/name Release prep");
  await expect.poll(async () => (await (await page.request.get(`${base}api/sessions?${new URLSearchParams({ cwd: project }).toString()}`)).json() as { id: string; name?: string }[]).find((s) => s.id === first)?.name).toBe("Durable · Release prep");

  // A turn that ends and an attention request while another Chat is open: unread, then needs you, on the first Chat's tab.
  await send(page, "gen");
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).not.toHaveURL(new RegExp(`session=${first}`));
  // The window is a Grid now: each tile's header dot carries the Chat's status.
  const tab = page.locator(`section.tile[data-session="${first}"] .dot`).first();
  await expect.poll(async () => (await (await page.request.get(`${base}api/sessions/unread`)).json() as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId)).toContain(first);
  await expect(tab).toHaveAttribute("data-status", "done");
  const prompt = await page.request.post(`${base}api/sessions/${encodeURIComponent(first)}/prompt`, { data: { cwd: project, text: 'call:request_attention {"reason":"Please review the diff"}' } });
  expect(prompt.ok()).toBe(true);
  await expect(tab).toHaveAttribute("data-status", "needs");
  await page.locator(`section.tile[data-session="${first}"]`).click();
  await expect.poll(async () => (await (await page.request.get(`${base}api/sessions/${encodeURIComponent(first)}/asks?${new URLSearchParams({ cwd: project }).toString()}`)).json() as { attentionRequest?: unknown }).attentionRequest).toBeUndefined();
  await expect(tab).toHaveAttribute("data-status", "idle");
  // The daemon's unread catalog (PI WEB's list view and the app badge) clears by the exact completion it was shown.
  const catalog = await (await page.request.get(`${base}api/sessions/unread`)).json() as { catalogId: string; sessions: { sessionId: string; completionOrder: number }[] };
  const order = catalog.sessions.find((s) => s.sessionId === first)?.completionOrder ?? 0;
  const stale = await page.request.post(`${base}api/sessions/${encodeURIComponent(first)}/unread/acknowledge`, { data: { cwd: project, catalogId: catalog.catalogId, throughCompletionOrder: order - 1 } });
  expect(((await stale.json()) as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId)).toContain(first);
  const acknowledged = await page.request.post(`${base}api/sessions/${encodeURIComponent(first)}/unread/acknowledge`, { data: { cwd: project, catalogId: catalog.catalogId, throughCompletionOrder: order } });
  expect(((await acknowledged.json()) as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId)).not.toContain(first);

  // Archiving is not ported (unused): its controls are hidden and the route refuses visibly.
  const archived = await page.request.post(`${base}api/sessions/${encodeURIComponent(first)}/archive`, { data: { cwd: project } });
  expect(archived.ok()).toBe(false);
  expect(await archived.text()).toContain("Archiving is not available in Durable Chats yet");
});

test("a Durable Chat compacts on /compact and continues after compact_and_continue, and both survive a reload", async ({ page }) => {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  if (base === undefined || workspaceId === undefined) throw new Error("Isolated PI WEB was not started");
  test.setTimeout(60_000);
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  await send(page, "one");
  await expect(chat(page).getByText("ok: one").first()).toBeVisible();
  await send(page, "two");
  await expect(chat(page).getByText("ok: two").first()).toBeVisible();

  // /compact with instructions: the summary appears as the transcript's history row, the earlier messages stay.
  await send(page, "/compact Keep the test names");
  await expect.poll(() => transcriptText(page)).toMatch(/history compaction summary|Compacted history/);
  await send(page, "three");
  await expect(chat(page).getByText("ok: three").first()).toBeVisible();

  // compact_and_continue: the run ends, a second summary is placed, and the next phase starts by itself.
  await send(page, `call:compact_and_continue ${JSON.stringify({ summaryFocus: "Keep the names", nextPhase: "write the docs" })}`);
  await expect(chat(page).getByText(/ok: Context checkpoint completed/).first()).toBeVisible();
  const checkVisible = async (): Promise<void> => {
    await expect(chat(page).getByText("Continue with the requested next phase: write the docs").first()).toBeVisible();
    await expect(chat(page).getByText(/ok: Context checkpoint completed/)).toHaveCount(1);
    await expect(chat(page).getByText("1 history compaction summary")).toHaveCount(2);
    for (const answer of ["ok: one", "ok: two", "ok: three"]) await expect(chat(page).getByText(answer)).toHaveCount(1);
  };
  await checkVisible();
  await page.reload();
  await checkVisible();
});

// P133 P134 P135: an installed Pi package (pi-process-monitor) in a Durable Chat. Needs PI_WEB_E2E_PI_PACKAGES=<dir holding
// the installed pi-process-monitor>, which the isolated PI WEB lists in its agent settings.
test("a Durable Chat runs an installed package's tool, shows its pings and its command output", async ({ page }) => {
  test.skip(process.env["PI_WEB_E2E_PI_PACKAGES"] === undefined, "PI_WEB_E2E_PI_PACKAGES is not set");
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"];
  if (base === undefined || workspaceId === undefined || project === undefined) throw new Error("Isolated PI WEB was not started");
  test.setTimeout(60_000);
  const log = join(project, "durable-watch.log");
  await writeFile(log, "");
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
  await page.getByRole("button", { name: "New Durable Chat" }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  await send(page, `call:monitor ${JSON.stringify({ source: { type: "tail", path: log }, options: { notifyOn: ["DONE"], coalesceSeconds: 0, label: "e2e-job" } })}`);
  await expect(chat(page).getByText("done after monitor").first()).toBeVisible();
  await appendFile(log, "build DONE\n");
  await expect(chat(page).getByText(/\[watcher \S+ · e2e-job\] build DONE/).first()).toBeVisible();
  await expect(chat(page).getByText(/ok: \[watcher/).first()).toBeVisible();
  await send(page, "/monitors");
  await expect(chat(page).getByText(/\[file\] state=claimed/).first()).toBeVisible();
  await page.reload();
  await expect(chat(page).getByText(/\[watcher \S+ · e2e-job\] build DONE/).first()).toBeVisible();
});
