// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserOutcome } from "../../../shared/apiTypes";
import type { ChatLine } from "./shared";
import { AskUserCard } from "./AskUserCard";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ChatView open ask_user form", () => {
  it("scrolls a newly opened form to its start and gives it a stable chat-scroll anchor", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    document.body.append(view);
    await view.updateComplete;
    let askStartScrolls = 0;
    let bottomScrolls = 0;
    if (!Reflect.set(view, "scrollToOpenAsk", () => { askStartScrolls += 1; })) throw new Error("Could not observe ChatView.scrollToOpenAsk");
    if (!Reflect.set(view, "scrollToBottom", () => { bottomScrolls += 1; })) throw new Error("Could not observe ChatView.scrollToBottom");

    view.pendingAsk = {
      askId: "ask-open",
      askedAt: "2026-07-20T10:00:00.000Z",
      questions: [{ id: "editor", question: "Which editor?", options: [{ value: "vim", label: "Vim" }] }],
    };
    await view.updateComplete;

    expect(askStartScrolls).toBe(1);
    expect(bottomScrolls).toBe(0);
    expect(view.shadowRoot?.querySelector("ask-user-card")?.getAttribute("data-scroll-anchor-id")).toBe("ask:ask-open");
  });

  it("scrolls and focuses the first unanswered control for the requested ask identity", async () => {
    const view = new ChatView();
    view.sessionId = "session-1";
    view.pendingAsk = {
      askId: "ask-focus",
      askedAt: "2026-07-20T10:00:00.000Z",
      questions: [{ id: "editor", question: "Which editor?", options: [{ value: "vim", label: "Vim" }] }],
    };
    document.body.append(view);
    await view.updateComplete;
    const card = requiredElement(view.shadowRoot?.querySelector("ask-user-card"), "open ask card");
    if (!(card instanceof AskUserCard)) throw new Error("Expected AskUserCard");
    await card.updateComplete;
    const scrollIntoView = vi.fn();
    card.scrollIntoView = scrollIntoView;

    expect(await view.focusPendingAsk("other-ask")).toBe(false);
    expect(await view.focusPendingAsk("ask-focus")).toBe(true);
    await Promise.resolve();

    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "smooth" });
    expect(card.shadowRoot?.activeElement).toBe(card.shadowRoot?.querySelector("input"));
  });
});

describe("ChatView collapsed current-exchange history", () => {
  it("expands history before capturing a prepend scroll anchor", async () => {
    const view = historyView();
    document.body.append(view);
    await view.updateComplete;
    const history = requiredDetails(view.shadowRoot?.querySelector("details.exchange-history"));
    expect(history.open).toBe(false);
    const capture = vi.fn(() => {
      expect(history.open).toBe(true);
      return undefined;
    });
    if (!Reflect.set(view, "capturePrependScrollAnchor", capture)) throw new Error("Could not observe prepend capture");

    view.messages = [chatLine("user", "earliest"), chatLine("assistant", "earliest answer"), ...view.messages];
    view.messageStart = 8;
    await view.updateComplete;

    expect(capture).toHaveBeenCalledOnce();
  });

  it("expands history before restoring a prepend marker anchored inside it", async () => {
    const view = historyView();
    document.body.append(view);
    await view.updateComplete;
    const history = requiredDetails(view.shadowRoot?.querySelector("details.exchange-history"));

    view.restorePrependScrollAnchor({ distanceFromBottom: 0, markerId: "m:10", markerOffset: 0 });

    expect(history.open).toBe(true);
  });
});

describe("ChatView ask_user transcript records", () => {
  it("renders a projected outcome as the read-only question card with the machine-scoped draft key", async () => {
    const outcome: AskUserOutcome = {
      askId: "ask-1",
      reason: "submitted",
      askedAt: "2026-07-20T10:00:00.000Z",
      closedAt: "2026-07-20T10:05:00.000Z",
      questions: [
        {
          question: { id: "editor", question: "Which editor?", options: [{ value: "vim", label: "Vim" }] },
          answered: true,
          values: ["vim"],
        },
        {
          question: { id: "region", question: "Which region?", options: [{ value: "eu", label: "Europe" }] },
          answered: false,
          values: [],
        },
      ],
      answeredCount: 1,
      unansweredIds: ["region"],
      summary: "Answered 1 of 2; unanswered: region",
    };
    const view = new ChatView();
    view.sessionId = "session-1";
    view.askDraftSessionId = "remote-a:session-1";
    view.messages = [{ role: "system", parts: [{ type: "askUserRecord", outcome }] }];
    document.body.append(view);
    await view.updateComplete;

    const card = requiredElement(view.shadowRoot?.querySelector("ask-user-card"), "ask_user record card");
    expect(card).toBeInstanceOf(AskUserCard);
    expect(card.outcome).toEqual(outcome);
    expect(card.ask).toBeUndefined();
    expect(card.draftSessionId).toBe("remote-a:session-1");
    await card.updateComplete;

    const cardRoot = requiredElement(card.shadowRoot, "ask_user record shadow root");
    expect(cardRoot.textContent).toContain("Answers sent");
    expect(cardRoot.textContent).toContain("Vim");
    expect(cardRoot.textContent).toContain("Which region?");
    expect(cardRoot.textContent).toContain("Unanswered");
    expect(cardRoot.querySelector("input, textarea, button, select")).toBeNull();
    expect(view.shadowRoot?.querySelector("article.ask-user-record-shell .msg-header")).toBeNull();
  });
});

function historyView(): ChatView {
  const view = new ChatView();
  view.sessionId = "session-1";
  view.messageStart = 10;
  view.messageTotal = 14;
  view.messages = [
    chatLine("user", "old"),
    chatLine("assistant", "old answer"),
    chatLine("user", "current"),
    chatLine("assistant", "current answer"),
  ];
  return view;
}

function chatLine(role: ChatLine["role"], text: string): ChatLine {
  return { role, parts: [{ type: "text", text }] };
}

function requiredDetails(value: Element | null | undefined): HTMLDetailsElement {
  if (!(value instanceof HTMLDetailsElement)) throw new Error("Expected collapsed exchange history");
  return value;
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
