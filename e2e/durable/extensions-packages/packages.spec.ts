// AC-P108, P110, P112–P119, P124–P125, P128–P130, P133–P135; deferred command refusal.
// The installed package copies run unchanged. Search/fetch use local HTTP; phone uses stdio only.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chat, choose, env, get, id, kill, lines, messages, mock, open, options, root, send, status, stop, text, tool, turn, webHits } from "./helpers";

test.beforeEach(async () => { await mock.reset(); await options(); });
test.afterEach(async ({ page }, info) => {
  await info.attach("model-journal", { body: JSON.stringify(await mock.journal(), null, 2), contentType: "application/json" });
  await info.attach("phone-receipts", { body: JSON.stringify(await lines("phone.jsonl")), contentType: "application/json" });
  expect(await readFile(join(root(), "forbidden.log"), "utf8").catch(() => "")).toBe("");
  expect(await lines("network.jsonl")).toEqual([]);
  await stop(page);
});
const enabled = async (page: Parameters<typeof tool>[0]) => {
  const result = await tool(page, "web_enable", {}); expect(result.isError, text(result.content)).toBe(false); return result;
};
const names = (body: unknown) => {
  const request = body as { tools?: { name: string }[]; input?: { tools?: { name: string }[] }[]; messages?: { content?: unknown }[] };
  const additions = (request.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === "tool_addition").map((block) => block.tool.definition as { name: string });
  return [...(request.tools ?? []), ...(request.input ?? []).flatMap((item) => item.tools ?? []), ...additions].map((t) => t.name);
};
const responseId = (result: { content: unknown; details?: unknown }) => {
  const found = /responseId[^A-Za-z0-9]*([A-Za-z0-9_-]{6,})/.exec(text(result.content) + JSON.stringify(result.details))?.[1];
  expect(found, "stored result identifier").toBeTruthy(); return found!;
};

test("AC-P113 web_enable gates configured tools and makes no network request", async ({ page }) => {
  await open(page);
  const hits = await webHits();
  const { journal } = await turn(page, [{ name: "web_enable", args: {} }]);
  expect(names(journal[0]?.body)).toContain("mcp__pi__web_enable");
  expect(names(journal[0]?.body)).not.toContain("mcp__pi__web_search");
  expect(names(journal[1]?.body).map((name) => name.replace(/^mcp__pi__/, ""))).toContain("web_search");
  expect(names(journal[1]?.body).map((name) => name.replace(/^mcp__pi__/, ""))).not.toContain("source_check");
  expect(await webHits()).toEqual(hits);
});

test("AC-P114 web_search returns query-specific linked sources and bounded limits", async ({ page }) => {
  await open(page); await enabled(page);
  for (const query of ["alpha-fleet", "beta-fleet"]) {
    const result = await tool(page, "web_search", { query, provider: "searxng", numResults: 2, recencyFilter: "week", workflow: "none" });
    expect(result.isError, text(result.content)).toBe(false);
    expect(text(result.content)).toContain(query); expect(text(result.content)).toContain("searxng"); responseId(result);
    expect(text(result.content)).toContain(`${env("FLEET_WEB")}/page/1`);
    expect(text(result.content)).not.toContain(`${query} source 3`);
    expect((await webHits()).some((hit) => hit.includes(`q=${query}`))).toBe(true);
  }
});

test("AC-P115 fetch_content readable and raw modes use only the local page", async ({ page }) => {
  await open(page); await enabled(page);
  for (const mode of ["readable", "raw"]) {
    const result = await tool(page, "fetch_content", { url: `${env("FLEET_WEB")}/page/${mode}`, mode });
    expect(result.isError, text(result.content)).toBe(false); expect(text(result.content)).toContain("Fixture evidence");
    if (mode === "raw") expect(text(result.content)).toContain("<article>");
    else expect(text(result.content)).not.toContain("<article>");
    responseId(result);
  }
  const answer = await tool(page, "fetch_content", { url: `${env("FLEET_WEB")}/page/answer`, mode: "answer", prompt: "What does the fixture say?", answerModel: "anthropic/claude-sonnet-5-5" });
  expect(answer.isError, text(answer.content)).toBe(false);
});

