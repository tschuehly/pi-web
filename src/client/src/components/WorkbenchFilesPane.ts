import { LitElement, css, html, nothing, svg, type PropertyValues, type SVGTemplateResult, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { api, type FileContentResponse, type FileTreeEntry, type Workspace } from "../api";
import { HttpRequestError } from "../api/http";
import { markdownWorkspaceContext, type LineRange } from "../formatting/workspaceLinks";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import { workspaceFilePreviewUrl } from "../api/urls";
import { writeClipboardText } from "../clipboard";
import { MAX_INLINE_PREVIEW_BYTES, MAX_WORKSPACE_FILE_CONTENT_BYTES } from "../../../shared/workspaceFiles";
import { bulkHunkAction, clearHunks, diskChangeSpec, hunkField, languageFor, lineRangeHighlight, lineRangeSpec, livePreview, proseHighlight } from "./workbenchFilesEditor";

const isMarkdown = (path: string): boolean => /\.(?:md|markdown|mdx)$/i.test(path);
const MODE_KEY = "pi-web.files.markdownMode";
const POLL_MS = 2000;
const isMissing = (error: unknown): boolean => error instanceof HttpRequestError && /does not exist|not found/i.test(error.message);

/** Matching search paths as nested folders, for the filtered tree. */
interface MatchNode { dirs: Map<string, MatchNode>; files: string[] }

/** One file surface: tree drawer, CodeMirror editor with Markdown live preview, and inline agent edits. */
@customElement("workbench-files-pane")
export class WorkbenchFilesPane extends LitElement {
  @property({ attribute: false }) workspace: Workspace | undefined;
  @property() machineId = "local";
  @state() private selectedPath = "";
  @state() private loaded: FileContentResponse | undefined;
  @state() private mode: "live" | "raw" = readMode();
  @state() private loading = false;
  @state() private saving = false;
  @state() private error = "";
  @state() private dirty = false;
  @state() private deleted = false;
  @state() private hunkCount = 0;
  @state() private toast = "";
  @state() private copied = false;
  @state() private treeOpen = false;
  @state() private full = false;
  @state() private dirs = new Map<string, FileTreeEntry[]>();
  @state() private openDirs = new Set<string>();
  @state() private query = "";
  @state() private found: string[] | undefined;
  @state() private cursor: string | null = null;
  @state() private searching = false;
  @state() private treeNotice = "";
  // Image pinch zoom is applied to the element directly so a gesture never re-renders the pane.
  private imageZoom = 1;
  private imageFitWidth = 0;
  private pinchStartZoom: number | undefined;
  private scope = "";
  private readSequence = 0;
  private treeSequence = 0;
  private diskSequence = 0;
  private searchController: AbortController | undefined;
  private searchTimer: number | undefined;
  private toastTimer: number | undefined;
  private pollTimer: number | undefined;
  private polling = false;
  private loadingDirs = new Set<string>();
  private view: EditorView | undefined;
  private readonly modeSlot = new Compartment();
  /** Last disk text the editor is in sync with; agent edits are diffed against it. */
  private base = "";
  private version: string | undefined;

  private get editable(): boolean { return this.loaded !== undefined && !this.loaded.binary && !this.loaded.truncated; }
  private get unsaved(): boolean { return this.editable && (this.dirty || this.deleted); }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.preventDirtyUnload);
    window.addEventListener("keydown", this.onWindowKeyDown);
    // ponytail: polling every 2s while a text file is open; swap for a push of file changes later.
    this.pollTimer = window.setInterval(() => { void this.syncWithDisk(); }, POLL_MS);
    // A re-attached pane rebuilds its editor from the last disk text.
    const file = this.loaded;
    if (file !== undefined && this.view === undefined && this.hasUpdated) void this.updateComplete.then(() => { this.resetEditor(this.base, file); });
  }

  override disconnectedCallback(): void {
    window.removeEventListener("beforeunload", this.preventDirtyUnload);
    window.removeEventListener("keydown", this.onWindowKeyDown);
    window.clearInterval(this.pollTimer);
    window.clearTimeout(this.searchTimer);
    window.clearTimeout(this.toastTimer);
    ++this.readSequence;
    ++this.treeSequence;
    this.searchController?.abort();
    // Browsers drop focus from removed nodes; happy-dom keeps it and then fails every ShadowRoot.activeElement.
    const focused = this.shadowRoot?.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    this.view?.destroy();
    this.view = undefined;
    super.disconnectedCallback();
  }

  protected override willUpdate(changes: PropertyValues<this>): void {
    if (!changes.has("workspace") && !changes.has("machineId")) return;
    const scope = `${this.machineId}:${this.workspace?.projectId ?? ""}:${this.workspace?.id ?? ""}`;
    if (scope === this.scope) return;
    this.scope = scope;
    ++this.readSequence;
    ++this.treeSequence;
    ++this.diskSequence;
    this.searchController?.abort();
    window.clearTimeout(this.searchTimer);
    this.dirs = new Map();
    this.loadingDirs = new Set();
    this.openDirs = new Set(readOpenDirs(scope));
    this.query = "";
    this.found = undefined;
    this.cursor = null;
    this.searching = false;
    this.treeNotice = "";
    this.treeOpen = false;
    this.selectedPath = "";
    this.loaded = undefined;
    this.error = "";
    this.resetEditor("");
  }

  protected override updated(): void {
    // Lazily list the root and every open folder the tree shows.
    if (this.workspace === undefined || (this.loaded !== undefined && !this.treeOpen) || this.found !== undefined) return;
    const visible = (dir: string): string[] => this.openDirs.has(dir) || dir === ""
      ? [dir, ...(this.dirs.get(dir) ?? []).filter((e) => e.type === "directory").flatMap((e) => visible(e.path))] : [];
    for (const dir of visible("")) if (!this.dirs.has(dir)) void this.loadDir(dir);
  }

  private readonly preventDirtyUnload = (event: BeforeUnloadEvent): void => {
    if (!this.unsaved) return;
    event.preventDefault();
    // Older WebKit requires returnValue to show its native reload confirmation.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    event.returnValue = "";
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.treeOpen && this.loaded !== undefined) { event.preventDefault(); this.showTree(false); }
    else if (event.key === "Escape" && this.full) { event.preventDefault(); this.full = false; }
    else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f" && this.loaded !== undefined) { event.preventDefault(); this.full = !this.full; }
  };

  /** Used by the shell before closing Files or leaving this Chat. */
  canClose(): boolean {
    return !this.saving && (!this.unsaved || window.confirm("Discard unsaved file edits?"));
  }

  /** Opens the file tree and focuses its filter (⌘P). */
  async searchFiles(): Promise<void> {
    if (this.workspace === undefined) return;
    this.showTree(true);
    await this.updateComplete;
  }

  private showTree(open: boolean): void {
    this.treeOpen = open;
    if (!open) return;
    void this.updateComplete.then(() => {
      const filter = this.shadowRoot?.querySelector<HTMLInputElement>(".filter input");
      filter?.focus();
      filter?.select();
      // happy-dom does not implement scrollIntoView.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      this.shadowRoot?.querySelector(".tree .sel")?.scrollIntoView?.({ block: "center" });
    });
  }

  // ---------------- tree ----------------
  private async loadDir(dir: string): Promise<void> {
    const workspace = this.workspace;
    if (workspace === undefined || this.loadingDirs.has(dir)) return;
    this.loadingDirs.add(dir);
    const sequence = this.treeSequence;
    try {
      const listing = await api.workspaceTree(workspace.projectId, workspace.id, dir, this.machineId);
      if (sequence !== this.treeSequence) return;
      const entries = listing.entries.filter((e) => e.name !== ".git").sort((a, b) =>
        (a.type === "directory") !== (b.type === "directory") ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
      this.dirs = new Map(this.dirs).set(dir, entries);
      if (listing.truncated) this.treeNotice = `Some entries in ${dir === "" ? "the workspace root" : dir} are not shown. Filter to find them.`;
    } catch (error) {
      if (sequence === this.treeSequence) { this.dirs = new Map(this.dirs).set(dir, []); this.treeNotice = `Could not list ${dir === "" ? "the workspace" : dir}: ${String(error)}`; }
    } finally {
      this.loadingDirs.delete(dir);
    }
  }

  private toggleDir(dir: string): void {
    const next = new Set(this.openDirs);
    if (!next.delete(dir)) next.add(dir);
    this.openDirs = next;
    writeOpenDirs(this.scope, next);
  }

  private onFilterInput(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.query = event.target.value;
    ++this.treeSequence;
    this.searchController?.abort();
    window.clearTimeout(this.searchTimer);
    if (this.query.trim() === "") { this.found = undefined; this.cursor = null; this.searching = false; this.treeNotice = ""; return; }
    this.searching = true;
    this.searchTimer = window.setTimeout(() => { void this.loadSearch(""); }, 150);
  }

  private async loadSearch(cursor: string): Promise<void> {
    const workspace = this.workspace;
    if (workspace === undefined) return;
    const sequence = ++this.treeSequence;
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    this.searching = true;
    this.treeNotice = "";
    try {
      const result = await api.searchWorkspaceFiles(workspace.projectId, workspace.id, this.query.trim(), cursor, this.machineId, { signal: controller.signal });
      if (sequence !== this.treeSequence || !this.isConnected) return;
      this.found = cursor === "" ? result.paths : [...(this.found ?? []), ...result.paths];
      this.cursor = result.cursor;
    } catch (error) {
      if (sequence === this.treeSequence) this.treeNotice = `Search failed; results may be incomplete. ${String(error)}`;
    } finally {
      if (sequence === this.treeSequence) { this.searching = false; this.searchController = undefined; }
    }
  }

  private onFilterKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    const first = this.shadowRoot?.querySelector<HTMLElement>(".tree .file")?.dataset["path"];
    if (first !== undefined) { event.preventDefault(); void this.openFile(first); }
  }

  // ---------------- files ----------------
  async openFile(path: string, force = false, lines?: LineRange): Promise<boolean> {
    if (this.saving) return false;
    if (!force && path === this.selectedPath && this.loaded !== undefined) {
      this.treeOpen = false;
      this.highlight(lines);
      return true;
    }
    if (!this.canClose()) return false;
    const workspace = this.workspace;
    if (workspace === undefined) return false;
    const sequence = ++this.readSequence;
    ++this.diskSequence;
    this.loading = true;
    this.error = "";
    try {
      const file = await api.workspaceFile(workspace.projectId, workspace.id, path, this.machineId);
      if (sequence !== this.readSequence) return false;
      this.selectedPath = path;
      this.loaded = file;
      this.deleted = false;
      this.treeOpen = false;
      this.expandTo(path);
      await this.updateComplete;
      this.resetEditor(file.binary ? "" : file.content, file);
      const image = this.shadowRoot?.querySelector<HTMLImageElement>(".preview img");
      if (image !== null && image !== undefined) this.zoomImage(image, 1, 0, 0);
      this.shadowRoot?.querySelector(".preview")?.scrollTo(0, 0);
      this.highlight(lines);
      return true;
    } catch (error) {
      if (sequence === this.readSequence) this.error = `Could not open ${path}: ${String(error)}`;
      return false;
    } finally {
      if (sequence === this.readSequence) this.loading = false;
    }
  }

  private expandTo(path: string): void {
    const parts = path.split("/").slice(0, -1);
    const next = new Set(this.openDirs);
    parts.forEach((_, index) => next.add(parts.slice(0, index + 1).join("/")));
    if (next.size !== this.openDirs.size) { this.openDirs = next; writeOpenDirs(this.scope, next); }
  }

  /** A fresh editor state per file, so undo history never crosses files. */
  private resetEditor(text: string, file?: FileContentResponse): void {
    this.base = text;
    this.version = file?.version;
    this.dirty = false;
    this.hunkCount = 0;
    this.toast = "";
    const host = this.shadowRoot?.querySelector<HTMLElement>(".editor");
    if (this.view === undefined) {
      if (file === undefined || host === null || host === undefined || this.shadowRoot === null) return;
      this.view = new EditorView({ parent: host, root: this.shadowRoot });
    }
    this.view.setState(this.editorState(text, file));
    this.view.scrollDOM.scrollTop = 0;
  }

  private editorState(text: string, file: FileContentResponse | undefined): EditorState {
    if (file === undefined || file.binary) return EditorState.create();
    const md = isMarkdown(file.path);
    const extension = file.path.slice(file.path.lastIndexOf(".") + 1);
    return EditorState.create({
      doc: text,
      extensions: [
        history(), drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        syntaxHighlighting(proseHighlight), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        hunkField, lineRangeHighlight,
        this.modeSlot.of(this.previewFor(file)),
        md ? [markdown({ base: markdownLanguage, codeLanguages: (info) => languageFor(info)?.language ?? null }), EditorView.lineWrapping]
          : [languageFor(extension) ?? [], lineNumbers(), highlightActiveLineGutter()],
        file.truncated ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
        EditorView.contentAttributes.of({ "aria-label": "File source" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.state.field(hunkField) !== update.startState.field(hunkField)) this.syncEditorState();
        }),
      ],
    });
  }

  private previewFor(file: FileContentResponse): ReturnType<typeof livePreview> {
    if (!isMarkdown(file.path) || file.truncated || this.mode !== "live") return [];
    const workspace = this.workspace;
    const base = workspace === undefined ? undefined : markdownWorkspaceContext(this.machineId, workspace, { id: "files", cwd: workspace.path });
    const context = base === undefined ? undefined : { ...base, sourcePath: file.path };
    return livePreview((source) => toSafeMarkdownHtml(source, context));
  }

  private syncEditorState(): void {
    const view = this.view;
    if (view === undefined) return;
    this.dirty = view.state.doc.toString() !== this.base;
    this.hunkCount = view.state.field(hunkField, false)?.length ?? 0;
  }

  private setMode(mode: "live" | "raw"): void {
    this.mode = mode;
    localStorage.setItem(MODE_KEY, mode);
    const file = this.loaded;
    if (file !== undefined) this.view?.dispatch({ effects: this.modeSlot.reconfigure(this.previewFor(file)) });
    this.view?.focus();
  }

  private highlight(lines: LineRange | undefined): void {
    const view = this.view;
    if (lines === undefined || view === undefined || !this.editable && this.loaded?.truncated !== true) return;
    view.dispatch(lineRangeSpec(view.state, lines.start, lines.end));
  }

  private showToast(message: string, sticky = false): void {
    window.clearTimeout(this.toastTimer);
    this.toast = message;
    if (!sticky) this.toastTimer = window.setTimeout(() => { this.toast = ""; }, 2500);
  }

  /** Applies the agent's disk text over the editor and shows what changed inline. */
  private applyDisk(disk: string): void {
    const view = this.view;
    if (view === undefined || disk === this.base) return;
    const { spec, overlaps } = diskChangeSpec(view.state, this.base, disk);
    this.base = disk;
    view.dispatch(spec);
    this.syncEditorState();
    this.showToast(overlaps ? "Agent edited lines you changed" : "Agent edit applied");
  }

  /** Re-reads the open text file and applies agent edits; the poll timer calls this every 2s. */
  async syncWithDisk(): Promise<void> {
    const workspace = this.workspace, path = this.selectedPath;
    if (this.polling || !this.editable || workspace === undefined || this.view === undefined || this.saving || this.loading || document.hidden || !this.isConnected) return;
    this.polling = true;
    const sequence = ++this.diskSequence;
    try {
      const disk = await api.workspaceFile(workspace.projectId, workspace.id, path, this.machineId);
      if (sequence !== this.diskSequence || disk.binary || disk.truncated) return;
      this.deleted = false;
      this.version = disk.version;
      this.applyDisk(disk.content);
    } catch (error) {
      if (sequence === this.diskSequence && isMissing(error)) this.deleted = true;
    } finally {
      this.polling = false;
    }
  }

  private async save(): Promise<void> {
    const file = this.loaded, workspace = this.workspace, view = this.view;
    if (file === undefined || !this.editable || workspace === undefined || view === undefined || this.saving || this.loading) return;
    if (!this.dirty && !this.deleted) {
      view.dispatch(clearHunks());
      this.showToast("Saved");
      return;
    }
    if (!this.deleted && this.version === undefined) {
      this.error = "Cannot save safely: this file was loaded without a version. Reload after updating the server; your edits are preserved.";
      return;
    }
    const text = view.state.doc.toString();
    const sequence = ++this.diskSequence;
    this.saving = true;
    this.error = "";
    let written = false;
    try {
      // A file deleted on disk is recreated, but never over one that reappeared meanwhile.
      await api.writeWorkspaceFile(workspace.projectId, workspace.id, file.path, text, this.deleted ? { overwrite: false } : { expectedVersion: this.version ?? "" }, this.machineId);
      written = true;
      const saved = await api.workspaceFile(workspace.projectId, workspace.id, file.path, this.machineId);
      if (saved.binary || saved.truncated || saved.version === undefined) throw new Error("Saved, but could not verify the new file version. Reload before saving again.");
      if (sequence !== this.diskSequence) return;
      // Unresolved agent hunks count as approved by the save.
      view.dispatch(clearHunks());
      this.base = text;
      this.version = saved.version;
      this.deleted = false;
      this.syncEditorState();
      this.showToast("Saved");
      this.applyDisk(saved.content);
    } catch (error) {
      if (error instanceof HttpRequestError && error.status === 409) await this.afterConflict(sequence);
      else this.error = `${written ? "Saved, but could not verify the new version" : "Save failed"}. Your edits are preserved. ${String(error)}`;
    } finally {
      this.saving = false;
    }
  }

  private async afterConflict(sequence: number): Promise<void> {
    const workspace = this.workspace;
    if (workspace === undefined) return;
    try {
      const disk = await api.workspaceFile(workspace.projectId, workspace.id, this.selectedPath, this.machineId);
      if (sequence !== this.diskSequence || disk.binary || disk.truncated) return;
      this.deleted = false;
      this.version = disk.version;
      this.applyDisk(disk.content);
    } catch (error) {
      if (!isMissing(error)) { this.error = `Save failed: the file changed and could not be re-read. Your edits are preserved. ${String(error)}`; return; }
      this.deleted = true;
    }
    this.showToast("Agent changed the file first · review, then ⌘S", true);
  }

  private async copy(): Promise<void> {
    if (this.view === undefined) return;
    this.copied = await writeClipboardText(this.view.state.doc.toString());
    window.setTimeout(() => { this.copied = false; }, 1200);
  }

  /** Scales the image between fit-to-pane (1) and 8×, keeping the point under the pointer in place. */
  private zoomImage(image: HTMLImageElement, requested: number, clientX: number, clientY: number): void {
    const pane = image.closest(".preview");
    if (!(pane instanceof HTMLElement)) return;
    const zoom = Math.min(8, Math.max(1, requested));
    if (this.imageZoom === 1) this.imageFitWidth = image.getBoundingClientRect().width;
    const previous = this.imageZoom;
    this.imageZoom = zoom;
    if (zoom === 1) {
      image.style.removeProperty("width");
      image.style.removeProperty("max-width");
      image.style.removeProperty("max-height");
      return;
    }
    if (zoom === previous || this.imageFitWidth === 0) return;
    const box = pane.getBoundingClientRect();
    const imageBox = image.getBoundingClientRect();
    const pointerX = clientX - box.left, pointerY = clientY - box.top;
    const offsetX = imageBox.left - box.left + pane.scrollLeft, offsetY = imageBox.top - box.top + pane.scrollTop;
    const ratio = zoom / previous;
    image.style.maxWidth = "none";
    image.style.maxHeight = "none";
    image.style.width = `${String(this.imageFitWidth * zoom)}px`;
    pane.scrollLeft = (pane.scrollLeft + pointerX - offsetX) * ratio + offsetX - pointerX;
    pane.scrollTop = (pane.scrollTop + pointerY - offsetY) * ratio + offsetY - pointerY;
  }

  // WebKit reports a trackpad pinch as non-standard gesture events; other engines send ctrl+wheel.
  private readonly onImageGesture = (event: Event): void => {
    const scale: unknown = Reflect.get(event, "scale");
    if (!(event.currentTarget instanceof HTMLImageElement) || typeof scale !== "number") return;
    event.preventDefault();
    if (event.type === "gesturestart") this.pinchStartZoom = this.imageZoom;
    else if (event.type === "gestureend") this.pinchStartZoom = undefined;
    else this.zoomImage(event.currentTarget, (this.pinchStartZoom ?? this.imageZoom) * scale, Number(Reflect.get(event, "clientX")), Number(Reflect.get(event, "clientY")));
  };

  private readonly onImageWheel = { passive: false, handleEvent: (event: WheelEvent): void => {
    if (!event.ctrlKey || this.pinchStartZoom !== undefined || !(event.currentTarget instanceof HTMLImageElement)) return;
    event.preventDefault();
    this.zoomImage(event.currentTarget, this.imageZoom * Math.exp(-event.deltaY / 100), event.clientX, event.clientY);
  } };

  private onPaneKeyDown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") { event.preventDefault(); void this.save(); }
  }

  private onBodyMouseDown(event: MouseEvent): void {
    if (this.treeOpen && this.loaded !== undefined && event.target instanceof Element && event.target.closest("aside") === null) this.showTree(false);
  }

  /** Links in rendered tables open in this pane instead of downloading. */
  private onEditorClick(event: MouseEvent): void {
    const anchor = event.target instanceof Element ? event.target.closest("a[data-workspace-file]") : null;
    const path = anchor?.getAttribute("data-workspace-file");
    if (path === null || path === undefined) return;
    event.preventDefault();
    void this.openFile(path);
  }

  override render() {
    const file = this.loaded;
    const workspace = this.workspace;
    const md = file !== undefined && isMarkdown(file.path) && !file.truncated && !file.binary;
    const text = file !== undefined && !file.binary;
    const slash = this.selectedPath.lastIndexOf("/");
    const status = file === undefined ? "" : this.toast !== "" ? this.toast : !this.editable ? "Read-only" : this.saving ? "Saving…" : this.deleted ? "Deleted on disk" : this.dirty ? "Unsaved · ⌘S" : "Saved";
    const statusClass = this.toast !== "" ? "toast" : this.deleted ? "danger" : this.dirty ? "dirty" : "";
    return html`
      ${this.full ? html`<div class="backdrop" @mousedown=${() => { this.full = false; }}></div>` : nothing}
      <section class=${`pane${this.full ? " full" : ""}${this.treeOpen ? " tree-open" : ""}${file === undefined ? " no-file" : ""}${md && this.mode === "live" ? " live" : ""}${text && !md ? " code" : ""}`} aria-label="Workspace files" @keydown=${(event: KeyboardEvent) => { this.onPaneKeyDown(event); }}>
        <div class="bar">
          <button type="button" class="icon tree-button" title="Files (⌘P)" aria-label="Files" aria-expanded=${this.treeOpen || file === undefined ? "true" : "false"} ?disabled=${workspace === undefined || file === undefined} @click=${() => { this.showTree(!this.treeOpen); }}>${FOLDER_ICON}</button>
          <button type="button" class="crumbs" title=${this.selectedPath || "Files"} ?disabled=${workspace === undefined} @click=${() => { this.showTree(true); }}>
            ${slash > 0 ? html`<span class="dir">${this.selectedPath.slice(0, slash + 1)}</span>` : nothing}<span class="leaf">${file === undefined ? "Files" : this.selectedPath.slice(slash + 1)}</span>
          </button>
          <span class=${`state ${statusClass}`} role="status">${this.loading ? "Opening…" : status}</span>
          ${md ? html`<div class="seg" role="group" aria-label="Markdown view">
            <button type="button" aria-pressed=${this.mode === "live" ? "true" : "false"} @click=${() => { this.setMode("live"); }}>Live</button>
            <button type="button" aria-pressed=${this.mode === "raw" ? "true" : "false"} @click=${() => { this.setMode("raw"); }}>Raw</button>
          </div>` : nothing}
          ${text ? html`<button type="button" class=${`icon${this.copied ? " done" : ""}`} title=${this.copied ? "Copied" : "Copy file contents"} aria-label=${this.copied ? "Copied" : "Copy file contents"} @click=${() => { void this.copy(); }}>${this.copied ? CHECK_ICON : COPY_ICON}</button>` : nothing}
          ${file !== undefined ? html`<button type="button" class="icon" title=${this.full ? "Back to panel (Esc)" : "Open full size (⌘⇧F)"} aria-label=${this.full ? "Back to panel" : "Open full size"} aria-pressed=${this.full ? "true" : "false"} @click=${() => { this.full = !this.full; }}>${this.full ? COLLAPSE_ICON : EXPAND_ICON}</button>` : nothing}
        </div>
        ${this.hunkCount > 0 ? html`<div class="strip" role="region" aria-label="Agent changes"><b>${this.hunkCount} agent change${this.hunkCount > 1 ? "s" : ""}</b><span class="actions">
          <button type="button" @click=${() => { if (this.view) bulkHunkAction(this.view, "next"); }}>Next</button>
          <button type="button" class="approve" @click=${() => { if (this.view) bulkHunkAction(this.view, "approve"); }}>${CHECK_ICON}Approve all</button>
          <button type="button" class="reject" @click=${() => { if (this.view) bulkHunkAction(this.view, "reject"); }}>${X_ICON}Reject all</button></span></div>` : nothing}
        ${this.error !== "" ? html`<p class="error" role="alert">${this.error}${file !== undefined ? html` <button type="button" @click=${() => { void this.openFile(this.selectedPath, true); }}>Reload</button>` : nothing}</p>` : nothing}
        <div class="body" @mousedown=${(event: MouseEvent) => { this.onBodyMouseDown(event); }}>
          ${workspace === undefined ? nothing : this.renderTree()}
          <div class="main">
            ${file === undefined ? nothing : this.renderReadOnly(file)}
            <div class="editor" ?hidden=${!text} @click=${(event: MouseEvent) => { this.onEditorClick(event); }}></div>
          </div>
        </div>
      </section>
    `;
  }

  private renderReadOnly(file: FileContentResponse): TemplateResult | typeof nothing {
    const workspace = this.workspace;
    if (workspace === undefined || (!file.binary && !file.truncated)) return nothing;
    const reveal = this.machineId === "local" ? window.piWebNative?.revealLocalFile : undefined;
    const absolute = `${workspace.path.replace(/\/+$/, "")}/${file.path}`;
    const action = reveal !== undefined
      ? html`<button type="button" @click=${() => { void reveal(absolute).catch((error: unknown) => { this.error = `Could not show the file in Finder: ${String(error)}`; }); }}>Show in Finder</button>`
      : html`<a class="download" href=${workspaceFilePreviewUrl(workspace.projectId, workspace.id, file.path, { machineId: this.machineId, download: true })} download>Download file</a>`;
    const preview = workspaceFilePreviewUrl(workspace.projectId, workspace.id, file.path, { machineId: this.machineId, modifiedAt: file.modifiedAt });
    if (file.truncated) return html`<p class="note" role="note">Showing the first ${formatBytes(MAX_WORKSPACE_FILE_CONTENT_BYTES)} of ${formatBytes(file.size)}. The file is too large to edit here. ${action}</p>`;
    return html`<div class="preview">
      ${(file.mediaType === "image" || file.mediaType === "pdf") && file.size > MAX_INLINE_PREVIEW_BYTES ? html`<p>File too large to preview.</p>`
        : file.mediaType === "image" ? html`<img alt=${`Preview of ${file.path}`} title="Pinch to zoom" @gesturestart=${this.onImageGesture} @gesturechange=${this.onImageGesture} @gestureend=${this.onImageGesture} @wheel=${this.onImageWheel} src=${preview}>`
        : file.mediaType === "pdf" ? html`<p>Inline PDF support varies. Use Open or Download if it does not display.</p><iframe title=${`Preview of ${file.path}`} src=${preview} allow="" referrerpolicy="no-referrer"></iframe>`
        : html`<p>Preview unavailable: this file is binary.</p>`}
      <p class="note">Read-only. ${action}</p>
    </div>`;
  }

  private renderTree(): TemplateResult {
    const rows: TemplateResult[] = [];
    const fileRow = (path: string, name: string, depth: number) => rows.push(html`<button type="button" class=${`row file${path === this.selectedPath ? " sel" : ""}`} data-path=${path} style=${`padding-left:${String(8 + depth * 14)}px`} title=${path} @click=${() => { void this.openFile(path); }}><i class=${`dot ext-${extensionOf(name)}`}></i><span>${name}</span></button>`);
    const dirRow = (path: string, name: string, depth: number, open: boolean, toggle: boolean) => rows.push(html`<button type="button" class=${`row dir${open ? " open" : ""}`} aria-expanded=${open ? "true" : "false"} style=${`padding-left:${String(8 + depth * 14)}px`} title=${path} @click=${() => { if (toggle) this.toggleDir(path); }}>${CHEVRON_ICON}<span>${name}</span></button>`);
    if (this.found !== undefined) {
      const root: MatchNode = { dirs: new Map(), files: [] };
      for (const path of this.found) {
        let node = root;
        for (const part of path.split("/").slice(0, -1)) {
          let child = node.dirs.get(part);
          if (child === undefined) { child = { dirs: new Map(), files: [] }; node.dirs.set(part, child); }
          node = child;
        }
        node.files.push(path);
      }
      const walk = (node: MatchNode, prefix: string, depth: number): void => {
        for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))) {
          dirRow(prefix + name, name, depth, true, false);
          walk(child, `${prefix}${name}/`, depth + 1);
        }
        for (const path of node.files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))) fileRow(path, path.slice(path.lastIndexOf("/") + 1), depth);
      };
      walk(root, "", 0);
    } else {
      const walk = (dir: string, depth: number): void => {
        for (const entry of this.dirs.get(dir) ?? []) {
          if (entry.type !== "directory") { fileRow(entry.path, entry.name, depth); continue; }
          const open = this.openDirs.has(entry.path);
          dirRow(entry.path, entry.name, depth, open, true);
          if (open) walk(entry.path, depth + 1);
        }
      };
      walk("", 0);
    }
    const empty = this.found !== undefined ? (this.searching ? "Searching…" : "No matching files") : this.dirs.has("") ? "No files" : "Loading…";
    return html`<aside aria-label="File tree" ?inert=${this.loaded !== undefined && !this.treeOpen}>
      <div class="filter">
        ${SEARCH_ICON}<input aria-label="Filter files" placeholder="Filter files" autocomplete="off" spellcheck="false" .value=${this.query} @input=${(event: Event) => { this.onFilterInput(event); }} @keydown=${(event: KeyboardEvent) => { this.onFilterKeyDown(event); }}><kbd>⌘P</kbd>
      </div>
      <div class="tree">${rows.length > 0 ? rows : html`<p class="none">${empty}</p>`}
        ${this.cursor !== null && this.found !== undefined ? html`<button type="button" class="more" ?disabled=${this.searching} @click=${() => { void this.loadSearch(this.cursor ?? ""); }}>Load more</button>` : nothing}
        ${this.treeNotice !== "" ? html`<p class="none" role="status">${this.treeNotice}</p>` : nothing}
      </div>
    </aside>`;
  }

  static override styles = css`
    :host { display: block; min-height: 0; min-width: 0; background: var(--pi-bg); color: var(--pi-text); --mono: ui-monospace, "SF Mono", Menlo, monospace; --ok: var(--pi-success); --bad: var(--pi-danger); }
    [hidden] { display: none !important; }
    .pane { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--pi-bg); }
    .backdrop { position: fixed; inset: 0; z-index: 90; background: rgba(15, 17, 21, .45); }
    .pane.full { position: fixed; inset: 28px; z-index: 100; height: auto; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0, 0, 0, .3); border: 1px solid var(--pi-border); }
    .pane.full:not(.code) .editor .cm-content { max-width: 880px; margin: 0 auto; }
    button { font: inherit; color: var(--pi-text); cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }

    .bar { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 10px; border-bottom: 1px solid var(--pi-border-muted); }
    .icon { display: grid; place-items: center; flex: none; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: none; color: var(--pi-muted); }
    .icon:hover:not(:disabled), .tree-open .tree-button { background: var(--pi-surface-hover); color: var(--pi-text); }
    .icon.done { color: var(--ok); }
    svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .icon svg { width: 16px; height: 16px; }
    .crumbs { flex: 1; display: flex; min-width: 0; padding: 0; border: 0; background: none; white-space: nowrap; font-size: 13px; color: var(--pi-muted); text-align: left; }
    .crumbs .dir { overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; }
    .crumbs .leaf { color: var(--pi-text); font-weight: 600; flex: none; }
    .crumbs:hover:not(:disabled) .leaf { text-decoration: underline; text-underline-offset: 3px; }
    .state { font-size: 12px; color: var(--pi-muted); white-space: nowrap; }
    .state.dirty { color: var(--pi-warning); }
    .state.danger { color: var(--bad); font-weight: 600; }
    .state.toast { color: var(--pi-accent); }
    .seg { display: flex; padding: 2px; background: var(--pi-surface); border-radius: 7px; }
    .seg button { border: 0; background: none; color: var(--pi-muted); padding: 3px 10px; font-size: 12.5px; border-radius: 5px; }
    .seg button[aria-pressed="true"] { background: var(--pi-bg); color: var(--pi-text); box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }

    .strip { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 12px; font-size: 12.5px; background: color-mix(in srgb, var(--pi-accent) 7%, var(--pi-bg)); border-bottom: 1px solid color-mix(in srgb, var(--pi-accent) 22%, var(--pi-border-muted)); }
    .strip .actions { display: flex; gap: 6px; margin-left: auto; }
    .strip button { display: inline-flex; align-items: center; gap: 4px; }
    .strip button svg { width: 12px; height: 12px; }
    .strip .approve { color: var(--ok); }
    .strip .reject { color: var(--bad); }
    .strip button, .note button, .error button, .more { border: 1px solid var(--pi-border); background: var(--pi-bg); border-radius: 6px; padding: 3px 9px; font-size: 12px; }
    .error { margin: 0; padding: 8px 12px; color: var(--bad); overflow-wrap: anywhere; border-bottom: 1px solid var(--pi-border-muted); }

    .body { position: relative; flex: 1; min-height: 0; display: flex; overflow: hidden; }
    .main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .no-file .main { display: none; }
    aside { position: absolute; z-index: 10; inset: 0 auto 0 0; width: min(320px, 88%); display: flex; flex-direction: column; min-height: 0; background: var(--pi-surface); border-right: 1px solid var(--pi-border-muted); box-shadow: 8px 0 24px rgba(0, 0, 0, .08); transform: translateX(-102%); transition: transform .16s ease; }
    .tree-open aside { transform: none; }
    .tree-open:not(.no-file) .body::after { content: ""; position: absolute; inset: 0; z-index: 5; background: rgba(0, 0, 0, .06); }
    .no-file aside { position: static; width: 100%; transform: none; box-shadow: none; border: 0; }
    .filter { position: relative; margin: 12px 12px 8px; }
    .filter svg { position: absolute; left: 9px; top: 8px; width: 13px; height: 13px; color: var(--pi-muted); }
    .filter input { box-sizing: border-box; width: 100%; padding: 6px 36px 6px 28px; border: 1px solid var(--pi-border-muted); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); font: inherit; font-size: 13px; outline: none; }
    .filter input:focus { border-color: var(--pi-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--pi-accent) 18%, transparent); }
    .filter kbd { position: absolute; right: 8px; top: 6px; font: 11px inherit; color: var(--pi-muted); border: 1px solid var(--pi-border-muted); border-radius: 4px; padding: 0 4px; }
    .tree { overflow: auto; flex: 1; padding: 4px 6px 16px; font-size: 13px; user-select: none; }
    .row { display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding-right: 8px; border: 0; border-radius: 5px; background: none; white-space: nowrap; text-align: left; font-size: 13px; }
    .row span { overflow: hidden; text-overflow: ellipsis; }
    .row:hover { background: var(--pi-surface-hover); }
    .row.sel { background: var(--pi-selection-bg); font-weight: 500; }
    .row.dir svg { flex: none; width: 12px; height: 12px; color: var(--pi-muted); transition: transform .12s; }
    .row.dir.open svg { transform: rotate(90deg); }
    .dot { flex: none; width: 7px; height: 7px; border-radius: 2px; margin: 0 2px 0 3px; background: var(--pi-dim); }
    .ext-md .dot, .dot.ext-md { background: #6e8fd8; } .dot.ext-ts, .dot.ext-tsx, .dot.ext-mts { background: #3178c6; } .dot.ext-js, .dot.ext-mjs, .dot.ext-cjs { background: #d4b830; }
    .dot.ext-json, .dot.ext-jsonl { background: #c98a3a; } .dot.ext-py { background: #4b8bbe; } .dot.ext-sh { background: #58a55c; } .dot.ext-css, .dot.ext-html { background: #c9567a; } .dot.ext-yml, .dot.ext-yaml { background: #9b6fc4; }
    .none { color: var(--pi-muted); padding: 8px 12px; margin: 0; font-size: 13px; }
    .more { margin: 6px 12px; }

    .preview { flex: 1; overflow: auto; min-height: 0; padding: 12px; }
    .preview p, .note { color: var(--pi-muted); }
    .note { margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .preview img { max-width: 100%; max-height: 100%; touch-action: pan-x pan-y; }
    .preview iframe { width: 100%; height: 100%; border: 0; }
    .download { color: var(--pi-accent); }

    /* editor */
    .editor { flex: 1; min-height: 0; }
    /* .pane .editor outranks CodeMirror's base theme (.ͼ1 .cm-*) */
    .pane .editor .cm-editor { height: 100%; background: transparent; color: var(--pi-text); }
    .pane .editor .cm-editor.cm-focused { outline: none; }
    .pane .editor .cm-content { font-family: var(--mono); font-size: 13px; line-height: 1.6; padding: 20px 0 30vh; caret-color: var(--pi-accent); min-width: 0; }
    .pane .editor .cm-line { padding: 0 18px; }
    .pane .editor .cm-gutters { background: var(--pi-bg); border: 0; color: var(--pi-dim); font: 12px/1.6 var(--mono); padding-left: 8px; }
    .pane .editor .cm-activeLineGutter { background: transparent; color: var(--pi-muted); }
    .cm-cursor { border-left: 2px solid var(--pi-accent) !important; }
    .cm-selectionBackground, .cm-focused .cm-selectionBackground { background: color-mix(in srgb, var(--pi-accent) 22%, transparent) !important; }
    .cm-range { background: color-mix(in srgb, var(--pi-accent) 12%, transparent); }

    /* Markdown live preview */
    .pane .editor .cm-content.lp-on { font-family: inherit; font-size: 14.5px; line-height: 1.65; }
    .lp-on .lp-h { font-weight: 650; line-height: 1.3; letter-spacing: -.01em; }
    .lp-on .lp-h1 { font-size: 1.6em; padding-top: .3em; padding-bottom: .25em; }
    .lp-on .lp-h2 { font-size: 1.28em; padding-top: 1.1em; padding-bottom: .15em; }
    .lp-on .lp-h3 { font-size: 1.12em; padding-top: .9em; }
    .lp-on .lp-h4, .lp-on .lp-h5, .lp-on .lp-h6 { font-size: 1em; padding-top: .7em; }
    .lp-on .lp-quote { border-left: 3px solid var(--pi-border); color: var(--pi-muted); margin-left: 18px; padding-left: 12px !important; }
    .lp-on .lp-code { background: var(--pi-surface); font-family: var(--mono); font-size: 12.5px; line-height: 1.6; margin: 0 18px; padding: 0 14px !important; }
    .lp-on .lp-code-first { border-radius: 8px 8px 0 0; padding-top: 8px !important; }
    .lp-on .lp-code-last { border-radius: 0 0 8px 8px; padding-bottom: 8px !important; }
    .lp-on .lp-fence { color: var(--pi-muted); font-size: 11px; opacity: .55; }
    .lp-on .lp-inline-code { font-family: var(--mono); font-size: .86em; background: var(--pi-surface); padding: .12em .35em; border-radius: 4px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
    .lp-on .lp-link { color: var(--pi-accent); border-bottom: 1px solid color-mix(in srgb, var(--pi-accent) 35%, transparent); }
    .lp-on .lp-done { color: var(--pi-muted); text-decoration: line-through; text-decoration-color: var(--pi-dim); }
    .lp-on .lp-table-src { font-family: var(--mono); font-size: 12.5px; }
    /* lists: hanging indent so wrapped lines align with the text, not the bullet */
    .lp-on .lp-li { --m: 1.6em; padding-left: calc(18px + var(--depth) * 1.6em + var(--m)) !important; text-indent: calc(-1 * var(--m)); }
    .lp-on .lp-li-cont { text-indent: 0; }
    .lp-on .lp-li > * { text-indent: 0; }
    .lp-marker { display: inline-block; width: 1.6em; text-indent: 0; color: var(--pi-muted); }
    .lp-bullet { text-align: center; padding-right: .35em; box-sizing: border-box; }
    .lp-num { font-variant-numeric: tabular-nums; }
    .lp-check { margin: 0; width: 14px; height: 14px; vertical-align: -2px; cursor: pointer; accent-color: var(--pi-accent); }
    .lp-hr { display: inline-block; width: 100%; border-top: 1px solid var(--pi-border-muted); vertical-align: middle; }
    .lp-img { display: block; }
    .lp-img p { margin: 0; }
    .lp-img img { max-width: 100%; border-radius: 6px; }
    /* wide tables scroll inside their own box; cells keep a readable width instead of squishing */
    .lp-table { box-sizing: border-box; margin: 0 18px; max-width: calc(100% - 36px); cursor: text; overflow-x: auto; border: 1px solid var(--pi-border-muted); border-radius: 8px; font-family: inherit; }
    .lp-table table { border-collapse: collapse; margin: 0; border-style: hidden; font-size: 14px; line-height: 1.5; }
    .lp-table th, .lp-table td { min-width: 7em; max-width: 26em; border: 1px solid var(--pi-border-muted); padding: 6px 12px; text-align: left; vertical-align: top; }
    .lp-table th { background: var(--pi-surface); font-weight: 600; }
    .lp-table code { font: .86em var(--mono); background: var(--pi-surface); padding: .1em .3em; border-radius: 4px; }
    .lp-table a { color: var(--pi-accent); }

    /* inline agent hunks */
    .hunk-new { background: color-mix(in srgb, var(--ok) 13%, transparent); box-shadow: inset 3px 0 0 var(--ok); }
    .hunk-box { margin: 4px 0 0; font: 12.5px/1.55 system-ui, sans-serif; }
    .hunk-old { white-space: pre-wrap; font: 12.5px/1.55 var(--mono); color: color-mix(in srgb, var(--bad) 75%, var(--pi-text)); background: color-mix(in srgb, var(--bad) 10%, transparent); box-shadow: inset 3px 0 0 var(--bad); padding: 2px 18px; text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--bad) 45%, transparent); }
    .hunk-bar { display: flex; align-items: center; gap: 4px; padding: 3px 18px 2px; }
    .hunk-who { font-size: 11px; color: var(--pi-muted); margin-right: auto; }
    .hunk-btns { display: flex; gap: 4px; }
    .hunk-btn { border: 1px solid var(--pi-border-muted); background: var(--pi-bg); border-radius: 5px; height: 20px; min-width: 22px; padding: 0 6px; font: 11.5px system-ui, sans-serif; }
    .hunk-btn:hover { background: var(--pi-surface-hover); }
    .hunk-btn.approve { color: var(--ok); }
    .hunk-btn.reject { color: var(--bad); }
    .hunk-ins { background: color-mix(in srgb, var(--ok) 18%, transparent); border-radius: 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .hunk-del { color: color-mix(in srgb, var(--bad) 80%, var(--pi-text)); background: color-mix(in srgb, var(--bad) 12%, transparent); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--bad) 55%, transparent); border-radius: 3px; margin-right: 1px; }
    .hunk-inline-btns { display: inline-flex; gap: 3px; margin: 0 2px 0 6px; vertical-align: middle; text-indent: 0; }
    .hunk-btn svg { width: 12px; height: 12px; vertical-align: -2px; }
    .hunk-inline-btns .hunk-btn { height: 20px; min-width: 20px; padding: 0 4px; font-size: 11px; line-height: 18px; }
  `;
}

function readMode(): "live" | "raw" {
  try { return localStorage.getItem(MODE_KEY) === "raw" ? "raw" : "live"; } catch { return "live"; }
}

function readOpenDirs(scope: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`pi-web.files.openDirs:${scope}`) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}

function writeOpenDirs(scope: string, dirs: Set<string>): void {
  try { localStorage.setItem(`pi-web.files.openDirs:${scope}`, JSON.stringify([...dirs])); } catch { /* storage unavailable */ }
}

function extensionOf(name: string): string {
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "none";
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${String(Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Lucide folder, copy, check, maximize-2, minimize-2, chevron-right, search, x.
const icon = (body: SVGTemplateResult) => html`<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const FOLDER_ICON = icon(svg`<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`);
const COPY_ICON = icon(svg`<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`);
const CHECK_ICON = icon(svg`<path d="M20 6 9 17l-5-5"/>`);
const X_ICON = icon(svg`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`);
const EXPAND_ICON = icon(svg`<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>`);
const COLLAPSE_ICON = icon(svg`<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>`);
const CHEVRON_ICON = icon(svg`<path d="m9 18 6-6-6-6"/>`);
const SEARCH_ICON = icon(svg`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`);
