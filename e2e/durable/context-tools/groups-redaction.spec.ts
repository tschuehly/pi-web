/** AC-P102 AC-P087 and assignment's P072 child grep/find/ls lens. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, mock, createChat, answer, send, messages, project, root, fixture, killHost, chat, command, status, fakeSecret, storeLeaks, expandTools, idle, rendered } from "./support";
test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });
test.setTimeout(60_000);
const additions = (body: unknown) => ((body as { messages?: { role: string; content?: unknown }[] }).messages ?? []).filter((m) => m.role === "system").flatMap((m) => Array.isArray(m.content) ? m.content as { type: string; tool?: { definition?: { name: string } } }[] : []).filter((b) => b.type === "tool_addition").flatMap((b) => b.tool?.definition?.name ?? []);
const names = (body: unknown) => [...((body as { tools?: { name?: string }[] }).tools ?? []).flatMap((t) => t.name ?? []), ...additions(body)];

for (const [group, tool] of [["workers", "worker_create"], ["atelier", "atelier"], ["monitor", "monitor"]] as const) {
  test(`AC-P102 ${group} exposure survives reload, host kill and compaction`, async ({ page }) => {
    await mock.script({ turns: [[{ toolCall: { name: "tools_enable", args: { group } } }], "Group enabled.", "After group restart.", "GROUP_SUMMARY", "After group compact."] });
    const id = await createChat(page);
    await answer(page, id, `enable ${group}`, "Group enabled.");
    let requests = await mock.journal({ kind: "chat" });
    expect.soft(names(requests[0]?.body).some((n) => n === tool || n.endsWith(`__${tool}`))).toBe(false);
    expect.soft(names(requests[1]?.body).some((n) => n === tool || n.endsWith(`__${tool}`))).toBe(true);
    expect.soft(additions(requests[1]?.body).every((name) => name.startsWith("mcp__")), "Claude inline additions must use the same aliases as initial tools").toBe(true);
    await page.reload();
    await killHost(page, id);
    await answer(page, id, "group after restart", "After group restart.");
    await command(page, id, "/compact keep enabled groups");
    await expect.poll(async () => (await messages(page, id)).filter((m) => m.source === "compaction").length).toBe(1);
    await answer(page, id, "group after compact", "After group compact.");
    requests = await mock.journal({ kind: "chat" });
    for (const i of [2, 4]) expect.soft(names(requests[i]?.body).some((n) => n === tool || n.endsWith(`__${tool}`))).toBe(true);
    expect((await messages(page, id)).filter((m) => m.role === "toolResult").map((m) => m.toolName)).toEqual(["tools_enable"]);
    expect(requests).toHaveLength(5);
  });
}

test("AC-P102 invalid group is rejected and Workers mode exposes only the worker group", async ({ page }) => {
  await mock.script({ turns: [[{ toolCall: { name: "tools_enable", args: { group: "nonexistent" } } }], "Invalid group checked.", "Workers mode checked."] });
  const id = await createChat(page);
  await answer(page, id, "invalid tool group", "Invalid group checked.");
  expect((await messages(page, id)).find((m) => m.toolName === "tools_enable")?.isError).toBe(true);
  await command(page, id, "/mode orchestration workers");
  await answer(page, id, "workers tools", "Workers mode checked.");
  const exposed = names((await mock.journal({ kind: "chat" }))[2]?.body);
  expect(exposed.some((n) => n.endsWith("worker_create"))).toBe(true);
  expect(exposed.some((n) => n.endsWith("__atelier"))).toBe(false);
});

test("P072 AC-P102 child grep/find/ls work and tools_enable cannot widen its allowlist", async ({ page }) => {
  test.setTimeout(90_000);
  await writeFile(process.env["PI_WEB_E2E_QUOTA_CACHE"]!, JSON.stringify({ version: 1, checkedAt: Date.now(), status: 0, stdout: JSON.stringify({ providers: [] }), stderr: "" }));
  await fixture(join(project(), "child-search.txt"), "child-search-needle\n");
  await mock.script({ provider: "anthropic", turns: [[{ toolCall: { name: "subagent", args: { name: "Search child", task: "CHILD_SEARCH_MARKER inspect files and try enabling workers", profile: "scout", cognitiveRole: "routine", background: true } } }], "Child started.", [{ toolCall: { name: "subagent_collect", args: {} } }], "Child collected."] });
  await mock.script({ provider: "openai-codex", match: "CHILD_SEARCH_MARKER", turns: [
    [{ toolCall: { name: "grep", args: { pattern: "child-search-needle", path: "child-search.txt" } } }],
    [{ toolCall: { name: "find", args: { pattern: "child-search.txt" } } }],
    [{ toolCall: { name: "ls", args: { path: "." } } }],
    [{ toolCall: { name: "tools_enable", args: { group: "workers" } } }], "Child search complete.",
  ] });
  const id = await createChat(page);
  await send(page, "launch search child");
  await expect(chat(page).getByText("Child collected.", { exact: true })).toBeVisible({ timeout: 40_000 });
  const requests = (await mock.journal({ provider: "openai-codex", kind: "chat" })).filter((e) => e.transport === "http");
  expect(requests).toHaveLength(5);
  expect(requests[1]?.lastUserText).toContain("child-search-needle");
  expect(requests[2]?.lastUserText).toContain("child-search.txt");
  expect(requests[3]?.lastUserText).toContain("child-search.txt");
  expect(requests[4]?.lastUserText).toMatch(/not.*(allowed|registered|available)|unknown|No workers/i);
  expect(names(requests[4]?.body).some((n) => n.endsWith("worker_create"))).toBe(false);
  for (const request of requests) expect(request.violations).toEqual([]);
  await killHost(page, id);
  expect((await mock.journal({ provider: "openai-codex", kind: "chat" })).filter((e) => e.transport === "http")).toHaveLength(5);
});

test("AC-P087 completed assistant text blocks do not retain synthetic secret fragments", async ({ page }) => {
  expect(process.env["PILOT_CONTEXT_TOKEN"] === fakeSecret).toBe(true);
  await mock.script({ turns: [[{ text: `split secret ${fakeSecret.slice(0, 18)}` }, { text: `${fakeSecret.slice(18)} complete.` }]] });
  const id = await createChat(page);
  await send(page, "split assistant blocks");
  await expect.poll(async () => (await messages(page, id)).filter((m) => m.role === "assistant").length).toBe(1);
  await idle(page, id);
  const body = JSON.stringify(await messages(page, id));
  expect.soft(body.includes(fakeSecret.slice(0, 18)), "Persisted assistant prefix must be redacted").toBe(false);
  expect.soft(body.includes(fakeSecret.slice(18)), "Persisted assistant suffix must be redacted").toBe(false);
  expect.soft(await storeLeaks(id)).toEqual([]);
  await killHost(page, id);
  expect(await storeLeaks(id)).toEqual([]);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(1);
});

test("AC-P087 env secret is redacted in core output, split model text, summary and store after kill", async ({ page }) => {
  expect(process.env["PILOT_CONTEXT_TOKEN"] === fakeSecret, "Run with PILOT_CONTEXT_TOKEN set to the fixture value in support.ts").toBe(true);
  await fixture(join(project(), "secret-fixture.txt"), `fixture-token=${fakeSecret}\n`);
  await mock.script({ turns: [
    [{ toolCall: { name: "read", args: { path: "secret-fixture.txt" } } }],
    [{ toolCall: { name: "bash", args: { command: "printf '%s\\n' \"$PILOT_CONTEXT_TOKEN\"", description: "Print synthetic token", foreground: true } } }],
    [{ text: `Complete synthetic token ${fakeSecret} complete.` }],
    "Pre-compaction turn.", `Summary token ${fakeSecret} retained.`, "Post-redaction turn.",
    [{ text: `interrupted ${fakeSecret.slice(0, 18)}` }, { barrier: "redaction-partial" }, { text: `${fakeSecret.slice(18)} end.` }],
  ] });
  const id = await createChat(page);
  await send(page, "redaction tools");
  await expect.poll(async () => (await messages(page, id)).filter((m) => m.role === "toolResult").length).toBe(2);
  await idle(page, id);
  const results = (await messages(page, id)).filter((m) => m.role === "toolResult");
  expect(JSON.stringify(results)).not.toContain(fakeSecret);
  expect(JSON.stringify(results)).toContain("REDACTED");
  await expandTools(page);
  await expect(chat(page).getByText(/REDACTED/).first()).toBeVisible();
  expect(await storeLeaks(id)).toEqual([]);
  await answer(page, id, "prepare summary", "Pre-compaction turn.");
  await command(page, id, "/compact Keep redaction proof");
  await expect.poll(async () => (await messages(page, id)).filter((m) => m.source === "compaction").length).toBe(1);
  expect(JSON.stringify(await messages(page, id))).not.toContain(fakeSecret);
  expect(await storeLeaks(id)).toEqual([]);
  await answer(page, id, "post redaction", "Post-redaction turn.");
  expect(JSON.stringify((await mock.journal({ kind: "chat" }))[5]?.body)).not.toContain(fakeSecret);
  await send(page, "split streaming kill");
  await mock.waitForBarrier("redaction-partial");
  expect.soft(await rendered(page)).not.toContain(fakeSecret.slice(0, 18));
  expect.soft(await storeLeaks(id)).toEqual([]);
  await killHost(page, id);
  expect(JSON.stringify(await messages(page, id))).not.toContain(fakeSecret);
  expect(await storeLeaks(id)).toEqual([]);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(7);
  await mock.release("redaction-partial");
  expect((await status(page, id)).warnings?.length).toBeGreaterThan(0);
});
