import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { renderBuiltinTabIcon } from "./tabIcons";

/**
 * A burger button disclosing its slotted items below it. A click on an item closes it unless the item is marked
 * `data-keep-open`; Escape and a click outside close it too. Escape and an item hand focus back to the button.
 */
@customElement("workbench-menu-button")
export class WorkbenchMenuButton extends LitElement {
  @property() label = "Menu";
  @state() private open = false;

  private readonly onDocumentClick = (event: MouseEvent): void => {
    if (!event.composedPath().includes(this)) this.close(false);
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close(true);
  };

  override focus(options?: FocusOptions): void {
    this.renderRoot.querySelector("button")?.focus(options);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.close(false);
  }

  private toggle(): void {
    if (this.open) { this.close(false); return; }
    this.open = true;
    document.addEventListener("click", this.onDocumentClick);
    document.addEventListener("keydown", this.onDocumentKeyDown);
  }

  private close(refocus: boolean): void {
    if (!this.open) return;
    this.open = false;
    document.removeEventListener("click", this.onDocumentClick);
    document.removeEventListener("keydown", this.onDocumentKeyDown);
    if (refocus) this.focus();
  }

  /** Captured on the host, so the menu has closed and refocused its button before the item acts and perhaps moves focus on. */
  private readonly onItemClick = (event: MouseEvent): void => {
    const item = event.composedPath().find((target): target is HTMLElement => target instanceof HTMLElement && target.matches("button, a"));
    if (item !== undefined && this.contains(item) && item.dataset["keepOpen"] === undefined) this.close(true);
  };

  constructor() {
    super();
    this.addEventListener("click", this.onItemClick, { capture: true });
  }

  override render() {
    return html`
      <button type="button" class="trigger" title=${this.label} aria-label=${this.label} aria-expanded=${String(this.open)} aria-controls="menu" @click=${() => { this.toggle(); }}>${renderBuiltinTabIcon("menu")}</button>
      <div id="menu" class="menu" role="group" aria-label=${this.label} ?hidden=${!this.open}><slot></slot></div>
    `;
  }

  static override styles = css`
    :host { position: relative; display: inline-flex; flex: 0 0 auto; }
    .trigger { box-sizing: border-box; display: grid; place-items: center; width: var(--workbench-menu-button-size, 26px); height: var(--workbench-menu-button-size, 26px); padding: 0; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); cursor: pointer; }
    .trigger:hover, .trigger[aria-expanded="true"] { background: var(--pi-surface-hover); color: var(--pi-text); }
    .trigger:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 30; min-width: 200px; display: grid; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 10px 30px var(--pi-shadow); }
    .menu[hidden] { display: none; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "workbench-menu-button": WorkbenchMenuButton;
  }
}
