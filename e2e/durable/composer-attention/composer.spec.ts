// AC-P003 P004 P005 P006 P007 P008 P011 P012 P013 P014 P015 P047 P048 P055 P056 P057.
// Real WebKit controls, real session daemon/host, mock-only provider requests.
// Coverage boundaries: Workstream fleet-evidence/composer-attention/report-notes.md (not a full parity sign-off).
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, mock, setup, create, send, fill, answer, idle, status, messages, get, post, id, chat, editor, killHost, project, root, url, PNG, PNG_BLUE, image, fixtureFile } from "./support";
setup();

for (const runtime of ["durable", "legacy"] as const) {
  test(`AC-P004 P007 P011 ${runtime}: steer and follow-ups queue; Stop recalls without sending`, async ({ page }) => {
    const session = await create(page, runtime);
    const marker = `queue-${session}`;
    await mock.script({ match: marker, turns: [[{ text: "Held response" }, { barrier: marker }, { text: "finished" }]] });
    await send(page, marker);
    await mock.waitForBarrier(marker);
    await send(page, "steer-first", "Steer current response");
    await send(page, "follow-one", "Queue follow-up");
    await send(page, "follow-two", "Queue follow-up");
    await expect(page.locator(".queued-message")).toHaveCount(3);
    expect((await status(page)).queuedMessages.map(({ text, kind }) => ({ text, kind }))).toEqual([
      { text: "steer-first", kind: "steer" }, { text: "follow-one", kind: "followUp" }, { text: "follow-two", kind: "followUp" },
    ]);
    if (process.env["FLEET_NEGATIVE"] === "queue") {
      // Fault the real browser/API boundary: omit one host-admitted item from snapshots.
      await page.route(/\/sessions\/[^/]+\/(status|transcript-snapshot)\?/, async (route) => {
        const response = await route.fetch();
        const body = await response.json() as { queuedMessages?: unknown[]; status?: { queuedMessages: unknown[] } };
        const projected = body.status ?? body;
        if (projected.queuedMessages !== undefined) projected.queuedMessages = projected.queuedMessages.slice(1);
        await route.fulfill({ response, json: body });
      });
      await page.reload();
      await expect(page.locator(".queued-message")).toHaveCount(3);
    }
    await page.getByRole("button", { name: "Stop current work" }).click();
    await expect(editor(page)).toContainText("steer-first");
    await expect(editor(page)).toContainText("follow-one");
    await expect(editor(page)).toContainText("follow-two");
    await idle(page);
    expect((await status(page)).queuedMessages).toEqual([]);
    if (runtime === "durable") await killHost(page);
    await page.reload();
    await expect(editor(page)).toContainText("follow-two");
    expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(await mock.journal({ kind: "chat", contains: marker })).toHaveLength(1);
  });

  test(`AC-P013 ${runtime}: two inline images reach the mock in order; invalid input rejects`, async ({ page }) => {
    await create(page, runtime);
    await page.locator("input.attachment-input").setInputFiles([
      { name: "first.png", mimeType: "image/png", buffer: PNG }, { name: "second.png", mimeType: "image/png", buffer: PNG_BLUE },
    ]);
    await expect(page.locator(".attachment-chip")).toHaveCount(2);
    await mock.script({ match: "image-check", turns: ["Images received."] });
    await send(page, "image-check compare [PIC_1] and [PIC_2]");
    await answer(page, "Images received.");
    const [request] = await mock.journal({ kind: "chat", contains: "image-check" });
    const body = request!.body as { messages: { role: string; content: { type: string; source?: { data: string } }[] }[] };
    const images = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((c) => c.type === "image") : []);
    expect(images).toHaveLength(2);
    expect(images.map((i) => i.source?.data)).toEqual([PNG.toString("base64"), PNG_BLUE.toString("base64")]);
    expect(JSON.stringify(request!.body)).toContain("1. [PIC_1]\\n2. [PIC_2]");
    expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(1);
    const invalid = await post(page, id(page), "prompt", { text: "bad", attachments: [{ ...image(), data: "!invalid!" }] });
    expect(invalid.ok()).toBe(false);
    expect(await invalid.text()).toContain("invalid base64");
  });

  test(`AC-P056 ${runtime}: leading and repeated inline skills expand once; unknown remains literal`, async ({ page }) => {
    await create(page, runtime);
    await mock.script({ match: "FLEET_SKILL_BODY", turns: ["Skill received.", "Inline received."] });
    await send(page, "/skill:fleet-check first");
    await answer(page, "Skill received.");
    await send(page, "Read /skill:fleet-check and /skill:fleet-check with /skill:missing");
    await answer(page, "Inline received.");
    const requests = await mock.journal({ kind: "chat" });
    for (const request of requests) {
      expect(request.lastUserText.match(/FLEET_SKILL_BODY/g)).toHaveLength(1);
      expect(request.lastUserText).toContain("References are relative to");
    }
    expect(requests.at(-1)!.lastUserText).toContain("/skill:missing");
    expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(2);
  });
}

