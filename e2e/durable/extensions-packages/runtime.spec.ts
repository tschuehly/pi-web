// AC-P034, P041, P073, P085, P088, P101, P103–P106, P111–P112, P137.
// Actual WebKit UI + mock model requests; host kills are SIGKILL, not browser reconnects.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chat, choose, command, env, id, kill, messages, mock, open, options, root, send, status, stop, text, tool, turn } from "./helpers";

test.beforeEach(async () => {
  await mock.reset(); await options();
  await writeFile(env("PI_WEB_E2E_QUOTA_CACHE"), JSON.stringify({ version: 1, checkedAt: Date.now(), status: 0, stdout: JSON.stringify({ providers: [] }), stderr: "" }));
});
test.afterEach(async ({ page }, info) => {
  await info.attach("model-journal", { body: JSON.stringify(await mock.journal(), null, 2), contentType: "application/json" });
  await stop(page);
});

for (const legacy of [false, true]) test(`AC-P111 ${legacy ? "legacy" : "durable"} subscription shape, thinking, canonical tool round trip`, async ({ page }) => {
  await open(page, legacy);
  const marker = `subscription-${id(page)}`;
  await mock.script({ match: marker, turns: [[{ thinking: "Inspect the fixture." }, { toolCall: { name: "read", args: { path: "docs/notes.md" } } }], "subscription complete"] });
  await send(page, marker);
  await expect(chat(page).getByText("subscription complete", { exact: true }).first()).toBeVisible();
  const requests = await mock.journal({ contains: marker, kind: "chat" });
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.violations).toEqual([]);
    expect(request.auth).toBe("oauth");
    expect(request.headers["user-agent"]).toMatch(/^claude-cli\//);
    expect(request.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(JSON.stringify(request.body)).toContain("cache_control");
  }
  expect(requests[1]?.lastUserText).toContain("Seeded notes body");
  expect((await messages(page)).find((m) => m.role === "toolResult")?.toolName).toBe("read");
  await turn(page);
  await mock.script({ turns: ["Fixture subscription compaction summary"] });
  await send(page, "/compact Keep the notes");
  await expect(chat(page).getByText(/history compaction summary|Compacted|Earlier conversation/i).first()).toBeVisible();
  for (const request of await mock.journal({ kind: "chat" })) expect(request.violations).toEqual([]);
});

test("AC-P041 extension status appears, updates and clears without losing Working Mode", async ({ page }) => {
  await open(page);
  const before = (await status(page)).extensionStatuses!["working-mode"];
  await command(page, "/fleet-status fixture-one");
  expect((await status(page)).extensionStatuses?.["fleet-probe"]).toBe("fixture-one");
  await command(page, "/fleet-status fixture-two");
  expect((await status(page)).extensionStatuses?.["fleet-probe"]).toBe("fixture-two");
  // Lead decision: legacy PI WEB renders no arbitrary extension statuses either; parity is the status projection, beside Working Mode.
  expect((await status(page)).extensionStatuses).toMatchObject({ "fleet-probe": "fixture-two", "working-mode": before });
  await command(page, "/fleet-status clear");
  expect((await status(page)).extensionStatuses?.["fleet-probe"]).toBeUndefined();
  expect((await status(page)).extensionStatuses?.["working-mode"]).toBe(before);
});

test("AC-P137 fast on/off/toggle affects only OpenAI service_tier", async ({ page }) => {
  await open(page); await choose(page, "openai-codex", "gpt-6-astra");
  for (const [arg, tier] of [["on", "priority"], ["off", undefined], ["toggle", "priority"]] as const) {
    await command(page, `/fast ${arg}`);
    const { journal } = await turn(page);
    expect((journal[0]?.body as Record<string, unknown>)["service_tier"]).toBe(tier);
  }
  const invalid = await command(page, "/fast garbage");
  expect(JSON.stringify(invalid.body)).toMatch(/usage|invalid/i);
  await choose(page, "anthropic");
  const { journal } = await turn(page);
  expect((journal[0]?.body as Record<string, unknown>)["service_tier"]).toBeUndefined();
});

