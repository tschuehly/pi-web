// Run: PI_WEB_E2E_FLEET=1 PI_WEB_E2E_DURABLE_HOST=<chat-host-main.ts> PI_WEB_E2E_PI_PACKAGES=<packages> PILOT_CONTEXT_TOKEN=<fakeSecret below> npx playwright test e2e/durable/context-tools/
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";
import { MOCK_CLAUDE_MODEL } from "../../mockModels/agentConfig";
import { mockModels } from "../../mockModels/client";
import type { SessionStatus } from "../../../src/shared/apiTypes";

export const mock = mockModels();
export const fakeSecret = "fleetContextSecret-6d8a39e2b4f107c5";
export const project = () => process.env["PI_WEB_E2E_PROJECT_DIR"]!;
export const root = () => dirname(project());
export const api = () => process.env["PI_WEB_E2E_BASE_URL"]!;
export const chat = (page: Page) => page.locator("chat-view");
export const editor = (page: Page) => page.locator("prompt-editor .cm-content");
export type Message = { role?: string; source?: string; customType?: string; content?: unknown; toolName?: string; isError?: boolean; details?: unknown };
const opened = new Set<string>();

export const test = base.extend<{ fleet: void }>({
  fleet: [async ({ page }, use, info) => {
    await mock.reset();
    await settings({ compaction: { enabled: true, keepRecentTokens: 1 }, defaultProjectTrust: "always" });
    await use();
    const journalPath = info.outputPath("mock-journal.json");
    await writeFile(journalPath, JSON.stringify(await mock.journal(), null, 2));
    await info.attach("mock-journal", { path: journalPath, contentType: "application/json" });
    for (const id of opened) {
      for (const route of ["status", "transcript-snapshot"]) {
        const response = await page.request.get(url(id, route));
        const evidence = info.outputPath(`${id}-${route}.json`);
        await writeFile(evidence, await response.body());
        await info.attach(`${id}-${route}`, { path: evidence, contentType: "application/json" });
      }
      await page.request.post(url(id, "stop"), { data: { cwd: project() } });
    }
    opened.clear();
  }, { auto: true }],
});

export async function settings(patch: Record<string, unknown>): Promise<void> {
  const path = join(root(), "agent", "settings.json");
  const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...current, ...patch }));
}
export const url = (id: string, route: string) => `${api()}api/sessions/${encodeURIComponent(id)}/${route}?${new URLSearchParams({ cwd: project() })}`;
export async function status(page: Page, id: string): Promise<SessionStatus> {
  const response = await page.request.get(url(id, "status"));
  expect(response.ok()).toBe(true);
  return await response.json() as SessionStatus;
}
export async function messages(page: Page, id: string): Promise<Message[]> {
  const response = await page.request.get(url(id, "messages"));
  expect(response.ok()).toBe(true);
  const value = await response.json() as Message[] | { messages: Message[] };
  return Array.isArray(value) ? value : value.messages;
}
export async function command(page: Page, id: string, text: string): Promise<void> {
  const response = await page.request.post(url(id, "commands/run"), { data: { cwd: project(), text } });
  expect(response.ok(), await response.text()).toBe(true);
}
export async function send(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: /^(Send message|Queue follow-up|Queue message)$/ }).click();
}
export async function idle(page: Page, id: string): Promise<void> {
  await expect.poll(async () => {
    const s = await status(page, id);
    return s.isStreaming || s.isCompacting;
  }).toBe(false);
}
export async function chooseModel(page: Page, model: { provider: string; id: string } = MOCK_CLAUDE_MODEL): Promise<void> {
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(`${model.provider}/${model.id}`);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: model.id, exact: true }).first().click();
  await expect(page.getByRole("button", { name: new RegExp(`^Model: ${model.provider}/${model.id}`) })).toBeVisible();
}
export async function createChat(page: Page, durable = true): Promise<string> {
  await page.goto(`${api()}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: process.env["PI_WEB_E2E_WORKSPACE_ID"]! })}`);
  await page.getByRole("button", { name: durable ? "New Durable Chat" : "New Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const id = new URL(page.url()).searchParams.get("session")!;
  opened.add(id);
  await page.goto(`${api()}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: process.env["PI_WEB_E2E_WORKSPACE_ID"]!, session: id, view: "chat" })}`);
  await chooseModel(page);
  return id;
}
export async function answer(page: Page, id: string, prompt: string, result: string): Promise<void> {
  await send(page, prompt);
  await expect(chat(page).getByText(result, { exact: true }).first()).toBeVisible();
  await idle(page, id);
}
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v: { text?: string }) => v.text ?? "").join("\n");
  return JSON.stringify(value);
}
export async function rendered(page: Page): Promise<string> {
  return chat(page).first().evaluate((root) => {
    const walk = (node: Node): string => node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : [...(node instanceof Element && node.shadowRoot ? node.shadowRoot.childNodes : []), ...node.childNodes].map(walk).join(" ");
    return walk(root);
  });
}
/** Every kill is scoped by BOTH this harness's workspace and this Chat's UUID; never pgrep a shared host path. */
export async function killHost(page: Page, id: string): Promise<void> {
  const hosts = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")
    .filter((line) => line.includes(`--session-id ${id}`) && line.includes(`--cwd ${project()}`) && line.includes(`--store ${root()}/data/durable/`));
  expect(hosts).toHaveLength(1);
  const pid = Number(hosts[0]!.trim().split(/\s/)[0]);
  process.kill(pid, "SIGKILL");
  // Observe exit before requesting the replacement; the concurrent kill/status IPC crash is reported separately.
  await expect.poll(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }).toBe(true);
  await expect.poll(async () => (await page.request.get(url(id, "status"))).ok()).toBe(true);
  await page.reload();
  await expect(editor(page)).toBeVisible();
}
export async function storeLeaks(id: string): Promise<string[]> {
  const dir = join(root(), "data", "durable", id);
  const leaks: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const file of await readdir(path, { withFileTypes: true })) {
      const child = join(path, file.name);
      if (file.isDirectory()) await visit(child);
      else if (file.isFile()) {
        const bytes = await readFile(child);
        if ([fakeSecret, fakeSecret.slice(0, 18), fakeSecret.slice(18)].some((part) => bytes.includes(part))) leaks.push(child.slice(dir.length + 1));
      }
    }
  };
  await visit(dir);
  return leaks;
}
export async function fixture(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
export async function journalCount(marker: string, expected: number): Promise<void> {
  const entries = await mock.journal({ kind: "chat", contains: marker });
  expect(entries).toHaveLength(expected);
  for (const entry of entries) {
    expect(entry.violations).toEqual([]);
    expect(entry.path).toMatch(/^\/(v1\/messages|codex\/responses)$/);
    expect(entry.answeredBy).not.toBe("echo");
  }
}
export async function expandTools(page: Page): Promise<void> {
  // Activity folds by their class: the summary's text now starts with its disclosure chevron.
  const groups = chat(page).locator("details.activity-group:not([open]) > summary");
  while (await groups.count()) await groups.first().click();
  const details = chat(page).locator("tool-execution-view details:not([open]) > summary");
  while (await details.count()) await details.first().click();
}
export { expect };