test("AC-P003: operation ID retries after host kill admit once and changed payload rejects", async ({ page }) => {
  const session = await create(page);
  const marker = `receipt-${session}`;
  await mock.script({ match: marker, turns: ["Admitted once."] });
  const requestPromise = page.waitForRequest((r) => r.url().endsWith("/prompt"));
  await send(page, marker);
  const payload = (await requestPromise).postDataJSON() as Record<string, unknown>;
  expect(payload["operationId"]).toEqual(expect.any(String));
  await answer(page, "Admitted once.");
  await killHost(page);
  expect((await post(page, session, "prompt", payload)).ok()).toBe(true);
  expect((await post(page, session, "prompt", { ...payload, text: "different payload" })).ok()).toBe(false);
  expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(1);
  expect(await mock.journal({ kind: "chat", contains: marker })).toHaveLength(1);
});

test("AC-P004 P007: queued kinds and order survive a real host kill; read-only reopen stays paused", async ({ page }) => {
  const session = await create(page);
  const marker = `survive-${session}`;
  await mock.script({ match: marker, turns: [[{ text: "Committed partial" }, { barrier: marker }]] });
  await send(page, marker);
  await mock.waitForBarrier(marker);
  for (const [text, mode] of [["steer", "steer"], ["first", "followUp"], ["second", "followUp"]] as const) {
    expect((await post(page, session, "prompt", { text, streamingBehavior: mode, operationId: `${session}-${text}`, ...(text === "second" ? { attachments: [image()] } : {}) })).ok()).toBe(true);
  }
  const queued = (await status(page)).queuedMessages;
  expect(queued).toHaveLength(3);
  expect(queued.at(-1)?.attachmentCount).toBe(1);
  await killHost(page);
  await page.reload();
  expect((await status(page)).queuedMessages).toEqual(queued);
  expect((await post(page, session, "prompt", { text: "first", streamingBehavior: "followUp", operationId: `${session}-first` })).ok()).toBe(true);
  expect((await post(page, session, "prompt", { text: "changed", streamingBehavior: "followUp", operationId: `${session}-first` })).ok()).toBe(false);
  expect(await mock.journal({ kind: "chat", contains: marker })).toHaveLength(1);
});

