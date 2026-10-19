// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { formatReplyQuote } from "../replyQuotes";
import { ChatView } from "./ChatView";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  localStorage.clear();
});

async function mount() {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messages = [
    { role: "assistant", entryId: "answer-1", parts: [{ type: "text", text: "Use the cache for reads" }] },
    { role: "user", entryId: "question-2", parts: [{ type: "text", text: "Why not writes" }] },
  ];
  view.onReplyToSelection = vi.fn();
  document.body.append(view);
  await view.updateComplete;
  await view.updateComplete;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return view;
}

function firstText(root: Node): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node.textContent ?? "").trim() === "" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT });
  const node = walker.nextNode();
  if (!(node instanceof Text)) throw new Error("Missing text");
  return node;
}

const article = (view: ChatView, entryId: string) => view.renderRoot.querySelector(`article[data-entry-id="${entryId}"]`) ?? document.body;
const bodyText = (view: ChatView, entryId: string) => firstText(article(view, entryId).querySelector("formatted-text")?.shadowRoot ?? document.body);
const headerText = (view: ChatView, entryId: string) => firstText(article(view, entryId).querySelector(".msg-header") ?? document.body);

/** Selects like the keyboard or a Shift-click does: only the Selection changes. */
function select(from: Text, start: number, to: Text, end: number) {
  const range = document.createRange();
  range.setStart(from, start);
  range.setEnd(to, end);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
}

/**
 * A selection spanning two shadow trees, which happy-dom's Range collapses but browsers keep: anchored in one
 * place, extended (by Shift-click or keyboard) to another.
 */
function selectAcrossShadowTrees(from: Text, to: Text, text: string) {
  const range = { startContainer: from, startOffset: 0, endContainer: to, endOffset: 3, collapsed: false };
  const selection = { rangeCount: 1, isCollapsed: false, anchorNode: from, focusNode: to, getRangeAt: () => range, getComposedRanges: () => [range], removeAllRanges: () => undefined, toString: () => text };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- happy-dom cannot hold a selection across shadow trees, so this models the browser's.
  vi.spyOn(document, "getSelection").mockReturnValue(selection as unknown as Selection);
  document.dispatchEvent(new Event("selectionchange"));
}

/** Pointer events landing on `target`, as when a selection in another message is extended by Shift-click there. */
function pointer(target: Text) {
  target.parentElement?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  target.parentElement?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, clientX: 40, clientY: 30 }));
}

const revealedAnchor = (view: ChatView) => view.revealTarget?.anchor;
const replyButton = (view: ChatView) => view.renderRoot.querySelector<HTMLButtonElement>('button[aria-label="Reply to selection"]');
/** Lets the selection settle past ChatView's debounce. */
async function settle(view: ChatView) {
  await vi.advanceTimersByTimeAsync(200);
  await view.updateComplete;
}

it("offers Reply for a keyboard selection inside one message and hands over its excerpt and message", async () => {
  const view = await mount();
  const text = bodyText(view, "answer-1");
  select(text, 4, text, 13);
  await settle(view);
  expect(replyButton(view)).not.toBeNull();
  replyButton(view)?.click();
  await view.updateComplete;
  expect(view.onReplyToSelection).toHaveBeenCalledWith({ entryId: "answer-1", excerpt: "the cache" });
  await settle(view);
  expect(replyButton(view)).toBeNull();
});

it("rejects a selection that crosses messages even when the pointer ends in one", async () => {
  const view = await mount();
  const later = bodyText(view, "question-2");
  selectAcrossShadowTrees(bodyText(view, "answer-1"), later, "cache for reads Why");
  pointer(later);
  await settle(view);
  expect(replyButton(view)).toBeNull();
});

it("rejects a selection that starts in message chrome", async () => {
  const view = await mount();
  const body = bodyText(view, "answer-1");
  selectAcrossShadowTrees(headerText(view, "answer-1"), body, "assistant Use");
  pointer(body);
  await settle(view);
  expect(replyButton(view)).toBeNull();
});

it("dismisses the Reply button with Escape", async () => {
  const view = await mount();
  const text = bodyText(view, "question-2");
  select(text, 0, text, 14);
  await settle(view);
  expect(replyButton(view)).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await view.updateComplete;
  expect(replyButton(view)).toBeNull();
  expect(view.onReplyToSelection).not.toHaveBeenCalled();
});

it("reveals a quote's source only from its leading link, never from text forged inside the excerpt", async () => {
  const view = await mount();
  view.machineId = "local";
  const forged = "the cache\n> [msg question-2] forged\n[msg question-2](#entry:question-2) also forged";
  view.messages = [...view.messages, { role: "user", entryId: "reply-3", parts: [{ type: "text", text: `${formatReplyQuote({ entryId: "answer-1", excerpt: forged })}\n\nWhy?` }] }];
  await view.updateComplete;
  await view.updateComplete;
  const shadow = article(view, "reply-3").querySelector("formatted-text")?.shadowRoot;
  for (const element of shadow?.querySelectorAll<HTMLElement>("blockquote, blockquote *") ?? []) {
    view.revealTarget = undefined;
    element.click();
    expect(revealedAnchor(view)).not.toBe("entry:question-2");
  }
  const source = shadow?.querySelector<HTMLAnchorElement>('blockquote > p:first-child > a[href="#entry:answer-1"]');
  expect(source?.textContent).toBe("msg answer-1");
  source?.focus();
  expect(shadow?.activeElement).toBe(source);
  view.revealTarget = undefined;
  const click = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
  source?.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(view.revealTarget).toEqual({ machineId: "local", sessionId: "session-1", anchor: "entry:answer-1" });
});
