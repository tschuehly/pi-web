import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { builtInPresentationProfile, resolvePresentationProfile, type PresentationProfileDefinition, type ResolvedPresentationProfile } from "../../presentationProfiles";
import "./SettingsPanelFrame";
import type { SettingsNotice } from "./SettingsPanelFrame";

@customElement("settings-appearance-panel")
export class SettingsAppearancePanel extends LitElement {
  @property() configPath = "";
  @property() configModifiedAt = "";
  @property({ type: Boolean }) loading = false;
  @property() error = "";
  @property({ attribute: false }) profiles: readonly PresentationProfileDefinition[] = [];
  @property({ attribute: false }) profileErrors: Readonly<Record<string, string>> = {};
  @property({ attribute: false }) activeProfile: ResolvedPresentationProfile = builtInPresentationProfile("comfortable");
  @property({ attribute: false }) previewProfile?: ResolvedPresentationProfile;
  @property({ type: Boolean }) activeProfileChanged = false;
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onPreview?: (profileId: string) => void;
  @property({ attribute: false }) onApplyPreview?: () => void;
  @property({ attribute: false }) onCancelPreview?: () => void;

  override render(): TemplateResult {
    const selectedId = this.previewProfile?.id ?? this.activeProfile.id;
    const availableProfiles = this.availableProfiles();
    const activeAvailable = availableProfiles.some((profile) => profile.id === this.activeProfile.id);
    return html`
      <settings-panel-frame
        heading="Appearance"
        description="Presentation profiles apply semantic spacing and sizing without exposing PI WEB internals."
        actionLabel="Reload profiles"
        .actionDisabled=${this.loading}
        .notices=${this.notices(activeAvailable)}
        .onAction=${() => { void this.onReload?.(); }}
      >
        <details class="config-source">
          <summary>Profile source · global config</summary>
          <code>${this.configPath || "Config path unavailable"}</code>
          ${this.configModifiedAt === "" ? nothing : html`<small>Config modified ${formatModifiedAt(this.configModifiedAt)}</small>`}
          <small>Agents may edit named profiles in <code>presentationProfiles</code>. Changes never activate without preview and Apply.</small>
        </details>

        <fieldset>
          <legend>Presentation profile</legend>
          <p>Choose a built-in profile or preview a validated custom profile. Compact and custom profiles do not change body text size; coarse-pointer layouts retain touch-safe controls.</p>
          <div class="profile-options">
            ${availableProfiles.map((profile) => this.renderProfileOption(profile, selectedId))}
          </div>
          ${selectedId === "comfortable" ? nothing : html`<button class="reset-button" @click=${() => { this.onPreview?.("comfortable"); }}>Reset preview to Comfortable</button>`}
        </fieldset>

        ${Object.keys(this.profileErrors).length === 0 ? nothing : html`
          <section class="invalid-profiles" aria-label="Invalid presentation profiles">
            <h3>Profiles needing correction</h3>
            ${Object.entries(this.profileErrors).sort(([left], [right]) => left.localeCompare(right)).map(([id, message]) => html`
              <article><strong>${id}</strong><span>${message}</span></article>
            `)}
          </section>
        `}

        ${this.activeProfileChanged ? html`
          <section class="pending-update" aria-label="Pending active profile revision">
            <div><strong>${this.activeProfile.title} changed in config</strong><span>The last applied revision remains active.</span></div>
            <button @click=${() => { this.onPreview?.(this.activeProfile.id); }}>Preview updated revision</button>
          </section>
        ` : nothing}

        ${this.previewProfile === undefined ? nothing : html`
          <footer class="preview-actions" aria-live="polite">
            <span>Previewing <strong>${this.previewProfile.title}</strong>. Apply to keep it in this browser.</span>
            <div>
              <button @click=${() => { this.onCancelPreview?.(); }}>Cancel</button>
              <button class="primary" @click=${() => { this.onApplyPreview?.(); }}>Apply profile</button>
            </div>
          </footer>
        `}
      </settings-panel-frame>
    `;
  }

  private availableProfiles(): ResolvedPresentationProfile[] {
    return [
      builtInPresentationProfile("comfortable"),
      builtInPresentationProfile("compact"),
      ...this.profiles.flatMap((profile) => {
        const resolved = resolvePresentationProfile(profile.id, this.profiles);
        return resolved === undefined ? [] : [resolved];
      }),
    ];
  }

