// @vitest-environment happy-dom

import type { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserOutcome, AskUserQuestion, PendingAskUser } from "../../../shared/apiTypes";
import { loadAskContext, loadAskNote, saveAskDraft, saveAskNote } from "../askDrafts";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { AskMarkdownField } from "./AskMarkdownField";
import { AskUserCard, renderedOnlyFences, type AskUserSubmitCallback } from "./AskUserCard";
import { settleDeferredContent, useDeferredContent } from "../formatting/deferredContent.testSupport";
import { html } from "lit";
import { createContentRenderingService } from "../formatting/contentRendering";
import type { ContentRendererHost } from "./ContentRendererHost";

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

  it("renders and answers questions whose ids name Object properties", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([question("constructor", "Which editor?", [option("vim", "Vim")]), question("__proto__", "Why?", [])]), onSubmit);
    expect(renderRoot(card).querySelectorAll("fieldset")).toHaveLength(2);

    inputWithValue(renderRoot(card), "vim").click();
    await card.updateComplete;

    expect(renderRoot(card).querySelector("[aria-live='polite']")?.textContent).toContain("1 of 2 answered");
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

  it("starts on the recommended options, counted as answered, and keeps them cleared once the user unticks them", async () => {
    const ask = openAsk([
      question("platforms", "Target platforms", [{ ...option("web", "Web"), recommended: true }, { ...option("desktop", "Desktop"), recommended: true }], { multiple: true }),
    ]);
    const card = await mountOpenAsk(ask);
    const root = renderRoot(card);

    expect(inputWithValue(root, "web").checked && inputWithValue(root, "desktop").checked).toBe(true);
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("1 of 1 answered");
    inputWithValue(root, "web").click();
    inputWithValue(root, "desktop").click();
    card.remove();

    const reloaded = renderRoot(await mountOpenAsk(ask));
    expect(inputWithValue(reloaded, "web").checked || inputWithValue(reloaded, "desktop").checked).toBe(false);
    expect(reloaded.querySelector("[aria-live='polite']")?.textContent).toContain("0 of 1 answered");
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

    const field = markdownField(root, ".other-answer ask-markdown-field");
    expect(field.closest(".other-answer")?.textContent).toContain("Custom answer");
    expect(field.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Custom answer");
    expect(AskUserCard.styles.cssText).toContain("font: var(--pi-control-font-size, 16px)");
    expect(field.contains(root.activeElement)).toBe(true);

    typeInto(field, "Svelte");
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [{ id: "stack", values: ["lit"], otherText: "Svelte" }],
    });
  });

  it("edits a proposed option in its own row into the custom answer for single and multi-select questions", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("editor", "Choose an editor", [option("vim", "Vim"), option("code", "VS Code")]),
      question("stack", "Pick the stack", [option("lit", "Lit"), option("react", "React")], { multiple: true }),
    ]), onSubmit);
    const root = renderRoot(card);
    const editButtons = [...root.querySelectorAll<HTMLButtonElement>("button[aria-label='Edit this answer']")];
    expect(editButtons).toHaveLength(4);
    expect(editButtons[0]?.type).toBe("button");

    // Radio: the edited row turns into the Custom answer's textarea, selected; Custom and its own textarea step aside.
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    requiredElement(editButtons[1], "edit VS Code").click();
    await card.updateComplete;
    await Promise.resolve();
    const editorText = markdownField(root, "#ask-user-other-0");
    const editedRow = requiredElement(editorText.closest(".option-row.inline-edit"), "inline edit row");
    expect(editedRow.previousElementSibling?.querySelector("input")?.value).toBe("vim");
    expect(editorText.value).toBe("VS Code");
    expect(editorText.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Custom answer, edited from VS Code");
    expect(editorText.contains(root.activeElement)).toBe(true);
    expect(editorView(editorText).state.selection.main.head).toBe("VS Code".length);
    expect(inputWithValue(root, "vim").checked).toBe(false);
    expect(root.querySelector("#ask-user-question-0 input[value='code']")).toBeNull();
    expect(inputWithValue(root, "__pi_web_other__").checked).toBe(false);
    expect(root.querySelectorAll("#ask-user-question-0 ask-markdown-field")).toHaveLength(1);
    expect(root.querySelector("#ask-user-question-0 .other-answer")).toBeNull();
    typeInto(editorText, "VS Code Insiders");

    // Checkbox: editing keeps other checked options, does not toggle the edited one, and replaces old custom text.
    inputWithValue(root, "lit").click();
    requiredElement(root.querySelector<HTMLInputElement>("#ask-user-question-1 input[value='__pi_web_other__']"), "stack custom").click();
    await card.updateComplete;
    typeInto(markdownField(root, "#ask-user-other-1"), "Svelte");
    await card.updateComplete;
    requiredElement(editButtons[3], "edit React").click();
    await card.updateComplete;
    await Promise.resolve();
    const editedStackText = markdownField(root, "#ask-user-other-1");
    expect(editedStackText.closest(".inline-edit")).not.toBeNull();
    expect(editedStackText.value).toBe("React");
    expect(editedStackText.contains(root.activeElement)).toBe(true);
    expect(inputWithValue(root, "lit").checked).toBe(true);

    buttonWithText(root, "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [
        { id: "editor", values: [], otherText: "VS Code Insiders" },
        { id: "stack", values: ["lit"], otherText: "React" },
      ],
    });
  });

  it("sends an edited checked option only as its correction, keeps the other checked ones, and Revert restores it", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("plan", "What ships?", [{ ...option("friday", "Deploy Friday"), recommended: true }, { ...option("docs", "Docs"), recommended: true }], { multiple: true }),
    ]), onSubmit);
    const root = renderRoot(card);
    requiredElement(root.querySelector<HTMLButtonElement>("button[aria-label='Edit this answer']"), "edit Deploy Friday").click();
    await card.updateComplete;
    typeInto(markdownField(root, ".inline-edit ask-markdown-field"), "Deploy Monday");
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenLastCalledWith("ask-1", { revision: "r1", answers: [{ id: "plan", values: ["docs"], otherText: "Deploy Monday" }] });

    buttonWithText(root, "Revert").click();
    await card.updateComplete;
    expect(inputWithValue(root, "friday").checked).toBe(true);
    expect(inputWithValue(root, "docs").checked).toBe(true);
  });

  it("reverts an inline edit with Esc or Revert to the answer from before it, keeping the drawer open", async () => {
    const card = await mountOpenAsk(openAsk([question("editor", "Choose an editor", [option("vim", "Vim"), option("code", "VS Code")])]));
    const root = renderRoot(card);
    const outside = vi.fn();
    document.body.addEventListener("keydown", outside);
    inputWithValue(root, "vim").click();
    await card.updateComplete;
    requiredElement(root.querySelectorAll<HTMLButtonElement>("button[aria-label='Edit this answer']")[1], "edit VS Code").click();
    await card.updateComplete;
    const textarea = markdownField(root, ".inline-edit ask-markdown-field");
    typeInto(textarea, "VS Code, but lighter");
    // The draft holds the edit as the Custom answer, as before.
    expect(JSON.parse(localStorage.getItem("pi-web:ask-draft:local:session-1:ask-1") ?? "{}")).toMatchObject({ editor: { values: [], otherText: "VS Code, but lighter" } });

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    requiredElement(textarea.querySelector(".cm-content"), "editor content").dispatchEvent(escape);
    await card.updateComplete;
    expect(escape.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();
    expect(root.querySelector(".inline-edit")).toBeNull();
    expect(inputWithValue(root, "vim").checked).toBe(true);
    expect(inputWithValue(root, "code").checked).toBe(false);
    expect(root.querySelector("#ask-user-other-0")).toBeNull();
    expect(JSON.parse(localStorage.getItem("pi-web:ask-draft:local:session-1:ask-1") ?? "{}")).toMatchObject({ editor: { values: ["vim"] } });

    // Without an earlier answer, Revert leaves the question unanswered.
    const fresh = await mountOpenAsk(openAsk([question("db", "Which database?", [option("pg", "Postgres")])]));
    const freshRoot = renderRoot(fresh);
    requiredElement(freshRoot.querySelector<HTMLButtonElement>("button[aria-label='Edit this answer']"), "edit Postgres").click();
    await fresh.updateComplete;
    buttonWithText(freshRoot, "Revert").click();
    await fresh.updateComplete;
    expect(freshRoot.querySelector(".inline-edit")).toBeNull();
    expect(freshRoot.querySelector("[aria-live='polite']")?.textContent).toContain("0 of 1 answered");
    document.body.removeEventListener("keydown", outside);
  });

  it("shows the pencil only on row hover or focus, as a sized icon button", () => {
    const styles = AskUserCard.styles.cssText;
    expect(styles).toMatch(/\.edit-option \{[^}]*width: 26px;[^}]*height: 26px;[^}]*opacity: 0;/);
    expect(styles).toContain(".option-row:hover > .edit-option, .option-row:focus-within > .edit-option { opacity: 1; }");
    expect(styles).toMatch(/\.edit-option:hover:not\(:disabled\) \{ background:/);
  });

  it("keeps a note on the whole set in the draft and sends it trimmed with the answers", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([question("db", "Which database?", [option("pg", "Postgres")])]), onSubmit);
    const root = renderRoot(card);
    expect(root.querySelector(".ask-note")).toBeNull();
    requiredElement(root.querySelector<HTMLButtonElement>('button[aria-label="Add note"]'), "note icon").click();
    await card.updateComplete;
    await Promise.resolve();
    const note = markdownField(root, ".ask-note ask-markdown-field");
    expect(note.contains(root.activeElement)).toBe(true);
    expect(root.querySelector('button[aria-label="Add note"]')).toBeNull();
    expect(note.closest("form")?.querySelector(".ask-note + .form-footer")).not.toBeNull();

    inputWithValue(root, "pg").click();
    typeInto(note, "  Ship it this week.  ");
    await card.updateComplete;
    expect(loadAskNote("local:session-1", "ask-1")).toBe("  Ship it this week.  ");
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", { revision: "r1", note: "Ship it this week.", answers: [{ id: "db", values: ["pg"] }] });
  });

  it("opens the note at once when the set already has a saved note draft", async () => {
    saveAskNote("local:session-1", "ask-1", "Half typed");
    const card = await mountOpenAsk(openAsk([question("db", "Which database?", [option("pg", "Postgres")])]));
    const root = renderRoot(card);
    expect(markdownField(root, ".ask-note ask-markdown-field").value).toBe("Half typed");
    expect(root.querySelector('button[aria-label="Add note"]')).toBeNull();
  });

  it("shows and submits the custom field directly when no options were supplied", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      question("notes", "Anything else?", []),
    ]), onSubmit);
    const root = renderRoot(card);
    const field = markdownField(root, ".other-answer ask-markdown-field");

    expect(root.querySelector("input")).toBeNull();
    expect(field.closest(".other-answer")?.textContent).toContain("Custom answer");
    typeInto(field, "Keep the first version small.");
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [{ id: "notes", values: [], otherText: "Keep the first version small." }],
    });
  });

  it("rounds an integer question's native bounds to whole numbers so step=1 never blocks a value the shared validator accepts", async () => {
    const card = await mountOpenAsk(openAsk([
      { id: "copies", question: "Copies?", options: [], kind: "number", minimum: 0.5, maximum: 5.5, integer: true },
    ]));
    const copies = requiredElement(renderRoot(card).querySelector<HTMLInputElement>("input[type='number']"), "number input");
    expect([copies.min, copies.max, copies.step]).toEqual(["1", "5", "1"]);
  });

  it("renders typed questions as a switch, text, number and date fields on their defaults, shows a field's error, and sends values", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(openAsk([
      { id: "backup", question: "Enable backup?", options: [], kind: "boolean" },
      { id: "folder", question: "Folder?", options: [], kind: "text", multiline: true, default: "~/b", showIf: { question: "backup", values: ["true"] } },
      { id: "copies", question: "Copies?", options: [], kind: "number", default: 2, maximum: 5, integer: true },
      { id: "due", question: "Due?", options: [], kind: "date" },
    ]), onSubmit);
    const root = renderRoot(card);
    const toggle = requiredElement(root.querySelector<HTMLInputElement>("input[role='switch']"), "switch");
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute("aria-label")).toBe("Enable backup?");
    expect(root.querySelector(".questions ask-markdown-field")).toBeNull();
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("2 of 3 answered");

    toggle.click();
    await card.updateComplete;
    // The multi-line field starts on its default, and what the user types there is the draft and the answer.
    const folder = markdownField(root, "#ask-user-other-1");
    expect(folder.value).toBe("~/b");
    typeInto(folder, "~/b/archive");
    await card.updateComplete;
    expect(JSON.parse(localStorage.getItem("pi-web:ask-draft:local:session-1:ask-1") ?? "{}")).toMatchObject({ folder: { value: "~/b/archive" } });
    const copies = requiredElement(root.querySelector<HTMLInputElement>("input[type='number']"), "number input");
    expect([copies.value, copies.max, copies.step]).toEqual(["2", "5", "1"]);
    copies.value = "9";
    copies.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await card.updateComplete;
    expect(root.querySelector(".field-error")?.textContent).toBe("Must be at most 5");
    expect(copies.getAttribute("aria-invalid")).toBe("true");
    copies.value = "3";
    copies.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    const due = requiredElement(root.querySelector<HTMLInputElement>("input[type='date']"), "date input");
    due.value = "2026-12-01";
    due.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await card.updateComplete;
    expect(root.querySelector(".field-error")).toBeNull();
    buttonWithText(root, "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", {
      revision: "r1",
      answers: [
        { id: "backup", values: [], value: true },
        { id: "folder", values: [], value: "~/b/archive" },
        { id: "copies", values: [], value: 3 },
        { id: "due", values: [], value: "2026-12-01" },
      ],
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
    buttonWithText(root, "Send answers").click();
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

describe("ask-user-card dependent questions", () => {
  const dependentAsk = () => openAsk([
    question("location", "Where should the browser run?", [option("home", "Home"), option("vps", "VPS")]),
    { ...question("machine", "Which machine?", [option("mini", "Mac mini"), option("pc", "PC")]), showIf: { question: "location", values: ["home"] } },
    { ...question("gpu", "Use the GPU?", [option("yes", "Yes")]), showIf: { question: "machine", values: ["pc"] } },
  ]);
  const legends = (root: ShadowRoot) => [...root.querySelectorAll("legend")].map((legend) => legend.textContent.replace(/\s+/gu, " ").trim());

  it("shows a dependent question only while its condition holds, hides its chain when it changes, and never counts it hidden", async () => {
    const card = await mountOpenAsk(dependentAsk());
    const root = renderRoot(card);
    const status = () => root.querySelector("[aria-live='polite']")?.textContent.trim();

    expect(legends(root)).toEqual([expect.stringContaining("1. Where should the browser run?")]);
    expect(status()).toBe("0 of 1 answered");

    inputWithValue(root, "home").click();
    await card.updateComplete;
    expect(legends(root)).toEqual([expect.stringContaining("Where"), expect.stringContaining("2. Which machine?")]);
    inputWithValue(root, "pc").click();
    await card.updateComplete;
    expect(legends(root)).toHaveLength(3);
    expect(status()).toBe("2 of 3 answered");

    inputWithValue(root, "vps").click();
    await card.updateComplete;
    expect(legends(root)).toEqual([expect.stringContaining("Where")]);
    expect(status()).toBe("1 of 1 answered");
  });

  it("sends without asking about hidden questions and leaves their stale answers out", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    saveAskDraft("local:session-1", "ask-1", { machine: { values: ["pc"], asked: JSON.stringify(dependentAsk().questions[1]) } });
    const card = await mountOpenAsk(dependentAsk(), onSubmit);
    const root = renderRoot(card);

    inputWithValue(root, "vps").click();
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await card.updateComplete;

    expect(root.querySelector("[aria-label='Confirm partial answers']")).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", { revision: "r1", answers: [{ id: "location", values: ["vps"] }] });
  });

  it("sends a follow-up's own Send with the unsent parent answers that show it, so the daemon keeps it", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(dependentAsk(), onSubmit);
    const root = renderRoot(card);
    inputWithValue(root, "home").click();
    await card.updateComplete;
    inputWithValue(root, "pc").click();
    await card.updateComplete;
    [...root.querySelectorAll<HTMLButtonElement>(".send-one")][1]?.click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", { answers: [{ id: "location", values: ["home"] }, { id: "machine", values: ["pc"] }], revision: "r1", partial: true });

    const toggled = vi.fn<AskUserSubmitCallback>();
    const typed = await mountOpenAsk({ ...openAsk([
      { id: "backup", question: "Enable backup?", options: [], kind: "boolean" },
      { id: "folder", question: "Folder?", options: [], kind: "text", default: "~/b", showIf: { question: "backup", values: ["true"] } },
    ]), askId: "ask-2" }, toggled);
    requiredElement(renderRoot(typed).querySelector<HTMLInputElement>("input[role='switch']"), "switch").click();
    await typed.updateComplete;
    [...renderRoot(typed).querySelectorAll<HTMLButtonElement>(".send-one")][1]?.click();
    await Promise.resolve();
    // It answers every visible question, so it closes the set as a full submit.
    expect(toggled).toHaveBeenCalledWith("ask-2", { answers: [{ id: "backup", values: [], value: true }, { id: "folder", values: [], value: "~/b" }], revision: "r1" });
  });

  it("sends the note with a follow-up's own Send that answers every visible question, and keeps it in the draft otherwise", async () => {
    saveAskNote("local:session-1", "ask-1", "Ship it this week.");
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(dependentAsk(), onSubmit);
    const root = renderRoot(card);
    inputWithValue(root, "home").click();
    await card.updateComplete;
    inputWithValue(root, "pc").click();
    await card.updateComplete;
    // The GPU question still shows unanswered: a partial send, the note waits in the draft.
    [...root.querySelectorAll<HTMLButtonElement>(".send-one")][1]?.click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenLastCalledWith("ask-1", { answers: [{ id: "location", values: ["home"] }, { id: "machine", values: ["pc"] }], revision: "r1", partial: true });
    expect(loadAskNote("local:session-1", "ask-1")).toBe("Ship it this week.");

    const closing = vi.fn<AskUserSubmitCallback>();
    card.remove();
    const again = await mountOpenAsk({ ...dependentAsk(), askId: "ask-1", revision: "r2" }, closing);
    const againRoot = renderRoot(again);
    inputWithValue(againRoot, "mini").click();
    await again.updateComplete;
    [...againRoot.querySelectorAll<HTMLButtonElement>(".send-one")][1]?.click();
    await Promise.resolve();
    expect(closing).toHaveBeenCalledWith("ask-1", { answers: [{ id: "location", values: ["home"] }, { id: "machine", values: ["mini"] }], note: "Ship it this week.", revision: "r2" });
  });

  it("offers Send anyway only for visible unanswered questions", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk(dependentAsk(), onSubmit);
    const root = renderRoot(card);

    inputWithValue(root, "home").click();
    await card.updateComplete;
    buttonWithText(root, "Send answers").click();
    await card.updateComplete;
    const confirmation = requiredElement(root.querySelector("[aria-label='Confirm partial answers']"), "partial confirmation");
    expect(confirmation.textContent).toContain("Which machine?");
    expect(confirmation.textContent).not.toContain("Use the GPU?");
  });

  it("labels a skipped question in the record apart from an unanswered one", async () => {
    const [location, machine] = dependentAsk().questions;
    if (location === undefined || machine === undefined) throw new Error("expected two questions");
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      questions: [{ question: location, answered: true, values: ["vps"] }, { question: machine, answered: false, values: [], skipped: true }],
      answeredCount: 1, unansweredIds: [], summary: "Answered 1 of 1; none left unanswered; skipped (condition not met): machine",
    };
    document.body.append(card);
    await card.updateComplete;
    expect(renderRoot(card).querySelector(".unanswered-record")?.textContent).toBe("Skipped · condition not met");
  });

  it("shows a typed answer in the record", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      questions: [{ question: { id: "b", question: "On?", options: [], kind: "boolean" }, answered: true, values: [], value: true }, { question: { id: "n", question: "N?", options: [], kind: "number" }, answered: true, values: [], value: 7 }],
      answeredCount: 2, unansweredIds: [], summary: "Answered 2 of 2; none left unanswered",
    };
    document.body.append(card);
    await card.updateComplete;
    expect([...renderRoot(card).querySelectorAll(".record-answer")].map((item) => item.textContent)).toEqual(["On", "7"]);
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

  it("keeps each question's own editor and undo history when a partial send or revision changes the set", async () => {
    const why = question("why", "Why?", []);
    const how = question("how", "How?", []);
    const card = await mountOpenAsk(openAsk([why, how]), vi.fn<AskUserSubmitCallback>());
    const fields = () => [...renderRoot(card).querySelectorAll(".other-answer ask-markdown-field")].map((field) => markdownField(renderRoot(card), `#${field.id}`));
    const [whyField, howField] = fields();
    typeInto(requiredElement(whyField, "why field"), "Because A.");
    typeInto(requiredElement(howField, "how field"), "Like B.");
    await card.updateComplete;
    [...renderRoot(card).querySelectorAll<HTMLButtonElement>(".send-one")][0]?.click();
    await Promise.resolve();

    // The first question was sent; the remaining one keeps its editor, so Undo never brings back the other question's text.
    card.ask = { ...openAsk([how]), revision: "r2" };
    await card.updateComplete;
    const remaining = requiredElement(fields()[0], "remaining field");
    expect([remaining === howField, remaining.value]).toEqual([true, "Like B."]);
    undo(editorView(remaining));
    expect(remaining.value).not.toBe("Because A.");

    // A revision that changes the question drops its draft underneath the editor; Undo cannot restore the dropped text.
    typeInto(remaining, "Like C.");
    await card.updateComplete;
    // A replacement within 500 ms of typing would join the typed undo step; the owner's next revision comes later.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1000);
    card.ask = { ...openAsk([question("how", "How, exactly?", [])]), revision: "r3" };
    await card.updateComplete;
    expect([remaining.isConnected, remaining === fields()[0], remaining.value]).toEqual([true, true, ""]);
    undo(editorView(remaining));
    expect(remaining.value).toBe("");
  });

  it("drops a field's undo history when its question is reworded, even when the new default equals the typed text", async () => {
    const notes: AskUserQuestion = { id: "notes", question: "Notes?", options: [], kind: "text", multiline: true };
    const card = await mountOpenAsk(openAsk([notes]));
    const field = markdownField(renderRoot(card), "ask-markdown-field#ask-user-other-0");
    typeInto(field, "Draft.");
    await card.updateComplete;

    card.ask = { ...openAsk([{ ...notes, detail: "Reworded.", default: "Draft." }]), revision: "r2" };
    await card.updateComplete;
    expect([field.isConnected, field.value]).toEqual([true, "Draft."]);
    undo(editorView(field));

    expect(field.value).toBe("Draft.");
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
    buttonWithText(renderRoot(card), "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledWith("ask-1", { revision: "r2", answers: [{ id: "editor", values: ["code"] }, { id: "shell", values: ["zsh"] }] });
  });
});

