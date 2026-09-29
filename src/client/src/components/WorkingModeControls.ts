import { LitElement, css, html, svg, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { parseWorkingModeSnapshot, WORKING_MODE_AXES, WORKING_MODE_AXIS_NAMES, WORKING_MODE_STATUS_KEY, type WorkingModeAxis } from "../extensionStatusSnapshots";

const LABELS: Record<WorkingModeAxis, string> = { alignment: "Alignment", attention: "Attention", checking: "Checking", orchestration: "Orchestration" };

// Stroke icons in the promptEditorIcons.ts convention (24x24, currentColor, round caps).
const ICONS: Record<WorkingModeAxis, TemplateResult> = {
  alignment: svg`<circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="4"></circle><circle cx="12" cy="12" r=".5"></circle>`,
  attention: svg`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"></path><circle cx="12" cy="12" r="3"></circle>`,
  checking: svg`<path d="M12 3 5 6v5c0 4.4 2.9 8 7 10 4.1-2 7-5.6 7-10V6Z"></path><path d="m9 12 2 2 4-4"></path>`,
  orchestration: svg`<circle cx="5" cy="12" r="2"></circle><circle cx="19" cy="5" r="2"></circle><circle cx="19" cy="12" r="2"></circle><circle cx="19" cy="19" r="2"></circle><path d="M7 12h10M7 11l10-5M7 13l10 5"></path>`,
};

/**
 * One icon per Working Mode axis. An axis at its default (the first value) shows only its
 * icon; any other value is also written out, so a changed mode is visible at a glance.
 * A wide composer expands every axis to "icon Name · Value"; a narrow one shows icons only.
 * The native select stays on top (transparent) and owns keyboard, picker, and accessibility.
 */
@customElement("working-mode-controls")
export class WorkingModeControls extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) onRunCommand?: (command: string) => void | Promise<void>;

  private get selected() {
    return parseWorkingModeSnapshot(this.status?.extensionStatuses?.[WORKING_MODE_STATUS_KEY])?.selected;
  }

  override render() {
    const selected = this.selected;
    return html`
      <section aria-label="Working Mode">
        ${WORKING_MODE_AXIS_NAMES.map((axis) => {
          const value = selected?.[axis];
          const changed = value !== undefined && value !== WORKING_MODE_AXES[axis][0];
          return html`
            <label class=${changed ? "changed" : ""} title=${`${LABELS[axis]}: ${value ?? "unavailable"}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[axis]}</svg>
              <span class="name" aria-hidden="true">${LABELS[axis]}</span>
              <span class="value" aria-hidden="true">${value ?? "\u2013"}</span>
              <select name=${axis} aria-label=${LABELS[axis]} ?disabled=${selected === undefined} @change=${(event: Event) => { this.change(axis, event); }}>
                ${selected === undefined ? html`<option value="">${LABELS[axis]}: –</option>` : null}
                ${WORKING_MODE_AXES[axis].map((option) => html`<option value=${option}>${LABELS[axis]}: ${option}</option>`)}
              </select>
            </label>
          `;
        })}
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
    :host { display: block; flex: 0 1 auto; min-width: 0; }
    section { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
    label { position: relative; display: inline-flex; align-items: center; gap: 4px; height: var(--composer-control-size, 24px); min-width: var(--composer-control-size, 24px); justify-content: center; padding: 0 4px; box-sizing: border-box; border-radius: 6px; color: var(--pi-muted); font: 12px system-ui, sans-serif; white-space: nowrap; }
    label:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    label.changed { color: var(--pi-text); }
    label.changed svg { color: var(--pi-accent); }
    label:has(select:disabled) { opacity: .5; }
    label:has(select:disabled):hover { background: transparent; color: var(--pi-muted); }
    label:has(select:focus-visible) { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    svg { width: 16px; height: 16px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    select { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; font: inherit; cursor: pointer; }
    select:disabled { cursor: default; }
    .name { display: none; color: var(--pi-muted); }
    .name::after { content: "·"; margin-left: 4px; color: var(--pi-dim); }
    label:not(.changed) > .value { display: none; }
    /* Wide composer: room for every axis name and value beside model, usage, and actions on one row. */
    @container composer (min-width: 1240px) {
      label > .name, label:not(.changed) > .value { display: inline; }
    }
    /* Narrow composer: changed axes keep only their accent icon; the value stays in the tooltip and select. */
    @container composer (max-width: 560px) {
      label > span { display: none; }
    }
    @media (forced-colors: active) {
      label:has(select:focus-visible) { outline-color: Highlight; }
    }
  `;
}
