import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ASK_USER_CONTEXT_MAX_LENGTH,
  ASK_USER_OTHER_TEXT_MAX_LENGTH,
  ASK_USER_STALE_TURNS,
  askQuestionRef,
  type AskUserAnswer,
  type AskUserImageTarget,
  type AskUserOutcome,
  type AskUserQuestion,
  type AskUserQuestionRecord,
  type AskUserSubmission,
  type PendingAskUser,
  askBooleanLabel,
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
import { askImageKey, askImageTargetKey, loadAskImages, saveAskImages, type StagedAskImage } from "../askImageStaging";
import { sameAskImageTarget } from "../../../shared/askUserImages";
import { capturePromptAttachments, dataTransferHasFiles, filesFromDataTransfer, READ_FAILURE_MESSAGE, readFileAsBase64 } from "../promptAttachmentCapture";
import { MAX_PROMPT_ATTACHMENTS, SUPPORTED_IMAGE_MIME_TYPES } from "../../../shared/promptAttachments";
import { renderAttachIcon } from "./promptEditorIcons";
import "./ImageGalleryDialog";
import type { ImageGalleryDialog } from "./ImageGalleryDialog";

// Lucide "pencil" and "undo-2" (https://lucide.dev, ISC).
const PENCIL_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path></svg>`;
const UNDO_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"></path></svg>`;
const NOTE: AskUserImageTarget = { kind: "note" };

/** The image targets of a send's answers, in their order. */
function questionTargets(answers: readonly AskUserAnswer[]): AskUserImageTarget[] {
  return answers.map((answer) => ({ kind: "question", id: answer.id }));
}

