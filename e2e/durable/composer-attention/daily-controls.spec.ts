// Supplemental lens checks: AC-P016 P019 P022 P058 P103 P104 (primary ownership in other fleet areas).
import { MOCK_CODEX_MODEL } from "../../mockModels/agentConfig";
import { test, expect, mock, setup, create, send, answer, status, messages, post, id, chat, killHost, chooseModel } from "./support";
setup();

test("AC-P016 P019: model and effort selections survive SIGKILL and route the next prompt to Codex", async ({ page }) => {
  await create(page);
  await mock.script({ provider: "anthropic", match: "provider-check", turns: ["Claude answer."] });
  await send(page, "provider-check");
  await answer(page, "Claude answer.");
  await chooseModel(page, MOCK_CODEX_MODEL);
  expect((await post(page, id(page), "thinking-level", { level: "high" })).ok()).toBe(true);
  expect((await post(page, id(page), "thinking-level", { level: "not-a-level" })).ok()).toBe(false);
  expect((await status(page)).thinkingLevel).toBe("high");
  await killHost(page);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Model: openai-codex\/gpt-6-luna/ })).toBeVisible();
  expect((await status(page)).thinkingLevel).toBe("high");
  await mock.script({ provider: "openai-codex", match: "provider-check", turns: ["Codex answer."] });
  await send(page, "now Codex");
  await answer(page, "Codex answer.");
  const requests = await mock.journal({ kind: "chat", contains: "provider-check" });
  expect(requests.map((r) => r.provider)).toEqual(["anthropic", "openai-codex"]);
  expect((requests[1]!.body as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
});

test("AC-P022: two known Codex usage completions are counted once and retained after host kill", async ({ page }) => {
  await create(page);
  await chooseModel(page, MOCK_CODEX_MODEL);
  // The Anthropic mock hardcodes input/cache to zero in message_start; Codex emits the scripted usage.
  await mock.script({ provider: "openai-codex", match: "usage-check", turns: [
    { steps: [{ text: "Usage one." }], usage: { input: 1200, output: 40, cacheRead: 100 } },
    { steps: [{ text: "Usage two." }], usage: { input: 1400, output: 60, cacheRead: 200 } },
  ] });
  await send(page, "usage-check");
  await answer(page, "Usage one.");
  await send(page, "again");
  await answer(page, "Usage two.");
  const before = await status(page);
  expect(before.tokens).toMatchObject({ input: 2300, output: 100, cacheRead: 300, cacheWrite: 0 });
  expect(before.cost).toBeGreaterThan(0);
  await expect(page.getByRole("list", { name: "Session usage" })).toContainText("Input tokens: 2300");
  await killHost(page);
  await page.reload();
  expect((await status(page)).tokens).toEqual(before.tokens);
  expect((await status(page)).cost).toBe(before.cost);
  expect(await mock.journal({ kind: "chat", contains: "usage-check" })).toHaveLength(2);
});

test("AC-P058: ! is included in next model context; !! is excluded; host reopen never re-executes shell", async ({ page }) => {
  await create(page);
  await send(page, "!printf shell-included");
  await expect(chat(page).locator("article").filter({ hasText: "$ printf shell-included" })).toContainText("exit 0");
  await expect.poll(async () => (await status(page)).isBashRunning).toBe(false);
  await send(page, "!!printf shell-excluded");
  await expect(chat(page).locator("article").filter({ hasText: "$ printf shell-excluded" })).toContainText("exit 0");
  await expect.poll(async () => (await status(page)).isBashRunning).toBe(false);
  await killHost(page);
  await page.reload();
  await mock.script({ match: "shell-context-check", turns: ["Shell context read."] });
  await send(page, "shell-context-check");
  await answer(page, "Shell context read.");
  const [request] = await mock.journal({ kind: "chat" });
  expect(JSON.stringify(request!.body)).toContain("shell-included");
  expect(JSON.stringify(request!.body)).not.toContain("shell-excluded");
});

test("AC-P103 P104: /mode changes guidance, survives host kill and rides exactly once with next prompt", async ({ page }) => {
  await create(page);
  await send(page, "/mode attention focused");
  const trigger = page.getByRole("button", { name: /^Working Mode — / });
  await expect(trigger).toHaveAttribute("title", /Focused/);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(0);
  await killHost(page);
  await page.reload();
  await expect(trigger).toHaveAttribute("title", /Focused/);
  await mock.script({ match: "mode-check", turns: ["Mode read."] });
  await send(page, "mode-check");
  await answer(page, "Mode read.");
  await expect(chat(page).locator("details.working-mode-card")).toHaveCount(1);
  expect(JSON.stringify((await mock.journal({ kind: "chat" }))[0]!.body)).toContain("Focused");
  expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(1);
});
