/** AC-P016 AC-P019 AC-P020 AC-P022 AC-P023 AC-P103 AC-P104 AC-P105 AC-P106. Model scope/cycle/defaults P017/P018/P021 are deferred. */
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MOCK_CODEX_MODEL } from "../../mockModels/agentConfig";
import { test, expect, mock, createChat, chooseModel, answer, send, status, url, project, killHost, command, messages, chat, idle, root } from "./support";

test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });
test.setTimeout(60_000);
test.afterEach(async () => { await rm(join(root(), "durable-agent", "models-store.json"), { force: true }); });

for (const durable of [false, true]) {
  test(`AC-P016 AC-P019 models and thinking route to matching mock (${durable ? "Durable" : "legacy"})`, async ({ page }) => {
    await mock.script({ provider: "anthropic", turns: ["Claude selected."] });
    await mock.script({ provider: "openai-codex", turns: ["Codex selected.", "Codex restored."] });
    const id = await createChat(page, durable);
    await answer(page, id, "provider first", "Claude selected.");
    await chooseModel(page, MOCK_CODEX_MODEL);
    await page.getByRole("button", { name: /^Model: / }).click();
    await page.getByRole("radiogroup", { name: "Thinking" }).getByRole("radio", { name: "high", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await status(page, id)).thinkingLevel).toBe("high");
    const rejected = await page.request.post(url(id, "thinking-level"), { data: { cwd: project(), level: "imaginary" } });
    expect(rejected.ok()).toBe(false);
    expect((await status(page, id)).thinkingLevel).toBe("high");
    await answer(page, id, "provider second", "Codex selected.");
    if (durable) await killHost(page, id); else await page.reload();
    expect((await status(page, id)).thinkingLevel).toBe("high");
    await answer(page, id, "provider restored", "Codex restored.");
    const allRequests = await mock.journal({ kind: "chat" });
    expect(allRequests.filter((e) => e.transport === "websocket").every((e) => e.status === 501)).toBe(true);
    const journal = allRequests.filter((e) => e.transport === "http");
    expect(journal.map((e) => e.provider)).toEqual(["anthropic", "openai-codex", "openai-codex"]);
    expect(journal.map((e) => e.violations)).toEqual([[], [], []]);
    expect((journal[1]?.body as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
    expect((journal[2]?.body as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
  });
}

test("AC-P020 cycles supported thinking levels and wraps", async ({ page }) => {
  await writeFile(join(root(), "durable-agent", "models-store.json"), JSON.stringify({ anthropic: { models: [{ id: "fleet-no-thinking", name: "Fleet non-thinking model", provider: "anthropic", api: "anthropic-messages", baseUrl: process.env["PI_WEB_E2E_MOCK_URL"], reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } }));
  const id = await createChat(page);
  const response = await page.request.get(url(id, "thinking-levels"));
  const value = await response.json() as { levels: string[] } | string[];
  const levels = Array.isArray(value) ? value : value.levels;
  const start = (await status(page, id)).thinkingLevel;
  for (let i = 1; i <= levels.length; i++) {
    const result = await page.request.post(url(id, "thinking-level/cycle"), { data: { cwd: project() } });
    expect(result.ok()).toBe(true);
    expect((await status(page, id)).thinkingLevel).toBe(levels[(levels.indexOf(start!) + i) % levels.length]);
  }
  const catalog = await (await page.request.get(url(id, "models"))).json() as { models: { provider: string; id: string; reasoning?: boolean }[] };
  const plain = catalog.models.find((m) => m.provider === "anthropic" && m.reasoning === false);
  expect(plain, "fixture catalog must include a non-thinking Claude model").toBeDefined();
  await chooseModel(page, plain!);
  const unsupported = await page.request.post(url(id, "thinking-level/cycle"), { data: { cwd: project() } });
  expect(unsupported.ok()).toBe(false);
  expect(await unsupported.text()).toContain("does not support thinking");
  expect(await mock.journal({ kind: "chat" })).toHaveLength(0);
});

for (const durable of [false, true]) {
  test(`AC-P022 exact usage totals and composer context (${durable ? "Durable" : "legacy"})`, async ({ page }) => {
    await mock.script({ turns: [
      { steps: [{ text: "First measured turn." }], usage: { input: 1100, output: 40, cacheRead: 100 } },
      { steps: [{ text: "Second measured turn." }], usage: { input: 2200, output: 60, cacheRead: 200 } },
    ] });
    const id = await createChat(page, durable);
    await chooseModel(page, MOCK_CODEX_MODEL);
    await answer(page, id, "measure first", "First measured turn.");
    await answer(page, id, "measure second", "Second measured turn.");
    const s = await status(page, id);
    expect(s.tokens).toEqual({ input: 3000, output: 100, cacheRead: 300, cacheWrite: 0, total: 3400 });
    expect(s.contextUsage?.tokens).toBe(2260);
    expect(s.contextUsage?.percent).toBeCloseTo(2260 / s.contextUsage!.contextWindow * 100);
    expect(s.cost).toBeGreaterThan(0);
    await expect(page.getByRole("list", { name: "Session usage" })).toContainText("Input tokens: 3000");
    await expect(page.locator('[title^="Context:"]')).toHaveAttribute("title", /2260/);
    if (durable) {
      await killHost(page, id);
      const restored = await status(page, id);
      expect(restored.tokens).toEqual(s.tokens);
      expect(restored.cost).toBe(s.cost);
      expect((await mock.journal({ kind: "chat" })).filter((e) => e.transport === "http")).toHaveLength(2);
    }
  });
}

test("AC-P016 revoked fixture auth parks the recorded model without billing fallback", async ({ page }) => {
  await mock.script({ turns: ["Before auth revocation."] });
  const id = await createChat(page);
  await answer(page, id, "before revoked auth", "Before auth revocation.");
  const auth = join(root(), "durable-agent", "auth.json");
  const original = await readFile(auth); // Only this harness's dummy logins; never owner credentials.
  try {
    await writeFile(auth, "{}");
    await killHost(page, id);
    await send(page, "after revoked auth");
    await expect(chat(page).getByText(/Model response failed: Provider is not configured: anthropic/i).last()).toBeVisible();
    await idle(page, id);
    expect((await status(page, id)).model?.provider).toBe("anthropic");
    expect(await mock.journal({ kind: "chat" })).toHaveLength(1);
  } finally { await writeFile(auth, original); }
});

test("AC-P023 paid cache miss is visible and survives reload", async ({ page }) => {
  await mock.script({ turns: [
    { steps: [{ text: "Warm cache." }], usage: { input: 50100, output: 10, cacheRead: 50000 } },
    { steps: [{ text: "Cache missed." }], usage: { input: 50100, output: 10, cacheRead: 0 } },
  ] });
  const id = await createChat(page);
  await chooseModel(page, MOCK_CODEX_MODEL);
  await answer(page, id, "cache first", "Warm cache.");
  await answer(page, id, "cache second", "Cache missed.");
  await expect.soft(chat(page).getByText(/tokens re-billed/i).first()).toBeVisible();
  await page.reload();
  await expect(chat(page).getByText(/tokens re-billed/i).first()).toBeVisible();
});

test("AC-P103 AC-P104 selected/applied four-axis mode and idempotent /mode send survive host kill", async ({ page }) => {
  await mock.script({ turns: ["Mode delivered.", "Pending mode delivered.", "After mode restart."] });
  const id = await createChat(page);
  for (const arg of ["alignment plan", "attention focused", "checking challenge", "orchestration workers"]) await command(page, id, `/mode ${arg}`);
  const mode = async () => JSON.parse((await status(page, id)).extensionStatuses!["working-mode"]!) as { phase: string; selected: Record<string, string>; applied: unknown };
  expect((await mode()).phase).toBe("selected");
  expect((await mode()).selected).toEqual({ alignment: "Plan", attention: "Focused", checking: "Challenge", orchestration: "Workers" });
  await killHost(page, id);
  await answer(page, id, "apply mode", "Mode delivered.");
  expect((await mode()).phase).toBe("applied");
  const first = (await mock.journal({ kind: "chat" }))[0]!;
  expect(JSON.stringify(first.body)).toContain("<working-mode>");
  expect(JSON.stringify((first.body as { system: unknown }).system)).not.toContain("<working-mode>");
  await command(page, id, "/mode");
  const before = await mode();
  await command(page, id, "/mode attention nonexistent");
  expect(await mode()).toEqual(before);
  await command(page, id, "/mode send");
  expect(await mock.journal({ kind: "chat" })).toHaveLength(1);
  await command(page, id, "/mode attention default");
  await command(page, id, "/mode send");
  await expect(chat(page).getByText("Pending mode delivered.", { exact: true })).toBeVisible();
  await idle(page, id);
  await killHost(page, id);
  await answer(page, id, "after mode restart", "After mode restart.");
  expect((await messages(page, id)).filter((m) => m.customType === "working-mode")).toHaveLength(2);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(3);
});

test("AC-P105 AC-P106 alignment reached and reset restore across host death", async ({ page }) => {
  await mock.script({ turns: [
    [{ toolCall: { name: "alignment_reached", args: { agreement: "Verify only the acceptance specs" } } }], "Alignment reached.",
    [{ toolCall: { name: "alignment_reset", args: { reason: "Acceptance changed" } } }], "Alignment reset.", "Pending alignment restored.",
  ] });
  const id = await createChat(page);
  await command(page, id, "/mode alignment plan");
  await command(page, id, "/mode attention afk");
  const mode = async () => JSON.parse((await status(page, id)).extensionStatuses!["working-mode"]!) as { aligned: boolean };
  await answer(page, id, "record agreement", "Alignment reached.");
  expect((await mode()).aligned).toBe(true);
  await killHost(page, id);
  expect((await mode()).aligned).toBe(true);
  await answer(page, id, "reset agreement", "Alignment reset.");
  expect((await mode()).aligned).toBe(false);
  await killHost(page, id);
  expect((await mode()).aligned).toBe(false);
  await answer(page, id, "alignment follow-up", "Pending alignment restored.");
  expect(JSON.stringify((await mock.journal({ kind: "chat" })).at(-1)?.body)).toContain("AFK has not started");
});
