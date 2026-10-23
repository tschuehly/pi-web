// AC-P093, AC-P095–AC-P098: workers tool group, create/dispatch/status/retire, scoped continuity and leaf cancellation.
import { base, call, control, create, expect, idOf, killHost, messages, mock, project, requests, row, scout, status, tc, test, textOf, tools } from "./support";

async function worker(page: Parameters<typeof call>[0]) {
  expect(textOf(await call(page, "tools_enable", { group: "workers" }))).toMatch(/worker/i);
  const before = (await mock.journal({ kind: "chat" })).length;
  const made = await call(page, "worker_create", { name: "Scope keeper", scope: "the fixture parser", profile: "coordinator" });
  expect(made.isError).not.toBe(true);
  expect(made.details).toMatchObject({ name: "Scope keeper", scope: "the fixture parser", profile: "coordinator", lineage: [], lock: null, repositoryRoot: process.env["PI_WEB_E2E_PROJECT_DIR"] });
  expect((await mock.journal({ kind: "chat" })).length).toBe(before + 2); // Only the lead tool call and acknowledgement.
  return String(made.details!["workerId"]);
}

test("AC-P095 AC-P096 AC-P097 AC-P098 Worker lifecycle: busy lock, leaf settlement, fresh binding with continuity, retirement survives kill", async ({ page }) => {
  await create(page);
  const workerId = await worker(page);
  const marker = `coordinator-${Date.now()}`;
  const leaf = `leaf-${Date.now()}`;
  const leafScript = await mock.script({ provider: "openai-codex", match: leaf, turns: [
    [{ barrier: leaf }, tc("subagent", scout("forbidden-third-level"))],
    "Leaf complete.",
  ] });
  const workerScript = await mock.script({ provider: "anthropic", match: marker, turns: [
    [tc("worker_create", { name: "forbidden", scope: "nested", profile: "scout" }), tc("subagent", scout(leaf))],
    "Worker waits for its leaf.",
    [tc("subagent_collect")],
    "Worker result after leaf collection.",
  ] });
  const dispatch = await call(page, "worker_dispatch", { workerId, task: marker, cognitiveRole: "coordination", background: true });
  expect(textOf(dispatch)).toContain("anthropic/claude-opus-5-5:medium (coordinator · coordination)");
  await mock.waitForBarrier(leaf);
  const busy = await call(page, "worker_status", { workerId });
  expect(textOf(busy)).toContain("[dispatching]");
  expect(textOf(busy)).toContain(idOf(dispatch));
  expect(textOf(await call(page, "worker_dispatch", { workerId, task: "must not queue", cognitiveRole: "routine" }))).toContain("is busy with dispatch");
  expect(textOf(await call(page, "worker_retire", { workerId, reason: "must not seize busy work" }))).toContain("is busy with dispatch");
  await mock.release(leaf);
  await expect.poll(async () => (await requests(workerScript)).length).toBe(4);
  await expect.poll(async () => JSON.stringify(await status(page))).toContain('success');
  const result = await call(page, "subagent_collect");
  expect(textOf(result)).toContain("Worker result after leaf collection.");
  expect(textOf(result)).toContain("outcome success");
  const first = await requests(workerScript);
  expect(first.map((r) => r.model)).toEqual(Array(4).fill("claude-opus-5-5"));
  expect(JSON.stringify(first[1]!.body)).toMatch(/worker_create.*(?:not found|not available|unknown|not registered)/is);
  const child = await requests(leafScript);
  expect(tools(child[0]!).map((t) => t.name)).not.toContain("subagent");
  expect(JSON.stringify(child[1]!.body)).toMatch(/subagent.*(?:not found|not available|unknown|not registered)/is);
  expect(JSON.stringify(first[3]!.body)).toContain("Leaf complete.");

  const next = `worker-second-${Date.now()}`;
  const secondScript = await mock.script({ provider: "openai-codex", match: next, turns: ["Second dispatch complete."] });
  const second = await call(page, "worker_dispatch", { workerId, task: next, cognitiveRole: "routine", background: false });
  expect(idOf(second)).not.toBe(idOf(dispatch));
  expect(textOf(second)).toContain("openai-codex/gpt-6-luna:medium");
  expect(JSON.stringify((await requests(secondScript))[0]!.body)).toContain("Worker result after leaf collection.");
  expect((await call(page, "worker_dispatch", { workerId, task: "review must be fresh", cognitiveRole: "review" })).isError).toBe(true);
  const diagnostic = await call(page, "worker_status", { workerId });
  const record = diagnostic.details!["worker"] as { receipts: unknown[]; lineage: number[]; lock: unknown };
  expect(record.receipts).toHaveLength(2);
  expect(new Set(record.lineage).size).toBe(2);
  expect(record.lock).toBeNull();
  expect(textOf(await call(page, "worker_retire", { workerId, reason: "scope finished" }))).toContain("scope finished");
  await killHost(page);
  await status(page);
  await page.reload();
  expect(textOf(await call(page, "worker_dispatch", { workerId, task: "retired must not run", cognitiveRole: "routine" }))).toContain("was retired");
  expect(textOf(await call(page, "worker_status", { workerId }))).toMatch(/retired.*scope finished/);
  expect(textOf(await call(page, "worker_status"))).toContain("No active durable workers");
  expect(textOf(await call(page, "worker_status", { all: true }))).toContain(workerId);
});

