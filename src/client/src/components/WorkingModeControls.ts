import { LitElement, css, html, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { parseWorkingModeSnapshot, WORKING_MODE_AXES, WORKING_MODE_AXIS_NAMES, WORKING_MODE_STATUS_KEY, workingModePending, type WorkingModeAxis, type WorkingModeState } from "../extensionStatusSnapshots";

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

const PENDING_LABEL = "Working Mode change not sent yet";
const ALIGNED_LABEL = "Aligned: Thomas confirmed the agreement";

function icon(axis: WorkingModeAxis, value: string | undefined): TemplateResult {
  const icons: Record<string, TemplateResult> = ICONS[axis];
  return icons[value ?? ""] ?? icons[WORKING_MODE_AXES[axis][0]] ?? svg``;
}

/**
 * The composer shows one icon per Working Mode axis. An axis at its default (the first value) shows a
 * muted icon; any other value takes the axis colour and is also written out, so a changed mode is
 * visible at a glance. A narrow composer shows icons only.
 * The icon row is one trigger for a pane with every axis, so several modes can change in one visit:
 * each value applies immediately and the pane stays open until Esc, an outside click, or the trigger.
 * A selection the model has not received yet marks the trigger with a dot and enables Send (`/mode send`).
 * Once the agent records alignment (`alignment_reached`) under a non-default Alignment, an "Aligned" chip follows its icon.
 */
@customElement("working-mode-controls")
export class WorkingModeControls extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) onRunCommand?: (command: string) => void | Promise<void>;
  /** Selection of the latest Working Mode block in the loaded transcript; the baseline before the first turn. */
  @property({ attribute: false }) transcriptSelection?: WorkingModeState;
  @state() private open = false;

  private readonly closeOnOutsidePointer = (event: PointerEvent): void => {
    if (!event.composedPath().includes(this)) this.setOpen(false);
  };

  private get snapshot() {
    return parseWorkingModeSnapshot(this.status?.extensionStatuses?.[WORKING_MODE_STATUS_KEY]);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
    super.disconnectedCallback();
  }

  override render() {
    const snapshot = this.snapshot;
    const selected = snapshot?.selected;
    const pending = snapshot !== undefined && workingModePending(snapshot, this.transcriptSelection);
    const aligned = snapshot?.aligned === true && selected?.alignment !== WORKING_MODE_AXES.alignment[0];
    const summary = WORKING_MODE_AXIS_NAMES.map((axis) => `${LABELS[axis]}: ${selected?.[axis] ?? "unavailable"}${axis === "alignment" && aligned ? " (aligned)" : ""}`).join(", ") + (pending ? `. ${PENDING_LABEL}` : "");
    return html`
      <button class="trigger" type="button" title=${summary} aria-label=${`Working Mode — ${summary}`} aria-haspopup="dialog" aria-expanded=${this.open ? "true" : "false"} ?disabled=${selected === undefined} @click=${() => { this.setOpen(!this.open); }}>
        ${WORKING_MODE_AXIS_NAMES.map((axis) => {
          const value = selected?.[axis];
          const changed = value !== undefined && value !== WORKING_MODE_AXES[axis][0];
          return html`<span class=${`axis ${axis}${changed ? " changed" : ""}`} data-axis=${axis}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon(axis, value)}</svg>${changed ? html`<span class="value">${value}</span>` : null}</span>${axis === "alignment" && aligned
            // Lucide circle-check
            ? html`<span class="aligned-chip alignment" title=${ALIGNED_LABEL}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg><span class="value">Aligned</span></span>`
            : null}`;
        })}
        ${pending ? html`<span class="pending-dot" title=${PENDING_LABEL}></span>` : null}
      </button>
      ${this.open && selected !== undefined ? html`
        <div class="pane" role="dialog" aria-label="Working Mode" @keydown=${(event: KeyboardEvent) => { this.handlePaneKey(event); }} @focusout=${(event: FocusEvent) => { this.handleFocusOut(event); }}>
          ${WORKING_MODE_AXIS_NAMES.map((axis) => html`
            <span class="axis-name" id=${`axis-${axis}`}>${LABELS[axis]}</span>
            <div class=${`values ${axis}`} role="radiogroup" aria-labelledby=${`axis-${axis}`}>
              ${WORKING_MODE_AXES[axis].map((value: string) => {
                const checked = value === selected[axis];
                // The axis default (Default, or Main) is icon-only; its name stays in the accessible label and tooltip.
                const iconOnly = value === WORKING_MODE_AXES[axis][0];
                return html`<button class=${iconOnly ? "icon-only" : ""} type="button" role="radio" aria-checked=${checked ? "true" : "false"} tabindex=${checked ? "0" : "-1"} data-value=${value} aria-label=${iconOnly ? value : nothing} title=${iconOnly ? value : nothing} @click=${() => { this.choose(axis, value); }} @keydown=${(event: KeyboardEvent) => { this.handleRadioKey(event, axis); }}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon(axis, value)}</svg>${iconOnly ? null : value}</button>`;
              })}
            </div>
          `)}
          <div class="actions">
            <!-- Lucide send -->
            <button class="send" type="button" ?disabled=${!pending} title=${pending ? "Send the Working Mode change now" : "No Working Mode change to send"} @click=${() => { this.send(); }}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"></path><path d="m21.854 2.147-10.94 10.939"></path></svg>Send</button>
          </div>
        </div>
      ` : null}
    `;
  }

  private setOpen(open: boolean, restoreFocus = false): void {
    if (open === this.open) return;
    this.open = open;
    if (open) {
      document.addEventListener("pointerdown", this.closeOnOutsidePointer, true);
      void this.updateComplete.then(() => { this.renderRoot.querySelector<HTMLButtonElement>('.pane [aria-checked="true"]')?.focus(); });
    } else {
      document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
      if (restoreFocus) void this.updateComplete.then(() => { this.renderRoot.querySelector<HTMLButtonElement>(".trigger")?.focus(); });
    }
  }

  // The reported selection stays authoritative: a choice shows as checked once the extension confirms it.
  private choose(axis: WorkingModeAxis, value: string): void {
    void this.onRunCommand?.(`/mode ${axis} ${value.toLowerCase()}`);
  }

  /** Delivers the pending selection now: the extension steers a working agent or starts a turn when idle. */
  private send(): void {
    void this.onRunCommand?.("/mode send");
    this.setOpen(false, true);
  }

  private handlePaneKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.setOpen(false, true);
  }

  private handleFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && next !== this && !this.renderRoot.contains(next)) this.setOpen(false);
  }

  /** Radio group keys (WAI-ARIA APG): arrows move focus and select within the axis; Tab leaves the row. */
  private handleRadioKey(event: KeyboardEvent, axis: WorkingModeAxis): void {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const values: readonly string[] = WORKING_MODE_AXES[axis];
    const current = event.currentTarget instanceof HTMLElement ? values.indexOf(event.currentTarget.dataset["value"] ?? "") : -1;
    const target = event.key === "Home" ? 0 : event.key === "End" ? values.length - 1 : step === 0 ? -1 : (current + step + values.length) % values.length;
    const value = values[target];
    if (value === undefined) return;
    event.preventDefault();
    // Move the roving tab stop now so Tab leaves the row even before the extension confirms the choice.
    for (const radio of this.renderRoot.querySelectorAll<HTMLButtonElement>(`.values.${axis} [role="radio"]`)) radio.tabIndex = radio.dataset["value"] === value ? 0 : -1;
    this.renderRoot.querySelector<HTMLButtonElement>(`.values.${axis} [data-value="${value}"]`)?.focus();
    this.choose(axis, value);
  }

  static override styles = css`
    :host { display: flex; justify-content: flex-end; flex: 0 1 auto; min-width: 0; }
    /* Axis hues, not theme semantics: each clears 4.7:1 on every theme's composer background and hover. */
    .alignment { --axis-color: light-dark(#0a5cc2, #58a6ff); }
    .attention { --axis-color: light-dark(#7644d4, #bc8cff); }
    .checking { --axis-color: light-dark(#177232, #3fb950); }
    .orchestration { --axis-color: light-dark(#a94400, #f0883e); }
    button { font: 12px system-ui, sans-serif; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    svg { width: 16px; height: 16px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .trigger { position: relative; display: flex; align-items: center; justify-content: flex-end; gap: 2px; min-width: 0; margin: 0; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--pi-muted); }
    .trigger:disabled { opacity: .5; cursor: default; }
    .trigger[aria-expanded="true"] { background: var(--pi-surface-hover); }
    .axis { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: var(--composer-control-size, 24px); min-width: var(--composer-control-size, 24px); padding: 0 4px; box-sizing: border-box; border-radius: 6px; white-space: nowrap; }
    .trigger:hover:not(:disabled) .axis { color: var(--pi-text); }
    .trigger:hover:not(:disabled) .axis:hover { background: var(--pi-surface-hover); }
    .pending-dot { position: absolute; top: 0; right: 0; width: 7px; height: 7px; border-radius: 50%; background: var(--pi-accent); box-shadow: 0 0 0 2px var(--pi-surface); }
    .axis.changed, .trigger:hover:not(:disabled) .axis.changed { color: var(--axis-color); }
    .aligned-chip { display: inline-flex; align-items: center; gap: 3px; height: 18px; padding: 0 6px 0 4px; border: 1px solid var(--axis-color); border-radius: 9px; color: var(--axis-color); font-size: 11px; font-weight: 600; white-space: nowrap; }
    .aligned-chip svg { width: 12px; height: 12px; }
    /* Anchored to the composer footer (the nearest positioned ancestor), right-aligned above it. */
    .pane { position: absolute; z-index: 20; right: 10px; bottom: calc(100% + 4px); display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 6px 12px; box-sizing: border-box; max-width: calc(100% - 20px); padding: 10px 12px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); color: var(--pi-text); font: 12px system-ui, sans-serif; white-space: normal; }
    .axis-name { color: var(--pi-muted); }
    .actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; padding-top: 4px; border-top: 1px solid var(--pi-border); }
    .send { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 3px 10px; border: 1px solid var(--pi-accent); border-radius: 6px; background: var(--pi-accent); color: var(--pi-accent-contrast, #fff); font-weight: 600; }
    .send:disabled { border-color: var(--pi-border); background: transparent; color: var(--pi-muted); cursor: default; }
    .values { display: flex; flex-wrap: wrap; gap: 2px; }
    /* Every row's values fill the shared value column, so all rows span the widest row's width. */
    .values > button { flex: 1 1 auto; justify-content: center; display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 3px 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--pi-text); white-space: nowrap; }
    /* The icon-only default keeps its natural width; the named values share the slack. */
    .values > button.icon-only { flex: 0 0 auto; }
    .values > button svg { color: var(--axis-color); }
    .values > button:hover { background: var(--pi-surface-hover); }
    .values > button[aria-checked="true"] { border-color: var(--axis-color); background: color-mix(in srgb, var(--axis-color) 14%, transparent); font-weight: 600; }
    /* Narrow composer: changed axes keep only their accent icon, and the pane becomes a full-width sheet. */
    @container composer (max-width: 560px) {
      .axis > .value, .aligned-chip > .value { display: none; }
      .pane { right: 6px; left: 6px; max-width: none; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 8px; }
      .axis-name { margin-top: 4px; }
      .actions { margin-top: 4px; }
    }
    @media (pointer: coarse) {
      .values > button, .send { min-height: 34px; }
    }
    @media (forced-colors: active) {
      button:focus-visible { outline-color: Highlight; }
      .values > button[aria-checked="true"] { border-color: Highlight; }
      .pending-dot { forced-color-adjust: none; background: Highlight; }
    }
  `;
}
