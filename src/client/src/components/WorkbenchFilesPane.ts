import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api, type FileContentResponse, type FileTreeEntry, type Workspace } from "../api";
import { HttpRequestError } from "../api/http";
import { markdownWorkspaceContext } from "../formatting/workspaceLinks";
import "./FormattedText";

const isMarkdown = (path: string): boolean => /\.(?:md|markdown)$/i.test(path);

/** One file surface for selection, preview, editing, and the loaded revision. */
@customElement("workbench-files-pane")
export class WorkbenchFilesPane extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property() machineId = "local";
  @state() private entries: FileTreeEntry[] = [];
  @state() private directories: Record<string, FileTreeEntry[] | undefined> = {};
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

  private get dirty(): boolean { return this.loaded !== undefined && this.buffer !== this.loaded.content; }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.preventDirtyUnload);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("beforeunload", this.preventDirtyUnload);
    ++this.readSequence;
    ++this.treeSequence;
    super.disconnectedCallback();
  }

  protected override willUpdate(changes: PropertyValues<this>): void {
    if (!changes.has("workspace") && !changes.has("machineId")) return;
    const scope = `${this.machineId}:${this.workspace?.projectId ?? ""}:${this.workspace?.id ?? ""}`;
    if (scope === this.scope) return;
    this.scope = scope;
    ++this.readSequence;
    ++this.treeSequence;
    this.entries = [];
    this.directories = {};
    this.selectedPath = "";
    this.loaded = undefined;
    this.buffer = "";
    this.error = "";
    this.conflict = false;
    if (this.workspace?.projectId !== undefined && this.workspace.projectId !== "") void this.refreshTree();
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
    return !this.saving && (!this.dirty || window.confirm("Discard unsaved Markdown edits?"));
  }

  private async refreshTree(): Promise<void> {
    const workspace = this.workspace;
    if (workspace?.projectId === undefined || workspace.projectId === "") return;
    const sequence = ++this.treeSequence;
    try {
      const tree = await api.workspaceTree(workspace.projectId, workspace.id, "", this.machineId);
      if (sequence !== this.treeSequence) return;
      this.entries = tree.entries;
      this.error = tree.truncated ? "File list is incomplete; some files are not shown." : "";
    } catch (error) {
      if (sequence === this.treeSequence) this.error = `Could not list files: ${String(error)}`;
    }
  }

  private async toggleDirectory(path: string): Promise<void> {
    if (this.directories[path] !== undefined) {
      this.directories = { ...this.directories, [path]: undefined };
      return;
    }
    const workspace = this.workspace;
    if (workspace?.projectId === undefined || workspace.projectId === "") return;
    const scope = this.scope;
    try {
      const tree = await api.workspaceTree(workspace.projectId, workspace.id, path, this.machineId);
      if (scope !== this.scope) return;
      this.directories = { ...this.directories, [path]: tree.entries };
      if (tree.truncated) this.error = `File list in ${path} is incomplete.`;
    } catch (error) {
      if (scope === this.scope) this.error = `Could not list ${path}: ${String(error)}`;
    }
  }

  async openFile(path: string, force = false): Promise<void> {
    if (!isMarkdown(path) || (!force && path === this.selectedPath) || this.saving || !this.canClose()) return;
    const workspace = this.workspace;
    if (workspace?.projectId === undefined || workspace.projectId === "") return;
    const sequence = ++this.readSequence;
    this.loading = true;
    this.error = "";
    this.conflict = false;
    try {
      const file = await api.workspaceFile(workspace.projectId, workspace.id, path, this.machineId);
      if (sequence !== this.readSequence) return;
      if (file.binary || file.truncated) throw new Error("This file cannot be edited because its text is unavailable or truncated.");
      this.selectedPath = path;
      this.loaded = file;
      this.buffer = file.content;
      this.mode = "preview";
      await this.updateComplete;
      this.shadowRoot?.querySelector(".preview")?.scrollTo(0, 0);
    } catch (error) {
      if (sequence === this.readSequence) this.error = `Could not open ${path}: ${String(error)}`;
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
    if (file === undefined || workspace?.projectId === undefined || workspace.projectId === "" || !this.dirty || this.saving || this.loading) return;
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

  private renderEntries(entries: FileTreeEntry[], depth = 0): unknown {
    return entries.filter((entry) => entry.type === "directory" || entry.type === "file" && isMarkdown(entry.path)).map((entry) => html`
      <button type="button" class="file-row" style=${`--depth:${String(depth)}`} aria-expanded=${entry.type === "directory" ? String(this.directories[entry.path] !== undefined) : undefined}
        aria-current=${entry.type === "file" && this.selectedPath === entry.path ? "true" : undefined}
        @click=${() => { if (entry.type === "directory") void this.toggleDirectory(entry.path); else void this.openFile(entry.path); }}>
        <span aria-hidden="true">${entry.type === "directory" ? this.directories[entry.path] === undefined ? "▸" : "▾" : "·"}</span>${entry.name}
      </button>
      ${entry.type === "directory" && this.directories[entry.path] !== undefined ? this.renderEntries(this.directories[entry.path] ?? [], depth + 1) : null}
    `);
  }

  override render() {
    const file = this.loaded;
    const workspace = this.workspace;
    const context = workspace === undefined ? undefined : markdownWorkspaceContext(this.machineId, workspace, { id: "files", cwd: workspace.path });
    return html`
      <section class="pane" aria-label="Workspace files">
        <div class="toolbar"><strong>Files</strong><button class="icon-button" type="button" title="Refresh list" aria-label="Refresh list" @click=${() => { void this.refreshTree(); }}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 7v5h-5M4 17v-5h5M5.6 9a7 7 0 0 1 12-2L20 12M4 12l2.4 5a7 7 0 0 0 12-2"/></svg></button></div>
        ${workspace?.projectId !== undefined && workspace.projectId !== "" ? html`<nav aria-label="Markdown files" class="tree">${this.renderEntries(this.entries)}${this.entries.length === 0 ? html`<p>No Markdown files at the workspace root.</p>` : null}</nav>` : html`<p role="status">Files are available in registered workspaces. Add this folder as a project to browse it.</p>`}
        <section class="surface" aria-label="Markdown preview and editor">
          ${file === undefined ? html`<p>${this.loading ? "Opening…" : "Choose a Markdown file."}</p>` : html`
            <div class="toolbar"><strong title=${this.selectedPath}>${this.selectedPath}</strong><span>${this.dirty ? "Unsaved changes" : "Saved"}</span></div>
            <div class="actions" role="group" aria-label="File actions">
              <button type="button" aria-pressed=${this.mode === "preview"} @click=${() => { this.mode = "preview"; }}>Preview</button>
              <button type="button" aria-pressed=${this.mode === "edit"} @click=${() => { this.mode = "edit"; }}>Edit</button>
              <button type="button" ?disabled=${!this.dirty || this.saving || this.loading} @click=${() => { void this.save(); }}>${this.saving ? "Saving…" : "Save"}</button>
              <button type="button" ?disabled=${this.saving || this.loading} @click=${() => { void this.reload(); }}>Reload</button>
              ${this.conflict ? html`<button type="button" ?disabled=${this.saving || this.loading} @click=${() => { void this.save(true); }}>Replace current file…</button>` : null}
            </div>
            <div class="preview" ?hidden=${this.mode !== "preview"}><formatted-text .text=${this.buffer} .workspaceContext=${context} @workspace-file-open=${(event: CustomEvent<{ path: string }>) => { if (isMarkdown(event.detail.path)) { event.preventDefault(); void this.openFile(event.detail.path); } }}></formatted-text></div>
            <textarea ?hidden=${this.mode !== "edit"} ?disabled=${this.saving || this.loading} aria-label="Markdown source" .value=${this.buffer} @input=${(event: Event) => { if (event.target instanceof HTMLTextAreaElement) this.buffer = event.target.value; }}></textarea>
          `}
          ${this.error !== "" ? html`<p class="error" role="alert">${this.error}</p>` : null}
        </section>
      </section>
    `;
  }

  static override styles = css`
    :host { display: block; min-height: 0; min-width: 0; background: var(--pi-bg); color: var(--pi-text); }
    .pane { height: 100%; min-height: 0; display: flex; flex-direction: column; }
    .toolbar, .actions { display: flex; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); flex-wrap: wrap; }
    .toolbar strong { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toolbar span, p { color: var(--pi-muted); }
    .tree { flex: 0 0 auto; max-height: 30%; min-height: 64px; overflow: auto; border-bottom: 1px solid var(--pi-border); padding: 4px; }
    .file-row { display: flex; align-items: center; gap: 5px; width: 100%; border: 0; background: transparent; color: inherit; padding: 5px 4px 5px calc(4px + var(--depth) * 16px); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
    .file-row:hover, .file-row[aria-current="true"] { background: var(--pi-surface-hover); }
    .surface { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .surface > p { margin: 10px; }
    .preview { flex: 1; overflow: auto; min-height: 0; padding: 12px; }
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
