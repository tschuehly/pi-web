// @vitest-environment happy-dom

import type { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserOutcome, AskUserQuestion, PendingAskUser } from "../../../shared/apiTypes";
import { loadAskNote, saveAskDraft } from "../askDrafts";
import { AskUserCard, type AskUserSubmitCallback } from "./AskUserCard";
import { settleDeferredContent, useDeferredContent } from "../formatting/deferredContent.testSupport";

useDeferredContent();

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ask-user-card live form", () => {
  it("uses native labelled groups and updates progress for a keyboard-focusable single select", async () => {
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim"), option("code", "VS Code")], { detail: "Used for examples." }),
      question("platforms", "Target platforms", [option("web", "Web"), option("desktop", "Desktop")], { multiple: true }),
    ]));
    const root = renderRoot(card);
    expect(card).toBeInstanceOf(HTMLElement);
    expect(customElements.get("ask-user-card")).toBe(AskUserCard);
    const fieldsets = root.querySelectorAll("fieldset");
    const legends = root.querySelectorAll("legend");
    const vim = inputWithValue(root, "vim");
    const code = inputWithValue(root, "code");
    const web = inputWithValue(root, "web");

    expect(fieldsets).toHaveLength(2);
    expect(legends[0]?.textContent).toContain("Choose an editor");
    expect(fieldsets[0]?.getAttribute("aria-describedby")).toBe("ask-user-question-detail-0");
    const detail = root.querySelector<HTMLElement & { text: string }>("#ask-user-question-detail-0");
    expect(detail?.localName).toBe("formatted-text");
    expect(detail?.text).toBe("Used for examples.");
    expect(vim.type).toBe("radio");
    expect(code.name).toBe(vim.name);
    expect(web.type).toBe("checkbox");
    expect(web.name).not.toBe(vim.name);
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("0 of 2 answered");

    // Focus and interaction run through the rendered native control rather than
    // extracting Lit handlers, so this exercises the form's browser boundary.
    vim.focus();
    expect(root.activeElement).toBe(vim);
    vim.click();
    await card.updateComplete;

    expect(vim.checked).toBe(true);
    expect(code.checked).toBe(false);
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("1 of 2 answered");
  });

  it("accumulates several checkbox values for a multi-select question", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("platforms", "Target platforms", [option("web", "Web"), option("desktop", "Desktop")], { multiple: true }),
    ]), onSubmit);
    const root = renderRoot(card);

    inputWithValue(root, "web").click();
    inputWithValue(root, "desktop").click();
    await card.updateComplete;

    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("1 of 1 answered");
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [{ id: "platforms", values: ["web", "desktop"] }],
    });
  });

  it("always offers and focuses a labelled custom field while preserving multi-select options", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("stack", "Pick the stack", [option("lit", "Lit"), option("react", "React")], { multiple: true }),
    ]), onSubmit);
    const root = renderRoot(card);

    inputWithValue(root, "lit").click();
    inputWithValue(root, "__pi_web_other__").click();
    await card.updateComplete;
    await Promise.resolve();

    const textarea = requiredElement(root.querySelector("textarea"), "custom textarea");
    const label = requiredElement(textarea.closest("label"), "custom label");
    expect(label.textContent).toContain("Custom answer");
    expect(getComputedStyle(textarea).fontSize).toBe("16px");
    expect(root.activeElement).toBe(textarea);

    textarea.value = "Svelte";
    textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [{ id: "stack", values: ["lit"], otherText: "Svelte" }],
    });
  });

  it("edits a proposed option into the custom answer for single and multi-select questions", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim"), option("code", "VS Code")]),
      question("stack", "Pick the stack", [option("lit", "Lit"), option("react", "React")], { multiple: true }),
    ]), onSubmit);
    const root = renderRoot(card);
    const editButtons = [...root.querySelectorAll<HTMLButtonElement>("button[aria-label='Edit this answer']")];
    expect(editButtons).toHaveLength(4);
    expect(editButtons[0]?.type).toBe("button");

    // Radio: editing replaces the selected option with Custom.
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    requiredElement(editButtons[1], "edit VS Code").click();
    await card.updateComplete;
    await Promise.resolve();
    const editorText = requiredElement(root.querySelector<HTMLTextAreaElement>("#ask-user-other-0"), "editor textarea");
    expect(editorText.value).toBe("VS Code");
    expect(root.activeElement).toBe(editorText);
    expect(editorText.selectionStart).toBe("VS Code".length);
    expect(inputWithValue(root, "vim").checked).toBe(false);
    expect(inputWithValue(root, "code").checked).toBe(false);
    editorText.value = "VS Code Insiders";
    editorText.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

    // Checkbox: editing keeps other checked options, does not toggle the edited one, and replaces old custom text.
    inputWithValue(root, "lit").click();
    requiredElement(root.querySelector<HTMLInputElement>("#ask-user-question-1 input[value='__pi_web_other__']"), "stack custom").click();
    await card.updateComplete;
    const stackText = requiredElement(root.querySelector<HTMLTextAreaElement>("#ask-user-other-1"), "stack textarea");
    stackText.value = "Svelte";
    stackText.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await card.updateComplete;
    requiredElement(editButtons[3], "edit React").click();
    await card.updateComplete;
    await Promise.resolve();
    const editedStackText = requiredElement(root.querySelector<HTMLTextAreaElement>("#ask-user-other-1"), "stack textarea");
    expect(editedStackText.value).toBe("React");
    expect(root.activeElement).toBe(editedStackText);
    expect(inputWithValue(root, "react").checked).toBe(false);

    buttonWithText(root, "Send all").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [
        { id: "editor", values: [], otherText: "VS Code Insiders" },
        { id: "stack", values: ["lit"], otherText: "React" },
      ],
    });
  });

  it("starts an edited answer from the option's label and its detail", async () => {
    const card = await mountOpenAsk(openAsk([
      question("db", "Which database?", [{ value: "pg", label: "Postgres", detail: "Runs in the existing cluster." }, option("lite", "SQLite")]),
    ]));
    const root = renderRoot(card);
    const [withDetail, withoutDetail] = [...root.querySelectorAll<HTMLButtonElement>("button[aria-label='Edit this answer']")];

    requiredElement(withDetail, "edit Postgres").click();
    await card.updateComplete;
    expect(requiredElement(root.querySelector<HTMLTextAreaElement>("#ask-user-other-0"), "custom").value).toBe("Postgres\nRuns in the existing cluster.");
    requiredElement(withoutDetail, "edit SQLite").click();
    await card.updateComplete;
    expect(requiredElement(root.querySelector<HTMLTextAreaElement>("#ask-user-other-0"), "custom").value).toBe("SQLite");
  });

  it("keeps a note on the whole set in the draft and sends it trimmed with the answers", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([question("db", "Which database?", [option("pg", "Postgres")])]), onSubmit);
    const root = renderRoot(card);
    const note = requiredElement(root.querySelector<HTMLTextAreaElement>(".ask-note textarea"), "note");
    expect(note.closest("form")?.querySelector(".ask-note + .form-footer")).not.toBeNull();

    inputWithValue(root, "pg").click();
    note.value = "  Ship it this week.  ";
    note.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await card.updateComplete;
    expect(loadAskNote("local:session-1", "ask-1")).toBe("  Ship it this week.  ");
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", { revision: "r1", note: "Ship it this week.", answers: [{ id: "db", values: ["pg"] }] });
  });

  it("shows and submits the custom field directly when no options were supplied", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("notes", "Anything else?", []),
    ]), onSubmit);
    const root = renderRoot(card);
    const textarea = requiredElement(root.querySelector("textarea"), "custom textarea");

    expect(root.querySelector("input")).toBeNull();
    expect(requiredElement(textarea.closest("label"), "custom label").textContent).toContain("Custom answer");
    textarea.value = "Keep the first version small.";
    textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [{ id: "notes", values: [], otherText: "Keep the first version small." }],
    });
  });

  it("names unanswered questions before allowing a partial submit", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim")]),
      question("deploy", "Choose a deployment target", [option("cloud", "Cloud")]),
      question("notes", "Add implementation notes", []),
    ]), onSubmit);
    const root = renderRoot(card);

    inputWithValue(root, "vim").click();
    await card.updateComplete;
    buttonWithText(root, "Send all").click();
    await card.updateComplete;
    await Promise.resolve();

    const confirmation = requiredElement(root.querySelector("[aria-label='Confirm partial answers']"), "partial confirmation");
    expect(confirmation.textContent).toContain("Send without answering:");
    expect(confirmation.textContent).toContain("Choose a deployment target");
    expect(confirmation.textContent).toContain("Add implementation notes");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(root.activeElement).toBe(buttonWithText(root, "Send anyway"));

    buttonWithText(root, "Send anyway").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [{ id: "editor", values: ["vim"] }],
    });
  });
});