test("AC-P005: thinking and text stream before completion; host kill retains aborted partial", async ({ page }) => {
  await create(page);
  const marker = `stream-${id(page)}`;
  await mock.script({ match: marker, turns: [[{ thinking: "Visible reasoning" }, { text: "Visible partial streaming " }, { barrier: marker }, { text: " final" }]] });
  await send(page, marker);
  await mock.waitForBarrier(marker);
  await expect(chat(page).getByText(/^Visible partial/).first()).toBeVisible();
  const before = await (await get(page, id(page), "stream-snapshot")).json() as { partial: unknown };
  expect(JSON.stringify(before.partial)).toContain("Visible reasoning");
  expect(JSON.stringify(before.partial)).not.toContain("signature");
  await page.reload();
  await expect(chat(page).getByText(/^Visible partial/).first()).toBeVisible();
  await killHost(page);
  await page.reload();
  const restored = await (await get(page, id(page), "transcript-snapshot")).json();
  expect(JSON.stringify(restored)).toContain("Visible partial");
  expect(JSON.stringify(restored)).toMatch(/aborted|interrupted/i);
  expect(await mock.journal({ kind: "chat", contains: marker })).toHaveLength(1);
});

test("AC-P006: paging preserves tool pairs and reconnect snapshot converges", async ({ page }) => {
  await create(page);
  const marker = `pages-${id(page)}`;
  for (let turn = 0; turn < 26; turn++) {
    await mock.script({ match: marker, turns: [[{ toolCall: { name: "read", args: { path: "docs/notes.md" } } }], `Tool page ${turn} done.`] });
    await send(page, `${marker} turn ${turn}`);
    await answer(page, `Tool page ${turn} done.`);
  }
  const all = await messages(page);
  expect(all.total).toBe(104);
  const newest = await (await get(page, id(page), "messages", { limit: "1" })).json() as typeof all;
  const older = await (await get(page, id(page), "messages", { limit: "500", before: String(newest.start) })).json() as typeof all;
  expect([...older.messages, ...newest.messages]).toEqual(all.messages);
  expect(newest.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  await page.reload();
  // Each entry into the top region loads one older page (ChatScrollFlows): leave and re-enter it until the first turn loads.
  await expect.poll(async () => {
    await chat(page).locator(".chat").evaluate(async (element) => {
      element.scrollTop = element.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      element.scrollTop = 0;
    });
    return chat(page).getByText(`${marker} turn 0`, { exact: true }).count();
  }).toBe(1);
  await mock.script({ match: marker, turns: [[{ text: "Page partial streaming " }, { barrier: marker }, { text: "complete" }]] });
  await send(page, "final streaming turn");
  await mock.waitForBarrier(marker);
  await page.reload();
  await expect(chat(page).getByText(/^Page partial/).first()).toBeVisible();
  await mock.release(marker);
  await expect(chat(page).getByText("complete", { exact: true })).toBeVisible();
  await idle(page);
  expect(JSON.stringify(await messages(page))).toContain("Page partial streaming ");
  expect((await messages(page)).messages.at(-1)?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "complete" })]));
  expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(27);
});

test("AC-P008: Clear queue keeps current generation and stays cleared after host kill", async ({ page }) => {
  await create(page);
  const marker = `clear-${id(page)}`;
  await mock.script({ match: marker, turns: [[{ text: "Still working" }, { barrier: marker }]] });
  await send(page, marker);
  await mock.waitForBarrier(marker);
  await send(page, "never-send", "Queue follow-up");
  await page.getByRole("button", { name: "Clear queue", exact: true }).click();
  await expect.poll(async () => (await status(page)).queuedMessages).toEqual([]);
  expect((await status(page)).isStreaming).toBe(true);
  await killHost(page);
  await page.reload();
  expect((await status(page)).queuedMessages).toEqual([]);
  expect(JSON.stringify(await messages(page))).not.toContain("never-send");
  expect(await mock.journal({ kind: "chat", contains: marker })).toHaveLength(1);
});

test("AC-P012: stop-runtime retains catalog and history without another model request", async ({ page }) => {
  const session = await create(page);
  await mock.script({ match: session, turns: ["Saved history."] });
  await send(page, session);
  await answer(page, "Saved history.");
  expect((await post(page, session, "stop")).ok()).toBe(true);
  await page.reload();
  await answer(page, "Saved history.");
  expect(await mock.journal({ kind: "chat", contains: session })).toHaveLength(1);
});

