import { LitElement, css, html, svg, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api } from "../api";
import { writeClipboardText } from "../clipboard";
import { AD_HOC_FOLDER_PROJECT_ID, adHocFolderWorkspaceId, MAX_WORKSPACE_FILE_CONTENT_BYTES } from "../../../shared/workspaceFiles";
import { registerRenderedModal, type RenderedModalRegistration } from "./modalLayerRegistry";

// Lucide file-text.
const fileTextIcon = svg`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`;

type LogView = { state: "loading" } | { state: "loaded"; text: string; note?: string } | { state: "error"; message: string };

/** Inspect button for a bash job's output log; opens the whole file in a native modal dialog, read once on open. */
@customElement("bash-log-button")
export class BashLogButton extends LitElement {
  @property() logPath = "";
  @property() machineId = "local";
  @state() private view: LogView | undefined;
  @state() private copied = false;
  @query("dialog") private dialog?: HTMLDialogElement | null;
  private registration: RenderedModalRegistration | undefined;
  private load = 0;

  constructor() {
    super();
    // The button usually sits inside a <summary>; a click here must not toggle its <details>.
    this.addEventListener("click", (event) => { event.preventDefault(); });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.registration?.unregister();
    this.registration = undefined;
  }

  protected override updated(changed: PropertyValues): void {
    if (!changed.has("view")) return;
    const dialog = this.dialog;
    if (!(dialog instanceof HTMLDialogElement)) return;
    if (this.view === undefined) {
      if (dialog.open) dialog.close();
      this.registration?.unregister();
      this.registration = undefined;
      return;
    }
    if (this.registration === undefined) {
      this.registration = registerRenderedModal({ element: dialog, nativeTopLayer: true, focus: () => { this.renderRoot.querySelector<HTMLElement>(".close")?.focus(); } });
      if (!dialog.open) dialog.showModal();
    }
    this.registration.focus();
  }

  private async open(): Promise<void> {
    const load = ++this.load;
    this.view = { state: "loading" };
    const slash = this.logPath.lastIndexOf("/");
    try {
      const file = await api.workspaceFile(AD_HOC_FOLDER_PROJECT_ID, adHocFolderWorkspaceId(this.logPath.slice(0, slash) || "/"), this.logPath.slice(slash + 1), this.machineId);
      if (load !== this.load) return;
      // ponytail: the file API returns the first 10 MB; show the tail once it can read from an offset.
      const note = file.truncated ? `Showing the first ${String(MAX_WORKSPACE_FILE_CONTENT_BYTES / 1024 / 1024)} MB of ${String(Math.ceil(file.size / 1024 / 1024))} MB. Full log: ${this.logPath}` : undefined;
      this.view = { state: "loaded", text: file.binary ? "(binary output)" : file.content, ...(note === undefined ? {} : { note }) };
    } catch (error) {
      if (load === this.load) this.view = { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private readonly close = (): void => { this.load++; this.view = undefined; };

  private async copy(text: string): Promise<void> {
    this.copied = await writeClipboardText(text);
    if (this.copied) window.setTimeout(() => { this.copied = false; }, 1200);
  }

  override render() {
    const view = this.view;
    return html`
      <button type="button" class="inspect" aria-label="Show full log" title="Show full log" @click=${() => { void this.open(); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${fileTextIcon}</svg>
      </button>
      <dialog aria-label="Full log" @close=${this.close} @cancel=${this.close} @click=${(event: MouseEvent) => { if (event.target === this.dialog) this.close(); }}>
        ${view === undefined ? null : html`
          <header>
            <code title=${this.logPath}>${this.logPath}</code>
            <button type="button" ?disabled=${view.state !== "loaded"} @click=${() => { if (view.state === "loaded") void this.copy(view.text); }}>${this.copied ? "Copied" : "Copy"}</button>
            <button type="button" class="close" aria-label="Close log" @click=${this.close}>×</button>
          </header>
          ${view.state === "loading" ? html`<p role="status">Loading log…</p>`
            : view.state === "error" ? html`<p role="alert">Could not read ${this.logPath}: ${view.message}</p>`
            : html`${view.note === undefined ? null : html`<p class="note">${view.note}</p>`}<pre tabindex="0" aria-label="Log output">${view.text === "" ? "(no output)" : view.text}</pre>`}
        `}
      </dialog>
    `;
  }

  static override styles = css`
    :host { display: inline-flex; flex: 0 0 auto; }
    .inspect { display: inline-grid; place-items: center; padding: 2px; border: 1px solid transparent; border-radius: 5px; background: none; color: var(--pi-muted); cursor: pointer; }
    .inspect:hover, .inspect:focus-visible { border-color: var(--pi-accent); color: var(--pi-text); }
    .inspect svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    dialog { box-sizing: border-box; width: min(960px, 92vw); height: min(80vh, 900px); padding: 0; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-bg); color: var(--pi-text); }
    dialog[open] { display: flex; flex-direction: column; }
    dialog::backdrop { background: var(--pi-overlay); }
    header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--pi-border); }
    header code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); font-size: 12px; }
    header button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 3px 8px; cursor: pointer; }
    p { margin: 8px 10px; color: var(--pi-muted); }
    pre { flex: 1; min-height: 0; margin: 0; padding: 10px; overflow: auto; white-space: pre; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  `;
}
