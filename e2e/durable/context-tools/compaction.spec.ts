/** AC-P053 AC-P082 AC-P083 AC-P103: compaction, automatic policy, continuation, mode and recovery. */
import { test, expect, mock, createChat, answer, send, chat, command, messages, text, status, idle, killHost, settings } from "./support";

test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });
test.setTimeout(60_000);

const summary = "COMPACTED-CONTEXT: preserve acceptance test names.";
const summaries = async (page: Parameters<typeof messages>[0], id: string) => (await messages(page, id)).filter((m) => m.source === "compaction");
async function seed(page: Parameters<typeof createChat>[0], id: string) {
  await answer(page, id, "phase one acceptance names", "Phase one complete.");
  await answer(page, id, "phase two acceptance names", "Phase two complete.");
}

for (const durable of [false, true]) {
  test(`AC-P053 focus summary reaches next context (${durable ? "Durable" : "legacy"})`, async ({ page }) => {
    await mock.script({ turns: ["Phase one complete.", "Phase two complete.", [{ barrier: "summary" }, { text: summary }], ...(!durable ? [summary] : []), "After compaction."] });
    const id = await createChat(page, durable);
    await seed(page, id);
    await send(page, "/compact Preserve acceptance test names");
    await mock.waitForBarrier("summary");
    expect((await status(page, id)).isCompacting).toBe(true);
    expect(await summaries(page, id)).toHaveLength(0);
    const request = (await mock.journal({ kind: "chat" }))[2]!;
    expect(JSON.stringify(request.body)).toContain("Preserve acceptance test names");
    await mock.release("summary");
    await expect.poll(async () => (await summaries(page, id)).length).toBe(1);
    await answer(page, id, "after compact", "After compaction.");
    expect(JSON.stringify((await mock.journal({ kind: "chat" })).at(-1)?.body)).toContain(summary);
    if (durable) await expect(chat(page).getByText("1 history compaction summary")).toHaveCount(1);
    else await expect(chat(page).locator("summary").filter({ hasText: "Earlier conversation" })).toHaveCount(1);
    if (durable) {
      await killHost(page, id);
      expect(await summaries(page, id)).toHaveLength(1);
      expect(await mock.journal({ kind: "chat" })).toHaveLength(4);
    }
  });
}

for (const outcome of ["cancel", "fail"] as const) {
  test(`AC-P053 compaction ${outcome} clears progress without a success summary`, async ({ page }) => {
    await mock.script({ turns: ["Phase one complete.", "Phase two complete.", outcome === "cancel" ? [{ barrier: "summary" }, { text: summary }] : [{ error: "invalid_request" }]] });
    const id = await createChat(page);
    await seed(page, id);
    await send(page, "/compact Keep names");
    if (outcome === "cancel") {
      await mock.waitForBarrier("summary");
      await page.getByRole("button", { name: "Stop current work" }).click();
      await mock.release("summary");
    }
    await idle(page, id);
    expect(await summaries(page, id)).toHaveLength(0);
    await expect(chat(page).getByText(outcome === "cancel" ? "Compaction cancelled." : "Couldn’t compact history. Try again.", { exact: true })).toBeVisible();
    await killHost(page, id);
    expect(await summaries(page, id)).toHaveLength(0);
    expect(await mock.journal({ kind: "chat" })).toHaveLength(3);
  });
}