test("AC-P085 temporary path guard, shell warning, bounded scratch sweep", async ({ page }) => {
  const scratch = join(root(), "pi-tmp", "expired-fixture");
  await mkdir(join(scratch, ".days"), { recursive: true });
  for (let n = 1; n <= 8; n++) await writeFile(join(scratch, ".days", `2026-01-0${n}`), "");
  await mkdir(join(scratch, "old"), { recursive: true }); await mkdir(join(scratch, "live"), { recursive: true });
  await utimes(join(scratch, "old"), new Date("2025-01-01"), new Date("2025-01-01"));
  await open(page);
  expect(existsSync(join(scratch, "old"))).toBe(false); expect(existsSync(join(scratch, "live"))).toBe(true);
  // Never actually write to /tmp: a unique forbidden target must be rejected before execution.
  const forbidden = `/tmp/fleet-must-not-exist-${id(page)}`;
  for (const name of ["write", "edit"]) {
    const result = await tool(page, name, name === "write" ? { path: forbidden, content: "no" } : { path: forbidden, edits: [{ oldText: "a", newText: "b" }] });
    expect(result.isError).toBe(true); expect(text(result.content)).toMatch(/Blocked:.*OS temp folder.*Use \$PI_TMP/s);
    expect(existsSync(forbidden)).toBe(false);
  }
  const result = await tool(page, "bash", { command: "true || cd /tmp", description: "Warning without touching OS tmp", foreground: true });
  expect(text(result.content)).toContain("Warning: this command uses /tmp");
});

test("AC-P088 low disk notice occurs once per threshold across host kills", async ({ page }) => {
  await options(49); await open(page); await turn(page); await turn(page);
  const notices = async () => (await messages(page)).filter((m) => m.customType === "storage-guard");
  expect(await notices()).toHaveLength(1);
  await options(46); await kill(page); await turn(page); expect(await notices()).toHaveLength(1);
  await options(44); await kill(page); await turn(page);
  expect((await notices()).map((m) => text(m.content))).toEqual([expect.stringContaining("49 GB"), expect.stringContaining("44 GB")]);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(4);
  await expect(chat(page).getByText(/Disk low: 44 GB/).first()).toBeVisible();
  const childMarker = `storage-child-${id(page)}`;
  const child = await tool(page, "subagent", { task: childMarker, profile: "scout", cognitiveRole: "routine", modelOverride: "anthropic/claude-sonnet-5-5" });
  expect(child.isError, text(child.content)).toBe(false);
  const requests = (await mock.journal({ contains: childMarker, kind: "chat" })).filter((entry) => entry.lastUserText.includes(`Assignment:\n${childMarker}`));
  expect(requests).toHaveLength(1); expect(JSON.stringify(requests[0]?.body)).not.toContain("Disk low:");
});

const mode = async (page: Parameters<typeof status>[0]) => JSON.parse((await status(page)).extensionStatuses!["working-mode"]!) as { phase: string; aligned: boolean; selected: Record<string, string> };
test("AC-P103 AC-P104 selected Working Mode delivers once and survives restart", async ({ page }) => {
  await open(page);
  for (const arg of ["alignment plan", "attention afk", "checking challenge", "orchestration workers"]) {
    expect((await command(page, `/mode ${arg}`)).ok).toBe(true);
  }
  expect((await mode(page)).phase).toBe("selected");
  await kill(page);
  const first = await turn(page);
  expect(JSON.stringify(first.journal[0]?.body)).toContain("<working-mode");
  expect((await mode(page)).phase).toBe("applied");
  const count = (await mock.journal({ kind: "chat" })).length;
  await command(page, "/mode send"); await command(page, "/mode send");
  expect(await mock.journal({ kind: "chat" })).toHaveLength(count);
  const prior = await mode(page); await command(page, "/mode attention nonsense"); expect(await mode(page)).toEqual(prior);
  const help = await command(page, "/mode"); expect(JSON.stringify(help.body)).toMatch(/mode|Alignment/);
  await expect(chat(page).locator("details.working-mode-card")).toHaveCount(1);
  await turn(page);
  await mock.script({ turns: ["Fixture compact summary retaining agreed mode"] });
  await send(page, "/compact Keep the Working Mode choice");
  await expect(chat(page).getByText("1 history compaction summary").first()).toBeVisible();
  const resumed = await turn(page);
  expect(JSON.stringify(resumed.journal[0]?.body)).toContain("<working-mode");
  expect((await mode(page)).selected).toEqual(prior.selected);
});

