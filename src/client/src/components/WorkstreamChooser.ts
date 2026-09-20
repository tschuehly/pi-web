import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { request } from "../api/http";

// Workstream re-entry view backed by the user-local Workbench plugin service.

export interface WorkstreamCheckpoint { id: string; whatChanged: string; remains: string; next: string; nextSessionPrompt: string | null; references?: string[]; recordedAt: string }
export interface WorkstreamSession { id: string; status: string; projectId?: string; workspaceId?: string; latestCheckpoint: WorkstreamCheckpoint | null }
export interface WorkstreamOverview { goal: string; doneWhen: string; description: string; history: string[]; recordedAt: string }
type HumanTaskAnswerKind = "yes-no" | "choice" | "free-text";
type HumanTaskAnswer = { kind: "yes-no" | "choice"; optionId: string } | { kind: "free-text"; text: string };
interface WorkstreamHumanTask {
  id: string; title: string; detail?: string; status: "pending" | "answered" | "resolved";
  answerKind: HumanTaskAnswerKind | null;
  options: { id: string; label: string }[];
  sourceSessionId: string | null;
}
export interface WorkstreamSnapshot {
  id: string; title: string; revision: number; updatedAt: string; closed: boolean;
  sessions: WorkstreamSession[];
  humanTasks: WorkstreamHumanTask[];
  links: { id: string; kind: string; reference: string; label?: string }[];
  overview: WorkstreamOverview | null;
}
interface WorkstreamSummary { id: string; title: string; group: string | null; createdAt: string; updatedAt: string; lastCheckpointAt: string | null; unresolvedHumanTaskCount: number }

export interface OpenWorkstreamSessionDetail {
  workstreamId: string;
  sessionId: string;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  /** Absolute directories from the newest checkpoint, most likely first. */
  directories: string[];
  prompt: string | null;
}

export interface StartWorkstreamSessionDetail {
  workstreamId: string;
  prompt: string;
  directories: string[];
  sessionId: string;
}

const SERVICE = "api/pi-web-plugins/pi-workbench/service";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
function service<T>(operation: string, input: unknown, check: (value: unknown) => value is T): Promise<T> {
  return request<T>(SERVICE, (body) => {
    if (!isRecord(body) || typeof body["ok"] !== "boolean") throw new Error(`Workstream service returned an invalid ${operation} response.`);
    if (!body["ok"]) {
      const failure = body["error"];
      throw new Error(isRecord(failure) && typeof failure["message"] === "string" ? failure["message"] : `Workstream ${operation} failed.`);
    }
    const value: unknown = body["value"];
    if (!check(value)) throw new Error(`Workstream service returned an invalid ${operation} response.`);
    return value;
  }, { method: "POST", body: JSON.stringify({ operation, input }) });
}
const isSummaryList = (value: unknown): value is WorkstreamSummary[] => Array.isArray(value);
const isSnapshot = (value: unknown): value is WorkstreamSnapshot => isRecord(value) && Array.isArray(value["sessions"]) && Array.isArray(value["humanTasks"]);
const isReceipt = (value: unknown): value is { acceptedRevision: number } => isRecord(value) && Number.isInteger(value["acceptedRevision"]);
const newId = (prefix: string): string => {
  const crypto: unknown = Reflect.get(globalThis, "crypto");
  const randomUUID: unknown = isRecord(crypto) ? Reflect.get(crypto, "randomUUID") : undefined;
  const value = typeof randomUUID === "function" ? String(Reflect.apply(randomUUID, crypto, [])) : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
};

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
export const groupMatchesProject = (group: string, project: string | undefined): boolean => project === undefined || normalize(group) === normalize(project);
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

