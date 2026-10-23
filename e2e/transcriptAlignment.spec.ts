import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ALL_KINDS_CHAT, E2E_MORE_CHATS, E2E_PROJECT_ID } from "./isolatedPiWeb";

// Throwaway audit: set PI_WEB_E2E_ALIGNMENT to a folder to write per-kind geometry (JSON) and screenshots
// of one Chat holding every transcript kind, in Tabs and a 3-tile Grid, light and dark.
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

/** Kind name → how to find its element inside `.chat` (light DOM of ChatView's shadow root). */
const KINDS: [string, string][] = [
  ["history fold (exchange)", "details.exchange-history > summary"],
  ["user message", ".chat > article.msg.user.conversation-message"],
  ["assistant message", ".chat > article.msg.assistant.conversation-message"],
  ["compaction summary", "details.history-group"],
  ["working-mode card", ".chat > .event-group.visible-events:has(.working-mode-card)"],
  ["thinking group", "details.thinking-group"],
  ["thinking › tool fold", "details.thinking-group details.tool-fold"],
  ["single tool row (bash)", "tool:success"],
  ["activity group (2 steps)", "details.activity-group"],
  ["failed tool (visible)", "tool:error"],
  ["background bash card", "article:has(> .background-bash-card)"],
  ["goal lifecycle card", "article:has(> .goal-lifecycle)"],
  ["subagent completion", "article:has(> .subagent-completion)"],
  ["ask_user record", "article.ask-user-record-shell"],
  ["quiet notice (lone)", ".chat > article.msg.notice-line"],
  ["notice fold", "details.notice-fold > summary"],
  ["tool image output", "article.tool-image-output"],
];

interface Row { kind: string; found: boolean; left?: number; right?: number; width?: number; bar?: string; background?: string; border?: string; radius?: string; textStart?: number; marker?: string; markerX?: number; gap?: number; painted?: string; host?: string }

