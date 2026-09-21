import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY, isTerminalDelegate, parseDelegateActivitySnapshot } from "../extensionStatusSnapshots";

@customElement("delegate-roster")
export class DelegateRoster extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;

  override render() {
    const items = parseDelegateActivitySnapshot(this.status?.extensionStatuses?.[ACTIVITY_STATUS_KEY]);
    if (items.length === 0) return null;
    return html`
      <section aria-label="Workers and Subagents">
        ${items.map((item) => {
          const terminal = isTerminalDelegate(item);
          const state = item.reportedStatus ?? item.activity ?? "starting";
          return html`<div class="row ${terminal ? "terminal" : ""}">
            <span class="kind">${item.kind === "worker" ? "Worker" : "Subagent"}</span>
            <strong title=${item.name ?? ""}>${item.name ?? "Unnamed"}</strong>
            <span class="task" title=${item.objective ?? ""}>${item.objective ?? "No task"}</span>
            <span class="activity" title=${state}>${state}</span>
            <span class="state">${terminal ? "Uncollected" : "Running"}</span>
          </div>`;
        })}
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; background: var(--pi-surface); }
    section { display: grid; gap: 2px; padding: 5px 12px 3px; border-top: 1px solid var(--pi-border-muted); }
    .row { min-width: 0; display: grid; grid-template-columns: auto minmax(60px, .8fr) minmax(80px, 260px) minmax(90px, 1fr) auto; align-items: center; gap: 8px; padding: 3px 5px; border-radius: 5px; color: var(--pi-text); font-size: 11px; }
    .row:nth-child(odd) { background: color-mix(in srgb, var(--pi-surface-hover) 45%, transparent); }
    .terminal { opacity: .72; }
    .kind, .state { color: var(--pi-muted); }
    .kind { font-weight: 650; }
    strong, .task, .activity { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .activity { color: var(--pi-muted); }
    .state { font-size: 10px; }
    @media (max-width: 700px) {
      .row { grid-template-columns: auto minmax(55px, .7fr) minmax(70px, 160px) minmax(80px, 1fr) auto; }
    }
  `;
}
