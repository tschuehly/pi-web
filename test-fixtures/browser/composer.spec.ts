import { expect, test, type Page } from "@playwright/test";

const paragraph = "This closed session still posts afk warnings, so the owner keeps getting pinged about a Chat that ended hours ago and nobody can tell why [PIC_1]";

async function open(page: Page, width: number, zoom = 1): Promise<void> {
  await page.goto(`/composer.html?width=${String(width)}&zoom=${String(zoom)}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
}

/** Visual line boxes of the typed text, and the icon boxes beside the input. */
async function layout(page: Page) {
  return page.locator("prompt-editor").evaluate((host) => {
    const root = host.shadowRoot;
    if (root === null) throw new Error("no shadow root");
    const row = root.querySelector(".input-row")?.getBoundingClientRect();
    if (row === undefined) throw new Error("no input row");
    const range = document.createRange();
    const lines: { left: number; right: number; top: number; bottom: number }[] = [];
    const text = document.createTreeWalker(root.querySelector(".cm-content") ?? root, NodeFilter.SHOW_TEXT);
    for (let node = text.nextNode(); node !== null; node = text.nextNode()) {
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width === 0) continue;
        const last = lines.at(-1);
        // Text runs on one visual line share a top; merge them into one box.
        if (last !== undefined && Math.abs(last.top - rect.top) < 2) { last.left = Math.min(last.left, rect.left); last.right = Math.max(last.right, rect.right); last.bottom = Math.max(last.bottom, rect.bottom); } else lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }
    }
    // The drawn icons, through the pickers' open shadow roots: a 26px hit area may reach a few px above a ~20px line, its glyph may not.
    const glyphs = (scope: ParentNode): Element[] => [...scope.querySelectorAll("*")].flatMap((element) => [...(element instanceof SVGSVGElement || element.matches(".usage [aria-hidden=true]") ? [element] : []), ...(element.shadowRoot === null ? [] : glyphs(element.shadowRoot))]);
    const icons = [...root.querySelectorAll(".input-row > .editor-wrap ~ *")].flatMap((element) => glyphs(element)).map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0).map(({ left, right, top, bottom }) => ({ left, right, top, bottom }));
    return { row: { left: row.left, width: row.width, bottom: row.bottom }, lines, icons };
  });
}

interface Box { left: number; right: number; top: number; bottom: number }
// Text boxes include ~1.5px of leading above and below the glyphs; a 2px vertical tolerance ignores that, not real overlap.
const overlaps = (line: Box, icon: Box): boolean => line.left < icon.right && icon.left < line.right && line.top < icon.bottom - 2 && icon.top + 2 < line.bottom;

for (const width of [640, 420]) {
  test(`dense composer wraps text at the full input width; icons share only the last line (tile ${String(width)}px)`, async ({ page }) => {
    await open(page, width);
    const input = page.locator("prompt-editor .cm-content");
    await input.focus();
    await input.pressSequentially(paragraph);
    const { row, lines, icons } = await layout(page);
    expect(lines.length).toBeGreaterThan(1);
    expect(icons.length).toBeGreaterThan(0);
    expect((lines[0]?.right ?? 0) - row.left).toBeGreaterThan(row.width * 0.85);
    for (const line of lines) {
      for (const icon of icons) {
        expect(overlaps(line, icon), `line ${JSON.stringify(line)} overlaps icon ${JSON.stringify(icon)}`).toBe(false);
      }
    }
    await page.screenshot({ path: test.info().outputPath(`dense-long-${String(width)}.png`) });
  });

  test(`dense composer scrolled to the end of a long draft keeps its last line clear of the icons (tile ${String(width)}px)`, async ({ page }) => {
    await open(page, width);
    await page.locator("prompt-editor .cm-content").focus();
    await page.keyboard.insertText(Array.from({ length: 15 }, () => paragraph).join(" "));
    const scroller = page.locator("prompt-editor .cm-scroller");
    expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    // CodeMirror scrolls the caret into view on its next measure frame.
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(1);
    const box = await scroller.boundingBox();
    const { lines, icons } = await layout(page);
    const visible = lines.filter((line) => box !== null && line.bottom > box.y && line.top < box.y + box.height);
    for (const line of visible) for (const icon of icons) expect(overlaps(line, icon), `line ${JSON.stringify(line)} icon ${JSON.stringify(icon)} scroller ${JSON.stringify(box)}`).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`dense-scrolled-${String(width)}.png`) });
  });

  test(`dense composer keeps a short line beside the icons, and the placeholder clear of them (tile ${String(width)}px)`, async ({ page }) => {
    await open(page, width);
    const empty = await layout(page);
    const placeholder = await page.locator("prompt-editor .prompt-placeholder").boundingBox();
    expect(placeholder).not.toBeNull();
    for (const icon of empty.icons) expect((placeholder?.x ?? 0) + (placeholder?.width ?? 0)).toBeLessThanOrEqual(icon.left + 1);
    await page.screenshot({ path: test.info().outputPath(`dense-empty-${String(width)}.png`) });

    const input = page.locator("prompt-editor .cm-content");
    await input.focus();
    await input.pressSequentially("Short line");
    const { row, lines, icons } = await layout(page);
    expect(lines).toHaveLength(1);
    // One line: the icons sit on it, so the row is no taller than an empty one.
    expect(Math.abs(row.bottom - empty.row.bottom)).toBeLessThan(2);
    for (const icon of icons) expect(lines[0]?.right ?? Infinity).toBeLessThanOrEqual(icon.left);
    await page.screenshot({ path: test.info().outputPath(`dense-short-${String(width)}.png`) });
  });
}

// Thomas's Grid tile draft: one long sentence ran past the input on a single line, scrolled sideways, instead of wrapping.
const sentence = "Spawn a subagent that reads through all sessions that used the tooling with luna subs how it is being used";
for (const [width, zoom] of [[1270, 1], [900, 1], [640, 1], [420, 1], [1270, 1.25], [640, 2], [640, 0.8]] as const) {
  test(`dense composer wraps one long typed sentence instead of scrolling sideways (tile ${String(width)}px, interface scale ${String(zoom)})`, async ({ page }) => {
    await open(page, width, zoom);
    const input = page.locator("prompt-editor .cm-content");
    await input.focus();
    // Long enough to overflow the widest tile at least once.
    await input.pressSequentially(width > 700 ? `${sentence} and then ${sentence.toLowerCase()}` : sentence);
    const { row, lines } = await layout(page);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.left).toBeGreaterThanOrEqual(row.left - 1);
      expect(line.right).toBeLessThanOrEqual(row.left + row.width + 1);
    }
    const scroll = await page.locator("prompt-editor").evaluate((host) => [".cm-scroller", ".cm-content"].map((selector) => { const element = host.shadowRoot?.querySelector(selector); return element === null || element === undefined ? -1 : element.scrollWidth - element.clientWidth + element.scrollLeft; }));
    expect(scroll).toEqual([0, 0]);
    await page.screenshot({ path: test.info().outputPath(`dense-sentence-${String(width)}.png`) });
  });
}
