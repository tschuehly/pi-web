import { LitElement, css, html, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { PendingAskUser } from "../../../shared/apiTypes";
import type { AskUserSubmitCallback } from "./AskUserCard";
import "./AskUserCard";

// Lucide "message-circle-question" (https://lucide.dev, ISC).
export const QUESTIONS_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`;

/**
 * Side pane listing the selected Chat's open question sets, oldest first. It is
 * the only place their forms live; answered sets drop out because the daemon
 * stops reporting them, leaving their record in the transcript.
 */
@customElement("workbench-questions-pane")
export class WorkbenchQuestionsPane extends LitElement {
  @property({ attribute: false }) asks: PendingAskUser[] = [];
  /** Machine-scoped session key the ask drafts are stored under. */
  @property({ attribute: false }) draftSessionId = "";
  @property({ attribute: false }) onSubmit?: AskUserSubmitCallback;

  override render() {
    return html`
      <section aria-label="Open questions">
        <h2>Questions <small>${this.asks.length} open</small></h2>
        ${this.asks.length === 0
          ? html`<p class="empty">No open questions in this Chat.</p>`
          : repeat(this.asks, (ask) => ask.askId, (ask) => html`<ask-user-card .ask=${ask} .draftSessionId=${this.draftSessionId} .onSubmit=${this.onSubmit}></ask-user-card>`)}
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; min-width: 0; overflow: auto; border-left: 1px solid var(--pi-border); background: var(--pi-bg); }
    section { display: grid; gap: 12px; padding: 12px; }
    h2 { margin: 0; font-size: 13px; }
    small { color: var(--pi-muted); font-weight: 500; }
    .empty { margin: 0; color: var(--pi-muted); }
    ask-user-card { margin: 0; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "workbench-questions-pane": WorkbenchQuestionsPane;
  }
}
