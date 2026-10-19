// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingAskUser } from "../../../shared/apiTypes";
import type { AskUserCard } from "./AskUserCard";
import { updatedAgo } from "./AskUserCard";
import { WorkbenchQuestionsPane } from "./WorkbenchQuestionsPane";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
});

function ask(askId: string, patch: Partial<PendingAskUser> = {}): PendingAskUser {
  return {
    askId,
    askedAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    revision: "r1",
    turnsSinceUpdate: 0,
    context: "**Finding:** the cache is stale.",
    questions: [{ id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres", recommended: true }, { value: "sqlite", label: "SQLite" }] }],
    ...patch,
  };
}

async function mountPane(asks: PendingAskUser[]) {
  const pane = new WorkbenchQuestionsPane();
  pane.asks = asks;
  pane.draftSessionId = "local:session-1";
  const onSubmit = vi.fn(() => Promise.resolve());
  pane.onSubmit = onSubmit;
  document.body.append(pane);
  await pane.updateComplete;
  const cards = [...(pane.shadowRoot?.querySelectorAll<AskUserCard>("ask-user-card") ?? [])];
  await Promise.all(cards.map((card) => card.updateComplete));
  return { pane, cards, onSubmit };
}

const text = (card: AskUserCard | undefined) => card?.shadowRoot?.textContent.replace(/\s+/g, " ") ?? "";

describe("WorkbenchQuestionsPane", () => {
  it("lists every open question set with context, refs, recommended option, Custom, and a Send button", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:05:00.000Z"));
    const { cards } = await mountPane([ask("abc-1"), ask("def-2", { turnsSinceUpdate: 6, updatedAt: "2026-10-19T08:00:00.000Z" })]);

    expect(cards).toHaveLength(2);
    expect(cards[0]?.shadowRoot?.querySelector("formatted-text")).not.toBeNull();
    expect(text(cards[0])).toContain("abc.db");
    expect(text(cards[0])).toContain("Postgres Recommended");
    expect(text(cards[0])).toContain("Custom");
    expect(text(cards[0])).toContain("updated 5 min ago");
    expect(text(cards[0])).not.toContain("may be stale");
    expect(text(cards[1])).toContain("def.db");
    expect(text(cards[1])).toContain("updated 2 h ago");
    expect(text(cards[1])).toContain("may be stale");
    expect(cards[1]?.shadowRoot?.querySelector('button[type="submit"]')?.textContent.trim()).toBe("Send answers");
  });

  it("sends one set's answers through the submit callback", async () => {
    const { cards, onSubmit } = await mountPane([ask("abc-1"), ask("def-2")]);
    const second = cards[1];
    second?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await second?.updateComplete;

    second?.shadowRoot?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await vi.waitFor(() => { expect(onSubmit).toHaveBeenCalledWith("def-2", { answers: [{ id: "db", values: ["pg"] }], revision: "r1" }); });
  });

  it("drops an answered set while keeping the other card and its draft", async () => {
    const { pane, cards } = await mountPane([ask("abc-1"), ask("def-2")]);
    const survivor = cards[1];

    pane.asks = [ask("def-2")];
    await pane.updateComplete;

    const remaining = [...(pane.shadowRoot?.querySelectorAll<AskUserCard>("ask-user-card") ?? [])];
    expect(remaining).toEqual([survivor]);
  });

  it("says so when the Chat has no open questions", async () => {
    const { pane } = await mountPane([]);
    expect(pane.shadowRoot?.textContent).toContain("No open questions in this Chat.");
  });

  it("formats the update age coarsely", () => {
    const now = Date.parse("2026-10-19T10:00:00.000Z");
    expect(updatedAgo("2026-10-19T09:59:30.000Z", now)).toBe("updated just now");
    expect(updatedAgo("2026-10-19T09:15:00.000Z", now)).toBe("updated 45 min ago");
    expect(updatedAgo("2026-10-17T09:00:00.000Z", now)).toBe("updated 2 d ago");
  });
});
