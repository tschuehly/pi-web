import { LitElement, css, html } from "lit";
import { customElement, property, queryAll } from "lit/decorators.js";
import type { QualifiedContributionId, QualifiedNavigationEntryContribution } from "../../plugins/types";

@customElement("app-primary-navigation")
export class AppPrimaryNavigation extends LitElement {
  @property({ attribute: false }) entries: QualifiedNavigationEntryContribution[] = [];
  @property({ attribute: false }) selectedView: "navigation" | "chat" | QualifiedContributionId = "chat";
  @property({ attribute: false }) badgeFor: (entry: QualifiedNavigationEntryContribution) => unknown = () => undefined;
  @property({ attribute: false }) onSelect?: (view: "chat" | QualifiedContributionId) => void;
  @queryAll("button") private buttons!: NodeListOf<HTMLButtonElement>;

  async focusSelected(): Promise<boolean> {
    await this.updateComplete;
    const selected = [...this.buttons].find((button) => button.getAttribute("aria-current") === "page") ?? this.buttons[0];
    selected?.focus();
    return selected !== undefined;
  }

  override render() {
    return html`
      <nav aria-label="Primary views">
        <span class="heading">Views</span>
        <button aria-current=${this.selectedView === "chat" ? "page" : "false"} @click=${() => { this.onSelect?.("chat"); }}>
          <span class="mark" aria-hidden="true">●</span>
          <span>Conversation</span>
        </button>
        ${this.entries.map((entry) => {
          const selected = this.selectedView === entry.primaryView;
          const badge = this.safeBadge(entry);
          return html`
            <button aria-current=${selected ? "page" : "false"} @click=${() => { this.onSelect?.(entry.primaryView); }}>
              <span class="mark" aria-hidden="true">${entry.icon ?? "◆"}</span>
              <span class="label">${entry.title}</span>
              ${badge === undefined || badge === "" ? null : html`<span class="badge">${badge}</span>`}
            </button>
          `;
        })}
      </nav>
    `;
  }

  private safeBadge(entry: QualifiedNavigationEntryContribution): unknown {
    try {
      return this.badgeFor(entry);
    } catch (error) {
      console.warn(`Failed to render navigation badge ${entry.id}`, error);
      return undefined;
    }
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; min-height: 0; }
    nav { display: grid; gap: 2px; padding: var(--pi-list-row-padding-block) var(--pi-panel-padding); border-bottom: 1px solid var(--pi-border-muted); }
    .heading { padding: 2px var(--pi-list-row-padding-inline); color: var(--pi-muted); font-size: 11px; font-weight: 650; }
    button { min-width: 0; min-height: var(--pi-control-min-size); display: flex; align-items: center; gap: 8px; border: 0; border-radius: 6px; background: transparent; color: var(--pi-text); padding: var(--pi-list-row-padding-block) var(--pi-list-row-padding-inline); font: inherit; text-align: left; cursor: pointer; }
    button:hover { background: var(--pi-surface-hover); }
    button[aria-current="page"] { background: var(--pi-selection-bg); color: var(--pi-text-bright); }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .mark { flex: 0 0 auto; width: 18px; height: 18px; display: inline-grid; place-items: center; color: var(--pi-muted); font-size: 9px; }
    .mark svg { width: 18px; height: 18px; }
    button[aria-current="page"] .mark { color: var(--pi-accent); }
    .label { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { flex: 0 0 auto; min-width: 14px; border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 0 5px; font-size: 11px; line-height: 16px; text-align: center; }
    @media (pointer: coarse) { button { min-height: 44px; } }
  `;
}
