// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
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
  return view;
}

function textNode(view: ChatView, entryId: string): Text {
  const article = view.renderRoot.querySelector(`article[data-entry-id="${entryId}"]`);
  const formatted = article?.querySelector("formatted-text");
  const root = formatted?.shadowRoot ?? article;
  const walker = document.createTreeWalker(root ?? document.body, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node.textContent ?? "").trim() === "" ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT });
  const node = walker.nextNode();
  if (!(node instanceof Text)) throw new Error(`Missing text in ${entryId}`);
  return node;
}

/** Drags a selection from one text node to another, the way a mouse selection arrives. */
async function dragSelect(view: ChatView, from: Text, to: Text, end: number) {
  from.parentElement?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  const range = document.createRange();
  range.setStart(from, 4);
  range.setEnd(to, end);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  to.parentElement?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, clientX: 40, clientY: 30 }));
  await view.updateComplete;
}

const replyButton = (view: ChatView) => view.renderRoot.querySelector<HTMLButtonElement>('button[aria-label="Reply to selection"]');

it("offers Reply for a selection inside one message and hands over its excerpt and message", async () => {
  const view = await mount();
  const text = textNode(view, "answer-1");
  await dragSelect(view, text, text, 13);
  const button = replyButton(view);
  expect(button).not.toBeNull();
  button?.click();
  await view.updateComplete;
  expect(view.onReplyToSelection).toHaveBeenCalledWith({ entryId: "answer-1", excerpt: "the cache" });
  expect(replyButton(view)).toBeNull();
});

it("ignores selections that cross messages", async () => {
  const view = await mount();
  await dragSelect(view, textNode(view, "answer-1"), textNode(view, "question-2"), 3);
  expect(replyButton(view)).toBeNull();
});

it("dismisses the Reply button with Escape", async () => {
  const view = await mount();
  const text = textNode(view, "question-2");
  await dragSelect(view, text, text, 14);
  expect(replyButton(view)).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await view.updateComplete;
  expect(replyButton(view)).toBeNull();
  expect(view.onReplyToSelection).not.toHaveBeenCalled();
});

it("scrolls to a quoted message when its quote is clicked", async () => {
  const view = await mount();
  view.machineId = "local";
  view.messages = [...view.messages, { role: "user", entryId: "reply-3", parts: [{ type: "text", text: "> [msg answer-1] the cache\n\nWhy?" }] }];
  await view.updateComplete;
  await view.updateComplete;
  const quote = view.renderRoot.querySelector('article[data-entry-id="reply-3"] formatted-text')?.shadowRoot?.querySelector("blockquote");
  expect(quote).not.toBeNull();
  quote?.querySelector("p")?.click();
  expect(view.revealTarget).toEqual({ machineId: "local", sessionId: "session-1", anchor: "entry:answer-1" });
});
