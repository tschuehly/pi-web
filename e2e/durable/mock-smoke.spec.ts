import { expect, test, type Page } from "@playwright/test";
import { E2E_NOTES_BODY, E2E_PROJECT_ID } from "../isolatedPiWeb";
import { MOCK_CODEX_ACCOUNT, MOCK_CLAUDE_MODEL, MOCK_CODEX_MODEL } from "../mockModels/agentConfig";
import { mockModels, type JournalEntry } from "../mockModels/client";

// Legacy and Durable Chats each answer through the mocked Claude subscription and ChatGPT Codex endpoints
// (e2e/mockModels/README.md): a scripted thinking + tool call, its tool result, and the request journal.
test.skip(process.env["PI_WEB_E2E_MOCK_URL"] === undefined, "the mock model server is off (PI_WEB_E2E_MOCK_MODELS=0)");
const mock = mockModels();
test.beforeEach(async () => { await mock.reset(); });

const editor = (page: Page) => page.locator("prompt-editor .cm-content");
const chat = (page: Page) => page.locator("chat-view");

async function openWorkspace(page: Page): Promise<void> {
  const base = process.env["PI_WEB_E2E_BASE_URL"];
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  if (base === undefined || workspaceId === undefined) throw new Error("Isolated PI WEB was not started");
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: workspaceId }).toString()}`);
}

async function send(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function chooseModel(page: Page, model: { provider: string; id: string }): Promise<void> {
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(model.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: model.id, exact: true }).first().click();
  await expect(page.getByRole("button", { name: new RegExp(`^Model: ${model.provider}/${model.id}`) })).toBeVisible();
}

/** Scripts a Claude turn that thinks, holds at barrier `marker`, reads docs/notes.md, then answers `answer`. */
async function scriptClaudeRead(marker: string, answer: string): Promise<string> {
  return mock.script({ provider: "anthropic", match: marker, turns: [[{ thinking: "The notes file has the answer." }, { barrier: marker }, { toolCall: { name: "read", args: { path: "docs/notes.md" } } }], answer] });
}

/** The held first turn is in flight (journal `pending`) until released. */
async function releaseHeldTurn(marker: string): Promise<void> {
  await mock.waitForBarrier(marker);
  expect((await mock.journal({ kind: "chat", contains: marker })).map((entry) => entry.outcome)).toEqual(["pending"]);
  await mock.release(marker);
}

/** The Claude subscription shape: OAuth bearer, Claude Code betas and identity block, no flat custom tool names. */
function expectClaudeSubscriptionShape(entry: JournalEntry | undefined): void {
  expect(entry?.violations).toEqual([]);
  expect(entry?.auth).toBe("oauth");
  expect(entry?.headers["authorization"]).toBe("[redacted]");
  expect(entry?.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
  const tools = ((entry?.body as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);
  expect(tools).toContain("Read");
}

test("a legacy Chat answers through mocked Claude (with a tool round trip) and Codex", async ({ page }) => {
  const marker = `legacy-smoke-${String(Date.now())}`;
  const script = await scriptClaudeRead(marker, "Claude read the notes.");
  await mock.script({ provider: "openai-codex", match: marker, turns: [[{ thinking: "Short answer." }, { text: "Codex answers too." }]] });

  await openWorkspace(page);
  await page.getByRole("button", { name: "New Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  await expect(page.getByRole("button", { name: new RegExp(`^Model: ${MOCK_CLAUDE_MODEL.provider}/${MOCK_CLAUDE_MODEL.id}`) })).toBeVisible();
  await send(page, `${marker}: what do the notes say?`);
  await releaseHeldTurn(marker);
  await expect(chat(page).getByText("Claude read the notes.").first()).toBeVisible();

  // Journal: the prompt, then the tool result read from the fixture project, both in the subscription shape.
  const claude = await mock.journal({ provider: "anthropic", kind: "chat", contains: marker });
  expect(claude.map((entry) => entry.answeredBy)).toEqual([{ script, turn: 0 }, { script, turn: 1 }]);
  expectClaudeSubscriptionShape(claude[0]);
  expectClaudeSubscriptionShape(claude[1]);
  expect(claude[1]?.lastUserText).toContain(E2E_NOTES_BODY);

  await chooseModel(page, MOCK_CODEX_MODEL);
  await send(page, "And now from Codex?");
  await expect(chat(page).getByText("Codex answers too.").first()).toBeVisible();
  const [codex, ...more] = await mock.journal({ provider: "openai-codex", kind: "chat" });
  expect(more).toEqual([]);
  expect(codex?.violations).toEqual([]);
  expect(codex?.model).toBe(MOCK_CODEX_MODEL.id);
  expect(codex?.auth).toBe("jwt");
  expect(codex?.headers["chatgpt-account-id"]).toBe(MOCK_CODEX_ACCOUNT);
  // The Codex request replays the Claude turn's tool output.
  expect(JSON.stringify(codex?.body)).toContain(E2E_NOTES_BODY);
});

test.describe("Durable Chat", () => {
  // Needs the Workbench Durable host with models.json baseUrl support for anthropic and openai-codex (e2e/mockModels/README.md).
  test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");

  test("a Durable Chat answers through mocked Claude with a tool round trip", async ({ page }) => {
    test.setTimeout(60_000);
    const marker = `durable-smoke-${String(Date.now())}`;
    await scriptClaudeRead(marker, "Durable Claude read the notes.");
    await openWorkspace(page);
    await page.getByRole("button", { name: "New Durable Chat" }).click();
    await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
    await chooseModel(page, MOCK_CLAUDE_MODEL);
    await send(page, `${marker}: what do the notes say?`);
    await releaseHeldTurn(marker);
    await expect(chat(page).getByText("Durable Claude read the notes.").first()).toBeVisible();

    const claude = await mock.journal({ provider: "anthropic", kind: "chat", contains: marker });
    expect(claude).toHaveLength(2);
    expectClaudeSubscriptionShape(claude[0]);
    expectClaudeSubscriptionShape(claude[1]);
    expect(claude[1]?.lastUserText).toContain(E2E_NOTES_BODY);
  });

  test("a Durable Chat answers through mocked Codex with a tool round trip", async ({ page }) => {
    test.setTimeout(60_000);
    const marker = `durable-codex-${String(Date.now())}`;
    const script = await mock.script({ provider: "openai-codex", match: marker, turns: [[{ thinking: "Read the notes." }, { toolCall: { name: "read", args: { path: "docs/notes.md" } } }], "Durable Codex read the notes."] });
    await openWorkspace(page);
    await page.getByRole("button", { name: "New Durable Chat" }).click();
    await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
    await chooseModel(page, MOCK_CODEX_MODEL);
    await send(page, `${marker}: what do the notes say?`);
    await expect(chat(page).getByText("Durable Codex read the notes.").first()).toBeVisible();

    const codex = await mock.journal({ provider: "openai-codex", kind: "chat", contains: marker });
    expect(codex.map((entry) => entry.answeredBy)).toEqual([{ script, turn: 0 }, { script, turn: 1 }]);
    for (const entry of codex) {
      expect(entry.violations).toEqual([]);
      expect(entry.model).toBe(MOCK_CODEX_MODEL.id);
      expect(entry.auth).toBe("jwt");
      expect(entry.headers["chatgpt-account-id"]).toBe(MOCK_CODEX_ACCOUNT);
    }
    expect(codex[1]?.lastUserText).toContain(E2E_NOTES_BODY);
  });
});