for (const window of ["none", "summarizing", "continuation"] as const) {
  test(`AC-P082 AC-P103 exactly one continuation and mode reattach; kill ${window}`, async ({ page }) => {
    const tool = [{ toolCall: { name: "compact_and_continue", args: { summaryFocus: "Keep acceptance names", nextPhase: "verify the acceptance files" } } }];
    const summaryTurn = window === "summarizing" ? [{ barrier: "summary" }, { text: "interrupted summary" }] : summary;
    const continuation = window === "continuation" ? [{ barrier: "continuation" }, { text: "interrupted continuation" }] : "Next phase complete.";
    await mock.script({ turns: ["Phase one complete.", "Phase two complete.", tool, summaryTurn,
      ...(window === "summarizing" ? [summary] : []), continuation,
      ...(window === "continuation" ? ["Next phase complete."] : []), "Recovery prompt complete."] });
    const id = await createChat(page);
    await command(page, id, "/mode attention focused");
    await seed(page, id);
    await send(page, "checkpoint now");
    if (window !== "none") {
      await mock.waitForBarrier(window === "summarizing" ? "summary" : "continuation");
      await killHost(page, id);
      const before = (await mock.journal({ kind: "chat" })).length;
      await messages(page, id);
      await status(page, id);
      expect(await mock.journal({ kind: "chat" })).toHaveLength(before);
      await mock.release(window === "summarizing" ? "summary" : "continuation");
      await send(page, "resume recovery");
    }
    await expect(chat(page).getByText("Next phase complete.", { exact: true })).toBeVisible();
    await idle(page, id);
    const transcript = await messages(page, id);
    expect(transcript.filter((m) => m.customType === "context-checkpoint")).toHaveLength(1);
    expect(await summaries(page, id)).toHaveLength(1);
    const requests = await mock.journal({ kind: "chat" });
    const continued = requests.filter((e) => e.lastUserText.includes("Context checkpoint completed."));
    // An interrupted provider request may retry; the logical continuation still appears once in the transcript.
    expect(continued).toHaveLength(window === "continuation" ? 2 : 1);
    const body = JSON.stringify(continued.at(-1)?.body);
    expect(body).toContain(summary);
    expect(body.match(/<working-mode>/g)).toHaveLength(1);
    expect(body).toContain("Focused");
    await killHost(page, id);
    expect((await messages(page, id)).filter((m) => m.customType === "context-checkpoint")).toHaveLength(1);
    expect(await mock.journal({ kind: "chat" })).toHaveLength(requests.length);
  });
}

test("AC-P053 manual summary killed before placement resumes once without read-triggered work", async ({ page }) => {
  await mock.script({ turns: ["Phase one complete.", "Phase two complete.", [{ barrier: "manual-summary" }, { text: "interrupted" }], summary, "Manual recovery complete.", "After manual recovery."] });
  const id = await createChat(page);
  await seed(page, id);
  await send(page, "/compact Keep acceptance names after recovery");
  await mock.waitForBarrier("manual-summary");
  await killHost(page, id);
  expect(await summaries(page, id)).toHaveLength(0);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(3);
  await mock.release("manual-summary");
  await send(page, "resume manual compaction");
  await expect(chat(page).getByText("Manual recovery complete.", { exact: true })).toBeVisible();
  await idle(page, id);
  expect(await summaries(page, id)).toHaveLength(1);
  const requests = await mock.journal({ kind: "chat" });
  expect(requests).toHaveLength(5);
  expect(JSON.stringify(requests[3]?.body)).toContain("Keep acceptance names after recovery");
  // Manual compaction is non-blocking: the resume input may run concurrently with the retried summarizer.
  await answer(page, id, "after placed recovery summary", "After manual recovery.");
  expect(JSON.stringify((await mock.journal({ kind: "chat" })).at(-1)?.body)).toContain(summary);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(6);
});

test("AC-P082 cancelling checkpoint summary admits no continuation even after host kill", async ({ page }) => {
  await mock.script({ turns: ["Phase one complete.", "Phase two complete.", [{ toolCall: { name: "compact_and_continue", args: { summaryFocus: "Keep names", nextPhase: "CANCELLED_NEXT_PHASE" } } }], [{ barrier: "cancel-checkpoint" }, { text: summary }]] });
  const id = await createChat(page);
  await seed(page, id);
  await send(page, "checkpoint cancel");
  await mock.waitForBarrier("cancel-checkpoint");
  await expect(page.getByRole("button", { name: "Stop current work" })).toBeEnabled();
  await page.getByRole("button", { name: "Stop current work" }).click();
  await mock.release("cancel-checkpoint");
  await expect(chat(page).getByText("Context checkpoint cancelled; the next phase was not started.", { exact: true })).toBeVisible();
  await idle(page, id);
  await killHost(page, id);
  expect(await summaries(page, id)).toHaveLength(0);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(4);
  expect(JSON.stringify((await messages(page, id)).filter((m) => m.customType === "context-checkpoint"))).toContain("cancelled");
});

