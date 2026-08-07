import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { Project } from "../../api";
import type { QualifiedContributionId, QualifiedNavigationEntryContribution } from "../../plugins/types";

@customElement("app-pi-menu")
export class AppPiMenu extends LitElement {
  @property({ attribute: false }) entries: QualifiedNavigationEntryContribution[] = [];
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selectedView: "navigation" | "chat" | QualifiedContributionId = "chat";
  @property({ attribute: false }) selectedProject?: Project;
  @property() connectionLabel = "Connected";
  @property({ attribute: false }) onSelectView?: (view: "chat" | QualifiedContributionId) => void | Promise<void>;
  @property({ attribute: false }) onSelectProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onShowProjects?: () => void | Promise<void>;
  @property({ attribute: false }) onShowActions?: () => void;
  @property({ attribute: false }) onConfigureAuth?: () => void | Promise<void>;
  @property({ attribute: false }) onOpenSettings?: () => void;
  @property({ attribute: false }) onRecover?: () => void | Promise<void>;
  @query("details") private details?: HTMLDetailsElement;
  @query("summary") private summary?: HTMLElement;
  @state() private menuOpen = false;

  override render() {
    return html`
      <details @toggle=${this.handleToggle} @keydown=${this.handleKeyDown}>
        <summary aria-label=${this.menuOpen ? "Close Pi menu" : "Open Pi menu"} aria-expanded=${String(this.menuOpen)} title="Pi menu"><span aria-hidden="true">π</span><span class="wordmark">PI</span></summary>
        <section class="menu" aria-label="Pi menu">
          <header><strong>PI WEB</strong><span class=${this.connectionLabel === "Connected" ? "connected" : "reconnecting"}>${this.connectionLabel}</span></header>
          <nav aria-label="Destinations">
            ${this.destination(this.selectedView === "chat" || this.selectedView === "navigation" ? "Conversation" : "Open default PI WEB shell", "chat")}
            ${this.entries.filter((entry) => entry.primaryView !== this.selectedView).map((entry) => this.destination(entry.title, entry.primaryView))}
          </nav>
          <div class="group" aria-label="Projects">
            <div class="group-heading"><span>Projects</span><button type="button" @click=${() => { this.invoke(this.onShowProjects); }}>All projects</button></div>
            ${this.projects.slice(0, 5).map((project) => html`
              <button type="button" class="project" aria-current=${this.selectedProject?.id === project.id ? "true" : "false"} @click=${() => { this.invoke(() => this.onSelectProject?.(project)); }}>${project.name}</button>
            `)}
            ${this.projects.length === 0 ? html`<p>No projects added</p>` : null}
          </div>
          <div class="utilities" aria-label="Utilities">
            <button type="button" @click=${() => { this.invoke(this.onShowActions); }}>Actions</button>
            <button type="button" @click=${() => { this.invoke(this.onConfigureAuth); }}>Authentication</button>
            <button type="button" @click=${() => { this.invoke(this.onRecover); }}>Recovery &amp; refresh</button>
            <button type="button" @click=${() => { this.invoke(this.onOpenSettings); }}>Settings</button>
          </div>
        </section>
      </details>
    `;
  }

  private destination(label: string, view: "chat" | QualifiedContributionId) {
    const current = this.selectedView === view;
    return html`<button type="button" aria-current=${current ? "page" : "false"} @click=${() => { this.invoke(() => this.onSelectView?.(view)); }}>${label}</button>`;
  }

  private readonly handleToggle = (event: Event): void => {
    const details = event.currentTarget;
    if (!(details instanceof HTMLDetailsElement)) return;
    this.menuOpen = details.open;
    this.toggleAttribute("open", details.open);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.details?.open !== true) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeMenu(true);
  };

  private closeMenu(returnFocus: boolean): void {
    if (this.details !== undefined) this.details.open = false;
    this.menuOpen = false;
    this.toggleAttribute("open", false);
    if (returnFocus) requestAnimationFrame(() => { this.summary?.focus(); });
  }

  private invoke(action: (() => void | Promise<void>) | undefined): void {
    this.closeMenu(false);
    void Promise.resolve(action?.()).finally(() => {
      requestAnimationFrame(() => { this.summary?.focus(); });
    });
  }

  static override styles = css`
    :host { position: relative; z-index: 80; display: block; color: var(--pi-text); font: 13px system-ui, sans-serif; }
    details { position: relative; }
    summary { box-sizing: border-box; min-width: 44px; min-height: 40px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 9px; background: var(--pi-surface); color: var(--pi-text-bright); padding: 6px 9px; cursor: pointer; font-weight: 760; list-style: none; box-shadow: 0 5px 18px var(--pi-shadow-soft); }
    summary::-webkit-details-marker { display: none; }
    summary > span:first-child { color: var(--pi-accent); font-size: 20px; line-height: 1; }
    summary:focus-visible, button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .menu { position: absolute; inset: calc(100% + 7px) auto auto 0; width: min(320px, calc(100vw - 24px)); max-height: min(680px, calc(100vh - 76px)); overflow: auto; display: grid; gap: 10px; border: 1px solid var(--pi-border); border-radius: 12px; background: var(--pi-bg); padding: 10px; box-shadow: 0 16px 42px var(--pi-shadow-strong); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 7px 8px; border-bottom: 1px solid var(--pi-border-muted); }
    header span { color: var(--pi-success); font-size: 11px; }
    header span.reconnecting { color: var(--pi-warning); }
    nav, .group, .utilities { display: grid; gap: 3px; }
    .group, .utilities { padding-top: 8px; border-top: 1px solid var(--pi-border-muted); }
    .group-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 7px; color: var(--pi-muted); font-size: 11px; font-weight: 700; }
    .group-heading button { min-height: 28px; width: auto; padding: 3px 6px; color: var(--pi-accent); }
    button { width: 100%; min-height: 36px; border: 0; border-radius: 7px; background: transparent; color: var(--pi-text); padding: 7px 9px; font: inherit; text-align: left; cursor: pointer; }
    button:hover { background: var(--pi-surface-hover); }
    button[aria-current="page"], button[aria-current="true"] { background: var(--pi-selection-bg); color: var(--pi-text-bright); font-weight: 650; }
    p { margin: 0; padding: 7px 9px; color: var(--pi-muted); }
    @media (max-width: 520px) { .wordmark { display: none; } .menu { position: fixed; inset: 58px 8px auto; width: auto; } }
    @media (pointer: coarse) { summary, button { min-height: 44px; } }
  `;
}

declare global {
  interface HTMLElementTagNameMap { "app-pi-menu": AppPiMenu }
}
