import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { piWebApi } from "../api";
import { nothingInstalled, type InstallLatestPreview, type InstallPair } from "../../../shared/installLatest";
import "./ModalSurface";

const short = (sha: string) => sha.slice(0, 7);
const pair = (value: InstallPair) => `${short(value.workbench)} · ${short(value.piWeb)}`;

/**
 * Install latest: reads `promote-installed latest --dry-run`, lists what the latest pi-workbench and PI WEB merges add,
 * and installs exactly the pairs shown, so the script refuses when another install happened or latest moved since;
 * after a refusal, Check again reloads the preview. Focus starts on Cancel.
 */
@customElement("install-latest-dialog")
export class InstallLatestDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @state() private phase: "loading" | "review" | "sending" | "done" = "loading";
  @state() private preview: InstallLatestPreview | undefined;
  @state() private message = "";

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.phase = "loading";
    this.preview = undefined;
    this.message = "";
    try {
      this.preview = await piWebApi.installLatestPreview();
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    }
    this.phase = "review";
  }

  override render(): TemplateResult {
    const { preview, phase } = this;
    return html`
      <modal-surface .onClose=${() => { this.remove(); }} .busy=${phase === "sending"} .initialFocus=${".cancel"} .label=${"Install latest"}>
        <header><h1>Install latest</h1></header>
        <div class="body">
          ${phase === "loading" ? html`<p role="status">Checking for new merges…</p>` : null}
          ${preview === undefined ? null : html`
            <dl>
              <dt>Pi Workbench</dt><dd><code>${short(preview.installed.workbench)} → ${short(preview.latest.workbench)}</code></dd>
              <dt>PI WEB</dt><dd><code>${short(preview.installed.piWeb)} → ${short(preview.latest.piWeb)}</code></dd>
            </dl>
            ${preview.upToDate ? html`<p class="result">Up to date: ${pair(preview.installed)} is the latest.</p>` : html`
              ${nothingInstalled(preview.installed)
                ? html`<p class="result">Nothing installed yet: Install sets up the latest pair ${pair(preview.latest)}.</p>`
                : html`<ul class="merges" aria-label="New merges">
                ${preview.merges.map((merge) => html`<li><span class="repo">${merge.repo}</span> <code>${short(merge.sha)}</code> ${merge.subject}</li>`)}
              </ul>`}
              <p class="warning">Install switches Pi Workbench and PI WEB to the latest pair at once. PI WEB restarts about 3 seconds later, which interrupts every open session except Durable Chats. It refuses if another install happened or a newer merge landed since this check, or while subagents or workers run.</p>`}`}
          ${this.message === "" ? null : html`<p class=${phase === "done" ? "result" : "dialog-error"} role=${phase === "done" ? "status" : "alert"}>${this.message}</p>`}
        </div>
        <footer>
          <button class="cancel" @click=${() => { this.remove(); }}>${phase === "done" ? "Close" : "Cancel"}</button>
          ${phase === "review" && this.message !== "" ? html`<button class="recheck" @click=${() => { void this.load(); }}>Check again</button>` : null}
          ${phase === "done" ? null : html`<button class="install" ?disabled=${phase !== "review" || preview === undefined || preview.upToDate} @click=${() => { void this.install(); }}>${preview?.upToDate === true ? "Up to date" : "Install"}</button>`}
        </footer>
      </modal-surface>
    `;
  }

  private async install(): Promise<void> {
    const preview = this.preview;
    if (preview === undefined || preview.upToDate || this.phase !== "review") return;
    this.phase = "sending";
    this.message = "";
    try {
      await piWebApi.installLatest(preview.installed, preview.latest);
      this.phase = "done";
      this.message = "Installing, PI WEB restarts in a few seconds.";
    } catch (error) {
      this.phase = "review";
      this.message = error instanceof Error ? error.message : String(error);
    }
  }

  static override styles = css`
    :host { position: fixed; inset: 0; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
    modal-surface { --modal-surface-backdrop-padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); --modal-surface-width: min(720px, 100%); --modal-surface-max-height: min(760px, 100%); --modal-surface-radius: 14px; }
    header, footer { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border); }
    footer { border-top: 1px solid var(--pi-border); border-bottom: 0; justify-content: end; }
    .body { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; gap: 14px; padding: 16px; }
    h1, p, dl, ul { margin: 0; }
    h1 { font-size: 20px; line-height: 1.2; }
    dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; }
    dt, .repo { color: var(--pi-muted); }
    dd { margin: 0; }
    ul { padding-left: 18px; display: grid; gap: 4px; overflow-wrap: anywhere; }
    code { font-family: var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .warning, .dialog-error, .result { border: 1px solid var(--pi-border); border-radius: 10px; padding: 10px 12px; }
    .warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
    .dialog-error { border-color: var(--pi-danger); color: var(--pi-danger); }
    .result { border-color: var(--pi-success-border); background: var(--pi-success-bg); }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 12px; font: inherit; cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
  `;
}

/** Opens Install latest over the page; it removes itself when closed. */
export function openInstallLatestDialog(): void {
  document.body.append(document.createElement("install-latest-dialog"));
}

declare global {
  interface HTMLElementTagNameMap { "install-latest-dialog": InstallLatestDialog }
}
