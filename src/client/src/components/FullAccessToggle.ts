import { LitElement, css, html, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionStatus } from "../api";

/** Published by Pi Workbench's Durable host where its write fence applies (macOS): "on" or "off". */
export const FULL_ACCESS_STATUS_KEY = "workbench.full-access";

const FENCED_LABEL = "Write fence on: this Chat's commands can change only its own folders. Click to allow full access.";
const FULL_LABEL = "Full access: this Chat's own commands run without the write fence (its Subagents stay fenced). Click to fence them again.";
const WAITING_LABEL = "Waiting for your answer in the macOS dialog";

// Lucide icons (https://lucide.dev, ISC), path data copied from lucide-static 1.48.0.
const SHIELD = svg`<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path>`; // shield
const SHIELD_OFF = svg`<path d="m2 2 20 20"></path><path d="M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67.01c2.35-.82 4.48-1.97 5.9-3.71"></path><path d="M9.309 3.652A12.252 12.252 0 0 0 11.24 2.28a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1v7a9.784 9.784 0 0 1-.08 1.264"></path>`; // shield-off

/**
 * The composer's write-fence switch for one Chat. Shown only when the host reports the fence's state; a muted shield
 * while fenced, a red "Full access" chip while not. A click sends `/full-access on|off`; turning it on waits for the
 * owner's answer in the macOS dialog the host shows, and the reported state stays authoritative.
 */
@customElement("full-access-toggle")
export class FullAccessToggle extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) onRunCommand?: (command: string) => void | Promise<void>;
  /** A Grid tile's one-row composer: icon only. */
  @property({ type: Boolean, reflect: true }) compact = false;
  @state() private waiting = false;

  override render() {
    const state = this.status?.extensionStatuses?.[FULL_ACCESS_STATUS_KEY];
    if (state !== "on" && state !== "off") return null;
    const on = state === "on";
    const label = this.waiting ? WAITING_LABEL : on ? FULL_LABEL : FENCED_LABEL;
    return html`<button type="button" class=${on ? "on" : ""} aria-pressed=${on ? "true" : "false"} aria-label=${`Full access — ${label}`} title=${label} ?disabled=${this.waiting} @click=${() => {
      void this.toggle(on);
    }}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${on ? SHIELD_OFF : SHIELD}</svg>${on ? html`<span class="value">Full access</span>` : null}</button>`;
  }

  private async toggle(on: boolean): Promise<void> {
    this.waiting = true;
    try {
      await this.onRunCommand?.(on ? "/full-access off" : "/full-access on");
    } finally {
      this.waiting = false;
    }
  }

  static override styles = css`
    :host { display: flex; flex: 0 0 auto; }
    /* Not a theme colour: red clears 4.5:1 on every theme's composer background. */
    button { --danger: light-dark(#b42318, #ff7b72); display: inline-flex; align-items: center; gap: 4px; height: var(--composer-control-size, 24px); min-width: var(--composer-control-size, 24px); margin: 0; padding: 0 4px; box-sizing: border-box; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--pi-muted); font: 600 11px system-ui, sans-serif; white-space: nowrap; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--pi-surface-hover); color: var(--pi-text); }
    button:disabled { opacity: .6; cursor: progress; }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    button.on, button.on:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); padding: 0 6px 0 4px; }
    svg { width: 16px; height: 16px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    :host([compact]) .value { display: none; }
    @container composer (max-width: 560px) { .value { display: none; } }
    @media (forced-colors: active) { button.on { border-color: Highlight; } }
  `;
}
