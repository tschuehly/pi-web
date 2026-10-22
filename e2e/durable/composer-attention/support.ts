import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";
import { MOCK_CLAUDE_MODEL } from "../../mockModels/agentConfig";
import { mockModels } from "../../mockModels/client";
import type { SessionStatus, PendingAskUser, SessionAttentionRequest } from "../../../src/shared/apiTypes";

export { expect, test };
export const mock = mockModels();
export const base = () => process.env["PI_WEB_E2E_BASE_URL"]!;
export const project = () => process.env["PI_WEB_E2E_PROJECT_DIR"]!;
export const root = () => dirname(project());
export const tile = (page: Page) => page.locator(`section.tile[data-session="${id(page)}"]`);
export const editor = (page: Page) => tile(page).locator("prompt-editor .cm-content");
export const chat = (page: Page) => tile(page).locator("chat-view");
export const id = (page: Page) => new URL(page.url()).searchParams.get("session")!;
export const url = (session?: string) => `${base()}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: process.env["PI_WEB_E2E_WORKSPACE_ID"]!, ...(session === undefined ? {} : { session, view: "chat" }) })}`;
export const endpoint = (session: string, path: string) => `${base()}api/sessions/${encodeURIComponent(session)}/${path}`;
export const query = (extra: Record<string, string> = {}) => new URLSearchParams({ cwd: project(), ...extra }).toString();
export const get = (page: Page, session: string, path: string, extra: Record<string, string> = {}) => page.request.get(`${endpoint(session, path)}?${query(extra)}`);
export const post = (page: Page, session: string, path: string, data: object = {}) => page.request.post(endpoint(session, path), { data: { cwd: project(), ...data } });
export const status = async (page: Page, session = id(page)): Promise<SessionStatus> => (await get(page, session, "status")).json();
export const asks = async (page: Page, session = id(page)): Promise<{ pendingAsks: PendingAskUser[]; attentionRequest?: SessionAttentionRequest }> => (await get(page, session, "asks")).json();
export const messages = async (page: Page, session = id(page)): Promise<{ messages: { role: string; content: unknown }[]; start: number; total: number }> => (await get(page, session, "messages")).json();

export async function chooseModel(page: Page, model: { provider: string; id: string } = MOCK_CLAUDE_MODEL): Promise<void> {
  await tile(page).getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(model.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: model.id, exact: true }).first().click();
  await expect(tile(page).getByRole("button", { name: new RegExp(`^Model: ${model.provider}/${model.id}`) })).toBeVisible();
}
export async function create(page: Page, runtime: "durable" | "legacy" = "durable"): Promise<string> {
  await page.goto(url());
  await page.getByRole("button", { name: runtime === "durable" ? "New Durable Chat" : "New Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  if (runtime === "durable") await chooseModel(page);
  return id(page);
}
export async function fill(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.insertText(text);
}
export async function send(page: Page, text: string, button = "Send message"): Promise<void> {
  await fill(page, text);
  await tile(page).getByRole("button", { name: button, exact: true }).click();
}
export async function idle(page: Page, session = id(page)): Promise<void> {
  await expect.poll(async () => (await status(page, session)).isStreaming).toBe(false);
}
export async function answer(page: Page, text: string): Promise<void> {
  await expect(chat(page).getByText(text, { exact: true }).first()).toBeVisible();
  await idle(page);
}
export async function killHost(page: Page, session = id(page)): Promise<void> {
  const store = join(root(), "data", "durable", session);
  const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  const owned = lines.filter((line) => line.includes("chat-host-main.ts") && line.includes(`--store ${store} `) && line.includes(`--session-id ${session}`));
  expect(owned, `one host owned by ${store}`).toHaveLength(1);
  const pid = Number(owned[0]!.trim().split(/\s+/)[0]);
  process.kill(pid, "SIGKILL");
  await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
  await expect.poll(async () => (await get(page, session, "status")).ok()).toBe(true);
}
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
export const PNG_BLUE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC", "base64");
export const image = (name = "first.png", reference = "[PIC_1]") => ({ kind: "image", mimeType: "image/png", data: PNG.toString("base64"), name, reference });
export const ASK = { context: "Choose the deployment target.", questions: [
  { id: "target", question: "Which target?", options: [{ value: "prod", label: "Production" }, { value: "stage", label: "Staging" }] },
  { id: "checks", question: "Which checks?", options: [{ value: "unit", label: "Unit tests" }] },
] };
export async function scriptAsk(marker: string, extra = {}): Promise<void> {
  await mock.script({ match: marker, turns: [[{ toolCall: { name: "ask_user", args: { ...ASK, ...extra } } }], "Question posted."] });
}
export async function fixtureFile(relative: string, content: string | Buffer): Promise<void> {
  const path = join(root(), relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
export async function installResources(): Promise<void> {
  await fixtureFile("agent/skills/fleet-check/SKILL.md", "---\nname: fleet-check\ndescription: Fleet skill fixture\n---\nFLEET_SKILL_BODY. Read references/detail.md.\n");
  await fixtureFile("agent/skills/fleet-check/references/detail.md", "Fixture detail.\n");
  for (const name of ["execute-plan-afk", "execute-plan-attended"]) await fixtureFile(`agent/prompts/${name}.md`, `---\ndescription: Fleet ${name}\nargument-hint: <plan>\n---\nFLEET_TEMPLATE_${name}: $ARGUMENTS\n`);
}
export function setup(): void {
  test.setTimeout(45_000);
  test.beforeAll(installResources);
  test.beforeEach(async () => { await mock.reset(); });
  test.afterEach(async ({ page }, info) => {
    const journal = await mock.journal();
    await info.attach("mock-journal", { body: JSON.stringify(journal, null, 2), contentType: "application/json" });
    expect(journal.flatMap((entry) => entry.violations)).toEqual([]);
    if (info.status !== info.expectedStatus) {
      const session = new URL(page.url()).searchParams.get("session");
      if (session !== null) {
        await info.attach("status", { body: JSON.stringify(await status(page, session)), contentType: "application/json" });
        await info.attach("transcript", { body: JSON.stringify(await messages(page, session)), contentType: "application/json" });
        await info.attach("transcript-snapshot", { body: await (await get(page, session, "transcript-snapshot")).text(), contentType: "application/json" });
        const log = await readFile(join(root(), "data", "durable", session, "host.log"), "utf8").catch(() => "");
        await info.attach("host-log", { body: log, contentType: "text/plain" });
      }
    }
    // Stop only this harness's hosts, including held model requests, before the next mock reset.
    const records = JSON.parse(await readFile(join(root(), "data/session-runtimes.json"), "utf8").catch(() => '{"chats":{}}')) as { chats: Record<string, { cwd: string }> };
    await Promise.all(Object.entries(records.chats).map(([session, record]) => post(page, session, "stop", { cwd: record.cwd })));
  });
}
