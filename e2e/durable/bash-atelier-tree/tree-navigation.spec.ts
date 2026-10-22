// AC-P044 / AC-P046. Extends the original /tree + Edit & resend flow with mock-only models,
// real SIGKILL, stale revision, as-of questions/Working Mode and pending-delivery boundaries.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { api, chat, completions, deliveries, editor, fixture, idle, killHost, mock, navigate, newChat, reopen, send, sessionId, setup, status, text, tool, tree } from "./fleet";
import { comment, openAtelier } from "./atelier-fixture";
setup();

for (const legacy of [false, true]) {
  test(`AC-P044 AC-P046 ${legacy ? "legacy" : "Durable"}: /tree and Edit & resend continue without erasing branches`, async ({ page }) => {
    await newChat(page, legacy);
    const marker = `tree-${Date.now()}`;
    await mock.script({ match: marker, turns: ["alpha answer", "beta answer", "gamma answer"] });
    await send(page, `${marker} alpha`);
    await expect(chat(page).getByText("alpha answer", { exact: true })).toBeVisible();
    await send(page, "beta");
    await expect(chat(page).getByText("beta answer", { exact: true })).toBeVisible();
    await idle(page);
    const id = sessionId(page);
    const nav = page.locator("session-tree-navigator");
    const row = (summary: string) => nav.getByRole("treeitem").filter({ has: page.locator(".summary", { hasText: new RegExp(`^${summary}$`) }) });
    await send(page, "/tree");
    await expect(nav.getByRole("tree")).toBeVisible();
    await row("beta").click();
    await nav.getByRole("button", { name: "Next" }).click();
    await nav.getByRole("button", { name: "Continue from here" }).click();
    await expect(nav).toHaveCount(0);
    await expect(editor(page)).toHaveText("beta");
    await expect(chat(page).getByText("beta answer", { exact: true })).toHaveCount(0);
    await expect(chat(page).getByText("alpha answer", { exact: true })).toBeVisible();
    await send(page, "gamma");
    await expect(chat(page).getByText("gamma answer", { exact: true })).toBeVisible();
    await idle(page);
    if (!legacy) await killHost(page);
    else expect((await api(page, "stop", {})).ok()).toBe(true);
    await reopen(page);
    await expect(chat(page).getByText("gamma answer", { exact: true })).toBeVisible();
    expect(sessionId(page)).toBe(id);
    await expect(chat(page).getByText("beta answer", { exact: true })).toHaveCount(0);
    const earlier = chat(page).locator("details").filter({ hasText: "Earlier conversation" });
    if (await earlier.count() > 0 && !await earlier.first().evaluate((element) => (element as HTMLDetailsElement).open)) await earlier.first().locator("summary").first().click();
    const first = chat(page).locator("article").filter({ has: page.getByText(`${marker} alpha`, { exact: true }) });
    await first.getByRole("button", { name: "Message actions" }).click();
    await first.getByRole("button", { name: "Edit and resend" }).click();
    await expect(editor(page)).toHaveText(`${marker} alpha`);
    await expect(chat(page).getByText("alpha answer", { exact: true })).toHaveCount(0);
    await send(page, "/tree");
    for (const value of [`${marker} alpha`, "alpha answer", "beta", "beta answer", "gamma", "gamma answer"]) await expect(row(value)).toHaveCount(1);
    await nav.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await mock.journal({ kind: "chat" })).toHaveLength(3);
  });
}

test("AC-P044 stale expectedLeafId refuses navigation without changing the active branch [negative-control]", async ({ page }) => {
  await newChat(page);
  await send(page, "stale-one");
  await expect(chat(page).getByText("echo: stale-one", { exact: true })).toBeVisible();
  await idle(page);
  const old = await tree(page);
  expect(old.type).toBe("tree");
  await send(page, "stale-two");
  await expect(chat(page).getByText("echo: stale-two", { exact: true })).toBeVisible();
  await idle(page);
  const current = await tree(page);
  // The optional faulty host IPC proxy replaces stale revisions with this leaf, disabling the protection.
  await writeFile(join(fixture().root, "data", "durable", sessionId(page), "fleet-current-leaf"), JSON.stringify(current.activeLeafId));
  const response = await navigate(page, old, old.nodes[0]!.id);
  expect(response.ok(), "stale expectedLeafId must not be accepted").toBe(false);
  expect(await response.text()).toMatch(/changed since|stale/i);
  expect((await tree(page)).activeLeafId).toBe(current.activeLeafId);
});

test("AC-P044 questions and Working Mode restore as-of branch and survive SIGKILL", async ({ page }) => {
  await newChat(page);
  await send(page, "/mode attention focused");
  await tool(page, "ask_user", { context: "Branch-specific target", questions: [{ id: "target", question: "Which target?", options: [{ value: "a", label: "Target A" }, { value: "b", label: "Target B" }] }] });
  const before = await status(page);
  expect(before.pendingAsks).toHaveLength(1);
  const atQuestion = await tree(page);
  const question = atQuestion.nodes.find((node) => node.kind === "tool-result" && node.summary.startsWith("Tool result (ask_user)"))!;
  await send(page, "/mode attention afk");
  expect((await tool(page, "ask_user", { withdraw: before.pendingAsks![0]!.askId })).isError).not.toBe(true);
  await send(page, "later-branch");
  await expect(chat(page).getByText("echo: later-branch", { exact: true })).toBeVisible();
  await idle(page);
  const later = await tree(page);
  expect((await status(page)).pendingAsks ?? []).toHaveLength(0);
  expect((await navigate(page, later, question.id)).ok()).toBe(true);
  await reopen(page);
  expect((await status(page)).pendingAsks?.map((ask) => ask.askId)).toEqual(before.pendingAsks!.map((ask) => ask.askId));
  expect(JSON.parse((await status(page)).extensionStatuses!["working-mode"]!).selected.attention).toBe("Focused");
  await expect(page.locator("workbench-question-chips").getByTitle("Which target?", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Working Mode.*Attention: Focused/ })).toBeVisible();
  await killHost(page);
  await reopen(page);
  expect((await status(page)).pendingAsks).toHaveLength(1);
  expect((await navigate(page, await tree(page), later.activeLeafId!)).ok()).toBe(true);
  expect((await status(page)).pendingAsks ?? []).toHaveLength(0);
  expect(JSON.parse((await status(page)).extensionStatuses!["working-mode"]!).selected.attention).toBe("AFK");
  await expect(page.locator("workbench-question-chips").getByTitle("Which target?", { exact: true })).toHaveCount(0);
});

