import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, type SessionInfo } from "../api";

@customElement("all-sessions")
export class AllSessions extends LitElement {
  @state() private sessions: SessionInfo[] = [];
  @state() private query = "";
  @state() private showAgentSessions = false;
  @state() private loading = true;
  @state() private error = "";

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.sessions = [...await api.recent(300)].sort((a, b) => b.modified.localeCompare(a.modified));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private open(session: SessionInfo): void {
    this.dispatchEvent(new CustomEvent<SessionInfo>("open-session", { detail: session, bubbles: true, composed: true }));
  }

  override render() {
    if (this.loading) return html`<p role="status">Loading sessions…</p>`;
    if (this.error !== "") return html`<p class="error" role="alert">${this.error}</p>`;
    const agentSessionCount = this.sessions.filter((session) => isAgentSession(session) || isChildSession(session)).length;
    const needle = this.query.trim().toLowerCase();
    const visible = this.sessions.filter((session) => (this.showAgentSessions || (!isAgentSession(session) && !isChildSession(session))) && matchesSearch(session, needle));
    const groups = new Map<string, SessionInfo[]>();
    for (const session of visible) {
      const label = dayLabel(session.modified);
      groups.set(label, [...(groups.get(label) ?? []), session]);
    }
    return html`
      <div class="tools">
        <input type="search" aria-label="Search sessions" placeholder="Search sessions" .value=${this.query} @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.query = event.target.value; }}>
        ${agentSessionCount === 0 ? nothing : html`
          <label><input type="checkbox" aria-label="Show agent sessions" .checked=${this.showAgentSessions} @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.showAgentSessions = event.target.checked; }}> Show agent sessions (${String(agentSessionCount)})</label>
        `}
      </div>
      ${visible.length === 0 ? html`<p>No sessions found.</p>` : [...groups].map(([label, sessions]) => html`
        <section aria-label=${label}>
          <h2>${label}</h2>
          <div class="list">
            ${sessions.map((session) => html`
              <button class="row" @click=${() => { this.open(session); }}>
                <strong>${sessionTitle(session)}</strong>
                <span>${shortenHome(session.cwd)}</span>
                <small>${modifiedTime(session.modified)} · ${String(session.messageCount)} messages</small>
              </button>
            `)}
          </div>
        </section>
      `)}
    `;
  }

  static override styles = css`
    :host { display: grid; gap: 12px; min-width: 0; max-width: 100%; }
    * { box-sizing: border-box; min-width: 0; }
    .tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    input[type="search"] { flex: 1 1 280px; min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: var(--pi-control-padding-block) var(--pi-control-padding-inline); font: inherit; }
    input:focus-visible, button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    label { display: flex; gap: 6px; align-items: center; color: var(--pi-muted); font-size: 12px; }
    section, .list { display: grid; gap: 6px; }
    h2 { margin: 0; color: var(--pi-muted); font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
    button { width: 100%; min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 12px; font: inherit; text-align: left; cursor: pointer; }
    button:hover { background: var(--pi-surface-hover); }
    .row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto; gap: 8px 12px; align-items: baseline; }
    .row strong, .row span, .row small { overflow-wrap: anywhere; }
    .row span, .row small, p { color: var(--pi-muted); }
    p { margin: 0; }
    .error { color: var(--pi-danger); }
    @media (max-width: 600px) { .row { grid-template-columns: 1fr; gap: 3px; } }
  `;
}

function isAgentSession(session: SessionInfo): boolean {
  return session.name?.startsWith("workbench-") === true;
}

function isChildSession(session: SessionInfo): boolean {
  return session.parentSessionPath !== undefined;
}

function matchesSearch(session: SessionInfo, needle: string): boolean {
  if (needle === "") return true;
  return [session.name ?? "", session.firstMessage, session.cwd, session.id].some((value) => value.toLowerCase().includes(needle));
}

function sessionTitle(session: SessionInfo): string {
  return session.name !== undefined && session.name !== "" ? session.name : session.firstMessage === "" ? session.id : session.firstMessage;
}

function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/u, "~");
}

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yesterday = new Date(start);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === start.getTime()) return "Today";
  if (day === yesterday.getTime()) return "Yesterday";
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function modifiedTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
