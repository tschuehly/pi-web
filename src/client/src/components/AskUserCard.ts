import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ASK_USER_CONTEXT_MAX_LENGTH,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  ASK_USER_STALE_TURNS,
  askQuestionRef,
  type AskUserOutcome,
  type AskUserQuestion,
  type AskUserQuestionRecord,
  type AskUserSubmission,
  type PendingAskUser,
} from "../../../shared/apiTypes";
import {
  answeredCount,
  askedFingerprint,
  loadAskContext,
  loadAskDraft,
  loadAskNote,
  ownEntry,
  saveAskContext,
  saveAskDraft,
  saveAskNote,
  toSubmission,
  typedDraftValue,
  unansweredQuestions,
  visibleQuestions,
  type AskDraftAnswer,
  type AskDraftAnswers,
} from "../askDrafts";
import "./FormattedText";
import { AskMarkdownField } from "./AskMarkdownField";
import { livePreviewStyles } from "./workbenchFilesEditor";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { workspaceContextChanged, type MarkdownWorkspaceContext } from "../formatting/workspaceLinks";
import type { ChatContentRendering } from "../formatting/contentRendering";

// Lucide "pencil", "undo-2" and "sticky-note" (https://lucide.dev, ISC).
const PENCIL_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path></svg>`;
const UNDO_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"></path></svg>`;
const NOTE_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"></path><path d="M15 3v4a2 2 0 0 0 2 2h4"></path></svg>`;

