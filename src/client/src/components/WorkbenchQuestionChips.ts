import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { PendingAskUser } from "../../../shared/apiTypes";
import type { AskUserCard, AskUserSubmitCallback } from "./AskUserCard";
import "./AskUserCard";

// Lucide "message-circle-question" and "chevron-down" (https://lucide.dev, ISC).
const QUESTION_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`;
const CHEVRON_DOWN_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>`;

/** Open questions across a Chat's sets; a Chat tab shows this count. */
export const openQuestionCount = (asks: readonly PendingAskUser[] | undefined): number => (asks ?? []).reduce((sum, ask) => sum + ask.questions.length, 0);

/**
 * The selected Chat's open questions as chips above its composer, one per question, oldest set first. A chip opens a
 * drawer rising from the composer with every set's form, its context beside its questions. Answered sets drop out
 * because the daemon stops reporting them, leaving their record in the transcript.
 */
@customElement("workbench-question-chips")
export class WorkbenchQuestionChips extends LitElement {
  @property({ attribute: false }) asks: PendingAskUser[] = [];
  /** Machine-scoped session key the ask drafts are stored under. */
  @property({ attribute: false }) draftSessionId = "";
  @property({ attribute: false }) onSubmit?: AskUserSubmitCallback;
  @state() private open = false;
  /** The chip that opened the drawer, refocused when it closes. */
  private opener: HTMLElement | undefined;

  protected override willUpdate(): void {
    if (this.asks.length === 0) this.open = false;
  }

  override render() {
    if (this.asks.length === 0) return nothing;
    const count = openQuestionCount(this.asks);
    return html`
      ${this.open ? html`
        <section id="question-drawer" class="drawer" aria-label="Open questions" @keydown=${this.onKeydown}>
          <header>
            <span>${count} open ${count === 1 ? "question" : "questions"}</span>
            <button type="button" class="close" title="Close questions (Esc)" aria-label="Close questions" @click=${() => { this.close(); }}>${CHEVRON_DOWN_ICON}</button>
          </header>
          <div class="sets">
            ${repeat(this.asks, (ask) => ask.askId, (ask) => html`<ask-user-card context-beside data-ask=${ask.askId} .ask=${ask} .draftSessionId=${this.draftSessionId} .onSubmit=${this.onSubmit}></ask-user-card>`)}
          </div>
        </section>` : nothing}
      <div class="chips" role="group" aria-label="Open questions" @keydown=${this.onKeydown}>
        ${this.asks.flatMap((ask) => ask.questions.map((question, index) => html`
          <button type="button" class="chip" title=${question.question} aria-expanded=${String(this.open)} aria-controls="question-drawer"
            @click=${(event: Event) => { void this.show(event.currentTarget, ask.askId, index); }}>${QUESTION_ICON}<span>${question.question}</span></button>`))}
      </div>
    `;
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.open) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  private async show(chip: EventTarget | null, askId: string, questionIndex: number): Promise<void> {
    if (chip instanceof HTMLElement) this.opener = chip;
    this.open = true;
    await this.updateComplete;
    const card = this.renderRoot.querySelector<AskUserCard>(`ask-user-card[data-ask="${CSS.escape(askId)}"]`);
    await card?.updateComplete;
    card?.focusQuestion(questionIndex);
  }

  private close(): void {
    this.open = false;
    const opener = this.opener;
    void this.updateComplete.then(() => { (opener?.isConnected === true ? opener : this.renderRoot.querySelector<HTMLElement>(".chip"))?.focus(); });
  }

  static override styles = css`
    :host { display: flex; flex: 0 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
    svg { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .chips { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 6px; padding: 6px var(--pi-panel-padding, 10px) 2px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: min(320px, 100%); height: 28px; padding: 0 11px 0 9px; border: 1px solid color-mix(in srgb, var(--pi-warning) 55%, transparent); border-radius: 999px; background: var(--pi-warning-surface); color: var(--pi-text); font: 12.5px system-ui, sans-serif; cursor: pointer; }
    .chip svg { color: var(--pi-warning); }
    .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip:hover, .chip[aria-expanded="true"] { border-color: var(--pi-warning); }
    .chip:focus-visible, .close:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    /* Rises from the composer: the transcript above gives up the room. */
    .drawer { flex: 0 1 auto; display: flex; flex-direction: column; min-height: 0; max-height: min(62vh, 640px); margin: 6px var(--pi-panel-padding, 10px) 0; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-surface); box-shadow: 0 -10px 30px var(--pi-shadow-soft); animation: rise .22s cubic-bezier(.16, 1, .3, 1); }
    header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--pi-border-muted); color: var(--pi-muted); font: 12px system-ui, sans-serif; }
    .close { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); cursor: pointer; }
    .close:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .close svg { width: 16px; height: 16px; }
    .sets { min-height: 0; overflow: auto; display: grid; gap: 10px; padding: 10px; }
    ask-user-card { margin: 0; }
    @keyframes rise { from { opacity: 0; transform: translateY(12px); } }
    @media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "workbench-question-chips": WorkbenchQuestionChips;
  }
}