test("AC-P044 running bash and open Atelier Page carry to the new branch; pending completion blocks navigation", async ({ page, context }) => {
  await newChat(page);
  await send(page, "carry-anchor");
  await expect(chat(page).getByText("echo: carry-anchor", { exact: true })).toBeVisible();
  await idle(page);
  const anchor = (await tree(page)).activeLeafId!;
  const { tab, file } = await openAtelier(page, context);
  const marker = join(fixture().project, `carried-${Date.now()}`);
  await tool(page, "bash", { description: "Carried background job", command: `while [ ! -e '${marker}' ]; do sleep .05; done; echo carried-output` });
  const old = await tree(page);
  expect((await navigate(page, old, anchor)).ok()).toBe(true); // live job alone does not block (legacy behavior)
  await reopen(page);
  await comment(tab, file, "Carried comment");
  await expect.poll(async () => (await deliveries(page)).length, { timeout: 10_000 }).toBe(1);
  await idle(page);
  const now = await tree(page);
  await mock.script({ match: "Background bash", turns: [[{ text: "Completion starts" }, { barrier: "completion-pending" }, { text: " and ends" }]] });
  await writeFile(marker, "go");
  await mock.waitForBarrier("completion-pending");
  const blocked = await navigate(page, now, anchor);
  expect(blocked.ok()).toBe(false);
  expect(await blocked.text()).toMatch(/activity|active|pending/i);
  await mock.release("completion-pending");
  await idle(page);
  expect(await completions(page)).toHaveLength(1);
  expect(text((await completions(page))[0]!.content)).toContain("carried-output");
  expect(text((await deliveries(page))[0]!.content)).toContain("Carried comment");
  expect((await tool(page, "bash_status", {})).details?.jobs?.[0]?.state).toBe("complete");
});

test("AC-P044 AC-P046 active generation disables Edit & resend and refuses queued navigation", async ({ page }) => {
  await newChat(page);
  await send(page, "busy-anchor");
  await expect(chat(page).getByText("echo: busy-anchor", { exact: true })).toBeVisible();
  await idle(page);
  const old = await tree(page);
  await mock.script({ match: "busy-tree-turn", turns: [[{ text: "Still working" }, { barrier: "busy-tree" }, { text: " finished" }]] });
  await send(page, "busy-tree-turn");
  await mock.waitForBarrier("busy-tree");
  const article = chat(page).locator("article").filter({ has: page.getByText("busy-anchor", { exact: true }) });
  await article.getByRole("button", { name: "Message actions" }).click();
  await expect(article.getByRole("button", { name: "Edit and resend" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await editor(page).click();
  await page.keyboard.insertText("queued navigation input");
  await page.getByRole("button", { name: "Queue follow-up", exact: true }).click();
  const blocked = await navigate(page, old, old.nodes[0]!.id);
  expect(blocked.ok()).toBe(false);
  expect(await blocked.text()).toMatch(/activity|pending|active/i);
  await mock.release("busy-tree");
  await idle(page);
});

test("AC-P044 navigation refuses an active child and its pending delivery", async ({ page }) => {
  const quota = process.env["PI_WEB_E2E_QUOTA_CACHE"]!;
  await writeFile(quota, JSON.stringify({ version: 1, checkedAt: Date.now(), status: 0, stdout: JSON.stringify({ providers: [] }), stderr: "" }));
  await newChat(page);
  await send(page, "child-anchor");
  await expect(chat(page).getByText("echo: child-anchor", { exact: true })).toBeVisible();
  await idle(page);
  const old = await tree(page);
  const marker = `child-tree-${Date.now()}`;
  await mock.script({ provider: "openai-codex", match: marker, turns: [[{ text: "Child working" }, { barrier: marker }, { text: "Child finished" }]] });
  const launched = await tool(page, "subagent", { name: "Tree guard", task: marker, profile: "scout", cognitiveRole: "routine", background: true });
  expect(launched.isError, text(launched.content)).not.toBe(true);
  await mock.waitForBarrier(marker);
  const active = await navigate(page, old, old.nodes[0]!.id);
  expect(active.ok()).toBe(false);
  expect(await active.text()).toMatch(/activity|children|pending/i);
  await mock.script({ provider: "anthropic", match: "Background children finished", turns: [[{ text: "Child delivery" }, { barrier: "child-delivery" }, { text: " processed" }]] });
  await mock.release(marker);
  await mock.waitForBarrier("child-delivery");
  const delivery = await navigate(page, old, old.nodes[0]!.id);
  expect(delivery.ok()).toBe(false);
  expect(await delivery.text()).toMatch(/activity|children|pending/i);
  await mock.release("child-delivery");
  await idle(page);
});
