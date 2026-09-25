import { LitElement, css, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { ACTIVITY_STATUS_KEY, BACKGROUND_BASH_STATUS_KEY, WATCHER_STATUS_KEY, isTerminalDelegate, parseBackgroundBashStatusSnapshot, parseDelegateActivitySnapshot, parseWatcherStatusSnapshot, visibleShellExecutions } from "../extensionStatusSnapshots";

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
    const backgroundBash = parseBackgroundBashStatusSnapshot(this.status?.extensionStatuses?.[BACKGROUND_BASH_STATUS_KEY]);
    const uncollected = delegates.filter(isTerminalDelegate).length;
    const rows = [
      ...delegates.map((item) => ({ key: `delegate:${item.id}`, source: "delegate" as const, item })),
      ...watchers.map((item) => ({ key: `watcher:${item.logicalId}`, source: "watcher" as const, item })),
      ...shells.map((item) => ({ key: `shell:${item.id}`, source: "shell" as const, item })),
      ...backgroundBash.map((item) => ({ key: `background-bash:${item.id}`, source: "background-bash" as const, item })),
    ];
    if (rows.length === 0) return null;
    return html`
      <section aria-label="Activity">
        <header>
          <button type="button" class="section-toggle" aria-expanded=${String(!this.collapsed)} aria-controls="delegate-roster-rows" @click=${() => { this.onToggleCollapsed?.(); }}>
            <span class="section-title">
              <span class="section-name"><span class="chevron" aria-hidden="true">${this.collapsed ? "▸" : "▾"}</span> Activity</span>
              <small class="aggregate">${String(delegates.length - uncollected)} running ${delegates.length - uncollected === 1 ? "delegate" : "delegates"} · ${String(uncollected)} uncollected · ${String(watchers.length)} ${watchers.length === 1 ? "watcher" : "watchers"} · ${String(shells.length + backgroundBash.length)} ${shells.length + backgroundBash.length === 1 ? "shell" : "shells"}</small>
            </span>
          </button>
        </header>
        <div class="rows" id="delegate-roster-rows" tabindex="0" role="region" aria-label="Activity entries" ?hidden=${this.collapsed}>${repeat(rows, (row) => row.key, (row) => {
          if (row.source === "background-bash") {
            const item = row.item;
            return html`<div class="row" data-row-key=${row.key}>
              <span class="kind shell" role="img" aria-label="Background bash" title="Background bash"></span>
              <span class="identity"><strong>Background bash</strong><span class="meta">${item.id.slice(0, 8)}</span></span>
              <span class="activity delegate-status">Running · ${String(item.elapsedSeconds)}s · ${String(item.bytes)} bytes output</span>
              <span class="state running" role="img" aria-label="Running" title="Running"></span>
            </div>`;
          }
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
          const kind = item.kind === "worker" ? "Worker" : "Subagent";
          const stateLabel = terminal ? "Uncollected" : "Running";
          const metadata = [item.role, shortModel(item.model), item.effort].filter(Boolean).join(" · ");
          const metadataTitle = [item.role, item.model, item.effort].filter(Boolean).join(" · ");
          return html`<div class="row ${terminal ? "terminal" : ""}" data-row-key=${row.key}>
            <span class="kind ${item.kind}" role="img" aria-label=${kind} title=${kind}></span>
            <span class="identity">
              <strong>${item.name ?? "Unnamed"}</strong>
              ${metadata ? html`<span class="meta" title=${metadataTitle}>${metadata}</span>` : null}
            </span>
            <span class="activity delegate-status">${item.reportedStatus === undefined
              ? terminal ? "No status report received" : "Waiting for status report"
              : html`<span class="field-label">Reported status:</span> ${item.reportedStatus}`}</span>
            <span class="state ${terminal ? "uncollected" : "running"}" role="img" aria-label=${stateLabel} title=${stateLabel}></span>
          </div>`;
        })}</div>
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; container-type: inline-size; background: var(--pi-surface); }
    section { display: grid; gap: 1px; padding: 3px 10px 2px; border-top: 1px solid var(--pi-border-muted); }
    .section-toggle { width: 100%; min-height: 24px; display: flex; align-items: center; gap: 8px; padding: 0 5px; border: 0; background: transparent; color: var(--pi-text); font: inherit; text-align: left; cursor: pointer; }
    .section-toggle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .section-title { min-width: 0; flex: 1 1 auto; display: flex; align-items: baseline; gap: 8px; }
    .section-name { flex: 0 0 auto; font-size: 11px; font-weight: 700; }
    .chevron { display: inline-block; width: 1em; color: var(--pi-muted); }
    .aggregate { min-width: 0; overflow: hidden; color: var(--pi-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .rows { display: grid; gap: 1px; max-height: min(22vh, 180px); overflow-y: auto; overscroll-behavior: contain; }
    .rows[hidden] { display: none; }
    .rows:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    .row { min-width: 0; display: grid; grid-template-columns: 8px minmax(0, 1fr) minmax(0, 2fr) 8px; grid-template-rows: auto auto; align-items: start; column-gap: 6px; row-gap: 1px; padding: 3px 5px; border-radius: 5px; color: var(--pi-text); font-size: 11px; }
    .row:nth-child(odd) { background: color-mix(in srgb, var(--pi-surface-hover) 45%, transparent); }
    .terminal { opacity: .72; }
    .kind, .state { width: 7px; height: 7px; justify-self: center; margin-top: 5px; border-radius: 50%; background: var(--pi-muted); }
    .kind { grid-column: 1; grid-row: 1; }
    .state { grid-column: 4; grid-row: 1; }
    .kind.worker { border-radius: 1px; }
    .kind.watcher { background: var(--pi-accent); }
    .kind.shell { border-radius: 1px; background: var(--pi-warning); }
    .state.watcher-state { background: var(--pi-accent); }
    .state.watcher-state.warning { background: var(--pi-warning); }
    .state.running { background: var(--pi-success); }
    .state.uncollected { background: var(--pi-warning); }
    .identity, .task, .activity { min-width: 0; overflow-wrap: anywhere; }
    .identity { grid-column: 2; grid-row: 1 / 3; display: grid; align-content: start; gap: 2px; }
    .meta { color: var(--pi-muted); }
    .task { grid-column: 3; grid-row: 1; }
    .activity { grid-column: 3; grid-row: 2; color: var(--pi-muted); }
    .delegate-status { grid-row: 1 / 3; align-self: center; color: var(--pi-text); }
    .field-label { color: var(--pi-muted); font-size: 10px; }
    @container (max-width: 700px) {
      section { padding-inline: 6px; }
      .section-title { flex-wrap: wrap; }
      .aggregate { flex: 0 1 100%; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
      .section-name { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row { grid-template-columns: 8px minmax(0, 1fr) 8px; column-gap: 6px; padding-inline: 3px; }
      .identity { grid-column: 2; grid-row: 1; }
      .task { grid-column: 2; grid-row: 2; }
      .activity { grid-column: 2; grid-row: 3; }
      .delegate-status { grid-row: 2; }
      .state { grid-column: 3; }
    }
  `;
}
