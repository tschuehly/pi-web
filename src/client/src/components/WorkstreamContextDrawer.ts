import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { appendWorkstream, inspectWorkstream, latestCheckpoints, type WorkstreamAppendInput, type WorkstreamServiceContext, type WorkstreamSnapshot } from "./WorkstreamChooser";
import { WORKSTREAM_TINT_PERCENTAGES, workstreamAccentColor, workstreamMonogram } from "../workstreamColor";

const checkpointFields: { name: "whatChanged" | "remains" | "next" | "nextSessionPrompt"; label: string; max: number }[] = [
  { name: "whatChanged", label: "What changed", max: 4000 },
  { name: "remains", label: "What remains", max: 4000 },
  { name: "next", label: "Next action", max: 4000 },
  { name: "nextSessionPrompt", label: "Next session prompt", max: 2000 },
];

@customElement("workstream-context-drawer")
export class WorkstreamContextDrawer extends LitElement {
  @property({ attribute: false }) snapshot: WorkstreamSnapshot | null | undefined;
  @property() error = "";
  @property() fallbackTitle = "";
  @property({ attribute: false }) serviceContext: WorkstreamServiceContext | undefined;
  @property() sessionId = "";
  @state() private editing = false;
  @state() private saving = false;
  @state() private message = "";
  @state() private conflict = false;
  private draft: { title: string; whatChanged: string; remains: string; next: string; nextSessionPrompt: string } | undefined;
  private base: WorkstreamSnapshot | undefined;
  private pending: WorkstreamAppendInput | undefined;

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("snapshot") && this.base && this.snapshot?.id !== this.base.id) {
      this.editing = false;
      this.base = undefined;
      this.pending = undefined;
      this.message = "";
    }
  }

  private openEditor(): void {
    if (!this.snapshot || this.snapshot.closed) return;
    this.base = this.snapshot;
    const checkpoint = latestCheckpoints(this.snapshot)[0]?.latestCheckpoint;
    this.draft = { title: this.snapshot.title, whatChanged: checkpoint?.whatChanged ?? "", remains: checkpoint?.remains ?? "", next: checkpoint?.next ?? "", nextSessionPrompt: checkpoint?.nextSessionPrompt ?? "" };
    this.editing = true;
    this.conflict = false;
    this.pending = undefined;
    this.message = "";
    void this.updateComplete.then(() => this.shadowRoot?.querySelector<HTMLInputElement>("#workstream-title")?.focus());
  }

  private cancel(): void {
    if (this.saving) return;
    if (this.dirty && !window.confirm("You have unsaved changes. Discard?")) return;
    this.editing = false;
    this.pending = undefined;
    this.message = "";
  }

  private get dirty(): boolean {
    const cp = this.base && latestCheckpoints(this.base)[0]?.latestCheckpoint;
    const d = this.draft;
    return !!d && !!this.base && (d.title !== this.base.title || d.whatChanged !== (cp?.whatChanged ?? "") || d.remains !== (cp?.remains ?? "") || d.next !== (cp?.next ?? "") || d.nextSessionPrompt !== (cp?.nextSessionPrompt ?? ""));
  }

  private change(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || !this.draft) return;
    const name = input.name;
    if (name === "title" || checkpointFields.some((field) => field.name === name)) this.draft = { ...this.draft, [name]: input.value };
    // A changed draft is a new operation; the old operation remains available only for an exact retry.
    this.pending = undefined;
    this.requestUpdate();
  }

  private get invalidCheckpoint(): boolean {
    const draft = this.draft;
    if (!draft) return false;
    const old = this.base && latestCheckpoints(this.base)[0]?.latestCheckpoint;
    const changed = checkpointFields.some(({ name }) => draft[name] !== (old?.[name] ?? ""));
    return changed && checkpointFields.some(({ name, max }) => draft[name].trim() === "" || draft[name].length > max);
  }

  private async reload(): Promise<void> {
    if (!this.base || !this.serviceContext) return;
    if (!this.conflict && this.dirty && !window.confirm("Reload and discard your unsaved changes?")) return;
    try {
      const snapshot = await inspectWorkstream(this.serviceContext, this.base.id);
      this.snapshot = snapshot;
      this.dispatchEvent(new CustomEvent("workstream-updated", { detail: snapshot, bubbles: true, composed: true }));
      this.openEditor();
    } catch (error) { this.message = `Could not reload Workstream: ${String(error)}`; }
  }

  private async save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.saving || !this.base || !this.draft || !this.serviceContext || !this.dirty || this.conflict) return;
    const d = this.draft;
    const titleError = d.title.trim() === "" ? "Enter a title." : d.title.length > 200 ? "Title must be at most 200 characters." : "";
    const fields = [d.whatChanged, d.remains, d.next, d.nextSessionPrompt];
    const old = latestCheckpoints(this.base)[0]?.latestCheckpoint;
    const checkpointChanged = d.whatChanged !== (old?.whatChanged ?? "") || d.remains !== (old?.remains ?? "") || d.next !== (old?.next ?? "") || d.nextSessionPrompt !== (old?.nextSessionPrompt ?? "");
    if (titleError || (checkpointChanged && (fields.some((value) => !value.trim()) || fields.slice(0, 3).some((value) => value.length > 4000) || d.nextSessionPrompt.length > 2000))) { this.message = titleError || "Complete all checkpoint fields (4,000 characters each; prompt 2,000)."; return; }
    const source = latestCheckpoints(this.base).find((session) => session.status === "active") ?? this.base.sessions.find((session) => session.id === this.sessionId && session.status === "active");
    if (checkpointChanged && !source) { this.message = "An active Workstream session is required to replace a checkpoint."; return; }
    this.saving = true;
    this.message = "";
    try {
      // Preflight gives an actionable conflict before append; the Store's expectedRevision is authoritative.
      const current = this.pending ? this.base : await inspectWorkstream(this.serviceContext, this.base.id);
      if (current.revision !== this.base.revision) { this.conflict = true; this.message = "Workstream changed elsewhere. Reload to review the latest version; your draft is preserved."; return; }
      const records: WorkstreamAppendInput["records"] = [];
      if (d.title !== this.base.title) records.push({ type: "title.set", producer: "owner", ...(this.sessionId ? { sourceSessionId: this.sessionId } : {}), payload: { title: d.title } });
      if (checkpointChanged && source) records.push({ type: "checkpoint.replaced", producer: "owner", sourceSessionId: source.id, payload: { sessionId: source.id, checkpoint: { id: crypto.randomUUID(), whatChanged: d.whatChanged, remains: d.remains, next: d.next, nextSessionPrompt: d.nextSessionPrompt, ...(old?.references ? { references: old.references } : {}) } } });
      this.pending ??= { workstreamId: this.base.id, expectedRevision: this.base.revision, idempotencyKey: crypto.randomUUID(), records };
      await appendWorkstream(this.serviceContext, this.pending);
      const saved = await inspectWorkstream(this.serviceContext, this.base.id);
      this.pending = undefined;
      this.editing = false;
      this.snapshot = saved;
      this.dispatchEvent(new CustomEvent("workstream-updated", { detail: saved, bubbles: true, composed: true }));
      this.message = "Workstream saved.";
    } catch (error) {
      if (/expected revision \d+, current revision is \d+/.test(String(error))) {
        this.conflict = true;
        this.pending = undefined;
        this.message = "Workstream changed elsewhere. Reload to review the latest version; your draft is preserved.";
      } else {
        this.message = `Save may not have completed. Retry the same update or reload to check it. ${String(error)}`;
      }
    } finally { this.saving = false; }
  }

  override render() {
    if (this.error !== "") return html`<div class="tab unavailable" role="status" title=${this.error}>Workstream unavailable</div>`;
    if (this.snapshot === undefined) return html`<div class="tab unavailable" role="status">Finding Workstream…</div>`;
    if (this.snapshot === null) return html`<div class="tab unavailable" title=${this.fallbackTitle}><span class="fallback-title">${this.fallbackTitle}</span></div>`;

    const overview = this.snapshot.overview;
    const checkpoint = latestCheckpoints(this.snapshot)[0]?.latestCheckpoint;
    return html`
      <details style=${`--workstream-color:${workstreamAccentColor(this.snapshot.id)}`}>
        <summary><span class="identity-mark" aria-hidden="true">${workstreamMonogram(this.snapshot.title)}</span><span class="context-label">Workstream</span><strong>${this.snapshot.title}</strong></summary>
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
          ${this.snapshot.closed || !this.serviceContext ? nothing : html`<button type="button" @click=${() => { this.openEditor(); }}>Edit Workstream</button>`}
          ${this.editing && this.draft ? html`
            <form @submit=${(event: SubmitEvent) => { void this.save(event); }} @input=${(event: Event) => { this.change(event); }} @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); this.cancel(); } else if (event.key === "s" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.shadowRoot?.querySelector<HTMLFormElement>("form")?.requestSubmit(); } }}>
              <label for="workstream-title">Title</label>
              <input id="workstream-title" name="title" .value=${this.draft.title} aria-describedby="title-error" ?disabled=${this.saving || this.pending !== undefined}>
              <small id="title-error" class="error">${!this.draft.title.trim() ? "Enter a title." : this.draft.title.length > 200 ? "Title must be at most 200 characters." : ""}</small>
              <p>Checkpoint · owner correction${checkpoint ? ` of latest checkpoint (${checkpoint.recordedAt})` : " (new)"}</p>
              ${checkpointFields.map(({ name, label, max }) => html`
                <label for=${name}>${label}</label><textarea id=${name} name=${name} maxlength=${max} .value=${this.draft?.[name] ?? ""} ?disabled=${this.saving || this.pending !== undefined}></textarea>
              `)}
              ${this.invalidCheckpoint ? html`<small class="error" role="alert">Complete all four checkpoint fields (4,000 characters; prompt 2,000).</small>` : nothing}
              ${this.conflict || (this.pending !== undefined && this.message !== "") ? html`<button type="button" @click=${() => { void this.reload(); }}>Reload Workstream</button>` : nothing}
              <div class="actions"><button type="submit" ?disabled=${this.saving || this.conflict || !this.dirty || !this.draft.title.trim() || this.draft.title.length > 200 || this.invalidCheckpoint}>${this.saving ? "Saving…" : "Save"}</button><button type="button" @click=${() => { this.cancel(); }}>Cancel</button></div>
            </form>
          ` : nothing}
          ${this.message ? html`<p role="alert">${this.message}</p>` : nothing}
        </div>
      </details>
    `;
  }

  static override styles = css`
    :host { position: static; display: block; min-width: 0; color: var(--pi-text); }
    * { box-sizing: border-box; min-width: 0; }
    details { position: static; border-left: 3px solid var(--workstream-color, transparent); }
    summary, .tab { min-height: 32px; display: flex; align-items: center; gap: 8px; }
    summary { padding: 0 10px; border: 1px solid var(--pi-border); border-radius: 8px; background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.drawer}%, var(--pi-surface)); list-style: none; cursor: pointer; }
    summary:hover { background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.drawerActive}%, var(--pi-surface-hover)); }
    details[open] summary { background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.drawerActive}%, var(--pi-surface-hover)); }
    summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: "↓"; flex: 0 0 auto; color: var(--pi-text); }
    details[open] summary::after { content: "↑"; }
    .context-label { flex: 0 0 auto; color: var(--pi-text); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    .identity-mark { flex: 0 0 auto; display: inline-grid; place-items: center; width: 28px; height: 24px; border: 2px solid var(--pi-text); border-radius: 7px 7px 3px 7px; background: color-mix(in srgb, var(--workstream-color) ${WORKSTREAM_TINT_PERCENTAGES.mark}%, var(--pi-surface)); color: var(--pi-text); font-size: 10px; font-weight: 850; letter-spacing: .03em; line-height: 1; }
    summary strong { flex: 1 1 auto; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
    .tab { overflow: hidden; padding: 0; border: 0; background: transparent; color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
    .fallback-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sheet { --sheet-tint: color-mix(in srgb, var(--pi-purple-surface) 36%, transparent); --sheet-paint: linear-gradient(var(--sheet-tint), var(--sheet-tint)); position: absolute; top: 100%; left: 0; right: 0; max-height: calc(var(--pi-workbench-viewport-height, 100vh) - 56px); overflow: auto; display: grid; padding: 20px max(24px, calc((100% - 900px) / 2)); border-bottom: 1px solid var(--pi-purple-border); background: var(--sheet-paint) var(--pi-surface); box-shadow: 0 18px 48px var(--pi-shadow); }
    button, input, textarea { font: inherit; color: var(--pi-text); background: var(--pi-surface); border: 1px solid var(--pi-border); border-radius: 6px; padding: 8px; }
    button { cursor: pointer; }
    :is(button, input, textarea):focus-visible { outline: 2px solid var(--pi-accent); }
    form { display: grid; gap: 8px; padding: 16px 0; }
    form label { font-weight: 700; }
    textarea { width: 100%; min-height: 64px; resize: vertical; }
    .actions { display: flex; gap: 8px; }
    .error { color: var(--pi-danger); }
    .row { position: relative; padding: 18px 0 12px; border-top: 1px solid var(--pi-border-muted); }
    .label { position: absolute; top: 0; left: 0; padding-right: 10px; color: var(--pi-text); background: var(--sheet-paint) var(--pi-surface); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; transform: translateY(-50%); }
    p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
    .goal { width: 100%; font-size: 18px; font-weight: 750; line-height: 1.35; }
    .about p { color: var(--pi-text); }
    .next { margin: 8px 0 4px; padding: 18px 12px 12px; border: 1px solid var(--pi-success-border); border-radius: 9px; background: linear-gradient(var(--pi-success-bg), var(--pi-success-bg)), var(--sheet-paint) var(--pi-surface); }
    .next .label { left: 12px; background: linear-gradient(var(--pi-success-bg), var(--pi-success-bg)), var(--sheet-paint) var(--pi-surface); }
    @media (forced-colors: active) {
      details { border-left-color: LinkText; }
      summary { background: Canvas; }
      details[open] summary { border-color: Highlight; }
      .identity-mark { border-color: ButtonText; background: Canvas; color: CanvasText; }
    }
    @media (max-width: 520px) {
      .context-label { display: none; }
      .sheet { padding: 12px 16px; }
      .goal { font-size: 16px; }
    }
  `;
}
