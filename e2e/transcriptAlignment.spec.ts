import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ALL_KINDS_CHAT, E2E_MORE_CHATS, E2E_PROJECT_ID } from "./isolatedPiWeb";

// The Workbench "one left rail" rule, checked on one Chat holding every transcript kind, in Tabs and a 3-tile Grid, light and dark:
// every block starts at the transcript edge, spans to its right edge, is square and unfilled, and draws a 3px bar;
// every heading label and message body line starts at one x (icons excluded); every fold uses the hanging Lucide chevron; one gap separates blocks.
// Set PI_WEB_E2E_ALIGNMENT to a folder to also write the measurements (JSON) and screenshots.
const OUT = process.env["PI_WEB_E2E_ALIGNMENT"];
const FOCUSED = E2E_ALL_KINDS_CHAT.id;

async function openWindow(page: Page, layout: "tabs" | "grid"): Promise<void> {
  const workspaceId = process.env["PI_WEB_E2E_WORKSPACE_ID"];
  const url = process.env["PI_WEB_E2E_CHAT_URL"];
  if (workspaceId === undefined || url === undefined) throw new Error("Isolated PI WEB was not started");
  const workstream = { id: "ws-alignment", title: "Alignment" };
  const all = [E2E_ALL_KINDS_CHAT, ...E2E_MORE_CHATS];
  const shown = layout === "grid" ? all : all.slice(0, 1);
  const chats = shown.map((chat) => ({ sessionId: chat.id, title: chat.question, machineId: "local", projectId: E2E_PROJECT_ID, workspaceId, workstream }));
  const store = { n: { name: "Window 1", layout, maximized: false, focused: FOCUSED, lastActive: {}, chats } };
  await page.addInitScript((value) => { if (localStorage.getItem("pi-workbench.windows.v1") === null) localStorage.setItem("pi-workbench.windows.v1", value); }, JSON.stringify(store));
  const target = new URL(url);
  target.searchParams.set("win", "n");
  target.searchParams.set("session", FOCUSED);
  await page.goto(target.toString());
  await expect(transcript(page)).toContainText("Final answer after the image.");
}

const transcript = (page: Page) => page.locator('.tile[data-focused="true"] main.chat-shell chat-view .chat');

/** Kind name → how to find its element inside `.chat`; nested kinds sit inside another block and must not draw a bar of their own. */
const KINDS: { kind: string; selector: string; nested?: true }[] = [
  { kind: "history fold (exchange)", selector: "details.exchange-history > summary" },
  { kind: "user message", selector: ".chat > article.msg.user.conversation-message" },
  { kind: "assistant message", selector: ".chat > article.msg.assistant.conversation-message" },
  { kind: "compaction summary", selector: "details.history-group" },
  { kind: "working-mode card", selector: ".chat > .event-group.visible-events:has(.working-mode-card)" },
  { kind: "thinking group", selector: "details.thinking-group" },
  { kind: "thinking › tool fold", selector: "details.thinking-group details.tool-fold", nested: true },
  { kind: "single tool row (bash)", selector: "tool:success" },
  { kind: "activity group (2 steps)", selector: "details.activity-group" },
  { kind: "failed tool (visible)", selector: "tool:error" },
  { kind: "background bash card", selector: "article:has(> .background-bash-card)" },
  { kind: "goal lifecycle card", selector: "article:has(> .goal-lifecycle)" },
  { kind: "subagent completion", selector: "article:has(> .subagent-completion)" },
  { kind: "ask_user record", selector: "article.ask-user-record-shell" },
  { kind: "quiet notice (lone)", selector: ".chat > article.msg.notice-line" },
  { kind: "notice fold", selector: "details.notice-fold" },
  { kind: "tool image output", selector: "article.tool-image-output" },
];

interface Row { kind: string; nested: boolean; found: boolean; left?: number; right?: number; bar?: string; barColour?: string; background?: string; radius?: string; contentStart?: number | undefined; bodyStarts?: number[] | undefined; marker?: string; gap?: number | undefined; afterBlock?: boolean }
interface Markers { summaries: number; withoutChevron: string[]; nativeMarkers: string[]; beforeMarkers: string[]; glyphs: number; chevronLefts: number[] }

