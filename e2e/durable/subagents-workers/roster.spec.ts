import { writeFile } from "node:fs/promises";
// AC-P089–AC-P094, AC-P099: foreground/background children, routing, status, bounded collection and completion roster.
import type { Page } from "@playwright/test";
import { expect, test, call, create, idOf, messages, requests, scout, tc, textOf, tools, row as rows } from "./support";
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
    [{ barrier: `${childDone}-report` }, { toolCall: { name: "report_status", args: { status: "Checking the roster result" } } }],
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
  await mock.waitForBarrier(`${childDone}-report`);
  await mock.release(`${childDone}-report`);
  await mock.waitForBarrier(childDone);
  await expect(row).toHaveCount(1);
  await expect(row.locator(".report")).toHaveText("Status: Checking the roster result");

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

  // Journal: all child requests went to the ChatGPT subscription on the routed model; the lead's four to Claude.
  const childRequests = await mock.journal({ provider: "openai-codex", kind: "chat", contains: child });
  expect(childRequests.map((entry) => entry.answeredBy)).toEqual([0, 1, 2].map((turn) => ({ script: childScript, turn })));
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

for (const legacy of [false, true]) {
  test(`AC-P089 ${legacy ? "legacy" : "Durable"} foreground children have fresh context, native tools, separate identity and model receipts`, async ({ page }) => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const project = process.env["PI_WEB_E2E_PROJECT_DIR"]!;
    const session = await create(page, legacy);
    await call(page, "report_status", { status: "PARENT-ONLY-CONTEXT" });
    const identities: { id: string; tmp: string }[] = [];
    for (const index of [0, 1]) {
      const marker = `identity-child-${session}-${index}`;
      const script = await mock.script({ provider: "openai-codex", match: marker, turns: [
        [tc("bash", { command: `node -e 'require("fs").writeFileSync("${marker}.json",JSON.stringify({id:process.env.PI_SESSION_ID,tmp:process.env.PI_TMP}))'` }), tc("grep", { pattern: "Seeded", path: "docs/notes.md" }), tc("find", { pattern: "*.md", path: "docs" }), tc("ls", { path: "docs" })],
        [tc("subagent", scout("forbidden-grandchild"))],
        "Identity child finished.",
      ] });
      const result = await call(page, "subagent", scout(marker, { background: false }));
      expect(textOf(result)).toContain("Completion receipt: openai-codex/gpt-6-luna:medium");
      expect(result.isError).not.toBe(true);
      const child = await requests(script);
      expect(child).toHaveLength(3);
      expect(JSON.stringify(child[0]!.body)).not.toContain("PARENT-ONLY-CONTEXT");
      expect.soft(tools(child[0]!).map((t) => t.name)).toEqual(expect.arrayContaining(["bash", "grep", "find", "ls", "read", "report_status"]));
      expect(tools(child[0]!).map((t) => t.name)).not.toEqual(expect.arrayContaining(["subagent"]));
      expect(tools(child[0]!).find((t) => t.name === "bash")?.properties ?? {}).not.toHaveProperty("foreground");
      expect(JSON.stringify(child[1]!.body)).toContain("Seeded notes body for the file-link check.");
      expect(JSON.stringify(child[1]!.body)).toContain("conflict.md");
      expect(JSON.stringify(child[2]!.body)).toMatch(/not available|not found|Unknown tool|not registered/i);
      identities.push(JSON.parse(await readFile(join(project, `${marker}.json`), "utf8")));
    }
    expect(identities[0]!.id).not.toBe(identities[1]!.id);
    expect(identities[0]!.tmp).not.toBe(identities[1]!.tmp);
    for (const identity of identities) {
      expect(identity.id).toBeTruthy();
      expect(identity.tmp).toBeTruthy();
      expect(identity.id).not.toBe(session);
    }
    expect((await messages(page)).filter((m) => m.customType === "pi-workbench:child-completion")).toHaveLength(0);
    expect(textOf(await call(page, "subagent_status", { all: true }))).toMatch(/collected/);
  });
}

test("AC-P089 review routes away from author family and refuses a same-family override", async ({ page }) => {
  await create(page);
  for (const author of ["openai-codex/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"]) {
    const marker = `review-child-${Date.now()}`;
    const provider = author.startsWith("openai") ? "anthropic" : "openai-codex";
    const model = provider === "anthropic" ? "claude-opus-5-5" : "gpt-6.1-sol";
    const script = await mock.script({ provider, match: marker, turns: ["Independent review complete."] });
    const receipt = await call(page, "subagent", scout(marker, { profile: "reviewer", cognitiveRole: "review", independentOfModel: author, background: false }));
    expect(textOf(receipt)).toContain(`Completion receipt: ${provider}/${model}:high`);
    expect(textOf(receipt)).toContain(`family ${provider === "anthropic" ? "anthropic" : "openai"}`);
    expect((await requests(script)).map((r) => [r.provider, r.model])).toEqual([[provider, model]]);
    const refused = await call(page, "subagent", scout("forbidden-same-family", { profile: "reviewer", cognitiveRole: "review", independentOfModel: author, modelOverride: author, background: false }));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/not independent|independen.*family/i);
  }
});

