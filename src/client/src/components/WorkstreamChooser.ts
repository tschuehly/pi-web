import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { request } from "../api/http";

// Read-only view of the user-local Workstream Store through the Workbench plugin service.
// It never mutates the store; the agent keeps writing overviews and checkpoints.

export interface WorkstreamCheckpoint { id: string; whatChanged: string; remains: string; next: string; nextSessionPrompt: string | null; references?: string[]; recordedAt: string }
export interface WorkstreamSession { id: string; status: string; projectId?: string; workspaceId?: string; latestCheckpoint: WorkstreamCheckpoint | null }
export interface WorkstreamOverview { goal: string; doneWhen: string; description: string; history: string[]; recordedAt: string }
export interface WorkstreamSnapshot {
  id: string; title: string; revision: number; updatedAt: string; closed: boolean;
  sessions: WorkstreamSession[];
  humanTasks: { id: string; title: string; status: string }[];
  links: { id: string; kind: string; reference: string; label?: string }[];
  overview: WorkstreamOverview | null;
}
interface WorkstreamSummary { id: string; title: string; group: string | null; updatedAt: string; unresolvedHumanTaskCount: number }

export interface OpenWorkstreamSessionDetail {
  workstreamId: string;
  sessionId: string;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  /** Absolute directories from the newest checkpoint, most likely first. */
  directories: string[];
  prompt: string | null;
}

const SERVICE = "api/pi-web-plugins/pi-workbench/service";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
function service<T>(operation: string, input: unknown, check: (value: unknown) => value is T): Promise<T> {
  return request<T>(SERVICE, (body) => {
    const value: unknown = isRecord(body) && body["ok"] === true ? body["value"] : undefined;
    if (!check(value)) throw new Error(`Workstream service returned an invalid ${operation} response.`);
    return value;
  }, { method: "POST", body: JSON.stringify({ operation, input }) });
}
const isSummaryList = (value: unknown): value is WorkstreamSummary[] => Array.isArray(value);
const isSnapshot = (value: unknown): value is WorkstreamSnapshot => isRecord(value) && Array.isArray(value["sessions"]);

export const ago = (value: string, now = Date.now()): string => {
  const hours = Math.round((now - new Date(value).getTime()) / 36e5);
  return hours < 1 ? "just now" : hours < 24 ? `${String(hours)} h ago` : `${String(Math.round(hours / 24))} d ago`;
};
export const actor = (text: string): string => (/^\s*(Thomas|Rod|Pia)\b/.exec(text) ?? [])[1] ?? (/\bThomas\b/.test(text) ? "Thomas" : "Pia");
export const firstClause = (text: string, max = 110): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = new RegExp(`^(.{1,${String(max)}}?[.;:])(\\s|$)`).exec(clean);
  const cut = match?.[1] ?? clean.slice(0, max);
  return cut + (cut.length < clean.length ? "…" : "");
};

/** Newest checkpoint per session, newest first. Two sessions within 36 h count as a conflict. */
export function latestCheckpoints(snapshot: WorkstreamSnapshot): (WorkstreamSession & { latestCheckpoint: WorkstreamCheckpoint })[] {
  return snapshot.sessions
    .filter((session): session is WorkstreamSession & { latestCheckpoint: WorkstreamCheckpoint } => session.latestCheckpoint !== null)
    .sort((a, b) => b.latestCheckpoint.recordedAt.localeCompare(a.latestCheckpoint.recordedAt));
}
export const conflicting = (a: WorkstreamCheckpoint, b: WorkstreamCheckpoint): boolean => Math.abs(new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()) < 36 * 36e5;
export const directoriesOf = (checkpoint: WorkstreamCheckpoint | undefined): string[] =>
  [...new Set((checkpoint?.references ?? []).filter((ref) => ref.startsWith("/") && !/\.[a-z0-9]{1,5}$/i.test(ref)))];

