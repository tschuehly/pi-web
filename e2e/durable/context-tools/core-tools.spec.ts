/** AC-P049, AC-P068, AC-P069, AC-P070, AC-P071: real core tools, legacy comparison and committed-result survival. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, mock, project, createChat, answer, messages, text, chat, killHost, journalCount, fixture, expandTools } from "./support";

test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });
test.setTimeout(60_000);

for (const durable of [false, true]) {
  test(`AC-P068 read lines, truncation, image and missing-file errors (${durable ? "Durable" : "legacy"})`, async ({ page }) => {
    const marker = `read-${durable}-${Date.now()}`;
    await fixture(join(project(), "large.txt"), Array.from({ length: 2400 }, (_, i) => `row ${i + 1}`).join("\n"));
    await fixture(join(project(), "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKJkAAAAASUVORK5CYII=", "base64"));
    const calls = [
      { path: "docs/long.md", offset: 40, limit: 2 }, { path: "large.txt" }, { path: "pixel.png" }, { path: "absent-file.txt" },
    ];
    await mock.script({ match: marker, turns: [...calls.map((args) => [{ toolCall: { name: "read", args } }]), "Read checks complete."] });
    const id = await createChat(page, durable);
    await answer(page, id, marker, "Read checks complete.");
    const results = (await messages(page, id)).filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(4);
    expect(text(results[0]?.content)).toContain("Line 40 of the long file.\nLine 41 of the long file.");
    expect(text(results[0]?.content)).not.toContain("Line 42 of the long file.");
    expect(text(results[1]?.content)).toMatch(/truncat|Showing|offset=/i);
    expect(JSON.stringify(results[2]?.content)).toMatch(/image|mediaId/);
    expect(results[3]?.isError).toBe(true);
    await expandTools(page);
    await expect.soft(chat(page).locator("tool-execution-view")).toHaveCount(4);
    await expect(chat(page).getByText(/ENOENT|no such file/i).first()).toBeVisible();
    await journalCount(marker, 5);
    if (durable) {
      await killHost(page, id);
      expect((await messages(page, id)).filter((m) => m.role === "toolResult")).toEqual(results);
      await journalCount(marker, 5);
    }
  });

  test(`AC-P069 AC-P070 AC-P071 write/edit/bash effects and errors (${durable ? "Durable" : "legacy"})`, async ({ page }) => {
    const marker = `mutate-${durable}-${Date.now()}`;
    const file = `${marker}/nested/file.txt`;
    await mock.script({ match: marker, turns: [
      [{ toolCall: { name: "write", args: { path: file, content: "alpha\nbeta\ngamma\n" } } }],
      [{ toolCall: { name: "write", args: { path: file, content: "alpha\nbeta\ngamma\ndup\ndup\n" } } }],
      [{ toolCall: { name: "edit", args: { path: file, edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "gamma", newText: "GAMMA" }] } } }],
      [{ toolCall: { name: "edit", args: { path: file, edits: [{ oldText: "beta", newText: "BETA" }, { oldText: "dup", newText: "NO" }] } } }],
      [{ toolCall: { name: "edit", args: { path: file, edits: [{ oldText: "ALPHA\nbeta", newText: "one" }, { oldText: "beta\nGAMMA", newText: "two" }] } } }],
      [{ toolCall: { name: "write", args: { path: `${file}/cannot-create`, content: "must fail" } } }],
      [{ toolCall: { name: "bash", args: { command: `printf 'one-effect\\n' >> ${marker}/effects; printf 'shell-visible\\n'; exit 3`, description: "Fixture shell", foreground: true } } }],
      "Mutation checks complete.",
    ] });
    const id = await createChat(page, durable);
    await answer(page, id, marker, "Mutation checks complete.");
    const results = (await messages(page, id)).filter((m) => m.role === "toolResult");
    expect.soft(await readFile(join(project(), file), "utf8")).toBe("ALPHA\nbeta\nGAMMA\ndup\ndup\n");
    expect.soft(results.map((m) => m.isError === true)).toEqual([false, false, false, true, true, true, true]);
    expect(await readFile(join(project(), marker, "effects"), "utf8")).toBe("one-effect\n");
    await expandTools(page);
    await expect.soft(chat(page).locator("tool-execution-view")).toHaveCount(7);
    await expect(chat(page).getByText(/shell-visible/).first()).toBeVisible();
    await journalCount(marker, 8);
    if (durable) {
      await killHost(page, id);
      expect((await messages(page, id)).filter((m) => m.role === "toolResult")).toEqual(results);
      expect(await readFile(join(project(), marker, "effects"), "utf8")).toBe("one-effect\n");
      await journalCount(marker, 8);
    }
  });
}

test("AC-P049 edit exposes old/new preview while the model continues", async ({ page }) => {
  const frames: string[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => frames.push(String(payload))));
  const marker = `preview-${Date.now()}`;
  await fixture(join(project(), "preview.txt"), "before-preview\n");
  await mock.script({ match: marker, turns: [[{ toolCall: { name: "edit", args: { path: "preview.txt", edits: [{ oldText: "before-preview", newText: "after-preview" }] } } }], [{ barrier: marker }, { text: "Preview complete." }]] });
  const id = await createChat(page);
  const { send } = await import("./support");
  await send(page, marker);
  await mock.waitForBarrier(marker);
  const tool = chat(page).locator("tool-execution-view");
  await expect(tool).toHaveCount(1);
  const details = tool.locator("details.diff-details");
  await expect(details).toBeVisible();
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  await expect(tool.locator("pre.diff")).toContainText("before-preview");
  await expect(tool.locator("pre.diff")).toContainText("after-preview");
  expect(await readFile(join(project(), "preview.txt"), "utf8")).toBe("after-preview\n");
  const preview = frames.findIndex((frame) => frame.includes('"type":"tool.update"') && frame.includes('"preview"'));
  const end = frames.findIndex((frame) => frame.includes('"type":"tool.end"'));
  expect.soft(preview, "Preview update must reach the browser before the final edit result").toBeGreaterThanOrEqual(0);
  expect.soft(preview).toBeLessThan(end);
  await mock.release(marker);
  await expect(chat(page).getByText("Preview complete.", { exact: true })).toBeVisible();
  expect((await messages(page, id)).filter((m) => m.role === "toolResult")[0]?.isError).not.toBe(true);
});