test("AC-P089 launch receipt includes execution identity, cwd and binding", async ({ page }) => {
  await create(page);
  const marker = `receipt-child-${Date.now()}`;
  await mock.script({ provider: "openai-codex", match: marker, turns: [[{ barrier: marker }, { text: "done" }]] });
  const receipt = await call(page, "subagent", scout(marker));
  expect(idOf(receipt)).toMatch(/^[0-9a-f-]{36}$/);
  expect(textOf(receipt)).toContain("openai-codex/gpt-6-luna:medium (scout · routine)");
  // The AC explicitly requires cwd in the receipt, not merely in a later diagnostic status.
  expect.soft(JSON.stringify(receipt)).toContain(process.env["PI_WEB_E2E_PROJECT_DIR"]!);
  await call(page, "subagent_cancel", { executionId: idOf(receipt) });
});

test("AC-P090 AC-P091 AC-P099 coalesced results stay uncollected on status, truncate honestly and collect once", async ({ page }) => {
  await create(page);
  const child = `bounded-${Date.now()}`;
  const long = await mock.script({ provider: "openai-codex", match: `${child}-long`, turns: [[{ barrier: "long" }, { text: "x".repeat(9000) }]] });
  const failure = await mock.script({ provider: "openai-codex", match: `${child}-failed`, turns: [[{ barrier: "failed" }, { error: "invalid_request" }]] });
  const first = await call(page, "subagent", scout(`${child}-long`));
  const second = await call(page, "subagent", scout(`${child}-failed`));
  const running = await call(page, "subagent_collect", { executionId: idOf(first) });
  expect(textOf(running)).toContain("Still running");
  expect(textOf(await call(page, "subagent_status", { executionId: idOf(first) }))).toMatch(/running.*scout.*routine.*gpt-6-luna/s);
  // Hold the parent's request so both completions queue at the same actionable boundary.
  const hold = `lead-busy-${Date.now()}`;
  await mock.script({ provider: "anthropic", match: hold, turns: [[{ barrier: "parent-busy" }, { text: "Parent is ready." }], "Wake observed, results not collected."] });
  await send(page, hold);
  await mock.waitForBarrier("parent-busy");
  await mock.release("long");
  await mock.release("failed");
  await expect.poll(async () => (await messages(page)).filter((m) => m.customType === "pi-workbench:child-completion").length).toBe(0);
  await expect.poll(async () => rows(page).locator(".status").allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/To collect/i), expect.stringMatching(/failed/i)]));
  await mock.release("parent-busy");
  await expect(page.locator("chat-view").getByText("Wake observed, results not collected.", { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  const diagnostic = await call(page, "subagent_status");
  expect(textOf(diagnostic)).toContain("0 running, 2 terminal and uncollected, 2 launched");
  const collected = await call(page, "subagent_collect");
  expect(textOf(collected)).toContain("Reconciled 2 of 2 terminal children");
  expect(textOf(collected)).toContain("showing the first 8000 of 9000 characters");
  expect(textOf(collected)).toContain("TRUNCATED, cannot satisfy verification");
  expect(textOf(collected)).toContain("execution_failed");
  expect(collected.isError).toBe(true);
  await expect(rows(page)).toHaveCount(0);
  expect(textOf(await call(page, "subagent_status"))).toContain("Nothing needs reconciliation");
  expect(textOf(await call(page, "subagent_status", { all: true }))).toContain(`${idOf(second)} [execution_failed, collected]`);
  expect(textOf(await call(page, "subagent_collect"))).toContain("Nothing terminal to reconcile");
  expect((await messages(page)).filter((m) => m.customType === "pi-workbench:child-completion")).toHaveLength(1);
  expect(await requests(long)).toHaveLength(1);
  expect(await requests(failure)).toHaveLength(1);
});

for (const legacy of [false, true]) test(`AC-P094 ${legacy ? "legacy" : "Durable"} steer and follow-up deliver once; requested status wakes; running follow-up must remain cancellable`, async ({ page }) => {
  const { killHost, status } = await import("./support");
  await create(page, legacy);
  const marker = `steered-child-${Date.now()}`;
  const script = await mock.script({ provider: "openai-codex", match: marker, turns: [
    [tc("report_status", { status: "Before steer" })],
    [{ barrier: "child-before-steer" }, tc("report_status", { status: "After steer" })],
    [{ barrier: "child-follow-up" }, { text: "Steered answer" }],
    [{ barrier: "child-after-follow-up" }, { text: "Should be cancelled" }],
  ] });
  const id = idOf(await call(page, "subagent", scout(marker)));
  await mock.waitForBarrier("child-before-steer");
  expect((await messages(page)).filter((m) => m.customType === "pi-workbench:child-update")).toHaveLength(0);
  const steer = await call(page, "subagent_steer", { executionId: id, message: "STEER-ONCE", requestUpdate: true });
  const followUp = await call(page, "subagent_steer", { executionId: id, message: "FOLLOW-UP-ONCE", mode: "followUp" });
  expect(steer.details).toMatchObject({ executionId: id, mode: "steer" });
  expect(followUp.details).toMatchObject({ executionId: id, mode: "followUp" });
  expect(Number(followUp.details!["sequence"])).toBeGreaterThan(Number(steer.details!["sequence"]));
  await mock.release("child-before-steer");
  await mock.waitForBarrier("child-follow-up");
  await expect.poll(async () => (await messages(page)).filter((m) => m.customType === "pi-workbench:child-update").length).toBe(1);
  await expect(rows(page).locator(".report")).toContainText("After steer");
  await mock.release("child-follow-up");
  await mock.waitForBarrier("child-after-follow-up");
  const child = await requests(script);
  expect(JSON.stringify(child[2]!.body).match(/STEER-ONCE/g)).toHaveLength(1);
  expect(JSON.stringify(child[3]!.body).match(/FOLLOW-UP-ONCE/g)).toHaveLength(1);
  expect.soft((await messages(page)).filter((m) => m.customType === "pi-workbench:child-completion")).toHaveLength(0);
  const cancelled = await call(page, "subagent_cancel", { executionId: id, reason: "acceptance cancellation" });
  expect(textOf(cancelled)).toBe(`${id}: cancelled.`);
  expect(textOf(await call(page, "subagent_status", { executionId: id }))).toContain("cancelled");
  if (!legacy) await killHost(page);
  await status(page);
  await page.reload();
  expect(textOf(await call(page, "subagent_status", { executionId: id }))).toContain("cancelled");
  await mock.release("child-after-follow-up");
  expect((await messages(page)).filter((m) => m.customType === "pi-workbench:child-completion")).toHaveLength(0);
  expect((await messages(page)).filter((m) => m.customType === "pi-workbench:child-update")).toHaveLength(1);
});

test("AC-P093 cancelling a running Subagent survives SIGKILL without late result or wake", async ({ page }) => {
  const { killHost, status } = await import("./support");
  await create(page);
  const marker = `cancel-single-${Date.now()}`;
  const script = await mock.script({ provider: "openai-codex", match: marker, turns: [[{ barrier: marker }, { text: "Forbidden late result" }]] });
  const id = idOf(await call(page, "subagent", scout(marker)));
  await mock.waitForBarrier(marker);
  expect(textOf(await call(page, "subagent_cancel", { executionId: id }))).toBe(`${id}: cancelled.`);
  await expect.poll(async () => (await requests(script))[0]!.outcome).toBe("client-closed");
  await killHost(page);
  await status(page);
  await page.reload();
  expect(textOf(await call(page, "subagent_status", { executionId: id }))).toContain("[cancelled, collected]");
  await mock.release(marker);
  expect((await messages(page)).filter((m) => m.customType === "pi-workbench:child-completion")).toHaveLength(0);
  expect(await requests(script)).toHaveLength(1);
});

test("AC-P090 bounded bulk collection leaves the unreturned remainder unread for collect by ID", async ({ page }) => {
  await create(page);
  const scripts: string[] = [];
  for (let index = 0; index < 4; index++) {
    const marker = `bulk-${index}-${Date.now()}`;
    scripts.push(await mock.script({ provider: "openai-codex", match: marker, turns: [[{ barrier: "bulk-ready" }, { text: "b".repeat(9000) }]] }));
    await call(page, "subagent", scout(marker));
  }
  const lead = `bulk-lead-${Date.now()}`;
  await mock.script({ provider: "anthropic", match: lead, turns: [[{ barrier: "bulk-parent" }, { text: "Parent ready." }], "Bulk wake noted."] });
  await send(page, lead);
  await mock.waitForBarrier("bulk-parent");
  await mock.release("bulk-ready");
  await expect.poll(async () => rows(page).locator(".status").allTextContents()).toEqual(Array(4).fill("To collect"));
  await mock.release("bulk-parent");
  await expect(page.locator("chat-view").getByText("Bulk wake noted.", { exact: true })).toBeVisible();
  const bulk = await call(page, "subagent_collect");
  expect(textOf(bulk)).toContain("Reconciled 3 of 4 terminal children");
  expect(textOf(bulk)).toContain("Bounded before reading 1 more; they stay uncollected");
  const remainder = bulk.details!["remaining"] as string[];
  expect(remainder).toHaveLength(1);
  await expect(rows(page)).toHaveCount(1);
  expect(textOf(await call(page, "subagent_status", { executionId: remainder[0] }))).toContain("[success, uncollected]");
  expect(textOf(await call(page, "subagent_collect", { executionId: remainder[0] }))).toContain("Completion receipt:");
  await expect(rows(page)).toHaveCount(0);
  expect(textOf(await call(page, "subagent_collect"))).toContain("Nothing terminal to reconcile");
  for (const script of scripts) expect(await requests(script)).toHaveLength(1);
});
