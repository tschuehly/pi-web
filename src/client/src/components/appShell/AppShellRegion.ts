import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { QualifiedShellRegionItem, ShellRegionActionDescriptor, ShellRegionLocation } from "../../plugins/types";

const CONTEXTUAL_ACTION_LIMIT = 3;

@customElement("app-shell-region")
export class AppShellRegion extends LitElement {
  @property({ reflect: true }) location: ShellRegionLocation = "status";
  @property({ attribute: false }) items: readonly QualifiedShellRegionItem[] = [];
  @query("details.overflow") private overflow?: HTMLDetailsElement;
  @query("details.overflow > summary") private overflowTrigger?: HTMLElement;
  @state() private actionError = "";

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleOutsidePointerDown);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("pointerdown", this.handleOutsidePointerDown);
    super.disconnectedCallback();
  }

  override render(): TemplateResult | typeof nothing {
    if (this.items.length === 0 && this.actionError === "") return nothing;
    const directItems = this.location === "contextual-actions" ? this.items.slice(0, CONTEXTUAL_ACTION_LIMIT) : this.items;
    const overflowItems = this.location === "contextual-actions" ? this.items.slice(CONTEXTUAL_ACTION_LIMIT) : [];
    return html`
      <section class="region" aria-label=${regionLabel(this.location)} @keydown=${this.handleKeyDown}>
        <div class="items">${directItems.map((item) => this.renderItem(item))}</div>
        ${overflowItems.length === 0 ? nothing : html`
          <details class="overflow">
            <summary>More</summary>
            <div class="overflow-menu">${overflowItems.map((item) => this.renderItem(item))}</div>
          </details>
        `}
        ${this.actionError === "" ? nothing : html`<span class="action-error" role="alert">${this.actionError}</span>`}
      </section>
    `;
  }

  private renderItem(item: QualifiedShellRegionItem): TemplateResult {
    if (item.type === "text") {
      return html`
        <span class=${`item text ${item.tone ?? "default"}`} title=${item.title ?? nothing}>
          <span class="label">${item.label}</span>
          ${item.value === undefined ? nothing : html`<span class="value">${item.value}</span>`}
        </span>
      `;
    }
    return html`
      <button
        type="button"
        class=${`item action ${item.tone ?? "default"}`}
        title=${item.title ?? nothing}
        aria-pressed=${item.active === undefined ? nothing : String(item.active)}
        aria-disabled=${item.disabled === true ? "true" : "false"}
        aria-describedby=${item.disabled === true && item.disabledReason !== undefined ? disabledReasonId(item) : nothing}
        @click=${() => { if (item.disabled !== true) this.invoke(item); }}
      >
        <span>${item.label}</span>
        ${item.badge === undefined || item.badge === "" ? nothing : html`<span class="badge">${item.badge}</span>`}
        ${item.disabled === true && item.disabledReason !== undefined ? html`<span class="visually-hidden" id=${disabledReasonId(item)}>${item.disabledReason}</span>` : nothing}
      </button>
    `;
  }

  private invoke(item: QualifiedShellRegionItem & ShellRegionActionDescriptor): void {
    this.closeOverflow(false);
    this.actionError = "";
    void Promise.resolve()
      .then(() => item.invoke())
      .catch((error: unknown) => {
        console.warn(`Failed to invoke shell region action ${item.id}`, error);
        this.actionError = `${item.label} is unavailable: ${errorMessage(error)}`;
      });
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.overflow?.open !== true) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeOverflow(true);
  };

  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    if (this.overflow?.open !== true || event.composedPath().includes(this)) return;
    this.closeOverflow(false);
  };

  private closeOverflow(returnFocus: boolean): void {
    if (this.overflow instanceof HTMLDetailsElement) this.overflow.open = false;
    if (returnFocus) requestAnimationFrame(() => { this.overflowTrigger?.focus(); });
  }

  static override styles = css`
    :host { min-width: 0; flex: 0 0 auto; display: block; color: var(--pi-text); background: var(--pi-surface); }
    .region { min-width: 0; display: flex; align-items: center; gap: var(--pi-toolbar-gap); padding: var(--pi-control-padding-block) var(--pi-panel-padding); border-bottom: 1px solid var(--pi-border-muted); }
    .items { min-width: 0; display: flex; align-items: center; gap: var(--pi-toolbar-gap); overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
    .item { box-sizing: border-box; flex: 0 0 auto; min-height: var(--pi-control-min-size); display: inline-flex; align-items: center; gap: 5px; border-radius: 6px; padding: var(--pi-control-padding-block) var(--pi-control-padding-inline); white-space: nowrap; }
    .text { background: transparent; }
    .text .label, .muted { color: var(--pi-muted); }
    .text .value { color: var(--pi-text); font-weight: 650; }
    button { border: 0; background: var(--pi-bg); color: var(--pi-text); font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    button[aria-pressed="true"] { background: var(--pi-selection-bg); color: var(--pi-text-bright); }
    button[aria-disabled="true"] { cursor: not-allowed; opacity: .58; }
    button:focus-visible, summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
    .accent { color: var(--pi-accent); }
    .success { color: var(--pi-success); }
    .warning { color: var(--pi-warning); }
    .danger { color: var(--pi-danger); }
    .badge { min-width: 14px; border-radius: 999px; background: var(--pi-selection-bg); padding: 0 5px; color: var(--pi-accent); font-size: 11px; line-height: 16px; text-align: center; }
    .overflow { position: relative; flex: 0 0 auto; }
    summary { min-height: var(--pi-control-min-size); display: inline-flex; align-items: center; border-radius: 6px; background: var(--pi-bg); padding: var(--pi-control-padding-block) var(--pi-control-padding-inline); cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    .overflow-menu { position: absolute; z-index: 70; inset: calc(100% + 5px) 0 auto auto; width: max-content; max-width: min(320px, calc(100vw - 24px)); display: grid; gap: 3px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-bg); padding: 6px; box-shadow: 0 12px 28px var(--pi-shadow-strong); }
    .overflow-menu .item { width: 100%; justify-content: space-between; }
    .action-error { min-width: 0; color: var(--pi-danger); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    :host([location="status"]) .region { border-top: 1px solid var(--pi-border-muted); border-bottom: 0; }
    :host([location="contextual-actions"]) { background: transparent; }
    :host([location="contextual-actions"]) .region { border: 0; background: transparent; padding: 0; }
    @media (pointer: coarse) { .item, summary { min-height: 44px; } }
  `;
}

function regionLabel(location: ShellRegionLocation): string {
  switch (location) {
    case "context-bar": return "Profile context";
    case "status": return "Profile status";
    case "surface-strip": return "Profile surfaces";
    case "contextual-actions": return "Profile actions";
  }
}

function disabledReasonId(item: QualifiedShellRegionItem): string {
  return `shell-region-disabled-${item.id.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

declare global {
  interface HTMLElementTagNameMap {
    "app-shell-region": AppShellRegion;
  }
}
