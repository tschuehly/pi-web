import { html } from "lit";
import type { SessionEffectResolution, SessionUnresolvedEffect } from "../../../../shared/apiTypes";
import { renderSessionWarningIcon } from "../shared";

const RESOLUTIONS: readonly { resolution: SessionEffectResolution; label: string; title: string }[] = [
  { resolution: "done", label: "Done", title: "It ran: the agent will not repeat it" },
  { resolution: "not-done", label: "Not done", title: "It did not run: the agent decides whether it is still needed" },
  { resolution: "retry", label: "Retry", title: "Run it again now" },
];

/**
 * A Durable Chat's interrupted unsafe tool calls: each blocks its tool until the user says whether it ran. The
 * resolution is recorded in the Chat and the agent is told.
 */
export function renderUnresolvedEffects(effects: readonly SessionUnresolvedEffect[] | undefined, onResolve: ((id: string, resolution: SessionEffectResolution) => void) | undefined) {
  if (effects === undefined || effects.length === 0) return null;
  return html`
    <aside class="session-warnings unresolved-effects" role="alert" aria-live="polite">
      ${effects.map((effect) => html`
        <div class="session-warning warning ui-transcript-surface" data-effect-id=${effect.id}>
          <div class="session-warning-head">
            ${renderSessionWarningIcon("warning", "session-warning-icon")}
            <span class="session-warning-source">Needs reconciliation</span>
          </div>
          <div class="session-warning-body">
            <p class="session-warning-message">An interrupted <code>${effect.toolName}</code> call may have run. Did it?</p>
            <p class="session-warning-path">${effect.arguments}</p>
            ${onResolve === undefined ? null : html`
              <div class="unresolved-effect-actions">
                ${RESOLUTIONS.map((option) => html`
                  <button type="button" class="ui-button ui-button--compact" title=${option.title} @click=${() => { onResolve(effect.id, option.resolution); }}>${option.label}</button>
                `)}
              </div>
            `}
          </div>
        </div>
      `)}
    </aside>
  `;
}