for (const cancel of ["leaf", "worker"] as const) {
  test(`AC-P093 ${cancel} cancellation ${cancel === "leaf" ? "keeps Worker alive" : "reaches all leaves"}`, async ({ page }) => {
    await create(page);
    const workerId = await worker(page);
    const marker = `cancel-worker-${Date.now()}`;
    const leaf = `cancel-leaf-${Date.now()}`;
    const leafScript = await mock.script({ provider: "openai-codex", match: leaf, turns: [[{ barrier: leaf }, { text: "A cancelled leaf must never return this." }]] });
    const workerScript = await mock.script({ provider: "anthropic", match: marker, turns: [
      [tc("subagent", scout(leaf))],
      [{ barrier: marker }, { text: "Worker survived cancelling its leaf." }],
    ] });
    const dispatch = await call(page, "worker_dispatch", { workerId, task: marker, cognitiveRole: "coordination", background: true });
    await mock.waitForBarrier(leaf);
    await mock.waitForBarrier(marker);
    if (cancel === "leaf") {
      const request = (await requests(workerScript))[1]!;
      const leafId = /Launched subagent ([0-9a-f-]{36})/.exec(JSON.stringify(request.body))![1]!;
      // Replace the held no-op answer with a real cancel tool call at the Worker's next boundary.
      await mock.script({ provider: "anthropic", match: marker, turns: [[tc("subagent_cancel", { executionId: leafId })], "Worker survived cancelling its leaf."] });
      await call(page, "subagent_steer", { executionId: idOf(dispatch), message: "Cancel your leaf, then finish." });
      await mock.release(marker);
      await expect.poll(async () => (await requests(leafScript))[0]!.outcome).toBe("client-closed");
      await expect.poll(async () => JSON.stringify(await status(page))).toContain("success");
      expect(textOf(await call(page, "subagent_collect"))).toContain("Worker survived cancelling its leaf.");
    } else {
      const result = await call(page, "subagent_cancel", { executionId: idOf(dispatch), reason: "Cancel the whole Worker tree" });
      expect(textOf(result)).toBe(`${idOf(dispatch)}: cancelled.`);
      expect((await requests(leafScript))[0]!.outcome).toBe("client-closed");
      expect((await requests(workerScript))[1]!.outcome).toBe("client-closed");
      await mock.release(leaf);
      await mock.release(marker);
      expect((await messages(page)).filter((m) => m.customType === "pi-workbench:child-completion")).toHaveLength(0);
    }
    const diagnostic = await call(page, "worker_status", { workerId });
    const record = diagnostic.details!["worker"] as { receipts: { outcome: string }[]; lock: unknown };
    expect(record.lock).toBeNull();
    expect(record.receipts.map((r) => r.outcome)).toEqual([cancel === "leaf" ? "success" : "cancelled"]);
  });
}

for (const foreign of [false, true]) {
  test(`AC-P090 AC-P097 AC-P098 AC-P099 ${foreign ? "foreign diagnostic Worker grants no control" : "receipt failure is unknown, collect is an error and redispatch requires inspection"}`, async ({ page }) => {
    const session = await create(page);
    const workerId = await worker(page);
    if (!foreign) {
      const marker = `unknown-receipt-${Date.now()}`;
      await mock.script({ provider: "openai-codex", match: marker, turns: ["Completed work, but its receipt will be lost."] });
      await call(page, "worker_dispatch", { workerId, task: marker, cognitiveRole: "routine", background: true });
      await expect(row(page).locator(".status")).toHaveText("To collect");
    }
    // Inject only the Given state, with the host closed, not the behavior being tested. The real UI/tools must enforce it.
    expect((await page.request.post(`${base()}api/sessions/${encodeURIComponent(session)}/stop`, { data: { cwd: project() } })).ok()).toBe(true);
    await control({ receiptFault: { workerId, foreign } });
    await status(page);
    await page.reload();
    if (foreign) {
      expect(textOf(await call(page, "worker_status"))).toContain("No active durable workers");
      expect((await call(page, "worker_status", { workerId })).isError).toBe(true);
      const diagnostic = await call(page, "worker_status", { workerId, all: true });
      expect(diagnostic.details!["owned"]).toBe(false);
      expect(textOf(diagnostic)).toContain("owned by another lead Chat");
      expect(textOf(await call(page, "worker_status", { all: true }))).toContain(workerId);
      expect(textOf(await call(page, "worker_dispatch", { workerId, task: "must not seize", cognitiveRole: "routine" }))).toContain("belongs to another lead Chat");
      expect(textOf(await call(page, "worker_retire", { workerId, reason: "must not seize" }))).toContain("belongs to another lead Chat");
    } else {
      await expect(row(page).locator(".status")).toContainText(/unknown/i);
      const diagnostic = await call(page, "worker_status", { workerId });
      expect(textOf(diagnostic)).toContain("[needs inspection]");
      expect(textOf(diagnostic)).toContain("Fixture receipt acknowledgement lost");
      expect(textOf(await call(page, "worker_dispatch", { workerId, task: "must not run without acknowledgement", cognitiveRole: "routine" }))).toContain("requires inspection");
      const collected = await call(page, "subagent_collect");
      expect(collected.isError).toBe(true);
      expect(textOf(collected)).toContain("outcome_unknown");
      expect(textOf(collected)).not.toContain("outcome success");
      const marker = `inspected-worker-${Date.now()}`;
      const script = await mock.script({ provider: "openai-codex", match: marker, turns: ["Inspected dispatch complete."] });
      expect(textOf(await call(page, "worker_dispatch", { workerId, task: marker, cognitiveRole: "routine", acknowledgeInspection: true }))).toContain("Inspected dispatch complete.");
      expect(await requests(script)).toHaveLength(1);
      const after = (await call(page, "worker_status", { workerId })).details!["worker"] as { requiresInspection: unknown; receipts: { outcome: string }[] };
      expect(after.requiresInspection).toBeNull();
      expect(after.receipts.map((r) => r.outcome)).toEqual(["outcome_unknown", "success"]);
    }
  });
}
