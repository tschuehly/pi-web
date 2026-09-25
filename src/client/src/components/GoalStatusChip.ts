import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { SessionStatus } from "../api";
import { GOAL_STATUS_KEY, parseGoalStatusSnapshot, parseLegacyGoalStatus, type GoalStatusSnapshot, type GoalStatusState } from "../extensionStatusSnapshots";

const STATE_LABELS: Record<GoalStatusState, string> = {
  active: "Active",
  waiting: "Waiting",
  paused: "Paused",
  blocked: "Blocked",
  usage_limited: "Usage limited",
  budget_limited: "Budget limited",
};

export function goalSheetMaximumHeight(headerBottom: number, summaryTop: number, interfaceScale: number): number {
  if (!Number.isFinite(headerBottom) || !Number.isFinite(summaryTop)) return 0;
  const scale = Number.isFinite(interfaceScale) && interfaceScale > 0 ? interfaceScale : 1;
  return Math.max(0, Math.floor((summaryTop - headerBottom) / scale));
}

function queryableRoot(root: Node): root is Node & ParentNode {
  return "querySelector" in root;
}

@customElement("goal-status-chip")
export class GoalStatusChip extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  private goal: GoalStatusSnapshot | undefined;
  private legacy: string | undefined;
  private sheetResizeObserver: ResizeObserver | undefined;
  private readonly onViewportChange = () => { this.updateSheetMaximumHeight(); };
  private readonly onDetailsToggle = (event: Event) => {
    if (!(event.currentTarget instanceof HTMLDetailsElement)) return;
    if (event.currentTarget.open) {
      this.updateSheetMaximumHeight();
      this.observeSheetGeometry();
    } else {
      this.stopObservingSheetGeometry();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportChange);
    window.visualViewport?.addEventListener("resize", this.onViewportChange);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    this.stopObservingSheetGeometry();
    super.disconnectedCallback();
  }

  protected override willUpdate(): void {
    const raw = this.status?.extensionStatuses?.[GOAL_STATUS_KEY];
    this.goal = parseGoalStatusSnapshot(raw);
    this.legacy = this.goal === undefined ? parseLegacyGoalStatus(raw) : undefined;
    this.hidden = this.goal === undefined && this.legacy === undefined;
  }

  protected override updated(): void {
    const details = this.shadowRoot?.querySelector<HTMLDetailsElement>("details");
    if (details?.open === true) {
      this.updateSheetMaximumHeight();
      this.observeSheetGeometry();
    } else {
      this.stopObservingSheetGeometry();
    }
  }

  override render() {
    const goal = this.goal;
    if (goal === undefined) return this.renderLegacy();
    const state = STATE_LABELS[goal.state];
    return html`
      <details data-state=${goal.state} @toggle=${this.onDetailsToggle}>
        <summary tabindex="0">
          <span class="chevron" aria-hidden="true">▸</span>
          <span class="identity">Goal</span>
          <span class="state">${state}</span>
          <span class="separator" aria-hidden="true">·</span>
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

  private renderLegacy() {
    const legacy = this.legacy;
    if (legacy === undefined) return null;
    return html`
      <details data-legacy @toggle=${this.onDetailsToggle}>
        <summary tabindex="0">
          <span class="chevron" aria-hidden="true">▸</span>
          <span class="identity">Goal</span>
          <span class="objective" title=${legacy}>${legacy}</span>
        </summary>
        <div class="sheet">
          <span class="label">Legacy status</span>
          <p>${legacy}</p>
        </div>
      </details>
    `;
  }

  private updateSheetMaximumHeight(): void {
    const summary = this.shadowRoot?.querySelector<HTMLElement>("summary");
    const details = summary?.closest("details");
    const boundary = this.sheetTopBoundary();
    if (summary === null || summary === undefined || details?.open !== true || boundary === undefined) return;
    const inheritedScale = getComputedStyle(this).getPropertyValue("--pi-interface-scale");
    const scale = Number.parseFloat(inheritedScale === "" ? getComputedStyle(this.ownerDocument.documentElement).getPropertyValue("--pi-interface-scale") : inheritedScale);
    const maximumHeight = goalSheetMaximumHeight(boundary.getBoundingClientRect().bottom, summary.getBoundingClientRect().top, scale);
    this.style.setProperty("--goal-sheet-max-height", `${String(maximumHeight)}px`);
  }

  private sheetTopBoundary(): HTMLElement | undefined {
    const root = this.getRootNode();
    if (!queryableRoot(root)) return undefined;
    return root.querySelector<HTMLElement>(".chat-error:not([hidden])") ?? root.querySelector<HTMLElement>("header") ?? undefined;
  }

  private observeSheetGeometry(): void {
    this.sheetResizeObserver?.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { this.updateSheetMaximumHeight(); });
    const root = this.getRootNode();
    const flexibleContent = queryableRoot(root) ? root.querySelector("chat-view, .transcript") : null;
    for (const target of [this.nextElementSibling, this.sheetTopBoundary(), flexibleContent]) {
      if (target instanceof Element) observer.observe(target);
    }
    this.sheetResizeObserver = observer;
  }

  private stopObservingSheetGeometry(): void {
    this.sheetResizeObserver?.disconnect();
    this.sheetResizeObserver = undefined;
    this.style.removeProperty("--goal-sheet-max-height");
  }

  static override styles = css`
    :host { position: relative; display: block; flex: 0 0 auto; min-width: 0; padding: 3px 8px 2px; border-top: 1px solid var(--pi-border-muted); background: var(--pi-surface); color: var(--pi-text); }
    :host([hidden]) { display: none; }
    * { box-sizing: border-box; min-width: 0; }
    details { --goal-color: var(--pi-muted); position: relative; }
    details[open] { z-index: 4; }
    details[data-state="active"] { --goal-color: var(--pi-success); }
    details[data-state="waiting"] { --goal-color: var(--pi-purple); }
    details[data-state="paused"] { --goal-color: var(--pi-muted); }
    details[data-state="blocked"] { --goal-color: var(--pi-text); }
    details[data-state="usage_limited"] { --goal-color: var(--pi-accent); }
    details[data-state="budget_limited"] { --goal-color: color-mix(in srgb, var(--pi-accent) 55%, var(--pi-purple)); }
    summary { min-height: 24px; display: flex; align-items: center; gap: 6px; overflow: hidden; padding: 0 5px; border-radius: 5px; list-style: none; cursor: pointer; white-space: nowrap; }
    summary:hover, details[open] summary { background: var(--pi-surface-hover); }
    summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    summary::-webkit-details-marker { display: none; }
    .identity, .state, .chevron { flex: 0 0 auto; }
    .identity { color: var(--pi-text); font-size: 11px; font-weight: 700; }
    .state { color: var(--goal-color); font-size: 11px; font-weight: 650; }
    .separator { color: var(--pi-muted); }
    .objective { flex: 1 1 auto; overflow: hidden; color: var(--pi-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .chevron { width: 1em; color: var(--pi-muted); font-size: 11px; }
    details[open] .chevron { transform: rotate(90deg); }
    code { font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .sheet { position: absolute; right: 0; bottom: 100%; width: min(440px, 100%); max-height: var(--goal-sheet-max-height, 0px); overflow: auto; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 14px; padding: 14px; border: 1px solid var(--pi-border); border-radius: 9px 9px 0 0; background: var(--pi-surface); box-shadow: 0 14px 36px var(--pi-shadow); }
    .label { color: var(--pi-muted); font-size: 10px; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; }
    p { margin: 0; line-height: 1.4; overflow-wrap: anywhere; }
    .full-id { overflow-wrap: anywhere; }
    @media (max-width: 700px) {
      :host { padding-inline: 4px; }
    }
    @media (forced-colors: active) {
      :host { border-color: ButtonText; background: Canvas; }
      .sheet { border-color: ButtonText; background: Canvas; }
      .state { color: CanvasText; }
      summary:focus-visible { outline-color: Highlight; }
    }
  `;
}