describe("ask-user-card context", () => {
  it("shows the open set's context in a Markdown editor, pre-filled and editable from the start, in the body font", async () => {
    const card = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [option("pg", "Postgres")])]), context: "The cache is **stale**." });
    const root = renderRoot(card);
    const editor = markdownField(root, ".ask-context ask-markdown-field.context-editor");

    expect(editor.value).toBe("The cache is **stale**.");
    expect(editor.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    expect(editor.querySelector(".cm-gutters")).toBeNull();
    // Live preview hides the Markdown marks off the cursor line, as the Files pane does.
    expect(editor.querySelector(".lp-on")).not.toBeNull();
    expect(editor.querySelector(".lp-on")).not.toBeNull();
    // The cursor starts after the text, so a heading on the first line shows rendered, without its "## ".
    card.ask = { ...openAsk([question("db", "Which database?", [])]), askId: "ask-2", context: "## Plan\nShip it." };
    await card.updateComplete;
    expect(markdownField(root, ".context-editor").querySelector(".cm-line")?.textContent).toBe("Plan");
    expect(root.querySelector("formatted-text.ask-context")).toBeNull();
    expect(root.querySelector(".ask-context + form .questions")).not.toBeNull();
    expect(root.querySelector(".context-actions")).toBeNull();
    const styles = AskUserCard.styles.toString();
    expect(styles).toContain(".card .context-editor .cm-scroller, .card .context-editor .cm-content { font: inherit; line-height: 1.45; }");
    expect(styles).toMatch(/\.card \.context-editor \{[^}]*border: 0;[^}]*background: color-mix/);
  });

  it("keeps an edited context in the draft, sends it with the answers, and restores the agent's text on Revert", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const ask = { ...openAsk([question("db", "Which database?", [option("pg", "Postgres")])]), context: "Plan: ship Monday." };
    const card = await mountOpenAsk(ask, onSubmit);
    typeInto(markdownField(renderRoot(card), ".context-editor"), "Plan: ship Friday.");
    await card.updateComplete;

    expect(loadAskContext("local:session-1", "ask-1", "Plan: ship Monday.")).toBe("Plan: ship Friday.");
    expect(renderRoot(card).querySelector(".context-actions")?.textContent).toContain("Edited");
    // A remount (reload) restores the edit from the draft.
    card.remove();
    const reloaded = await mountOpenAsk(ask, onSubmit);
    expect(markdownField(renderRoot(reloaded), ".context-editor").value).toBe("Plan: ship Friday.");
    inputWithValue(renderRoot(reloaded), "pg").click();
    buttonWithText(renderRoot(reloaded), "Send answers").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenLastCalledWith("ask-1", { revision: "r1", context: "Plan: ship Friday.", answers: [{ id: "db", values: ["pg"] }] });

    buttonWithText(renderRoot(reloaded), "Revert").click();
    await reloaded.updateComplete;
    expect(markdownField(renderRoot(reloaded), ".context-editor").value).toBe("Plan: ship Monday.");
    expect(loadAskContext("local:session-1", "ask-1", "Plan: ship Monday.")).toBeUndefined();
    expect(renderRoot(reloaded).querySelector(".context-actions")).toBeNull();
  });

  it("opens a context with Windows line endings, cursor after its text, and keeps it unchanged", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [option("pg", "Postgres")])]), context: "## Plan\r\nShip it.\r\n" }, onSubmit);
    const view = editorView(markdownField(renderRoot(card), ".context-editor"));
    expect([view.state.doc.toString(), view.state.selection.main.head]).toEqual(["## Plan\nShip it.\n", 17]);
    expect(renderRoot(card).querySelector(".context-actions")).toBeNull();
  });

  it("sends no context while it is unchanged", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [option("pg", "Postgres")])]), context: "Plan." }, onSubmit);
    const editor = markdownField(renderRoot(card), ".context-editor");
    typeInto(editor, "Plan!");
    typeInto(editor, "Plan.");
    inputWithValue(renderRoot(card), "pg").click();
    buttonWithText(renderRoot(card), "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", { revision: "r1", answers: [{ id: "db", values: ["pg"] }] });
  });

  it("sends a cleared context as cleared rather than leaving the agent's text in place", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [option("pg", "Postgres")])]), context: "Approve: drop the table." }, onSubmit);
    typeInto(markdownField(renderRoot(card), ".context-editor"), "  ");
    await card.updateComplete;
    expect(renderRoot(card).querySelector(".context-actions")?.textContent).toContain("Edited");
    inputWithValue(renderRoot(card), "pg").click();
    buttonWithText(renderRoot(card), "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", { revision: "r1", context: "", answers: [{ id: "db", values: ["pg"] }] });
  });

  it("shows a context the user cleared as cleared in the record", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      context: "Approve: drop the table.", editedContext: "",
      questions: [unansweredRecord(question("db", "Which database?", [option("pg", "Postgres")]))],
      answeredCount: 0, unansweredIds: ["db"], summary: "Answered 0 of 1; unanswered: db",
    };
    document.body.append(card);
    await card.updateComplete;

    expect(renderRoot(card).querySelector(".context-edited")?.textContent).toBe("Context cleared by you");
    expect(renderRoot(card).querySelector("formatted-text.ask-context")).toBeNull();
  });

  it("carries the edited context with a single-answer send", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const card = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [option("pg", "Postgres")]), question("cache", "Which cache?", [])]), context: "Plan." }, onSubmit);
    typeInto(markdownField(renderRoot(card), ".context-editor"), "My plan.");
    inputWithValue(renderRoot(card), "pg").click();
    await card.updateComplete;
    buttonWithText(renderRoot(card), "Send").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenCalledWith("ask-1", { revision: "r1", partial: true, context: "My plan.", answers: [{ id: "db", values: ["pg"] }] });
  });

  it("keeps an empty editable context after a partial send cleared it, and sends a new one written there", async () => {
    const onSubmit = vi.fn<AskUserSubmitCallback>();
    const cache = question("cache", "Which cache?", [option("redis", "Redis")]);
    const card = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [option("pg", "Postgres")]), cache]), context: "Plan." }, onSubmit);
    typeInto(markdownField(renderRoot(card), ".context-editor"), "");
    inputWithValue(renderRoot(card), "pg").click();
    await card.updateComplete;
    buttonWithText(renderRoot(card), "Send").click();
    await Promise.resolve();
    expect(onSubmit).toHaveBeenLastCalledWith("ask-1", { revision: "r1", partial: true, context: "", answers: [{ id: "db", values: ["pg"] }] });

    // The daemon drops the cleared context from the questions left open.
    card.ask = { ...openAsk([cache]), revision: "r2" };
    await card.updateComplete;
    const editor = markdownField(renderRoot(card), ".context-editor");
    expect(editor.value).toBe("");
    typeInto(editor, "New plan.");
    inputWithValue(renderRoot(card), "redis").click();
    await card.updateComplete;
    buttonWithText(renderRoot(card), "Send answers").click();
    await Promise.resolve();

    expect(onSubmit).toHaveBeenLastCalledWith("ask-1", { revision: "r2", context: "New plan.", answers: [{ id: "cache", values: ["redis"] }] });
  });

  it("resets the edit when a revision changes the context, and keeps it when the context stays", async () => {
    const ask = { ...openAsk([question("db", "Which database?", [])]), context: "Plan A." };
    const card = await mountOpenAsk(ask);
    typeInto(markdownField(renderRoot(card), ".context-editor"), "Plan A, edited.");
    await card.updateComplete;

    card.ask = { ...ask, revision: "r2" };
    await card.updateComplete;
    expect(markdownField(renderRoot(card), ".context-editor").value).toBe("Plan A, edited.");

    card.ask = { ...ask, revision: "r3", context: "Plan B." };
    await card.updateComplete;
    expect(markdownField(renderRoot(card), ".context-editor").value).toBe("Plan B.");
    expect(renderRoot(card).querySelector(".context-actions")).toBeNull();
  });

  it("draws the diagrams and diffs live preview leaves as code under the editor, following the edits", async () => {
    const card = await mountOpenAsk({ ...openAsk([question("db", "Which database?", [])]), context: "Intro only." });
    expect(renderRoot(card).querySelector("formatted-text.context-media")).toBeNull();
    typeInto(markdownField(renderRoot(card), ".context-editor"), "Now:\n\n```diff\n-a\n+b\n```\n");
    await card.updateComplete;
    const media = requiredElement(renderRoot(card).querySelector<LitElement & { text: string }>("formatted-text.context-media"), "context media");
    expect(media.text).toBe("```diff\n-a\n+b\n```");
    await settleDeferredContent(media);
    expect(media.renderRoot.querySelector("pre.diff .added")?.textContent).toBe("+b\n");
  });

  it("renders the context of a closed ask record in its full-questions disclosure, after the answers", async () => {
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
    expect(renderRoot(card).querySelector(".record-lines ~ details.record-full formatted-text.ask-context")).not.toBeNull();
    expect(renderRoot(card).querySelector(".context-edited")).toBeNull();
  });

  it("keeps a sent record's context image without a source until its disclosure opens", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      context: "See ![Login screen](https://example.com/login.png)",
      questions: [unansweredRecord(question("db", "Which database?", [option("pg", "Postgres")]))],
      answeredCount: 0, unansweredIds: ["db"], summary: "Answered 0 of 1; unanswered: db",
    };
    document.body.append(card);
    await card.updateComplete;
    const formatted = requiredElement(renderRoot(card).querySelector<LitElement>("formatted-text.ask-context"), "ask context");
    const sourceChanges = watchImageSources(requiredElement(formatted.shadowRoot, "ask context shadow root"));
    const context = await renderedContext(card);
    const fold = requiredElement(context.querySelector<HTMLDetailsElement>("details.folded-media"), "image fold");

    expect([fold.open, fold.querySelector("img")?.hasAttribute("src"), sourceChanges()]).toEqual([false, false, []]);
    requiredElement(fold.querySelector("summary"), "image summary").click();
    expect([fold.open, fold.querySelector("img")?.getAttribute("src")]).toEqual([true, "https://example.com/login.png"]);
  });

  it("shows the user's edited context in a record, labelled as edited", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      context: "Recommend **Postgres**.", editedContext: "Recommend **SQLite**.",
      questions: [unansweredRecord(question("db", "Which database?", [option("pg", "Postgres")]))],
      answeredCount: 0, unansweredIds: ["db"], summary: "Answered 0 of 1; unanswered: db",
    };
    document.body.append(card);
    await card.updateComplete;

    expect((await renderedContext(card)).innerHTML).toContain("<strong>SQLite</strong>");
    expect(renderRoot(card).querySelector(".context-edited + formatted-text.ask-context")).not.toBeNull();
  });

  it("opens a local video linked from the context through the host, like a Chat link", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "cancelled", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      context: "Watch [IMG_2430.MOV](/Users/me/Bilder & Videos/IMG_2430.MOV).",
      questions: [unansweredRecord(question("db", "Which take?", []))],
      answeredCount: 0, unansweredIds: ["db"], summary: "Answered 0 of 1; unanswered: db",
    };
    card.workspaceContext = { machineId: "local", projectId: "p", workspaceId: "w", root: "/work" };
    document.body.append(card);
    await card.updateComplete;
    const opened = vi.fn((event: Event) => { event.preventDefault(); });
    document.body.addEventListener("outside-file-open", opened, { once: true });

    requiredElement((await renderedContext(card)).querySelector("a"), "context link").click();

    expect(opened.mock.calls[0]?.[0]).toMatchObject({ detail: { machineId: "local", path: "/Users/me/Bilder & Videos/IMG_2430.MOV" } });
  });

  it("opens a file link clicked in the context editor through the host, like a Chat link", async () => {
    const card = new AskUserCard();
    card.ask = { ...openAsk([question("db", "Which take?", [])]), context: "Watch [IMG_2430.MOV](/Users/me/IMG_2430.MOV)." };
    card.workspaceContext = { machineId: "local", projectId: "p", workspaceId: "w", root: "/work" };
    document.body.append(card);
    await card.updateComplete;
    const opened = vi.fn((event: Event) => { event.preventDefault(); });
    document.body.addEventListener("outside-file-open", opened, { once: true });

    const link = requiredElement(markdownField(renderRoot(card), ".context-editor").querySelector(".lp-link"), "editor link");
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

    expect(opened.mock.calls[0]?.[0]).toMatchObject({ detail: { machineId: "local", path: "/Users/me/IMG_2430.MOV" } });
  });

  it("renders an empty editable context and no context text when the ask carries none", async () => {
    const card = await mountOpenAsk(openAsk([question("db", "Which database?", [])]));

    expect(renderRoot(card).querySelector("formatted-text.ask-context")).toBeNull();
    expect(markdownField(renderRoot(card), ".context-editor").value).toBe("");
    expect(renderRoot(card).querySelector(".context-actions")).toBeNull();
  });
});