test("AC-P014: folder delivery preserves bytes and collisions; traversal and symlink escape reject", async ({ page }) => {
  const session = await create(page);
  const attachment = { kind: "file", name: "report.txt", mimeType: "text/plain", data: Buffer.from("original bytes").toString("base64") };
  const save = () => post(page, session, "attachments", { attachments: [attachment], folder: "fleet-files" });
  const first = await (await save()).json() as { attachments: { path: string }[] };
  const second = await (await save()).json() as typeof first;
  expect(first.attachments[0]!.path).toMatch(/^fleet-files\//);
  expect(first.attachments[0]!.path).not.toBe(second.attachments[0]!.path);
  for (const result of [first, second]) expect(await readFile(join(project(), result.attachments[0]!.path), "utf8")).toBe("original bytes");
  expect((await post(page, session, "attachments", { attachments: [attachment], folder: "../escape" })).ok()).toBe(false);
  const outside = join(root(), "outside");
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(project(), `escape-${session}`));
  expect((await post(page, session, "attachments", { attachments: [attachment], folder: `escape-${session}` })).ok()).toBe(false);
  await page.locator("input.attachment-input").setInputFiles({ name: "document.txt", mimeType: "text/plain", buffer: Buffer.from("UI file bytes") });
  await send(page, "Please inspect the attached file");
  await idle(page);
  await expect.poll(async () => (await mock.journal({ kind: "chat" })).length).toBe(1);
  expect((await mock.journal({ kind: "chat" }))[0]!.lastUserText).toContain("document.txt");
});

