import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PROJECT_ID } from "../../isolatedPiWeb";
import { MOCK_CLAUDE_MODEL, MOCK_CODEX_MODEL } from "../../mockModels/agentConfig";
import { mockModels } from "../../mockModels/client";

export const mock = mockModels();
export const editor = (page: Page) => page.locator("prompt-editor .cm-content");
export const chat = (page: Page) => page.locator("chat-view");
export const fixture = () => {
  const base = process.env["PI_WEB_E2E_BASE_URL"]!;
  const project = process.env["PI_WEB_E2E_PROJECT_DIR"]!;
  return { base, project, root: dirname(project), workspace: process.env["PI_WEB_E2E_WORKSPACE_ID"]! };
};
export const sessionId = (page: Page) => new URL(page.url()).searchParams.get("session")!;
export const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
export type Message = { role: string; content?: unknown; customType?: string; toolName?: string; isError?: boolean; details?: { id?: string; state?: string; logPath?: string; url?: string; check?: { status: string; views: unknown[]; unchecked: string[] }; jobs?: { id: string; state: string; bytes: number; elapsedSeconds: number; logPath: string }[] } };
export type Tree = { type: string; activeLeafId: string | null; nodes: { id: string; parentId: string | null; kind: string; summary: string }[] };
export type Status = { isStreaming?: boolean; pendingAsks?: { askId: string; revision: string }[]; extensionStatuses?: Record<string, string>; queuedMessages?: unknown[] };