for (const reset of [false, true]) test(`AC-P${reset ? "106" : "105"} alignment ${reset ? "reset" : "reached"} is durable`, async ({ page }) => {
  await open(page); await command(page, "/mode alignment plan"); await command(page, "/mode attention afk");
  const result = await tool(page, "alignment_reached", { agreement: "Fixture agreed outcome only" });
  expect(result.isError).toBe(false); expect((await mode(page)).aligned).toBe(true);
  if (reset) { const cleared = await tool(page, "alignment_reset", { reason: "Fixture scope changed" }); expect(cleared.isError).toBe(false); }
  await kill(page); expect((await mode(page)).aligned).toBe(!reset);
  const { journal } = await turn(page);
  expect(JSON.stringify(journal[0]?.body)).toContain(reset ? "Fixture scope changed" : "Fixture agreed outcome only");
});

test("AC-P034 lead tools and fixture Workstreams CLI identify the Durable Chat", async ({ page }) => {
  await open(page);
  const cli = join(env("FLEET_WORKBENCH"), "skills/workstreams/scripts/workstreams.mjs");
  const workstream = `ws-fleet-${id(page).slice(0, 8)}`;
  execFileSync(process.execPath, [cli, "create", workstream, "--title", "Fleet fixture", "--group", "Pi Workbench", "--owner"], { env: { ...process.env, PI_WORKBENCH_WORKSTREAM_DIR: join(root(), "workstreams") } });
  const result = await tool(page, "bash", { command: `printf "ID=%s TMP=%s FILE=%s TMPDIR=%s\\n" "$PI_SESSION_ID" "$PI_TMP" "\${PI_SESSION_FILE:-none}" "$TMPDIR"; workstreams associate ${workstream} >/dev/null && workstreams`, description: "Fixture identity", foreground: true });
  expect(result.isError).toBe(false);
  expect(text(result.content)).toContain(`ID=${id(page)}`); expect(text(result.content)).toContain("FILE=none");
  expect(text(result.content)).toContain(`this session: ${workstream}`);
  expect(text(result.content)).toContain(join(root(), "pi-tmp", "project", id(page)));
});

test("AC-P034 AC-P085 child environments are distinct and never borrow the lead identity", async ({ page }) => {
  await open(page);
  const environments: { PI_SESSION_ID: string; PI_TMP: string; TMPDIR: string; PI_SESSION_FILE?: string }[] = [];
  for (const index of [1, 2]) {
    const marker = `child-env-${id(page)}-${index}`;
    const output = join(env("PI_WEB_E2E_PROJECT_DIR"), `${marker}.json`);
    const commandText = `node -e 'const e=process.env; require("node:fs").writeFileSync(${JSON.stringify(output)},JSON.stringify({PI_SESSION_ID:e.PI_SESSION_ID,PI_TMP:e.PI_TMP,TMPDIR:e.TMPDIR,PI_SESSION_FILE:e.PI_SESSION_FILE}))'`;
    await mock.script({ match: marker, turns: [[{ toolCall: { name: "bash", args: { command: commandText } } }], "child identity captured"] });
    const child = await tool(page, "subagent", { task: marker, profile: "implementer", cognitiveRole: "routine", modelOverride: "anthropic/claude-sonnet-5-5" });
    expect(child.isError, text(child.content)).toBe(false);
    environments.push(JSON.parse(await readFile(output, "utf8")));
  }
  for (const value of environments) {
    expect(value.PI_SESSION_ID).toMatch(new RegExp(`^${id(page)}:`));
    expect(value.PI_TMP).toContain(join(root(), "pi-tmp", "project"));
    expect(value.PI_TMP).not.toBe(value.TMPDIR); expect(value.PI_SESSION_FILE).toBeUndefined();
  }
  expect(environments[0]?.PI_SESSION_ID).not.toBe(environments[1]?.PI_SESSION_ID);
  expect(environments[0]?.PI_TMP).not.toBe(environments[1]?.PI_TMP);
});

