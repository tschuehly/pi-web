import { LitElement, css, html, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionModel, SessionStatus } from "../api";
import { thinkingLevelLabel } from "../../../shared/thinkingLevels";
import { scrollWhenSelected } from "./scrollWhenSelected";

type QualifiedModel = SessionModel & { provider: string; id: string };

/** Models matching the search, in catalog order, grouped by provider in first-seen order. */
export function modelPickerGroups(models: readonly SessionModel[], query: string): { provider: string; models: QualifiedModel[] }[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, QualifiedModel[]>();
  for (const model of models) {
    if (typeof model.provider !== "string" || model.provider === "" || typeof model.id !== "string" || model.id === "") continue;
    const qualified: QualifiedModel = { ...model, provider: model.provider, id: model.id };
    if (needle !== "" && !`${qualified.provider}/${qualified.id} ${qualified.name ?? ""}`.toLowerCase().includes(needle)) continue;
    groups.set(qualified.provider, [...(groups.get(qualified.provider) ?? []), qualified]);
  }
  return [...groups].map(([provider, grouped]) => ({ provider, models: grouped }));
}

// Lucide "check" (https://lucide.dev, ISC).
const CHECK_ICON = svg`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>`;

/**
 * One composer button for the model and its thinking effort. It opens a compact popover: the effort
 * row applies immediately and stays open; choosing a model applies it and closes.
 */
@customElement("model-effort-picker")
export class ModelEffortPicker extends LitElement {
  @property({ attribute: false }) status?: SessionStatus;
  /** Thinking levels the current model supports, in order. */
  @property({ attribute: false }) thinkingLevels: readonly string[] = [];
  @property({ attribute: false }) loadModels?: () => Promise<readonly SessionModel[]>;
  @property({ attribute: false }) onSetModel?: (provider: string, modelId: string) => unknown;
  @property({ attribute: false }) onSetThinkingLevel?: (level: string) => unknown;
  @state() private open = false;
  @state() private models: readonly SessionModel[] = [];
  @state() private query = "";
  @state() private activeIndex = 0;
  private openGeneration = 0;

  private readonly closeOnOutsidePointer = (event: PointerEvent): void => {
    if (!event.composedPath().includes(this)) this.setOpen(false);
  };

  override disconnectedCallback(): void {
    document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
    super.disconnectedCallback();
  }

  override render() {
    const model = this.status?.model?.id ?? "no model";
    const provider = this.status?.model?.provider ?? "";
    const qualified = provider === "" ? model : `${provider}/${model}`;
    const thinking = thinkingLevelLabel(this.status?.thinkingLevel);
    return html`
      <button class="trigger" type="button" title=${`Model: ${qualified} · Thinking: ${thinking}`} aria-label=${`Model: ${qualified}, thinking ${thinking}. Change model or thinking`} aria-haspopup="dialog" aria-expanded=${this.open ? "true" : "false"} @click=${() => { this.setOpen(!this.open); }}>
        <span class="model-name">${model}</span><span class="separator" aria-hidden="true">·</span><span class="thinking">${thinking}</span>
      </button>
      ${this.open ? this.renderPopover(thinking) : null}
    `;
  }

  private renderPopover(thinking: string) {
    const groups = modelPickerGroups(this.models, this.query);
    const flat = groups.flatMap((group) => group.models);
    const active = flat[Math.min(this.activeIndex, flat.length - 1)];
    const current = this.status?.model;
    return html`
      <div class="popover" role="dialog" aria-label="Model and thinking" @keydown=${(event: KeyboardEvent) => { this.handlePopoverKey(event); }} @focusout=${(event: FocusEvent) => { this.handleFocusOut(event); }}>
        ${this.thinkingLevels.length === 0 ? null : html`
          <div class="effort" role="radiogroup" aria-label="Thinking">
            ${this.thinkingLevels.map((level) => html`<button type="button" role="radio" aria-checked=${level === thinking ? "true" : "false"} tabindex=${level === thinking ? "0" : "-1"} data-level=${level} @click=${() => { void this.onSetThinkingLevel?.(level); }} @keydown=${(event: KeyboardEvent) => { this.handleEffortKey(event); }}>${level}</button>`)}
          </div>
        `}
        <input class="search" type="search" placeholder="Search models" aria-label="Search models" role="combobox" aria-expanded="true" aria-controls="model-list" aria-autocomplete="list" aria-activedescendant=${active === undefined ? "" : optionId(active)} .value=${this.query} @input=${(event: Event) => { this.handleSearch(event); }} @keydown=${(event: KeyboardEvent) => { this.handleSearchKey(event, flat); }} />
        <div class="models" id="model-list" role="listbox" aria-label="Models">
          ${flat.length === 0 ? html`<div class="empty">No models</div>` : groups.map((group, groupIndex) => html`
            <div role="group" aria-labelledby=${`provider-${String(groupIndex)}`}>
              <div class="provider" id=${`provider-${String(groupIndex)}`} role="presentation">${group.provider}</div>
              ${group.models.map((entry) => {
                const isCurrent = entry.provider === current?.provider && entry.id === current.id;
                const isActive = entry === active;
                return html`<div class=${`model${isActive ? " active" : ""}`} id=${optionId(entry)} role="option" aria-selected=${isCurrent ? "true" : "false"} title=${entry.name ?? entry.id} ${scrollWhenSelected(isActive, this.query)} @pointerdown=${(event: PointerEvent) => { event.preventDefault(); }} @click=${() => { this.chooseModel(entry); }}>
                  <span class="mark">${isCurrent ? CHECK_ICON : null}</span><span class="model-id">${entry.id}</span>
                </div>`;
              })}
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private setOpen(open: boolean, restoreFocus = false): void {
    if (open === this.open) return;
    this.open = open;
    this.openGeneration += 1;
    if (!open) {
      document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
      if (restoreFocus) void this.updateComplete.then(() => { this.renderRoot.querySelector<HTMLButtonElement>(".trigger")?.focus(); });
      return;
    }
    document.addEventListener("pointerdown", this.closeOnOutsidePointer, true);
    this.query = "";
    this.activeIndex = 0;
    void this.updateComplete.then(() => { this.renderRoot.querySelector<HTMLInputElement>(".search")?.focus(); });
    const generation = this.openGeneration;
    void this.loadModels?.().then((models) => {
      if (generation !== this.openGeneration) return;
      this.models = models;
      const current = this.status?.model;
      const index = modelPickerGroups(models, "").flatMap((group) => group.models).findIndex((model) => model.provider === current?.provider && model.id === current.id);
      this.activeIndex = Math.max(0, index);
    });
  }

  private chooseModel(model: QualifiedModel): void {
    this.setOpen(false, true);
    void this.onSetModel?.(model.provider, model.id);
  }

  private handleSearch(event: Event): void {
    if (!(event.currentTarget instanceof HTMLInputElement)) return;
    this.query = event.currentTarget.value;
    this.activeIndex = 0;
  }

  private handleSearchKey(event: KeyboardEvent, flat: readonly QualifiedModel[]): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length > 0) this.activeIndex = (Math.min(this.activeIndex, flat.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = flat[Math.min(this.activeIndex, flat.length - 1)];
      if (model !== undefined) this.chooseModel(model);
    }
  }

