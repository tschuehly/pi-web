import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { latestCheckpoints, type WorkstreamSnapshot } from "./WorkstreamChooser";

@customElement("workstream-context-drawer")
export class WorkstreamContextDrawer extends LitElement {
  @property({ attribute: false }) snapshot: WorkstreamSnapshot | null | undefined;
  @property() error = "";

  override render() {
    if (this.error !== "") return html`<div class="tab unavailable" role="status" title=${this.error}>Workstream unavailable</div>`;
    if (this.snapshot === undefined) return html`<div class="tab unavailable" role="status">Finding Workstream…</div>`;
    if (this.snapshot === null) return html`<div class="tab unavailable">No Workstream associated</div>`;

    const overview = this.snapshot.overview;
    const checkpoint = latestCheckpoints(this.snapshot)[0]?.latestCheckpoint;
    return html`
      <details>
        <summary><span>Workstream</span><strong>${this.snapshot.title}</strong></summary>
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
    details { position: static; }
    summary, .tab { min-height: 32px; display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: transparent; }
    summary { list-style: none; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: "↓"; flex: 0 0 auto; color: var(--pi-muted); }
    details[open] summary::after { content: "↑"; }
    summary span { flex: 0 0 auto; color: var(--pi-accent); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    summary strong { overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
    .tab { color: var(--pi-muted); font-size: 12px; }
    .sheet { position: absolute; top: 100%; left: 0; right: 0; max-height: min(60vh, 520px); overflow: auto; display: grid; padding: 14px max(24px, calc((100% - 900px) / 2)); border-bottom: 1px solid var(--pi-purple-border); background: color-mix(in srgb, var(--pi-purple-surface) 36%, var(--pi-surface)); box-shadow: 0 18px 48px var(--pi-shadow); }
    .row { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 16px; align-items: baseline; padding: 11px 0; border-bottom: 1px solid var(--pi-border-muted); }
    .row:last-child { border-bottom: 0; }
    .label { color: var(--pi-accent); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
    .goal { width: 100%; font-size: 18px; font-weight: 750; line-height: 1.35; }
    .about p { color: var(--pi-muted); }
    .next { margin-top: 4px; padding-inline: 12px; border: 1px solid var(--pi-success-border); border-radius: 9px; background: var(--pi-success-bg); }
    @media (max-width: 520px) {
      .sheet { padding: 12px 16px; }
      .row { grid-template-columns: 1fr; gap: 4px; }
      .goal { font-size: 16px; }
    }
  `;
}
