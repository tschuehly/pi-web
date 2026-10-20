// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingAskUser } from "../../../shared/apiTypes";
import { AskUserCard, updatedAgo } from "./AskUserCard";
import { WorkbenchQuestionChips, openQuestionCount } from "./WorkbenchQuestionChips";

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

const twoQuestions = ask("def-2", { questions: [
  { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] },
  { id: "why", question: "Why now?", options: [] },
] });

async function mount(asks: PendingAskUser[]) {
  const chips = new WorkbenchQuestionChips();
  chips.asks = asks;
  chips.draftSessionId = "local:session-1";
  const onSubmit = vi.fn(() => Promise.resolve());
  chips.onSubmit = onSubmit;
  document.body.append(chips);
  await chips.updateComplete;
  return { chips, onSubmit };
}

const chipButtons = (chips: WorkbenchQuestionChips) => [...(chips.shadowRoot?.querySelectorAll<HTMLButtonElement>(".chip") ?? [])];
const drawer = (chips: WorkbenchQuestionChips) => chips.shadowRoot?.querySelector<HTMLElement>(".drawer") ?? null;
const cards = (chips: WorkbenchQuestionChips) => [...(chips.shadowRoot?.querySelectorAll<AskUserCard>("ask-user-card") ?? [])];
const text = (card: AskUserCard | undefined) => card?.shadowRoot?.textContent.replace(/\s+/g, " ") ?? "";

async function openWith(chips: WorkbenchQuestionChips, chip: HTMLButtonElement | undefined) {
  chip?.click();
  await chips.updateComplete;
  await Promise.all(cards(chips).map((card) => card.updateComplete));
}