  private handlePopoverKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.setOpen(false, true);
  }

  private handleFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && next !== this && !this.renderRoot.contains(next)) this.setOpen(false);
  }

  /** Radio group keys (WAI-ARIA APG): arrows move focus and select the level. */
  private handleEffortKey(event: KeyboardEvent): void {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const levels = this.thinkingLevels;
    const current = event.currentTarget instanceof HTMLElement ? levels.indexOf(event.currentTarget.dataset["level"] ?? "") : -1;
    const target = event.key === "Home" ? 0 : event.key === "End" ? levels.length - 1 : step === 0 ? -1 : (current + step + levels.length) % levels.length;
    const level = levels[target];
    if (level === undefined) return;
    event.preventDefault();
    // Move the roving tab stop now so Tab leaves the row even before the session confirms the level.
    for (const radio of this.renderRoot.querySelectorAll<HTMLButtonElement>('.effort [role="radio"]')) radio.tabIndex = radio.dataset["level"] === level ? 0 : -1;
    this.renderRoot.querySelector<HTMLButtonElement>(`.effort [data-level="${level}"]`)?.focus();
    void this.onSetThinkingLevel?.(level);
  }

  static override styles = css`
    :host { display: flex; flex: 0 1 auto; min-width: 0; }
    button { font: inherit; cursor: pointer; }
    button:focus-visible, .search:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
    .trigger { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: min(42vw, 360px); min-height: var(--composer-control-size, 24px); padding: 0 4px; border: 0; border-radius: 6px; background: transparent; color: var(--pi-text-secondary, var(--pi-text)); white-space: nowrap; }
    .trigger:hover, .trigger[aria-expanded="true"] { background: var(--pi-surface-hover); color: var(--pi-text); }
    .model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .separator { color: var(--pi-dim); }
    .thinking { flex: 0 0 auto; }
    /* Anchored to the composer footer (the nearest positioned ancestor), left-aligned above it. */
    .popover { position: absolute; z-index: 20; left: 10px; bottom: calc(100% + 4px); display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; width: min(360px, calc(100% - 20px)); max-height: min(440px, 60vh); padding: 8px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); box-shadow: 0 8px 24px var(--pi-shadow); color: var(--pi-text); font: 12px system-ui, sans-serif; white-space: normal; }
    .effort { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 8px; background: var(--pi-bg); }
    .effort > button { flex: 1 1 auto; min-height: 26px; padding: 2px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--pi-muted); }
    .effort > button:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .effort > button[aria-checked="true"] { border-color: var(--pi-accent); background: var(--pi-surface); color: var(--pi-text); font-weight: 600; }
    .search { box-sizing: border-box; width: 100%; padding: 5px 8px; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text); font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); }
    .models { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .provider { position: sticky; top: 0; padding: 6px 6px 2px; background: var(--pi-surface); color: var(--pi-muted); font-size: 11px; }
    .model { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
    .model:hover { background: var(--pi-surface-hover); }
    .model.active { background: var(--pi-surface-hover); outline: 1px solid var(--pi-accent); outline-offset: -1px; }
    .model[aria-selected="true"] { font-weight: 600; }
    .mark { display: inline-grid; place-items: center; width: 14px; flex: 0 0 auto; color: var(--pi-accent); }
    .mark svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .model-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { padding: 6px; color: var(--pi-muted); }
    /* Narrow composer: a full-width sheet above the composer. */
    @container composer (max-width: 560px) {
      .trigger { max-width: 40cqi; }
      .popover { right: 6px; left: 6px; width: auto; }
    }
    @media (pointer: coarse) {
      .effort > button { min-height: 34px; }
      .model { min-height: 34px; }
    }
    @media (forced-colors: active) {
      button:focus-visible, .search:focus-visible { outline-color: Highlight; }
      .model.active { outline-color: Highlight; }
    }
  `;
}

function optionId(model: QualifiedModel): string {
  return `model-${model.provider}-${model.id}`.replace(/[^\w-]/g, "_");
}