  private notices(activeAvailable: boolean): readonly SettingsNotice[] {
    const notices: SettingsNotice[] = [];
    if (this.error !== "") notices.push({ type: "error", content: this.error });
    if (!activeAvailable) {
      notices.push({
        type: "warning",
        title: "Active profile is unavailable",
        content: `${this.activeProfile.title} remains active from its last valid browser snapshot. Correct or restore the config profile, or apply a built-in profile.`,
      });
    }
    if (this.previewProfile !== undefined) notices.push({ type: "info", content: "Preview is temporary and will be cancelled when Settings closes." });
    return notices;
  }

  private renderProfileOption(profile: ResolvedPresentationProfile, selectedId: string): TemplateResult {
    const selected = selectedId === profile.id;
    const active = this.activeProfile.id === profile.id;
    return html`
      <label class=${selected ? "profile-option selected" : "profile-option"}>
        <input
          type="radio"
          name="presentation-profile"
          value=${profile.id}
          .checked=${selected}
          @change=${() => { this.onPreview?.(profile.id); }}
        >
        <span class="option-copy">
          <span class="option-heading"><strong>${profile.title}</strong>${active ? html`<span class="active-badge">active</span>` : nothing}</span>
          <small>${profile.description}</small>
          <small class="provenance">${profile.origin === "built-in" ? "Built in" : `Global config · extends ${profile.base}`} · revision ${profile.revision.slice(3)}</small>
        </span>
      </label>
    `;
  }

  static override styles = css`
    :host { display: block; }
    fieldset, .config-source, .invalid-profiles, .pending-update, .preview-actions { min-width: 0; margin: 0; }
    fieldset { padding: 0; border: 0; }
    legend { padding: 0; color: var(--pi-text); font-weight: 700; }
    p { margin: 5px 0 10px; color: var(--pi-muted); line-height: 1.4; }
    button { min-height: var(--pi-control-min-size); border: 0; border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: var(--pi-control-padding-block) var(--pi-control-padding-inline); font: inherit; cursor: pointer; }
    button:hover { background: var(--pi-surface-hover); }
    button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .primary { color: var(--pi-text-bright); background: var(--pi-accent-border); }
    .config-source { padding: 6px 8px; border-radius: 6px; background: var(--pi-surface); color: var(--pi-muted); }
    .config-source summary { cursor: pointer; font-size: 12px; font-weight: 650; }
    .config-source[open] { display: grid; gap: 5px; }
    code { border-radius: 4px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .config-source > code { display: block; margin-top: 5px; padding: 5px 7px; }
    .config-source small { color: var(--pi-muted); line-height: 1.35; }
    .profile-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--pi-toolbar-gap); }
    .reset-button { margin-top: var(--pi-toolbar-gap); }
    .profile-option { box-sizing: border-box; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 8px; min-width: 0; min-height: var(--pi-control-min-size); padding: var(--pi-panel-padding); border-radius: 6px; background: var(--pi-surface); cursor: pointer; }
    .profile-option:hover { background: var(--pi-surface-hover); }
    .profile-option.selected { color: var(--pi-text-bright); background: var(--pi-selection-bg); }
    .profile-option:has(input:focus-visible) { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    input { margin: 3px 0 0; accent-color: var(--pi-accent); }
    .option-copy { display: grid; gap: 4px; min-width: 0; }
    .option-heading { display: flex; align-items: baseline; gap: 6px; }
    .active-badge { border-radius: 999px; background: color-mix(in srgb, var(--pi-accent) 14%, transparent); color: var(--pi-accent); padding: 0 5px; font-size: 10px; font-weight: 600; }
    small { color: var(--pi-muted); line-height: 1.4; }
    .provenance { color: var(--pi-dim); font-size: 11px; }
    .invalid-profiles { display: grid; gap: var(--pi-toolbar-gap); padding: 8px 10px; border-radius: 6px; background: var(--pi-warning-surface); }
    h3 { margin: 0; font-size: 13px; }
    .invalid-profiles article { display: grid; gap: 3px; padding-top: var(--pi-toolbar-gap); }
    .invalid-profiles article span { color: var(--pi-danger); line-height: 1.4; }
    .pending-update, .preview-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--pi-toolbar-gap); padding: 8px 10px; border-radius: 6px; background: var(--pi-surface); }
    .pending-update > div { display: grid; gap: 3px; }
    .pending-update span, .preview-actions > span { color: var(--pi-muted); }
    .preview-actions > div { flex: 0 0 auto; display: flex; gap: var(--pi-toolbar-gap); }

    @media (max-width: 620px) {
      .profile-options { grid-template-columns: minmax(0, 1fr); }
      .pending-update, .preview-actions { align-items: stretch; flex-direction: column; }
      .preview-actions > div { justify-content: flex-end; }
    }
  `;
}

function formatModifiedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-appearance-panel": SettingsAppearancePanel;
  }
}
