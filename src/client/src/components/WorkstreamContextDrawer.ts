import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { latestCheckpoints, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { WORKSTREAM_TINT_PERCENTAGES, workstreamAccentColor, workstreamMonogram } from "../workstreamColor";

@customElement("workstream-context-drawer")
export class WorkstreamContextDrawer extends LitElement {
  @property({ attribute: false }) snapshot: WorkstreamSnapshot | null | undefined;
  @property() error = "";
  @property() fallbackTitle = "";

  override render() {
    if (this.error !== "") return html`<div class="tab unavailable" role="status" title=${this.error}>Workstream unavailable</div>`;
    if (this.snapshot === undefined) return html`<div class="tab unavailable" role="status">Finding Workstream…</div>`;
    if (this.snapshot === null) return html`<div class="tab unavailable" title=${this.fallbackTitle}><span class="fallback-title">${this.fallbackTitle}</span></div>`;

    const overview = this.snapshot.overview;
    const checkpoint = latestCheckpoints(this.snapshot)[0]?.latestCheckpoint;
    return html`
      <details style=${`--workstream-color:${workstreamAccentColor(this.snapshot.id)}`}>
        <summary><span class="identity-mark" aria-hidden="true">${workstreamMonogram(this.snapshot.title)}</span><span class="context-label">Workstream</span><strong>${this.snapshot.title}</strong></summary>
        <div class="sheet">
          <section class="row goal-row">
            <span class="label">Goal</span>
            <p class="goal">${overview?.goal ?? "No Workstream overview has been written."}</p>
          </section>
          <section class="row about">
            <span class="label">About</span>
            <p>${overview?.description ?? "This Workstream has no stored description yet."}</p>
          </section>
          <section class="row">
            <span class="label">Done when</span>
            <p>${overview?.doneWhen ?? "No completion condition recorded."}</p>
          </section>
          <section class="row next">
            <span class="label">Do next</span>
            <p>${checkpoint?.next ?? "No next action recorded."}</p>
          </section>
        </div>
      </details>
    `;
  }

  static override styles = css`
    :host { position: static; display: block; min-width: 0; color: var(--pi-text); }
    * { box-sizing: border-box; min-width: 0; }
    details { position: static; border-left: 3px solid var(--workstream-color, transparent); }
    summary, .tab { min-height: 32px; display: flex; align-items: center; gap: 8px; }
    summary { padding: 0 10px; border: 1px solid var(--pi-border); border-radius: 8px; background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.drawer}%, var(--pi-surface)); list-style: none; cursor: pointer; }
    summary:hover { background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.drawerActive}%, var(--pi-surface-hover)); }
    details[open] summary { background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.drawerActive}%, var(--pi-surface-hover)); }
    summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: "↓"; flex: 0 0 auto; color: var(--pi-text); }
    details[open] summary::after { content: "↑"; }
    .context-label { flex: 0 0 auto; color: var(--pi-text); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    .identity-mark { flex: 0 0 auto; display: inline-grid; place-items: center; width: 28px; height: 24px; border: 2px solid var(--pi-text); border-radius: 7px 7px 3px 7px; background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.mark}%, var(--pi-surface)); color: var(--pi-text); font-size: 10px; font-weight: 850; letter-spacing: .03em; line-height: 1; }
    summary strong { flex: 1 1 auto; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
    .tab { overflow: hidden; padding: 0; border: 0; background: transparent; color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
    .fallback-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sheet { --sheet-tint: color-mix(in srgb, var(--pi-purple-surface) 36%, transparent); --sheet-paint: linear-gradient(var(--sheet-tint), var(--sheet-tint)); position: absolute; top: 100%; left: 0; right: 0; max-height: calc(var(--pi-workbench-viewport-height, 100vh) - 56px); overflow: auto; display: grid; padding: 20px max(24px, calc((100% - 900px) / 2)); border-bottom: 1px solid var(--pi-purple-border); background: var(--sheet-paint) var(--pi-surface); box-shadow: 0 18px 48px var(--pi-shadow); }
    .row { position: relative; padding: 18px 0 12px; border-top: 1px solid var(--pi-border-muted); }
    .label { position: absolute; top: 0; left: 0; padding-right: 10px; color: var(--pi-text); background: var(--sheet-paint) var(--pi-surface); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; transform: translateY(-50%); }
    p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
    .goal { width: 100%; font-size: 18px; font-weight: 750; line-height: 1.35; }
    .about p { color: var(--pi-text); }
    .next { margin: 8px 0 4px; padding: 18px 12px 12px; border: 1px solid var(--pi-success-border); border-radius: 9px; background: linear-gradient(var(--pi-success-bg), var(--pi-success-bg)), var(--sheet-paint) var(--pi-surface); }
    .next .label { left: 12px; background: linear-gradient(var(--pi-success-bg), var(--pi-success-bg)), var(--sheet-paint) var(--pi-surface); }
    @media (forced-colors: active) {
      details { border-left-color: LinkText; }
      summary { background: Canvas; }
      details[open] summary { border-color: Highlight; }
      .identity-mark { border-color: ButtonText; background: Canvas; color: CanvasText; }
    }
    @media (max-width: 520px) {
      .context-label { display: none; }
      .sheet { padding: 12px 16px; }
      .goal { font-size: 16px; }
    }
  `;
}