/** "updated 5 min ago"-style age of an ISO timestamp. */
export function updatedAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!(minutes >= 1)) return "updated just now";
  if (minutes < 60) return `updated ${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `updated ${String(hours)} h ago` : `updated ${String(Math.floor(hours / 24))} d ago`;
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
  /** The Chat's host takes images with answers (`chatSupports(status, "ask-images")`): the note and text answers accept them. */
  @property({ attribute: false }) imagesEnabled = false;
  /** Record mode: each `outcome.images` entry's source, in its order; `undefined` where its bytes are not at hand. */
  @property({ attribute: false }) recordImages: readonly (string | undefined)[] | undefined;

  @state() private answers: AskDraftAnswers = {};
  /** Free text on the whole set, sent with the answers. */
  @state() private note = "";
  /** The user's edit of the ask's context; `undefined` while it is unchanged. */
  @state() private editedContext: string | undefined;
  /** After a send the context folds to one line until clicked, unless the user ticked Keep context open; both reset for each new set. */
  @state() private contextFolded = false;
  @state() private keepContextOpen = false;
  /** The set the fold and Keep context open belong to: a revision of it keeps them. */
  private foldAskId: string | undefined;
  @state() private confirmingPartialSubmit = false;
  @state() private submitting = false;
  /** Per question id: the option edited in its own row, and the answer Revert restores. Its text is the Custom answer. */
  @state() private inlineEdits: Record<string, { value: string; previous: AskDraftAnswer | undefined }> = {};
  /** Unsent images per {@link askImageTargetKey} (the note or a text question), mirrored in memory by askImageStaging. */
  @state() private images: Record<string, readonly StagedAskImage[]> = {};
  @state() private imageError: string | undefined;
  private imageSeq = 0;
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
    if (this.ask?.askId !== this.foldAskId) {
      this.foldAskId = this.ask?.askId;
      this.contextFolded = false;
      this.keepContextOpen = false;
    }
    // A context the user cleared with a partial send is absent: his new edit is made against "".
    const context = this.ask?.context ?? "";
    this.editedContext = this.ask === undefined || this.draftSessionId === "" || this.outcome !== undefined ? undefined : loadAskContext(this.draftSessionId, this.ask.askId, context);
    this.confirmingPartialSubmit = false;
    this.submitting = false;
    this.inlineEdits = {};
    this.images = this.loadImages();
    this.imageError = undefined;
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
    // An approval set may be the context alone: Approve, or send a note (with any context edit) instead of answers.
    const contextOnly = ask.questions.length === 0;
    return html`
      <article class="ui-transcript-surface card open-card" aria-labelledby="ask-user-heading">
        <header class="card-header">
          <h2 id="ask-user-heading"><slot name="title">Questions</slot></h2>
          <span class="ask-meta">
            <time datetime=${ask.updatedAt} title=${ask.updatedAt}>${updatedAgo(ask.updatedAt)}</time>
            ${ask.turnsSinceUpdate > ASK_USER_STALE_TURNS ? html`<span class="stale" title=${`${String(ask.turnsSinceUpdate)} agent turns without an update`}>may be stale</span>` : null}
          </span>
          ${contextOnly ? null : html`<span class="header-status" role="status" aria-live="polite" aria-atomic="true">
            ${count} of ${visible.length} answered
          </span>`}
          <slot name="actions"></slot>
        </header>
        ${this.renderContextEditor(ask.context)}
        <form class="ask-form" @submit=${(event: SubmitEvent) => { this.handleSubmit(event, ask); }}>
          ${contextOnly ? null : html`<div class="questions">
            ${repeat(visible, (question) => question.id, (question, shown) => html`${shown === 0 ? null : html`<hr class="question-separator" />`}${this.renderQuestion(ask, question, ask.questions.indexOf(question), shown + 1, visible.length > 1)}`)}
          </div>`}
          <footer class="form-footer">
            <div class="note-column">
              ${this.renderWithImages(NOTE, "the note", html`<ask-markdown-field class="ask-note" .label=${"Note for the whole set"} .placeholderText=${"Note for the whole set (optional)"} .value=${this.note} @ask-field-input=${this.changeNote}></ask-markdown-field>`)}
            </div>
            ${this.confirmingPartialSubmit && unanswered.length > 0
              ? this.renderPartialSubmitConfirmation(ask, unanswered)
              : html`
                  <label class="keep-context"><input type="checkbox" .checked=${this.keepContextOpen} @change=${(event: Event) => { if (event.currentTarget instanceof HTMLInputElement) this.keepContextOpen = event.currentTarget.checked; }} />Keep context open</label>
                  ${ask.approval === true ? html`<button class="approve" type="button" title="Approve the context (your edited version, if you changed it) and send the answers; unanswered questions close too" ?disabled=${this.submitting} @click=${() => { void this.submitAnswers(ask, true); }}>Approve</button>` : null}
                  <button class="primary-action" type="submit" ?disabled=${this.submitting || (contextOnly && this.note.trim() === "" && this.contextSubmission().context === undefined)}>
                    ${this.submitting ? "Sending…" : contextOnly ? "Send note" : "Send answers"}
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
   * are drawn in place, as the read view draws them, until the user clicks into one to edit its source.
   */
  private renderContextEditor(context: string | undefined): TemplateResult {
    // An absent context (cleared by a partial send) stays an empty field the user can write a new one into.
    const text = this.editedContext ?? context ?? "";
    if (this.contextFolded && text.trim() !== "") {
      const line = text.split("\n").map((each) => each.replace(/^[\s#>*+-]+/u, "").trim()).find((each) => each !== "") ?? "";
      return html`
        <div class="ask-context">
          <button class="context-folded" type="button" aria-expanded="false" title="Show the context" @click=${() => { this.contextFolded = false; }}>
            <span class="context-folded-label">Context</span><span class="context-folded-line">${line}</span>
          </button>
        </div>
      `;
    }
    return html`
      <div class="ask-context">
        <ask-markdown-field class="context-editor" .label=${"Context (editable)"} .maxLength=${ASK_USER_CONTEXT_MAX_LENGTH} .workspaceContext=${this.workspaceContext} .contentRendering=${this.contentRendering} .renderFences=${true} .value=${text} @ask-field-input=${this.changeContext}></ask-markdown-field>
        ${this.editedContext === undefined ? null : html`
          <div class="context-actions">
            <span class="context-edited">Edited</span>
            <button class="revert-edit" type="button" title="Restore the agent's context" @click=${this.revertContext}>${UNDO_ICON}Revert</button>
          </div>
        `}
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
    const customField = customSelected && inlineEdit === undefined ? html`
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
    ` : null;
    const customChoice = html`
      <label class="option other-option">
        <input
          type=${inputType}
          name=${this.questionGroupName(ask, question)}
          value="__pi_web_other__"
          .checked=${customSelected && inlineEdit === undefined}
          @change=${(event: Event) => { this.changeOther(question, index, event); }}
        />
        ${this.renderOptionCopy({ label: "Custom" })}
      </label>
      ${customField}
    `;
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
                ${this.renderOptionCopy(option)}
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
          ${freeTextOnly ? customField : customChoice}
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

  private renderOptionCopy(option: Pick<AskUserQuestion["options"][number], "label" | "detail" | "recommended">): TemplateResult {
    return html`
      <span class="option-copy">
        <span class="option-label">${option.label}${option.recommended === true ? html` <span class="recommended">Recommended</span>` : null}</span>
        ${option.detail === undefined ? null : html`<span class="option-detail">${option.detail}</span>`}
      </span>
    `;
  }

  /** A typed question's input: a switch, a text field or textarea, a number, or a date, with why its value does not fit under it. */
  private renderTypedField(question: AskUserQuestion, index: number, answer: AskDraftAnswer | undefined): TemplateResult {
    const id = this.otherInputId(index);
    if (question.kind === "boolean") {
      const on = answer?.value === true;
      // Words, once opened, ride along with the switch; non-blank they replace its value, as a choice's Custom answer does.
      const words = answer?.otherText;
      const keep = (): AskDraftAnswer => ({ values: [], ...(answer?.value === undefined ? {} : { value: answer.value }) });
      return html`
        <div class="boolean-field">
          <label class=${`typed-field switch${(words ?? "").trim() === "" ? "" : " overridden"}`}>
            <input id=${id} type="checkbox" role="switch" aria-label=${question.question} .checked=${on} @change=${(event: Event) => { if (event.currentTarget instanceof HTMLInputElement) this.setAnswer(question, { values: [], value: event.currentTarget.checked, ...(words === undefined ? {} : { otherText: words }) }); }} />
            <span class="switch-track" aria-hidden="true"></span>
            <span class="switch-state" aria-hidden="true">${askBooleanLabel(question, on)}</span>
          </label>
          ${words === undefined
            ? html`<button class="answer-in-words" type="button" @click=${() => { this.setAnswer(question, { ...keep(), otherText: "" }); void this.focusWords(index); }}>Answer in words</button>`
            : html`<input
                id=${`${id}-words`}
                class="boolean-words"
                type="text"
                aria-label=${`${question.question}: answer in words`}
                placeholder="Answer in words"
                maxlength=${String(ASK_USER_OTHER_TEXT_MAX_LENGTH)}
                .value=${words}
                @input=${(event: Event) => { if (event.currentTarget instanceof HTMLInputElement) this.setAnswer(question, { ...keep(), otherText: event.currentTarget.value.slice(0, ASK_USER_OTHER_TEXT_MAX_LENGTH) }); }}
              />`}
        </div>
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
    const field = question.kind === "text" && question.multiline === true
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
            />`;
    return html`
      <div class="typed-field">
        ${question.kind === "text" ? this.renderWithImages({ kind: "question", id: question.id }, "this answer", field) : field}
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
          >${question.question}</button>`)}${unanswered.at(-1)?.question.trimEnd().endsWith("?") === true ? "" : "?"}
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
      : outcome.approved === true ? "Approved"
      : { submitted: "Answers sent", superseded: "Superseded", cancelled: "Cancelled", withdrawn: "Withdrawn" }[outcome.reason];
    // Superseded and withdrawn explain their status, so that line stays in view; the summary only repeats the answers.
    const statusLine = outcome.reason === "superseded"
      ? "A newer question set replaced this one. Draft answers shown below were not sent to the model."
      : outcome.reason === "withdrawn" ? "The agent withdrew these questions." : undefined;
    const context = this.renderContext(outcome.editedContext ?? outcome.context, outcome.editedContext !== undefined);
    const details = outcome.questions.flatMap((record, index) => record.question.detail === undefined ? [] : [this.renderQuestionDetailRecord(record, index)]);
    const full = context !== null || details.length > 0 || statusLine === undefined;
    return html`
      <article class="ui-transcript-surface card record-card" aria-labelledby="ask-user-record-heading">
        <header class="card-header">
          <h2 id="ask-user-record-heading">Questions</h2>
          <span class=${`header-status ${outcome.reason}`}>${recordLabel}</span>
          <slot name="actions"></slot>
        </header>
        ${statusLine === undefined ? null : html`<p class="record-summary record-status">${statusLine}</p>`}
        <ol class="record-lines" aria-label="Questions and answers">
          ${outcome.questions.map((record, index) => this.renderQuestionRecord(outcome, record, index))}
        </ol>
        ${outcome.note === undefined && !(outcome.images ?? []).some((image) => image.target.kind === "note") ? null : html`<section class="record-question record-note"><h3>Note</h3>${outcome.note === undefined ? null : html`<p class="other-record-text">${outcome.note}</p>`}${this.renderRecordImages(outcome, NOTE)}</section>`}
        ${this.recordImages?.some((src) => src !== undefined) === true ? html`<pi-web-image-gallery-dialog></pi-web-image-gallery-dialog>` : null}
        ${full ? html`
          <details class="record-full">
            <summary>Show full questions</summary>
            ${context}
            ${statusLine === undefined ? html`<p class="record-summary">${outcome.summary}</p>` : null}
            ${details}
          </details>
        ` : null}
      </article>
    `;
  }

  /** One compact line: number, question, then its answer as text. */
  private renderQuestionRecord(outcome: AskUserOutcome, record: AskUserQuestionRecord, index: number): TemplateResult {
    const answer = this.displayedRecordAnswer(outcome, record);
    const parts = answer === undefined ? [] : [
      ...answer.values.map((value) => this.optionLabel(record.question, value)),
      ...(answer.otherText === undefined ? [] : [`Custom: ${answer.otherText}`]),
      ...(answer.value === undefined ? [] : [typeof answer.value === "boolean" ? askBooleanLabel(record.question, answer.value) : String(answer.value)]),
    ];
    return html`
      <li class="record-line">
        <span class="question-number">${String(index + 1)}.</span>
        <span class="record-line-copy">
          <span class="record-line-question">${record.question.question}</span>
          <span aria-hidden="true"> — </span>
          ${record.skipped === true
            ? html`<span class="unanswered-record">Skipped · condition not met</span>`
            : answer === undefined
            ? html`<span class="unanswered-record">Unanswered</span>`
            : html`<span class="record-answer other-record-text">${parts.join(", ")}</span>${answer.fromDraft ? html` <span class="draft-note">Draft answer · not sent</span>` : null}`}
          ${this.renderRecordImages(outcome, { kind: "question", id: record.question.id })}
        </span>
      </li>
    `;
  }

  /** A question's detail inside the record's disclosure, under its number and wording. */
  private renderQuestionDetailRecord(record: AskUserQuestionRecord, index: number): TemplateResult {
    return html`
      <section class="record-question" aria-labelledby=${this.recordQuestionHeadingId(index)}>
        <h3 id=${this.recordQuestionHeadingId(index)}>
          <span class="question-number">${String(index + 1)}.</span>
          <span>${record.question.question}</span>
        </h3>
        ${this.renderDetail(record.question.detail)}
      </section>
    `;
  }

  /**
   * A field that takes images: paste or drop them on it, or pick them with the paperclip; each shows as a removable
   * thumbnail under it. Without the host's support it is the field alone.
   */
  private renderWithImages(target: AskUserImageTarget, label: string, field: TemplateResult): TemplateResult {
    if (!this.imagesEnabled) return field;
    const key = askImageTargetKey(target);
    const images = ownEntry(this.images, key) ?? [];
    const accept = SUPPORTED_IMAGE_MIME_TYPES.join(",");
    return html`
      <div class="with-images" @paste=${{ capture: true, handleEvent: (event: ClipboardEvent) => { this.pasteImages(target, event); } }} @dragover=${(event: DragEvent) => { if (event.dataTransfer !== null && dataTransferHasFiles(event.dataTransfer)) event.preventDefault(); }} @drop=${{ capture: true, handleEvent: (event: DragEvent) => { this.dropImages(target, event); } }}>
        <div class="field-row">
          ${field}
          <button class="attach-image" type="button" title=${`Attach images to ${label}`} aria-label=${`Attach images to ${label}`} @click=${(event: Event) => { const picker = event.currentTarget instanceof HTMLElement ? event.currentTarget.nextElementSibling : null; if (picker instanceof HTMLInputElement) picker.click(); }}>${renderAttachIcon()}</button>
          <input type="file" accept=${accept} multiple hidden @change=${(event: Event) => { this.pickImages(target, event); }} />
        </div>
        ${images.length === 0 ? null : html`
          <div class="answer-images" data-target=${key} aria-label=${`Images on ${label}`}>
            ${images.map((image) => html`
              <span class="answer-image">
                <img src=${`data:${image.mimeType};base64,${image.data}`} alt=${image.name ?? "attached image"} />
                <button class="answer-image-remove" type="button" title="Remove image" aria-label=${`Remove image ${image.name ?? ""}`.trim()} @click=${() => { this.removeImage(target, image.id); }}>×</button>
              </span>
            `)}
          </div>
        `}
        ${this.imageError === undefined || key !== this.imageErrorTarget ? null : html`<p class="field-error" role="alert">${this.imageError}</p>`}
      </div>
    `;
  }

  /** The record's thumbnails of one target: a click opens them all in the gallery; one without bytes shows its reference. */
  private renderRecordImages(outcome: AskUserOutcome, target: AskUserImageTarget): TemplateResult | null {
    const all = outcome.images ?? [];
    const own = all.flatMap((image, index) => sameAskImageTarget(image.target, target) ? [{ image, src: this.recordImages?.[index] }] : []);
    if (own.length === 0) return null;
    return html`
      <span class="answer-images" data-target=${askImageTargetKey(target)}>
        ${own.map(({ image, src }) => src === undefined
          ? html`<span class="answer-image-missing" title="Image not loaded here (sent with an earlier answer, or images are off)">${image.name ?? "image"}</span>`
          : html`<button class="answer-image-open" type="button" title=${`Open ${image.name ?? "image"}`} @click=${() => { this.openRecordImage(src); }}><img src=${src} alt=${image.name ?? `${image.reference} attached image`} /></button>`)}
      </span>
    `;
  }

  private openRecordImage(src: string): void {
    const entries = (this.recordImages ?? []).flatMap((each, index) => each === undefined ? [] : [{ src: each, alt: this.outcome?.images?.[index]?.name ?? "attached image" }]);
    this.renderRoot.querySelector<ImageGalleryDialog>("pi-web-image-gallery-dialog")?.show(entries, Math.max(0, entries.findIndex((entry) => entry.src === src)));
  }

  /** Which field the last image error belongs to, so it shows under that field alone. */
  private imageErrorTarget: string | undefined;

  /** Runs in the capture phase: the prevented default keeps CodeMirror from pasting (and replacing the selection) or dropping file text. */
  private pasteImages(target: AskUserImageTarget, event: ClipboardEvent): void {
    const files = filesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void this.addImages(target, files);
  }

  private dropImages(target: AskUserImageTarget, event: DragEvent): void {
    const files = filesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void this.addImages(target, files);
  }

  private pickImages(target: AskUserImageTarget, event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement) || input.files === null) return;
    const files = Array.from(input.files);
    input.value = "";
    void this.addImages(target, files);
  }

  /** Reads image files as the composer does and stages them on `target`; other files and any past the set's limit are refused. */
  private async addImages(target: AskUserImageTarget, files: readonly File[]): Promise<void> {
    const ask = this.ask;
    if (ask === undefined || !this.imagesEnabled) return;
    const { attachments, error } = await capturePromptAttachments(files, readFileAsBase64);
    if (this.ask?.askId !== ask.askId) return;
    const images = attachments.filter((each) => each.kind === "image");
    const room = MAX_PROMPT_ATTACHMENTS - Object.values(this.images).reduce((sum, each) => sum + each.length, 0);
    const kept = images.slice(0, Math.max(0, room));
    this.imageErrorTarget = askImageTargetKey(target);
    this.imageError = error ?? (images.length < attachments.length ? "Only JPEG, PNG, GIF or WebP images can be attached here."
      : kept.length < images.length ? `At most ${String(MAX_PROMPT_ATTACHMENTS)} images per question set.` : undefined);
    if (error === READ_FAILURE_MESSAGE && kept.length === 0) return;
    this.setImages(target, [...(ownEntry(this.images, askImageTargetKey(target)) ?? []), ...kept.map((each) => ({ id: `ask-image-${String(++this.imageSeq)}`, target, mimeType: each.mimeType, data: each.data, name: each.name }))]);
  }

  private removeImage(target: AskUserImageTarget, id: string): void {
    this.setImages(target, (ownEntry(this.images, askImageTargetKey(target)) ?? []).filter((image) => image.id !== id));
    this.imageError = undefined;
  }

  private setImages(target: AskUserImageTarget, images: readonly StagedAskImage[]): void {
    this.images = { ...this.images, [askImageTargetKey(target)]: images };
    if (this.ask !== undefined && this.draftSessionId !== "") saveAskImages(askImageKey(this.draftSessionId, this.ask.askId, target), images);
  }

  /** The open set's unsent images, kept in memory across its revisions; a reload starts without them. */
  private loadImages(): Record<string, readonly StagedAskImage[]> {
    const ask = this.ask;
    if (ask === undefined || this.outcome !== undefined || this.draftSessionId === "") return {};
    const targets: AskUserImageTarget[] = [NOTE, ...ask.questions.filter((question) => question.kind === "text").map((question) => ({ kind: "question" as const, id: question.id }))];
    return Object.fromEntries(targets.map((target) => [askImageTargetKey(target), loadAskImages(askImageKey(this.draftSessionId, ask.askId, target))]));
  }

  /** The images a send carries, of `targets` in their order: `[PIC_n]` numbers follow it. */
  private imagesFor(targets: readonly AskUserImageTarget[]): Pick<AskUserSubmission, "images"> {
    const images = targets.flatMap((target) => (ownEntry(this.images, askImageTargetKey(target)) ?? []).map(({ mimeType, data, name }) => ({ target, mimeType, data, ...(name === undefined ? {} : { name }) })));
    return images.length === 0 ? {} : { images };
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

  /** `approved`: Approve, which closes the whole set even with questions unanswered. */
  private submitAnswers(ask: PendingAskUser, approved = false): Promise<boolean> {
    const note = this.note.trim();
    const submission = toSubmission(ask.questions, this.answers);
    // A closing send carries only answered questions' images; one staged on a blank answer would be lost with the set.
    const stranded = visibleQuestions(ask.questions, this.answers).find((question) => question.kind === "text"
      && !submission.answers.some((answer) => answer.id === question.id)
      && (ownEntry(this.images, askImageTargetKey({ kind: "question", id: question.id }))?.length ?? 0) > 0);
    if (stranded !== undefined) {
      this.imageErrorTarget = askImageTargetKey({ kind: "question", id: stranded.id });
      this.imageError = "Add an answer or remove the image";
      return Promise.resolve(false);
    }
    return this.send(ask, { ...submission, ...(note === "" ? {} : { note }), ...this.contextSubmission(), revision: ask.revision, ...(approved ? { approved } : {}), ...this.imagesFor([...questionTargets(submission.answers), NOTE]) });
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
    return this.send(ask, { answers, revision: ask.revision, partial: true, ...this.contextSubmission(), ...this.imagesFor(questionTargets(answers)) });
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
        else if (!this.keepContextOpen) this.contextFolded = true;
        // Sent images leave memory; the record shows them from the answers message.
        const sentTargets = sent ? submission.images?.map((image) => image.target) ?? [] : [];
        if (this.draftSessionId !== "") for (const target of sentTargets) saveAskImages(askImageKey(this.draftSessionId, askId, target), []);
        const sentKeys = new Set(sentTargets.map(askImageTargetKey));
        if (sentKeys.size > 0 && this.ask?.askId === askId) this.images = Object.fromEntries(Object.entries(this.images).filter(([key]) => !sentKeys.has(key)));
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
    void this.send(ask, { answers, revision: ask.revision, partial: true, ...this.contextSubmission(), ...this.imagesFor(questionTargets(answers)) });
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

  private async focusWords(index: number): Promise<void> {
    await this.updateComplete;
    this.renderRoot.querySelector<HTMLInputElement>(`#${this.otherInputId(index)}-words`)?.focus();
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
      margin: 0 0 12px;
      color: var(--pi-text);
      font: 14px var(--pi-font, system-ui, sans-serif);
      container-type: inline-size;
    }
    /*
     * One reading column (--ask-x): context, questions, details and answers start there; question numbers hang in the
     * gutter to its left, and boxed controls (options, fields, the note) bleed 8px into it so their text lines up too.
     * Spacing steps are 4, 8 and 12px: tight inside a question, wider between questions and around the send bar.
     */
    .card {
      --ask-x: var(--ui-transcript-inline-start, 28px);
      --ask-end: 16px;
      --question-number-column: 16px;
      --question-copy-gap: 4px;
      /* Accent-coloured words: the accent alone reads under 4.5:1 on some dark themes (pi-web-dark 3.7:1); mixing in the text colour lifts it in light and dark themes alike. */
      --ask-accent-text: color-mix(in srgb, var(--pi-accent) 65%, var(--pi-text));
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
      min-height: 20px;
      padding: 6px var(--ask-end) 6px var(--ask-x);
      border-bottom: 1px solid color-mix(in srgb, var(--pi-border-muted) 35%, transparent);
      border-radius: var(--ask-card-radius, 9px) var(--ask-card-radius, 9px) 0 0;
      background: var(--ask-card-bg, var(--pi-surface));
      box-shadow: 0 8px 18px var(--pi-shadow-soft);
    }
    h2, h3, p { margin-top: 0; }
    h2 {
      margin-bottom: 0;
      color: var(--ask-accent-text);
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
    .recommended { margin-inline-start: 4px; padding: 0 6px; border-radius: 999px; background: var(--pi-success-bg); color: var(--pi-success); font-size: 11px; font-weight: 650; }
    .ask-context { display: block; min-width: 0; padding: 8px var(--ask-end) 0 var(--ask-x); }
    /* The editable context reads as one continuous text with the rendered view: its font, size, line height and colours; no frame, tint or focus ring (the caret shows focus). */
    .card .context-editor { border: 0; border-radius: 0; background: transparent; }
    .card .context-editor .cm-editor { min-height: 0; max-height: none; }
    /* CodeMirror's base theme sets a monospace scroller; the context keeps the card's body font. */
    .card .context-editor .cm-scroller, .card .context-editor .cm-content { font: inherit; line-height: 1.45; }
    .card .context-editor .cm-content { padding: 0; }
    .card .context-editor .cm-line { padding: 0; }
    /* A blank source line stands for the read view's paragraph gap, not a whole empty line. */
    .card .context-editor .cm-line:has(> br:only-child) { line-height: 8px; }
    /* Headings and lists sit where the read view puts them: no extra top air on the first line, bullets in a 22px indent. */
    .card .context-editor .lp-h { padding-top: 8px; padding-bottom: 4px; }
    .card .context-editor .cm-line:first-child { padding-top: 0; }
    .card .context-editor .lp-li { --m: 14px; padding-left: calc(8px + var(--depth) * 1.6em + var(--m)) !important; }
    /* Inline code as the read view draws it; slice, not clone, so a wrapped code run adds no padding at the line's end to push it past the edge. */
    .card .context-editor .lp-inline-code { padding: 1px 4px; border-radius: 3px; background: var(--pi-surface-hover); font-size: 13px; -webkit-box-decoration-break: slice; box-decoration-break: slice; }
    .card .context-editor .lp-fence-block { cursor: text; }
    .card .context-editor:focus-within { outline: none; }
    /* A folded image in a Markdown field's live preview, styled like the Chat's folded media. */
    ask-markdown-field .folded-media > summary { width: fit-content; color: var(--ask-accent-text); cursor: pointer; }
    ask-markdown-field .folded-media > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 4px; }
    .context-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
    .context-edited { margin: 0; color: var(--pi-muted); font-size: 11px; }
    .record-card .context-edited { padding: 8px var(--ask-end) 0 var(--ask-x); }
    .record-card .context-edited + .ask-context { padding-top: 2px; }
    /* The widest step: context and questions are the card's two groups. */
    .questions { display: grid; padding-top: 16px; }
    fieldset.question {
      min-width: 0;
      margin: 0;
      border: 0;
      /* No top padding: a fieldset puts it between the legend and the rest, so the space above a question is the separator's. */
      padding: 0 var(--ask-end) 12px var(--ask-x);
      background: transparent;
    }
    /* Its own element: a fieldset's top border would paint through the middle of its legend. */
    .question-separator { margin: 0 var(--ask-end) 12px var(--ask-x); border: 0; border-top: 1px solid var(--pi-border-muted); }
    fieldset.question:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -3px; }
    /* The number hangs in the gutter, so the question's words start on the reading column. */
    legend {
      box-sizing: border-box;
      width: calc(100% + var(--question-number-column) + var(--question-copy-gap));
      display: grid;
      grid-template-columns: var(--question-number-column) minmax(0, 1fr);
      align-items: start;
      gap: var(--question-copy-gap);
      margin-inline-start: calc(-1 * (var(--question-number-column) + var(--question-copy-gap)));
      padding: 0;
      color: var(--pi-text);
      font-weight: 650;
      line-height: 1.4;
    }
    .question-number { justify-self: end; color: var(--pi-muted); }
    fieldset.question.answered .question-number { color: var(--pi-success); }
    /* Below the question in a quieter voice; the options carry the answer. */
    .question-detail { display: block; margin: 2px 0 0; color: var(--pi-text-secondary, var(--pi-muted)); font-size: 13px; overflow-wrap: anywhere; }
    .options { display: grid; gap: 0; margin: 6px 0 0 -8px; }
    /* The pencil sits in the option's trailing padding, so every option, Custom and the textarea end at one edge. */
    .option-row { position: relative; }
    .option-row > .option { padding-inline-end: 40px; }
    .edit-option {
      position: absolute;
      top: 0;
      right: 0;
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      min-height: 0;
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
    /* The edited option keeps its row and its selected tint; the pencil stands in for the control. */
    .inline-edit {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      gap: 4px 8px;
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--pi-selection-bg);
    }
    .inline-edit-marker { display: flex; margin-top: 9px; color: var(--pi-accent); }
    .card .inline-edit ask-markdown-field { flex: 1; min-width: 0; }
    .card .inline-edit ask-markdown-field .cm-editor { min-height: 52px; }
    .revert-edit { grid-column: 2; justify-self: end; display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border-color: transparent; background: transparent; color: var(--pi-muted); font-size: 12px; }
    .revert-edit:hover:not(:disabled) { color: var(--pi-text); }
    .revert-edit svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    /* One row per option, its tint the only box: hover lightens it, the selected one carries the selection colour. */
    .option {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr);
      align-items: start;
      gap: 8px;
      min-height: 32px;
      box-sizing: border-box;
      border-radius: 6px;
      padding: 6px 8px;
      cursor: pointer;
    }
    .option:hover, :where(.option-row:hover) > .option { background: var(--pi-surface-hover); }
    .option:has(input:checked) { background: var(--pi-selection-bg); }
    input { margin: 2px 0 0; accent-color: var(--pi-accent); }
    input:focus-visible, button:focus-visible, ask-markdown-field:focus-within { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .option-copy { min-width: 0; display: grid; gap: 0; }
    .option-label { line-height: 1.4; }
    .option-detail { color: var(--pi-muted); font-size: 12px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
    /* Under its choice: the field's text starts where the option labels do (8px pad + 16px control + 8px gap, less its own 9px inset). */
    .other-answer { display: grid; gap: 2px; color: var(--pi-muted); font-size: 12px; padding: 2px 0 4px 23px; }
    .other-answer > span { padding-inline-start: 9px; }
    .typed-field { display: grid; gap: 4px; margin-top: 8px; }
    .typed-field input:not([type="checkbox"]) {
      box-sizing: border-box;
      width: calc(100% + 8px);
      min-height: 32px;
      margin: 0 0 0 -8px;
      border: 1px solid var(--pi-border);
      border-radius: 6px;
      background: var(--pi-bg);
      color: var(--pi-text);
      padding: 4px 8px;
      font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif);
    }
    .typed-field ask-markdown-field { width: calc(100% + 8px); margin-inline-start: -8px; }
    .typed-field input[type="number"], .typed-field input[type="date"] { width: auto; min-width: 11em; justify-self: start; }
    .typed-field [aria-invalid="true"] { border-color: var(--pi-danger); }
    .field-error { margin: 0; color: var(--pi-danger); font-size: 12px; }
    .switch { position: relative; display: inline-flex; align-items: center; gap: 8px; justify-self: start; min-height: 32px; cursor: pointer; }
    /* The real checkbox stays focusable and clickable over the drawn track. */
    .switch input { position: absolute; inset-inline-start: 0; top: 6px; width: 36px; height: 20px; margin: 0; opacity: 0; cursor: pointer; }
    .switch-track { position: relative; width: 36px; height: 20px; border-radius: 999px; background: var(--pi-border); transition: background 0.15s; }
    .switch-track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--pi-surface); transition: transform 0.15s; }
    .switch input:checked + .switch-track { background: var(--pi-accent); }
    .switch input:checked + .switch-track::after { transform: translateX(16px); }
    .switch input:focus-visible + .switch-track { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .boolean-field { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 4px; }
    .boolean-field > .switch { margin-top: 0; }
    /* Words replace the switch's value, so it reads as set aside while they hold text. */
    .switch.overridden .switch-track, .switch.overridden .switch-state { opacity: .45; }
    .answer-in-words { padding: 0 8px; border-color: transparent; background: transparent; color: var(--pi-muted); font-size: 12px; }
    .answer-in-words:hover:not(:disabled) { color: var(--pi-text); }
    .boolean-words { flex: 1 1 14em; min-width: 0; min-height: 32px; box-sizing: border-box; margin: 0; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text); padding: 4px 8px; font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif); }
    .approve { border-color: var(--pi-accent); color: var(--ask-accent-text); font-weight: 650; }
    .question-actions { display: flex; justify-content: flex-end; margin-top: 4px; }
    .send-one { padding: 0 12px; font-size: 12px; }
    /* Quiet beside Send answers: accent text, no frame until hovered. */
    .send-one { border-color: transparent; background: transparent; color: var(--ask-accent-text); font-weight: 650; }
    .send-one:disabled { color: var(--pi-muted); font-weight: 400; cursor: default; }
    /* Multi-line answers: the Files pane's Markdown editor in a textarea's frame; .card outranks CodeMirror's base theme. */
    ${livePreviewStyles}
    ask-markdown-field { display: block; box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text); }
    .card ask-markdown-field .cm-editor { min-height: 68px; max-height: 50vh; background: transparent; color: var(--pi-text); }
    .card ask-markdown-field .cm-editor.cm-focused { outline: none; }
    .card ask-markdown-field .cm-scroller { overflow: auto; }
    /* min-width: a wide diff or code block scrolls in its own box instead of widening the text, so long lines and inline code wrap. */
    .card ask-markdown-field .cm-content { min-width: 0; padding: 6px 0; font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif); caret-color: var(--pi-accent); }
    .card ask-markdown-field .cm-line { padding: 0 8px; }
    .card ask-markdown-field .cm-placeholder { color: var(--pi-muted); }
    ask-markdown-field.invalid { border-color: var(--pi-danger); }
    /* The note fills the send bar beside its buttons: two lines tall, growing with its text; focus tints the border instead of a second ring. */
    .note-column { flex: 1 1 auto; min-width: 0; }
    ask-markdown-field.ask-note { display: block; min-width: 0; border-color: var(--pi-border-muted); background: var(--pi-surface); }
    .card ask-markdown-field.ask-note .cm-editor { min-height: calc(2lh + 10px); max-height: 8lh; }
    .card ask-markdown-field.ask-note .cm-content { padding: 5px 0; }
    ask-markdown-field.ask-note:focus-within { outline: 2px solid transparent; outline-offset: 0; border-color: var(--pi-accent); box-shadow: 0 0 0 1px var(--pi-accent); }
    /* A field that takes images: the paperclip beside it, the thumbnails under it. */
    .with-images { display: grid; gap: 4px; min-width: 0; }
    .field-row { display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
    .field-row > :first-child { flex: 1 1 auto; min-width: 0; }
    .typed-field .field-row > :first-child { width: auto; margin-inline-start: 0; }
    .typed-field .with-images { width: calc(100% + 8px); margin-inline-start: -8px; }
    .attach-image { flex: 0 0 auto; display: grid; place-items: center; width: 32px; padding: 0; border-color: transparent; background: transparent; color: var(--pi-muted); }
    .attach-image:hover:not(:disabled) { color: var(--pi-text); }
    .attach-image svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .answer-images { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
    .record-card .answer-images { margin-top: 4px; }
    .answer-image { display: inline-flex; align-items: center; gap: 4px; padding: 4px; border-radius: 6px; background: var(--pi-surface-hover); }
    .answer-image img, .answer-image-open img { display: block; width: 48px; height: 48px; object-fit: cover; border-radius: 4px; }
    .answer-image-remove { width: 32px; padding: 0; border-color: transparent; background: transparent; color: var(--pi-muted); font-size: 16px; }
    .answer-image-open { display: inline-flex; min-height: 0; padding: 0; border: 0; border-radius: 4px; background: transparent; cursor: zoom-in; }
    .answer-image-missing { color: var(--pi-muted); font-size: 12px; }
    .keep-context { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; min-height: 32px; color: var(--pi-muted); font-size: 12px; white-space: nowrap; cursor: pointer; }
    .keep-context input { margin: 0; accent-color: var(--pi-accent); }
    .context-folded { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 0; border: 0; background: transparent; color: var(--pi-muted); text-align: start; }
    .context-folded:hover:not(:disabled) { background: transparent; color: var(--pi-text); }
    .context-folded-label { flex: 0 0 auto; font-weight: 650; }
    .context-folded-line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .form-footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 8px 12px;
      border-top: 1px solid var(--pi-border-muted);
      padding: 8px var(--ask-end) 8px calc(var(--ask-x) - 8px);
    }
    button {
      box-sizing: border-box;
      min-height: 32px;
      border: 1px solid var(--pi-border);
      border-radius: 6px;
      background: var(--pi-surface);
      color: var(--pi-text);
      padding: 0 12px;
      font: inherit;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    button:disabled { cursor: wait; opacity: .65; }
    .primary-action { border-color: var(--pi-accent); background: var(--pi-accent); color: var(--pi-accent-contrast, white); font-weight: 650; }
    .primary-action:hover:not(:disabled) { background: color-mix(in srgb, var(--pi-accent) 86%, white); }
    .partial-confirmation { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
    .partial-confirmation p { min-width: 0; margin: 0; color: var(--pi-warning); font-size: 12px; line-height: 1.4; }
    .question-jump {
      display: inline;
      min-height: 0;
      border: 0;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      padding: 0;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .confirmation-actions { flex: 0 0 auto; display: flex; gap: 8px; }
    .record-summary { margin: 0; color: var(--pi-muted); padding: 8px var(--ask-end) 8px var(--ask-x); font-size: 12px; }
    .record-lines { display: grid; gap: 4px; margin: 0; padding: 8px var(--ask-end) 8px var(--ask-x); list-style: none; line-height: 1.4; }
    /* Numbers hang in the gutter so question and answer words stay in the reading column. */
    .record-line { display: grid; grid-template-columns: var(--question-number-column) minmax(0, 1fr); align-items: start; gap: var(--question-copy-gap); margin-inline-start: calc(-1 * (var(--question-number-column) + var(--question-copy-gap))); }
    .record-line-copy { min-width: 0; overflow-wrap: anywhere; }
    .record-line-question { font-weight: 600; }
    .record-note { border-top: 1px solid var(--pi-border-muted); }
    .record-full { border-top: 1px solid var(--pi-border-muted); }
    .record-full > summary { width: fit-content; padding: 8px var(--ask-end) 8px var(--ask-x); color: var(--ask-accent-text); font-size: 12px; cursor: pointer; }
    .record-full > summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; border-radius: 4px; }
    .record-full > .ask-context { padding-top: 0; }
    .record-full > .record-question { border-top: 1px solid var(--pi-border-muted); }
    .record-question { min-width: 0; padding: 8px var(--ask-end) 12px var(--ask-x); }
    .record-question h3 { display: grid; grid-template-columns: var(--question-number-column) minmax(0, 1fr); align-items: start; gap: var(--question-copy-gap); margin-bottom: 2px; font-size: 14px; line-height: 1.4; }
    /* Numbers hang in the gutter so question and answer words stay in the reading column. */
    .record-question h3 { margin-inline-start: calc(-1 * (var(--question-number-column) + var(--question-copy-gap))); }
    /* The note has no number to hang, so its label sits in the reading column like the answers. */
    .record-note h3 { display: block; margin-inline-start: 0; color: var(--pi-muted); font-size: 12px; font-weight: 600; }
    .other-record-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .unanswered-record { color: var(--pi-muted); font-style: italic; }
    .draft-note { color: var(--pi-warning); font-size: 11px; }
    @container (max-width: 580px) {
      .card { --ask-end: 12px; }
      /* The note takes the bar's first line; Keep context open and the buttons share the second. */
      .form-footer > .note-column { flex-basis: 100%; }
      .keep-context { margin-inline-end: auto; }
      .partial-confirmation { flex: 1 1 100%; align-items: stretch; flex-direction: column; }
      .confirmation-actions { justify-content: flex-end; }
      .primary-action, .approve, .confirmation-actions > button { min-height: 42px; }
      .attach-image, .answer-image-remove { min-height: 42px; width: 42px; }
    }
    /* Embedded in the question drawer: no frame of its own, one header line, composer-dense type. */
    :host([flat]) { margin: 0; font-size: 13px; }
    :host([flat]) .card { --ask-x: 32px; --ask-end: 12px; border: 0; border-radius: 0; background: transparent; }
    :host([flat]) .card-header { justify-content: flex-start; gap: 6px; min-height: 32px; padding: 0 4px 0 12px; border-bottom: 1px solid var(--pi-border-muted); border-radius: 0; box-shadow: none; }
    :host([flat]) h2 { color: var(--pi-muted); font-weight: 600; text-transform: none; white-space: nowrap; }
    :host([flat]) .ask-meta { flex: 0 1 auto; gap: 6px; font-size: 12px; }
    :host([flat]) .header-status { flex: 1 1 auto; font-size: 12px; text-align: start; }
    :host([flat]) .ask-meta::before, :host([flat]) .header-status::before { content: "·" / ""; margin-inline-end: 6px; }
    :host([flat]) .question-detail { font-size: 12px; }
    /* The drawer scrolls the questions under their actions, which stay in view. */
    :host([flat]) .form-footer { position: sticky; bottom: 0; z-index: 6; background: var(--pi-surface); }
    @media (prefers-reduced-motion: reduce) { .edit-option, .switch-track, .switch-track::after { transition: none; } }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ask-user-card": AskUserCard;
  }
}
