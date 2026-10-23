import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";
import { MOCK_CLAUDE_MODEL, MOCK_CODEX_MODEL } from "../../mockModels/agentConfig";
import { mockModels } from "../../mockModels/client";

export const mock = mockModels();
export const env = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}; use fleet.config.ts`); return value; };
export const root = () => env("FLEET_ROOT");
export const chat = (page: Page) => page.locator("chat-view");
export const id = (page: Page) => new URL(page.url()).searchParams.get("session")!;
export const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map((p) => p.text ?? "").join("\n") : "";
export type Message = { role: string; customType?: string; content: unknown; toolName?: string; isError?: boolean; details?: Record<string, unknown> };
export type Status = { isStreaming: boolean; tokens: { total: number }; extensionStatuses?: Record<string, string>; activeToolExecutions?: unknown[]; unresolvedEffects?: { toolName: string }[] };
export async function get<T>(page: Page, endpoint: string): Promise<T> {
  const response = await page.request.get(`${env("PI_WEB_E2E_BASE_URL")}api/sessions/${encodeURIComponent(id(page))}/${endpoint}?${new URLSearchParams({ cwd: env("PI_WEB_E2E_PROJECT_DIR") })}`);
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
export const status = (page: Page) => get<Status>(page, "status");
export const messages = async (page: Page) => (await get<{ messages: Message[] }>(page, "messages")).messages;
export async function command(page: Page, value: string) {
  const response = await page.request.post(`${env("PI_WEB_E2E_BASE_URL")}api/sessions/${encodeURIComponent(id(page))}/commands/run`, { data: { cwd: env("PI_WEB_E2E_PROJECT_DIR"), text: value } });
  return { ok: response.ok(), body: await response.json() as { type?: string; message?: string; error?: string } };
}
export async function choose(page: Page, provider: "anthropic" | "openai-codex", modelId?: string) {
  const model = { ...(provider === "anthropic" ? MOCK_CLAUDE_MODEL : MOCK_CODEX_MODEL), ...(modelId ? { id: modelId } : {}) };
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(model.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: model.id, exact: true }).first().click();
  await expect(page.getByRole("button", { name: new RegExp(`^Model: ${provider}/${model.id}`) })).toBeVisible();
}
export async function open(page: Page, legacy = false) {
  if (page.url().startsWith(env("PI_WEB_E2E_BASE_URL"))) await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`${env("PI_WEB_E2E_BASE_URL")}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: env("PI_WEB_E2E_WORKSPACE_ID") })}`);
  await page.getByRole("button", { name: legacy ? "New Chat" : "New Durable Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  // Re-enter the exact single-Chat link; creating a neighbor may otherwise retain a Grid.
  await page.goto(`${env("PI_WEB_E2E_BASE_URL")}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: env("PI_WEB_E2E_WORKSPACE_ID"), session: id(page), view: "chat" })}`);
  if (!legacy) await choose(page, "anthropic");
}
export async function send(page: Page, value: string) {
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(page.locator("prompt-editor .cm-content")).toHaveText("");
  await page.locator("prompt-editor .cm-content").click();
  await page.keyboard.insertText(value);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
let seq = 0;
export async function turn(page: Page, calls: { name: string; args: Record<string, unknown> }[] = [], extraRequests = 0) {
  const marker = `fleet-${id(page)}-${++seq}`;
  await mock.script({ match: marker, turns: [...calls.map((toolCall) => [{ toolCall }]), `finished ${marker}`] });
  const before = (await messages(page)).length;
  await send(page, marker);
  await expect(chat(page).getByText(`finished ${marker}`, { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await status(page)).isStreaming).toBe(false);
  await expect.poll(async () => (await mock.journal({ kind: "chat", contains: marker })).length).toBe(calls.length + 1 + extraRequests);
  const journal = await mock.journal({ kind: "chat", contains: marker });
  for (const request of journal) expect(request.violations).toEqual([]);
  return { marker, journal, results: (await messages(page)).slice(before).filter((m) => m.role === "toolResult") };
}
export async function tool(page: Page, name: string, args: Record<string, unknown>, extraRequests = 0) {
  const result = (await turn(page, [{ name, args }], extraRequests)).results.at(-1);
  expect(result, `${name} must return a canonical tool result`).toBeDefined(); return result!;
}
export async function kill(page: Page) {
  const session = id(page);
  const rows = execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" }).split("\n")
    .filter((line) => line.includes("extensions-packages/host.ts") && line.includes(`--session-id ${session}`) && line.includes(root()));
  expect(rows, "kill only this fixture Chat's host").toHaveLength(1);
  const pid = Number(rows[0]!.trim().split(/\s+/)[0]); process.kill(pid, "SIGKILL");
  await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
  await expect.poll(async () => (await page.request.get(`${env("PI_WEB_E2E_BASE_URL")}api/sessions/${session}/status?${new URLSearchParams({ cwd: env("PI_WEB_E2E_PROJECT_DIR") })}`)).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Model: / })).toBeVisible();
}
export async function stop(page: Page) {
  if (!id(page)) return;
  await page.request.post(`${env("PI_WEB_E2E_BASE_URL")}api/sessions/${encodeURIComponent(id(page))}/stop`, { data: { cwd: env("PI_WEB_E2E_PROJECT_DIR") } });
}
export async function options(freeGb = 1000) { await writeFile(join(root(), "host-options.json"), JSON.stringify({ freeGb })); }
export async function lines(name: string) { return (await readFile(join(root(), name), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); }
export async function webHits(): Promise<string[]> { return (await fetch(`${env("FLEET_WEB")}/__hits`)).json() as Promise<string[]>; }
