import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { parseWorkingModeSnapshot, WORKING_MODE_AXES, WORKING_MODE_AXIS_NAMES, WORKING_MODE_STATUS_KEY, type WorkingModeAxis } from "../extensionStatusSnapshots";

const LABELS: Record<WorkingModeAxis, string> = { alignment: "Alignment", attention: "Attention", checking: "Checking", orchestration: "Orchestration" };

@customElement("working-mode-controls")
export class WorkingModeControls extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ attribute: false }) onRunCommand?: (command: string) => void | Promise<void>;

  private get selected() {
    return parseWorkingModeSnapshot(this.status?.extensionStatuses?.[WORKING_MODE_STATUS_KEY])?.selected;
  }

  override render() {
    const selected = this.selected;
    return html`
      <section aria-label="Working Mode">
        ${WORKING_MODE_AXIS_NAMES.map((axis) => html`
          <label>
            <span>${LABELS[axis]}</span>
            <select name=${axis} aria-label=${LABELS[axis]} ?disabled=${selected === undefined} @change=${(event: Event) => { this.change(axis, event); }}>
              ${selected === undefined ? html`<option value="">${this.compact ? `${LABELS[axis]}: –` : "–"}</option>` : null}
              ${WORKING_MODE_AXES[axis].map((value) => html`<option value=${value}>${this.compact ? `${LABELS[axis]}: ${value}` : value}</option>`)}
            </select>
          </label>
        `)}
      </section>
    `;
  }

  // Always show the reported selection; a user's choice appears once the extension confirms it.
  override updated() {
    const selected = this.selected;
    for (const axis of WORKING_MODE_AXIS_NAMES) {
      const select = this.renderRoot.querySelector<HTMLSelectElement>(`select[name="${axis}"]`);
      if (select !== null) select.value = selected?.[axis] ?? "";
    }
  }

  private change(axis: WorkingModeAxis, event: Event): void {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    void this.onRunCommand?.(`/mode ${axis} ${event.currentTarget.value.toLowerCase()}`);
    this.requestUpdate();
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; padding: 5px 12px; border-top: 1px solid var(--pi-border-muted); background: var(--pi-surface); }
    :host([compact]) { flex: 0 1 auto; min-width: 0; max-width: 100%; padding: 0; border-top: 0; background: transparent; }
    :host([compact]) section { flex-wrap: wrap; gap: 4px; overflow: visible; }
    :host([compact]) label > span { display: none; }
    section { display: flex; align-items: center; gap: 12px; overflow-x: auto; }
    label { display: inline-flex; align-items: center; white-space: nowrap; }
    label > span { margin-right: 6px; color: var(--pi-muted); font-size: 11px; font-weight: 650; }
    select { min-height: 26px; padding: 2px 4px; border: 1px solid var(--pi-border); border-radius: 6px; background: transparent; color: var(--pi-text); font: 12px system-ui, sans-serif; cursor: pointer; }
    select:disabled { color: var(--pi-muted); cursor: default; }
    select:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    @media (max-width: 430px) {
      :host([compact]) section { flex-wrap: wrap; }
    }
  `;
}
