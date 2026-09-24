import { LitElement, css, html, nothing } from "lit";
import { nativeDirectoryPicker } from "../nativeHost";
import { customElement, property, state } from "lit/decorators.js";
import { applyInterfaceScale, INTERFACE_SCALE_CSS_PROPERTY, INTERFACE_SCALE_STEPS, parseInterfaceScale, readStoredInterfaceScale, writeStoredInterfaceScale } from "../interfaceScale";
import { applyPresentationProfile, builtInPresentationProfile, readStoredPresentationProfile, writeStoredPresentationProfile, type BuiltInPresentationProfileId } from "../presentationProfiles";
import type { QualifiedThemeContribution, QualifiedThemePairContribution } from "../plugins/types";
import { findThemePairForTheme, type ThemePreference } from "../theme";

/**
 * The Workbench shell's one settings entry point: a small popover over the preferences
 * that already exist in interfaceScale.ts, theme.ts, and presentationProfiles.ts. It applies
 * and persists interface scale and presentation profile itself (both are self-contained
 * modules); theme changes are reported to the host, which already owns theme resolution
 * and system-preference tracking.
 */
@customElement("workbench-settings-panel")
export class WorkbenchSettingsPanel extends LitElement {
  @property({ attribute: false }) themePreference!: ThemePreference;
  @property({ attribute: false }) themes: readonly QualifiedThemeContribution[] = [];
  @property({ attribute: false }) themePairs: readonly QualifiedThemePairContribution[] = [];
  @property({ attribute: false }) onThemePreferenceChange?: (preference: ThemePreference) => void;

  @state() private open = false;
  @state() private anchorTop = 0;
  @state() private anchorRight = 0;
  @state() private scale = readStoredInterfaceScale();
  @state() private profileId: BuiltInPresentationProfileId = readStoredPresentationProfile()?.base ?? "comfortable";
  @state() private sleepDisabled: boolean | undefined;
  @state() private sleepPending = false;
  @state() private sleepError = "";
  @state() private sleepChangeError = "";
  private sleepPoll: ReturnType<typeof setInterval> | undefined;
  private sleepReadVersion = 0;

  private readonly onDocumentClick = (event: MouseEvent): void => {
    if (event.composedPath().includes(this)) return;
    this.close();
  };

