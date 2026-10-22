// AC-P058, AC-P071, AC-P078, AC-P079, AC-P080, AC-P081. Real WebKit + local Claude/Codex,
// marker-file effects and one-shot SIGKILL fault points (see fault-host.mjs).
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { alive, api, armCrash, chat, completions, effectCount, fixture, idle, killHost, messages, mock, newChat, reopen, send, setup, status, text, tool } from "./fleet";
setup();

for (const legacy of [false, true]) {
  test(`AC-P058 ${legacy ? "legacy" : "Durable"}: ! enters context, !! stays out, invalid and concurrent shell rejected`, async ({ page }) => {
    await newChat(page, legacy);
    const marker = `shell-${Date.now()}`;
    await send(page, `!printf '${marker}-included'`);
    await expect(chat(page).locator("article").filter({ hasText: `exit 0` }).last()).toContainText(`${marker}-included`);
    await send(page, `!!printf '${marker}-excluded'`);
    await expect(chat(page).locator("article").filter({ hasText: `exit 0` }).last()).toContainText(`${marker}-excluded`);
    await send(page, `context-${marker}`);
    await expect.poll(async () => (await mock.journal({ kind: "chat" })).length).toBe(1);
    const [request] = await mock.journal({ kind: "chat" });
    expect(JSON.stringify(request!.body)).toContain(`${marker}-included`);
    expect(JSON.stringify(request!.body)).not.toContain(`${marker}-excluded`);
    await idle(page);
    expect((await api(page, "shell", { text: "!" })).ok()).toBe(false);
    const gate = join(fixture().project, `${marker}.gate`);
    const running = api(page, "shell", { text: `!echo started > '${gate}.started'; while [ ! -e '${gate}' ]; do sleep .05; done` });
    await expect.poll(() => effectCount(`${gate}.started`)).toBe(1);
    expect((await api(page, "shell", { text: "!echo concurrent" })).ok()).toBe(false);
    await writeFile(gate, "go");
    expect((await running).ok()).toBe(true);
  });
}

for (const legacy of [false, true]) {
test(`AC-P071 ${legacy ? "legacy" : "Durable"} foreground stdout/stderr and nonzero exit remain an error, not a completion`, async ({ page }) => {
  await newChat(page, legacy);
  const result = await tool(page, "bash", { description: "Print stdout and stderr", command: "echo foreground-out; echo foreground-err >&2; exit 7", foreground: true });
  expect(result.isError).toBe(true);
  expect(text(result.content)).toContain("foreground-out");
  expect(text(result.content)).toContain("foreground-err");
  expect(text(result.content)).toContain("Command exited with code 7");
  const truncated = await tool(page, "bash", { description: "Print large foreground output", command: "for i in $(seq 1 3000); do echo foreground-$i-xxxxxxxxxx; done", foreground: true });
  expect(text(truncated.content)).toContain("showing recent output only");
  expect(text(truncated.content).length).toBeLessThan(13_000);
  expect(await completions(page)).toHaveLength(0);
});

test(`AC-P078 AC-P081 ${legacy ? "legacy" : "Durable"} default background returns before completion; one bounded card opens its full log`, async ({ page }) => {
  await newChat(page, legacy, true);
  const marker = join(fixture().project, `background-${Date.now()}`);
  const result = await tool(page, "bash", { description: "Count and print output", command: `echo launch >> '${marker}'; while [ ! -e '${marker}.go' ]; do sleep .05; done; for i in $(seq 1 3000); do echo line-$i-xxxxxxxxxx; done; exit 3` });
  expect(text(result.content)).toMatch(/^Background bash [0-9a-f-]{36} started/);
  expect(result.details?.state).toMatch(/pending|running/);
  expect(await effectCount(marker)).toBe(1);
  const record = JSON.parse(await readFile(join(fixture().root, "background-bash", result.details!.id!, "job.json"), "utf8")) as { startedAt: number; expiresAt: number };
  expect(record.expiresAt - record.startedAt).toBe(12 * 60 * 60 * 1000);
  expect(await completions(page)).toHaveLength(0);
  await writeFile(`${marker}.go`, "go");
  await expect.poll(async () => (await completions(page)).length).toBe(1);
  const [completion] = await completions(page);
  expect(completion!.details?.id).toBe(result.details?.id);
  expect(text(completion!.content)).toMatch(/failed \(exit 3\)/);
  expect(text(completion!.content)).toContain("showing recent output only");
  expect(text(completion!.content).length).toBeLessThan(13_000);
  await page.getByRole("button", { name: "Show full log" }).last().click();
  await expect(page.getByRole("dialog", { name: "Full log" })).toBeVisible();
  await expect(page.getByLabel("Log output")).toContainText("line-1-xxxxxxxxxx");
  await expect(page.getByLabel("Log output")).toContainText("line-3000-xxxxxxxxxx");
  await page.getByRole("dialog", { name: "Full log" }).getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Full log" }).getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close log" }).click();
  await idle(page);
  if (legacy) expect((await api(page, "stop", {})).ok()).toBe(true);
  else await killHost(page);
  await reopen(page);
  expect(await completions(page)).toHaveLength(1);
  expect(await effectCount(marker)).toBe(1);
});