describe("ask-user-card single-answer send", () => {
  it("sends one answered question on its own as a partial submit and offers no per-question Send for a lone question", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim")]),
      question("deploy", "Choose a deployment target", [option("cloud", "Cloud")]),
    ]), onSubmit);
    const root = renderRoot(card);
    const sends = () => [...root.querySelectorAll<HTMLButtonElement>(".send-one")];
    expect(sends().map((button) => button.disabled)).toEqual([true, true]);

    inputWithValue(root, "cloud").click();
    await card.updateComplete;
    expect(sends().map((button) => button.disabled)).toEqual([true, false]);
    sends()[1]?.click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", { answers: [{ id: "deploy", values: ["cloud"] }], revision: "r1", partial: true });
    // The sent question leaves with its focused button; focus moves to the question now in its place.
    const focus = vi.spyOn(card, "focusQuestion");
    card.ask = { ...openAsk([question("editor", "Choose an editor", [option("vim", "Vim")])]), revision: "r2" };
    await card.updateComplete;
    expect(focus).toHaveBeenCalledWith(0);

    const lone = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [])]), askId: "ask-2" });
    expect(renderRoot(lone).querySelector(".send-one")).toBeNull();
    expect(buttonWithText(renderRoot(lone), "Send answers")).toBeDefined();
  });

  it("keeps the other questions' drafts when a partial send returns the ask under a new revision", async () => {
    const editor = question("editor", "Choose an editor", [option("vim", "Vim")]);
    const shell = question("shell", "Choose a shell", [option("zsh", "Zsh")]);
    const card = await mountOpenAsk(openAsk([editor, shell]), vi.fn<AskUserSubmitCallback>());
    inputWithValue(renderRoot(card), "vim").click();
    inputWithValue(renderRoot(card), "zsh").click();
    await card.updateComplete;

    card.ask = { ...openAsk([shell]), revision: "r2" };
    await card.updateComplete;

    expect(inputWithValue(renderRoot(card), "zsh").checked).toBe(true);
    expect(renderRoot(card).textContent).toContain("1 of 1 answered");
  });
});

