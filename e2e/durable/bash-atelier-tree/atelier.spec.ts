// AC-P075 / AC-P076: real Page-tab human actions, delivery counts and host-kill boundaries.
// Cross-Chat takeover is explicitly deferred. The check test re-enables the harness-disabled Page checker.
import { expect, test } from "@playwright/test";
import { alive, armCrash, deliveries, idle, killHost, messages, mock, newChat, reopen, send, setup, status, text, tool } from "./fleet";
import { comment, events, openAtelier } from "./atelier-fixture";
setup();

for (const legacy of [false, true]) {
test(`AC-P075 AC-P076 ${legacy ? "legacy" : "Durable"} Comment and Decision reach Chat once; answer, ask, update and request status reach the Page`, async ({ page, context }) => {
  await newChat(page, legacy);
  const { tab, file, name } = await openAtelier(page, context);
  const posted = await comment(tab, file, "Make the proposal clearer");
  expect(await deliveries(page)).toHaveLength(0); // still in the Kernel's undo window
  await expect.poll(async () => (await deliveries(page)).length, { timeout: 10_000 }).toBe(1);
  await idle(page);
  expect(text((await deliveries(page))[0]!.content)).toContain("Make the proposal clearer");
  expect((await tool(page, "atelier", { action: "answer", page: name, comment: posted.seq, text: "Clarified the proposal." })).isError).not.toBe(true);
  await tab.locator(`[data-atl="thread"][data-seq="${posted.seq}"]`).first().click();
  await expect(tab.getByRole("dialog", { name: "Thread on proposal" })).toContainText("Clarified the proposal.");
  await tab.getByRole("button", { name: "Close this box" }).click();
  await tab.getByRole("group", { name: "Decision on proposal" }).getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(async () => (await deliveries(page)).length, { timeout: 10_000 }).toBe(2);
  await idle(page);
  expect(text((await deliveries(page))[1]!.content)).toContain("Approve");
  await tool(page, "atelier", { action: "ask", page: name, decision: { id: "size", key: "proposal", question: "Which size?", options: [{ label: "Small", consequence: "Less detail" }, { label: "Large", consequence: "More detail" }] } });
  await expect(tab.getByText("Which size?", { exact: true })).toBeVisible();
  await tool(page, "atelier", { action: "update", page: name, text: "Proposal clarified" });
  expect((await events(file)).filter((event) => event.type === "update")).toHaveLength(1);
  await tab.getByRole("button", { name: "Run check", exact: true }).click();
  await expect.poll(async () => (await events(file)).filter((event) => event.type === "request").length).toBe(1);
  await expect.poll(async () => (await deliveries(page)).length, { timeout: 10_000 }).toBe(3);
  await idle(page);
  const request = (await events(file)).find((event) => event.type === "request")!;
  await tool(page, "atelier", { action: "status", page: name, request: request.seq, state: "running", text: "Checking now" });
  await expect(tab.getByText("Checking now", { exact: false }).first()).toBeVisible();
  const log = await events(file);
  expect(log.filter((event) => event.type === "received").flatMap((event) => event.of ?? [])).toContain(posted.seq);
  expect((await mock.journal({ kind: "chat" })).filter((entry) => entry.lastUserText.startsWith("Atelier"))).toHaveLength(3);
});

}

test("AC-P075 check measures the valid Page rather than reporting unchecked", async ({ page, context }) => {
  await newChat(page);
  const { name } = await openAtelier(page, context);
  await armCrash(page, "atelier.check-enabled");
  const checked = await tool(page, "atelier", { action: "check", page: name });
  expect(text(checked.content)).toMatch(/Page check/);
  expect(checked.details?.check?.views.length, text(checked.content)).toBeGreaterThan(0);
  expect(checked.details?.check?.unchecked).toEqual([]);
});

for (const legacy of [false, true]) {
test(`AC-P076 ${legacy ? "legacy" : "Durable"} Undo suppresses delivery; busy Chat receives exactly one follow-up after its turn`, async ({ page, context }) => {
  await newChat(page, legacy);
  const { tab, file } = await openAtelier(page, context);
  const undone = await comment(tab, file, "Undone comment must never arrive");
  await tab.getByRole("button", { name: /^Undo \(/ }).click();
  await expect.poll(async () => (await events(file)).some((event) => event.type === "undo" && event.target === undone.seq)).toBe(true);
  const marker = `busy-page-${Date.now()}`;
  await mock.script({ match: marker, turns: [[{ text: "Busy answer starts" }, { barrier: marker }, { text: " and finishes" }], "Page follow-up handled"] });
  await send(page, marker);
  await mock.waitForBarrier(marker);
  await comment(tab, file, "One follow-up while busy");
  // Legacy acknowledges on message consumption; Durable acknowledges admission. Both enqueue before the held turn ends.
  await expect.poll(async () => (await events(file)).filter((event) => event.type === "delivered").length, { timeout: 10_000 }).toBe(1);
  expect((await mock.journal({ contains: marker, kind: "chat" }))).toHaveLength(1);
  expect((await status(page)).isStreaming).toBe(true);
  await mock.release(marker);
  await expect.poll(async () => (await deliveries(page)).length).toBe(1);
  await idle(page);
  await expect.poll(async () => (await events(file)).filter((event) => event.type === "received").length).toBe(1);
  const transcript = await messages(page);
  const index = transcript.findIndex((m) => m.customType?.startsWith("atelier:"));
  expect(text(transcript[index - 1]?.content)).toContain("and finishes");
  expect(JSON.stringify(transcript)).not.toContain("Undone comment must never arrive");
  const journal = await mock.journal({ kind: "chat" });
  expect(journal.filter((entry) => entry.lastUserText.startsWith("Atelier"))).toHaveLength(1);
  expect(JSON.stringify(journal)).not.toContain("Undone comment must never arrive");
});

}

for (const point of ["append", "atelier.admitted", "atelier.received"]) {
  test(`AC-P075 AC-P076 SIGKILL at ${point}: same Page port and one delivery after reopen`, async ({ page, context }) => {
    await newChat(page);
    const { tab, file, url } = await openAtelier(page, context);
    const pid = point === "append" ? undefined : await armCrash(page, point);
    if (point !== "append") await tab.reload();
    const posted = await comment(tab, file, `Recover ${point} once`);
    if (point === "append") await killHost(page);
    else await expect.poll(() => alive(pid!), { timeout: 10_000 }).toBe(false);
    const before = await events(file);
    if (point === "append" || point === "atelier.admitted") expect(before.filter((event) => event.type === "received")).toHaveLength(0);
    else expect(before.filter((event) => event.type === "received")).toHaveLength(1);
    await reopen(page);
    if (point !== "append") await send(page, "Resume after host crash");
    await tab.goto(url); // exact URL, not a new tool-open result
    await expect(tab.getByRole("heading", { name: "Fleet proposal" })).toBeVisible();
    await expect.poll(async () => (await deliveries(page)).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => (await events(file)).filter((event) => event.type === "received" && event.of?.includes(posted.seq)).length).toBe(1);
    await idle(page);
    await killHost(page);
    await reopen(page);
    await tab.reload();
    expect(await deliveries(page)).toHaveLength(1);
    expect((await mock.journal({ kind: "chat" })).filter((entry) => entry.lastUserText.startsWith("Atelier"))).toHaveLength(1);
  });
}