test(`AC-P071 AC-P078 ${legacy ? "legacy" : "Durable"} foreground waits 30 seconds then hands off the same job once`, async ({ page }) => {
  await newChat(page, legacy);
  const marker = join(fixture().project, `foreground-${Date.now()}`);
  const start = Date.now();
  const result = await tool(page, "bash", { description: "Wait for release", command: `echo launch >> '${marker}'; while [ ! -e '${marker}.go' ]; do sleep .05; done; echo handoff-finished`, foreground: true });
  expect(Date.now() - start).toBeGreaterThanOrEqual(29_000);
  expect(text(result.content)).toContain("Still running after 30s; continued as background bash");
  expect(await effectCount(marker)).toBe(1);
  await writeFile(`${marker}.go`, "go");
  await expect.poll(async () => (await completions(page)).length).toBe(1);
  expect((await completions(page))[0]!.details?.id).toBe(result.details?.id);
  expect(await effectCount(marker)).toBe(1);
});

test(`AC-P078 ${legacy ? "legacy" : "Durable"} timeout reports failure rather than success`, async ({ page }) => {
  await newChat(page, legacy);
  await tool(page, "bash", { description: "Enforce timeout", command: "sleep 60", timeout: 1 });
  await expect.poll(async () => (await completions(page)).length).toBe(1);
  expect(text((await completions(page))[0]!.content)).toContain("Timed out after 1 seconds");
  expect((await completions(page))[0]!.details?.state).toBe("failed");
});

test(`AC-P079 AC-P080 AC-P081 ${legacy ? "legacy" : "Durable"} status and cancel respect ownership; cancelled completion never wakes a turn`, async ({ page, context }) => {
  const foreign = await context.newPage();
  await newChat(foreign, legacy);
  const other = await tool(foreign, "bash", { description: "Foreign running job", command: "sleep 90" });
  await newChat(page, legacy);
  const one = await tool(page, "bash", { description: "First running job", command: "printf 12345; sleep 90" });
  const two = await tool(page, "bash", { description: "Second running job", command: "sleep 90" });
  await expect.poll(async () => JSON.parse((await status(page)).extensionStatuses?.["pi-workbench:background-bash"] ?? "{}").jobs?.find((job: { id: string }) => job.id === one.details!.id)?.bytes, { timeout: 10_000 }).toBe(5);
  const list = await tool(page, "bash_status", {});
  expect(list.details?.jobs?.map((job) => job.id).sort()).toEqual([one.details!.id!, two.details!.id!].sort());
  for (const job of list.details!.jobs!) { expect(job.state).toBe("running"); expect(job.elapsedSeconds).toBeGreaterThanOrEqual(0); expect(job.logPath).toContain("output.log"); }
  const single = await tool(page, "bash_status", { id: one.details!.id });
  expect(single.details?.jobs).toHaveLength(1);
  expect(single.details?.jobs?.[0]?.bytes).toBe(5);
  expect(text((await tool(page, "bash_status", { id: other.details!.id })).content)).toContain("No matching");
  expect(text((await tool(page, "bash_cancel", { id: other.details!.id })).content)).toContain("No background bash job");
  expect(text((await tool(page, "bash_cancel", { id: "unknown" })).content)).toContain("No background bash job");
  const beforeCancel = (await mock.journal({ kind: "chat" })).length;
  const cancelled = await tool(page, "bash_cancel", { id: one.details!.id });
  expect(text(cancelled.content)).toContain("Cancellation requested");
  await expect.poll(async () => (await completions(page)).length).toBeGreaterThan(0);
  expect.soft(await completions(page), "one cancellation completion, not two").toHaveLength(1);
  expect((await completions(page))[0]!.details?.state).toBe("cancelled");
  expect(await mock.journal({ kind: "chat" })).toHaveLength(beforeCancel + 2);
  expect((await tool(foreign, "bash_status", { id: other.details!.id })).details?.jobs?.[0]?.state).toBe("running");
});

}