describe("ask-user-card revisions", () => {
  it("drops draft answers to questions a revision changed, keeps the rest, and submits the revision answered", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const editor = question("editor", "Choose an editor", [option("vim", "Vim"), option("code", "VS Code")]);
    const shell = question("shell", "Choose a shell", [option("zsh", "Zsh"), option("fish", "Fish")]);
    const card = await mountOpenAsk(openAsk([editor, shell]), onSubmit);
    inputWithValue(renderRoot(card), "vim").click();
    inputWithValue(renderRoot(card), "zsh").click();
    await card.updateComplete;

    card.ask = { ...openAsk([question("editor", "Choose a primary editor", [option("vim", "Vim"), option("code", "VS Code")]), shell]), revision: "r2" };
    await card.updateComplete;

    expect(inputWithValue(renderRoot(card), "vim").checked).toBe(false);
    expect(inputWithValue(renderRoot(card), "zsh").checked).toBe(true);
    inputWithValue(renderRoot(card), "code").click();
    await card.updateComplete;
    buttonWithText(renderRoot(card), "Send all").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", { revision: "r2", answers: [{ id: "editor", values: ["code"] }, { id: "shell", values: ["zsh"] }] });
  });
});

describe("ask-user-card context", () => {
  it("renders the ask context as Markdown above the open questions", async () => {
    const card = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [option("pg", "Postgres")])]), context: "The cache is **stale**." });
    const context = await renderedContext(card);

    expect(context.innerHTML).toContain("<strong>stale</strong>");
    expect(renderRoot(card).querySelector(".ask-context + form .questions")).not.toBeNull();
  });

  it("renders the context above the questions of a closed ask record", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "cancelled", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      context: "Recommend **Postgres**.",
      questions: [unansweredRecord(question("db", "Which database?", [option("pg", "Postgres")]))],
      answeredCount: 0, unansweredIds: ["db"], summary: "Answered 0 of 1; unanswered: db",
    };
    document.body.append(card);
    await card.updateComplete;
    const context = await renderedContext(card);

    expect(context.innerHTML).toContain("<strong>Postgres</strong>");
    expect(renderRoot(card).querySelector(".ask-context ~ .record-questions")).not.toBeNull();
  });

  it("opens a local video linked from the context through the host, like a Chat link", async () => {
    const ask = { ...openAsk([question("db", "Which take?", [])]), context: "Watch [IMG_2430.MOV](/Users/me/Bilder & Videos/IMG_2430.MOV)." };
    const card = new AskUserCard();
    card.ask = ask;
    card.workspaceContext = { machineId: "local", projectId: "p", workspaceId: "w", root: "/work" };
    document.body.append(card);
    await card.updateComplete;
    const opened = vi.fn((event: Event) => { event.preventDefault(); });
    document.body.addEventListener("outside-file-open", opened, { once: true });

    requiredElement((await renderedContext(card)).querySelector("a"), "context link").click();

    expect(opened.mock.calls[0]?.[0]).toMatchObject({ detail: { machineId: "local", path: "/Users/me/Bilder & Videos/IMG_2430.MOV" } });
  });

  it("renders no context block when the ask carries none", async () => {
    const card = await mountOpenAsk(openAsk([question("db", "Which database?", [])]));

    expect(renderRoot(card).querySelector(".ask-context")).toBeNull();
  });
});

