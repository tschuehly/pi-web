// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingAskUser } from "../../../shared/apiTypes";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY } from "../extensionStatusSnapshots";
import { AskUserCard, updatedAgo } from "./AskUserCard";
import { DelegateRoster } from "./DelegateRoster";
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

const running: SessionStatus = {
  sessionId: "s", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
  extensionStatuses: { [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [{ id: "w", kind: "worker", name: "Rows", activity: "running" }] }) },
};

async function mount(asks: PendingAskUser[], setup?: (chips: WorkbenchQuestionChips) => void) {
  const chips = new WorkbenchQuestionChips();
  chips.asks = asks;
  setup?.(chips);
  chips.draftSessionId = "local:session-1";
  const onSubmit = vi.fn(() => Promise.resolve());
  chips.onSubmit = onSubmit;
  document.body.append(chips);
  await chips.updateComplete;
  await roster(chips)?.updateComplete;
  return { chips, onSubmit };
}

const roster = (chips: WorkbenchQuestionChips) => chips.shadowRoot?.querySelector<DelegateRoster>("delegate-roster") ?? undefined;
/** The row's two halves: the roster's Activity toggle and what its header slot shows. */
function row(chips: WorkbenchQuestionChips) {
  const shadow = roster(chips)?.shadowRoot;
  const slot = shadow?.querySelector<HTMLSlotElement>('slot[name="aside"]');
  return { toggle: shadow?.querySelector(".head > .section-toggle") ?? null, aside: slot?.assignedElements() ?? [], slotParent: slot?.parentElement ?? null, rows: shadow?.querySelector<HTMLElement>("section > .rows") ?? null };
}

const bar = (chips: WorkbenchQuestionChips) => chips.shadowRoot?.querySelector<HTMLButtonElement>(".bar") ?? undefined;
const drawer = (chips: WorkbenchQuestionChips) => chips.shadowRoot?.querySelector<HTMLElement>(".drawer") ?? null;
const cards = (chips: WorkbenchQuestionChips) => [...(chips.shadowRoot?.querySelectorAll<AskUserCard>("ask-user-card") ?? [])];
const text = (card: AskUserCard | undefined) => card?.shadowRoot?.textContent.replace(/\s+/g, " ") ?? "";

async function openWith(chips: WorkbenchQuestionChips, button = bar(chips)) {
  button?.click();
  await chips.updateComplete;
  await Promise.all(cards(chips).map((card) => card.updateComplete));
}

