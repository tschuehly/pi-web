import { html } from "lit";
import type { SessionEffectResolution, SessionStatus, SessionUnresolvedEffect } from "../../../../shared/apiTypes";
import { renderSessionWarningIcon } from "../shared";

const RESOLUTIONS: readonly { resolution: SessionEffectResolution; label: string; title: string }[] = [
  { resolution: "done", label: "Done", title: "It ran: the agent will not repeat it" },
  { resolution: "not-done", label: "Not done", title: "It did not run: the agent decides whether it is still needed" },
  { resolution: "retry", label: "Retry", title: "Run it again now" },
];

/** A compact host-upgrade status; versions, recovery details and actions stay inside a native disclosure. */
export function renderDurableHostPin(pin: SessionStatus["durableHostPin"], onUpgrade: ((mode: "quiet" | "now" | "cancel") => void) | undefined) {
  if (pin === undefined) return null;
  const repeats = pin.repeats ?? [];
  return html`
    <aside class="session-warnings durable-host-pin">
      <details>
        <summary><span role="status">${pin.pending === true ? "Host upgrade pending" : "Host upgrade available"}</span> <span class="durable-host-pin-disclosure">Details</span></summary>
        <div class="durable-host-pin-details">
          <p>Host <code>${pin.revision}</code> (new Chats run <code>${pin.current}</code>)</p>
          ${pin.pending === true ? html`<p>Upgrade pending: it restarts on the current code once no turn, tool or child runs.</p>` : null}
          <p id="durable-host-upgrade-recovery">Upgrade now restarts this Chat's host; the Chat resumes by itself. Open questions, queued input, background bash and Atelier Pages carry over.
            ${repeats.length === 0 ? "Nothing repeats." : `Repeats: ${repeats.join("; ")}.`}</p>
          ${
            onUpgrade === undefined
              ? null
              : html`
            <div class="durable-host-pin-actions">
              <button type="button" class="ui-button ui-button--compact" title="Restart this Chat's host on the current code; refused while it is busy" @click=${() => {
                onUpgrade("quiet");
              }}>Upgrade host</button>
              <button type="button" class="ui-button ui-button--compact" aria-describedby="durable-host-upgrade-recovery" @click=${() => {
                onUpgrade("now");
              }}>Upgrade now</button>
              ${
                pin.pending === true
                  ? html`<button type="button" class="ui-button ui-button--compact" title="Keep this Chat on its host code until you upgrade it" @click=${() => {
                      onUpgrade("cancel");
                    }}>Cancel</button>`
                  : null
              }
            </div>`
          }
        </div>
      </details>
    </aside>
  `;
}

/**
 * A Durable Chat's interrupted unsafe tool calls: each blocks its tool until the user says whether it ran. The
 * resolution is recorded in the Chat and the agent is told.
 */
export function renderUnresolvedEffects(
  effects: readonly SessionUnresolvedEffect[] | undefined,
  onResolve: ((id: string, resolution: SessionEffectResolution) => void) | undefined,
) {
  if (effects === undefined || effects.length === 0) return null;
  return html`
    <aside class="session-warnings unresolved-effects" role="alert" aria-live="polite">
      ${effects.map(
        (effect) => html`
        <div class="session-warning warning ui-transcript-surface" data-effect-id=${effect.id}>
          <div class="session-warning-head">
            ${renderSessionWarningIcon("warning", "session-warning-icon")}
            <span class="session-warning-source">Needs reconciliation</span>
          </div>
          <div class="session-warning-body">
            <p class="session-warning-message">An interrupted <code>${effect.toolName}</code> call may have run. Did it?</p>
            <p class="session-warning-path">${effect.arguments}</p>
            ${
              onResolve === undefined
                ? null
                : html`
              <div class="unresolved-effect-actions">
                ${RESOLUTIONS.map(
                  (option) => html`
                  <button type="button" class="ui-button ui-button--compact" title=${option.title} @click=${() => {
                    onResolve(effect.id, option.resolution);
                  }}>${option.label}</button>
                `,
                )}
              </div>
            `
            }
          </div>
        </div>
      `,
      )}
    </aside>
  `;
}
