// AC-P001 P002 P024 P027 P028 P029 P030 P031 P032 P033 P037 P038 P039 P040 P050 P051.
// Missing parity deliberately fails (never test.fail()). Evidence is retained by Playwright and the mock journal.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test, expect, mock, setup, create, send, answer, idle, status, messages, asks, scriptAsk, ASK, get, post, id, chat, killHost, project, root, url, base, query, fixtureFile } from "./support";
setup();
const chips = (page: import("@playwright/test").Page) => page.locator("workbench-question-chips .chip");

test("AC-P001: create Durable and legacy neighbors; capability removal hides creation", async ({ page }) => {
  const durable = await create(page);
  const legacy = await create(page, "legacy");
  const listing = await (await page.request.get(`${base()}api/sessions?${query()}`)).json() as { id: string; path: string }[];
  expect(listing.filter((s) => s.id === durable)).toHaveLength(1);
  expect(listing.find((s) => s.id === durable)?.path).toBe(`durable:${durable}`);
  expect(listing.filter((s) => s.id === legacy)).toHaveLength(1);
  expect(listing.find((s) => s.id === legacy)?.path).not.toMatch(/^durable:/);
  await page.route("**/api/machines/*/runtime*", async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    await route.fulfill({ response, body: text.replaceAll('"sessions.durable-chats"', '"fixture.disabled"') });
  });
  await page.goto(url());
  await expect(page.getByRole("button", { name: "New Chat", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Durable Chat" })).toHaveCount(0);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(0);
});

test("AC-P002: catalogs contain each Chat once; recent sorted; exact link locates without a turn", async ({ page }) => {
  const first = await create(page);
  await send(page, "catalog-first");
  await answer(page, "echo: catalog-first");
  const otherWorkspace = join(root(), "catalog-workspace");
  await mkdir(otherWorkspace, { recursive: true });
  const second = (await (await page.request.post(`${base()}api/sessions`, { data: { cwd: otherWorkspace, runtime: "durable" } })).json() as { id: string }).id;
  const legacy = await create(page, "legacy");
  await send(page, "catalog-legacy");
  await answer(page, "echo: catalog-legacy");
  const listing = await (await page.request.get(`${base()}api/sessions/recent?limit=100`)).json() as { id: string; modified: string }[];
  for (const session of [first, second, legacy]) expect(listing.filter((s) => s.id === session)).toHaveLength(1);
  expect(listing.map((s) => s.modified)).toEqual(listing.map((s) => s.modified).sort().reverse());
  await page.goto(`${base()}?session=${second}&view=chat`);
  await expect(chat(page)).toBeVisible();
  const located = await (await page.request.get(`${base()}api/sessions/locate/${second}`)).json() as { cwd: string };
  expect(located.cwd).toBe(otherWorkspace);
  expect(id(page)).toBe(second);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(2);
});

test("AC-P024: dismissing a session warning must be a supported operation", async ({ page }) => {
  await create(page);
  const response = await post(page, id(page), "warnings/dismiss", { dismissId: "fleet-warning" });
  expect(await response.text(), "in-scope warning dismissal must not return unsupported").not.toContain("not available in Durable Chats");
});

for (const runtime of ["durable", "legacy"] as const) {
  test(`AC-P028 ${runtime}: retain extension warnings; dismiss through observed watermark only`, async ({ page }) => {
    // Local stub occupies a supported package slot; it emits actual non-command ExtensionUI notifications.
    const fixture = join(root(), "notification-fixture");
    const receipts = join(fixture, "receipts.jsonl");
    await fixtureFile("notification-fixture/package.json", JSON.stringify({ name: "pi-process-monitor", version: "0.0.0", type: "module", pi: { extensions: ["./index.mjs"] } }));
    await fixtureFile("notification-fixture/index.mjs", `import { appendFileSync } from 'node:fs';
export default function(pi) {
  const notify = (ctx, text) => { ctx.ui.notify(text, 'warning'); appendFileSync(${JSON.stringify(receipts)}, text + '\\n'); };
  pi.on('session_start', (_e, ctx) => { notify(ctx, 'fleet-notice-A'); notify(ctx, 'fleet-notice-B'); });
  pi.on('before_agent_start', (_e, ctx) => { notify(ctx, 'fleet-notice-C'); });
}`);
    const settingsPath = join(root(), runtime === "durable" ? "durable-agent/settings.json" : "agent/settings.json");
    const original = await readFile(settingsPath, "utf8");
    const settings = JSON.parse(original) as { packages?: string[]; extensions?: string[] };
    await writeFile(settingsPath, JSON.stringify(runtime === "durable"
      ? { ...settings, packages: [...settings.packages ?? [], fixture] }
      : { ...settings, extensions: [...settings.extensions ?? [], join(fixture, "index.mjs")] }));
    try {
      const session = await create(page, runtime);
      expect(await readFile(receipts, "utf8")).toContain("fleet-notice-B");
      const inbox = async () => (await (await get(page, session, "notifications")).json()) as { daemonInstanceId: string; notifications: { id: string; message: string }[]; dismissThrough: { order: number; overflowWatermark: number } };
      const observed = await inbox();
      expect(observed.notifications).toHaveLength(2);
      await send(page, "notification-check");
      await answer(page, "echo: notification-check");
      await expect.poll(async () => (await inbox()).notifications.length).toBe(3);
      await post(page, session, "notifications/dismiss", { daemonInstanceId: observed.daemonInstanceId, notificationId: observed.notifications[0]!.id });
      await post(page, session, "notifications/dismiss-all", { daemonInstanceId: observed.daemonInstanceId, throughOrder: observed.dismissThrough.order, throughOverflowWatermark: observed.dismissThrough.overflowWatermark });
      expect((await inbox()).notifications.map((n) => n.message)).toEqual(["fleet-notice-C"]);
    } finally { await writeFile(settingsPath, original); }
  });
}

for (const runtime of ["durable", "legacy"] as const) {
  test(`AC-P027 ${runtime}: stale unread acknowledgement cannot erase a newer completion`, async ({ page }) => {
    const session = await create(page, runtime);
    await mock.script({ match: session, turns: ["First unseen.", "Second unseen."] });
    await page.goto(url());
    const catalog = async () => (await (await page.request.get(`${base()}api/sessions/unread`)).json()) as { catalogId: string; sessions: { sessionId: string; completionOrder: number }[] };
    await post(page, session, "prompt", { text: session });
    await expect.poll(async () => (await catalog()).sessions.find((s) => s.sessionId === session)?.completionOrder ?? 0).toBeGreaterThan(0);
    const old = await catalog();
    const oldOrder = old.sessions.find((s) => s.sessionId === session)!.completionOrder;
    await idle(page, session);
    await post(page, session, "prompt", { text: "second" });
    await expect.poll(async () => (await catalog()).sessions.find((s) => s.sessionId === session)?.completionOrder ?? 0).toBeGreaterThan(oldOrder);
    const fresh = await catalog();
    const stale = await post(page, session, "unread/acknowledge", { catalogId: old.catalogId, throughCompletionOrder: oldOrder });
    expect(((await stale.json()) as typeof old).sessions.some((s) => s.sessionId === session)).toBe(true);
    const cleared = await post(page, session, "unread/acknowledge", { catalogId: fresh.catalogId, throughCompletionOrder: fresh.sessions.find((s) => s.sessionId === session)!.completionOrder });
    expect(((await cleared.json()) as typeof old).sessions.some((s) => s.sessionId === session)).toBe(false);
    expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(2);
  });

  test(`AC-P037 ${runtime}: questions return immediately; partial answer closes once and names unanswered items`, async ({ page }) => {
    const session = await create(page, runtime);
    await scriptAsk(session);
    await send(page, session);
    await answer(page, "Question posted.");
    await expect(chips(page)).toHaveCount(2);
    const [before] = (await asks(page)).pendingAsks;
    if (runtime === "durable") await killHost(page);
    await page.reload();
    await expect(chips(page)).toHaveCount(2);
    expect((await asks(page)).pendingAsks[0]?.askId).toBe(before!.askId);
    await mock.script({ match: session, turns: ["Answer received."] });
    await chips(page).first().click();
    await page.locator('workbench-question-chips input[value="stage"]').check();
    await page.locator("workbench-question-chips").getByRole("button", { name: "Send answers" }).click();
    await page.locator("workbench-question-chips").getByRole("button", { name: "Send anyway" }).click();
    await answer(page, "Answer received.");
    await expect(chips(page)).toHaveCount(0);
    const requests = await mock.journal({ kind: "chat", contains: session });
    expect(requests).toHaveLength(3);
    expect(requests[2]!.lastUserText).toContain("selected stage");
    expect(requests[2]!.lastUserText).toMatch(/unanswered/i);
    if (runtime === "durable") await killHost(page);
    await page.reload();
    await expect(chips(page)).toHaveCount(0);
    expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(3);
  });
}

test("AC-P037: revision rejects stale answers; cancel delivers once; withdraw delivers none", async ({ page }) => {
  const session = await create(page);
  await scriptAsk(session);
  await send(page, session);
  await answer(page, "Question posted.");
  const original = (await asks(page)).pendingAsks[0]!;
  await mock.script({ match: session, turns: [[{ toolCall: { name: "ask_user", args: { update: original.askId, context: "Revised context" } } }], "Revised."] });
  await send(page, "revise");
  await answer(page, "Revised.");
  const updated = (await asks(page)).pendingAsks[0]!;
  expect(updated.askId).toBe(original.askId);
  expect(updated.revision).not.toBe(original.revision);
  const stale = await post(page, session, "ask/submit", { askId: original.askId, revision: original.revision, answers: [] });
  expect((await stale.json() as { result: string }).result).toBe("stale");
  await mock.script({ match: session, turns: ["Cancellation received."] });
  expect((await post(page, session, "ask/cancel", { askId: original.askId, operationId: `cancel-${session}` })).ok()).toBe(true);
  await answer(page, "Cancellation received.");
  expect((await asks(page)).pendingAsks).toEqual([]);
  await scriptAsk(session);
  await send(page, "ask again");
  await expect(chips(page)).toHaveCount(2);
  await idle(page);
  const next = (await asks(page)).pendingAsks[0]!;
  await mock.script({ match: session, turns: [[{ toolCall: { name: "ask_user", args: { withdraw: next.askId } } }], "Withdrawn."] });
  await send(page, "withdraw");
  await answer(page, "Withdrawn.");
  await expect(chips(page)).toHaveCount(0);
  expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(9);
});

test("AC-P029 P038: background attention has exact IDs; stale ack and host kills preserve latest request", async ({ page }) => {
  const session = await create(page);
  // Observe global events at the actual browser WebSocket boundary (not a fabricated notification store).
  const events: { type: string; sessionId?: string; kind?: string; id?: string }[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => { try { events.push(JSON.parse(String(payload))); } catch { /* non-JSON frames */ } }));
  await page.goto(url());
  await mock.script({ match: session, turns: ["Ordinary done.", [{ toolCall: { name: "request_attention", args: { reason: "Review A" } } }], "A posted.", [{ toolCall: { name: "request_attention", args: { reason: "Review B" } } }], "B posted."] });
  await post(page, session, "prompt", { text: session });
  await expect.poll(async () => (await mock.journal({ kind: "chat", contains: session })).length).toBe(1);
  await idle(page, session);
  expect(events.filter((e) => e.type === "session.attention" && e.sessionId === session)).toEqual([]);
  await post(page, session, "prompt", { text: "attention A" });
  await expect.poll(async () => (await asks(page, session)).attentionRequest?.reason).toBe("Review A");
  await idle(page, session);
  const a = (await asks(page, session)).attentionRequest!;
  await post(page, session, "prompt", { text: "attention B" });
  await expect.poll(async () => (await asks(page, session)).attentionRequest?.reason).toBe("Review B");
  await idle(page, session);
  const b = (await asks(page, session)).attentionRequest!;
  expect(a.id).not.toBe(b.id);
  await killHost(page, session);
  expect((await asks(page, session)).attentionRequest?.id).toBe(b.id);
  expect((await (await post(page, session, "attention/acknowledge", { requestId: a.id })).json() as { acknowledged: boolean }).acknowledged).toBe(false);
  expect((await asks(page, session)).attentionRequest?.id).toBe(b.id);
  expect((await (await post(page, session, "attention/acknowledge", { requestId: b.id })).json() as { acknowledged: boolean }).acknowledged).toBe(true);
  await killHost(page, session);
  expect((await asks(page, session)).attentionRequest).toBeUndefined();
  await expect.poll(() => events.filter((e) => e.type === "session.attention" && e.sessionId === session).length).toBe(2);
  expect((await asks(page, session)).pendingAsks).toEqual([]);
  expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(5);
  await scriptAsk(session);
  await post(page, session, "prompt", { text: "background question" });
  await expect.poll(async () => (await asks(page, session)).pendingAsks.length).toBe(1);
  await idle(page, session);
  await killHost(page, session);
  await page.goto(url(session));
  await expect(chips(page)).toHaveCount(2);
  await expect.poll(() => events.filter((e) => e.type === "session.attention" && e.sessionId === session).length).toBe(3);
  expect(events.filter((e) => e.type === "session.attention" && e.sessionId === session && e.kind === "ask")).toHaveLength(1);
  expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(7);
});

test("AC-P039: each prompt gets one reminder per open set, none after closure, including host reopen", async ({ page }) => {
  const session = await create(page);
  await mock.script({ match: session, turns: [[{ toolCall: { name: "ask_user", args: ASK } }, { toolCall: { name: "ask_user", args: { ...ASK, context: "Second set" } } }], "Two sets posted.", "Unrelated answered.", "After kill answered."] });
  await send(page, session);
  await answer(page, "Two sets posted.");
  const open = (await asks(page)).pendingAsks;
  expect(open).toHaveLength(2);
  await send(page, "unrelated");
  await answer(page, "Unrelated answered.");
  await killHost(page);
  await page.reload();
  await send(page, "after kill");
  await answer(page, "After kill answered.");
  for (const entry of (await mock.journal({ kind: "chat", contains: session })).slice(-2)) {
    for (const ask of open) expect(entry.lastUserText.split(ask.askId).length - 1).toBe(1);
  }
  expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(3);
  await mock.script({ match: session, turns: [[...open.map((ask) => ({ toolCall: { name: "ask_user", args: { withdraw: ask.askId } } }))], "Closed.", "No reminders."] });
  await send(page, "close sets");
  await answer(page, "Closed.");
  await send(page, "no questions");
  await answer(page, "No reminders.");
  expect((await mock.journal({ kind: "chat", contains: session })).at(-1)!.lastUserText).not.toContain("open question");
});

test("AC-P040: chips count individual questions, stale begins at six turns, confirmation resets age", async ({ page }) => {
  const session = await create(page);
  await mock.script({ match: session, turns: [[{ toolCall: { name: "ask_user", args: ASK } }, { toolCall: { name: "ask_user", args: { ...ASK, context: "Second ordered set" } } }], "Question posted."] });
  await send(page, session);
  await answer(page, "Question posted.");
  await expect(chips(page)).toHaveCount(4);
  const open = (await asks(page)).pendingAsks;
  const ask = open[0]!;
  expect(await chips(page).evaluateAll((elements) => elements.map((element) => element.getAttribute("data-ask")))).toEqual([open[0]!.askId, open[0]!.askId, open[1]!.askId, open[1]!.askId]);
  await mock.script({ match: session, turns: Array.from({ length: 6 }, (_, n) => `Turn ${n + 1}.`) });
  for (let n = 1; n <= 6; n++) {
    await send(page, `turn ${n}`);
    await answer(page, `Turn ${n}.`);
    await chips(page).first().click();
    const drawer = page.locator("workbench-question-chips .drawer");
    if (n === 5) await expect(drawer).not.toContainText("may be stale");
    if (n === 6) await expect(drawer).toContainText("may be stale");
    await page.getByRole("button", { name: "Close questions", exact: true }).click();
  }
  await mock.script({ match: session, turns: [[{ toolCall: { name: "ask_user", args: { update: ask.askId } } }], "Confirmed."] });
  await send(page, "confirm");
  await answer(page, "Confirmed.");
  expect((await asks(page)).pendingAsks[0]!.turnsSinceUpdate).toBeLessThan(2);
});

test("AC-P031: first prompt gets generated title; /name remains authoritative", async ({ page }) => {
  const session = await create(page);
  const listing = async () => (await (await page.request.get(`${base()}api/sessions?${query()}`)).json()) as { id: string; name?: string }[];
  await mock.script({ match: session, turns: ["Substantive answer.", "Another answer."] });
  await send(page, `Please review this substantial migration plan ${session}`);
  await answer(page, "Substantive answer.");
  await expect.poll(async () => (await listing()).find((s) => s.id === session)?.name).toBe("Durable · Mock title");
  await send(page, "/name Explicit owner title");
  await send(page, "continue");
  await answer(page, "Another answer.");
  expect((await listing()).find((s) => s.id === session)?.name).toBe("Durable · Explicit owner title");
});

test("AC-P031: manual /name survives later prompts and host kill", async ({ page }) => {
  const session = await create(page);
  const listing = async () => (await (await page.request.get(`${base()}api/sessions?${query()}`)).json()) as { id: string; name?: string }[];
  await send(page, "/name Owner title");
  await expect.poll(async () => (await listing()).find((s) => s.id === session)?.name).toBe("Durable · Owner title");
  await mock.script({ match: session, turns: ["Named response."] });
  await send(page, session);
  await answer(page, "Named response.");
  await killHost(page);
  await page.reload();
  expect((await listing()).find((s) => s.id === session)?.name).toBe("Durable · Owner title");
  expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(1);
});

test("AC-P032: checkpoint title command is recognized without model admission", async ({ page }) => {
  await create(page);
  const response = await post(page, id(page), "commands/run", { text: "/workstream-checkpoint-title Checkpoint fixture" });
  const result = await response.json() as { type: string; message?: string };
  expect(result.type, result.message).toBe("done");
  expect(await mock.journal({ kind: "chat" })).toHaveLength(0);
});

test("AC-P033: Durable launch token resolves the same Chat without a duplicate", async ({ page }) => {
  await create(page);
  const token = `pi-web:fleet-${id(page)}`;
  const response = await page.request.post(`${base()}api/sessions`, { data: { cwd: project(), runtime: "durable", startupToken: token } });
  expect(response.ok()).toBe(true);
  const created = await response.json() as { id: string };
  const lookup = await page.request.get(`${base()}api/sessions/workstream-launch/${encodeURIComponent(token)}?${query()}`);
  expect(await lookup.json()).toEqual(expect.objectContaining({ sessionId: created.id }));
});

test("AC-P030: activity distinguishes streaming, tool and idle", async ({ page }) => {
  const session = await create(page);
  const events: { type: string; activity?: { label: string } }[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => { try { events.push(JSON.parse(String(payload))); } catch { /* non-JSON */ } }));
  await page.reload();
  await mock.script({ match: session, turns: [[{ text: "Thinking now" }, { barrier: session }, { toolCall: { name: "read", args: { path: "docs/notes.md" } } }], "Done reading."] });
  await send(page, session);
  await mock.waitForBarrier(session);
  expect((await status(page)).isStreaming).toBe(true);
  await mock.release(session);
  await answer(page, "Done reading.");
  const labels = events.filter((e) => e.type === "activity.update").map((e) => e.activity?.label);
  expect(labels).toContain("agent running");
  expect(labels).toContain("idle");
  expect(labels.some((label) => label?.toLowerCase().includes("read")), "activity needs a per-tool label, not only agent running/idle").toBe(true);
});