describe("WorkbenchQuestionChips", () => {
  it("shows one focusable bar counting every set's open questions and no drawer until it is chosen", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);

    expect(chips.shadowRoot?.querySelectorAll(".bar")).toHaveLength(1);
    expect(bar(chips)?.textContent.trim()).toBe("3 open questions");
    expect(bar(chips)?.type).toBe("button");
    expect(bar(chips)?.getAttribute("aria-expanded")).toBe("false");
    expect(drawer(chips)).toBeNull();
    expect(openQuestionCount([ask("abc-1"), twoQuestions])).toBe(3);
  });

  it("counts answered questions from the drafts and as the user answers in the drawer", async () => {
    localStorage.setItem("pi-web:ask-draft:local:session-1:def-2", JSON.stringify({ why: { values: [], otherText: "Soon", asked: JSON.stringify(twoQuestions.questions[1]) } }));
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    expect(bar(chips)?.textContent.replace(/\s+/g, " ").trim()).toBe("3 open questions · 1 answered");

    await openWith(chips);
    cards(chips)[0]?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await chips.updateComplete;
    expect(bar(chips)?.textContent.replace(/\s+/g, " ").trim()).toBe("3 open questions · 2 answered");
  });

  it("renders nothing for a Chat without open questions", async () => {
    const { chips } = await mount([]);
    expect(bar(chips)).toBeUndefined();
  });

  it("opens a drawer of every set with its context above the questions, recommended option, Custom and Send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:05:00.000Z"));
    const { chips } = await mount([ask("abc-1"), ask("def-2", { turnsSinceUpdate: 6, updatedAt: "2026-10-19T08:00:00.000Z" })]);

    await openWith(chips);

    expect(drawer(chips)?.getAttribute("aria-label")).toBe("Open questions");
    expect(bar(chips)?.getAttribute("aria-expanded")).toBe("true");
    expect(chips.hasAttribute("open")).toBe(true);
    const [first, second] = cards(chips);
    expect(AskUserCard.styles.cssText).not.toContain("context-beside");
    expect(first?.shadowRoot?.querySelector(".ask-context + form .questions")).not.toBeNull();
    expect(first?.shadowRoot?.querySelector("formatted-text")).not.toBeNull();
    expect(text(first)).toContain("abc.db");
    expect(text(first)).toContain("Postgres Recommended");
    expect(text(first)).toContain("Custom");
    expect(text(first)).toContain("updated 5 min ago");
    expect(text(second)).toContain("may be stale");
    expect(second?.shadowRoot?.querySelector('button[type="submit"]')?.textContent.trim()).toBe("Send answers");
    expect(first?.shadowRoot?.querySelector(".send-one")).toBeNull();
  });

  it("focuses the first question of the oldest set when the bar opens the drawer", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    const focus = vi.spyOn(AskUserCard.prototype, "focusQuestion");

    await openWith(chips);

    await vi.waitFor(() => { expect(focus).toHaveBeenCalledWith(0); });
    expect(focus.mock.contexts[0]).toBe(cards(chips)[0]);
  });

  it("opens a question for a caller and refuses one no open set asks", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    const focus = vi.spyOn(AskUserCard.prototype, "focusQuestion");

    expect(await chips.openQuestion("def-2", 5)).toBe(false);
    expect(drawer(chips)).toBeNull();
    expect(await chips.openQuestion("def-2", 1)).toBe(true);

    expect(drawer(chips)).not.toBeNull();
    expect(focus).toHaveBeenCalledWith(1);
    expect(focus.mock.contexts[0]).toBe(cards(chips)[1]);
  });

  it("shares one row: Activity and the bar split the roster's header line, the entries span below, the drawer opens above", async () => {
    const { chips } = await mount([ask("abc-1")], (each) => { each.status = running; each.rosterCollapsed = false; });
    const both = row(chips);
    expect(both.toggle?.textContent).toContain("Activity");
    expect(both.aside).toEqual([bar(chips)]);
    expect(both.slotParent?.classList.contains("head")).toBe(true);
    // The entries are the header line's sibling, not inside either half.
    expect(both.rows?.hidden).toBe(false);
    expect(both.rows?.previousElementSibling?.classList.contains("head")).toBe(true);

    await openWith(chips);
    expect(chips.shadowRoot?.firstElementChild).toBe(drawer(chips));
    expect(drawer(chips)?.nextElementSibling).toBe(roster(chips));

    const styles = WorkbenchQuestionChips.styles.cssText;
    expect(styles).toMatch(/:host \{[^}]*flex: 0 0 auto;[^}]*min-height: 0;/);
    expect(styles).toMatch(/:host\(\[open\]\) \{ flex: 1 1 0; \}/);
    expect(styles).toMatch(/\.bar \{[^}]*min-height: 24px;[^}]*background: transparent;/);
    expect(styles).toMatch(/\.drawer \{ flex: 1 1 0;[^}]*min-height: 0;/);
    expect(styles).not.toMatch(/\.drawer \{[^}]*(max-height|margin|border|box-shadow)/);
    // Each half takes an even share of the line, so either alone takes all of it.
    expect(DelegateRoster.styles.cssText).toMatch(/\.section-toggle, ::slotted\(\[slot="aside"\]\) \{ flex: 1 1 0; min-width: 0; \}/);
    // The flat card keeps its actions in view at the drawer's bottom.
    expect(AskUserCard.styles.cssText).toMatch(/:host\(\[flat\]\) \.form-footer \{ position: sticky; bottom: 0;/);
  });

  it("gives Activity the whole row without open questions, and the bar the whole row without activity", async () => {
    const { chips } = await mount([], (each) => { each.status = running; });
    expect(row(chips).toggle).not.toBeNull();
    expect(row(chips).aside).toEqual([]);

    const lone = (await mount([ask("abc-1")])).chips;
    expect(row(lone).toggle).toBeNull();
    expect(row(lone).aside).toEqual([bar(lone)]);
    expect(row(lone).slotParent?.matches("section.lone")).toBe(true);

    // A Grid tile's folded roster (its toggle lives in the composer) leaves the bar the row too.
    const compact = (await mount([ask("abc-1")], (each) => { each.status = running; each.rosterCompact = true; })).chips;
    expect(row(compact).toggle).toBeNull();
    expect(row(compact).slotParent?.matches("section.lone")).toBe(true);

    // Neither: no row at all.
    const empty = (await mount([])).chips;
    expect(roster(empty)?.shadowRoot?.querySelector("section")).toBeNull();

    // Questions arriving later move into the row beside Activity.
    chips.asks = [ask("abc-1")];
    await chips.updateComplete;
    await vi.waitFor(() => { expect(row(chips).aside).toEqual([bar(chips)]); });
    expect(row(chips).toggle).not.toBeNull();
  });

  it("frames one set flat under a single header line carrying the count and close button; several sets keep a drawer header", async () => {
    const { chips } = await mount([twoQuestions]);
    await openWith(chips);
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

  it("sends one set's answers, or one question's, through the submit callback", async () => {
    const { chips, onSubmit } = await mount([ask("abc-1"), ask("def-2")]);
    await openWith(chips);
    const second = cards(chips)[1];
    second?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await second?.updateComplete;

    second?.shadowRoot?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await vi.waitFor(() => { expect(onSubmit).toHaveBeenCalledWith("def-2", { answers: [{ id: "db", values: ["pg"] }], revision: "r1" }); });

    chips.asks = [twoQuestions];
    await chips.updateComplete;
    const card = cards(chips)[0];
    await card?.updateComplete;
    card?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await card?.updateComplete;
    card?.shadowRoot?.querySelector<HTMLButtonElement>(".send-one")?.click();
    await vi.waitFor(() => { expect(onSubmit).toHaveBeenCalledWith("def-2", { answers: [{ id: "db", values: ["pg"] }], revision: "r1", partial: true }); });
  });

  it("closes the drawer on Esc or its close button, returning focus to the bar", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    const chip = bar(chips);
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
    await openWith(chips);
    const survivor = cards(chips)[1];

    chips.asks = [ask("def-2")];
    await chips.updateComplete;
    expect(cards(chips)).toEqual([survivor]);
    expect(bar(chips)?.textContent.trim()).toBe("1 open question");

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