async function measure(page: Page): Promise<{ chatWidth: number; workbench: boolean; dense: boolean; rows: Row[]; outline: string[] }> {
  return transcript(page).evaluate((chat, kinds) => {
    const host = (chat.getRootNode() as ShadowRoot).host;
    const chatRect = chat.getBoundingClientRect();
    const chatRight = chatRect.left + chat.clientWidth;
    const alpha = (colour: string) => colour === "transparent" ? 0 : Number(/rgba?\([^)]*?,[^,)]*?,[^,)]*?(?:,\s*([\d.]+))?\)/u.exec(colour)?.[1] ?? 1);
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
    const paint = (element: Element): string | undefined => {
      const style = getComputedStyle(element);
      const parts: string[] = [];
      if (alpha(style.backgroundColor) > 0 && style.backgroundColor !== base) parts.push("bg");
      if (parseFloat(style.borderLeftWidth) > 0 && alpha(style.borderLeftColor) > 0) parts.push("left");
      if (parseFloat(style.borderTopWidth) > 0 && alpha(style.borderTopColor) > 0) parts.push("top");
      return parts.length > 0 ? parts.join("+") : undefined;
    };
    /** The first painted box in pre-order, crossing shadow roots. */
    const paintedBox = (element: Element): Element | undefined => {
      if (!shown(element) && element.getBoundingClientRect().height === 0) return undefined;
      if (paint(element) !== undefined) return element;
      for (const child of children(element)) { const found = paintedBox(child); if (found !== undefined) return found; }
      return undefined;
    };
    // Visible text rects in document order, crossing shadow roots; message action strips and hidden labels are chrome, not content.
    const textRects = (element: Element, out: DOMRect[] = []): DOMRect[] => {
      if (getComputedStyle(element).display === "none" || element.matches(".visually-hidden, .conversation-header, pi-message-actions-menu") || element instanceof SVGElement) return out;
      const nodes = element instanceof HTMLDetailsElement && !element.open ? children(element)
        : [...(element.shadowRoot ? Array.from(element.shadowRoot.childNodes) : []), ...Array.from(element.childNodes)];
      for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "") {
          const range = document.createRange();
          range.selectNodeContents(node);
          out.push(...Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 0));
        } else if (node instanceof Element) textRects(node, out);
      }
      return out;
    };
    const firstText = (element: Element): DOMRect | undefined => textRects(element)[0];
    /** The painted box, else the union of visible text. */
    const visual = (element: Element): DOMRect => {
      const box = paintedBox(element);
      if (box !== undefined) return box.getBoundingClientRect();
      const rects = textRects(element);
      if (rects.length === 0) return element.getBoundingClientRect();
      const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
      const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
      return new DOMRect(left, top, right - left, bottom - top);
    };
    /** Union of every painted box and visible text in the block, for gaps between neighbours. */
    const ink = (element: Element): DOMRect => {
      const rects: DOMRect[] = [...textRects(element)];
      const walk = (node: Element) => { if (!shown(node) && node.getBoundingClientRect().height === 0) return; if (paint(node) !== undefined) rects.push(node.getBoundingClientRect()); children(node).forEach(walk); };
      walk(element);
      if (rects.length === 0) return element.getBoundingClientRect();
      const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
      return new DOMRect(0, top, 0, bottom - top);
    };
    /** Left edge of the disclosure marker, relative to the chat. */
    const markerX = (element: Element): number | undefined => {
      const summary = findSummary(element);
      if (summary === undefined) return undefined;
      const chevron = summary.querySelector(".chevron");
      if (chevron !== null) return chevron.getBoundingClientRect().left - chatRect.left;
      const style = getComputedStyle(summary);
      return summary.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) - chatRect.left;
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
    const marker = (element: Element): string => {
      const summary = findSummary(element);
      if (summary === undefined) return "none";
      if (summary.querySelector(".chevron") !== null) return "chevron svg";
      if (summary.classList.contains("ui-transcript-disclosure")) return "filled CSS triangle";
      if ((summary.textContent ?? "").trim().startsWith("▶")) return "▶ glyph";
      if (getComputedStyle(summary).display === "list-item") return "native marker";
      return "none (clickable text)";
    };
    const round = (value: number) => Math.round(value * 10) / 10;
    const rows = kinds.map(([kind, selector]): Row => {
      const element = resolve(selector);
      if (element === null) return { kind, found: false };
      const box = paintedBox(element) ?? element;
      // Unpainted kinds report their layout box for edges; text start and gaps use visible text.
      const rect = paintedBox(element) === undefined ? element.getBoundingClientRect() : visual(element);
      const style = getComputedStyle(box);
      const text = firstText(element);
      const block = element.matches("summary") ? element.parentElement ?? element : element;
      const previous = (() => { for (let prev = block.previousElementSibling; prev !== null; prev = prev.previousElementSibling) if (prev.getBoundingClientRect().height > 0) return prev; return null; })();
      const gap = previous === null ? undefined : ink(block).top - ink(previous).bottom;
      const sides = (["Top", "Right", "Bottom"] as const).map((side) => style.getPropertyValue(`border-${side.toLowerCase()}-width`));
      return {
        kind, found: true,
        left: round(rect.left - chatRect.left), right: round(chatRight - rect.right), width: round(rect.width),
        painted: paint(box) === undefined ? "no paint (text only)" : `${box.tagName.toLowerCase()}.${Array.from(box.classList).slice(0, 2).join(".")}`,
        bar: parseFloat(style.borderLeftWidth) > 0 && sides.every((width) => parseFloat(width) === 0) ? `${style.borderLeftWidth} ${style.borderLeftColor}` : "none",
        background: alpha(style.backgroundColor) > 0 && style.backgroundColor !== base ? style.backgroundColor : "none",
        border: sides.some((width) => parseFloat(width) > 0) ? `${style.borderTopWidth} ${style.borderTopColor}` : "none",
        radius: style.borderTopLeftRadius,
        textStart: text === undefined ? undefined : round(text.left - chatRect.left),
        marker: marker(element), markerX: (() => { const x = markerX(element); return x === undefined || marker(element) === "none" ? undefined : round(x); })(),
        gap: gap === undefined ? undefined : round(gap),
      };
    });
    // The tool row's "Details" line sits inside the tool card's shadow root.
    const toolView = resolve("tool:success")?.querySelector("tool-execution-view");
    const details = toolView?.shadowRoot?.querySelector(".text-body > summary");
    if (details) {
      const rect = details.getBoundingClientRect();
      const text = firstText(details);
      rows.splice(rows.findIndex((row) => row.kind.startsWith("single tool row")) + 1, 0, { kind: "  › its Details line", found: true, left: round(rect.left - chatRect.left), right: round(chatRight - rect.right), width: round(rect.width), painted: "summary (heading bg)", bar: "inherits card bar", background: getComputedStyle(details).backgroundColor, border: "none", radius: "0px", textStart: text === undefined ? undefined : round(text.left - chatRect.left), marker: marker(details), gap: undefined });
    }
    const outline = Array.from(chat.querySelectorAll(":scope > *, .exchange-history-body > *")).map((block) => {
      const rect = visual(block);
      const layout = block.getBoundingClientRect();
      const painted = paintedBox(block);
      return `${block.tagName.toLowerCase()}.${Array.from(block.classList).slice(0, 3).join(".")} layout y=${String(round(layout.top - chatRect.top + chat.scrollTop))} h=${String(round(layout.height))} visual y=${String(round(rect.top - chatRect.top + chat.scrollTop))} h=${String(round(rect.height))} paint=${painted === undefined ? "-" : `${painted.tagName.toLowerCase()}.${Array.from(painted.classList).slice(0, 2).join(".")}`} "${(block.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 50)}"`;
    });
    return { chatWidth: round(chat.clientWidth), workbench: host.hasAttribute("workbench"), dense: host.hasAttribute("dense"), rows, outline };
  }, KINDS);
}

test("measures every transcript kind in Tabs and a 3-tile Grid", async ({ browser }) => {
  test.skip(OUT === undefined, "set PI_WEB_E2E_ALIGNMENT to write the audit");
  test.setTimeout(240_000);
  await mkdir(OUT ?? "", { recursive: true });
  const results: Record<string, unknown> = {};
  for (const scheme of ["light", "dark"] as const) {
    for (const layout of ["tabs", "grid"] as const) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const page = await context.newPage();
      await openWindow(page, layout);
      if (layout === "grid") await expect(page.locator(".grid > .tile")).toHaveCount(3);
      const thinking = transcript(page).locator("details.thinking-group").first();
      if (await thinking.evaluate((element) => !(element as HTMLDetailsElement).open)) await thinking.locator("> summary").click();
      await expect(transcript(page).locator("details.tool-fold")).toHaveCount(1);
      await page.waitForTimeout(800);
      const name = `${layout}-${scheme}`;
      results[name] = await measure(page);
      // Scroll through the transcript a viewport at a time.
      const chat = transcript(page);
      const height = await chat.evaluate((element) => { element.scrollTop = 0; return { scroll: element.scrollHeight, client: element.clientHeight }; });
      for (let index = 0, top = 0; top < height.scroll && index < 8; index += 1, top += height.client - 40) {
        await chat.evaluate((element, value) => { element.scrollTop = value; }, top);
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(OUT ?? "", `${name}-${String(index + 1)}.png`) });
      }
      await context.close();
    }
  }
  await writeFile(join(OUT ?? "", "measurements.json"), `${JSON.stringify(results, null, 2)}\n`);
});