async function renderedContext(card: AskUserCard): Promise<ShadowRoot> {
  const formatted = requiredElement(renderRoot(card).querySelector<LitElement>("formatted-text.ask-context"), "ask context");
  await formatted.updateComplete;
  // Markdown formatting is deferred to a later frame.
  await settleDeferredContent(formatted);
  return requiredElement(formatted.shadowRoot, "ask context shadow root");
}

describe("ask-user-card record mode", () => {
  it("has no answer controls and displays draft answers retained for a superseded ask", async () => {
    const draftSessionId = "remote-a:session-1";
    saveAskDraft(draftSessionId, "ask-old", {
      speed: { values: ["fast"] },
      rationale: { values: [], otherText: "It keeps the feedback loop short." },
    });
    const outcome: AskUserOutcome = {
      askId: "ask-old",
      reason: "superseded",
      askedAt: "2026-07-20T10:00:00.000Z",
      closedAt: "2026-07-20T10:05:00.000Z",
      questions: [
        unansweredRecord(question("speed", "Preferred pace", [option("fast", "Fast"), option("careful", "Careful")])),
        unansweredRecord(question("rationale", "Why?", [])),
        unansweredRecord(question("region", "Deployment region", [option("eu", "Europe")])),
      ],
      answeredCount: 0,
      unansweredIds: ["speed", "rationale", "region"],
      summary: "Answered 0 of 3; unanswered: speed, rationale, region",
    };
    const card = new AskUserCard();
    card.draftSessionId = draftSessionId;
    card.outcome = outcome;
    document.body.append(card);
    await card.updateComplete;
    const root = renderRoot(card);

    expect(root.querySelector("input, textarea, button, select")).toBeNull();
    expect(root.textContent).toContain("Superseded");
    expect(root.textContent).toContain("Fast");
    expect(root.textContent).toContain("It keeps the feedback loop short.");
    expect(root.textContent).toContain("Draft answer · not sent");
    expect(root.textContent).toContain("Deployment region");
    expect(root.textContent).toContain("Unanswered");
  });

  it("labels a set the agent withdrew", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-gone",
      reason: "withdrawn",
      askedAt: "2026-07-20T10:00:00.000Z",
      closedAt: "2026-07-20T10:05:00.000Z",
      questions: [unansweredRecord(question("region", "Deployment region", [option("eu", "Europe")]))],
      answeredCount: 0,
      unansweredIds: ["region"],
      summary: "Answered 0 of 1; unanswered: region",
    };
    document.body.append(card);
    await card.updateComplete;

    expect(renderRoot(card).textContent).toContain("Withdrawn");
    expect(renderRoot(card).textContent).toContain("The agent withdrew these questions.");
  });

  it("labels the record of a single answer sent while the set stays open", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      questions: [{ question: question("db", "Which database?", [option("pg", "Postgres")]), answered: true, values: ["pg"] }],
      answeredCount: 1, unansweredIds: [], summary: "Answered 1; still open: ask.why", partial: true, revision: "r2",
    };
    document.body.append(card);
    await card.updateComplete;

    expect(renderRoot(card).querySelector(".header-status")?.textContent).toBe("Answer sent · others still open");
    expect(renderRoot(card).textContent).toContain("Postgres");
  });

  it("shows the question detail as Markdown and the user's note", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      questions: [unansweredRecord(question("db", "Which database?", [], { detail: "The **cache** store." }))],
      note: "Ship it this week.",
      answeredCount: 0, unansweredIds: ["db"], summary: "Answered 0 of 1; unanswered: db",
    };
    document.body.append(card);
    await card.updateComplete;

    expect(renderRoot(card).querySelector<HTMLElement & { text: string }>(".record-question formatted-text.question-detail")?.text).toBe("The **cache** store.");
    expect(renderRoot(card).querySelector(".record-note")?.textContent).toContain("Ship it this week.");
  });
});