test("AC-P116 stored content honors offsets/findText and survives restart without refetch", async ({ page }) => {
  await open(page); await enabled(page);
  const url = `${env("FLEET_WEB")}/page/stored`;
  const fetched = await tool(page, "fetch_content", { url });
  const stored = responseId(fetched); const hits = await webHits();
  const first = await tool(page, "get_search_content", { responseId: stored, url, offset: 0, limit: 100 });
  const later = await tool(page, "get_search_content", { responseId: stored, url, offset: 200, limit: 100 });
  expect(first.isError).toBe(false); expect(later.isError).toBe(false);
  expect(text(first.content)).not.toBe(text(later.content));
  await kill(page);
  const found = await tool(page, "get_search_content", { responseId: stored, url, findText: "NEEDLE-END" });
  expect(found.isError, text(found.content)).toBe(false); expect(text(found.content)).toContain("NEEDLE-END");
  const missing = await tool(page, "get_search_content", { responseId: "missing-fixture-id" });
  expect(text(missing.content)).toMatch(/not found|No stored|unknown/i);
  expect(await webHits()).toEqual(hits);
});

test("AC-P117 source_check when configured emits sourced passages, not a truth verdict", async ({ page }) => {
  const config = join(root(), "durable-agent/web-search.json");
  const original = await readFile(config, "utf8");
  await writeFile(config, JSON.stringify({ ...JSON.parse(original), tools: { sourceCheck: { enabled: true } } }));
  try {
    await open(page); await enabled(page);
    const result = await tool(page, "source_check", { claim: "alpha-fleet has local evidence", fetchContent: true });
    expect(result.isError, text(result.content)).toBe(false);
    expect(text(result.content)).toContain(env("FLEET_WEB"));
    expect(text(result.content)).toMatch(/manual|review|not.*verdict/i);
  } finally { await writeFile(config, original); }
});

test("AC-P112 Claude package aliases round-trip canonically and do not leak to OpenAI", async ({ page }) => {
  await open(page); const result = await tool(page, "notify_human", { message: "alias fixture" });
  expect(result.toolName).toBe("notify_human"); expect(result.isError).toBe(false);
  const claude = await mock.journal({ kind: "chat", provider: "anthropic" });
  expect(names(claude[0]?.body)).toContain("mcp__pi__notify_human");
  await choose(page, "openai-codex"); const { journal } = await turn(page);
  expect(names(journal[0]?.body)).toContain("notify_human");
  expect(names(journal[0]?.body).some((name) => name.startsWith("mcp__pi__"))).toBe(false);
  await choose(page, "anthropic");
  const dynamic = await turn(page, [{ name: "web_enable", args: {} }]);
  expect(names(dynamic.journal[1]?.body), "dynamically added Claude tools also need subscription aliases").toContain("mcp__pi__web_search");
});

for (const name of ["ask_human", "notify_human"]) test(`AC-P${name === "ask_human" ? "124" : "125"} ${name} stub success/error and kill-after-send never resends`, async ({ page }) => {
  await open(page); const field = name === "ask_human" ? "question" : "message";
  const prefix = `${id(page)}-${name}`;
  const sent = () => lines("phone.jsonl").then((all) => all.filter((line) => JSON.stringify(line).includes(prefix)));
  const success = await tool(page, name, { [field]: `${prefix} success` });
  expect(success.isError).toBe(false); expect(text(success.content)).toContain(name === "ask_human" ? "fixture yes" : "fixture delivered");
  const failure = await tool(page, name, { [field]: `fail:${prefix}` });
  expect(failure.isError).toBe(true); expect(text(failure.content)).toContain("Fixture transport refused");
  if (name === "ask_human") {
    const timeout = await tool(page, name, { question: `timeout:${prefix}`, timeoutMs: 1 });
    expect(timeout.isError).toBe(true); expect(text(timeout.content)).toContain("timed out");
  }
  const marker = `hold:${prefix}`;
  await mock.script({ match: marker, turns: [[{ toolCall: { name, args: { [field]: marker } } }]] });
  await send(page, marker);
  await expect.poll(async () => (await sent()).filter((line) => JSON.stringify(line).includes(marker)).length).toBe(1);
  const count = (await sent()).length;
  await kill(page);
  await expect(chat(page).locator(".unresolved-effects")).toContainText(name);
  expect((await status(page)).unresolvedEffects?.map((e) => e.toolName)).toContain(name);
  await page.reload(); await status(page); expect(await sent()).toHaveLength(count);
  const resume = `resume:${prefix}`;
  await mock.script({ match: resume, turns: [[{ toolCall: { name, args: { [field]: `fresh-duplicate:${prefix}` } } }], "fresh send blocked"] });
  const admitted = await page.request.post(`${env("PI_WEB_E2E_BASE_URL")}api/sessions/${id(page)}/prompt`, { data: { cwd: env("PI_WEB_E2E_PROJECT_DIR"), text: resume } });
  expect(admitted.ok()).toBe(true);
  await expect(chat(page).getByText("fresh send blocked", { exact: true }).first()).toBeVisible();
  expect(text((await messages(page)).findLast((message) => message.toolName === name)?.content)).toContain("Needs reconciliation");
  expect(await sent()).toHaveLength(count);
  expect((await sent()).every((line) => line["transport"] === "stdio-fixture")).toBe(true);
});

