// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingAskUser } from "../../../shared/apiTypes";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY } from "../extensionStatusSnapshots";
import { AskUserCard, updatedAgo, type AskUserSubmitCallback } from "./AskUserCard";
import { DelegateRoster } from "./DelegateRoster";
import { WorkbenchQuestionChips, openQuestionCount } from "./WorkbenchQuestionChips";
import { loadAskDraft, saveAskNote } from "../askDrafts";

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
    questions: [
      {
        id: "db",
        question: "Which database?",
        options: [
          { value: "pg", label: "Postgres" },
          { value: "sqlite", label: "SQLite" },
        ],
      },
    ],
    ...patch,
  };
}

const twoQuestions = ask("def-2", {
  questions: [
    { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] },
    { id: "why", question: "Why now?", options: [] },
  ],
});

const running: SessionStatus = {
  sessionId: "s",
  isStreaming: false,
  isCompacting: false,
  isBashRunning: false,
  pendingMessageCount: 0,
  queuedMessages: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
  extensionStatuses: { [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [{ id: "w", kind: "worker", name: "Rows", activity: "running" }] }) },
};

async function mount(asks: PendingAskUser[], setup?: (chips: WorkbenchQuestionChips) => void) {
  const chips = new WorkbenchQuestionChips();
  chips.asks = asks;
  setup?.(chips);
  chips.draftSessionId = "local:session-1";
  const onSubmit = vi.fn<AskUserSubmitCallback>(() => Promise.resolve());
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
  return {
    toggle: shadow?.querySelector(".head > .section-toggle") ?? null,
    aside: slot?.assignedElements() ?? [],
    slotParent: slot?.parentElement ?? null,
    rows: shadow?.querySelector<HTMLElement>("section > .rows") ?? null,
  };
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
    expect(openQuestionCount([ask("abc-1"), twoQuestions], "")).toBe(3);
    // An approval set of the context alone still waits for the user.
    expect(openQuestionCount([{ ...ask("ctx-1"), approval: true, questions: [] }], "")).toBe(1);
  });

  it("counts answered questions from the drafts and as the user answers in the drawer", async () => {
    localStorage.setItem(
      "pi-web:ask-draft:local:session-1:def-2",
      JSON.stringify({ why: { values: [], otherText: "Soon", asked: JSON.stringify(twoQuestions.questions[1]) } }),
    );
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
    const recommended = {
      questions: [
        {
          id: "db",
          question: "Which database?",
          options: [
            { value: "pg", label: "Postgres", recommended: true },
            { value: "sqlite", label: "SQLite" },
          ],
        },
      ],
    };
    const { chips } = await mount([ask("abc-1", recommended), ask("def-2", { turnsSinceUpdate: 6, updatedAt: "2026-10-19T08:00:00.000Z" })]);

    await openWith(chips);

    expect(drawer(chips)?.getAttribute("aria-label")).toBe("Open questions");
    expect(bar(chips)?.getAttribute("aria-expanded")).toBe("true");
    expect(chips.hasAttribute("open")).toBe(true);
    const [first, second] = cards(chips);
    expect(AskUserCard.styles.cssText).not.toContain("context-beside");
    expect(first?.shadowRoot?.querySelector(".ask-context + form .questions")).not.toBeNull();
    expect(first?.shadowRoot?.querySelector(".ask-context ask-markdown-field.context-editor")).not.toBeNull();
    expect(text(first)).toContain("abc.db");
    expect(text(first)).toContain("Postgres Recommended");
    // Marked, never preselected.
    expect(first?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.checked).toBe(false);
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

    await vi.waitFor(() => {
      expect(focus).toHaveBeenCalledWith(0, true);
    });
    expect(focus.mock.contexts[0]).toBe(cards(chips)[0]);
  });

  it("opens at the top of the first set, its heading and context in view, with focus on its first question", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    // Layout stand-in: the first card starts at the top of the scrolled list; focusing a control scrolls it into view as a browser does.
    const focused: (FocusOptions | undefined)[] = [];
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      focused.push(options);
      const sets = chips.shadowRoot?.querySelector<HTMLElement>(".sets");
      if (sets !== null && sets !== undefined && options?.preventScroll !== true) sets.scrollTop = 489;
    });
    vi.spyOn(AskUserCard.prototype, "getBoundingClientRect").mockImplementation(function (this: AskUserCard) {
      const sets = chips.shadowRoot?.querySelector<HTMLElement>(".sets");
      return DOMRect.fromRect({ y: this === cards(chips)[0] ? -(sets?.scrollTop ?? 0) : 0, height: 100 });
    });

    await openWith(chips);

    await vi.waitFor(() => {
      expect(focused).toEqual([{ preventScroll: true }]);
    });
    expect(chips.shadowRoot?.querySelector<HTMLElement>(".sets")?.scrollTop).toBe(0);
    vi.restoreAllMocks();
  });

  it("opens an approval-only set from the bar with Approve focused", async () => {
    const { chips } = await mount([ask("ctx-1", { approval: true, questions: [] })]);
    await openWith(chips);
    expect(drawer(chips)).not.toBeNull();
    const card = cards(chips)[0];
    await vi.waitFor(() => {
      expect(card?.shadowRoot?.activeElement?.classList.contains("approve")).toBe(true);
    });
    expect(await chips.openQuestion("ctx-1", 1)).toBe(false);
  });

  it("opens a question for a caller and refuses one no open set asks", async () => {
    const { chips } = await mount([ask("abc-1"), twoQuestions]);
    const focus = vi.spyOn(AskUserCard.prototype, "focusQuestion");

    expect(await chips.openQuestion("def-2", 5)).toBe(false);
    expect(drawer(chips)).toBeNull();
    expect(await chips.openQuestion("def-2", 1)).toBe(true);

    expect(drawer(chips)).not.toBeNull();
    expect(focus).toHaveBeenCalledWith(1, false);
    expect(focus.mock.contexts[0]).toBe(cards(chips)[1]);
  });

  it("shares one row: Activity and the bar split the roster's header line, the entries span below, the drawer opens above", async () => {
    const { chips } = await mount([ask("abc-1")], (each) => {
      each.status = running;
      each.rosterCollapsed = false;
    });
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
    const { chips } = await mount([], (each) => {
      each.status = running;
    });
    expect(row(chips).toggle).not.toBeNull();
    expect(row(chips).aside).toEqual([]);

    const lone = (await mount([ask("abc-1")])).chips;
    expect(row(lone).toggle).toBeNull();
    expect(row(lone).aside).toEqual([bar(lone)]);
    expect(row(lone).slotParent?.matches("section.lone")).toBe(true);

    // A Grid tile's folded roster (its toggle lives in the composer) leaves the bar the row too.
    const compact = (
      await mount([ask("abc-1")], (each) => {
        each.status = running;
        each.rosterCompact = true;
      })
    ).chips;
    expect(row(compact).toggle).toBeNull();
    expect(row(compact).slotParent?.matches("section.lone")).toBe(true);

    // Neither: no row at all.
    const empty = (await mount([])).chips;
    expect(roster(empty)?.shadowRoot?.querySelector("section")).toBeNull();

    // Questions arriving later move into the row beside Activity.
    chips.asks = [ask("abc-1")];
    await chips.updateComplete;
    await vi.waitFor(() => {
      expect(row(chips).aside).toEqual([bar(chips)]);
    });
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

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("def-2", { answers: [{ id: "db", values: ["pg"] }], revision: "r1" });
    });

    chips.asks = [twoQuestions];
    await chips.updateComplete;
    const card = cards(chips)[0];
    await card?.updateComplete;
    card?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await card?.updateComplete;
    card?.shadowRoot?.querySelector<HTMLButtonElement>(".send-one")?.click();
    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("def-2", { answers: [{ id: "db", values: ["pg"] }], revision: "r1", partial: true });
    });
  });

  it("offers Send all once two sets hold answers and sends each: a full set whole with its note, a partial one keeping the rest open", async () => {
    saveAskNote("local:session-1", "abc-1", "Note for one");
    saveAskNote("local:session-1", "def-2", "Waits for the rest");
    const { chips, onSubmit } = await mount([ask("abc-1"), twoQuestions, ask("ghi-3")]);
    await openWith(chips);
    const sendAll = () => chips.shadowRoot?.querySelector<HTMLButtonElement>(".send-all") ?? null;
    const [first, second] = cards(chips);
    first?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await first?.updateComplete;
    await chips.updateComplete;
    expect(sendAll()).toBeNull();

    second?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await second?.updateComplete;
    await chips.updateComplete;
    expect(sendAll()?.textContent.trim()).toBe("Send all 2 answers");

    sendAll()?.click();
    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });
    expect(onSubmit).toHaveBeenNthCalledWith(1, "abc-1", { answers: [{ id: "db", values: ["pg"] }], note: "Note for one", revision: "r1" });
    expect(onSubmit).toHaveBeenNthCalledWith(2, "def-2", { answers: [{ id: "db", values: ["pg"] }], revision: "r1", partial: true });
    // The daemon, not this stub, retires sent answers; the drawer is idle again with no error.
    await vi.waitFor(() => {
      expect(sendAll()?.disabled).toBe(false);
    });
    expect(chips.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
  });

  it("counts and sends only shown questions: a hidden dependent is not open, and Send all sends a set whose rest is hidden whole", async () => {
    const dependent = ask("def-2", {
      questions: [
        {
          id: "location",
          question: "Where should the browser run?",
          options: [
            { value: "home", label: "Home" },
            { value: "vps", label: "VPS" },
          ],
        },
        { id: "machine", question: "Which machine?", options: [{ value: "mini", label: "Mac mini" }], showIf: { question: "location", values: ["home"] } },
      ],
    });
    const { chips, onSubmit } = await mount([ask("abc-1"), dependent]);
    expect(bar(chips)?.textContent.trim()).toBe("2 open questions");
    expect(openQuestionCount([ask("abc-1"), dependent], "local:session-1")).toBe(2);
    await openWith(chips);
    const [first, second] = cards(chips);
    first?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    second?.shadowRoot?.querySelector<HTMLInputElement>('input[value="home"]')?.click();
    await second?.updateComplete;
    await chips.updateComplete;
    expect(bar(chips)?.textContent.replace(/\s+/g, " ").trim()).toBe("3 open questions · 2 answered");
    second?.shadowRoot?.querySelector<HTMLInputElement>('input[value="mini"]')?.click();
    second?.shadowRoot?.querySelector<HTMLInputElement>('input[value="vps"]')?.click();
    await second?.updateComplete;
    await chips.updateComplete;
    expect(bar(chips)?.textContent.replace(/\s+/g, " ").trim()).toBe("2 open questions · 2 answered");

    chips.shadowRoot?.querySelector<HTMLButtonElement>(".send-all")?.click();
    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });
    // The hidden machine answer stays out, and with nothing visible left the set goes whole rather than partial.
    expect(onSubmit).toHaveBeenNthCalledWith(2, "def-2", { answers: [{ id: "location", values: ["vps"] }], revision: "r1" });
  });

  it("keeps a set whose send fails with its draft and says so, while the other sets still go", async () => {
    const { chips, onSubmit } = await mount([ask("abc-1"), ask("def-2"), ask("ghi-3")]);
    onSubmit.mockImplementation((askId: string) => (askId === "def-2" ? Promise.reject(new Error("offline")) : Promise.resolve()));
    await openWith(chips);
    for (const card of cards(chips)) {
      card.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
      await card.updateComplete;
    }
    await chips.updateComplete;
    chips.shadowRoot?.querySelector<HTMLButtonElement>(".send-all")?.click();

    await vi.waitFor(() => {
      expect(chips.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe("1 of 3 sets were not sent; their answers are kept.");
    });
    expect(onSubmit.mock.calls.map(([askId]) => askId)).toEqual(["abc-1", "def-2", "ghi-3"]);
    expect(loadAskDraft("local:session-1", "def-2")).toMatchObject({ db: { values: ["pg"] } });
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
    await vi.waitFor(() => {
      expect(chips.shadowRoot?.activeElement).toBe(chip);
    });

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

  it("closes the drawer once the last open set is sent", async () => {
    const { chips, onSubmit } = await mount([ask("abc-1")]);
    onSubmit.mockImplementation(async (askId) => {
      chips.asks = [];
      await chips.updateComplete;
      return { askId, reason: "submitted", askedAt: "", closedAt: "", questions: [], answeredCount: 1, unansweredIds: [], summary: "Answered 1 of 1" };
    });
    await openWith(chips);
    cards(chips)[0]?.shadowRoot?.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
    await cards(chips)[0]?.updateComplete;
    cards(chips)[0]?.shadowRoot?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(drawer(chips)).toBeNull();
    });
    expect(chips.open).toBe(false);
  });

  it("keeps a sent set as its record with context and detail below the sets still open, until dismissed", async () => {
    const question = { id: "db", question: "Which database?", detail: "Postgres scales further.", options: [{ value: "pg", label: "Postgres" }] };
    const detailed = ask("abc-1", { questions: [question] });
    const { chips, onSubmit } = await mount([detailed, ask("def-2")]);
    // The daemon's status drops the set before the send resolves with its closed record.
    onSubmit.mockImplementation(async (askId) => {
      chips.asks = [ask("def-2")];
      await chips.updateComplete;
      return {
        askId,
        reason: "submitted",
        askedAt: detailed.askedAt,
        closedAt: detailed.askedAt,
        context: detailed.context,
        questions: [{ question, answered: true, values: ["pg"] }],
        answeredCount: 1,
        unansweredIds: [],
        summary: "Answered 1 of 1",
      };
    });
    await openWith(chips);
    cards(chips)[0]?.shadowRoot?.querySelector<HTMLInputElement>('input[value="pg"]')?.click();
    await cards(chips)[0]?.updateComplete;
    cards(chips)[0]?.shadowRoot?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();

    await vi.waitFor(() => {
      expect(text(cards(chips)[1])).toContain("Answers sent");
    });
    expect(drawer(chips)).not.toBeNull();
    const shown = [...(cards(chips)[1]?.shadowRoot?.querySelectorAll<HTMLElement & { text: string }>("formatted-text") ?? [])].map((each) => each.text);
    expect(shown).toEqual([detailed.context, "Postgres scales further."]);
    expect(cards(chips).map((card) => card.ask?.askId ?? `record:${card.outcome?.askId ?? ""}`)).toEqual(["def-2", "record:abc-1"]);
    expect(bar(chips)?.textContent.trim()).toBe("1 open question");

    chips.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Dismiss sent answers"]')?.click();
    await chips.updateComplete;
    expect(cards(chips).map((card) => card.ask?.askId)).toEqual(["def-2"]);
  });

  it("keeps the whole-set record the daemon returns for a set sent one question at a time, earlier sends from another device included", async () => {
    const questions = ["db", "cache", "queue"].map((id) => ({ id, question: `Which ${id}?`, options: [{ value: `${id}-a`, label: `${id} A` }] }));
    const three = ask("abc-1", { questions });
    // A second open set keeps the drawer open after the last send, so the record stays readable.
    const other = ask("zzz-9");
    const { chips, onSubmit } = await mount([three, other]);
    let revision = 1;
    // Each send closes its questions; the daemon's status drops them before the send resolves with its record.
    // Its last send returns the whole set's record (pendingAskStore's withEarlierAnswers), "cache" sent from another device included.
    onSubmit.mockImplementation(async (askId, submission) => {
      const sent = new Set(submission.answers.map((answer) => answer.id));
      const open = (chips.asks[0]?.questions ?? []).filter((question) => !sent.has(question.id));
      revision += 1;
      chips.asks = open.length === 0 ? [other] : [{ ...three, questions: open, revision: `r${String(revision)}` }, other];
      await chips.updateComplete;
      const records = questions
        .filter((question) => open.length === 0 || sent.has(question.id))
        .map((question) => ({ question, answered: true, values: [`${question.id}-a`] }));
      return {
        askId,
        reason: "submitted",
        askedAt: three.askedAt,
        closedAt: three.askedAt,
        context: three.context,
        questions: records,
        answeredCount: records.length,
        unansweredIds: [],
        summary: open.length === 0 ? "Answered 3 of 3; none left unanswered" : `Answered ${String(records.length)}`,
        ...(submission.partial === true ? { partial: true, revision: `r${String(revision)}` } : {}),
      };
    });
    await openWith(chips);
    // "cache" went from another device: this drawer only sees the set without it.
    chips.asks = [{ ...three, questions: questions.filter((question) => question.id !== "cache"), revision: "r2" }, other];
    revision = 2;
    await chips.updateComplete;
    for (const id of ["db", "queue"]) {
      const card = cards(chips)[0];
      card?.shadowRoot?.querySelector<HTMLInputElement>(`input[value="${id}-a"]`)?.click();
      await card?.updateComplete;
      // The last open question goes with the set's Send; the others with their own.
      const send =
        id === "queue"
          ? card?.shadowRoot?.querySelector<HTMLButtonElement>('button[type="submit"]')
          : card?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".send-one")[chips.asks[0]?.questions.findIndex((question) => question.id === id) ?? -1];
      send?.click();
      await vi.waitFor(() => {
        expect(onSubmit).toHaveBeenLastCalledWith("abc-1", expect.objectContaining({ answers: [{ id, values: [`${id}-a`] }] }));
      });
      await chips.updateComplete;
      await cards(chips)[0]?.updateComplete;
    }

    await vi.waitFor(() => {
      expect(text(cards(chips)[1])).toContain("Answers sent");
    });
    const record = cards(chips)[1]?.outcome;
    expect(record?.questions.map((each) => [each.question.id, each.values])).toEqual([
      ["db", ["db-a"]],
      ["cache", ["cache-a"]],
      ["queue", ["queue-a"]],
    ]);
    expect(record?.summary).toBe("Answered 3 of 3; none left unanswered");
    expect(text(cards(chips)[1])).toContain("cache A");
    const shown = [...(cards(chips)[1]?.shadowRoot?.querySelectorAll<HTMLElement & { text: string }>("formatted-text") ?? [])].map((each) => each.text);
    expect(shown).toContain(three.context);
  });

  it("formats the update age coarsely", () => {
    const now = Date.parse("2026-10-19T10:00:00.000Z");
    expect(updatedAgo("2026-10-19T09:59:30.000Z", now)).toBe("updated just now");
    expect(updatedAgo("2026-10-19T09:15:00.000Z", now)).toBe("updated 45 min ago");
    expect(updatedAgo("2026-10-17T09:00:00.000Z", now)).toBe("updated 2 d ago");
  });

  it("lets its cards attach images only when the Chat's host reports ask-images; a legacy Chat reports no capabilities and takes none", async () => {
    const { chips } = await mount([ask("abc-1", { questions: [{ id: "why", question: "Why?", kind: "text", options: [] }] })], (each) => {
      each.status = { ...running, capabilities: ["attachments"] };
    });
    await openWith(chips);
    expect(cards(chips)[0]?.imagesEnabled).toBe(false);
    chips.status = running;
    await chips.updateComplete;
    expect(cards(chips)[0]?.imagesEnabled).toBe(false);
    chips.status = { ...running, capabilities: ["ask-images"] };
    await chips.updateComplete;
    expect(cards(chips)[0]?.imagesEnabled).toBe(true);
  });

  it("lets the agent's context blocks run only on a host that reports owner-run, which records who wrote the context; a legacy Chat's never do", async () => {
    const { chips } = await mount([ask("abc-1")], (each) => {
      each.status = running;
    });
    await openWith(chips);
    expect(cards(chips)[0]?.contextOwnerRuns).toBe(false);
    chips.status = { ...running, capabilities: ["owner-run"] };
    await chips.updateComplete;
    expect(cards(chips)[0]?.contextOwnerRuns).toBe(true);
  });
});