async function mountOpenAsk(ask: PendingAskUser, onSubmit?: AskUserSubmitCallback): Promise<AskUserCard> {
  const card = new AskUserCard();
  card.ask = ask;
  card.draftSessionId = "local:session-1";
  if (onSubmit !== undefined) card.onSubmit = onSubmit;
  document.body.append(card);
  await card.updateComplete;
  return card;
}

function renderRoot(card: AskUserCard): ShadowRoot {
  return requiredElement(card.shadowRoot, "ask-user-card shadow root");
}

function inputWithValue(root: ShadowRoot, value: string): HTMLInputElement {
  const input = [...root.querySelectorAll("input")].find((candidate) => candidate.value === value);
  return requiredElement(input, `input with value ${value}`);
}

function buttonWithText(root: ShadowRoot, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === text);
  return requiredElement(button, `button named ${text}`);
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}

function openAsk(questions: AskUserQuestion[]): PendingAskUser {
  return { askId: "ask-1", askedAt: "2026-07-20T10:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, questions };
}

function question(
  id: string,
  text: string,
  options: AskUserQuestion["options"],
  settings: { detail?: string; multiple?: boolean } = {},
): AskUserQuestion {
  return {
    id,
    question: text,
    options,
    ...(settings.detail === undefined ? {} : { detail: settings.detail }),
    ...(settings.multiple === undefined ? {} : { multiple: settings.multiple }),
  };
}

function option(value: string, label: string): AskUserQuestion["options"][number] {
  return { value, label };
}

function unansweredRecord(questionValue: AskUserQuestion): AskUserOutcome["questions"][number] {
  return { question: questionValue, answered: false, values: [] };
}