test("AC-P073 shell activity updates then clears at the actual tool boundary", async ({ page }) => {
  await open(page);
  const marker = `activity-${id(page)}`;
  const gate = join(env("PI_WEB_E2E_PROJECT_DIR"), `${marker}.gate`);
  const script = `node -e 'const f=require("node:fs"); console.log("shell-active"); const t=setInterval(()=>{if(f.existsSync(${JSON.stringify(gate)})){clearInterval(t)}},50)'`;
  await mock.script({ match: marker, turns: [[{ toolCall: { name: "bash", args: { command: script, description: "Fixture activity", foreground: true, timeout: 20 } } }], "shell complete"] });
  await send(page, marker);
  await expect.poll(async () => (await status(page)).activeToolExecutions?.length).toBe(1);
  try {
    await page.getByRole("region", { name: "Activity", exact: true }).getByRole("button").click();
    // Wait for the owned job projection too; otherwise the first status briefly shows only the built-in shell.
    await expect(page.getByRole("region", { name: "Activity", exact: true })).toContainText("Fixture activity");
    await expect(page.getByRole("region", { name: "Activity", exact: true })).toContainText("1 shell");
  }
  finally { await writeFile(gate, "release"); }
  await expect(chat(page).getByText("shell complete", { exact: true }).first()).toBeVisible();
  expect((await status(page)).activeToolExecutions ?? []).toEqual([]);
});

test("AC-P073 delegate self-report remains distinct from inferred tool activity", async ({ page }) => {
  await open(page); await choose(page, "openai-codex");
  const marker = `delegate-activity-${id(page)}`;
  await mock.script({ provider: "anthropic", match: marker, turns: [[{ toolCall: { name: "report_status", args: { status: "Checking the fixture contracts" } } }], [{ barrier: marker }, { text: "delegate complete" }]] });
  const launched = await tool(page, "subagent", { task: marker, profile: "scout", cognitiveRole: "routine", modelOverride: "anthropic/claude-sonnet-5-5", background: true });
  expect(launched.isError, text(launched.content)).toBe(false);
  await mock.waitForBarrier(marker);
  try {
    await expect.poll(async () => (await status(page)).extensionStatuses?.["pi-workbench:activity"]).toContain("Checking the fixture contracts");
    await page.getByRole("region", { name: "Activity", exact: true }).getByRole("button").click();
    await expect(page.getByRole("region", { name: "Activity entries" })).toContainText("Status: Checking the fixture contracts");
    const roster = JSON.parse((await status(page)).extensionStatuses!["pi-workbench:activity"]!) as { items: { activity: string; reportedStatus: string }[] };
    expect(roster.items[0]?.activity).not.toBe(roster.items[0]?.reportedStatus);
  } finally { await mock.release(marker); }
  await expect.poll(async () => JSON.stringify((await status(page)).extensionStatuses)).toContain("endedAt");
  await expect.poll(async () => (await status(page)).isStreaming).toBe(false);
  await tool(page, "subagent_collect", {});
  expect((await status(page)).extensionStatuses?.["pi-workbench:activity"]).toBeUndefined();
});

test("AC-P101 telemetry survives reopen without duplicate usage and includes child lineage", async ({ page }) => {
  await open(page); await turn(page);
  const events = async () => (await Promise.all((await readdir(join(root(), "telemetry"))).map(async (name) => (await readFile(join(root(), "telemetry", name), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)))).flat().filter((event) => event["sessionId"] === id(page));
  const before = await events(); const usage = before.filter((e) => e["type"] === "usage"); expect(usage.length).toBeGreaterThan(0);
  const totals = (await status(page)).tokens; await kill(page);
  expect((await events()).filter((e) => e["type"] === "usage")).toEqual(usage); expect((await status(page)).tokens).toEqual(totals);
  expect(before.find((e) => e["type"] === "session.start")?.["sessionFile"]).toBeNull();
  // A launch exercises real child telemetry, not fabricated export fixtures.
  const child = await tool(page, "subagent", { task: "fixture child telemetry", profile: "scout", cognitiveRole: "routine", modelOverride: "anthropic/claude-sonnet-5-5" });
  expect(child.isError, text(child.content)).toBe(false);
  const exported = (await Promise.all((await readdir(join(root(), "telemetry"))).map((name) => readFile(join(root(), "telemetry", name), "utf8")))).join("\n");
  expect(exported).toContain(`"parentSessionId":"${id(page)}"`);
});