describe("ask-markdown-field", () => {
  it("destroys its editor when removed, releasing the window listeners, and rebuilds it with the text when re-added", async () => {
    const field = new AskMarkdownField();
    document.body.append(field);
    typeInto(field, "Typed **draft**");
    const view = editorView(field);
    const destroy = vi.spyOn(view, "destroy");
    const removed = vi.spyOn(window, "removeEventListener");

    // A move within one task keeps the editor.
    field.remove();
    document.body.append(field);
    await Promise.resolve();
    expect([destroy.mock.calls.length, editorView(field)]).toEqual([0, view]);

    field.remove();
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledOnce();
    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(["scroll", "resize"]));
    expect(field.querySelector(".cm-editor")).toBeNull();
    expect(field.value).toBe("Typed **draft**");

    document.body.append(field);
    const rebuilt = editorView(field);
    expect(rebuilt).not.toBe(view);
    expect(rebuilt.state.doc.toString()).toBe("Typed **draft**");
    removed.mockRestore();
  });
});

describe("renderedOnlyFences", () => {
  it("keeps only the mermaid, diff and worddiff fences, whole, including an unclosed last one", () => {
    const text = "Intro\n\n```ts\nconst a = 1;\n```\n\n```mermaid\npie\n```\n\n~~~~worddiff\nold\n>>>\nnew\n~~~~\n\n```diff\n-a";
    expect(renderedOnlyFences(text)).toBe("```mermaid\npie\n```\n\n~~~~worddiff\nold\n>>>\nnew\n~~~~\n\n```diff\n-a");
    expect(renderedOnlyFences("Just text with `code`.")).toBe("");
  });
});