for (const invalid of ["batch", "empty", "oversized"] as const) {
  test(`AC-P082 rejects ${invalid} checkpoint directives without continuation`, async ({ page }) => {
    const args = { summaryFocus: invalid === "oversized" ? "x".repeat(1201) : "Keep names", nextPhase: invalid === "empty" ? "" : "next" };
    await mock.script({ turns: [[{ toolCall: { name: "compact_and_continue", args } }, ...(invalid === "batch" ? [{ toolCall: { name: "read", args: { path: "docs/notes.md" } } }] : [])], "Rejection observed."] });
    const id = await createChat(page);
    await answer(page, id, "invalid checkpoint", "Rejection observed.");
    expect(await summaries(page, id)).toHaveLength(0);
    const transcript = await messages(page, id);
    expect(transcript.filter((m) => m.customType === "context-checkpoint")).toHaveLength(0);
    const result = transcript.find((m) => m.toolName === "compact_and_continue");
    expect(text(result?.content)).toMatch(/alone|empty|1200|short|invalid|validation|length|character/i);
    expect(await mock.journal({ kind: "chat" })).toHaveLength(2);
  });
}

test("AC-P082 failed summarizer never starts the next phase", async ({ page }) => {
  await mock.script({ turns: ["Phase one complete.", "Phase two complete.", [{ toolCall: { name: "compact_and_continue", args: { summaryFocus: "Keep names", nextPhase: "MUST NOT START" } } }], [{ error: "invalid_request" }], "Unexpected continuation."] });
  const id = await createChat(page);
  await seed(page, id);
  await send(page, "checkpoint fail");
  await expect.poll(async () => (await messages(page, id)).filter((m) => m.customType === "context-checkpoint").length).toBe(1);
  await idle(page, id);
  expect.soft(await summaries(page, id)).toHaveLength(0);
  expect((await mock.journal({ kind: "chat" })).filter((e) => e.lastUserText.includes("Requested next phase:")).length).toBe(0);
});

for (const crash of [false, true]) test(`AC-P083 usage crosses threshold, queues input, and compacts before continuing; kill ${crash}`, async ({ page }) => {
  await settings({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 } });
  // Anthropic mock input/cache usage is currently ignored; explicit output usage drives the same context policy.
  await mock.script({ turns: ["Phase one complete.", { steps: [{ text: "Phase two complete." }], usage: { output: 995000 } }, [{ barrier: "auto-summary" }, { text: summary }], ...(crash ? [summary] : []), "Automatic prompt complete.", "Held human complete.", ...(crash ? ["Auto recovery complete."] : [])] });
  const id = await createChat(page);
  await command(page, id, "/mode attention focused");
  await seed(page, id);
  await send(page, "trigger automatic compaction");
  await mock.waitForBarrier("auto-summary");
  expect((await status(page, id)).isCompacting).toBe(true);
  await expect(page.getByRole("button", { name: "Stop current work" })).toBeEnabled();
  await send(page, "held human input");
  if (crash) {
    await killHost(page, id);
    await messages(page, id);
    expect(await mock.journal({ kind: "chat" })).toHaveLength(3);
  }
  await mock.release("auto-summary");
  if (crash) await send(page, "resume automatic compaction");
  await expect(chat(page).getByText("Held human complete.", { exact: true })).toBeVisible();
  if (crash) await expect(chat(page).getByText("Auto recovery complete.", { exact: true })).toBeVisible();
  await idle(page, id);
  expect(await summaries(page, id)).toHaveLength(1);
  const requests = await mock.journal({ kind: "chat" });
  expect(requests).toHaveLength(crash ? 7 : 5);
  const first = crash ? 4 : 3;
  expect(requests[first]?.lastUserText).toContain("trigger automatic compaction");
  expect(requests[first + 1]?.lastUserText).toContain("held human input");
  expect(JSON.stringify(requests[first]?.body)).toContain(summary);
  expect.soft(JSON.stringify(requests[first]?.body)).toContain("<working-mode>");
  await killHost(page, id);
  expect(await summaries(page, id)).toHaveLength(1);
  expect(await mock.journal({ kind: "chat" })).toHaveLength(crash ? 7 : 5);
});
