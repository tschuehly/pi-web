import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { PendingAskUser } from "../../../shared/apiTypes";
import type { SessionStatus } from "../api";
import type { AskUserCard, AskUserSubmitCallback } from "./AskUserCard";
import "./AskUserCard";
import "./DelegateRoster";
import { answeredCount, loadAskDraft } from "../askDrafts";
import { workspaceContextChanged, type MarkdownWorkspaceContext } from "../formatting/workspaceLinks";

// Lucide "message-circle-question" and "chevron-down" (https://lucide.dev, ISC).
const QUESTION_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`;
const CHEVRON_DOWN_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>`;

/** Open questions across a Chat's sets; a Chat tab shows this count. */
export const openQuestionCount = (asks: readonly PendingAskUser[] | undefined): number => (asks ?? []).reduce((sum, ask) => sum + ask.questions.length, 0);

/**
 * The row above a Chat's composer: its Activity roster and, beside the roster's header, one bar for the open questions
 * ("3 open questions · 1 answered", over every open set). Hosting the roster lets the bar share its header line while
 * the roster's entries span the row below and the drawer opens above it. The bar opens a drawer with every set's form,
 * oldest first, each its context above its questions; while open (announced by `question-drawer-toggle`) the Chat gives
 * the drawer the transcript's whole area. Sent questions and answered sets drop out because the daemon stops reporting
 * them, leaving their record in the transcript.
 */
@customElement("workbench-question-chips")
export class WorkbenchQuestionChips extends LitElement {
  @property({ attribute: false }) asks: PendingAskUser[] = [];
  /** Machine-scoped session key the ask drafts are stored under. */
  @property({ attribute: false }) draftSessionId = "";
  @property({ attribute: false }) onSubmit?: AskUserSubmitCallback;
  @property({ attribute: false, hasChanged: workspaceContextChanged }) workspaceContext: MarkdownWorkspaceContext | undefined;
  /** Forwarded to the Activity roster. */
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Boolean }) rosterCollapsed = true;
  @property({ type: Boolean }) rosterCompact = false;
  @property({ attribute: false }) onToggleRoster?: () => void;
  /** Reflected so the Chat can hand the drawer the transcript's area. */
  @property({ type: Boolean, reflect: true }) open = false;

  protected override willUpdate(): void {
    if (this.asks.length === 0) this.open = false;
  }

  protected override updated(changed: PropertyValues<this>): void {
    // The Chat lays out on this event, not on `:has([open])`: WebKit never restyles `:has(...)::part(...)` when the attribute flips.
    if (changed.has("open")) this.dispatchEvent(new CustomEvent<boolean>("question-drawer-toggle", { bubbles: true, detail: this.open }));
  }

  override render() {
    const questions = this.asks.length === 0 ? undefined : this.renderQuestions();
    // One template, so the roster element stays mounted as questions come and go.
    return html`
      ${questions?.drawer ?? nothing}
      <delegate-roster ?compact=${this.rosterCompact} .status=${this.status} .collapsed=${this.rosterCollapsed} .onToggleCollapsed=${this.onToggleRoster}>${questions?.bar ?? nothing}</delegate-roster>
    `;
  }

  private renderQuestions(): { drawer: TemplateResult | typeof nothing; bar: TemplateResult } {
    const count = openQuestionCount(this.asks);
    const title = `${String(count)} open ${count === 1 ? "question" : "questions"}`;
    // Drafts live in the browser, so the count is read back from them; cards announce edits with ask-draft-change.
    const answered = this.asks.reduce((sum, ask) => sum + answeredCount(ask.questions, loadAskDraft(this.draftSessionId, ask.askId, undefined, ask.questions)), 0);
    const closeButton = html`<button type="button" class="close" slot="actions" title="Close questions (Esc)" aria-label="Close questions" @click=${() => { this.close(); }}>${CHEVRON_DOWN_ICON}</button>`;
    // One set lends its header line the drawer's title and close button; several keep a drawer header above them.
    const single = this.asks.length === 1;
    return {
      drawer: !this.open ? nothing : html`
        <section id="question-drawer" class="drawer" aria-label="Open questions" @keydown=${this.onKeydown} @ask-draft-change=${() => { this.requestUpdate(); }}>
          ${single ? nothing : html`<header><span>${title}</span>${closeButton}</header>`}
          <div class="sets">
            ${repeat(this.asks, (ask) => ask.askId, (ask) => html`<ask-user-card flat data-ask=${ask.askId} .ask=${ask} .draftSessionId=${this.draftSessionId} .workspaceContext=${this.workspaceContext} .onSubmit=${this.onSubmit}>${single ? html`<span slot="title">${title}</span>${closeButton}` : nothing}</ask-user-card>`)}
          </div>
        </section>`,
      bar: html`<button type="button" class="bar" slot="aside" aria-expanded=${String(this.open)} aria-controls="question-drawer" @keydown=${this.onKeydown}
        @click=${() => { if (this.open) this.close(); else void this.openQuestion(this.asks[0]?.askId ?? "", 0); }}>${QUESTION_ICON}<span><span class="title">${title}</span>${answered === 0 ? nothing : html`<span class="answered"> · ${String(answered)} answered</span>`}</span></button>`,
    };
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.open) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  /** Opens the drawer at one question (the bar opens it at the first); false when no open set asks it. */
  async openQuestion(askId: string, questionIndex: number): Promise<boolean> {
    if (this.asks.find((ask) => ask.askId === askId)?.questions[questionIndex] === undefined) return false;
    this.open = true;
    await this.updateComplete;
    const card = this.renderRoot.querySelector<AskUserCard>(`ask-user-card[data-ask="${CSS.escape(askId)}"]`);
    await card?.updateComplete;
    card?.focusQuestion(questionIndex);
    return true;
  }

  private close(): void {
    this.open = false;
    void this.updateComplete.then(() => { this.renderRoot.querySelector<HTMLElement>(".bar")?.focus(); });
  }

  static override styles = css`
    /* Open, the host fills the room the hidden transcript gives up; the drawer scrolls its forms, so the row and composer stay whole. */
    :host { display: flex; flex: 0 0 auto; flex-direction: column; min-width: 0; min-height: 0; }
    :host([open]) { flex: 1 1 0; }
    svg { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    /* Sized like the roster's Activity toggle beside it, on the row's own background. */
    .bar { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 24px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--pi-text); font: inherit; text-align: left; cursor: pointer; }
    .bar svg { color: var(--pi-warning); }
    .bar > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title { font-weight: 650; }
    .answered { color: var(--pi-muted); font-size: 11px; }
    .bar:hover, .bar[aria-expanded="true"] { background: var(--pi-surface-hover); }
    .bar:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .close:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    /* Fills the transcript's area above the Activity and questions row, flush with the Chat's edges. */
    .drawer { flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; overflow: hidden; background: var(--pi-surface); animation: rise .22s cubic-bezier(.16, 1, .3, 1); }
    header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--pi-border-muted); color: var(--pi-muted); font: 12px system-ui, sans-serif; }
    .close { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); cursor: pointer; }
    .close:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .close svg { width: 16px; height: 16px; }
    /* Keeps a focused field clear of the sticky Send bar. */
    .sets { min-height: 0; overflow: auto; scroll-padding-bottom: 64px; }
    ask-user-card + ask-user-card { border-top: 1px solid var(--pi-border); }
    @keyframes rise { from { opacity: 0; transform: translateY(12px); } }
    @media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "workbench-question-chips": WorkbenchQuestionChips;
  }
}