const abbreviation = /(?:\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|vs|etc)|\b[A-Z])\.$/i;
export function sentences(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") return [];
  const result: string[] = [];
  const append = (sentence: string): void => {
    if (sentence.length >= 3) { result.push(sentence); return; }
    const previous = result.pop();
    result.push(previous === undefined ? sentence : `${previous} ${sentence}`);
  };
  let start = 0;
  for (const match of clean.matchAll(/[.;!?](?:\s+|$)/g)) {
    const end = match.index + 1;
    const sentence = clean.slice(start, end).trim();
    if (match[0].startsWith(".") && abbreviation.test(sentence)) continue;
    append(sentence);
    start = match.index + match[0].length;
  }
  const tail = clean.slice(start).trim();
  if (tail !== "") append(tail);
  return result;
}

const anchor = /https?:\/\/[^\s,;!?()[\]{}]*[^\s,.;!?()[\]{}]|[\w.-]+\/[\w.-]+#\d+|~?\/[^\s,;!?()[\]{}]*[^\s,.;!?()[\]{}]|\b[a-f\d]{7,40}\b|#\d+/gi;
export function withAnchors(text: string): TemplateResult {
  const parts: (string | TemplateResult)[] = [];
  let start = 0;
  for (const match of text.matchAll(anchor)) {
    const index = match.index;
    parts.push(text.slice(start, index), html`<code>${match[0]}</code>`);
    start = index + match[0].length;
  }
  parts.push(text.slice(start));
  return html`${parts}`;
}

export function directoriesOf(checkpoint: WorkstreamCheckpoint | undefined): string[] {
  // ponytail: path kind is heuristic because the browser cannot stat local references.
  const absolute = (checkpoint?.references ?? []).filter((ref) => ref.startsWith("/"));
  const files = absolute.filter((ref) => /\.[a-z0-9]{1,5}$/i.test(ref));
  const directories = absolute.filter((ref) => !files.includes(ref));
  if (directories.length > 0) return [...new Set(directories)];
  return [...new Set(files.map((ref) => ref.slice(0, ref.lastIndexOf("/")) || "/"))];
}