test("AC-P050: unsupported fork/archive hidden and API rejects without mutation", async ({ page }) => {
  const session = await create(page);
  await mock.script({ match: session, turns: ["Control check."] });
  await send(page, session);
  await answer(page, "Control check.");
  if (process.env["FLEET_NEGATIVE"] === "attention") {
    // Disable the supported attachment capability at the API boundary; the ordinary control assertion must fail.
    await page.route(/\/sessions\/[^/]+\/(status|transcript-snapshot)\?/, async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { capabilities?: string[]; status?: { capabilities: string[] } };
      const projected = body.status ?? body;
      projected.capabilities = (projected.capabilities ?? []).filter((capability) => capability !== "attachments");
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(chat(page)).toBeVisible();
  }
  await expect(chat(page).locator('[aria-label="Clone session from this message"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
  const before = await messages(page);
  const response = await post(page, session, "archive");
  expect(response.ok()).toBe(false);
  expect(await response.text()).toContain("not available in Durable Chats");
  expect(await messages(page)).toEqual(before);
});

for (const resolution of ["done", "not-done", "retry"] as const) {
  test(`AC-P051: interrupted write remains unresolved after two reopens until ${resolution}`, async ({ page }) => {
    const session = await create(page);
    const fifo = join(root(), `unsafe-${session}.fifo`);
    execFileSync("mkfifo", [fifo]);
    await mock.script({ match: session, turns: [[{ toolCall: { name: "write", args: { path: fifo, content: "effect" } } }]] });
    await send(page, session);
    await expect(chat(page).locator("tool-execution-view .tool-card.running")).toHaveCount(1);
    await killHost(page);
    await page.reload();
    const card = chat(page).locator(".unresolved-effects");
    await expect(card).toContainText("Needs reconciliation");
    await killHost(page);
    await page.reload();
    await expect(card).toContainText("Needs reconciliation");
    expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(1);
    await card.getByRole("button", { name: resolution === "done" ? "Done" : resolution === "not-done" ? "Not done" : "Retry", exact: true }).click();
    await expect(card).toHaveCount(0);
    await idle(page);
    const afterResolution = (await mock.journal({ kind: "chat", contains: session })).length;
    await killHost(page);
    await page.reload();
    await expect(card).toHaveCount(0);
    expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(afterResolution);
  });
}
