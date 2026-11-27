/** Live review (`/pair`): the main Chat makes a wrong edit, its reviewer gets a digest and steers it; the steer lands at the main Chat's next tool call. */
import { test, expect, mock, createChat, answer, messages, text, command, idle, chat, send } from "./support";

test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });
test.setTimeout(120_000);

test("/pair: a wrong edit reaches the reviewer as a digest; its urgent message steers the main Chat at its next tool call", async ({ page }) => {
  const tag = Date.now().toString(36);
  const mainKey = `main${tag}-review-chat`;
  const [file, held, finding] = [`sum-${tag}.js`, `held-${tag}`, `sum-${tag}.js:1 off by one: the loop must stop at i < n`];

  const main = await createChat(page);
  await command(page, main, `/name Main${tag} review chat`);
  await mock.script({ provider: "anthropic", match: `hello-${tag}`, turns: ["Main ready."] });
  await answer(page, main, `hello-${tag}`, "Main ready.");
  // The default reviewer: openai/gpt-6.2-sol at thinking low; every edit sends a digest.
  await command(page, main, "/pair --trigger edits");

  // The reviewer (the mock's openai path) answers the first digest with one urgent finding, later ones with "ok".
  await mock.script({
    provider: "openai",
    match: "Live review digest",
    turns: [[{ toolCall: { name: "send_chat_message", args: { chat: mainKey, text: finding, urgent: true } } }], "ok"],
  });
  // The main Chat writes the bug, then its next request waits at a barrier until the reviewer's message is in.
  await mock.script({
    provider: "anthropic",
    match: `task-${tag}`,
    turns: [
      [{ toolCall: { name: "write", args: { path: file, content: "for (let i = 0; i <= n; i++) total += xs[i];\n" } } }],
      [{ barrier: held }, { toolCall: { name: "read", args: { path: file } } }],
      "Fixed after review.",
    ],
  });
  await send(page, `task-${tag}: sum the list in ${file}`);
  await mock.waitForBarrier(held, 60_000);

  // The reviewer got the digest: its label names the main Chat, the turn and the knobs; the write's arguments are the diff.
  await expect.poll(async () => (await mock.journal({ provider: "openai", contains: "Live review digest" })).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const body = JSON.stringify((await mock.journal({ provider: "openai", contains: "Live review digest" }))[0]?.body);
  expect(body).toContain(`Live review digest · ${mainKey} · turn 1 · trigger edits · brief silent`);
  expect(body).toContain("Tool call write");
  expect(body).toContain("i <= n");
  expect(body).toContain(`Files touched: ${file}`);
  expect(body).toContain("Stay silent unless");
  // Its message was delivered as a steer of the running turn, without limits or a hop.
  await expect
    .poll(async () => (await mock.journal({ provider: "openai", contains: "it steers the chat's current turn" })).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await mock.release(held);

  await expect(chat(page).getByText("Fixed after review.", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await idle(page, main);
  // The steer landed after the held turn's read call: in the third request, not the second.
  const requests = await mock.journal({ provider: "anthropic", kind: "chat", contains: `task-${tag}` });
  expect(requests.map((entry) => JSON.stringify(entry.body).includes(finding))).toEqual([false, false, true]);
  const delivered = (await messages(page, main)).find((m) => m.customType === "workbench:chat-message");
  expect(text(delivered?.content).split("\n")[0]).toMatch(/ · live reviewer · /);
  expect(text(delivered?.content)).toContain("never reply to it");
  expect(text(delivered?.content)).toContain(finding);
  expect(delivered?.details).toMatchObject({ delivery: "steered", liveReview: { kind: "reviewer" } });
  expect(delivered?.details).not.toHaveProperty("hop");
});