export async function api(page: Page, path: string, data?: object) {
  const { base, project } = fixture();
  const url = `${base}api/sessions/${encodeURIComponent(sessionId(page))}/${path}`;
  return data === undefined ? page.request.get(`${url}?${new URLSearchParams({ cwd: project })}`) : page.request.post(url, { data: { cwd: project, ...data } });
}
export async function messages(page: Page): Promise<Message[]> {
  const response = await api(page, "messages");
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json() as { messages: Message[] };
  return body.messages;
}
export async function status(page: Page): Promise<Status> { return (await api(page, "status")).json() as Promise<Status>; }
export async function idle(page: Page) { await expect.poll(async () => (await status(page)).isStreaming, { timeout: 20_000 }).toBe(false); }
export async function send(page: Page, value: string) {
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(value);
  await page.getByRole("button", { name: /^(Send message|Steer current response)$/ }).click({ timeout: 10_000 });
}
export async function newChat(page: Page, legacy = false, codex = false) {
  const { base, workspace, root } = fixture();
  if (legacy) {
    // Only the throwaway profile; never the owner's settings. Match the real Workbench legacy tools.
    const workbench = join(dirname(process.env["DURABLE_FLEET_HOST"] ?? process.env["PI_WEB_E2E_DURABLE_HOST"]!), "../../..");
    const path = join(root, "agent", "settings.json");
    const settings = JSON.parse(await readFile(path, "utf8")) as { extensions?: string[] };
    settings.extensions = [...new Set([...(settings.extensions ?? []), ...["background-bash", "atelier", "tool-groups", "telemetry"].map((name) => join(workbench, "extensions", name, "index.ts"))])];
    await writeFile(path, JSON.stringify(settings));
  }
  await page.goto(`${base}?${new URLSearchParams({ project: E2E_PROJECT_ID, workspace })}`);
  await page.getByRole("button", { name: legacy ? "New Chat" : "New Durable Chat", exact: true }).click();
  await expect(page).toHaveURL(/session=[0-9a-f-]{36}/);
  const model = codex ? MOCK_CODEX_MODEL : MOCK_CLAUDE_MODEL;
  await page.getByRole("button", { name: /^Model: / }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill(model.id);
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name: model.id, exact: true }).first().click();
  await expect(page.getByRole("button", { name: new RegExp(`^Model: ${model.provider}/${model.id}`) })).toBeVisible();
}
export async function tool(page: Page, name: string, args: Record<string, unknown>, label = `${name}-${Date.now()}`): Promise<Message> {
  // Match the new prompt, not an earlier marker in history: exhausted scripts are skipped by the mock.
  await mock.script({ match: label, turns: [[{ toolCall: { name, args } }], `done ${label}`] });
  const before = (await messages(page)).filter((m) => m.toolName === name).length;
  await send(page, label);
  await expect.poll(async () => (await messages(page)).filter((m) => m.toolName === name).length, { timeout: 45_000 }).toBe(before + 1);
  await expect(chat(page).getByText(`done ${label}`, { exact: true }).first()).toBeVisible();
  await idle(page);
  return (await messages(page)).filter((m) => m.toolName === name).at(-1)!;
}
export const completions = async (page: Page) => (await messages(page)).filter((m) => m.customType === "background-bash");
export const deliveries = async (page: Page) => (await messages(page)).filter((m) => m.customType?.startsWith("atelier:"));
export const effectCount = async (path: string) => (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function hostPid(page: Page): number {
  const store = join(fixture().root, "data", "durable", sessionId(page));
  const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  const matches = lines.filter((line) => line.includes(`--store ${store}`) && /(?:chat-host-main\.ts|fault-host\.mjs)/.test(line) && !line.includes("/tsx/dist/cli"));
  expect(matches, `exactly one host under ${store}`).toHaveLength(1);
  return Number(matches[0]!.trim().split(/\s+/)[0]);
}
export async function killHost(page: Page) {
  const pid = hostPid(page);
  process.kill(pid, "SIGKILL");
  await expect.poll(() => alive(pid)).toBe(false);
}
export async function reopen(page: Page) { await page.reload(); await expect(editor(page)).toBeVisible(); await expect.poll(async () => (await api(page, "status")).ok()).toBe(true); }
export async function armCrash(page: Page, point: string) {
  expect(process.env["DURABLE_FLEET_HOST"], "Use bash e2e/durable/bash-atelier-tree/run.sh for host fault injection").toBeTruthy();
  // fault-host.mjs consumes this one-shot file at the next host start; it never changes production code.
  await writeFile(join(fixture().root, "data", "durable", sessionId(page), "fleet-crash"), point);
  expect((await api(page, "stop", {})).ok()).toBe(true);
  await reopen(page);
  return hostPid(page);
}
export async function tree(page: Page): Promise<Tree> {
  const result = await (await api(page, "commands/run", { text: "/tree" })).json() as { type: string; tree: Omit<Tree, "type"> };
  expect(result.type, JSON.stringify(result)).toBe("tree");
  return { type: result.type, ...result.tree };
}
export async function navigate(page: Page, t: Tree, target: string) { return api(page, "tree/navigate", { targetId: target, expectedLeafId: t.activeLeafId, summary: { mode: "none" }, retainCheckpoint: false }); }

export function setup() {
  test.skip(process.env["PI_WEB_E2E_DURABLE_HOST"] === undefined, "PI_WEB_E2E_DURABLE_HOST is not set");
  test.skip(process.env["PI_WEB_E2E_MOCK_URL"] === undefined, "the mock model server is required");
  test.setTimeout(90_000);
  test.use({ trace: "on" });
  test.beforeEach(async ({ context }) => {
    await mock.reset();
    await context.route("**/*", async (route) => {
      const host = new URL(route.request().url()).hostname;
      if (["127.0.0.1", "localhost", "[::1]"].includes(host)) await route.continue();
      else { await route.abort(); throw new Error(`Fleet blocks non-fixture browser destination: ${host}`); }
    });
  });
  test.afterEach(async ({ page }, info) => {
    const journal = await mock.journal();
    await info.attach("mock-journal", { body: JSON.stringify(journal, null, 2), contentType: "application/json" });
    if (!page.isClosed() && sessionId(page)) {
      await info.attach("transcript", { body: JSON.stringify(await messages(page).catch(() => []), null, 2), contentType: "application/json" });
    }
    for (const tab of page.context().pages()) if (!tab.isClosed() && sessionId(tab)) await api(tab, "stop", {}).catch(() => undefined);
    // Detached runners are outside sessiond's process group. Only kill identities in OUR registry.
    const jobs = join(fixture().root, "background-bash");
    for (const id of await readdir(jobs).catch(() => [])) {
      const dir = join(jobs, id);
      const claim = JSON.parse(await readFile(join(dir, "claim"), "utf8").catch(() => "{}")) as { pid?: number };
      if (claim.pid === undefined || !alive(claim.pid)) continue;
      const command = execFileSync("ps", ["-p", String(claim.pid), "-o", "command="], { encoding: "utf8" });
      if (command.includes(dir) && command.includes("runner.mjs")) { try { process.kill(-claim.pid, "SIGKILL"); } catch { /* already exited */ } }
    }
    // Fixture transports and strict subscription validation; failed setup need not have sent a model request.
    if (info.status === "passed") expect(journal.filter((entry) => entry.kind === "chat").length).toBeGreaterThan(0);
    for (const entry of journal) {
      expect(entry.violations).toEqual([]);
      expect(["/v1/messages", "/codex/responses"]).toContain(entry.path);
    }
  });
}