async function renderedContext(card: AskUserCard): Promise<ShadowRoot> {
  openFullRecord(card);
  const formatted = requiredElement(renderRoot(card).querySelector<LitElement>("formatted-text.ask-context"), "ask context");
  await formatted.updateComplete;
  // Markdown formatting is deferred to a later frame.
  await settleDeferredContent(formatted);
  return requiredElement(formatted.shadowRoot, "ask context shadow root");
}

describe("ask-user-card media", () => {
  it("folds each image and Mermaid diagram in the context and details behind a disclosure that draws the diagram when opened, and colours diff fences", async () => {
    const media = "Compare these.\n\n![Login screen](https://example.com/login.png)\n\n```mermaid\npie\n  \"A\": 2\n```\n\n```diff\n-a\n+b\n```";
    // A manual renderer, like the Mermaid plugin: the Chat shows its source until asked.
    const rendering = createContentRenderingService((request) => request.language === "mermaid"
      ? [{ id: "diagram", label: "Diagram", renderer: { id: "diagram", render: () => html`<b class="diagram-preview">drawn</b>` } }]
      : request.language === "chart" ? [{ id: "chart", label: "Chart", renderer: { id: "chart", render: () => html`<b class="chart-preview">drawn</b>` } }] : []);
    const card = new AskUserCard();
    // A manual renderer that is not a folded diagram waits for its own Render click, even in question details.
    const detail = `${media}\n\n\`\`\`chart\nbar 1 2\n\`\`\``;
    card.ask = { ...openAsk([question("pick", "Pick one", [option("a", "A")], { detail })]), context: media };
    card.contentRendering = rendering;
    card.setAttribute("flat", "");
    document.body.append(card);
    await card.updateComplete;

    // The context's image folds in the editor's live preview and loads only once opened (by keyboard here); its diagram and diff are drawn under it.
    const imageFold = requiredElement(renderRoot(card).querySelector<HTMLDetailsElement>(".context-editor .lp-img details.folded-media"), "context image fold");
    const imageSummary = requiredElement(imageFold.querySelector("summary"), "context image summary");
    expect([imageSummary.textContent, imageFold.open, imageFold.querySelector("img")?.hasAttribute("src")]).toEqual(["Show image: Login screen", false, false]);
    imageSummary.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect([imageFold.open, imageFold.querySelector("img")?.getAttribute("src")]).toEqual([true, "https://example.com/login.png"]);
    // An image in a table folds the same way, without a source until its own disclosure opens.
    card.ask = { ...card.ask, askId: "ask-table", context: "| Screen |\n| --- |\n| ![Table shot](https://example.com/table.png) |\n\nEnd." };
    await card.updateComplete;
    const tableFold = requiredElement(renderRoot(card).querySelector<HTMLDetailsElement>(".context-editor .lp-table details.folded-media"), "table image fold");
    expect([tableFold.querySelector("summary")?.textContent, tableFold.open, tableFold.querySelector("img")?.hasAttribute("src")]).toEqual(["Show image: Table shot", false, false]);
    requiredElement(tableFold.querySelector("summary"), "table image summary").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect([tableFold.open, tableFold.querySelector("img")?.getAttribute("src")]).toEqual([true, "https://example.com/table.png"]);
    card.ask = { ...card.ask, askId: "ask-1", context: media };
    await card.updateComplete;
    const contextMedia = requiredElement(renderRoot(card).querySelector<LitElement>("formatted-text.context-media"), "context media");
    await settleDeferredContent(contextMedia);
    expect([...contextMedia.renderRoot.querySelectorAll("details.folded-media summary")].map((summary) => summary.textContent)).toEqual(["Show diagram"]);
    expect(contextMedia.renderRoot.querySelector("pre.diff .added")?.textContent).toBe("+b\n");
    for (const selector of ["formatted-text.question-detail"]) {
      const formatted = requiredElement(renderRoot(card).querySelector<LitElement>(selector), selector);
      const sourceChanges = watchImageSources(requiredElement(formatted.shadowRoot, "detail shadow root"));
      await settleDeferredContent(formatted);
      for (const host of formatted.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")) {
        await settleDeferredContent(host);
        await settleDeferredContent(host);
      }
      const root = formatted.renderRoot;
      const folds = [...root.querySelectorAll("details.folded-media")];
      expect(folds.map((fold) => [fold.querySelector("summary")?.textContent, fold.hasAttribute("open")])).toEqual([["Show image: Login screen", false], ["Show diagram", false]]);
      // Source-free until opened: the image never had a source in the DOM.
      expect([folds[0]?.querySelector("img")?.hasAttribute("src"), sourceChanges()]).toEqual([false, []]);
      requiredElement(folds[0]?.querySelector("summary"), "image summary").click();
      expect([folds[0]?.hasAttribute("open"), folds[0]?.querySelector("img")?.getAttribute("src")]).toEqual([true, "https://example.com/login.png"]);
      expect(root.querySelector("p")?.textContent).toBe("Compare these.");
      expect(root.querySelector("pre.diff .added")?.textContent).toBe("+b\n");
      const host = requiredElement(folds[1]?.querySelector<ContentRendererHost>("pi-web-content-renderer"), "diagram host");
      expect(host.renderRoot.querySelector(".diagram-preview")).toBeNull();
      requiredElement(folds[1]?.querySelector("summary"), "diagram summary").click();
      await settleDeferredContent(host);
      await settleDeferredContent(host);
      expect(folds[1]?.hasAttribute("open")).toBe(true);
      expect(host.renderRoot.querySelector(".diagram-preview")?.textContent).toBe("drawn");
      const chart = requiredElement([...root.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")].find((candidate) => candidate.language === "chart"), "chart host");
      expect([chart.closest("details"), chart.renderRoot.querySelector(".chart-preview")]).toEqual([null, null]);
    }
  });
});

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

    expect(root.querySelector("input, textarea, button, select, ask-markdown-field")).toBeNull();
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

  it("shows a closed record as one line per question and answer, the context, details and summary folded until opened", async () => {
    const card = new AskUserCard();
    card.outcome = {
      askId: "ask-1", reason: "submitted", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      context: "Recommend **Postgres**.", editedContext: "Recommend **SQLite**.",
      questions: [
        { question: question("db", "Which database?", [option("pg", "Postgres")], { detail: "The **main** store." }), answered: true, values: ["pg"] },
        { question: question("day", "Deploy day?", [option("mon", "Monday")]), answered: true, values: [], otherText: "Tuesday" },
        { question: { id: "on", question: "Enable cache?", options: [], kind: "boolean" }, answered: true, values: [], value: false },
        unansweredRecord(question("why", "Why?", [])),
        { question: question("gpu", "Which GPU?", []), answered: false, values: [], skipped: true },
      ],
      note: "Ship it.",
      answeredCount: 3, unansweredIds: ["why"], summary: "Answered 3 of 4; unanswered: why",
    };
    document.body.append(card);
    await card.updateComplete;
    const root = renderRoot(card);
    const details = requiredElement(root.querySelector<HTMLDetailsElement>("details.record-full"), "full questions");

    expect([...root.querySelectorAll("ol.record-lines > li")].map((line) => line.textContent.replace(/\s+/gu, " ").trim())).toEqual([
      "1. Which database? — Postgres", "2. Deploy day? — Custom: Tuesday", "3. Enable cache? — Off", "4. Why? — Unanswered", "5. Which GPU? — Skipped · condition not met",
    ]);
    expect(root.querySelector(".record-note")?.textContent).toContain("Ship it.");
    expect([details.open, details.querySelector("summary")?.textContent]).toEqual([false, "Show full questions"]);
    expect([...root.querySelectorAll(".ask-context, .context-edited, .question-detail, .record-summary")].every((element) => details.contains(element))).toBe(true);

    const context = await renderedContext(card);
    expect(details.open).toBe(true);
    expect(context.innerHTML).toContain("<strong>SQLite</strong>");
    expect(details.querySelector(".context-edited")?.textContent).toBe("Context edited by you");
    expect(details.querySelector<HTMLElement & { text: string }>(".record-question formatted-text.question-detail")?.text).toBe("The **main** store.");
    expect(details.querySelector(".record-summary")?.textContent.trim()).toBe("Answered 3 of 4; unanswered: why");
  });

  it("keeps a superseded record's explanation and unsent draft in view outside the disclosure", async () => {
    const db = question("db", "Which database?", [option("pg", "Postgres")]);
    saveAskDraft("session-1", "ask-1", { db: { values: ["pg"] } });
    const card = new AskUserCard();
    card.draftSessionId = "session-1";
    card.outcome = {
      askId: "ask-1", reason: "superseded", askedAt: "2026-07-20T10:00:00.000Z", closedAt: "2026-07-20T10:05:00.000Z",
      questions: [unansweredRecord(db)], answeredCount: 0, unansweredIds: ["db"], summary: "Answered 0 of 1; unanswered: db",
    };
    document.body.append(card);
    await card.updateComplete;
    const root = renderRoot(card);

    expect(root.querySelector(".record-status")?.textContent).toContain("A newer question set replaced this one.");
    expect(root.querySelector("ol.record-lines > li")?.textContent.replace(/\s+/gu, " ").trim()).toBe("1. Which database? — Postgres Draft answer · not sent");
    // Nothing more to show: no context, no detail, and the explanation stands in for the summary.
    expect(root.querySelector("details.record-full")).toBeNull();
  });
});

/** Opens a record's "Show full questions" disclosure; an open card has none. */
function openFullRecord(card: AskUserCard): void {
  const details = renderRoot(card).querySelector<HTMLDetailsElement>("details.record-full");
  if (details === null || details.open) return;
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
}

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

function markdownField(root: ShadowRoot, selector: string): AskMarkdownField {
  const field = root.querySelector(selector);
  if (!(field instanceof AskMarkdownField)) throw new Error(`Expected a Markdown field at ${selector}`);
  return field;
}

/** Reports each image source attribute set or removed under `root` since the call (a folded image must never get one before it opens). */
function watchImageSources(root: Node): () => (string | null)[] {
  const observer = new MutationObserver(() => undefined);
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["src", "srcset", "preview-url"] });
  return () => observer.takeRecords().map((record) => record.attributeName);
}

function editorView(field: AskMarkdownField): EditorView {
  return requiredElement(EditorView.findFromDOM(requiredElement(field.querySelector<HTMLElement>(".cm-editor"), "editor")), "editor view");
}

/** Replaces the field's text as the user's edit would. */
function typeInto(field: AskMarkdownField, text: string): void {
  const view = editorView(field);
  // Typed, as a keyboard edit is: the history keeps it apart from programmatic replacements.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" });
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
