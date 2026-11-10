import { LitElement, css, html, nothing, svg, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { activitySummary, delegateOutcome, type DelegateActivityItem, type DelegateOutcome } from "../extensionStatusSnapshots";
import { formatAge, formatElapsed, formatFileSize } from "../utils/format";

// ponytail: one fixed threshold for "may be stuck"; make it per role if long-thinking delegates trip it.
const QUIET_AFTER_MS = 10 * 60_000;
const OUTCOME_ORDER: Record<DelegateOutcome, number> = { failed: 0, done: 1, cancelled: 2, running: 4 };
const QUIET_ORDER = 3;

// Lucide shapes (https://lucide.dev, ISC), drawn by the shared `svg` rule below.
const ICONS = {
  subagent: svg`<path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path>`,
  worker: svg`<path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"></path><path d="M14 6a6 6 0 0 1 6 6v3"></path><path d="M4 15v-3a6 6 0 0 1 6-6"></path><rect x="2" y="15" width="20" height="4" rx="1"></rect>`,
  done: svg`<circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path>`,
  failed: svg`<circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path>`,
  cancelled: svg`<circle cx="12" cy="12" r="10"></circle><line x1="9" x2="15" y1="15" y2="9"></line>`,
  watcher: svg`<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle>`,
  shell: svg`<path d="M12 19h8"></path><path d="m4 17 6-6-6-6"></path>`,
  backgroundShell: svg`<path d="m7 11 2-2-2-2"></path><path d="M11 13h4"></path><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>`,
  timer: svg`<line x1="10" x2="14" y1="2" y2="2"></line><line x1="12" x2="15" y1="14" y2="11"></line><circle cx="12" cy="14" r="8"></circle>`,
  quiet: svg`<path d="M12 6v6l4 2"></path><path d="M20 12v5"></path><path d="M20 21h.01"></path><path d="M21.25 8.2A10 10 0 1 0 16 21.16"></path>`,
  chevron: svg`<path d="m9 18 6-6-6-6"></path>`,
};

type Tone = "running" | "done" | "failed" | "muted" | "warning";

function icon(shape: TemplateResult, className = "icon"): TemplateResult {
  return html`<svg class=${className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shape}</svg>`;
}

function shortModel(model: string | undefined): string | undefined {
  return model?.split("/").at(-1)?.replace(/-\d{8}$/, "");
}

const MODEL_NICKNAMES: readonly (readonly [RegExp, string])[] = [[/opus/u, "Opus"], [/sonnet/u, "Sonnet"], [/fable/u, "Fable"], [/haiku/u, "Haiku"], [/astra/u, "Astra"], [/sol\b/u, "Sol"], [/luna/u, "Luna"], [/grok/u, "Grok"]];
const SIGNAL_BARS = ["M2 20h.01", "M7 20v-4", "M12 20v-8", "M17 20V8", "M22 4v16"];
const ZAP = "M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z";
/** Lucide signal-zero … signal for minimal … xhigh; max adds a zap. */
const EFFORT_BARS: Readonly<Record<string, number>> = { minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 5 };

/** The model's nickname (one version of each is in use); unknown models keep their short id. */
function modelNickname(model: string | undefined): string | undefined {
  const short = shortModel(model);
  return short === undefined ? undefined : MODEL_NICKNAMES.find(([pattern]) => pattern.test(short))?.[1] ?? short;
}

function effortIcon(effort: string | undefined): TemplateResult | typeof nothing {
  const bars = effort === undefined ? undefined : EFFORT_BARS[effort];
  if (bars === undefined || effort === undefined) return nothing;
  return html`<svg class="effort" role="img" aria-label=${`${effort} effort`} viewBox="0 0 24 24">${SIGNAL_BARS.slice(0, bars).map((d) => svg`<path d=${d}></path>`)}</svg>${effort === "max" ? html`<svg class="effort zap" aria-hidden="true" viewBox="0 0 24 24">${svg`<path d=${ZAP}></path>`}</svg>` : nothing}`;
}

function since(iso: string | undefined, now: number): number | undefined {
  return iso === undefined ? undefined : now - Date.parse(iso);
}

/** A running delegate that has not reported for a while may be stuck. */
function isQuiet(item: DelegateActivityItem, now: number): boolean {
  return (since(item.reportedAt ?? item.startedAt, now) ?? 0) >= QUIET_AFTER_MS;
}

function elapsed(ms: number | undefined, label = "Running for"): TemplateResult {
  if (ms === undefined) return html`<span class="elapsed"></span>`;
  const text = formatElapsed(ms);
  return html`<span class="elapsed" title=${`${label} ${text}`}>${icon(ICONS.timer, "timer-icon")}<span class="visually-hidden">${label} </span>${text}</span>`;
}

const OUTCOME_LABEL: Record<Exclude<DelegateOutcome, "running">, string> = { done: "To collect", failed: "Failed", cancelled: "Cancelled" };
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

@customElement("delegate-roster")
export class DelegateRoster extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Boolean }) collapsed = false;
  /** A Grid tile folds the roster away entirely: its composer's Activity badge shows the count and unfolds it. */
  @property({ type: Boolean }) compact = false;
  @property({ attribute: false }) onToggleCollapsed?: () => void;
  @state() private expandedBashJobs = new Set<string>();
  /** Re-renders once a second while the rows are visible so elapsed times and report ages stay current. */
  private clock: ReturnType<typeof setInterval> | undefined;

  override updated(): void {
    // Keep each open log on its newest lines unless the reader scrolled up.
    for (const pre of this.shadowRoot?.querySelectorAll<HTMLElement>(".bash-log pre") ?? []) {
      if (pre.dataset["pinned"] !== "false") pre.scrollTop = pre.scrollHeight;
    }
    const visible = this.shadowRoot?.querySelector(".rows:not([hidden])") != null;
    if (visible && this.clock === undefined) this.clock = setInterval(() => { this.requestUpdate(); }, 1000);
    if (!visible) this.stopClock();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopClock();
  }

  private stopClock(): void {
    clearInterval(this.clock);
    this.clock = undefined;
  }

  private toggleBashJob(id: string): void {
    const next = new Set(this.expandedBashJobs);
    if (!next.delete(id)) next.add(id);
    this.expandedBashJobs = next;
  }

  // Slotted content shares the header line, so the roster re-renders when it comes or goes.
  private readonly asideChanged = (): void => { this.requestUpdate(); };

  override render() {
    const { delegates, watchers, shells, backgroundBash, label } = activitySummary(this.status);
    const aside = html`<slot name="aside" @slotchange=${this.asideChanged}></slot>`;
    // No header to share: content slotted into `aside` takes the whole line alone.
    if (delegates.length + watchers.length + shells.length + backgroundBash.length === 0 || (this.compact && this.collapsed)) {
      return this.querySelector(":scope > [slot='aside']") === null ? aside : html`<section class="lone">${aside}</section>`;
    }
    const now = Date.now();
    // Attention first: failures, results waiting to be collected, quiet work that may be stuck, then the rest.
    const rank = ({ item, outcome }: { item: DelegateActivityItem; outcome: DelegateOutcome }) => outcome === "running" && isQuiet(item, now) ? QUIET_ORDER : OUTCOME_ORDER[outcome];
    const ordered = delegates.map((item) => ({ item, outcome: delegateOutcome(item) })).sort((a, b) => rank(a) - rank(b));
    return html`
      <section aria-label="Activity">
        <div class="head">
          <button type="button" class="section-toggle" aria-expanded=${String(!this.collapsed)} aria-controls="delegate-roster-rows" @click=${() => { this.onToggleCollapsed?.(); }}>
            ${icon(ICONS.chevron, "chevron")}
            <span class="section-name">Activity</span>
            <small class="aggregate">${label}</small>
          </button>
          ${aside}
        </div>
        <div class="rows" id="delegate-roster-rows" tabindex="0" role="region" aria-label="Activity entries" ?hidden=${this.collapsed}>
          ${repeat(ordered, ({ item }) => `delegate:${item.id}`, ({ item, outcome }) => this.renderDelegate(item, outcome, now))}
          ${repeat(watchers, (item) => `watcher:${item.logicalId}`, (item) => {
            const warning = item.state === "suspended" || item.state === "quarantined";
            const kind = `${capitalized(item.mode)} watcher`;
            const failures = item.consecutiveFailures > 0 ? ` · ${String(item.consecutiveFailures)} ${item.consecutiveFailures === 1 ? "failure" : "failures"}` : "";
            return this.renderRow({
              key: `watcher:${item.logicalId}`, tone: warning ? "warning" : "running", shape: ICONS.watcher, iconLabel: `${kind}, ${item.state}`,
              name: item.label ?? item.handleId, nameTitle: `${kind} · ${item.handleId}`,
              report: item.scope === "" ? undefined : item.scope, reportLabel: "Scope", fallback: "No scope given",
              status: html`${capitalized(item.state)}${failures}`, statusTitle: `Monitor ${item.state}${failures}`,
              elapsed: since(item.startedAt, now),
            });
          })}
          ${repeat(shells, (item) => `shell:${item.id}`, (item) => this.renderRow({
            key: `shell:${item.id}`, tone: "running", shape: ICONS.shell, iconLabel: "Shell, running",
            name: item.label, report: item.toolName === "bash" ? "Built-in bash tool" : "Interactive ! shell",
            status: "Running", elapsed: since(item.startedAt, now),
          }))}
          ${repeat(backgroundBash, (item) => `background-bash:${item.id}`, (item) => this.renderBackgroundBash(item))}
        </div>
      </section>
    `;
  }

  private renderDelegate(item: DelegateActivityItem, outcome: DelegateOutcome, now: number): TemplateResult {
    const kind = item.kind === "worker" ? "Worker" : "Subagent";
    const details = [kind, item.role, shortModel(item.model), item.effort].filter(Boolean).join(" · ");
    const nickname = modelNickname(item.model);
    const model = nickname === undefined || item.model === undefined ? undefined : { label: html`${nickname}${effortIcon(item.effort)}`, title: item.effort === undefined ? item.model : `${item.model} · ${item.effort} effort` };
    const reportAge = since(item.reportedAt ?? item.startedAt, now);
    const ended = item.endedAt === undefined ? undefined : Date.parse(item.endedAt);
    if (outcome !== "running") {
      const raw = capitalized((item.activity ?? "").replaceAll("_", " "));
      return this.renderRow({
        key: `delegate:${item.id}`, tone: outcome === "cancelled" ? "muted" : outcome, shape: ICONS[outcome], iconLabel: `${kind}, ${OUTCOME_LABEL[outcome].toLowerCase()}`,
        name: item.name ?? "Unnamed", nameTitle: details, model, report: item.reportedStatus, reportLabel: "Status", fallback: "No status report received",
        status: outcome === "failed" ? raw : OUTCOME_LABEL[outcome],
        statusTitle: outcome === "done" ? "Finished; its result is waiting to be collected" : `${OUTCOME_LABEL[outcome]}: ${raw.toLowerCase()}`,
        elapsed: ended === undefined || item.startedAt === undefined ? undefined : ended - Date.parse(item.startedAt),
        elapsedLabel: "Ran for",
      });
    }
    const quiet = isQuiet(item, now);
    const age = reportAge === undefined ? undefined : formatAge(reportAge);
    return this.renderRow({
      key: `delegate:${item.id}`, tone: "running", shape: item.kind === "worker" ? ICONS.worker : ICONS.subagent, iconLabel: `${kind}, running`,
      name: item.name ?? "Unnamed", nameTitle: details, model, report: item.reportedStatus, reportLabel: "Status", fallback: "Waiting for its first status report",
      status: reportAge === undefined || age === undefined ? nothing
        : quiet ? html`${icon(ICONS.quiet, "quiet-icon")}Quiet ${formatElapsed(reportAge)}`
        : html`<span class="visually-hidden">${item.reportedAt === undefined ? "Started" : "Reported"} </span>${age}`,
      statusTitle: reportAge === undefined || age === undefined ? undefined : quiet ? `No status report for ${formatElapsed(reportAge)}; it may be stuck` : `${item.reportedAt === undefined ? "Started" : "Last status report"} ${age}`,
      quiet, elapsed: since(item.startedAt, now),
    });
  }

  private renderRow(row: {
    key: string; tone: Tone; shape: TemplateResult; iconLabel: string; name: string; nameTitle?: string; model?: { label: TemplateResult; title: string } | undefined;
    report: string | undefined; reportLabel?: string; fallback?: string; status: unknown; statusTitle?: string | undefined; quiet?: boolean;
    elapsed: number | undefined; elapsedLabel?: string;
  }): TemplateResult {
    return html`<div class="row ${row.tone}" data-row-key=${row.key}>
      <span class="kind" role="img" aria-label=${row.iconLabel} title=${row.iconLabel}>${icon(row.shape)}</span>
      ${row.model === undefined
        ? html`<strong class="name" title=${row.nameTitle ?? row.name}>${row.name}</strong>`
        : html`<span class="who"><strong class="name" title=${row.nameTitle ?? row.name}>${row.name}</strong><span class="model" title=${row.model.title}>${row.model.label}</span></span>`}
      ${row.report === undefined
        ? html`<span class="report fallback">${row.fallback}</span>`
        : html`<span class="report" title=${row.report}>${row.reportLabel === undefined ? nothing : html`<span class="visually-hidden">${row.reportLabel}: </span>`}${row.report}</span>`}
      <span class="status ${row.quiet === true ? "quiet" : ""}" title=${row.statusTitle ?? nothing}>${row.status}</span>
      ${elapsed(row.elapsed, row.elapsedLabel)}
    </div>`;
  }

  private renderBackgroundBash(item: ReturnType<typeof activitySummary>["backgroundBash"][number]): TemplateResult {
    const expanded = this.expandedBashJobs.has(item.id);
    const logId = `bash-log-${item.id}`;
    return html`<div class="row running" data-row-key=${`background-bash:${item.id}`}>
      <span class="kind" role="img" aria-label="Background bash, running" title="Background bash, running">${icon(ICONS.backgroundShell)}</span>
      <button type="button" class="name expand" aria-expanded=${String(expanded)} aria-controls=${logId} title=${expanded ? "Hide output" : "Show output"} @click=${() => { this.toggleBashJob(item.id); }}>
        <span>${item.description ?? "Background bash"}</span>${icon(ICONS.chevron, "chevron")}
      </button>
      ${item.command === undefined
        ? html`<span class="report fallback">Command not shown</span>`
        : html`<code class="report command" title=${item.command}>${item.command}</code>`}
      <span class="status" title=${`${String(item.bytes)} bytes of output`}>${formatFileSize(item.bytes)}</span>
      ${elapsed(item.elapsedSeconds * 1000)}
      ${expanded ? html`<div class="bash-log" id=${logId}>
        ${item.command === undefined ? null : html`<code class="bash-command">$ ${item.command}</code>`}
        ${item.logPath === undefined ? null : html`<small class="log-path">Recent output only. Full log: ${item.logPath}</small>`}
        <pre tabindex="0" aria-label="Recent output" @scroll=${(event: Event) => { const pre = event.currentTarget; if (pre instanceof HTMLElement) pre.dataset["pinned"] = String(pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4); }}>${item.output === undefined || item.output === "" ? "No output yet." : item.output}</pre>
      </div>` : null}
    </div>`;
  }

  static override styles = css`
    :host { display: block; flex: 0 0 auto; container-type: inline-size; background: var(--pi-surface); }
    section { display: grid; gap: 2px; padding: 3px 10px 4px; border-top: 1px solid var(--pi-border-muted); font-size: 12px; line-height: 18px; }
    svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: 0 0 auto; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    /* The header line: Activity and slotted aside content (a Chat's question bar) split it evenly; either alone takes it all. */
    .head { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .section-toggle, ::slotted([slot="aside"]) { flex: 1 1 0; min-width: 0; }
    .section-toggle { min-width: 0; min-height: 24px; display: flex; align-items: center; gap: 6px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--pi-text); font: inherit; text-align: left; cursor: pointer; }
    .section-toggle:hover { background: var(--pi-surface-hover); }
    .section-toggle:focus-visible, .expand:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .chevron { width: 14px; height: 14px; color: var(--pi-muted); transition: transform 150ms ease-out; }
    [aria-expanded="true"] > .chevron { transform: rotate(90deg); }
    .section-name { flex: 0 0 auto; font-weight: 650; }
    .aggregate { min-width: 0; overflow: hidden; color: var(--pi-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
    /* One shared column grid: every name, report, status and time lines up across rows. */
    .rows { display: grid; grid-template-columns: 14px fit-content(42%) minmax(0, 1fr) auto auto; grid-auto-rows: max-content; column-gap: 10px; max-height: min(28vh, 220px); overflow-y: auto; overscroll-behavior: contain;
      /* Scroll shadows: an edge shadow appears only while more rows sit beyond it. */
      background:
        linear-gradient(var(--pi-surface) 40%, transparent) top / 100% 18px no-repeat local,
        linear-gradient(transparent, var(--pi-surface) 60%) bottom / 100% 18px no-repeat local,
        linear-gradient(var(--pi-shadow-soft), transparent) top / 100% 8px no-repeat scroll,
        linear-gradient(transparent, var(--pi-shadow-soft)) bottom / 100% 8px no-repeat scroll; }
    .rows[hidden] { display: none; }
    .rows:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; border-radius: 6px; }
    .row { --tone: var(--pi-success); grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; min-width: 0; min-height: 24px; padding: 1px 6px; border-radius: 6px; color: var(--pi-text); }
    .row:hover { background: var(--pi-surface-hover); }
    .row.done { --tone: var(--pi-purple); }
    .row.failed { --tone: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 9%, transparent); }
    .row.warning { --tone: var(--pi-warning); }
    .row.muted { --tone: var(--pi-muted); }
    .kind { display: flex; color: var(--tone); }
    .icon { width: 14px; height: 14px; }
    .who { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .model { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; color: var(--pi-muted); font-size: 11px; white-space: nowrap; }
    .model .effort { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .model .effort.zap { width: 10px; height: 10px; margin-left: -2px; stroke-width: 2; }
    .name { min-width: 0; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .report { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .report.fallback { color: var(--pi-muted); font-style: italic; }
    .command { color: var(--pi-muted); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .status, .elapsed { color: var(--pi-muted); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .status { display: flex; align-items: center; gap: 4px; justify-self: end; }
    .elapsed { display: flex; align-items: center; justify-content: flex-end; gap: 3px; min-width: 6ch; }
    .timer-icon { width: 11px; height: 11px; color: var(--pi-dim); }
    /* Tone text leans toward the foreground so 11px labels keep AA contrast; icons keep the pure tone. */
    .row.done .status, .row.failed .status, .row.warning .status, .status.quiet { color: color-mix(in srgb, var(--tone) 80%, var(--pi-text)); font-weight: 600; }
    .status.quiet { --tone: var(--pi-warning); }
    .quiet-icon { width: 12px; height: 12px; }
    .expand { display: flex; align-items: center; gap: 4px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-weight: 600; text-align: left; cursor: pointer; }
    .expand > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .bash-log { grid-column: 2 / -1; display: grid; gap: 2px; min-width: 0; padding: 2px 0 4px; }
    .bash-command, .log-path { overflow-wrap: anywhere; color: var(--pi-muted); font-size: 11px; }
    .bash-log pre { max-height: 80px; margin: 0; padding: 4px 6px; overflow: auto; border-radius: 4px; background: var(--pi-surface-hover); font-size: 10.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
    /* A narrow Grid tile: name and times on the first line, the report beneath, up to two lines. */
    @container (max-width: 560px) {
      section { padding-inline: 6px; }
      .section-toggle { flex-wrap: wrap; row-gap: 0; }
      .aggregate { flex: 1 1 0; white-space: normal; overflow-wrap: anywhere; }
      .rows { grid-template-columns: 14px minmax(0, 1fr) auto auto; column-gap: 8px; }
      .row { align-items: start; padding-block: 3px; }
      .kind { grid-column: 1; grid-row: 1; margin-top: 2px; }
      .name { grid-column: 2; grid-row: 1; }
      .status { grid-column: 3; grid-row: 1; }
      .elapsed { grid-column: 4; grid-row: 1; }
      .report { grid-column: 2 / -1; grid-row: 2; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; overflow-wrap: anywhere; }
      .command { -webkit-line-clamp: 1; }
      .bash-log { grid-row: 3; }
    }
    @media (prefers-reduced-motion: reduce) { .chevron { transition: none; } }
  `;
}
