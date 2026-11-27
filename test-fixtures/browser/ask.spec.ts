import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/ask.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  // The drawer rises in; drag only once it stands still.
  await page.locator("workbench-question-chips .drawer").evaluate((drawer) => Promise.all(drawer.getAnimations().map((animation) => animation.finished)));
});

async function dragAcross(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("target not laid out");
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

/** What Cmd/Ctrl+C puts on the clipboard: the copy event's data (CodeMirror sets it) or else the selection the browser copies. */
async function copied(page: Page): Promise<string> {
  await page.evaluate(() => {
    window.addEventListener(
      "copy",
      (event) => {
        const data = event.clipboardData?.getData("text/plain") ?? "";
        document.body.dataset["copied"] = data !== "" || event.defaultPrevented ? data : (document.getSelection()?.toString() ?? "");
      },
      { once: true },
    );
  });
  await page.keyboard.press("ControlOrMeta+C");
  return page.evaluate(() => document.body.dataset["copied"] ?? "<no copy event>");
}

for (const text of [
  "Context prose to copy",
  "inline-code-copy",
  "echo copied-command",
  "Question line to copy",
  "Question detail to copy",
  "Option label to copy",
  "Option detail to copy",
]) {
  test(`selecting "${text}" in the question drawer shows the selection and copies it`, async ({ page }) => {
    const target = text === "inline-code-copy" ? page.locator(".lp-inline-code", { hasText: text }) : page.getByText(text).last();
    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    if (box === null) throw new Error("target not laid out");
    const clip = { x: box.x, y: box.y, width: Math.min(box.width, 120), height: box.height };
    const unselected = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
    await dragAcross(page, target);
    // The highlight must show: on a code block or inline code it was hidden behind the code's background, so the owner saw nothing selected.
    await expect.poll(async () => (await page.screenshot({ clip, animations: "disabled", caret: "hide" })).equals(unselected)).toBe(false);
    // The drag may stop a letter short where live preview reveals an inline code's backticks.
    expect(await copied(page)).toContain(text.slice(0, -1));
  });
}

test("a click on an option still selects it, and the context stays editable", async ({ page }) => {
  await page.getByText("Other option").click();
  await expect(page.locator('workbench-question-chips ask-user-card input[value="b"]')).toBeChecked();
  const context = page.locator("workbench-question-chips .context-editor .cm-content");
  await page.getByText("After the block.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited.");
  await expect(context).toContainText("After the block. Edited.");
});
