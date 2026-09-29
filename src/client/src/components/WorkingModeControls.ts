import { LitElement, css, html, svg, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { parseWorkingModeSnapshot, WORKING_MODE_AXES, WORKING_MODE_AXIS_NAMES, WORKING_MODE_STATUS_KEY, type WorkingModeAxis } from "../extensionStatusSnapshots";

const LABELS: Record<WorkingModeAxis, string> = { alignment: "Alignment", attention: "Attention", checking: "Checking", orchestration: "Orchestration" };

// Lucide icons (https://lucide.dev, ISC), path data copied from lucide-static 1.48.0; one per value.
const ICONS: { [A in WorkingModeAxis]: Record<typeof WORKING_MODE_AXES[A][number], TemplateResult> } = {
  alignment: {
    Default: svg`<circle cx="12" cy="12" r="10"></circle><line x1="22" x2="18" y1="12" y2="12"></line><line x1="6" x2="2" y1="12" y2="12"></line><line x1="12" x2="12" y1="6" y2="2"></line><line x1="12" x2="12" y1="22" y2="18"></line>`, // crosshair
    Align: svg`<path d="m11 17 2 2a1 1 0 1 0 3-3"></path><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"></path><path d="m21 3 1 11h-2"></path><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"></path><path d="M3 4h8"></path>`, // handshake
    Plan: svg`<path d="M13 5h8"></path><path d="M13 12h8"></path><path d="M13 19h8"></path><path d="m3 17 2 2 4-4"></path><path d="m3 7 2 2 4-4"></path>`, // list-checks
    Spec: svg`<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path><path d="M14 2v5a1 1 0 0 0 1 1h5"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path>`, // file-text
  },
  attention: {
    Default: svg`<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle>`, // eye
    Focused: svg`<path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><circle cx="12" cy="12" r="1"></circle><path d="M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0"></path>`, // scan-eye
    Switching: svg`<path d="M8 3 4 7l4 4"></path><path d="M4 7h16"></path><path d="m16 21 4-4-4-4"></path><path d="M20 17H4"></path>`, // arrow-left-right
    Phone: svg`<rect width="14" height="20" x="5" y="2" rx="2" ry="2"></rect><path d="M12 18h.01"></path>`, // smartphone
    AFK: svg`<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"></path>`, // moon
  },
  checking: {
    Default: svg`<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path>`, // shield
    Exercise: svg`<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path>`, // play
    Test: svg`<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"></path><path d="M6.453 15h11.094"></path><path d="M8.5 2h7"></path>`, // flask-conical
    Challenge: svg`<path d="m13 19 6-6"></path><path d="M14.5 17.5 3.586 6.586A2 2 0 013 5.172V3h2.172a2 2 0 011.414.586L17.5 14.5"></path><path d="m14.828 6.172 2.586-2.586A2 2 0 0118.828 3H21v2.172a2 2 0 01-.586 1.414l-2.586 2.586"></path><path d="m16 16 4 4"></path><path d="m19 21 2-2"></path><path d="m5 14 4 4"></path><path d="m5 21-2-2"></path><path d="M7.5 16.5 4 20"></path>`, // swords
  },
  orchestration: {
    Main: svg`<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>`, // user
    Subagents: svg`<circle cx="12" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"></path><path d="M12 12v3"></path>`, // git-fork
    Workers: svg`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><path d="M16 3.128a4 4 0 0 1 0 7.744"></path><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><circle cx="9" cy="7" r="4"></circle>`, // users
  },
};

function icon(axis: WorkingModeAxis, value: string | undefined): TemplateResult {
  const icons: Record<string, TemplateResult> = ICONS[axis];
  return icons[value ?? ""] ?? icons[WORKING_MODE_AXES[axis][0]] ?? svg``;
}

/**
 * One icon per Working Mode value. An axis at its default (the first value) shows a muted icon;
 * any other value takes the axis colour and is also written out, so a changed mode is visible at a glance.
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
            <label class=${`${axis}${changed ? " changed" : ""}`} title=${`${LABELS[axis]}: ${value ?? "unavailable"}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon(axis, value)}</svg>
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
    /* Axis hues, not theme semantics: each clears 4.7:1 on every theme's composer background and hover. */
    .alignment { --axis-color: light-dark(#0a5cc2, #58a6ff); }
    .attention { --axis-color: light-dark(#7644d4, #bc8cff); }
    .checking { --axis-color: light-dark(#177232, #3fb950); }
    .orchestration { --axis-color: light-dark(#a94400, #f0883e); }
    label.changed { color: var(--axis-color); }
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