async function measure(page: Page): Promise<{ chatWidth: number; workbench: boolean; dense: boolean; rows: Row[]; markers: Markers; deep: { selector: string; x: number | undefined }[] }> {
  return transcript(page).evaluate((chat, kinds) => {
    const host = (chat.getRootNode() as ShadowRoot).host;
    const chatRect = chat.getBoundingClientRect();
    const chatRight = chatRect.left + chat.clientWidth;
    const alpha = (colour: string) => colour === "transparent" ? 0 : Number(/rgba?\([^)]*?,[^,)]*?,[^,)]*?(?:,\s*([\d.]+))?\)|\/\s*([\d.]+)\)/u.exec(colour)?.slice(1).find((value) => value !== undefined) ?? 1);
    // The chat's own effective background: the first opaque one up the composed tree.
    let base = "rgb(255, 255, 255)";
    for (let node: Element | null = chat; node !== null; node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null)) {
      const bg = getComputedStyle(node).backgroundColor;
      if (alpha(bg) > 0) { base = bg; break; }
    }
    // A closed <details> renders only its summary.
    const children = (element: Element): Element[] => element instanceof HTMLDetailsElement && !element.open
      ? Array.from(element.children).filter((child) => child.matches("summary"))
      : [...(element.shadowRoot ? Array.from(element.shadowRoot.children) : []), ...Array.from(element.children)];
    const shown = (element: Element) => { const style = getComputedStyle(element); return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().width > 1; };
    const fill = (style: CSSStyleDeclaration) => alpha(style.backgroundColor) > 0 && style.backgroundColor !== base;
    const paint = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return fill(style) || (parseFloat(style.borderLeftWidth) > 0 && alpha(style.borderLeftColor) > 0) || (parseFloat(style.borderTopWidth) > 0 && alpha(style.borderTopColor) > 0);
    };
    /** The first painted box in pre-order, crossing shadow roots. */
    const paintedBox = (element: Element): Element | undefined => {
      if (!shown(element) && element.getBoundingClientRect().height === 0) return undefined;
      if (paint(element)) return element;
      for (const child of children(element)) { const found = paintedBox(child); if (found !== undefined) return found; }
      return undefined;
    };
    /** Visible content in document order, crossing shadow roots; the fold chevron, message action strips and hidden labels are chrome.
     *  With `textOnly`, icons are skipped too: SVGs and symbol-only text such as ✓ ✖ ●, so a label is measured where its words start. */
    const contentRects = (element: Element, textOnly = false, out: DOMRect[] = []): DOMRect[] => {
      if (getComputedStyle(element).display === "none" || element.matches(".visually-hidden, .conversation-header, pi-message-actions-menu, .chevron")) return out;
      if (element instanceof SVGSVGElement) { const rect = element.getBoundingClientRect(); if (!textOnly && rect.width > 1) out.push(rect); return out; }
      const nodes = element instanceof HTMLDetailsElement && !element.open ? children(element)
        : [...(element.shadowRoot ? Array.from(element.shadowRoot.childNodes) : []), ...Array.from(element.childNodes)];
      for (const node of nodes) {
        const text = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "").trim() : "";
        if (text !== "" && !(textOnly && /^[\p{S}\p{P}\s]+$/u.test(text))) {
          const range = document.createRange();
          range.selectNodeContents(node);
          out.push(...Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 0));
        } else if (node instanceof Element) contentRects(node, textOnly, out);
      }
      return out;
    };
    /** Union of every painted box and visible content in the block, for gaps between neighbours. */
    const ink = (element: Element): { top: number; bottom: number } => {
      const rects: DOMRect[] = [...contentRects(element)];
      const walk = (node: Element) => { if (!shown(node) && node.getBoundingClientRect().height === 0) return; if (paint(node)) rects.push(node.getBoundingClientRect()); children(node).forEach(walk); };
      walk(element);
      if (rects.length === 0) { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; }
      return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    };
    const resolve = (selector: string): Element | null => {
      if (!selector.startsWith("tool:")) return chat.querySelector(selector);
      const status = selector.slice(5);
      const view = Array.from(chat.querySelectorAll("tool-execution-view")).find((candidate) => (candidate as unknown as { execution?: { status?: string } }).execution?.status === status && candidate.closest("details") === null);
      return view?.closest(".event-group") ?? null;
    };
    const findSummary = (element: Element): Element | undefined => {
      if (element.matches("summary")) return element;
      for (const child of children(element)) { const found = findSummary(child); if (found !== undefined) return found; }
      return undefined;
    };
    const marker = (summary: Element | undefined): string => {
      if (summary === undefined) return "none";
      if (summary.querySelector(":scope > .chevron svg") !== null) return "chevron";
      if (!["none", "normal"].includes(getComputedStyle(summary, "::before").content)) return "::before";
      if ((summary.textContent ?? "").trim().startsWith("▶")) return "▶ glyph";
      if (getComputedStyle(summary).display === "list-item") return "native marker";
      return "none (clickable text)";
    };
    const round = (value: number) => Math.round(value * 10) / 10;
    const isBlock = (element: Element) => element.matches(".msg, .notice-fold, .visible-events, .exchange-history, ask-user-card");
    const rows = kinds.map(({ kind, selector, nested }): Row => {
      const element = resolve(selector);
      if (element === null) return { kind, nested: nested === true, found: false };
      const box = paintedBox(element);
      const rect = (box ?? element).getBoundingClientRect();
      const style = getComputedStyle(box ?? element);
      const sides = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth];
      const content = contentRects(element, true)[0];
      // A message's body (below its role and time heading): its first and leftmost line must sit on the same column as every heading.
      const body = element.querySelector(".conversation-body");
      const bodyRects = body === null ? [] : Array.from(body.children).filter((child) => !child.matches(".msg-heading")).flatMap((child) => contentRects(child, true));
      const block = element.matches("summary") ? element.parentElement ?? element : element;
      const previous = (() => { for (let prev = block.previousElementSibling; prev !== null; prev = prev.previousElementSibling) if (prev.getBoundingClientRect().height > 0) return prev; return null; })();
      return {
        kind, nested: nested === true, found: true,
        left: round(rect.left - chatRect.left), right: round(chatRight - rect.right),
        bar: box !== undefined && parseFloat(style.borderLeftWidth) > 0 && sides.every((width) => parseFloat(width) === 0) ? style.borderLeftWidth : "none",
        barColour: style.borderLeftColor,
        background: box !== undefined && fill(style) ? style.backgroundColor : "none",
        radius: style.borderTopLeftRadius,
        contentStart: content === undefined ? undefined : round(content.left - chatRect.left),
        bodyStarts: bodyRects.length === 0 ? undefined : [round(bodyRects[0].left - chatRect.left), round(Math.min(...bodyRects.map((r) => r.left)) - chatRect.left)],
        marker: marker(findSummary(element)),
        gap: previous === null ? undefined : round(ink(block).top - ink(previous).bottom),
        afterBlock: previous !== null && isBlock(previous),
      };
    });
    // Every rendered summary anywhere in the transcript, shadow roots included.
    const summaries: Element[] = [];
    const glyphs: Text[] = [];
    const walk = (root: Element | ShadowRoot) => {
      for (const node of Array.from(root.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").includes("▶")) glyphs.push(node as Text);
        if (!(node instanceof Element)) continue;
        if (node.matches("summary") && node.getClientRects().length > 0) summaries.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
        walk(node);
      }
    };
    walk(chat);
    const label = (summary: Element) => (summary.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 40);
    const markers: Markers = {
      summaries: summaries.length,
      withoutChevron: summaries.filter((summary) => marker(summary) !== "chevron").map(label),
      nativeMarkers: summaries.filter((summary) => getComputedStyle(summary).display === "list-item" && getComputedStyle(summary).listStyleType !== "none").map(label),
      beforeMarkers: summaries.filter((summary) => !["none", "normal"].includes(getComputedStyle(summary, "::before").content)).map(label),
      glyphs: glyphs.length,
      chevronLefts: summaries.flatMap((summary) => { const chevron = summary.querySelector(":scope > .chevron"); return chevron === null ? [] : [round(chevron.getBoundingClientRect().left - chatRect.left)]; }),
    };
    // Text deeper inside blocks keeps the column too: question and answer words, and expanded tool output.
    const deepAll = (root: Element | ShadowRoot, selector: string, out: Element[] = []): Element[] => {
      for (const node of Array.from(root.querySelectorAll("*"))) { if (node.matches(selector)) out.push(node); if (node.shadowRoot) deepAll(node.shadowRoot, selector, out); }
      return out;
    };
    const deep = [".record-question h3 > span:not(.question-number)", ".question-detail", ".record-answers > li", ".detail-result pre", ".detail-label"].flatMap((selector) =>
      deepAll(chat, selector).filter((element) => element.getClientRects().length > 0).slice(0, 1).map((element) => {
        const first = contentRects(element, true)[0];
        return { selector, x: first === undefined ? undefined : round(first.left - chatRect.left) };
      }));
    return { chatWidth: round(chat.clientWidth), workbench: host.hasAttribute("workbench"), dense: host.hasAttribute("dense"), rows, markers, deep };
  }, KINDS);
}

