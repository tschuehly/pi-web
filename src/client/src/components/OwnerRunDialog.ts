import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sessionsApi, type SessionRef } from "../api";
import type { OwnerRunAskSource, OwnerRunProposal } from "../../../shared/ownerRun";
import "./ModalSurface";

/**
 * The committed assistant message a pi-run block belongs to, or the field of the open question set that holds it (its
 * `block`, when not given, is the clicked block's place in the text the button's formatted text draws).
 */
export type OwnerRunTarget = { session: SessionRef; machineId: string } & ({ entryId: string } | (Omit<OwnerRunAskSource, "block"> & { block?: number }));

/**
 * Confirms one pi-run proposal before it runs outside the write fence: the folder, the whole literal command and where
 * the result goes. Focus starts on Cancel; running takes a separate click, and nothing is remembered.
 */
@customElement("owner-run-dialog")
export class OwnerRunDialog extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) target?: OwnerRunTarget;
  @property({ attribute: false }) proposal?: OwnerRunProposal;
  @state() private sending = false;
  @state() private error = "";

  override render(): TemplateResult {
    const proposal = this.proposal;
    if (proposal === undefined) return html``;
    const terminal = proposal.mode === "terminal";
    return html`
      <modal-surface .onClose=${() => {
        this.close();
      }} .busy=${this.sending} .initialFocus=${".cancel"} .label=${"Run outside the write fence"}>
        <header><h1>Run outside the write fence</h1></header>
        <div class="body">
          <p class="warning">Runs as you, not in the agent's sandbox: it can change or delete anything you can.</p>
          <p class="meta">in <code>${proposal.cwd}</code> · ${terminal ? "new Terminal window, output not returned" : "background job (12 h limit), output goes to the agent"}</p>
          <pre class="command">${proposal.command}</pre>
          ${this.error === "" ? null : html`<p class="dialog-error" role="status">${this.error}</p>`}
        </div>
        <footer>
          <button class="cancel" ?disabled=${this.sending} @click=${() => {
            this.close();
          }}>Cancel</button>
          <button class="danger run" ?disabled=${this.sending} @click=${() => {
            void this.run();
          }}>${terminal ? "Open in Terminal" : "Run once"}</button>
        </footer>
      </modal-surface>
    `;
  }

  /** Closes on success: the result arrives in the Chat, so the dialog has nothing left to show. */
  private async run(): Promise<void> {
    const { target, proposal } = this;
    if (target === undefined || proposal === undefined || this.sending) return;
    this.sending = true;
    this.error = "";
    try {
      const { session, machineId, ...source } = target;
      await sessionsApi.ownerRun(session, "entryId" in source ? source.entryId : { ...source, block: source.block ?? 0 }, proposal, machineId);
      this.close();
    } catch (error) {
      this.sending = false;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private close(): void {
    this.remove();
  }

  static override styles = css`
    :host { position: fixed; inset: 0; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
    modal-surface { --modal-surface-backdrop-padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); --modal-surface-width: min(720px, 100%); --modal-surface-max-height: min(760px, 100%); --modal-surface-radius: 14px; }
    header, footer { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--pi-border); }
    footer { border-top: 1px solid var(--pi-border); border-bottom: 0; justify-content: end; }
    .body { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; gap: 10px; padding: 12px 14px; }
    h1, p { margin: 0; }
    h1 { font-size: 16px; line-height: 1.2; }
    .meta { color: var(--pi-muted); overflow-wrap: anywhere; }
    .meta code { color: var(--pi-text); white-space: pre-wrap; }
    code, .command { font-family: var(--pi-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
    .command { margin: 0; max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-bg); padding: 8px 12px; }
    .warning, .dialog-error { border: 1px solid var(--pi-border); border-radius: 10px; padding: 8px 12px; }
    .warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
    .dialog-error { border-color: var(--pi-danger); color: var(--pi-danger); }
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
  interface HTMLElementTagNameMap {
    "owner-run-dialog": OwnerRunDialog;
  }
}