/** "updated 5 min ago"-style age of an ISO timestamp. */
export function updatedAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!(minutes >= 1)) return "updated just now";
  if (minutes < 60) return `updated ${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `updated ${String(hours)} h ago` : `updated ${String(Math.floor(hours / 24))} d ago`;
}

/**
 * The fences of `markdown` that only the read view draws (mermaid, diff, worddiff), so the context editor can show
 * them rendered under it; empty when there are none.
 */
export function renderedOnlyFences(markdown: string): string {
  const blocks: string[] = [];
  let open: { fence: string; lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    if (open === undefined) {
      const start = /^ {0,3}(`{3,}|~{3,})\s*(?:mermaid|diff|worddiff)(?:\s|$)/u.exec(line);
      if (start?.[1] !== undefined) open = { fence: start[1], lines: [line] };
      continue;
    }
    open.lines.push(line);
    if (line.trim().startsWith(open.fence) && line.trim().replace(/[`~]/gu, "") === "") {
      blocks.push(open.lines.join("\n"));
      open = undefined;
    }
  }
  // An unclosed fence runs to the end, as Markdown reads it.
  if (open !== undefined) blocks.push(open.lines.join("\n"));
  return blocks.join("\n\n");
}

/** May return a promise; resolving to `false` means the submit did not reach the daemon (the caller showed why), so the card keeps its draft. */
export type AskUserSubmitCallback = (askId: string, submission: AskUserSubmission) => unknown;

interface DisplayedRecordAnswer {
  values: string[];
  otherText?: string;
  value?: boolean | number | string;
  fromDraft: boolean;
}

/**
 * One question set posted by `ask_user`.
 *
 * The live mode owns only browser-local draft state; the daemon remains the
 * source of truth for whether the ask is open. Record mode consumes the closed
 * daemon outcome and, for a superseded ask, can recover the unsent local draft
 * so text the user had entered is not silently hidden.
 */
@customElement("ask-user-card")
export class AskUserCard extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) ask?: PendingAskUser;
  @property({ attribute: false }) outcome?: AskUserOutcome;
  /** Machine-scoped session cache key used by the ask draft store. */
  @property({ attribute: false }) draftSessionId = "";
  @property({ attribute: false }) onSubmit?: AskUserSubmitCallback;
  /** Lets file links in the context open in the Files pane, as they do in the Chat. */
  @property({ attribute: false, hasChanged: workspaceContextChanged }) workspaceContext: MarkdownWorkspaceContext | undefined;
  /** The Chat's content renderers (Mermaid), so context and details draw diagrams like Chat messages. */
  @property({ attribute: false }) contentRendering: ChatContentRendering | undefined;

  @state() private answers: AskDraftAnswers = {};
  /** Free text on the whole set, sent with the answers. */
  @state() private note = "";
  /** The user's edit of the ask's context; `undefined` while it is unchanged. */
  @state() private editedContext: string | undefined;
  /** The Note field hides behind its icon until opened; a saved note keeps it open. */
  @state() private noteOpen = false;
  @state() private confirmingPartialSubmit = false;
  @state() private submitting = false;
  /** Per question id: the option edited in its own row, and the answer Revert restores. Its text is the Custom answer. */
  @state() private inlineEdits: Record<string, { value: string; previous: AskDraftAnswer | undefined }> = {};
  private modelIdentity: string | undefined;
  /** Question index to focus once a single-answer send comes back as the ask's next revision. */
  private focusAfterRevision: number | undefined;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("ask") && !changed.has("outcome") && !changed.has("draftSessionId")) return;
    const identity = this.currentModelIdentity();
    if (identity === this.modelIdentity) return;
    this.modelIdentity = identity;
    this.answers = this.loadCurrentDraft();
    this.note = this.ask === undefined || this.draftSessionId === "" ? "" : loadAskNote(this.draftSessionId, this.ask.askId);
    this.noteOpen = this.note !== "";
    // A context the user cleared with a partial send is absent: his new edit is made against "".
    const context = this.ask?.context ?? "";
    this.editedContext = this.ask === undefined || this.draftSessionId === "" || this.outcome !== undefined ? undefined : loadAskContext(this.draftSessionId, this.ask.askId, context);
    this.confirmingPartialSubmit = false;
    this.submitting = false;
    this.inlineEdits = {};
    const focusIndex = this.focusAfterRevision;
    this.focusAfterRevision = undefined;
    if (focusIndex !== undefined && this.ask !== undefined && this.ask.questions.length > 0) void this.focusQuestion(Math.min(focusIndex, this.ask.questions.length - 1));
  }

  override render(): TemplateResult | null {
    if (this.outcome !== undefined) return this.renderRecord(this.outcome);
    if (this.ask !== undefined) return this.renderOpenAsk(this.ask);
    return null;
  }

  private renderOpenAsk(ask: PendingAskUser): TemplateResult {
    const count = answeredCount(ask.questions, this.answers);
    const unanswered = unansweredQuestions(ask.questions, this.answers);
    // A question whose showIf is unmet is left out; ids keep the question's place in the set, numbers count the shown ones.
    const visible = visibleQuestions(ask.questions, this.answers);
    return html`
      <article class="ui-transcript-surface card open-card" aria-labelledby="ask-user-heading">
        <header class="card-header">
          <h2 id="ask-user-heading"><slot name="title">Questions</slot></h2>
          <span class="ask-meta">
            <time datetime=${ask.updatedAt} title=${ask.updatedAt}>${updatedAgo(ask.updatedAt)}</time>
            ${ask.turnsSinceUpdate > ASK_USER_STALE_TURNS ? html`<span class="stale" title=${`${String(ask.turnsSinceUpdate)} agent turns without an update`}>may be stale</span>` : null}
          </span>
          <span class="header-status" role="status" aria-live="polite" aria-atomic="true">
            ${count} of ${visible.length} answered
          </span>
          <slot name="actions"></slot>
        </header>
        ${this.renderContextEditor(ask.context)}
        <form class="ask-form" @submit=${(event: SubmitEvent) => { this.handleSubmit(event, ask); }}>
          <div class="questions">
            ${repeat(visible, (question) => question.id, (question, shown) => html`${shown === 0 ? null : html`<hr class="question-separator" />`}${this.renderQuestion(ask, question, ask.questions.indexOf(question), shown + 1, visible.length > 1)}`)}
          </div>
          ${this.noteOpen ? html`
            <div class="ask-note">
              <ask-markdown-field .label=${"Note for the whole set"} .placeholderText=${"Note for the whole set (optional)"} .value=${this.note} @ask-field-input=${this.changeNote}></ask-markdown-field>
            </div>
          ` : null}
          <footer class="form-footer">
            ${this.confirmingPartialSubmit && unanswered.length > 0
              ? this.renderPartialSubmitConfirmation(ask, unanswered)
              : html`
                  ${this.noteOpen ? null : html`<button class="note-toggle" type="button" aria-label="Add note" title="Add a note for the whole set" @click=${this.openNote}>${NOTE_ICON}</button>`}
                  <button class="primary-action" type="submit" ?disabled=${this.submitting}>
                    ${this.submitting ? "Sending…" : "Send answers"}
                  </button>
                `}
          </footer>
        </form>
      </article>
    `;
  }

  /** The model's explanation for the question set, rendered like Chat Markdown; a record marks the user's edit of it. */
  private renderContext(context: string | undefined, edited = false): TemplateResult | null {
    if (edited && context === "") return html`<p class="context-edited">Context cleared by you</p>`;
    return context === undefined ? null : html`
      ${edited ? html`<p class="context-edited">Context edited by you</p>` : null}
      <formatted-text class="ask-context" fold-media diff-views .contentRendering=${this.contentRendering} .workspaceContext=${this.workspaceContext} .text=${context}></formatted-text>
    `;
  }

  /**
   * The open set's context, editable from the start in the Markdown field styled as the read text. Diagrams and diffs
   * the live preview leaves as code are drawn under it from the current text.
   */
  private renderContextEditor(context: string | undefined): TemplateResult {
    // An absent context (cleared by a partial send) stays an empty field the user can write a new one into.
    const text = this.editedContext ?? context ?? "";
    const media = renderedOnlyFences(text);
    return html`
      <div class="ask-context">
        <ask-markdown-field class="context-editor" .label=${"Context (editable)"} .maxLength=${ASK_USER_CONTEXT_MAX_LENGTH} .workspaceContext=${this.workspaceContext} .value=${text} @ask-field-input=${this.changeContext}></ask-markdown-field>
        ${this.editedContext === undefined ? null : html`
          <div class="context-actions">
            <span class="context-edited">Edited</span>
            <button class="revert-edit" type="button" title="Restore the agent's context" @click=${this.revertContext}>${UNDO_ICON}Revert</button>
          </div>
        `}
        ${media === "" ? null : html`<formatted-text class="context-media" fold-media diff-views .contentRendering=${this.contentRendering} .workspaceContext=${this.workspaceContext} .text=${media}></formatted-text>`}
      </div>
    `;
  }

  private renderQuestion(ask: PendingAskUser, question: AskUserQuestion, index: number, number: number, sendOne: boolean): TemplateResult {
    const answer = ownEntry(this.answers, question.id);
    const answered = answeredCount([question], this.answers) === 1;
    const detailId = question.detail === undefined ? undefined : this.questionDetailId(index);
    const freeTextOnly = question.options.length === 0;
    const customSelected = freeTextOnly || this.isOtherSelected(question, answer);
    // The edited row holds the Custom text itself, so Custom and its own textarea step aside while it lasts.
    const inlineEdit = customSelected ? ownEntry(this.inlineEdits, question.id)?.value : undefined;
    const inputType = question.multiple === true ? "checkbox" : "radio";
    return html`
      <fieldset
        id=${this.questionFieldsetId(index)}
        class=${`question${answered ? " answered" : ""}`}
        aria-describedby=${ifDefined(detailId)}
        tabindex="-1"
      >
        <legend>
          <span class="question-number">${String(number)}.</span>
          <span>${question.question} <code class="question-ref" title="Reference for this question">${askQuestionRef(ask.askId, question.id)}</code></span>
        </legend>
        ${this.renderDetail(question.detail, detailId)}
        ${(question.kind ?? "choice") !== "choice" ? this.renderTypedField(question, index, answer) : html`
        <div class="options">
          ${question.options.map((option) => option.value === inlineEdit ? this.renderInlineEdit(question, index, option.label, answer?.otherText ?? "") : html`
            <div class="option-row">
              <label class="option">
                <input
                  type=${inputType}
                  name=${this.questionGroupName(ask, question)}
                  value=${option.value}
                  .checked=${answer?.values.includes(option.value) === true}
                  @change=${(event: Event) => { this.changeOption(question, option.value, event); }}
                />
                <span class="option-copy">
                  <span class="option-label">${option.label}${option.recommended === true ? html` <span class="recommended">Recommended</span>` : null}</span>
                  ${option.detail === undefined ? null : html`<span class="option-detail">${option.detail}</span>`}
                </span>
              </label>
              <button
                class="edit-option"
                type="button"
                aria-label="Edit this answer"
                title="Edit this answer"
                @click=${() => { this.editOption(question, index, option.value, option.detail === undefined ? option.label : `${option.label}\n${option.detail}`); }}
              >${PENCIL_ICON}</button>
            </div>
          `)}
          ${freeTextOnly ? null : html`
            <label class="option other-option">
              <input
                type=${inputType}
                name=${this.questionGroupName(ask, question)}
                value="__pi_web_other__"
                .checked=${customSelected && inlineEdit === undefined}
                @change=${(event: Event) => { this.changeOther(question, index, event); }}
              />
              <span class="option-copy"><span class="option-label">Custom</span></span>
            </label>
          `}
          ${customSelected && inlineEdit === undefined ? html`
            <div class="other-answer">
              <span aria-hidden="true">Custom answer</span>
              <ask-markdown-field
                id=${this.otherInputId(index)}
                .label=${"Custom answer"}
                .historyKey=${this.historyKey(question)}
                .value=${answer?.otherText ?? ""}
                @ask-field-input=${(event: Event) => { this.changeOtherText(question, event); }}
              ></ask-markdown-field>
            </div>
          ` : null}
        </div>
        `}
        ${sendOne ? html`
          <div class="question-actions">
            <button class="send-one" type="button" ?disabled=${!answered || this.submitting} title="Send just this answer now; the other questions stay open" @click=${() => { this.submitOne(ask, question, index); }}>Send</button>
          </div>
        ` : null}
      </fieldset>
    `;
  }

  /** A typed question's input: a switch, a text field or textarea, a number, or a date, with why its value does not fit under it. */
  private renderTypedField(question: AskUserQuestion, index: number, answer: AskDraftAnswer | undefined): TemplateResult {
    const id = this.otherInputId(index);
    if (question.kind === "boolean") {
      const on = answer?.value === true;
      return html`
        <label class="typed-field switch">
          <input id=${id} type="checkbox" role="switch" aria-label=${question.question} .checked=${on} @change=${(event: Event) => { if (event.currentTarget instanceof HTMLInputElement) this.setAnswer(question, { values: [], value: event.currentTarget.checked }); }} />
          <span class="switch-track" aria-hidden="true"></span>
          <span class="switch-state" aria-hidden="true">${on ? "On" : "Off"}</span>
        </label>
      `;
    }
    const raw = typeof answer?.value === "string" ? answer.value : "";
    const error = typedDraftValue(question, answer)?.error;
    const errorId = error === undefined ? undefined : `${id}-error`;
    const change = (event: Event): void => {
      const input = event.currentTarget;
      if (input instanceof HTMLInputElement || input instanceof AskMarkdownField) this.setAnswer(question, { values: [], value: input.value.slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH) });
    };
    const maxLength = String(question.maxLength ?? ASK_USER_OTHER_TEXT_MAX_LENGTH);
    return html`
      <div class="typed-field">
        ${question.kind === "text" && question.multiline === true
          ? html`<ask-markdown-field id=${id} class=${error === undefined ? "" : "invalid"} .label=${question.question} .maxLength=${question.maxLength ?? ASK_USER_OTHER_TEXT_MAX_LENGTH} .invalid=${error !== undefined} .describedBy=${errorId} .historyKey=${this.historyKey(question)} .value=${raw} @ask-field-input=${change}></ask-markdown-field>`
          : html`<input
              id=${id}
              type=${question.kind === "number" ? "number" : question.kind === "date" ? "date" : "text"}
              aria-label=${question.question}
              min=${ifDefined(question.integer === true && question.minimum !== undefined ? Math.ceil(question.minimum) : question.minimum)}
              max=${ifDefined(question.integer === true && question.maximum !== undefined ? Math.floor(question.maximum) : question.maximum)}
              step=${ifDefined(question.kind === "number" ? (question.integer === true ? "1" : "any") : undefined)}
              inputmode=${ifDefined(question.kind === "number" ? (question.integer === true ? "numeric" : "decimal") : undefined)}
              minlength=${ifDefined(question.kind === "text" ? question.minLength : undefined)}
              maxlength=${ifDefined(question.kind === "text" ? maxLength : undefined)}
              aria-invalid=${error === undefined ? "false" : "true"}
              aria-describedby=${ifDefined(errorId)}
              .value=${raw}
              @input=${change}
            />`}
        ${errorId === undefined ? null : html`<p class="field-error" id=${errorId}>${error?.replace(/^m/u, "M")}</p>`}
      </div>
    `;
  }

  /** What a question's field answers: Undo never crosses into another ask or another wording of the question. */
  private historyKey(question: AskUserQuestion): string {
    return `${this.ask?.askId ?? ""}\n${askedFingerprint(question)}`;
  }

  /** An option being edited in place: its row becomes the Custom answer's textarea, selected, with a way back. */
  private renderInlineEdit(question: AskUserQuestion, index: number, label: string, text: string): TemplateResult {
    return html`
      <div class="option-row inline-edit">
        <span class="inline-edit-marker">${PENCIL_ICON}</span>
        <ask-markdown-field
          id=${this.otherInputId(index)}
          .label=${`Custom answer, edited from ${label}`}
          .historyKey=${this.historyKey(question)}
          .value=${text}
          @ask-field-input=${(event: Event) => { this.changeOtherText(question, event); }}
          @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.revertEdit(question, index); } }}
        ></ask-markdown-field>
        <button class="revert-edit" type="button" title="Revert to the option (Esc)" @click=${() => { this.revertEdit(question, index); }}>${UNDO_ICON}Revert</button>
      </div>
    `;
  }

  /** A question's Markdown detail, in body text like the context. */
  private renderDetail(detail: string | undefined, id?: string): TemplateResult | null {
    return detail === undefined ? null : html`<formatted-text class="question-detail" id=${ifDefined(id)} fold-media diff-views .contentRendering=${this.contentRendering} .workspaceContext=${this.workspaceContext} .text=${detail}></formatted-text>`;
  }

  private renderPartialSubmitConfirmation(ask: PendingAskUser, unanswered: AskUserQuestion[]): TemplateResult {
    return html`
      <div class="partial-confirmation" role="group" aria-label="Confirm partial answers">
        <p>
          <strong>Send without answering:</strong>
          ${unanswered.map((question, index) => html`${index === 0 ? " " : ", "}<button
            class="question-jump"
            type="button"
            @click=${() => { void this.focusQuestion(ask.questions.indexOf(question)); }}
          >${question.question}</button>`)}?
        </p>
        <div class="confirmation-actions">
          <button class="secondary-action" type="button" @click=${() => { this.keepEditing(ask, unanswered); }}>Keep editing</button>
          <button class="primary-action send-anyway" type="button" ?disabled=${this.submitting} @click=${() => { void this.submitAnswers(ask); }}>
            ${this.submitting ? "Sending…" : "Send anyway"}
          </button>
        </div>
      </div>
    `;
  }

  private renderRecord(outcome: AskUserOutcome): TemplateResult {
    const recordLabel = outcome.partial === true
      ? `${outcome.answeredCount === 1 ? "Answer" : "Answers"} sent · others still open`
      : { submitted: "Answers sent", superseded: "Superseded", cancelled: "Cancelled", withdrawn: "Withdrawn" }[outcome.reason];
    return html`
      <article class="ui-transcript-surface card record-card" aria-labelledby="ask-user-record-heading">
        <header class="card-header">
          <h2 id="ask-user-record-heading">Questions</h2>
          <span class=${`header-status ${outcome.reason}`}>${recordLabel}</span>
          <slot name="actions"></slot>
        </header>
        ${this.renderContext(outcome.editedContext ?? outcome.context, outcome.editedContext !== undefined)}
        <p class="record-summary">
          ${outcome.reason === "superseded"
            ? "A newer question set replaced this one. Draft answers shown below were not sent to the model."
            : outcome.reason === "withdrawn" ? "The agent withdrew these questions." : outcome.summary}
        </p>
        <div class="record-questions">
          ${outcome.questions.map((record, index) => this.renderQuestionRecord(outcome, record, index))}
        </div>
        ${outcome.note === undefined ? null : html`<section class="record-question record-note"><h3>Note</h3><p class="other-record-text">${outcome.note}</p></section>`}
      </article>
    `;
  }

  private renderQuestionRecord(outcome: AskUserOutcome, record: AskUserQuestionRecord, index: number): TemplateResult {
    const answer = this.displayedRecordAnswer(outcome, record);
    return html`
      <section class="record-question" aria-labelledby=${this.recordQuestionHeadingId(index)}>
        <h3 id=${this.recordQuestionHeadingId(index)}>
          <span class="question-number">${String(index + 1)}.</span>
          <span>${record.question.question}</span>
        </h3>
        ${this.renderDetail(record.question.detail)}
        ${record.skipped === true
          ? html`<p class="unanswered-record">Skipped · condition not met</p>`
          : answer === undefined
          ? html`<p class="unanswered-record">Unanswered</p>`
          : html`
              <ul class="record-answers">
                ${answer.values.map((value) => html`<li>${this.optionLabel(record.question, value)}</li>`)}
                ${answer.otherText === undefined ? null : html`<li><strong>Custom:</strong> <span class="other-record-text">${answer.otherText}</span></li>`}
                ${answer.value === undefined ? null : html`<li class="other-record-text">${typeof answer.value === "boolean" ? (answer.value ? "On" : "Off") : String(answer.value)}</li>`}
              </ul>
              ${answer.fromDraft ? html`<p class="draft-note">Draft answer · not sent</p>` : null}
            `}
      </section>
    `;
  }

  private changeOption(question: AskUserQuestion, value: string, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    if (question.multiple !== true) this.endInlineEdit(question);
    if (question.multiple !== true) {
      if (input.checked) this.setAnswer(question, { values: [value] });
      return;
    }
    const current = ownEntry(this.answers, question.id);
    const values = input.checked
      ? [...new Set([...(current?.values ?? []), value])]
      : (current?.values ?? []).filter((selected) => selected !== value);
    this.setAnswer(question, {
      values,
      ...(current?.otherText === undefined ? {} : { otherText: current.otherText }),
    });
  }

  private changeOther(question: AskUserQuestion, index: number, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const current = ownEntry(this.answers, question.id);
    // Choosing Custom moves an inline edit's text into Custom's own textarea.
    this.endInlineEdit(question);
    if (question.multiple === true) {
      this.setAnswer(question, {
        values: [...(current?.values ?? [])],
        ...(input.checked ? { otherText: current?.otherText ?? "" } : {}),
      });
    } else if (input.checked) {
      this.setAnswer(question, { values: [], otherText: this.isOtherSelected(question, current) ? current?.otherText ?? "" : "" });
    }
    if (input.checked) void this.focusOtherInput(index);
  }

  /** Starts a Custom answer from an option's label and detail, edited in that option's row in place of the option. */
  private editOption(question: AskUserQuestion, index: number, value: string, text: string): void {
    const current = ownEntry(this.answers, question.id);
    const previous = ownEntry(this.inlineEdits, question.id)?.previous ?? current;
    this.inlineEdits = { ...this.inlineEdits, [question.id]: { value, previous } };
    this.setAnswer(question, {
      // The edit replaces the option, so its own value leaves the selection; Revert brings it back.
      values: question.multiple === true ? (current?.values ?? []).filter((selected) => selected !== value) : [],
      otherText: text.slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH),
    });
    void this.focusOtherInput(index, true);
  }

  /** Drops an inline edit, restoring the answer from before it began, and returns focus to the question. */
  private revertEdit(question: AskUserQuestion, index: number): void {
    const edit = ownEntry(this.inlineEdits, question.id);
    if (edit === undefined) return;
    this.endInlineEdit(question);
    this.setAnswer(question, edit.previous ?? { values: [] });
    void this.focusQuestion(index);
  }

  private endInlineEdit(question: AskUserQuestion): void {
    if (ownEntry(this.inlineEdits, question.id) === undefined) return;
    this.inlineEdits = Object.fromEntries(Object.entries(this.inlineEdits).filter(([id]) => id !== question.id));
  }

  private changeOtherText(question: AskUserQuestion, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof AskMarkdownField)) return;
    const current = ownEntry(this.answers, question.id);
    this.setAnswer(question, {
      values: [...(current?.values ?? [])],
      otherText: input.value.slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH),
    });
  }

  private readonly changeNote = (event: Event): void => {
    const input = event.currentTarget;
    if (!(input instanceof AskMarkdownField)) return;
    this.note = input.value.slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH);
    if (this.ask !== undefined && this.draftSessionId !== "") saveAskNote(this.draftSessionId, this.ask.askId, this.note);
  };

  private readonly changeContext = (event: Event): void => {
    const input = event.currentTarget;
    const ask = this.ask;
    if (!(input instanceof AskMarkdownField) || ask === undefined) return;
    const context = ask.context ?? "";
    this.editedContext = input.value === context ? undefined : input.value;
    if (this.draftSessionId !== "") saveAskContext(this.draftSessionId, ask.askId, context, input.value);
  };

  private readonly revertContext = (): void => {
    const ask = this.ask;
    if (ask === undefined) return;
    this.editedContext = undefined;
    if (this.draftSessionId !== "") saveAskContext(this.draftSessionId, ask.askId, ask.context ?? "", ask.context ?? "");
    this.renderRoot.querySelector<HTMLElement>(".context-editor")?.focus();
  };

  /** The edited context for a submission: nothing when unchanged, `""` when the user cleared it. */
  private contextSubmission(): Pick<AskUserSubmission, "context"> {
    const context = this.editedContext;
    // Blank over an absent context changes nothing, so it is no edit.
    if (context === undefined || (context.trim() === "" && (this.ask?.context ?? "") === "")) return {};
    return { context: context.trim() === "" ? "" : context };
  }

  private readonly openNote = async (): Promise<void> => {
    this.noteOpen = true;
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(".ask-note ask-markdown-field")?.focus();
  };

  private setAnswer(question: AskUserQuestion, answer: AskDraftAnswer): void {
    const next: AskDraftAnswers = { ...this.answers, [question.id]: { ...answer, asked: askedFingerprint(question) } };
    this.answers = next;
    this.confirmingPartialSubmit = false;
    if (this.ask !== undefined && this.draftSessionId !== "") saveAskDraft(this.draftSessionId, this.ask.askId, next);
    // Lets a question bar outside the card recount answered questions.
    this.dispatchEvent(new Event("ask-draft-change", { bubbles: true, composed: true }));
  }

  private handleSubmit(event: SubmitEvent, ask: PendingAskUser): void {
    event.preventDefault();
    if (this.submitting) return;
    if (unansweredQuestions(ask.questions, this.answers).length > 0) {
      void this.showPartialSubmitConfirmation();
      return;
    }
    void this.submitAnswers(ask);
  }

  private submitAnswers(ask: PendingAskUser): Promise<boolean> {
    const note = this.note.trim();
    return this.send(ask, { ...toSubmission(ask.questions, this.answers), ...(note === "" ? {} : { note }), ...this.contextSubmission(), revision: ask.revision });
  }

  /**
   * Sends what is answered, for the drawer's Send all: a fully answered set as its Send would, a partly answered one
   * as a partial submit that keeps the rest open (a partial takes no note, so the note waits for the rest).
   * `undefined` when nothing was sent because nothing is answered or a send is under way.
   */
  sendAnswered(): Promise<boolean> | undefined {
    const ask = this.ask;
    if (ask === undefined || this.outcome !== undefined || this.submitting) return undefined;
    const answers = toSubmission(ask.questions, this.answers).answers;
    if (answers.length === 0) return undefined;
    if (unansweredQuestions(ask.questions, this.answers).length === 0) return this.submitAnswers(ask);
    return this.send(ask, { answers, revision: ask.revision, partial: true, ...this.contextSubmission() });
  }

  /** True when the submit reached the daemon; on false the card and its draft stay intact. */
  private send(ask: PendingAskUser, submission: AskUserSubmission): Promise<boolean> {
    const callback = this.onSubmit;
    if (this.submitting || callback === undefined) return Promise.resolve(false);
    this.submitting = true;
    const askId = ask.askId;
    return Promise.resolve()
      .then(() => callback(askId, submission))
      .then((result) => result !== false)
      .catch(() => false)
      .then((sent) => {
        // The parent controller owns the visible transport error. Keeping this
        // card and its draft intact is the only recovery needed at this boundary.
        if (!sent) this.focusAfterRevision = undefined;
        if (this.ask?.askId === askId) this.submitting = false;
        return sent;
      });
  }

  /** Sends one question's answer at once (a partial submit); the daemon keeps the other questions open under a new revision. */
  private submitOne(ask: PendingAskUser, question: AskUserQuestion, index: number): void {
    // A follow-up shows because of its unsent parents' draft answers; they go with it, as the daemon judges showIf on the submission.
    const parents: AskUserQuestion[] = [];
    for (let id = question.showIf?.question; id !== undefined;) {
      const parent = ask.questions.find((each) => each.id === id);
      if (parent === undefined) break;
      parents.unshift(parent);
      id = parent.showIf?.question;
    }
    const answers = toSubmission([...parents, question], this.answers).answers;
    if (!answers.some((answer) => answer.id === question.id)) return;
    // A send that answers every visible question closes the set, so it goes as the full submit that carries the note.
    if (visibleQuestions(ask.questions, this.answers).every((each) => answers.some((answer) => answer.id === each.id))) {
      void this.submitAnswers(ask);
      return;
    }
    // The sent questions leave the form, taking the focused button with them; the next revision focuses the question in its place.
    this.focusAfterRevision = index - parents.length;
    void this.send(ask, { answers, revision: ask.revision, partial: true, ...this.contextSubmission() });
  }

  private async showPartialSubmitConfirmation(): Promise<void> {
    this.confirmingPartialSubmit = true;
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLElement>(".send-anyway")?.focus();
  }

  private keepEditing(ask: PendingAskUser, unanswered: AskUserQuestion[]): void {
    this.confirmingPartialSubmit = false;
    const first = unanswered[0];
    if (first !== undefined) void this.focusQuestion(ask.questions.indexOf(first));
  }

  /** Focus the `index`th question's first control, as a chip opening this set does. */
  /** Focuses a question's first control; `preventScroll` leaves the scrolling to the caller, e.g. to show the set's context first. */
  focusQuestion(index: number, preventScroll = false): Promise<void> {
    if (index < 0) return Promise.resolve();
    return this.updateComplete.then(() => {
      const fieldset = this.renderRoot.querySelector<HTMLElement>(`#${this.questionFieldsetId(index)}`);
      const firstControl = fieldset?.querySelector<HTMLElement>("input, ask-markdown-field");
      (firstControl ?? fieldset)?.focus({ preventScroll });
    });
  }

  private async focusOtherInput(index: number, cursorAtEnd = false): Promise<void> {
    await this.updateComplete;
    const input = this.renderRoot.querySelector(`#${this.otherInputId(index)}`);
    if (!(input instanceof AskMarkdownField)) return;
    if (cursorAtEnd) input.focusEnd();
    else input.focus();
  }

  private isOtherSelected(question: AskUserQuestion, answer: AskDraftAnswer | undefined): boolean {
    if (answer?.otherText === undefined) return false;
    return question.multiple === true || answer.values.length === 0;
  }

  private displayedRecordAnswer(outcome: AskUserOutcome, record: AskUserQuestionRecord): DisplayedRecordAnswer | undefined {
    if (record.answered) {
      return {
        values: [...record.values],
        ...(record.otherText === undefined ? {} : { otherText: record.otherText }),
        ...(record.value === undefined ? {} : { value: record.value }),
        fromDraft: false,
      };
    }
    if (outcome.reason !== "superseded") return undefined;
    const answer = toSubmission([record.question], this.answers).answers[0];
    if (answer === undefined) return undefined;
    return {
      values: [...answer.values],
      ...(answer.otherText === undefined ? {} : { otherText: answer.otherText }),
      ...(answer.value === undefined ? {} : { value: answer.value }),
      fromDraft: true,
    };
  }

  private optionLabel(question: AskUserQuestion, value: string): string {
    return question.options.find((option) => option.value === value)?.label ?? value;
  }

  private currentModelIdentity(): string | undefined {
    if (this.outcome !== undefined) return `record:${this.draftSessionId}:${this.outcome.askId}`;
    // A revision reloads the draft, which drops answers to questions it changed.
    if (this.ask !== undefined) return `open:${this.draftSessionId}:${this.ask.askId}:${this.ask.revision}`;
    return undefined;
  }

  private loadCurrentDraft(): AskDraftAnswers {
    const askId = this.outcome?.askId ?? this.ask?.askId;
    if (askId === undefined || this.draftSessionId === "") return {};
    return loadAskDraft(this.draftSessionId, askId, undefined, this.outcome === undefined ? this.ask?.questions : undefined);
  }

  private questionGroupName(ask: PendingAskUser, question: AskUserQuestion): string {
    return `ask-user:${ask.askId}:${question.id}`;
  }

  private questionFieldsetId(index: number): string {
    return `ask-user-question-${String(index)}`;
  }

  private questionDetailId(index: number): string {
    return `ask-user-question-detail-${String(index)}`;
  }

  private otherInputId(index: number): string {
    return `ask-user-other-${String(index)}`;
  }

  private recordQuestionHeadingId(index: number): string {
    return `ask-user-record-question-${String(index)}`;
  }

  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      margin: 0 0 14px;
      color: var(--pi-text);
      font: 14px var(--pi-font, system-ui, sans-serif);
      container-type: inline-size;
    }
    .card {
      --question-number-column: 25px;
      --question-copy-gap: 5px;
      /* A transcript that draws its own frame (the Workbench rail) replaces these and aligns text with --ui-transcript-inline-start. */
      border: var(--ask-card-border, 1px solid var(--pi-border));
      border-radius: var(--ask-card-radius, 10px);
      background: var(--ask-card-bg, var(--pi-surface));
    }
    .card-header {
      position: sticky;
      top: var(--pi-chat-sticky-top, 0px);
      z-index: 6;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 22px;
      padding: 7px 10px 6px var(--ui-transcript-inline-start, 10px);
      border-bottom: 1px solid color-mix(in srgb, var(--pi-border-muted) 35%, transparent);
      border-radius: var(--ask-card-radius, 9px) var(--ask-card-radius, 9px) 0 0;
      background: var(--ask-card-bg, var(--pi-surface));
      box-shadow: 0 8px 18px var(--pi-shadow-soft);
    }
    h2, h3, p { margin-top: 0; }
    h2 {
      margin-bottom: 0;
      color: var(--pi-accent);
      font-size: 12px;
      line-height: 1.3;
      text-transform: uppercase;
    }
    .header-status { flex: 0 1 auto; color: var(--pi-muted); font-size: 11px; text-align: end; }
    .header-status.submitted { color: var(--pi-success); }
    .header-status.superseded, .header-status.withdrawn { color: var(--pi-warning); }
    .ask-meta { flex: 1 1 auto; min-width: 0; display: flex; gap: 8px; color: var(--pi-muted); font-size: 11px; }
    .stale { color: var(--pi-warning); font-weight: 650; }
    .question-ref { color: var(--pi-muted); font-size: 11px; font-weight: 500; }
    .recommended { margin-inline-start: 4px; padding: 1px 6px; border-radius: 999px; background: var(--pi-success-bg); color: var(--pi-success); font-size: 11px; font-weight: 650; }
    .ask-context { display: block; padding: 12px 16px 0 var(--ui-transcript-inline-start, 16px); }
    /* The editable context reads as the rendered text: its font, size, line height and colours, a faint tint, a quiet focus ring. */
    .card .context-editor { margin-inline: -6px; width: calc(100% + 12px); border: 0; border-radius: 6px; background: color-mix(in srgb, var(--pi-text) 4%, transparent); }
    .card .context-editor .cm-editor { min-height: 0; max-height: none; }
    /* CodeMirror's base theme sets a monospace scroller; the context keeps the card's body font. */
    .card .context-editor .cm-scroller, .card .context-editor .cm-content { font: inherit; line-height: 1.45; }
    .card .context-editor .cm-content { padding: 4px 0; }
    .card .context-editor .cm-line { padding: 0 6px; }
    .card .context-editor:focus-within { outline: 1px solid color-mix(in srgb, var(--pi-accent) 60%, transparent); outline-offset: 0; }
    /* A folded image in a Markdown field's live preview, styled like the Chat's folded media. */
    ask-markdown-field .folded-media > summary { width: fit-content; color: var(--pi-accent); cursor: pointer; }
    ask-markdown-field .folded-media > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 4px; }
    .context-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 2px; }
    .context-edited { margin: 0; color: var(--pi-muted); font-size: 11px; }
    .record-card .context-edited { padding: 12px 16px 0 var(--ui-transcript-inline-start, 16px); }
    .record-card .context-edited + .ask-context { padding-top: 2px; }
    .context-media { display: block; margin-top: 6px; }
    .questions { display: grid; padding-top: 8px; }
    fieldset.question {
      min-width: 0;
      margin: 0;
      border: 0;
      padding: 0 16px 16px var(--ui-transcript-inline-start, 16px);
      background: transparent;
    }
    /* Its own element: a fieldset's top border would paint through the middle of its legend. */
    .question-separator { margin: 0 0 10px; border: 0; border-top: 1px solid var(--pi-border-muted); }
    fieldset.question:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -3px; }
    legend {
      box-sizing: border-box;
      width: 100%;
      display: grid;
      grid-template-columns: var(--question-number-column) minmax(0, 1fr);
      align-items: start;
      gap: var(--question-copy-gap);
      color: var(--pi-text);
      padding: 0;
      font-weight: 650;
      line-height: 1.35;
    }
    .question-number { justify-self: end; color: var(--pi-muted); }
    fieldset.question.answered .question-number { color: var(--pi-success); }
    .question-detail { display: block; margin: 4px 0 10px; color: var(--pi-text); overflow-wrap: anywhere; }
    fieldset.question > .question-detail {
      padding-inline-start: calc(var(--question-number-column) + var(--question-copy-gap));
    }
    .options { display: grid; gap: 7px; }
    legend + .options { margin-top: 10px; }
    /* The pencil sits in the option's trailing padding, so every option, Custom and the textarea end at one edge. */
    .option-row { position: relative; }
    .option-row > .option { padding-inline-end: 36px; }
    .edit-option {
      position: absolute;
      top: 4px;
      right: 4px;
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--pi-muted);
      opacity: 0;
      transition: opacity 120ms ease-out;
    }
    /* Shown on the row's hover or focus, so it stays keyboard reachable; touch screens always show it. */
    .option-row:hover > .edit-option, .option-row:focus-within > .edit-option { opacity: 1; }
    @media (hover: none) { .edit-option { opacity: 1; } }
    .edit-option:hover:not(:disabled) { background: color-mix(in srgb, var(--pi-text) 9%, transparent); color: var(--pi-text); }
    .option-row svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    /* The edited option keeps its row and its selected look; the pencil stands in for the control. */
    .inline-edit {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      gap: 5px;
      padding: 7px 8px;
      border: 1px solid var(--pi-accent);
      border-radius: 8px;
      background: var(--pi-selection-bg);
    }
    .inline-edit-marker { display: flex; margin-top: 3px; color: var(--pi-accent); }
    .card .inline-edit ask-markdown-field { flex: 1; min-width: 0; background: var(--pi-surface); }
    .card .inline-edit ask-markdown-field .cm-editor { min-height: 52px; }
    .revert-edit { grid-column: 2; justify-self: end; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-color: transparent; background: transparent; color: var(--pi-muted); font-size: 12px; }
    .revert-edit:hover:not(:disabled) { color: var(--pi-text); }
    /* 1px border + 8px padding + 16px control + 5px gap = the number gutter, so option text starts where question text does. */
    .option {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      align-items: start;
      gap: 5px;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 7px 8px;
      cursor: pointer;
    }
    .option:hover, :where(.option-row:hover) > .option { border-color: var(--pi-border); background: var(--pi-surface-hover); }
    .option:has(input:checked) { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
    input { margin: 2px 0 0; accent-color: var(--pi-accent); }
    input:focus-visible, button:focus-visible, ask-markdown-field:focus-within { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .option-copy { min-width: 0; display: grid; gap: 2px; }
    .option-label { line-height: 1.35; }
    .option-detail { color: var(--pi-muted); font-size: 12px; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
    .other-answer { display: grid; gap: 5px; color: var(--pi-muted); font-size: 12px; padding: 4px 0 4px calc(var(--question-number-column) + var(--question-copy-gap)); }
    .typed-field { display: grid; gap: 4px; padding: 4px 0 4px calc(var(--question-number-column) + var(--question-copy-gap)); }
    .typed-field input:not([type="checkbox"]) {
      box-sizing: border-box;
      width: 100%;
      margin: 0;
      border: 1px solid var(--pi-border);
      border-radius: 8px;
      background: var(--pi-bg);
      color: var(--pi-text);
      padding: 8px;
      font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif);
    }
    .typed-field input[type="number"], .typed-field input[type="date"] { width: auto; min-width: 11em; justify-self: start; }
    .typed-field [aria-invalid="true"] { border-color: var(--pi-danger); }
    .field-error { margin: 0; color: var(--pi-danger); font-size: 12px; }
    .switch { position: relative; display: inline-flex; align-items: center; gap: 8px; justify-self: start; cursor: pointer; }
    /* The real checkbox stays focusable and clickable over the drawn track. */
    .switch input { position: absolute; inset-inline-start: calc(var(--question-number-column) + var(--question-copy-gap)); width: 36px; height: 20px; margin: 0; opacity: 0; cursor: pointer; }
    .switch-track { position: relative; width: 36px; height: 20px; border-radius: 999px; background: var(--pi-border); transition: background 0.15s; }
    .switch-track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--pi-surface); transition: transform 0.15s; }
    .switch input:checked + .switch-track { background: var(--pi-accent); }
    .switch input:checked + .switch-track::after { transform: translateX(16px); }
    .switch input:focus-visible + .switch-track { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .question-actions { display: flex; justify-content: flex-end; margin-top: 6px; }
    .send-one { padding: 3px 10px; font-size: 12px; }
    .send-one:not(:disabled) { border-color: var(--pi-accent); color: var(--pi-accent); font-weight: 650; }
    .send-one:disabled { cursor: default; }
    /* Multi-line answers: the Files pane's Markdown editor in a textarea's frame; .card outranks CodeMirror's base theme. */
    ${livePreviewStyles}
    ask-markdown-field { display: block; box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); color: var(--pi-text); }
    .card ask-markdown-field .cm-editor { min-height: 68px; max-height: 50vh; background: transparent; color: var(--pi-text); }
    .card ask-markdown-field .cm-editor.cm-focused { outline: none; }
    .card ask-markdown-field .cm-scroller { overflow: auto; }
    .card ask-markdown-field .cm-content { padding: 8px 0; font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif); caret-color: var(--pi-accent); }
    .card ask-markdown-field .cm-line { padding: 0 8px; }
    .card ask-markdown-field .cm-placeholder { color: var(--pi-muted); }
    ask-markdown-field.invalid { border-color: var(--pi-danger); }
    .ask-note { display: grid; padding: 0 16px 10px var(--ui-transcript-inline-start, 16px); }
    /* A quiet one-line field that grows with its text; focus tints the border instead of a second ring. */
    .ask-note ask-markdown-field { border-color: var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); }
    .card .ask-note ask-markdown-field .cm-editor { min-height: 0; max-height: 8lh; }
    .card .ask-note ask-markdown-field .cm-content { padding: 5px 0; }
    .ask-note ask-markdown-field:focus-within { outline: 2px solid transparent; outline-offset: 0; border-color: var(--pi-accent); box-shadow: 0 0 0 1px var(--pi-accent); }
    .note-toggle { display: grid; place-items: center; padding: 6px; border-color: transparent; background: transparent; color: var(--pi-muted); }
    .note-toggle:hover:not(:disabled) { color: var(--pi-text); }
    .note-toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .form-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      border-top: 1px solid var(--pi-border-muted);
      padding: 12px 16px;
    }
    button {
      border: 1px solid var(--pi-border);
      border-radius: 8px;
      background: var(--pi-surface);
      color: var(--pi-text);
      padding: 7px 10px;
      font: inherit;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    button:disabled { cursor: wait; opacity: .65; }
    .primary-action { border-color: var(--pi-accent); background: var(--pi-accent); color: var(--pi-accent-contrast, white); font-weight: 650; }
    .primary-action:hover:not(:disabled) { background: color-mix(in srgb, var(--pi-accent) 86%, white); }
    .partial-confirmation { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
    .partial-confirmation p { min-width: 0; margin: 0; color: var(--pi-warning); font-size: 12px; line-height: 1.4; }
    .question-jump {
      display: inline;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      padding: 0;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .confirmation-actions { flex: 0 0 auto; display: flex; gap: 7px; }
    .record-summary { margin: 0; color: var(--pi-muted); padding: 12px 16px 12px var(--ui-transcript-inline-start, 16px); font-size: 12px; }
    .record-questions { display: grid; }
    .record-question { min-width: 0; padding: 14px 16px 14px var(--ui-transcript-inline-start, 16px); }
    .record-question + .record-question { border-top: 1px solid var(--pi-border-muted); }
    .record-question h3 { display: grid; grid-template-columns: var(--question-number-column) minmax(0, 1fr); align-items: start; gap: var(--question-copy-gap); margin-bottom: 8px; font-size: 14px; line-height: 1.35; }
    /* Numbers and bullets hang in the gutter so question and answer words stay in the transcript's text column. */
    .record-question h3 { margin-inline-start: calc(-1 * (var(--question-number-column) + var(--question-copy-gap))); }
    /* The note has no number to hang, so its heading sits in the text column like the answers. */
    .record-note h3 { display: block; margin-inline-start: 0; }
    .record-answers { display: grid; gap: 4px; margin: 0; padding-left: 0; line-height: 1.4; }
    .other-record-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .unanswered-record { margin: 0; color: var(--pi-muted); font-style: italic; }
    .draft-note { margin: 7px 0 0; color: var(--pi-warning); font-size: 11px; }
    @container (max-width: 580px) {
      fieldset.question { padding: 0 12px 14px var(--ui-transcript-inline-start, 12px); }
      .record-question { padding: 14px 12px 14px var(--ui-transcript-inline-start, 12px); }
      .record-summary, .ask-context, .ask-note { padding-inline: var(--ui-transcript-inline-start, 12px) 12px; }
      .form-footer { align-items: stretch; flex-direction: column; padding: 12px; }
      .partial-confirmation { align-items: stretch; flex-direction: column; }
      .confirmation-actions { justify-content: flex-end; }
      .note-toggle { align-self: flex-start; }
      .primary-action { min-height: 42px; }
    }
    /* Embedded in the question drawer: no frame of its own, one header line, composer-dense spacing. */
    :host([flat]) { margin: 0; font-size: 13px; }
    :host([flat]) .card { border: 0; border-radius: 0; background: transparent; }
    :host([flat]) .card-header { justify-content: flex-start; gap: 6px; min-height: 28px; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--pi-border-muted); border-radius: 0; box-shadow: none; }
    :host([flat]) h2 { color: var(--pi-muted); font-weight: 600; text-transform: none; white-space: nowrap; }
    :host([flat]) .ask-meta { flex: 0 1 auto; gap: 6px; font-size: 12px; }
    :host([flat]) .header-status { flex: 1 1 auto; font-size: 12px; text-align: start; }
    :host([flat]) .ask-meta::before, :host([flat]) .header-status::before { content: "·" / ""; margin-inline-end: 6px; }
    /* One reading column: numbers and controls hang in the gutter between the 12px inset and the text. */
    :host([flat]) .card { --ask-reading-start: calc(12px + var(--question-number-column) + var(--question-copy-gap)); }
    :host([flat]) .open-card .ask-context { padding: 8px 12px 8px var(--ask-reading-start); }
    /* A sent record kept in the drawer reads in the same column, its numbers and bullets hanging in the gutter. */
    :host([flat]) .record-card :is(.ask-context, .context-edited, .record-summary, .record-question) { padding-inline: var(--ask-reading-start) 12px; }
    :host([flat]) .questions { padding-top: 8px; }
    :host([flat]) .question-separator { margin-bottom: 8px; }
    :host([flat]) fieldset.question { padding: 0 12px 8px; }
    :host([flat]) .question-detail { margin: 2px 0 6px; }
    :host([flat]) legend + .options { margin-top: 6px; }
    :host([flat]) .options { gap: 2px; }
    :host([flat]) .option { padding-block: 4px; }
    :host([flat]) .ask-note { padding: 0 12px 8px var(--ask-reading-start); }
    /* The drawer scrolls the questions under their actions, which stay in view. */
    :host([flat]) .form-footer { position: sticky; bottom: 0; z-index: 6; padding: 6px 12px; background: var(--pi-surface); }
    :host([flat]) .form-footer button:not(.question-jump) { padding: 5px 10px; }
    :host([flat]) .edit-option { top: 1px; }
    :host([flat]) .inline-edit { padding-block: 4px; }
    @media (prefers-reduced-motion: reduce) { .edit-option, .switch-track, .switch-track::after { transition: none; } }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ask-user-card": AskUserCard;
  }
}