for (const point of ["bash.intent", "bash.spawned", "bash.admitted"]) {
  test(`AC-P071 AC-P078 AC-P079 AC-P080 AC-P081 SIGKILL at ${point}: one effect and one completion after reopen`, async ({ page }) => {
    await newChat(page);
    const marker = join(fixture().project, `crash-${point}-${Date.now()}`);
    const label = `crash-${point}-${Date.now()}`;
    const pid = await armCrash(page, point);
    await mock.script({ match: label, turns: [[{ toolCall: { name: "bash", args: { description: "Crash counted launch", command: `echo launch >> '${marker}'; echo crash-output` } } }], "original finished", "completion received", "resumed"] });
    await send(page, label);
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    if (point === "bash.intent") expect(await effectCount(marker)).toBe(0);
    await reopen(page);
    await send(page, `resume ${label}`);
    await expect.poll(() => effectCount(marker)).toBe(1);
    await expect.poll(async () => (await completions(page)).length, { timeout: 20_000 }).toBe(1);
    await idle(page);
    await killHost(page);
    await reopen(page);
    expect(await completions(page)).toHaveLength(1);
    expect(await effectCount(marker)).toBe(1);
    expect((await mock.journal({ kind: "chat" })).filter((entry) => /^Background bash .* (complete|failed) \(/.test(entry.lastUserText))).toHaveLength(1);
  });
}

test("AC-P071 AC-P078 Stop cancels a foreground wait; host SIGKILL leaves the runner alive", async ({ page }) => {
  await newChat(page);
  const marker = join(fixture().project, `stop-${Date.now()}`);
  const label = `stop-${Date.now()}`;
  await mock.script({ match: label, turns: [[{ toolCall: { name: "bash", args: { description: "Foreground survival", command: `echo launch >> '${marker}'; while [ ! -e '${marker}.go' ]; do sleep .05; done`, foreground: true } } }], "survived"] });
  await send(page, label);
  await expect.poll(() => effectCount(marker)).toBe(1);
  await killHost(page);
  await reopen(page);
  await send(page, "resume foreground");
  await expect(page.getByRole("button", { name: "Stop current work", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop current work", exact: true }).click();
  await expect.poll(async () => (await messages(page)).some((m) => m.toolName === "bash" && m.isError === true)).toBe(true);
  expect(await effectCount(marker)).toBe(1);
  const result = (await messages(page)).find((m) => m.toolName === "bash");
  expect(text(result?.content)).toMatch(/abort|cancel/i);
  if (result?.details?.id) {
    const exit = JSON.parse(await readFile(join(fixture().root, "background-bash", result.details.id, "exit"), "utf8")) as { cancelled: boolean };
    expect(exit.cancelled).toBe(true);
  }
});

test("AC-P078 AC-P079 AC-P081 lost runner reports unknown exit and never relaunches", async ({ page }) => {
  await newChat(page);
  const marker = join(fixture().project, `lost-runner-${Date.now()}`);
  const result = await tool(page, "bash", { description: "Runner identity check", command: `echo launch >> '${marker}'; sleep 90` });
  const dir = join(fixture().root, "background-bash", result.details!.id!);
  const claim = JSON.parse(await readFile(join(dir, "claim"), "utf8")) as { pid: number };
  await killHost(page);
  expect(alive(claim.pid)).toBe(true);
  await reopen(page);
  expect((await tool(page, "bash_status", { id: result.details!.id })).details?.jobs?.[0]?.state).toBe("running");
  await killHost(page);
  // The registry belongs to this test and the live identity was just verified by bash_status.
  process.kill(-claim.pid, "SIGKILL");
  await expect.poll(() => alive(claim.pid)).toBe(false);
  await reopen(page);
  await expect.poll(async () => (await completions(page)).length, { timeout: 10_000 }).toBe(1);
  expect(text((await completions(page))[0]!.content)).toMatch(/failed \(exit unknown\).*runner ended/s);
  expect(await effectCount(marker)).toBe(1);
});