  // ponytail: a live-repositioning popover needs a resize observer; closing on resize is
  // the smaller fix and the anchored position only goes stale while the panel is open.
  private readonly onWindowResize = (): void => { this.close(); };

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick);
    window.removeEventListener("resize", this.onWindowResize);
    this.stopSleepPolling();
    super.disconnectedCallback();
  }

  override render() {
    return html`
      <button
        class="trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded=${this.open}
        title="Workbench settings"
        aria-label="Workbench settings"
        @click=${() => { this.toggle(); }}
      >⚙</button>
      ${this.open ? this.renderPopover() : nothing}
    `;
  }

  private renderPopover() {
    const pair = findThemePairForTheme(this.themePairs, this.themePreference.themeId);
    const currentScheme = this.themes.find((theme) => theme.id === this.themePreference.themeId)?.colorScheme;
    return html`
      <div class="popover" role="dialog" aria-label="Workbench settings" style="top: ${String(this.anchorTop)}px; right: ${String(this.anchorRight)}px; max-height: calc(var(--pi-workbench-viewport-height, 100vh) - ${String(this.anchorTop)}px - 12px);" @keydown=${(event: KeyboardEvent) => { this.onPopoverKeyDown(event); }}>
        <fieldset>
          <legend>Theme</legend>
          <label class="checkbox">
            <input type="checkbox" .checked=${this.themePreference.auto} @change=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.setAuto(event.target.checked); }}>
            Follow system theme
          </label>
          ${pair === undefined ? nothing : html`
            <div role="radiogroup" aria-label="Theme appearance">
              <label class="radio">
                <input type="radio" name="theme-scheme" .checked=${!this.themePreference.auto && currentScheme === "light"} @change=${() => { this.setScheme(pair, "light"); }}>
                Light
              </label>
              <label class="radio">
                <input type="radio" name="theme-scheme" .checked=${!this.themePreference.auto && currentScheme === "dark"} @change=${() => { this.setScheme(pair, "dark"); }}>
                Dark
              </label>
            </div>
          `}
        </fieldset>
        <fieldset>
          <legend><label for="workbench-settings-scale">Interface scale</label></legend>
          <select id="workbench-settings-scale" @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) this.setScale(Number(event.target.value)); }}>
            ${INTERFACE_SCALE_STEPS.map((step) => html`<option value=${String(step)} .selected=${step === this.scale}>${Math.round(step * 100)}%</option>`)}
          </select>
        </fieldset>
        <fieldset>
          <legend><label for="workbench-settings-profile">Presentation</label></legend>
          <select id="workbench-settings-profile" @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) this.setProfile(event.target.value === "compact" ? "compact" : "comfortable"); }}>
            <option value="comfortable" .selected=${this.profileId === "comfortable"}>Comfortable</option>
            <option value="compact" .selected=${this.profileId === "compact"}>Compact</option>
          </select>
        </fieldset>
        ${this.sleepHost() === undefined ? nothing : html`
          <fieldset>
            <legend>System sleep (battery and AC)</legend>
            <p class="sleep-status" role="status" aria-live="polite">${this.sleepPending ? "Changing system sleep setting…" : this.sleepDisabled === undefined ? "Checking system sleep setting…" : this.sleepDisabled ? "System sleep disabled" : "System sleep enabled"}</p>
            <button type="button" ?disabled=${this.sleepPending || this.sleepDisabled === undefined} @click=${() => { void this.changeSleep(); }}>${this.sleepDisabled === true ? "Enable system sleep" : "Disable system sleep"}</button>
            <small>This setting persists after quitting or restarting the Mac. To restore sleep outside Workbench: sudo /usr/bin/pmset -a disablesleep 0</small>
            ${this.sleepChangeError !== "" ? html`<p role="alert" class="sleep-error">${this.sleepChangeError} ${this.sleepDisabled === undefined ? "Current state could not be verified; Settings will retry." : "Current state was reread."}</p>`
              : this.sleepError === "" ? nothing : html`<p role="alert" class="sleep-error">${this.sleepError}</p>`}
          </fieldset>
        `}
      </div>
    `;
  }

  private toggle(): void {
    if (this.open) { this.close(); return; }
    const appliedScale = parseInterfaceScale(document.documentElement.style.getPropertyValue(INTERFACE_SCALE_CSS_PROPERTY)) ?? this.scale;
    this.positionPopover(appliedScale);
    this.open = true;
    document.addEventListener("click", this.onDocumentClick);
    window.addEventListener("resize", this.onWindowResize);
    if (this.sleepHost() !== undefined) {
      this.sleepDisabled = undefined;
      this.sleepError = "";
      this.sleepChangeError = "";
      void this.readSleep();
      this.sleepPoll = setInterval(() => { if (!this.sleepPending) void this.readSleep(); }, 5000);
    }
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>(".popover input, .popover select")?.focus();
    });
  }

  private positionPopover(scale: number): void {
    const rect = this.renderRoot.querySelector(".trigger")?.getBoundingClientRect();
    this.anchorTop = ((rect?.bottom ?? 0) + 6) / scale;
    this.anchorRight = Math.max(8, window.innerWidth - (rect?.right ?? window.innerWidth)) / scale;
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    this.stopSleepPolling();
    document.removeEventListener("click", this.onDocumentClick);
    window.removeEventListener("resize", this.onWindowResize);
    this.renderRoot.querySelector<HTMLButtonElement>(".trigger")?.focus();
  }

  private onPopoverKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  private sleepHost() {
    const host = nativeDirectoryPicker("local");
    return typeof host?.getSleepDisabled === "function" && typeof host.setSleepDisabled === "function" ? host : undefined;
  }

  private stopSleepPolling(): void {
    if (this.sleepPoll !== undefined) clearInterval(this.sleepPoll);
    this.sleepPoll = undefined;
    this.sleepReadVersion++;
  }

  private async readSleep(): Promise<void> {
    const host = this.sleepHost();
    if (host?.getSleepDisabled === undefined) return;
    const version = ++this.sleepReadVersion;
    try {
      const disabled = await host.getSleepDisabled();
      if (version !== this.sleepReadVersion) return;
      if (typeof disabled !== "boolean") throw new Error("Invalid system sleep state from native host");
      this.sleepDisabled = disabled;
      this.sleepError = "";
    } catch (error) {
      if (version !== this.sleepReadVersion) return;
      this.sleepDisabled = undefined;
      this.sleepError = `Could not read system sleep state: ${String(error)}. Retrying while Settings is open; reopen to retry now.`;
    }
  }

  private async changeSleep(): Promise<void> {
    const host = this.sleepHost();
    if (host?.setSleepDisabled === undefined || this.sleepPending || this.sleepDisabled === undefined) return;
    const target = !this.sleepDisabled;
    if (!window.confirm(`${target ? "Disable" : "Enable"} system sleep on battery and AC? This setting persists after Workbench quits and after a reboot.`)) return;
    this.sleepPending = true;
    this.sleepError = "";
    this.sleepChangeError = "";
    this.sleepReadVersion++;
    try {
      const actual = await host.setSleepDisabled(target);
      if (typeof actual !== "boolean") throw new Error("Native host did not confirm system sleep state");
      this.sleepDisabled = actual;
    } catch (error) {
      const detail = String(error);
      this.sleepDisabled = undefined;
      this.sleepChangeError = detail.includes("SLEEP_CONTROL_USER_CANCELLED:") ? "System sleep change cancelled."
        : detail.includes("SLEEP_CONTROL_STATE_UNVERIFIED:") ? "System sleep may have changed."
        : detail.includes("SLEEP_CONTROL_TIMEOUT:") ? "System sleep change timed out; the setting may have changed."
        : `System sleep change failed: ${detail}.`;
    } finally {
      this.sleepPending = false;
      if (this.open && this.sleepChangeError !== "") await this.readSleep();
    }
  }

  private setAuto(auto: boolean): void {
    this.onThemePreferenceChange?.({ themeId: this.themePreference.themeId, auto });
  }

  private setScheme(pair: QualifiedThemePairContribution, scheme: "light" | "dark"): void {
    this.onThemePreferenceChange?.({ themeId: scheme === "light" ? pair.light : pair.dark, auto: false });
  }

  private setScale(scale: number): void {
    if (!Number.isFinite(scale)) return;
    writeStoredInterfaceScale(scale);
    applyInterfaceScale(scale);
    this.scale = scale;
    this.positionPopover(scale);
  }

  private setProfile(id: BuiltInPresentationProfileId): void {
    const profile = builtInPresentationProfile(id);
    applyPresentationProfile(profile);
    writeStoredPresentationProfile(profile);
    this.profileId = id;
  }

  static override styles = css`
    :host { position: relative; display: inline-block; }
    .trigger { box-sizing: border-box; width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 7px; background: none; color: var(--pi-muted); font-size: 16px; cursor: pointer; }
    .trigger:hover { border-color: var(--pi-border); color: var(--pi-text); background: var(--pi-surface-hover); }
    .trigger:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .popover { position: fixed; z-index: 20; box-sizing: border-box; width: min(260px, calc(var(--pi-workbench-viewport-width, 100vw) - 24px)); overflow-y: auto; display: grid; gap: 12px; padding: 12px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); box-shadow: 0 12px 30px var(--pi-shadow); }
    fieldset { margin: 0; padding: 0; border: 0; display: grid; gap: 6px; }
    legend { padding: 0; margin-bottom: 4px; color: var(--pi-text); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    label { color: var(--pi-text); font-size: 13px; }
    .checkbox, .radio { display: flex; align-items: center; gap: 6px; }
    [role="radiogroup"] { display: flex; gap: 14px; }
    select { box-sizing: border-box; width: 100%; min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: var(--pi-control-padding-block) var(--pi-control-padding-inline); font: 13px system-ui, sans-serif; }
    select:focus-visible, input:focus-visible, fieldset button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .sleep-status, .sleep-error { margin: 0; font-size: 13px; color: var(--pi-text); }
    .sleep-error { color: var(--pi-error, var(--pi-text)); }
    fieldset button { min-height: var(--pi-control-min-size); border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); cursor: pointer; }
    fieldset button:disabled { opacity: .55; cursor: default; }
    small { color: var(--pi-muted); line-height: 1.4; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "workbench-settings-panel": WorkbenchSettingsPanel;
  }
}