test("AC-P124 delayed phone reply and cancellation are truthful", async ({ page }) => {
  await open(page); const key = `hold:reply-${id(page)}`;
  await mock.script({ match: key, turns: [[{ toolCall: { name: "ask_human", args: { question: key } } }], "answered locally"] });
  await send(page, key);
  await expect.poll(async () => (await lines("phone.jsonl")).some((row) => JSON.stringify(row).includes(key))).toBe(true);
  await writeFile(join(root(), "phone-replies.json"), JSON.stringify({ [key]: "fixture delayed yes" }));
  await expect(chat(page).getByText("answered locally", { exact: true }).first()).toBeVisible();
  expect(text((await messages(page)).findLast((m) => m.toolName === "ask_human")?.content)).toContain("fixture delayed yes");
  const cancel = `hold:cancel-${id(page)}`;
  await mock.script({ match: cancel, turns: [[{ toolCall: { name: "ask_human", args: { question: cancel } } }]] });
  await send(page, cancel);
  await expect.poll(async () => (await lines("phone.jsonl")).some((row) => JSON.stringify(row).includes(cancel))).toBe(true);
  await page.getByRole("button", { name: "Stop current work" }).click();
  await expect.poll(async () => (await status(page)).isStreaming).toBe(false);
  expect(text((await messages(page)).findLast((m) => m.toolName === "ask_human")?.content)).toMatch(/abort|cancel/i);
});

test("AC-P133 monitor tools preserve identity, quarantine and explicit destructive approval", async ({ page }) => {
  await open(page); const log = join(env("PI_WEB_E2E_PROJECT_DIR"), `${id(page)}.log`); await writeFile(log, "");
  const args = { source: { type: "tail", path: log }, options: { reuse: "return-existing", reuseKey: id(page) } };
  const created = await tool(page, "monitor", args); expect(created.isError, text(created.content)).toBe(false);
  const watcher = (created.details?.["watcher"] as { id: string; logicalId: string }); expect(watcher?.id).toBeTruthy();
  const reused = await tool(page, "monitor", args); expect((reused.details?.["watcher"] as { logicalId: string }).logicalId).toBe(watcher.logicalId);
  for (const name of ["monitor_status", "monitor_inspect"]) {
    const result = await tool(page, name, name === "monitor_status" ? {} : { id: watcher.id }); expect(result.isError).toBe(false); expect(text(result.content)).toContain(watcher.id);
  }
  const gc = await tool(page, "monitor_gc", {}); expect(text(gc.content)).toContain("dry-run");
  const refused = await tool(page, "monitor_kill_all", { confirm: false }); expect(refused.isError).toBe(true);
  const quarantine = await tool(page, "monitor", { source: { type: "poll", command: "echo never-mutates" }, options: { label: "fixture quarantine" } });
  expect(text(quarantine.content)).toContain("QUARANTINED");
  const q = (quarantine.details?.["watcher"] as { id: string }).id;
  expect((await tool(page, "monitor_recover", { id: q, action: "reject" })).isError).toBe(false);
  expect((await tool(page, "monitor_kill", { id: watcher.id })).isError).toBe(false);
  expect((await tool(page, "monitor_kill_all", { confirm: true })).isError).toBe(false);
});

test("AC-P134 monitor commands list, show usage and keep GC dry-run", async ({ page }) => {
  await open(page);
  const commands = await get<{ name: string }[]>(page, "commands");
  for (const name of ["monitor", "monitors", "monitor-kill", "monitor-recover", "monitor-gc"]) expect(commands.map((c) => c.name)).toContain(name);
  await send(page, "/monitor"); await expect(chat(page).getByText(/Usage:.*monitor/i).first()).toBeVisible();
  await send(page, "/monitor-gc"); await expect(chat(page).getByText(/monitor GC is dry-run/).first()).toBeVisible();
});