const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

for (const layout of ["tabs", "grid"] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`every transcript kind follows the one-rail rule in ${layout} (${scheme})`, async ({ browser }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const page = await context.newPage();
      await openWindow(page, layout);
      if (layout === "grid") await expect(page.locator(".grid > .tile")).toHaveCount(3);
      const thinking = transcript(page).locator("details.thinking-group").first();
      if (await thinking.evaluate((element) => !(element as HTMLDetailsElement).open)) await thinking.locator("> summary").click();
      await expect(transcript(page).locator("details.tool-fold")).toHaveCount(1);
      await page.waitForTimeout(500);
      const result = await measure(page);
      const name = `${layout}-${scheme}`;
      if (OUT !== undefined) {
        await mkdir(OUT, { recursive: true });
        await writeFile(join(OUT, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
        const chat = transcript(page);
        const height = await chat.evaluate((element) => { element.scrollTop = 0; return { scroll: element.scrollHeight, client: element.clientHeight }; });
        for (let index = 0, top = 0; top < height.scroll && index < 8; index += 1, top += height.client - 40) {
          await chat.evaluate((element, value) => { element.scrollTop = value; }, top);
          await page.waitForTimeout(250);
          await page.screenshot({ path: join(OUT, `${name}-${String(index + 1)}.png`) });
        }
      }
      await context.close();

      expect(result.workbench).toBe(true);
      expect(result.dense).toBe(layout === "grid");
      const { rows, markers } = result;
      expect(rows.filter((row) => !row.found).map((row) => row.kind), "every kind is in the fixture").toEqual([]);
      const blocks = rows.filter((row) => !row.nested);
      // Each block: its bar is the painted box, at the transcript edge, spanning to its right edge, square, unfilled.
      expect(blocks.filter((row) => Math.abs(row.left ?? NaN) > 0.5).map((row) => `${row.kind}: left ${String(row.left)}`), "box left = 0").toEqual([]);
      expect(blocks.filter((row) => Math.abs(row.right ?? NaN) > 1).map((row) => `${row.kind}: right ${String(row.right)}`), "box spans to the right edge").toEqual([]);
      expect(blocks.filter((row) => row.radius !== "0px").map((row) => `${row.kind}: ${String(row.radius)}`), "square corners").toEqual([]);
      expect(blocks.filter((row) => row.bar !== "3px").map((row) => `${row.kind}: ${String(row.bar)}`), "3px left bar").toEqual([]);
      expect(blocks.filter((row) => row.background !== "none").map((row) => `${row.kind}: ${String(row.background)}`), "no fill").toEqual([]);
      expect(rows.filter((row) => row.nested && row.bar !== "none").map((row) => row.kind), "nested blocks draw no second bar").toEqual([]);
      // One text column for every kind, nested ones included: each heading's first word, and each message body's first and leftmost line.
      expect(result.deep.map((entry) => entry.selector), "question records and an expanded tool result are measured").toEqual([".record-question h3 > span:not(.question-number)", ".record-answers > li", ".detail-result pre", ".detail-label"].filter((selector) => result.deep.some((entry) => entry.selector === selector)).length === 4 ? result.deep.map((entry) => entry.selector) : ["missing deep text"]);
      const starts = [...rows.flatMap((row) => [row.contentStart ?? NaN, ...(row.bodyStarts ?? [])]), ...result.deep.map((entry) => entry.x ?? NaN)];
      expect(rows.filter((row) => row.kind.endsWith("message") && row.bodyStarts === undefined).map((row) => row.kind), "message bodies measured").toEqual([]);
      expect(spread(starts), `text starts: ${rows.map((row) => `${row.kind}=${[row.contentStart, ...(row.bodyStarts ?? [])].map(String).join("/")}`).join(", ")}; deep: ${result.deep.map((entry) => `${entry.selector}=${String(entry.x)}`).join(", ")}`).toBeLessThanOrEqual(1);
      // One marker: every rendered summary leads with the Lucide chevron, all at one x; no native, CSS or glyph marker.
      expect(markers.summaries).toBeGreaterThan(5);
      expect(markers.withoutChevron, "summaries without the chevron").toEqual([]);
      expect(markers.nativeMarkers, "native markers").toEqual([]);
      expect(markers.beforeMarkers, "::before markers").toEqual([]);
      expect(markers.glyphs, "▶ glyphs").toBe(0);
      expect(spread(markers.chevronLefts), `chevron x: ${markers.chevronLefts.join(", ")}`).toBeLessThanOrEqual(0.5);
      // One gap between consecutive blocks.
      const gaps = blocks.filter((row) => row.afterBlock === true && row.gap !== undefined);
      expect(gaps.length).toBeGreaterThan(10);
      expect(spread(gaps.map((row) => row.gap ?? NaN)), `gaps: ${gaps.map((row) => `${row.kind}=${String(row.gap)}`).join(", ")}`).toBeLessThanOrEqual(0.5);
    });
  }
}
