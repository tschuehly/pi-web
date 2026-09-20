import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { ALIGNMENT_VALUES, CHECKING_VALUES, parseWorkingModeSnapshot, WORKING_MODE_STATUS_KEY } from "../extensionStatusSnapshots";

@customElement("working-mode-controls")
export class WorkingModeControls extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) onRunCommand?: (command: string) => void | Promise<void>;

  override render() {
    const selected = parseWorkingModeSnapshot(this.status?.extensionStatuses?.[WORKING_MODE_STATUS_KEY])?.selected;
    return html`
      <section aria-label="Working Mode">
        <div class="axis" role="group" aria-label="Alignment">
          <span>Alignment</span>
          ${ALIGNMENT_VALUES.map((value) => html`<button type="button" aria-pressed=${selected?.alignment === value ? "true" : "false"} @click=${() => { this.run(`/mode alignment ${value.toLowerCase()}`); }}>${value}</button>`)}
        </div>
        <div class="axis" role="group" aria-label="Checking">
          <span>Checking</span>
          ${CHECKING_VALUES.map((value) => html`<button type="button" aria-pressed=${selected?.checking === value ? "true" : "false"} @click=${() => { this.run(`/mode checking ${value}`); }}>${value}</button>`)}
        </div>
      </section>
    `;
  }

  private run(command: string): void {
    void this.onRunCommand?.(command);
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; padding: 5px 12px; border-top: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
    section { display: flex; align-items: center; gap: 12px; overflow-x: auto; }
    .axis { display: inline-flex; align-items: center; white-space: nowrap; }
    .axis > span { margin-right: 6px; color: var(--pi-muted); font-size: 11px; font-weight: 650; }
    button { min-height: 26px; padding: 3px 8px; border: 1px solid var(--pi-border); border-right-width: 0; border-radius: 0; background: transparent; color: var(--pi-muted); font: 12px system-ui, sans-serif; cursor: pointer; }
    button:first-of-type { border-radius: 6px 0 0 6px; }
    button:last-of-type { border-right-width: 1px; border-radius: 0 6px 6px 0; }
    button[aria-pressed="true"] { background: var(--pi-surface-hover); color: var(--pi-text); font-weight: 700; }
    button:focus-visible { position: relative; outline: 2px solid var(--pi-accent); outline-offset: -2px; }
  `;
}
