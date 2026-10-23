// AC-P003 P004 P005 P007 P011: execution ordering, failed-turn retention and visible Stop failures.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, mock, setup, create, send, answer, idle, status, messages, killHost, project } from "./support";
setup();

for (const phase of ["before admission", "after commit before browser acknowledgement"] as const) {
  test(`AC-P003: host kill ${phase} keeps one prompt under its original operation ID`, async ({ page }) => {
    const session = await create(page);
    const marker = `ack-window-${session}`;
    await mock.script({ match: marker, turns: [[{ text: "Held admitted prompt " }, { barrier: marker }]] });
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operations: string[] = [];
    await page.route("**/sessions/*/prompt", async (route) => {
      const payload = route.request().postDataJSON() as { operationId: string };
      operations.push(payload.operationId);
      if (operations.length !== 1) { await route.continue(); return; }
      if (phase === "after commit before browser acknowledgement") {
        const committed = await route.fetch();
        expect(committed.ok()).toBe(true);
      }
      reached();
      await gate;
      if (phase === "before admission") await route.continue();
      else await route.abort("failed"); // The browser loses the successful post-commit reply and retries its stable ID.
    });
    await send(page, marker);
    await barrier;
    if (phase === "after commit before browser acknowledgement") await mock.waitForBarrier(marker);
    expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(phase === "before admission" ? 0 : 1);
    await killHost(page);
    release();
    await expect.poll(async () => (await messages(page)).messages.filter((m) => m.role === "user").length).toBe(1);
    if (phase !== "before admission") await expect.poll(() => operations.length).toBeGreaterThan(1);
    expect(new Set(operations).size).toBe(1);
    expect(operations[0]).toEqual(expect.any(String));
    await mock.waitForBarrier(marker);
    expect(await mock.journal({ kind: "chat", contains: marker })).toHaveLength(1);
  });
}

test("AC-P004: steer reaches the tool boundary and follow-ups run in admission order", async ({ page }) => {
  const session = await create(page);
  await mock.script({ match: session, turns: [[{ barrier: session }, { toolCall: { name: "read", args: { path: "docs/notes.md" } } }], "Steering applied.", "First follow-up done.", "Second follow-up done."] });
  await send(page, session);
  await mock.waitForBarrier(session);
  await send(page, "steer-now", "Steer current response");
  await send(page, "follow-first", "Queue follow-up");
  await send(page, "follow-second", "Queue follow-up");
  expect((await status(page)).queuedMessages).toHaveLength(3);
  await mock.release(session);
  await answer(page, "Second follow-up done.");
  expect((await status(page)).queuedMessages).toEqual([]);
  const users = (await messages(page)).messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
  expect(users).toHaveLength(4);
  expect(users[1]).toContain("steer-now");
  expect(users[2]).toContain("follow-first");
  expect(users[3]).toContain("follow-second");
  expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(4);
});

test("AC-P003 P004 P007: failed turn retains waiting input through SIGKILL, without silently draining", async ({ page }) => {
  const session = await create(page);
  await mock.script({ match: session, turns: [[{ barrier: session }, { error: "invalid_request" }]] });
  await send(page, session);
  await mock.waitForBarrier(session);
  await send(page, "waiting-after-failure", "Queue follow-up");
  await mock.release(session);
  await idle(page);
  expect((await status(page)).queuedMessages.map((m) => m.text)).toEqual(["waiting-after-failure"]);
  await killHost(page);
  await page.reload();
  expect((await status(page)).queuedMessages.map((m) => m.text)).toEqual(["waiting-after-failure"]);
  expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(1);
});

test("AC-P005: completed shell effect is not replayed when the following generation is killed", async ({ page }) => {
  const session = await create(page);
  const effect = join(project(), `effects-${session}.txt`);
  await mock.script({ match: session, turns: [[{ toolCall: { name: "bash", args: { command: `printf effect >> '${effect}'`, description: "Fixture effect", foreground: true } } }], [{ text: "Effect finished streaming " }, { barrier: session }]] });
  await send(page, session);
  await mock.waitForBarrier(session);
  expect(await readFile(effect, "utf8")).toBe("effect");
  await killHost(page);
  await page.reload();
  expect(await readFile(effect, "utf8")).toBe("effect");
  expect((await messages(page)).messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
  expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(2);
});

test("AC-P011: Stop failure is visible and does not claim generation stopped", async ({ page }) => {
  const session = await create(page);
  await mock.script({ match: session, turns: [[{ text: "Stop failure fixture " }, { barrier: session }]] });
  await send(page, session);
  await mock.waitForBarrier(session);
  let refused = false;
  await page.route("**/sessions/*/abort", async (route) => { refused = true; await route.fulfill({ status: 400, json: { error: "fixture stop refused" } }); });
  await page.getByRole("button", { name: "Stop current work" }).click();
  await expect.poll(() => refused).toBe(true);
  await expect(page.getByText(/fixture stop refused/)).toBeVisible();
  expect((await status(page)).isStreaming).toBe(true);
});
