import { LitElement, css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY, WATCHER_STATUS_KEY, isTerminalDelegate, parseDelegateActivitySnapshot, parseWatcherStatusSnapshot, visibleShellExecutions } from "../extensionStatusSnapshots";

function shortModel(model: string | undefined): string | undefined {
  return model?.split("/").at(-1)?.replace(/-\d{8}$/, "");
}

@customElement("delegate-roster")
export class DelegateRoster extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Boolean }) collapsed = false;
  @property({ attribute: false }) onToggleCollapsed?: () => void;

  override render() {
    const delegates = parseDelegateActivitySnapshot(this.status?.extensionStatuses?.[ACTIVITY_STATUS_KEY]);
    const watchers = parseWatcherStatusSnapshot(this.status?.extensionStatuses?.[WATCHER_STATUS_KEY]);
    const shells = visibleShellExecutions(this.status?.activeToolExecutions);
    const uncollected = delegates.filter(isTerminalDelegate).length;
    const rows = [
      ...delegates.map((item) => ({ key: `delegate:${item.id}`, source: "delegate" as const, item })),
      ...watchers.map((item) => ({ key: `watcher:${item.logicalId}`, source: "watcher" as const, item })),
      ...shells.map((item) => ({ key: `shell:${item.id}`, source: "shell" as const, item })),
    ];
    if (rows.length === 0) return null;
    return html`
      <section aria-label="Activity">
        <header>
          <button type="button" class="section-toggle" aria-expanded=${String(!this.collapsed)} aria-controls="delegate-roster-rows" @click=${() => { this.onToggleCollapsed?.(); }}>
            <span class="section-title">
              <span class="section-name"><span class="chevron" aria-hidden="true">${this.collapsed ? "▸" : "▾"}</span> Activity</span>
              <small class="aggregate">${String(delegates.length - uncollected)} running ${delegates.length - uncollected === 1 ? "delegate" : "delegates"} · ${String(uncollected)} uncollected · ${String(watchers.length)} ${watchers.length === 1 ? "watcher" : "watchers"} · ${String(shells.length)} ${shells.length === 1 ? "shell" : "shells"}</small>
            </span>
            <small class="section-count">${String(rows.length)}<span class="visually-hidden"> total</span></small>
          </button>
        </header>
        <div class="rows" id="delegate-roster-rows" ?hidden=${this.collapsed}>${repeat(rows, (row) => row.key, (row) => {
          if (row.source === "watcher") {
            const item = row.item;
            const kind = `${item.mode === "poll" ? "Poll" : item.mode === "file" ? "File" : "Spawn"} watcher`;
            const state = `Monitor: ${item.state}`;
            const activity = `Monitor: ${item.state}${item.consecutiveFailures > 0 ? ` · ${String(item.consecutiveFailures)} consecutive failures` : ""}`;
            const scope = `Scope: ${item.scope || "Not specified"}`;
            return html`<div class="row" data-row-key=${row.key}>
              <span class="kind watcher" role="img" aria-label=${kind} title=${kind}></span>
              <span class="identity"><strong>${item.handleId}</strong>${item.label !== undefined ? html`<span class="meta" title=${item.label}>${item.label}</span>` : null}</span>
              <span class="task" title=${scope}>${scope}</span>
              <span class="activity" title=${activity}>${activity}</span>
              <span class="state watcher-state ${item.state === "suspended" || item.state === "quarantined" ? "warning" : ""}" role="img" aria-label=${state} title=${state}></span>
            </div>`;
          }
          if (row.source === "shell") {
            const item = row.item;
            const kind = item.toolName === "bash" ? "Built-in bash tool" : "Interactive ! shell";
            return html`<div class="row" data-row-key=${row.key}>
              <span class="kind shell" role="img" aria-label="Shell" title="Shell"></span>
              <span class="identity"><strong>${item.label}</strong></span>
              <span class="task">${kind}</span>
              <span class="activity">Running</span>
              <span class="state running" role="img" aria-label="Running" title="Running"></span>
            </div>`;
          }
          const item = row.item;
          const terminal = isTerminalDelegate(item);
          const inferredActivity = item.activity ?? "starting";
          const activity = item.reportedStatus ?? `No status report · ${inferredActivity}`;
          const kind = item.kind === "worker" ? "Worker" : "Subagent";
          const stateLabel = terminal ? "Uncollected" : "Running";
          const metadata = [item.role, shortModel(item.model), item.effort].filter(Boolean).join(" · ");
          const metadataTitle = [item.role, item.model, item.effort].filter(Boolean).join(" · ");
          return html`<div class="row ${terminal ? "terminal" : ""}" data-row-key=${row.key}>
            <span class="kind ${item.kind}" role="img" aria-label=${kind} title=${kind}></span>
            <span class="identity">
              <strong title=${item.name ?? ""}>${item.name ?? "Unnamed"}</strong>
              ${metadata ? html`<span class="meta" title=${metadataTitle}>${metadata}</span>` : null}
            </span>
            <span class="task" title=${item.objective ?? ""}>${item.objective ?? "No task"}</span>
            <span class="activity" title=${activity}>${item.reportedStatus === undefined
              ? html`No status report<span class="visually-hidden">; inferred activity:</span><span aria-hidden="true"> ·</span> ${inferredActivity}`
              : html`<span class="visually-hidden">Reported status: </span>${item.reportedStatus}`}</span>
            <span class="state ${terminal ? "uncollected" : "running"}" role="img" aria-label=${stateLabel} title=${stateLabel}></span>
          </div>`;
        })}</div>
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; container-type: inline-size; background: var(--pi-surface); }
    section { display: grid; gap: 2px; padding: 5px 12px 3px; border-top: 1px solid var(--pi-border-muted); }
    .section-toggle { width: 100%; min-height: 24px; display: flex; align-items: center; gap: 8px; padding: 0 5px; border: 0; background: transparent; color: var(--pi-text); font: inherit; text-align: left; cursor: pointer; }
    .section-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .section-title { min-width: 0; flex: 1 1 auto; display: flex; align-items: baseline; gap: 8px; }
    .section-name { flex: 0 0 auto; font-size: 11px; font-weight: 700; }
    .chevron { display: inline-block; width: 1em; color: var(--pi-muted); }
    .aggregate { min-width: 0; overflow: hidden; color: var(--pi-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .section-count { flex: 0 0 auto; color: var(--pi-muted); font-size: 10px; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .rows { display: grid; gap: 2px; }
    .rows[hidden] { display: none; }
    .row { min-width: 0; display: grid; grid-template-columns: 8px minmax(105px, 180px) minmax(160px, 1.5fr) minmax(180px, 1.2fr) 8px; align-items: center; gap: 8px; padding: 3px 5px; border-radius: 5px; color: var(--pi-text); font-size: 11px; }
    .row:nth-child(odd) { background: color-mix(in srgb, var(--pi-surface-hover) 45%, transparent); }
    .terminal { opacity: .72; }
    .kind, .state { width: 7px; height: 7px; justify-self: center; border-radius: 50%; background: var(--pi-muted); }
    .kind.worker { border-radius: 1px; }
    .kind.watcher { background: var(--pi-accent); }
    .kind.shell { border-radius: 1px; background: var(--pi-warning); }
    .state.watcher-state { background: var(--pi-accent); }
    .state.watcher-state.warning { background: var(--pi-warning); }
    .state.running { background: var(--pi-success); }
    .state.uncollected { background: var(--pi-warning); }
    .identity { min-width: 0; display: flex; gap: 6px; align-items: baseline; overflow: hidden; white-space: nowrap; }
    strong { flex: 0 1 auto; }
    .meta { flex: 1 1 auto; color: var(--pi-muted); }
    strong, .meta, .task, .activity { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .activity { color: var(--pi-muted); }
    @container (max-width: 700px) {
      section { padding-inline: 6px; }
      .section-title { flex-wrap: wrap; }
      .aggregate { order: -1; flex: 0 1 100%; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
      .section-name { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row { grid-template-columns: 8px minmax(70px, .7fr) minmax(70px, 1fr) minmax(90px, 1.2fr) 8px; gap: 6px; padding-inline: 3px; }
      .meta { display: none; }
    }
  `;
}
