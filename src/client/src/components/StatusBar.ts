import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { renderSessionWarningIcon, statusBarStyles } from "./shared";
import { sessionStatusPresentation, sessionWarningControlContent } from "./sessionStatusPresentation";

export { sessionWarningControlContent as statusBarWarningControlContent } from "./sessionStatusPresentation";

@customElement("status-bar")
export class StatusBar extends LitElement {
  @property({ attribute: false }) status: SessionStatus | null | undefined = undefined;
  @property({ type: Number }) warningCount = 0;
  @property({ type: Boolean }) warningsExpanded = false;
  @property({ attribute: false }) onToggleWarnings?: () => void;

  private readonly handleToggleWarnings = (): void => {
    this.onToggleWarnings?.();
  };

  override render() {
    const status = this.status;
    if (status == null) return html`<div class="bar muted" role="status">No session status yet</div>`;
    const presentation = sessionStatusPresentation(status);
    const warningControl = sessionWarningControlContent(this.warningCount, this.warningsExpanded);
    return html`
      <div class="bar">
        ${warningControl === undefined || this.onToggleWarnings === undefined ? null : html`
          <button
            type="button"
            class="warning-toggle"
            title=${warningControl.accessibleLabel}
            aria-label=${warningControl.accessibleLabel}
            aria-expanded=${String(this.warningsExpanded)}
            @click=${this.handleToggleWarnings}
          >
            ${renderSessionWarningIcon("warning", "warning-toggle-icon")}
            <span>${warningControl.countText}</span>
          </button>
        `}
        <span>${presentation.inputText}</span>
        <span>${presentation.outputText}</span>
        <span
          class=${presentation.contextHighUsage ? "context high-usage" : "context"}
          title=${presentation.contextAccessibleLabel}
          aria-label=${presentation.contextAccessibleLabel}
        >${presentation.contextStatusText}</span>
        <span>${presentation.costText}</span>
        ${presentation.queuedText === undefined ? null : html`<span>${presentation.queuedText}</span>`}
      </div>
    `;
  }

  static override styles = statusBarStyles;
}