test("AC-P135 monitor ping survives host restart and stays in its owning Chat", async ({ page }) => {
  await open(page); const owner = page.url();
  const log = join(env("PI_WEB_E2E_PROJECT_DIR"), `${id(page)}-ping.log`); await writeFile(log, "");
  const result = await tool(page, "monitor", { source: { type: "tail", path: log }, options: { notifyOn: ["FLEET-DONE"], coalesceSeconds: 0, label: "fleet-watcher" } });
  expect(result.isError, text(result.content)).toBe(false);
  await kill(page); await appendFile(log, "FLEET-DONE\n");
  await expect(chat(page).getByText(/\[watcher .*fleet-watcher\] FLEET-DONE/).first()).toBeVisible();
  const pings = (await messages(page)).filter((m) => m.role === "custom" && text(m.content).includes("FLEET-DONE"));
  expect(pings).toHaveLength(1);
  await stop(page); await open(page);
  expect((await messages(page)).some((m) => text(m.content).includes("FLEET-DONE"))).toBe(false);
  await stop(page); await page.goto(owner);
  expect((await messages(page)).filter((m) => m.role === "custom" && text(m.content).includes("FLEET-DONE"))).toHaveLength(1);
});

for (const [ac, commandName] of [["128", "btw"], ["129", "btw:ask"]]) test(`AC-P${ac} non-overlay ${commandName} saves a visible side note`, async ({ page }) => {
  await open(page);
  await mock.script({ turns: ["fixture side answer"] });
  await send(page, `/${commandName} What is the fixture result?`);
  await expect(chat(page).getByText("fixture side answer", { exact: true }).first()).toBeVisible();
  const { journal } = await turn(page); expect(JSON.stringify(journal[0]?.body)).not.toContain("fixture side answer");
});

for (const [ac, skill] of [["108", "workstreams"], ["130", "btw"]]) test(`AC-P${ac} skill catalog exposes ${skill} independently of extension execution`, async ({ page }) => {
  await open(page);
  const catalog = await get<{ name: string }[]>(page, "commands");
  expect(catalog.map((entry) => entry.name)).toContain(`skill:${skill}`);
  if (ac === "108") for (const name of ["atelier", "autonomous-grill", "define-goal", "model-orchestration", "orient", "workstreams", "analyze-source-for-workbench", "customize-pi-web-presentation", "gh-stack"]) expect(catalog.map((entry) => entry.name)).toContain(`skill:${name}`);
  await send(page, `/skill:${skill}`);
  await expect.poll(async () => (await mock.journal({ kind: "chat" })).length).toBe(1);
  expect(JSON.stringify((await mock.journal({ kind: "chat" }))[0]?.body)).toContain("SKILL.md");
});

test("AC-P110 extension-contributed skill is discovered or explicitly rejected", async ({ page }) => {
  await open(page);
  const catalog = await get<{ name: string }[]>(page, "commands");
  // The copied bound package registers resources_discover; silent omission is not a visible refusal.
  const found = catalog.some((entry) => entry.name === "skill:fleet-contributed");
  if (!found) await expect(chat(page).getByText(/resource.*(unsupported|not available)/i).first()).toBeVisible();
  expect(found, "supported contribution must be invokable").toBe(true);
});

test("AC-P118 curator settings are visible; stored-result selection remains usable", async ({ page }) => {
  await open(page); await enabled(page);
  await tool(page, "fetch_content", { url: `${env("FLEET_WEB")}/page/select` });
  await send(page, "/search");
  // Unsupported extension dialogs are NOT parity for this retained package command.
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("AC-P119 package lifecycle retains branch-local tools and clears pending search activity", async ({ page }) => {
  await open(page); await enabled(page);
  const result = await tool(page, "web_search", { query: "lifecycle-fleet", provider: "searxng", includeContent: true, workflow: "none" }, 1);
  expect(result.isError).toBe(false); expect(text(result.content)).toContain("lifecycle-fleet");
  expect((await status(page)).isStreaming).toBe(false);
  await kill(page); const { journal } = await turn(page);
  expect(names(journal[0]?.body).map((name) => name.replace(/^mcp__pi__/, ""))).toContain("web_search");
});

test("deferred package commands are visibly refused, never model prompts", async ({ page }) => {
  await open(page);
  for (const name of ["google-account", "autonomous-grill", "relay", "watch"]) {
    await send(page, `/${name}`);
    await expect(chat(page).getByText(new RegExp(`/${name}.*(not available|unsupported)|Unknown.*${name}`, "i")).first()).toBeVisible();
  }
  expect(await mock.journal({ kind: "chat" })).toEqual([]);
});
