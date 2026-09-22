import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { GOAL_STATUS_KEY, parseGoalStatusSnapshot, type GoalStatusSnapshot, type GoalStatusState } from "../extensionStatusSnapshots";

const STATE_LABELS: Record<GoalStatusState, string> = {
  active: "Active",
  waiting: "Waiting",
  paused: "Paused",
  blocked: "Blocked",
  usage_limited: "Usage limited",
  budget_limited: "Budget limited",
};

function shortGoalId(goalId: string): string {
  const characters = Array.from(goalId);
  return characters.length <= 8 ? goalId : `${characters.slice(0, 8).join("")}…`;
}

@customElement("goal-status-chip")
export class GoalStatusChip extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  private goal: GoalStatusSnapshot | undefined;

  protected override willUpdate(): void {
    this.goal = parseGoalStatusSnapshot(this.status?.extensionStatuses?.[GOAL_STATUS_KEY]);
    this.hidden = this.goal === undefined;
  }

  override render() {
    const goal = this.goal;
    if (goal === undefined) return null;
    const state = STATE_LABELS[goal.state];
    return html`
      <details data-state=${goal.state}>
        <summary>
          <span class="identity">Goal</span>
          <span class="state">${state}</span>
          <code class="short-id" title=${goal.goalId}>#${shortGoalId(goal.goalId)}</code>
          <span class="objective" title=${goal.objective}>${goal.objective}</span>
        </summary>
        <div class="sheet">
          <span class="label">Objective</span>
          <p>${goal.objective}</p>
          <span class="label">State</span>
          <p>${state}</p>
          <span class="label">Goal ID</span>
          <code class="full-id">${goal.goalId}</code>
        </div>
      </details>
    `;
  }

  static override styles = css`
    :host { position: static; display: block; flex: 0 1 360px; min-width: 0; max-width: min(360px, 40vw); color: var(--pi-text); }
    :host([hidden]) { display: none; }
    * { box-sizing: border-box; min-width: 0; }
    details { --goal-color: var(--pi-muted); position: static; }
    details[data-state="active"] { --goal-color: var(--pi-success); }
    details[data-state="waiting"] { --goal-color: var(--pi-purple); }
    details[data-state="paused"] { --goal-color: var(--pi-muted); }
    details[data-state="blocked"] { --goal-color: var(--pi-text); }
    details[data-state="usage_limited"] { --goal-color: var(--pi-accent); }
    details[data-state="budget_limited"] { --goal-color: color-mix(in srgb, var(--pi-accent) 55%, var(--pi-purple)); }
    summary { min-height: 32px; display: flex; align-items: center; gap: 6px; overflow: hidden; padding: 0 9px; border: 1px solid var(--pi-border); border-left: 3px solid var(--goal-color); border-radius: 8px; background: var(--pi-bg); list-style: none; cursor: pointer; white-space: nowrap; }
    summary:hover, details[open] summary { background: var(--pi-surface-hover); }
    summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: "↓"; flex: 0 0 auto; color: var(--pi-muted); }
    details[open] summary::after { content: "↑"; }
    .identity, .state, .short-id { flex: 0 0 auto; }
    .identity { color: var(--pi-muted); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    .state { padding: 2px 5px; border-radius: 5px; background: color-mix(in srgb, var(--goal-color) 14%, transparent); color: var(--goal-color); font-size: 11px; font-weight: 750; }
    code { font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .short-id { color: var(--pi-muted); }
    .objective { flex: 1 1 auto; overflow: hidden; color: var(--pi-text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .sheet { position: absolute; top: 100%; right: 12px; width: min(440px, calc(100% - 24px)); display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 14px; padding: 14px; border: 1px solid var(--pi-border); border-top: 3px solid var(--goal-color); border-radius: 0 0 9px 9px; background: var(--pi-surface); box-shadow: 0 14px 36px var(--pi-shadow); }
    .label { color: var(--pi-muted); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    p { margin: 0; line-height: 1.4; overflow-wrap: anywhere; }
    .full-id { overflow-wrap: anywhere; }
    @media (forced-colors: active) {
      summary, .sheet { border-color: ButtonText; background: Canvas; }
      .state { border: 1px solid ButtonText; background: Canvas; color: CanvasText; }
    }
    @media (max-width: 700px) {
      :host { max-width: 46vw; }
      .identity { display: none; }
      .sheet { right: 8px; width: calc(100% - 16px); }
    }
  `;
}