test("AC-P015: media is scoped and survives host kill; gallery opens", async ({ page }) => {
  // A supported package fixture returns two images in ONE tool result: prompt previews are deliberately single-image,
  // while the legacy gallery navigates within a tool result (not across unrelated messages).
  const fixture = join(root(), "image-fixture");
  await fixtureFile("image-fixture/package.json", JSON.stringify({ name: "pi-process-monitor", version: "0.0.0", type: "module", pi: { extensions: ["./index.mjs"] } }));
  await fixtureFile("image-fixture/index.mjs", `export default function(pi) { pi.registerTool({ name: 'fleet_images', label: 'Fleet images', description: 'Return two local fixture images', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: ${JSON.stringify([PNG, PNG_BLUE].map((buffer) => ({ type: "image", mimeType: "image/png", data: buffer.toString("base64") })))}, details: {} }) }); }`);
  const settingsPath = join(root(), "durable-agent/settings.json");
  const original = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(original) as { packages?: string[] };
  await writeFile(settingsPath, JSON.stringify({ ...settings, packages: [...settings.packages ?? [], fixture] }));
  let session: string;
  try { session = await create(page); } finally { await writeFile(settingsPath, original); }
  await mock.script({ match: "media-check", turns: [[{ toolCall: { name: "fleet_images", args: {} } }], "Image saved."] });
  await page.locator("input.attachment-input").setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: PNG }, { name: "second.png", mimeType: "image/png", buffer: PNG_BLUE },
  ]);
  await send(page, "media-check [PIC_1] [PIC_2]");
  await answer(page, "Image saved.");
  const snapshot = await (await get(page, session, "messages", { media: "reference" })).json();
  const mediaIds = [...JSON.stringify(snapshot).matchAll(/"mediaId":"([a-f0-9]+)"/g)].map((match) => match[1]!);
  expect(mediaIds).toHaveLength(4);
  const mediaId = mediaIds[0]!;
  expect(await (await get(page, session, `media/${mediaIds[1]}`)).body()).toEqual(PNG_BLUE);
  const own = await get(page, session, `media/${mediaId}`);
  expect(own.ok()).toBe(true);
  expect(await own.body()).toEqual(PNG);
  const other = await create(page);
  expect((await get(page, other, `media/${mediaId}`)).status()).toBe(404);
  await killHost(page, session);
  await page.goto(url(session));
  expect(await (await get(page, session, `media/${mediaId}`)).body()).toEqual(PNG);
  await chat(page).locator("article.tool-image-output img").first().click();
  await expect(page.getByRole("dialog", { name: "Image preview" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Image preview" })).toContainText("Image 1 of 2");
  await page.getByRole("button", { name: "Next image" }).click();
  await expect(page.getByRole("dialog", { name: "Image preview" })).toContainText("Image 2 of 2");
  expect(await mock.journal({ kind: "chat", contains: "media-check" })).toHaveLength(2);
});

test("AC-P048: per-Chat drafts persist across switch, browser reload and host kill without admission", async ({ page }) => {
  const first = await create(page);
  await fill(page, "Draft alpha");
  await expect.poll(() => page.evaluate(() => JSON.stringify(localStorage))).toContain("Draft alpha");
  const second = await create(page);
  await fill(page, "Draft beta");
  await expect.poll(() => page.evaluate(() => JSON.stringify(localStorage))).toContain("Draft beta");
  await killHost(page, first);
  await page.goto(url(first));
  await expect(editor(page)).toHaveText("Draft alpha");
  await page.goto(url(second));
  await page.reload();
  await expect(editor(page)).toHaveText("Draft beta");
  expect(await mock.journal({ kind: "chat" })).toHaveLength(0);
});

test("AC-P047: copy uses plain text and selection quote populates composer only", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator.clipboard, "writeText", { value: async (text: string) => { (window as unknown as { copied: string }).copied = text; } }); });
  await create(page);
  await mock.script({ match: "quote-check", turns: ["A **bold** passage to quote."] });
  await send(page, "quote-check");
  await expect(chat(page).getByText("passage to quote.", { exact: false }).first()).toBeVisible();
  await idle(page);
  await chat(page).getByRole("button", { name: "Message actions", exact: true }).last().click();
  const copy = chat(page).getByRole("button", { name: "Copy assistant message" }).first();
  await copy.click({ force: true });
  await expect.poll(() => page.evaluate(() => (window as unknown as { copied?: string }).copied)).toBe("A **bold** passage to quote.");
  await chat(page).getByRole("button", { name: "Message actions", exact: true }).last().click();
  await chat(page).locator("formatted-text strong").getByText("bold", { exact: true }).dblclick();
  await page.getByRole("button", { name: "Reply to selection", exact: true }).click();
  const quote = page.locator("prompt-editor .cm-reply-quote");
  await expect(quote).toContainText("bold");
  await quote.click();
  await expect(editor(page)).toContainText("#entry:");
  expect((await messages(page)).messages.filter((m) => m.role === "user")).toHaveLength(1);
});

test("AC-P055 P057: command catalog and autocomplete expose installed templates; both expand arguments", async ({ page }) => {
  await create(page);
  const commands = await (await get(page, id(page), "commands")).json() as { name: string; source: string }[];
  expect(commands.map((c) => c.name)).toEqual([...commands.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
  expect(commands).toContainEqual(expect.objectContaining({ name: "skill:fleet-check", source: "skill" }));
  expect(commands.map((c) => c.name)).not.toContain("fork");
  for (const name of ["execute-plan-afk", "execute-plan-attended"]) {
    expect(commands).toContainEqual(expect.objectContaining({ name, source: "prompt" }));
    await mock.script({ match: `FLEET_TEMPLATE_${name}`, turns: [`Expanded ${name}.`] });
    await fill(page, `/${name}`);
    await page.getByRole("button", { name: new RegExp(`^/${name} `) }).click();
    await expect(editor(page)).toContainText(`/${name}`);
    await send(page, `/${name} \"plan one\" tail`);
    await answer(page, `Expanded ${name}.`);
    expect((await mock.journal({ kind: "chat" })).at(-1)!.lastUserText).toContain(`FLEET_TEMPLATE_${name}: plan one tail`);
  }
});
