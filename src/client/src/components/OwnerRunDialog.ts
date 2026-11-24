import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sessionsApi, type SessionRef } from "../api";
import type { OwnerRunProposal } from "../../../shared/ownerRun";
import "./ModalSurface";

/** The committed assistant message a pi-run block belongs to. */
export interface OwnerRunTarget { session: SessionRef; machineId: string; entryId: string }

/**
 * Confirms one pi-run proposal before it runs outside the write fence: the folder, the shell and the whole literal
 * command, with where the result goes. Focus starts on Cancel; running takes a separate click, and nothing is remembered.
 */
@customElement("owner-run-dialog")
export class OwnerRunDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) target?: OwnerRunTarget;
  @property({ attribute: false }) proposal?: OwnerRunProposal;
  @state() private phase: "review" | "sending" | "done" = "review";
  @state() private message = "";

  override render(): TemplateResult {
    const proposal = this.proposal;
    if (proposal === undefined) return html``;
    const terminal = proposal.mode === "terminal";
    return html`
      <modal-surface .onClose=${() => { this.close(); }} .busy=${this.phase === "sending"} .initialFocus=${".cancel"} .label=${"Run outside the write fence"}>
        <header><h1>Run outside the write fence</h1></header>
        <div class="body">
          <p class="warning">The agent proposed this command. It runs as you on this Mac, not in the agent's sandbox, so it can change or delete anything you can. Read all of it.</p>
          <dl>
            <dt>Folder</dt><dd><code>${proposal.cwd}</code></dd>
            <dt>Runs in</dt><dd>${terminal ? "a new Terminal window" : "/bin/bash -c, 10 minute limit"}</dd>
            <dt>Result</dt><dd>${terminal ? "Terminal; output and exit code are not returned" : "output and exit code go back to the agent"}</dd>
          </dl>
          <pre class="command">${proposal.command}</pre>
          ${this.message === "" ? null : html`<p class=${this.phase === "done" ? "result" : "dialog-error"} role="status">${this.message}</p>`}
        </div>
        <footer>
          <button class="cancel" @click=${() => { this.close(); }}>${this.phase === "done" ? "Close" : "Cancel"}</button>
          ${this.phase === "done" ? null : html`<button class="danger run" ?disabled=${this.phase === "sending"} @click=${() => { void this.run(); }}>${terminal ? "Open in Terminal" : "Run once"}</button>`}
        </footer>
      </modal-surface>
    `;
  }

  private async run(): Promise<void> {
    const { target, proposal } = this;
    if (target === undefined || proposal === undefined || this.phase !== "review") return;
    this.phase = "sending";
    this.message = "";
    try {
      const { status } = await sessionsApi.ownerRun(target.session, target.entryId, proposal, target.machineId);
      this.phase = "done";
      this.message = status === "started" ? "Started. The output goes to the agent when the command ends." : "Terminal opened.";
    } catch (error) {
      this.phase = "review";
      this.message = error instanceof Error ? error.message : String(error);
    }
  }

  private close(): void {
    this.remove();
  }

  static override styles = css`
    :host { position: fixed; inset: 0; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
    modal-surface { --modal-surface-backdrop-padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); --modal-surface-width: min(720px, 100%); --modal-surface-max-height: min(760px, 100%); --modal-surface-radius: 14px; }
    header, footer { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--pi-border); }
    footer { border-top: 1px solid var(--pi-border); border-bottom: 0; justify-content: end; }
    .body { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; gap: 14px; padding: 16px; }
    h1, p, dl { margin: 0; }
    h1 { font-size: 20px; line-height: 1.2; }
    dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; }
    dt { color: var(--pi-muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code, .command { font-family: var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .command { margin: 0; max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-bg); padding: 10px 12px; }
    .warning, .dialog-error, .result { border: 1px solid var(--pi-border); border-radius: 10px; padding: 10px 12px; }
    .warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
    .dialog-error { border-color: var(--pi-danger); color: var(--pi-danger); }
    .result { border-color: var(--pi-success-border); background: var(--pi-success-bg); }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 12px; font: inherit; cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    button.danger { color: var(--pi-danger); }
  `;
}

/** Opens the confirmation over the page; it removes itself when closed. */
export function openOwnerRunDialog(target: OwnerRunTarget, proposal: OwnerRunProposal): void {
  const dialog = document.createElement("owner-run-dialog");
  dialog.target = target;
  dialog.proposal = proposal;
  document.body.append(dialog);
}

declare global {
  interface HTMLElementTagNameMap { "owner-run-dialog": OwnerRunDialog }
}