@customElement("workstream-chooser")
export class WorkstreamChooser extends LitElement {
  /** PI WEB project name; only Workstream groups equal to it (case- and punctuation-insensitive) are shown. */
  @property() project: string | undefined;
  /** Project names whose Workstreams are hidden here; used by the Other tab to show the rest. */
  @property({ attribute: false }) excludeProjects: string[] = [];
  @state() private summaries: WorkstreamSummary[] = [];
  @state() private selected: WorkstreamSnapshot | undefined;
  @state() private error = "";
  @state() private notice = "";
  @state() private answering = "";
  @state() private loading = true;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const list = await service("list", {}, isSummaryList);
      this.summaries = this.sortedSummaries(list);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  private async select(id: string): Promise<void> {
    this.notice = "";
    if (this.selected?.id === id) { this.selected = undefined; return; }
    try {
      this.selected = await service("inspect", { workstreamId: id }, isSnapshot);
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private sortedSummaries(list: WorkstreamSummary[]): WorkstreamSummary[] {
    return [...list].sort((a, b) => (b.lastCheckpointAt ?? b.createdAt).localeCompare(a.lastCheckpointAt ?? a.createdAt));
  }

  private async answer(snapshot: WorkstreamSnapshot, task: WorkstreamHumanTask, answer: HumanTaskAnswer): Promise<void> {
    if (this.answering !== "") return;
    this.answering = task.id;
    this.notice = "";
    try {
      const idempotencyKey = newId("task-answer");
      const answerId = newId("answer");
      await service("append", {
        workstreamId: snapshot.id,
        expectedRevision: snapshot.revision,
        idempotencyKey,
        records: [{
          type: "human-task.answered",
          producer: "owner",
          ...(task.sourceSessionId === null ? {} : { sourceSessionId: task.sourceSessionId }),
          payload: { taskId: task.id, answerId, answer },
        }],
      }, isReceipt);
    } catch (error) {
      this.error = `The answer may not have been saved. Close and reopen the card before choosing again. ${error instanceof Error ? error.message : String(error)}`;
      this.answering = "";
      return;
    }
    try {
      const [selected, list] = await Promise.all([
        service("inspect", { workstreamId: snapshot.id }, isSnapshot),
        service("list", {}, isSummaryList),
      ]);
      if (this.selected?.id === snapshot.id) {
        this.selected = selected;
        this.error = "";
        this.notice = "Answer recorded.";
        await this.updateComplete;
        this.shadowRoot?.querySelector<HTMLElement>(".card")?.focus();
      }
      this.summaries = this.sortedSummaries(list);
    } catch (error) {
      if (this.selected?.id === snapshot.id) this.error = `Answer was saved, but the Workstream could not be refreshed. Close and reopen the card. ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.answering = "";
    }
  }

  private submitText(event: SubmitEvent, snapshot: WorkstreamSnapshot, task: WorkstreamHumanTask): void {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement)) return;
    const input = event.currentTarget.querySelector("input");
    if (input === null || input.value.trim() === "") {
      input?.setCustomValidity("Enter an answer before submitting.");
      input?.reportValidity();
      return;
    }
    input.setCustomValidity("");
    void this.answer(snapshot, task, { kind: "free-text", text: input.value });
  }

  private answerOption(snapshot: WorkstreamSnapshot, task: WorkstreamHumanTask, optionId: string): void {
    if (task.answerKind !== "yes-no" && task.answerKind !== "choice") return;
    void this.answer(snapshot, task, { kind: task.answerKind, optionId });
  }

  private open(snapshot: WorkstreamSnapshot, session: WorkstreamSession): void {
    const detail: OpenWorkstreamSessionDetail = {
      workstreamId: snapshot.id,
      sessionId: session.id,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      directories: session.latestCheckpoint === null ? [] : directoriesOf(session.latestCheckpoint),
      prompt: session.latestCheckpoint?.nextSessionPrompt ?? null,
    };
    this.dispatchEvent(new CustomEvent<OpenWorkstreamSessionDetail>("open-workstream-session", { detail, bubbles: true, composed: true }));
  }

  private start(snapshot: WorkstreamSnapshot, session: WorkstreamSession & { latestCheckpoint: WorkstreamCheckpoint }, prompt: string): void {
    const detail: StartWorkstreamSessionDetail = {
      workstreamId: snapshot.id,
      prompt,
      directories: directoriesOf(session.latestCheckpoint),
      sessionId: session.id,
    };
    this.dispatchEvent(new CustomEvent<StartWorkstreamSessionDetail>("start-workstream-session", { detail, bubbles: true, composed: true }));
  }

  override render() {
    if (this.loading) return html`<p role="status">Loading Workstreams…</p>`;
    if (this.error !== "" && this.summaries.length === 0) return html`<p class="error" role="alert">${this.error}</p>`;
    const groups = new Map<string, WorkstreamSummary[]>();
    for (const item of this.summaries) {
      const key = item.group ?? "Ungrouped";
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    const mine = sorted.filter(([group]) => groupMatchesProject(group, this.project) && !this.excludeProjects.some((project) => groupMatchesProject(group, project)));
    const renderGroup = ([group, items]: [string, WorkstreamSummary[]]) => html`
      <section class="group" aria-label=${group}>
        <h3>${group} <small>${String(items.length)}</small></h3>
        <div class="list" role="list">
          ${items.map((item) => html`
            <button role="listitem" class="row" aria-pressed=${this.selected?.id === item.id} @click=${() => { void this.select(item.id); }}>
              <strong>${item.title}</strong>
              <small>${item.lastCheckpointAt === null ? "no checkpoint yet" : `worked on ${ago(item.lastCheckpointAt)}`} · started ${ago(item.createdAt)}${item.unresolvedHumanTaskCount > 0 ? html` · <b>${String(item.unresolvedHumanTaskCount)} open question${item.unresolvedHumanTaskCount > 1 ? "s" : ""}</b>` : nothing}</small>
            </button>
            ${this.selected?.id === item.id ? this.renderCard(this.selected) : nothing}
          `)}
        </div>
      </section>`;
    return html`
      ${mine.length === 0 && this.project !== undefined ? html`<p class="missing">No Workstream group is named “${this.project}”. Ask Pi to set the group.</p>` : nothing}
      ${mine.map(renderGroup)}
      ${this.notice === "" ? nothing : html`<p role="status">${this.notice}</p>`}
      ${this.error === "" ? nothing : html`<p class="error" role="alert">${this.error}</p>`}
    `;
  }

  private renderCard(snapshot: WorkstreamSnapshot) {
    const overview = snapshot.overview;
    const [latest, rival] = latestCheckpoints(snapshot);
    const conflict = latest !== undefined && rival !== undefined && conflicting(latest.latestCheckpoint, rival.latestCheckpoint);
    const pending = snapshot.humanTasks.filter((task) => task.status === "pending");
    const nextText = latest?.latestCheckpoint.next ?? pending[0]?.title ?? "No next move recorded.";
    const section = (label: string, peek: string, body: unknown) => html`<details><summary>${label}<span class="peek">${peek}</span></summary><div>${body}</div></details>`;
    const bulletList = (text: string) => html`<ul>${sentences(text).map((sentence) => html`<li>${withAnchors(sentence)}</li>`)}</ul>`;
    const cp = latest?.latestCheckpoint;
    const prompt = cp?.nextSessionPrompt;
    const directories = directoriesOf(cp);
    const sessions = [...latestCheckpoints(snapshot), ...snapshot.sessions.filter((session) => session.latestCheckpoint === null)];
    return html`
      <article class="card" tabindex="-1" aria-label=${`Re-entry card for ${snapshot.title}`}>
        ${overview === null
          ? html`<p class="missing">No overview stored yet. Ask Pi: “write the overview for ${snapshot.id}”.</p>`
          : html`<p class="goal">${overview.goal}<small>Done when: ${overview.doneWhen}</small></p>`}
        <div class="next"><span class="kicker">Do next</span><p><span class="who">${actor(nextText)}</span>${nextText}</p>${cp === undefined ? nothing : html`<small>Last touched ${ago(cp.recordedAt)}</small>`}</div>
        ${conflict ? html`<p class="warn"><b>Two sessions disagree.</b> ${firstClause(latest.latestCheckpoint.whatChanged)} <i>vs.</i> ${firstClause(rival.latestCheckpoint.whatChanged)}</p>` : nothing}
        ${pending.length > 0 ? html`<p class="warn"><b>${pending.length} open question${pending.length > 1 ? "s" : ""} for Thomas:</b> ${pending.map((task) => task.title).join(" · ")}</p>` : nothing}
        ${pending.length === 0 ? nothing : section("Questions", `${String(pending.length)} awaiting an answer`, html`
          <div class="task-list">
            ${pending.map((task) => html`
              <article class="task" data-task-id=${task.id}>
                <b>${task.title}</b>
                ${task.detail === undefined ? nothing : html`<p>${task.detail}</p>`}
                ${task.answerKind === "free-text" ? html`
                  <form @submit=${(event: SubmitEvent) => { this.submitText(event, snapshot, task); }}>
                    <input aria-label=${`Answer ${task.title}`} ?disabled=${snapshot.closed || this.answering !== ""} @input=${(event: InputEvent) => { if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.setCustomValidity(""); }}>
                    <button type="submit" ?disabled=${snapshot.closed || this.answering !== ""}>Answer</button>
                  </form>
                ` : task.answerKind === "yes-no" || task.answerKind === "choice" ? html`
                  <div class="task-options" role="group" aria-label=${task.title}>
                    ${task.options.map((option) => html`<button ?disabled=${snapshot.closed || this.answering !== ""} @click=${() => { this.answerOption(snapshot, task, option.id); }}>${option.label}</button>`)}
                  </div>
                ` : html`<small>This legacy task cannot be answered here.</small>`}
              </article>
            `)}
          </div>
        `)}
        ${cp === undefined ? nothing : section("Now", firstClause(cp.whatChanged), html`
          ${bulletList(cp.whatChanged)}
          <div class="now-block"><b>Still open:</b>${bulletList(cp.remains)}</div>
          ${conflict ? html`<div class="now-block"><b>Other session:</b>${bulletList(rival.latestCheckpoint.whatChanged)}</div>` : nothing}
        `)}
        ${overview === null ? nothing : section("So far", `${String(overview.history.length)} steps · ${firstClause(overview.history.at(-1) ?? "", 70)}`, html`<ol>${overview.history.map((event) => html`<li>${event}</li>`)}</ol>`)}
        ${overview === null ? nothing : section("About", firstClause(overview.description, 90), html`<p>${overview.description}</p>`)}
        ${cp === undefined ? nothing : section("Continue", directories[0]?.replace(/^\/Users\/[^/]+/, "~") ?? "no directory recorded", html`
          ${directories.map((directory) => html`<code>${directory}</code>`)}
          ${cp.nextSessionPrompt === null ? nothing : html`<p class="prompt">${cp.nextSessionPrompt}</p>`}
        `)}
        ${section("Sessions", `${String(sessions.length)} sessions · newest ${cp === undefined ? "no checkpoint" : ago(cp.recordedAt)}`, html`
          <div class="session-list">
            ${sessions.map((session) => html`
              <button class="session-row" data-session-id=${session.id} @click=${() => { this.open(snapshot, session); }}>
                <span class="session-meta">
                  <span>${session.latestCheckpoint === null ? "no checkpoint" : ago(session.latestCheckpoint.recordedAt)}</span>
                  ${session.status === "active" ? nothing : html`<span class="status">${session.status}</span>`}
                </span>
                <span class="session-summary">${session.latestCheckpoint === null ? session.id.slice(-8) : firstClause(session.latestCheckpoint.whatChanged, 90)}</span>
              </button>
            `)}
          </div>
        `)}
        <div class="actions">
          ${latest === undefined ? html`<p class="missing">No session has checkpointed yet.</p>` : html`<button class="primary" @click=${() => { this.open(snapshot, latest); }}>Open session</button>`}
          ${latest === undefined || prompt === undefined || prompt === null ? nothing : html`<button @click=${() => { this.start(snapshot, latest, prompt); }}>New session with prompt</button>`}
        </div>
      </article>
    `;
  }

  static override styles = css`
    :host { display: grid; gap: 10px; min-width: 0; max-width: 100%; }
    * { box-sizing: border-box; min-width: 0; }
    .card p, .card li, .goal, .next p, .warn { overflow-wrap: anywhere; }
    .card p, .card ul, .card ol { max-width: 65ch; }
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
    details > div { display: grid; gap: 10px; padding: 0 12px 10px 28px; font-size: 14px; line-height: 1.55; }
    details ol, details ul { margin: 0; padding-left: 18px; }
    details li + li { margin-top: 6px; }
    .now-block, .task-list, .task { display: grid; gap: 6px; }
    .task + .task { border-top: 1px solid var(--pi-border); padding-top: 10px; }
    .task p, .task small { color: var(--pi-muted); }
    .task form, .task-options { display: flex; gap: 6px; flex-wrap: wrap; }
    .task input { flex: 1 1 220px; min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: 8px 10px; font: inherit; }
    code { font-size: 12px; overflow-wrap: anywhere; }
    .prompt { padding: 8px 10px; border: 1px dashed var(--pi-border); border-radius: 6px; color: var(--pi-muted); font-size: 12px; }
    .session-list { display: grid; gap: 4px; }
    .session-row { width: 100%; min-width: 0; display: grid; gap: 4px; padding: 6px 8px; font-size: 13px; }
    .session-meta { display: flex; align-items: center; gap: 4px; color: var(--pi-muted); font-size: 11px; }
    .status { padding: 0 5px; border: 1px solid var(--pi-border); border-radius: 999px; }
    .session-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .primary { border-color: var(--pi-success-border); background: var(--pi-success-bg); font-weight: 700; }
    .missing, .error { color: var(--pi-muted); font-size: 13px; }
    .error { color: var(--pi-danger); }
  `;
}