describe("WorkbenchQuestionChips", () => {
  it("shows one focusable chip per open question and no drawer until one is chosen", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);

    expect(chipButtons(chips).map((chip) => chip.textContent.trim())).toEqual(["Which database?", "Which database?", "Why now?"]);
    expect(chipButtons(chips).every((chip) => chip.type === "button" && chip.tabIndex === 0 && chip.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(drawer(chips)).toBeNull();
    expect(openQuestionCount([ask("abc-1"), twoQuestions])).toBe(3);
  });

  it("renders nothing for a Chat without open questions", async () => {
    const { chips } = await mount([]);
    expect(chips.shadowRoot?.querySelector(".chips")).toBeNull();
  });

  it("opens a drawer of every set with its context beside the questions, recommended option, Custom and Send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:05:00.000Z"));
    const { chips } = await mount([ask("abc-1"), ask("def-2", { turnsSinceUpdate: 6, updatedAt: "2026-10-19T08:00:00.000Z" })]);

    await openWith(chips, chipButtons(chips)[1]);

    expect(drawer(chips)?.getAttribute("aria-label")).toBe("Open questions");
    expect(chipButtons(chips)[1]?.getAttribute("aria-expanded")).toBe("true");
    const [first, second] = cards(chips);
    expect(cards(chips).every((card) => card.hasAttribute("context-beside"))).toBe(true);
    expect(AskUserCard.styles.cssText).toMatch(/:host\(\[context-beside\]\) \.open-card:has\(\.ask-context\) \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.15fr\)/);
    expect(first?.shadowRoot?.querySelector("formatted-text")).not.toBeNull();
    expect(text(first)).toContain("abc.db");
    expect(text(first)).toContain("Postgres Recommended");
    expect(text(first)).toContain("Custom");
    expect(text(first)).toContain("updated 5 min ago");
    expect(text(second)).toContain("may be stale");
    expect(second?.shadowRoot?.querySelector('button[type="submit"]')?.textContent.trim()).toBe("Send answers");
  });

  it("focuses the chosen question in the drawer", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    const focus = vi.spyOn(AskUserCard.prototype, "focusQuestion");

    await openWith(chips, chipButtons(chips)[2]);

    await vi.waitFor(() => { expect(focus).toHaveBeenCalledWith(1); });
    expect(focus.mock.contexts[0]).toBe(cards(chips)[1]);
  });

  it("opens a question for a caller, as its chip would, and refuses one no open set asks", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    const focus = vi.spyOn(AskUserCard.prototype, "focusQuestion");

    expect(await chips.openQuestion("def-2", 5)).toBe(false);
    expect(drawer(chips)).toBeNull();
    expect(await chips.openQuestion("def-2", 1)).toBe(true);

    expect(drawer(chips)).not.toBeNull();
    expect(focus).toHaveBeenCalledWith(1);
    expect(chipButtons(chips).map((chip) => [chip.dataset["ask"], chip.dataset["question"]])).toEqual([["abc-1", "0"], ["def-2", "0"], ["def-2", "1"]]);
  });

  it("keeps the chips to one sideways-scrolling row and the drawer at its forms' height up to 60% of the tile, shrinking only once the transcript is gone", () => {
    const styles = WorkbenchQuestionChips.styles.cssText;
    expect(styles).toMatch(/:host \{[^}]*flex: 0 1 auto;[^}]*min-height: 0;/);
    expect(styles).toMatch(/\.chips \{ flex: 0 0 auto;/);
    expect(styles).toMatch(/\.chips \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/);
    expect(styles).toMatch(/\.chip \{ flex: 0 0 auto;/);
    expect(styles).toMatch(/\.drawer \{[^}]*max-height: min\(60cqh, 640px\);/);
    expect(styles).toMatch(/\.drawer \{ flex: 0 1 auto;[^}]*min-height: 0;/);
  });

  it("frames one set flat under a single header line carrying the count and close button; several sets keep a drawer header", async () => {
    const { chips } = await mount([twoQuestions]);
    await openWith(chips, chipButtons(chips)[0]);
    const [card] = cards(chips);
    expect(card?.hasAttribute("flat")).toBe(true);
    expect(drawer(chips)?.querySelector("header")).toBeNull();
    expect(card?.querySelector('[slot="title"]')?.textContent).toBe("2 open questions");
    expect(card?.querySelector('[slot="actions"]')?.getAttribute("aria-label")).toBe("Close questions");

    chips.asks = [ask("abc-1"), twoQuestions];
    await chips.updateComplete;
    expect(drawer(chips)?.querySelector("header")?.textContent).toContain("3 open questions");
    expect(cards(chips).every((each) => each.hasAttribute("flat") && each.children.length === 0)).toBe(true);
  });

  it("sends one set's answers through the submit callback", async () => {
    const { chips, onSubmit } = await mount([ask("abc-1"), ask("def-2")]);
    await openWith(chips, chipButtons(chips)[0]);
    const second = cards(chips)[1];
    second?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await second?.updateComplete;

    second?.shadowRoot?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await vi.waitFor(() => { expect(onSubmit).toHaveBeenCalledWith("def-2", { answers: [{ id: "db", values: ["pg"] }], revision: "r1" }); });
  });

  it("closes the drawer on Esc or its close button, returning focus to the chip", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    const chip = chipButtons(chips)[1];
    await openWith(chips, chip);

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    drawer(chips)?.dispatchEvent(escape);
    await chips.updateComplete;

    expect(escape.defaultPrevented).toBe(true);
    expect(drawer(chips)).toBeNull();
    await vi.waitFor(() => { expect(chips.shadowRoot?.activeElement).toBe(chip); });

    await openWith(chips, chip);
    chips.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Close questions"]')?.click();
    await chips.updateComplete;
    expect(drawer(chips)).toBeNull();
    expect(chip?.getAttribute("aria-expanded")).toBe("false");
  });

  it("drops an answered set while keeping the other card and its draft, and folds away with the last", async () => {
    const { chips } = await mount([ask("abc-1"), ask("def-2")]);
    await openWith(chips, chipButtons(chips)[0]);
    const survivor = cards(chips)[1];

    chips.asks = [ask("def-2")];
    await chips.updateComplete;
    expect(cards(chips)).toEqual([survivor]);
    expect(chipButtons(chips)).toHaveLength(1);

    chips.asks = [];
    await chips.updateComplete;
    expect(drawer(chips)).toBeNull();
    chips.asks = [ask("ghi-3")];
    await chips.updateComplete;
    expect(drawer(chips)).toBeNull();
  });

  it("formats the update age coarsely", () => {
    const now = Date.parse("2026-10-19T10:00:00.000Z");
    expect(updatedAgo("2026-10-19T09:59:30.000Z", now)).toBe("updated just now");
    expect(updatedAgo("2026-10-19T09:15:00.000Z", now)).toBe("updated 45 min ago");
    expect(updatedAgo("2026-10-17T09:00:00.000Z", now)).toBe("updated 2 d ago");
  });
});