@customElement("workstream-chooser")
export class WorkstreamChooser extends LitElement {
  @state() private summaries: WorkstreamSummary[] = [];
  @state() private selected: WorkstreamSnapshot | undefined;
  @state() private error = "";
  @state() private loading = true;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const list = await service("list", {}, isSummaryList);
      this.summaries = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private async select(id: string): Promise<void> {
    if (this.selected?.id === id) { this.selected = undefined; return; }
    try {
      this.selected = await service("inspect", { workstreamId: id }, isSnapshot);
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private open(snapshot: WorkstreamSnapshot, session: WorkstreamSession & { latestCheckpoint: WorkstreamCheckpoint }): void {
    const detail: OpenWorkstreamSessionDetail = {
      workstreamId: snapshot.id,
      sessionId: session.id,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      directories: directoriesOf(session.latestCheckpoint),
      prompt: session.latestCheckpoint.nextSessionPrompt,
    };
    this.dispatchEvent(new CustomEvent<OpenWorkstreamSessionDetail>("open-workstream-session", { detail, bubbles: true, composed: true }));
  }

  override render() {
    if (this.loading) return html`<p role="status">Loading Workstreams…</p>`;
    if (this.error !== "" && this.summaries.length === 0) return html`<p class="error" role="alert">${this.error}</p>`;
    const groups = new Map<string, WorkstreamSummary[]>();
    for (const item of this.summaries) {
      const key = item.group ?? "Ungrouped";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return html`
      <h2>Continue a Workstream</h2>
      ${[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => html`
        <section class="group" aria-label=${group}>
          <h3>${group} <small>${String(items.length)}</small></h3>
          <div class="list" role="list">
            ${items.map((item) => html`
              <button role="listitem" class="row" aria-pressed=${this.selected?.id === item.id} @click=${() => { void this.select(item.id); }}>
                <strong>${item.title}</strong>
                <small>${ago(item.updatedAt)}${item.unresolvedHumanTaskCount > 0 ? html` · <b>${String(item.unresolvedHumanTaskCount)} open question${item.unresolvedHumanTaskCount > 1 ? "s" : ""}</b>` : nothing}</small>
              </button>
              ${this.selected?.id === item.id ? this.renderCard(this.selected) : nothing}
            `)}
          </div>
        </section>
      `)}
      ${this.error === "" ? nothing : html`<p class="error" role="alert">${this.error}</p>`}
    `;
  }

  private renderCard(snapshot: WorkstreamSnapshot) {
    const overview = snapshot.overview;
    const [latest, rival] = latestCheckpoints(snapshot);
    const conflict = latest !== undefined && rival !== undefined && conflicting(latest.latestCheckpoint, rival.latestCheckpoint);
    const pending = snapshot.humanTasks.filter((task) => task.status !== "resolved");
    const nextText = latest?.latestCheckpoint.next ?? pending[0]?.title ?? "No next move recorded.";
    const section = (label: string, peek: string, body: unknown) => html`<details><summary>${label}<span class="peek">${peek}</span></summary><div>${body}</div></details>`;
    const cp = latest?.latestCheckpoint;
    const directories = directoriesOf(cp);
    return html`
      <article class="card" aria-label=${`Re-entry card for ${snapshot.title}`}>
        ${overview === null
          ? html`<p class="missing">No overview stored yet. Ask Pi: “write the overview for ${snapshot.id}”.</p>`
          : html`<p class="goal">${overview.goal}<small>Done when: ${overview.doneWhen}</small></p>`}
        <div class="next"><span class="kicker">Do next</span><p><span class="who">${actor(nextText)}</span>${nextText}</p>${cp === undefined ? nothing : html`<small>Last touched ${ago(cp.recordedAt)}</small>`}</div>
        ${conflict ? html`<p class="warn"><b>Two sessions disagree.</b> ${firstClause(latest.latestCheckpoint.whatChanged)} <i>vs.</i> ${firstClause(rival.latestCheckpoint.whatChanged)}</p>` : nothing}
        ${pending.length > 0 ? html`<p class="warn"><b>${pending.length} open question${pending.length > 1 ? "s" : ""} for Thomas:</b> ${pending.map((task) => task.title).join(" · ")}</p>` : nothing}
        ${cp === undefined ? nothing : section("Now", firstClause(cp.whatChanged), html`<p>${cp.whatChanged}</p><p><b>Still open:</b> ${cp.remains}</p>${conflict ? html`<p><b>Other session:</b> ${rival.latestCheckpoint.whatChanged}</p>` : nothing}`)}
        ${overview === null ? nothing : section("So far", `${String(overview.history.length)} steps · ${firstClause(overview.history.at(-1) ?? "", 70)}`, html`<ol>${overview.history.map((event) => html`<li>${event}</li>`)}</ol>`)}
        ${overview === null ? nothing : section("About", firstClause(overview.description, 90), html`<p>${overview.description}</p>`)}
        ${cp === undefined ? nothing : section("Continue", directories[0]?.replace(/^\/Users\/[^/]+/, "~") ?? "no directory recorded", html`
          ${directories.map((directory) => html`<code>${directory}</code>`)}
          ${cp.nextSessionPrompt === null ? nothing : html`<p class="prompt">${cp.nextSessionPrompt}</p>`}
        `)}
        <div class="actions">
          ${latest === undefined ? html`<p class="missing">No session has checkpointed yet.</p>` : html`<button class="primary" @click=${() => { this.open(snapshot, latest); }}>Open session</button>`}
          ${cp?.nextSessionPrompt === undefined || cp.nextSessionPrompt === null ? nothing : html`<button @click=${() => { void navigator.clipboard.writeText(cp.nextSessionPrompt ?? ""); }}>Copy prompt</button>`}
        </div>
      </article>
    `;
  }

  static override styles = css`
    :host { display: grid; gap: 10px; min-width: 0; max-width: 100%; }
    * { box-sizing: border-box; min-width: 0; }
    .card p, .card li, .goal, .next p, .warn { overflow-wrap: anywhere; }
    .row { width: 100%; }
    h2 { margin: 0; font-size: 16px; }
    .group { display: grid; gap: 6px; }
    h3 { margin: 6px 0 0; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--pi-muted); }
    h3 small { font-weight: 500; }
    p { margin: 0; line-height: 1.45; }
    .list { display: grid; gap: 6px; }
    button { box-sizing: border-box; min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 12px; font: inherit; text-align: left; cursor: pointer; }
    button:hover { background: var(--pi-surface-hover); }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .row { display: grid; gap: 2px; }
    .row[aria-pressed="true"] { border-color: var(--pi-accent); }
    .row small { color: var(--pi-muted); }
    .row small b { color: var(--pi-danger); }
    .card { display: grid; gap: 8px; margin: 2px 0 8px; padding: 12px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); }
    .goal { font-weight: 700; font-size: 15px; }
    .goal small { display: block; margin-top: 2px; font-weight: 500; color: var(--pi-muted); font-size: 12px; }
    .next { display: grid; gap: 4px; padding: 12px 14px; border-radius: 10px; background: var(--pi-accent); color: white; }
    .kicker { font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; opacity: .85; }
    .who { display: inline-block; margin-right: 8px; padding: 1px 8px; border-radius: 999px; background: white; color: var(--pi-accent); font-size: 11px; font-weight: 800; }
    .next p { font-size: 15px; }
    .next small { font-size: 11px; opacity: .8; }
    .warn { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--pi-purple-border); background: var(--pi-purple-surface); font-size: 13px; }
    details { border: 1px solid var(--pi-border); border-radius: 8px; }
    summary { display: flex; gap: 8px; align-items: baseline; padding: 8px 12px; font-weight: 700; font-size: 13px; cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: "▸"; color: var(--pi-muted); }
    details[open] summary::before { content: "▾"; }
    .peek { flex: 1; min-width: 0; font-weight: 500; color: var(--pi-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    details > div { display: grid; gap: 6px; padding: 0 12px 10px 28px; font-size: 13px; }
    details ol { margin: 0; padding-left: 18px; }
    code { font-size: 12px; overflow-wrap: anywhere; }
    .prompt { padding: 8px 10px; border: 1px dashed var(--pi-border); border-radius: 6px; color: var(--pi-muted); font-size: 12px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .primary { border-color: var(--pi-success-border); background: var(--pi-success-bg); font-weight: 700; }
    .missing, .error { color: var(--pi-muted); font-size: 13px; }
    .error { color: var(--pi-danger); }
  `;
}
