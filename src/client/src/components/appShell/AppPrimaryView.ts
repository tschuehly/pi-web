import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { PrimaryViewContext, QualifiedPrimaryViewContribution } from "../../plugins/types";

@customElement("app-primary-view")
export class AppPrimaryView extends LitElement {
  @property({ attribute: false }) contribution?: QualifiedPrimaryViewContribution;
  @property({ attribute: false }) context?: PrimaryViewContext;
  @property({ attribute: false }) onReturnToConversation?: () => void;
  @query(".surface") private surface?: HTMLElement;

  async focusSurface(): Promise<void> {
    await this.updateComplete;
    this.surface?.focus();
  }

  override render() {
    const contribution = this.contribution;
    const context = this.context;
    if (contribution === undefined || context === undefined) {
      return this.renderFailure("This view is unavailable.", "Its plugin may be disabled or still reconnecting.");
    }

    try {
      return html`
        <section class="surface" tabindex="-1" aria-label=${contribution.ariaLabel ?? contribution.title}>
          ${contribution.render(context)}
        </section>
      `;
    } catch (error) {
      console.warn(`Failed to render primary view ${contribution.id}`, error);
      return this.renderFailure("This view could not be rendered.", error instanceof Error ? error.message : String(error));
    }
  }

  private renderFailure(title: string, detail: string) {
    return html`
      <section class="surface failure" tabindex="-1" aria-label="Primary view unavailable">
        <h1>${title}</h1>
        <p>${detail}</p>
        <button type="button" @click=${() => { this.onReturnToConversation?.(); }}>Return to conversation</button>
      </section>
    `;
  }

  static override styles = css`
    :host { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; overflow: hidden; background: var(--pi-bg); }
    .surface { box-sizing: border-box; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; overflow: auto; outline: none; }
    .surface:focus-visible { box-shadow: inset 0 0 0 2px var(--pi-accent); }
    .failure { width: min(100%, 560px); margin: auto; align-self: center; flex: 0 1 auto; display: grid; gap: 10px; padding: var(--pi-panel-padding); color: var(--pi-muted); text-align: center; }
    h1 { margin: 0; color: var(--pi-text); font-size: 18px; }
    p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
    button { justify-self: center; min-height: var(--pi-control-min-size); border: 0; border-radius: 6px; background: var(--pi-selection-bg); color: var(--pi-text); padding: var(--pi-control-padding-block) var(--pi-control-padding-inline); cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    @media (pointer: coarse) { button { min-height: 44px; } }
  `;
}
