import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api, type FileContentResponse, type Workspace } from "../api";
import { HttpRequestError } from "../api/http";
import { markdownWorkspaceContext } from "../formatting/workspaceLinks";
import { workspaceFilePreviewUrl } from "../api/urls";
import { MAX_INLINE_PREVIEW_BYTES } from "../../../shared/workspaceFiles";
import "./ModalSurface";
import "./FormattedText";

const isMarkdown = (path: string): boolean => /\.(?:md|markdown)$/i.test(path);

/** One file surface for selection, preview, editing, and the loaded revision. */
@customElement("workbench-files-pane")
export class WorkbenchFilesPane extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property() machineId = "local";
  @state() private entries: string[] = [];
  @state() private query = "";
  @state() private cursor: string | null = null;
  @state() private selectedIndex = 0;
  private searchTimer: number | undefined;
  @state() private searching = false;
  @state() private pickerOpen = false;
  @state() private searchNotice = "";
  @state() private selectedPath = "";
  @state() private loaded: FileContentResponse | undefined;
  @state() private buffer = "";
  @state() private mode: "preview" | "edit" = "preview";
  @state() private loading = false;
  @state() private saving = false;
  @state() private error = "";
  @state() private conflict = false;
  private scope = "";
  private readSequence = 0;
  private treeSequence = 0;
  private searchController: AbortController | undefined;

  private get dirty(): boolean { return this.loaded !== undefined && !this.loaded.binary && !this.loaded.truncated && this.buffer !== this.loaded.content; }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.preventDirtyUnload);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("beforeunload", this.preventDirtyUnload);
    ++this.readSequence;
    ++this.treeSequence;
    this.searchController?.abort();
    window.clearTimeout(this.searchTimer);
    super.disconnectedCallback();
  }

  protected override willUpdate(changes: PropertyValues<this>): void {
    if (!changes.has("workspace") && !changes.has("machineId")) return;
    const scope = `${this.machineId}:${this.workspace?.projectId ?? ""}:${this.workspace?.id ?? ""}`;
    if (scope === this.scope) return;
    this.scope = scope;
    ++this.readSequence;
    ++this.treeSequence;
    this.searchController?.abort();
    this.entries = [];
    this.cursor = null;
    window.clearTimeout(this.searchTimer);
    this.pickerOpen = false;
    this.searching = false;
    this.searchNotice = "";
    this.selectedPath = "";
    this.loaded = undefined;
    this.buffer = "";
    this.error = "";
    this.conflict = false;
  }

  private readonly preventDirtyUnload = (event: BeforeUnloadEvent): void => {
    if (!this.dirty) return;
    event.preventDefault();
    // Older WebKit requires returnValue to show its native reload confirmation.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    event.returnValue = "";
  };

  /** Used by the shell before closing Files or leaving this Chat. */
  canClose(): boolean {
    return !this.saving && (!this.dirty || window.confirm("Discard unsaved file edits?"));
  }

  async searchFiles(): Promise<void> {
    if (this.workspace?.projectId === undefined || this.workspace.projectId === "") return;
    if (!this.pickerOpen) { this.query = ""; this.entries = []; this.selectedIndex = 0; }
    this.pickerOpen = true;
    await this.loadSearch("");
  }

  private onSearchInput(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.query = event.target.value;
    ++this.treeSequence;
    this.searchController?.abort();
    this.entries = [];
    this.cursor = null;
    this.selectedIndex = 0;
    this.searching = true;
    window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => { void this.loadSearch(""); }, 150);
  }

  private async loadSearch(cursor: string): Promise<void> {
    const workspace = this.workspace;
    if (workspace?.projectId === undefined || workspace.projectId === "") return;
    const sequence = ++this.treeSequence;
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    this.searching = true;
    this.searchNotice = "";
    try {
      const result = await api.searchWorkspaceFiles(workspace.projectId, workspace.id, this.query, cursor, this.machineId, { signal: controller.signal });
      if (sequence !== this.treeSequence || !this.isConnected) return;
      this.entries = cursor === "" ? result.paths : [...this.entries, ...result.paths];
      if (this.selectedIndex >= this.entries.length) this.selectedIndex = 0;
      this.cursor = result.cursor;
      this.searchNotice = result.cursor === null ? "All matching files shown." : "More files may match. Load more to continue searching.";
    } catch (error) {
      if (sequence === this.treeSequence) this.searchNotice = `Search failed; results may be incomplete. ${String(error)}`;
    } finally {
      if (sequence === this.treeSequence) { this.searching = false; this.searchController = undefined; }
    }
  }

  private async loadMoreSearch(): Promise<void> {
    await this.loadSearch(this.cursor ?? "");
    await this.updateComplete;
    if (this.pickerOpen) this.shadowRoot?.querySelector<HTMLInputElement>('.picker-content input')?.focus();
  }

  private closePicker(): void {
    this.pickerOpen = false;
    ++this.treeSequence;
    this.searchController?.abort();
    window.clearTimeout(this.searchTimer);
    this.searching = false;
  }

  protected override updated(): void {
    // happy-dom does not implement scrollIntoView.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this.shadowRoot?.querySelector('.picker-results [aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }

  private onPickerKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.selectedIndex = Math.max(0, Math.min(this.entries.length - 1, this.selectedIndex + (event.key === "ArrowDown" ? 1 : -1)));
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      const path = this.entries[this.selectedIndex];
      if (path !== undefined) { event.preventDefault(); void this.pickFile(path); }
    }
  }

  private async pickFile(path: string): Promise<void> {
    if (await this.openFile(path)) this.closePicker();
  }

  async openFile(path: string, force = false): Promise<boolean> {
    if (this.saving || !this.canClose()) return false;
    if (!force && path === this.selectedPath) return true;
    const workspace = this.workspace;
    if (workspace?.projectId === undefined || workspace.projectId === "") return false;
    const sequence = ++this.readSequence;
    this.loading = true;
    this.error = "";
    this.conflict = false;
    try {
      const file = await api.workspaceFile(workspace.projectId, workspace.id, path, this.machineId);
      if (sequence !== this.readSequence) return false;
      // A truncated or binary read is view-only: never expose an incomplete buffer to Save.
      this.selectedPath = path;
      this.loaded = file;
      this.buffer = file.binary || file.truncated ? "" : file.content;
      this.mode = "preview";
      await this.updateComplete;
      this.shadowRoot?.querySelector(".preview")?.scrollTo(0, 0);
      return true;
    } catch (error) {
      if (sequence === this.readSequence) this.error = `Could not open ${path}: ${String(error)}`;
      return false;
    } finally {
      if (sequence === this.readSequence) this.loading = false;
    }
  }

  private async reload(): Promise<void> {
    if (this.selectedPath === "" || this.saving || !this.canClose()) return;
    await this.openFile(this.selectedPath, true);
  }

  private async save(overwrite = false): Promise<void> {
    const file = this.loaded;
    const workspace = this.workspace;
    if (file === undefined || file.binary || file.truncated || workspace?.projectId === undefined || workspace.projectId === "" || !this.dirty || this.saving || this.loading) return;
    if (!overwrite && file.version === undefined) {
      this.error = "Cannot save safely: this file was loaded without a version. Reload after updating the server; your edits are preserved.";
      return;
    }
    if (overwrite && !window.confirm("Replace the current file with your edits? It may have changed or been deleted. This cannot be undone.")) return;
    this.saving = true;
    this.error = "";
    this.conflict = false;
    let written = false;
    try {
      await api.writeWorkspaceFile(workspace.projectId, workspace.id, file.path, this.buffer,
        overwrite ? { overwrite: true } : { expectedVersion: file.version ?? "" }, this.machineId);
      written = true;
      const saved = await api.workspaceFile(workspace.projectId, workspace.id, file.path, this.machineId);
      if (saved.binary || saved.truncated || saved.version === undefined) throw new Error("Saved, but could not verify the new file version. Reload before saving again.");
      this.loaded = saved;
      if (saved.content !== this.buffer) this.error = "The file changed again after saving. Your edits are preserved; inspect the current file before retrying.";
    } catch (error) {
      this.conflict = error instanceof HttpRequestError && error.status === 409;
      this.error = `${written ? "Saved, but could not verify the new version" : this.conflict ? "Conflict: the file changed or was deleted" : "Save failed"}. Your edits are preserved. ${String(error)}`;
    } finally {
      this.saving = false;
    }
  }

  override render() {
    const file = this.loaded;
    const workspace = this.workspace;
    const baseContext = workspace === undefined ? undefined : markdownWorkspaceContext(this.machineId, workspace, { id: "files", cwd: workspace.path });
    const context = baseContext === undefined ? undefined : { ...baseContext, sourcePath: file?.path };
    return html`
      <section class="pane" aria-label="Workspace files">
        <div class="toolbar"><strong>Files</strong><button type="button" ?disabled=${workspace?.projectId === undefined || workspace.projectId === ""} @click=${() => { void this.searchFiles(); }}>Search files</button></div>
        ${workspace?.projectId === undefined || workspace.projectId === "" ? html`<p role="status">Files are available in registered workspaces. Add this folder as a project to browse it.</p>` : null}
        <section class="surface" aria-label="File preview and editor">
          ${file === undefined ? html`<p>${this.loading ? "Opening…" : "Search files to open a workspace file."}</p>` : html`
            <div class="toolbar"><strong title=${this.selectedPath}>${this.selectedPath}</strong><span>${file.binary || file.truncated ? "Read-only" : this.dirty ? "Unsaved changes" : "Saved"}</span></div>
            <div class="actions" role="group" aria-label="File actions">
              ${!file.binary && !file.truncated ? html`
              <button type="button" aria-pressed=${this.mode === "preview"} @click=${() => { this.mode = "preview"; }}>Preview</button>
              <button type="button" aria-pressed=${this.mode === "edit"} @click=${() => { this.mode = "edit"; }}>Edit</button>
              <button type="button" ?disabled=${!this.dirty || this.saving || this.loading} @click=${() => { void this.save(); }}>${this.saving ? "Saving…" : "Save"}</button>` : null}
              <button type="button" ?disabled=${this.saving || this.loading} @click=${() => { void this.reload(); }}>Reload</button>
              ${this.conflict ? html`<button type="button" ?disabled=${this.saving || this.loading} @click=${() => { void this.save(true); }}>Replace current file…</button>` : null}
            </div>
            <div class="preview" ?hidden=${this.mode !== "preview"}>
              ${(file.mediaType === "image" || file.mediaType === "pdf") && file.size > MAX_INLINE_PREVIEW_BYTES ? html`<p>File too large to preview. Use Download file.</p>` : file.mediaType === "image" ? html`<img alt=${`Preview of ${file.path}`} src=${workspaceFilePreviewUrl(workspace?.projectId ?? "", workspace?.id ?? "", file.path, { machineId: this.machineId, modifiedAt: file.modifiedAt })}>` :
                file.mediaType === "pdf" ? html`<p>Inline PDF support varies. Use Open or Download if it does not display.</p><iframe title=${`Preview of ${file.path}`} src=${workspaceFilePreviewUrl(workspace?.projectId ?? "", workspace?.id ?? "", file.path, { machineId: this.machineId, modifiedAt: file.modifiedAt })} allow="" referrerpolicy="no-referrer"></iframe>` :
                file.binary || file.truncated ? html`<p>Preview unavailable: this file is binary or too large to edit.</p>` :
                  isMarkdown(file.path) ? html`<formatted-text .text=${this.buffer} .workspaceContext=${context} @workspace-file-open=${(event: CustomEvent<{ path: string }>) => { event.preventDefault(); void this.openFile(event.detail.path); }}></formatted-text>` : html`<pre>${this.buffer}</pre>`}
            </div>
            ${file.binary || file.truncated ? html`<a href=${workspaceFilePreviewUrl(workspace?.projectId ?? "", workspace?.id ?? "", file.path, { machineId: this.machineId, download: true })} download>Download file</a>` : html`<textarea ?hidden=${this.mode !== "edit"} ?disabled=${this.saving || this.loading} aria-label="File source" .value=${this.buffer} @input=${(event: Event) => { if (event.target instanceof HTMLTextAreaElement) this.buffer = event.target.value; }}></textarea>`}
          `}
          ${this.error !== "" ? html`<p class="error" role="alert">${this.error}</p>` : null}
        </section>
        ${this.pickerOpen ? html`<div class="file-picker"><modal-surface label="Search files" .initialFocus=${"input"} .onClose=${() => { this.closePicker(); }} @keydown=${(event: KeyboardEvent) => { this.onPickerKeyDown(event); }}>
          <div class="picker-content"><header><strong>Search workspace files</strong><button type="button" aria-label="Close" @click=${() => { this.closePicker(); }}>×</button></header>
          <input aria-label="Search files" role="combobox" aria-autocomplete="list" aria-controls="workspace-file-results" aria-expanded="true" aria-activedescendant=${this.entries[this.selectedIndex] === undefined ? "" : `workspace-file-option-${String(this.selectedIndex)}`} placeholder="Filename or path" .value=${this.query} @input=${(event: Event) => { this.onSearchInput(event); }}>
          <div class="picker-results" id="workspace-file-results" role="listbox">${this.entries.map((path, index) => html`<button type="button" role="option" id=${`workspace-file-option-${String(index)}`} aria-selected=${this.selectedIndex === index ? "true" : "false"} @click=${() => { void this.pickFile(path); }}>${path}</button>`)}</div>
          <p role="status">${this.searching ? "Searching workspace…" : this.searchNotice}</p>
          ${this.cursor !== null ? html`<button type="button" ?disabled=${this.searching} @click=${() => { void this.loadMoreSearch(); }}>Load more</button>` : null}
          </div></modal-surface></div>` : null}
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; min-height: 0; min-width: 0; background: var(--pi-bg); color: var(--pi-text); }
    .pane { height: 100%; min-height: 0; display: flex; flex-direction: column; }
    .toolbar, .actions { display: flex; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); flex-wrap: wrap; }
    .toolbar strong { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toolbar span, p { color: var(--pi-muted); }
    .file-picker, .file-picker modal-surface { position: fixed; inset: 0; z-index: 12; }
    .picker-content { width: min(620px, 85vw); max-height: 65vh; display: flex; flex-direction: column; background: var(--pi-bg); padding: 12px; gap: 8px; }
    .picker-content input { padding: 8px; background: var(--pi-bg); color: var(--pi-text); border: 1px solid var(--pi-border); }
    .picker-results { overflow: auto; min-height: 80px; }
    .picker-results button { display: block; width: 100%; text-align: left; overflow-wrap: anywhere; }
    .picker-results button[aria-selected="true"] { background: var(--pi-selection-bg); }
    .surface { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .surface > p { margin: 10px; }
    .preview { flex: 1; overflow: auto; min-height: 0; padding: 12px; }
    .preview pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .preview img { max-width: 100%; max-height: 100%; }
    .preview iframe { width: 100%; height: 100%; border: 0; }
    textarea { flex: 1; min-height: 0; box-sizing: border-box; width: 100%; resize: none; border: 0; padding: 12px; background: var(--pi-bg); color: var(--pi-text); font: 13px/1.5 ui-monospace, monospace; tab-size: 2; }
    [hidden] { display: none !important; }
    button { min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 8px; cursor: pointer; }
    .icon-button { width: 32px; height: 32px; min-height: 0; padding: 6px; display: grid; place-items: center; border-color: transparent; background: none; color: var(--pi-muted); }
    .icon-button:hover { border-color: var(--pi-border); color: var(--pi-text); background: var(--pi-surface-hover); }
    .icon-button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
    button[aria-pressed="true"] { border-color: var(--pi-accent); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .error { color: var(--pi-danger); overflow-wrap: anywhere; }
  `;
}
