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
          <section>
            <span class="label">Goal</span>
            <p class="goal">${overview?.goal ?? "No Workstream overview has been written."}</p>
          </section>
          <section class="about">
            <div>
              <span class="label">About</span>
              <p>${overview?.description ?? "This Workstream has no stored description yet."}</p>
            </div>
            <div class="facts">
              <div><span class="label">Done when</span><p>${overview?.doneWhen ?? "No completion condition recorded."}</p></div>
              <div class="next"><span class="label">Do next</span><p>${checkpoint?.next ?? "No next action recorded."}</p></div>
            </div>
          </section>
        </div>
      </details>
    `;
  }

  static override styles = css`
    :host { position: relative; z-index: 5; display: block; flex: 0 0 auto; height: 24px; min-width: 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); color: var(--pi-text); }
    * { box-sizing: border-box; min-width: 0; }
    details { position: relative; height: 24px; }
    summary, .tab { position: absolute; left: 50%; top: -1px; width: min(520px, calc(100% - 28px)); min-height: 31px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 4px 14px; border: 1px solid var(--pi-border); border-top: 0; border-radius: 0 0 10px 10px; background: var(--pi-surface); box-shadow: 0 6px 16px var(--pi-shadow); transform: translateX(-50%); }
    summary { list-style: none; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: "↓"; flex: 0 0 auto; color: var(--pi-muted); }
    details[open] summary::after { content: "↑"; }
    summary span { flex: 0 0 auto; color: var(--pi-accent); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    summary strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tab { color: var(--pi-muted); font-size: 12px; }
    .sheet { position: absolute; top: 24px; left: 0; right: 0; max-height: min(60vh, 520px); overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 20px; padding: 22px max(24px, calc((100% - 900px) / 2)); border-bottom: 1px solid var(--pi-purple-border); background: color-mix(in srgb, var(--pi-purple-surface) 36%, var(--pi-surface)); box-shadow: 0 18px 48px var(--pi-shadow); }
    section, .about, .facts { display: grid; gap: 12px; align-content: start; }
    .label { display: block; margin-bottom: 4px; color: var(--pi-accent); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
    .goal { font-size: 20px; font-weight: 750; line-height: 1.35; }
    .about > div:first-child > p { color: var(--pi-muted); }
    .facts { grid-template-columns: 1fr 1fr; gap: 14px; }
    .facts > div { padding: 12px; border: 1px solid var(--pi-border); border-radius: 9px; background: var(--pi-bg); }
    .facts .next { border-color: var(--pi-success-border); background: var(--pi-success-bg); }
    @media (max-width: 700px) {
      .sheet, .facts { grid-template-columns: 1fr; }
      .sheet { gap: 14px; padding: 18px 16px; }
      .goal { font-size: 17px; }
    }
  `;
}
