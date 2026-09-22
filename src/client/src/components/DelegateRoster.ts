import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY, isTerminalDelegate, parseDelegateActivitySnapshot } from "../extensionStatusSnapshots";

function shortModel(model: string | undefined): string | undefined {
  return model?.split("/").at(-1)?.replace(/-\d{8}$/, "");
}

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
          const inferredActivity = item.activity ?? "starting";
          const activity = item.reportedStatus ?? `No status report · ${inferredActivity}`;
          const activityLabel = item.reportedStatus === undefined ? `No status report; inferred activity: ${inferredActivity}` : `Reported status: ${item.reportedStatus}`;
          const kind = item.kind === "worker" ? "Worker" : "Subagent";
          const stateLabel = terminal ? "Uncollected" : "Running";
          const metadata = [item.role, shortModel(item.model), item.effort].filter(Boolean).join(" · ");
          const metadataTitle = [item.role, item.model, item.effort].filter(Boolean).join(" · ");
          return html`<div class="row ${terminal ? "terminal" : ""}">
            <span class="kind ${item.kind}" role="img" aria-label=${kind} title=${kind}></span>
            <span class="identity">
              <strong title=${item.name ?? ""}>${item.name ?? "Unnamed"}</strong>
              ${metadata ? html`<span class="meta" title=${metadataTitle}>${metadata}</span>` : null}
            </span>
            <span class="task" title=${item.objective ?? ""}>${item.objective ?? "No task"}</span>
            <span class="activity" title=${activity} aria-label=${activityLabel}>${activity}</span>
            <span class="state ${terminal ? "uncollected" : "running"}" role="img" aria-label=${stateLabel} title=${stateLabel}></span>
          </div>`;
        })}
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; background: var(--pi-surface); }
    section { display: grid; gap: 2px; padding: 5px 12px 3px; border-top: 1px solid var(--pi-border-muted); }
    .row { min-width: 0; display: grid; grid-template-columns: 8px minmax(105px, 180px) minmax(160px, 1.5fr) minmax(180px, 1.2fr) 8px; align-items: center; gap: 8px; padding: 3px 5px; border-radius: 5px; color: var(--pi-text); font-size: 11px; }
    .row:nth-child(odd) { background: color-mix(in srgb, var(--pi-surface-hover) 45%, transparent); }
    .terminal { opacity: .72; }
    .kind, .state { width: 7px; height: 7px; justify-self: center; border-radius: 50%; background: var(--pi-muted); }
    .kind.worker { border-radius: 1px; }
    .state.running { background: var(--pi-success); }
    .state.uncollected { background: var(--pi-warning); }
    .identity { min-width: 0; display: flex; gap: 6px; align-items: baseline; overflow: hidden; white-space: nowrap; }
    strong { flex: 0 1 auto; }
    .meta { flex: 1 1 auto; color: var(--pi-muted); }
    strong, .meta, .task, .activity { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .activity { color: var(--pi-muted); }
    @media (max-width: 700px) {
      section { padding-inline: 6px; }
      .row { grid-template-columns: 8px minmax(70px, .7fr) minmax(70px, 1fr) minmax(90px, 1.2fr) 8px; gap: 6px; padding-inline: 3px; }
      .meta { display: none; }
    }
  `;
}
