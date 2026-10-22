import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test as baseTest, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";
import { MOCK_CLAUDE_MODEL } from "../../mockModels/agentConfig";
import { mockModels, type JournalEntry, type Step } from "../../mockModels/client";

export { expect };
export const mock = mockModels();
export const root = () => dirname(process.env["PI_WEB_E2E_PROJECT_DIR"]!);
export const project = () => process.env["PI_WEB_E2E_PROJECT_DIR"]!;
export const base = () => process.env["PI_WEB_E2E_BASE_URL"]!;
export const control = (value: { hold?: string; hideRoster?: boolean; receiptFault?: { workerId: string; foreign?: boolean } } = {}) => writeFile(join(root(), "fleet-control.json"), JSON.stringify(value));
export const editor = (page: Page) => page.locator("prompt-editor .cm-content");
export const row = (page: Page) => page.getByRole("region", { name: "Activity" }).locator('[data-row-key^="delegate:"]');
export const tc = (name: string, args: Record<string, unknown> = {}): Step => ({ toolCall: { name, args } });
export const scout = (task: string, extra: Record<string, unknown> = {}) => ({ task, profile: "scout", cognitiveRole: "routine", background: true, ...extra });
export const idOf = (result: Message) => String(result.details?.["executionId"]);
export const textOf = (message: Message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((c) => c.text ?? "").join("");
export type Message = { role?: string; toolName?: string; customType?: string; content?: string | { type: string; text?: string }[]; details?: Record<string, unknown>; isError?: boolean };

// Each test gets a new browser and Chat; all its external model requests remain in the saved journal.
export const test = baseTest.extend<{ fleet: void }>({ fleet: [async ({ page }, use, info) => {
  await mock.reset();
  await control({ hideRoster: process.env["FLEET_NEGATIVE_CONTROL"] === "1" });
  await writeFile(process.env["PI_WEB_E2E_QUOTA_CACHE"]!, JSON.stringify({ version: 1, checkedAt: Date.now(), status: 0, stdout: JSON.stringify({ providers: [] }), stderr: "" }));
  await use();
  const journal = await mock.journal();
  await writeFile(info.outputPath("mock-journal.json"), JSON.stringify(journal, null, 2));
  const id = new URL(page.url()).searchParams.get("session");
  if (id) {
    await writeFile(info.outputPath("transcript.json"), JSON.stringify(await messages(page, id).catch(() => []), null, 2));
    const ipc = await readFile(join(root(), `fleet-${id}.jsonl`), "utf8").catch(() => "");
    await writeFile(info.outputPath("host-ipc.jsonl"), ipc);
    const telemetry = await readdir(join(root(), "telemetry")).catch(() => []);
    for (const file of telemetry.filter((f) => f.endsWith(".jsonl"))) {
      const lines = (await readFile(join(root(), "telemetry", file), "utf8")).split("\n").filter((line) => line.includes(id));
      if (lines.length) await writeFile(info.outputPath(`telemetry-${file}`), lines.join("\n"));
    }
    // Teardown each Chat before resetting the mock in the next case (especially after an assertion fails).
    await page.request.post(`${base()}api/sessions/${encodeURIComponent(id)}/stop`, { data: { cwd: project() } }).catch(() => undefined);
  }
  expect(journal.flatMap((r) => r.violations)).toEqual([]);
}, { auto: true }] });

export async function send(page: Page, text: string, button: string | RegExp = /^(Send message|Queue follow-up)$/) {
  await editor(page).click();
  await page.keyboard.insertText(text);
  await page.getByRole("button", { name: button, exact: true }).click();
}
export async function create(page: Page, legacy = false) {
  await page.goto(`${base()}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace: process.env["PI_WEB_E2E_WORKSPACE_ID"]! })}`);
  await page.getByRole("button", { name: legacy ? "New Chat" : "New Durable Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(MOCK_CLAUDE_MODEL.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: MOCK_CLAUDE_MODEL.id, exact: true }).first().click();
  return new URL(page.url()).searchParams.get("session")!;
}
export async function messages(page: Page, id = new URL(page.url()).searchParams.get("session")!) {
  const response = await page.request.get(`${base()}api/sessions/${encodeURIComponent(id)}/messages?${new URLSearchParams({ cwd: project(), limit: "1000" })}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { messages: Message[] }).messages;
}
export async function status(page: Page) {
  const id = new URL(page.url()).searchParams.get("session")!;
  return (await page.request.get(`${base()}api/sessions/${encodeURIComponent(id)}/status?${new URLSearchParams({ cwd: project() })}`)).json();
}
let sequence = 0;
export async function call(page: Page, name: string, args: Record<string, unknown> = {}) {
  const marker = `fleet-call-${++sequence}-${Date.now()}`;
  const before = (await messages(page)).filter((m) => m.toolName === name).length;
  await mock.script({ provider: "anthropic", match: marker, turns: [[tc(name, args)], `ack ${marker}`] });
  await send(page, marker);
  await expect.poll(async () => (await messages(page)).filter((m) => m.toolName === name).length).toBe(before + 1);
  await expect(page.locator("chat-view").getByText(`ack ${marker}`, { exact: true })).toBeVisible();
  return (await messages(page)).filter((m) => m.toolName === name).at(-1)!;
}
export async function requests(script: string): Promise<JournalEntry[]> {
  return (await mock.journal()).filter((r) => typeof r.answeredBy === "object" && r.answeredBy.script === script);
}
type ToolSchema = { name: string; parameters?: { properties?: Record<string, unknown> }; input_schema?: { properties?: Record<string, unknown> } };
// Top-level `tools`, plus Responses `additional_tools` input items: pi-ai 1.4's Codex transport declares tools there.
export function tools(request: JournalEntry) {
  const body = request.body as { tools?: ToolSchema[]; input?: { type?: string; tools?: ToolSchema[] }[] };
  const declared = [...(body.tools ?? []), ...(Array.isArray(body.input) ? body.input : []).flatMap((item) => item.type === "additional_tools" ? item.tools ?? [] : [])];
  return declared.map((t) => ({ name: t.name.replace(/^mcp__[^_]+__/, "").toLowerCase(), properties: (t.parameters ?? t.input_schema)?.properties ?? {} }));
}
export async function killHost(page: Page) {
  const id = new URL(page.url()).searchParams.get("session")!;
  const { pid, store, sessionId } = JSON.parse(await readFile(join(root(), `fleet-${id}.pid.json`), "utf8")) as { pid: number; store: string; sessionId: string };
  expect(sessionId).toBe(id);
  expect(store.startsWith(`${root()}/`)).toBe(true);
  expect(pid).toBeGreaterThan(1);
  process.kill(pid, "SIGKILL");
  await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
  return { pid, store };
}
export async function held(page: Page, name: string) {
  const id = new URL(page.url()).searchParams.get("session")!;
  await expect.poll(async () => readFile(join(root(), `fleet-${id}.jsonl`), "utf8").catch(() => "")).toContain(`"type":"test.hold","name":"${name}"`);
}
