import { css } from "lit";
import { uiButtonStyles, uiMenuStyles, uiToolbarStyles, uiTabStyles } from "./controlStyles";
import { chatNavigationStyles } from "./chatNavigationStyles";
import { promptEditorIntegrationStyles } from "./promptEditorIntegrationStyles";

// The base theme owns default shell layout and presentation; components retain behaviour.

/** Directional navigation shadow that avoids a halo above the fixed heading edge. */
export const scrollBoundaryShadow = css`0 8px 18px -8px var(--pi-shadow-soft)`;

export const appStyles = css`
  @layer pi-web-base {
  /* Mobile browsers already subtract browser controls from 100dvh; reserve bottom safe area only in standalone PWA modes. */
  :host { --pi-app-safe-area-bottom: 0px; position: fixed; top: 0; right: 0; left: 0; display: block; height: 100dvh; box-sizing: border-box; overflow: hidden; padding: env(safe-area-inset-top) env(safe-area-inset-right) var(--pi-app-safe-area-bottom) env(safe-area-inset-left); color: var(--pi-text); background: var(--pi-bg); font: 14px var(--pi-font, system-ui, sans-serif); }
  :host([pwa-display-mode]) { --pi-app-safe-area-bottom: env(safe-area-inset-bottom); }
  @media (display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui) {
    :host { --pi-app-safe-area-bottom: env(safe-area-inset-bottom); }
  }
  .shell { --navigation-panel-size: 340px; --workspace-panel-size: minmax(360px, 42vw); --navigation-panel-width: var(--navigation-panel-size); --workspace-panel-width: var(--workspace-panel-size); display: grid; grid-template-columns: var(--navigation-panel-width) 1px minmax(320px, 1fr) 1px var(--workspace-panel-width); height: 100%; min-height: 0; }
  aside { grid-column: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  aside app-navigation-panel { flex: 1 1 auto; min-height: 0; }
  header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--pi-border); }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  main { grid-column: 3; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .context-bar { position: relative; flex: 0 0 auto; min-width: 0; display: none; align-items: center; gap: 0; padding: 6px 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
  .context-bar::before, .context-bar::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 20px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .context-bar::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .context-bar::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .context-bar.can-scroll-left::before, .context-bar.can-scroll-right::after { opacity: 1; }
  .context-bar-label { display: none; }
  .context-items { flex: 1 1 auto; min-width: 0; display: flex; align-items: stretch; gap: 5px; margin: 0; padding: 0 8px; list-style: none; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scroll-padding-inline: 8px; scrollbar-width: thin; }
  .context-bar.has-context-actions .context-items { padding-right: 52px; scroll-padding-inline: 8px 52px; }
  .context-item { flex: 0 0 auto; min-width: 0; display: flex; }
  .context-actions { position: absolute; top: 6px; right: 0; bottom: 6px; z-index: 3; display: flex; align-items: center; padding: 0 8px 0 0; pointer-events: none; }
  .context-actions::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; z-index: 0; width: 26px; background: var(--pi-bg); pointer-events: none; }
  .context-chip { flex: 0 0 auto; min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; border: 1px solid var(--pi-border-muted); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 8px; font: inherit; text-align: left; }
  .context-chip:hover { background: var(--pi-surface-hover); }
  .context-chip:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
  .context-chip.empty { border-style: dashed; color: var(--pi-muted); }
  .context-kind { display: none; }
  .context-value { min-width: 0; overflow: visible; text-overflow: clip; white-space: nowrap; }
  app-mobile-main-tabs { display: none; }
  app-mobile-main-tabs[panel-controls] { display: block; }
  .mobile-tabs-frame { position: relative; display: none; flex: 0 0 auto; min-width: 0; border-bottom: 1px solid var(--pi-border); background: var(--pi-bg); }
  .mobile-tabs-frame::before, .mobile-tabs-frame::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 20px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .mobile-tabs-frame::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .mobile-tabs-frame::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .mobile-tabs-frame.can-scroll-left::before, .mobile-tabs-frame.can-scroll-right::after { opacity: 1; }
  .mobile-tabs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; padding: 8px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; }
  .mobile-tabs button { flex: 0 0 auto; white-space: nowrap; }
  .mobile-navigation-tab, .mobile-navigation-panel { display: none; }
  .mobile-tabs button.selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .tab-badge { display: inline-block; min-width: 14px; margin-left: 4px; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 0 5px; font-size: 11px; line-height: 16px; text-align: center; }
  workspace-panel { grid-column: 5; min-width: 0; min-height: 0; overflow: hidden; }
  @media (min-width: 1181px) {
    .shell.navigation-panel-collapsed { --navigation-panel-width: 0px; }
    .shell.navigation-panel-collapsed > aside { display: none; }
    .shell.two-column-layout.workspace-panel-collapsed { grid-template-columns: var(--navigation-panel-width) 1px minmax(0, 1fr) 1px; }
    .shell.workspace-panel-collapsed > app-panel-edge-control[side="workspace"] { grid-row: 1 / 3; }
  }
  .shell.two-column-layout { grid-template-columns: var(--navigation-panel-width) 1px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .shell.two-column-layout.navigation-panel-collapsed { --navigation-panel-width: 0px; }
  .shell.two-column-layout.navigation-panel-collapsed > aside { display: none; }
  .two-column-layout > aside, .two-column-layout > app-panel-edge-control[side="navigation"] { grid-row: 1 / 3; }
  .two-column-layout main { grid-column: 3; grid-row: 1 / 3; }
  .two-column-layout app-mobile-main-tabs { display: block; flex: 0 0 auto; min-width: 0; }
  .two-column-layout .mobile-tabs-frame { display: flex; }
  .shell.two-column-layout.workspace-view main { grid-row: 1; min-height: auto; }
  .shell.two-column-layout.workspace-view > workspace-panel { grid-column: 3; grid-row: 2; display: flex; border-left: 0; }
  .shell.two-column-layout:not(.workspace-view) > workspace-panel { display: none; }
  .two-column-layout main.workspace-view conversation-layout,
  .two-column-layout main.workspace-view .empty { display: none; }
  .two-column-layout main.workspace-view { overflow: hidden; }
  @media (max-width: 760px) {
    .shell.two-column-layout { grid-template-columns: minmax(0, 1fr); }
    aside { display: none; }
    .two-column-layout main, .shell.two-column-layout.workspace-view > workspace-panel { grid-column: 1; }
    .context-bar { display: flex; }
    .mobile-navigation-tab { display: block; }
    main.navigation-view conversation-layout,
    main.navigation-view .empty { display: none; }
    main.navigation-view .mobile-navigation-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    main.navigation-view .mobile-navigation-panel app-navigation-panel { flex: 1 1 auto; min-height: 0; }
  }
  status-bar { flex: 0 0 auto; }
  conversation-layout { flex: 1 1 auto; min-width: 0; min-height: 0; }
  .composer-area { display: grid; min-width: 0; background: var(--pi-bg); }
  /* Share a grid cell instead of adding banner height; allow long notices to grow the area rather than clip their controls. */
  .composer-area > prompt-editor, .composer-activity-notice { grid-area: 1 / 1; min-width: 0; }
  .composer-area > prompt-editor[inert] { visibility: hidden; }
  .composer-activity-notice { z-index: 6; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--pi-warning-border); background: var(--pi-warning-surface); color: var(--pi-warning); }
  .composer-activity-notice-text { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
  .composer-activity-notice p { margin: 0; }
  .composer-activity-notice button { flex: 0 0 auto; }
  button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
  .empty { margin: auto; color: var(--pi-muted); }
  .error { display: flex; gap: 8px; align-items: flex-start; padding: 10px 16px; border-bottom: 1px solid var(--pi-border); color: var(--pi-danger); }
  .error.warning { border-bottom-color: var(--pi-warning-border); color: var(--pi-warning); background: var(--pi-warning-surface); }
  .error.info { border-bottom-color: var(--pi-accent-border); color: var(--pi-text); background: var(--pi-selection-bg); }
  .error .error-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .error .error-dismiss { flex: 0 0 auto; padding: 0 6px; border: 0; background: none; color: inherit; line-height: 1.4; }
  .deprecation-notice { padding: 10px 16px; border-bottom: 1px solid var(--pi-border); color: var(--pi-warning); }
  .deprecation-notice .deprecation-notice-text { margin: 0; overflow-wrap: anywhere; }
  .deprecation-notice .deprecation-notice-text + .deprecation-notice-text { margin-top: 4px; }
  }
`;

export const workspacePanelStyles = css`
  ${uiButtonStyles}
  ${uiToolbarStyles}
  ${uiTabStyles}
  @layer pi-web-base {
  :host { display: flex; flex-direction: column; min-height: 0; color: var(--pi-text); background: var(--pi-bg); font: 13px var(--pi-font, system-ui, sans-serif); container-type: inline-size; }
  header { display: flex; align-items: stretch; flex: 0 0 auto; min-width: 0; border-bottom: 1px solid var(--pi-border); }
  .navigation-menu-button { flex: 0 0 auto; justify-content: center; min-width: 44px; margin: 0; }
  .panel-toggle { margin-inline-start: auto; border-inline-start: 1px solid var(--pi-border-muted); }
  .workspace-header-scroll-frame { flex: 1 1 auto; display: flex; position: relative; min-width: 0; background: var(--pi-bg); }
  .workspace-header-scroll-frame::before, .workspace-header-scroll-frame::after { content: ""; position: absolute; top: 0; bottom: 0; z-index: 2; width: 18px; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
  .workspace-header-scroll-frame::before { left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .workspace-header-scroll-frame::after { right: 0; background: linear-gradient(270deg, color-mix(in srgb, var(--pi-shadow-strong) 55%, transparent) 0%, transparent 100%); }
  .workspace-header-scroll-frame.can-scroll-left::before, .workspace-header-scroll-frame.can-scroll-right::after { opacity: 1; }
  .workspace-header-strip { flex: 1 1 auto; display: flex; justify-content: space-between; align-items: stretch; gap: 0; min-width: 0; padding: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; }
  .tabs button.icon-tab { min-width: 44px; }
  .tab-icon { flex: 0 0 auto; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  .tab-custom-icon { flex: 0 0 auto; width: 16px; height: 16px; display: inline-grid; place-items: center; color: currentColor; pointer-events: none; }
  .tab-custom-icon svg { width: 16px; height: 16px; pointer-events: none; }
  .tab-label { min-width: 0; }
  .tab-badge { flex: 0 0 auto; display: inline-block; min-width: 14px; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 0 5px; font-size: 11px; line-height: 16px; text-align: center; }
  @container (max-width: 430px) {
    .tabs button.icon-tab { justify-content: center; padding-inline: 10px; }
  }
  .panel-content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
  .empty-state { box-sizing: border-box; width: min(100%, 380px); margin: auto; padding: 24px; display: grid; gap: 8px; color: var(--pi-muted); text-align: center; }
  .empty-state h2 { margin: 0; color: var(--pi-text); font-size: 15px; line-height: 1.3; }
  .empty-state p { margin: 0; line-height: 1.45; }
  small, .muted { color: var(--pi-muted); }
  @media (max-width: 1180px) { header { display: none; } }
  .workspace-label { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
  .workspace-label-base, .workspace-label-item, .workspace-label-render { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .workspace-label-item, .workspace-label-render, .workspace-label-separator { color: var(--pi-muted); }
  .workspace-label-link { color: var(--pi-accent); text-decoration: none; }
  .workspace-label-link:hover, .workspace-label-link:focus { text-decoration: underline; }
  }
`;

export const listStyles = css`
  ${uiButtonStyles}
  ${uiToolbarStyles}
  ${uiMenuStyles}
  @layer pi-web-base {
  :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
  :host([collapsed]) { flex: 0 0 auto; min-height: auto; overflow: hidden; }
  section { box-sizing: border-box; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 0; }
  h2 { flex: 0 0 auto; margin: 0; color: var(--pi-muted); font-size: 12px; text-transform: uppercase; }
  h2.ui-toolbar { border-bottom: 1px solid var(--pi-border-muted); }
  section > h2 { position: relative; z-index: 3; background: var(--pi-bg); box-shadow: ${scrollBoundaryShadow}; }
  .list-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .subheading { margin-top: 14px; }
  .section-toggle { width: 100%; gap: 8px; }
  .section-toggle span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .section-title { display: grid; gap: 2px; min-width: 0; }
  .section-toggle .section-selected { display: block; color: var(--pi-text); font-size: 12px; font-weight: 600; line-height: 1.25; text-transform: none; }
  .section-toggle .section-count { flex: 0 0 auto; display: inline; color: var(--pi-muted); font-size: inherit; }
  .section-toggle small { display: inline; color: inherit; font-size: inherit; }
  .action-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; margin: 6px 0; cursor: pointer; }
  .action-row:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; border-radius: 8px; }
  .action-row.selected .action-main { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
  .action-row.archived .action-main { color: var(--pi-muted); }
  .action-main { position: relative; box-sizing: border-box; min-width: 0; width: 100%; border: 1px solid var(--pi-border); border-top-right-radius: 0; border-bottom-right-radius: 0; border-top-left-radius: 8px; border-bottom-left-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 22px 7px calc(9px + var(--depth, 0) * 16px); text-align: left; }
  .action-name { display: -webkit-box; max-height: 2.5em; overflow: hidden; overflow-wrap: anywhere; line-height: 1.25; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .action-row:not(.selected):hover .action-main { background: var(--pi-surface-hover); }
  .workspace-row .action-main { border-radius: 8px 0 0 8px; }
  .workspace-primary { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
  .workspace-primary-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-status { flex: 0 0 auto; color: var(--pi-warning); font-size: 12px; }
  .workspace-secondary { margin-top: 3px; }
  .workspace-menu-actions { margin: 0 0 8px; padding-bottom: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .workspace-menu-details { display: grid; gap: 6px; margin: 0; padding: 0 9px 5px; }
  .workspace-detail-row { display: grid; grid-template-columns: minmax(58px, max-content) minmax(0, 1fr); gap: 8px; align-items: baseline; }
  .workspace-detail-row dt { color: var(--pi-muted); font-size: 12px; white-space: normal; }
  .workspace-detail-row dd { min-width: 0; margin: 0; overflow-wrap: anywhere; white-space: normal; }
  .detail-copy { margin-left: 6px; vertical-align: middle; }
  .tree-marker { color: var(--pi-dim); margin-right: 5px; }
  .badge { display: inline-block; margin-left: 5px; border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); padding: 0 5px; font-size: 11px; font-weight: 400; }
  .action-activity { position: absolute; top: 50%; inset-inline-start: calc(6px + var(--depth, 0) * 16px + var(--agent-offset, 0px)); transform: translateY(-50%); z-index: 1; display: grid; place-items: center; width: 10px; height: 10px; }
  .action-activity .activity-indicator { margin: 0; vertical-align: 0; }
  .activity-indicator { flex: 0 0 auto; display: inline-block; width: 7px; height: 7px; margin-right: 6px; background: var(--pi-success); animation: pulse 1s ease-in-out infinite; vertical-align: 1px; }
  .activity-indicator.session { border-radius: 50%; background: var(--pi-success); }
  .activity-indicator.terminal { border-radius: 2px; background: var(--pi-accent); }
  /* Client-side sending (upload in flight); distinct from server activity, which propagates to workspace/machine rows. */
  .activity-indicator.sending { border-radius: 50%; background: var(--pi-warning); }
  /* Unread is a stable state, not ongoing work: keep it static and accent-colored. */
  .activity-indicator.unread { border-radius: 50%; background: var(--pi-accent); animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--pi-accent) 20%, transparent); }
  /* Unread + ongoing work: a static accent ring wraps the still-pulsing work dot. */
  .unread-ring { flex: 0 0 auto; box-sizing: border-box; display: inline-grid; place-items: center; width: 9px; height: 9px; margin-right: 6px; border: 1.5px solid var(--pi-accent); border-radius: 50%; vertical-align: 1px; }
  .unread-ring .activity-indicator { width: 5px; height: 5px; margin: 0; vertical-align: 0; }
  .action-activity .unread-ring { margin: 0; vertical-align: 0; }
  .action-menu { position: relative; align-self: stretch; }
  .action-menu-toggle { height: 100%; }
  .action-menu-panel { min-width: min(120px, calc(100vw - 16px)); overflow-wrap: anywhere; }
  .action-menu-description { display: block; padding: 0 9px 7px; color: var(--pi-muted); font-size: 12px; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; }
  .action-menu-description a { color: var(--pi-accent); text-decoration: none; }
  .action-menu-description a:hover, .action-menu-description a:focus-visible { text-decoration: underline; }
  .action-menu-error { color: var(--pi-danger, #c0392b); }
  small { display: block; color: var(--pi-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-label { min-width: 0; display: inline-flex; align-items: baseline; gap: 5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
  .workspace-label-base, .workspace-label-item, .workspace-label-render { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .workspace-label-item, .workspace-label-render, .workspace-label-separator { color: var(--pi-muted); }
  .workspace-label-link { color: var(--pi-accent); text-decoration: none; }
  .workspace-label-link:hover, .workspace-label-link:focus { text-decoration: underline; }
  .workspace-detail-row .workspace-label { overflow: visible; white-space: normal; flex-wrap: wrap; }
  .workspace-detail-row .workspace-label-base, .workspace-detail-row .workspace-label-item, .workspace-detail-row .workspace-label-render { overflow: visible; text-overflow: clip; overflow-wrap: anywhere; white-space: normal; }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  }
`;

export const statusBarStyles = css`
  @layer pi-web-base {
  :host { display: block; color: var(--pi-muted); font: 12px var(--pi-font, system-ui, sans-serif); }
  .bar { display: flex; justify-content: flex-end; gap: 12px; align-items: center; min-width: 0; padding: 7px 12px; border-top: 1px solid var(--pi-border); background: var(--pi-bg); white-space: nowrap; overflow: hidden; }
  span { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .warning-toggle { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; margin-right: auto; border: 0; background: transparent; color: inherit; padding: 0; font: inherit; line-height: 1; white-space: nowrap; cursor: pointer; }
  .warning-toggle:focus-visible { outline: 1px solid currentColor; outline-offset: 2px; }
  .warning-toggle-icon { flex: 0 0 auto; width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .activity { display: inline-flex; align-items: center; gap: 6px; color: var(--pi-muted); }
  .activity.active { color: var(--pi-success); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .45; flex: 0 0 auto; }
  .activity.active .dot { animation: pulse 1s ease-in-out infinite; opacity: 1; }
  .muted { color: var(--pi-dim); }
  @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  }
`;

export const autocompleteStyles = css`
  @layer pi-web-base {
  :host { display: block; }
  .menu { overflow: auto; padding: 0; color: var(--pi-text); border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 10px 30px var(--pi-shadow); }
  button { display: grid; grid-template-columns: minmax(120px, 1fr) auto; gap: 4px 10px; width: 100%; border: 0; border-bottom: 1px solid var(--pi-border); border-radius: 0; background: transparent; color: var(--pi-text); padding: 8px 10px; text-align: left; cursor: pointer; }
  button:last-child { border-bottom: 0; }
  button.selected, button:hover { background: var(--pi-selection-bg); }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .argument-hint { color: var(--pi-muted); font-size: 12px; }
  .detail { color: var(--pi-muted); font-size: 12px; }
  small { grid-column: 1 / -1; color: var(--pi-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
`;

export const promptEditorLayoutStyles = css`
  ${uiButtonStyles}
  ${uiMenuStyles}
  ${uiToolbarStyles}
  ${chatNavigationStyles}
  @layer pi-web-base {
  :host { position: relative; z-index: 5; display: block; color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
  /* One surface: the top rule is the composer's only boundary (and its resize edge); it turns accent while typing. */
  footer { --composer-control-size: 24px; position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 2px 10px 6px; border-top: 1px solid var(--pi-border); container: composer / inline-size; }
  footer.shell-mode { border-top-color: var(--pi-success); background: var(--pi-success-bg); }
  .editor-resize-handle { position: absolute; z-index: 4; top: -4px; right: 0; left: 0; height: 8px; cursor: ns-resize; touch-action: none; }
  .editor-resize-handle:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -2px; }
  .editor-wrap { position: relative; min-width: 0; }
  /* Negative inline margin puts ghost-control text on the editor's text edge. */
  .actions { display: flex; gap: 2px 12px; align-items: center; justify-content: flex-start; flex-wrap: wrap; margin-inline: -4px; white-space: nowrap; color: var(--pi-muted); font-size: 12px; }
  .composer-actions > button { border-color: transparent; background: transparent; }
  .composer-actions > button:hover:not(:disabled) { background: var(--pi-surface-hover); color: var(--pi-text); }
  .usage { display: flex; flex: 0 1 auto; min-width: 0; align-items: center; gap: 10px; margin: 0; padding: 0 4px; list-style: none; font-variant-numeric: tabular-nums; }
  .usage > li { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .context-meter { display: inline-flex; align-items: center; gap: 5px; }
  .context-ring { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke-width: 2.5; }
  .context-ring-track { stroke: currentColor; opacity: .3; }
  .context-ring-used { stroke: currentColor; }
  .context-warning { color: var(--pi-warning); }
  .context-danger { color: var(--pi-danger); }
  .visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0 0 0 0) !important; clip-path: inset(50%) !important; white-space: nowrap !important; border: 0 !important; }
  /* Growing (not an auto margin) keeps the mode icons against the actions on every wrapped row. */
  working-mode-controls { flex: 1 1 auto; }
  .composer-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; }
  .icon-button { flex: 0 0 auto; display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; }
  .icon-button .prompt-action-icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  .icon-button .prompt-action-icon-filled { fill: currentColor; stroke: none; }
  .attach-button { color: var(--pi-muted); }
  .attach-button .prompt-action-icon { width: 16px; height: 16px; }
  .attach-source-panel .attach-source-label { display: inline-flex; align-items: center; min-width: 0; }
  .attach-source-panel .attach-source-icon { display: inline-grid; place-items: center; flex: 0 0 auto; width: 16px; height: 16px; margin-inline-end: 9px; color: var(--pi-muted); }
  .attach-source-panel .attach-source-icon .prompt-action-icon { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  /* The one filled control: the primary action leads the row. */
  .composer-actions > .send-button:not(:disabled) { border-color: var(--pi-accent); background: var(--pi-accent); color: var(--pi-bg); }
  .composer-actions > .send-button:hover:not(:disabled) { background: var(--pi-accent-border, var(--pi-accent)); color: var(--pi-bg); }
  .stop-button:not(:disabled) { color: var(--pi-danger); }
  textarea { overflow-y: auto; padding: 6px 0; }
  .mode-hint { position: absolute; right: 0; bottom: 6px; max-width: 100%; border: 1px solid var(--pi-success-border); border-radius: 999px; background: var(--pi-success-surface); color: var(--pi-success); padding: 2px 8px; font-size: 12px; pointer-events: none; }
  .prompt-chips, .attachments { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
  /* A compact one-line tag; the full staged text sits in the title. */
  .prompt-chip { box-sizing: border-box; display: inline-flex; align-items: center; gap: 2px; max-width: min(240px, 100%); height: 22px; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 0 1px 0 7px; font-size: 12px; line-height: 1; }
  .prompt-chip button { flex: none; display: inline-grid; place-items: center; width: 18px; height: 18px; border: 0; border-radius: 4px; background: transparent; color: var(--pi-muted); padding: 0; }
  .prompt-chip button:hover:not(:disabled), .prompt-chip button:focus-visible { background: var(--pi-surface-hover); color: var(--pi-text); }
  .prompt-chip button:focus-visible { outline: 1px solid var(--pi-accent); outline-offset: 0; }
  .prompt-chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prompt-chip .prompt-action-icon { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  .chip-error { flex-basis: 100%; color: var(--pi-danger); font-size: 12px; }
  .attachment-chip { position: relative; width: 56px; height: 56px; border: 1px solid var(--pi-border); border-radius: 8px; overflow: hidden; background: var(--pi-bg); }
  .attachment-chip img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .attachment-image-reference { position: absolute; right: 3px; bottom: 3px; left: 3px; overflow: hidden; border-radius: 3px; background: color-mix(in srgb, var(--pi-bg) 82%, transparent); color: var(--pi-text); font: 700 10px/1.4 system-ui, sans-serif; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  .attachment-chip-file { display: grid; place-items: center; }
  .attachment-file-preview { display: grid; place-items: center; width: 34px; height: 26px; border: 1px solid var(--pi-border); border-radius: 4px; background: var(--pi-surface); color: var(--pi-muted); font: 700 10px/1 system-ui, sans-serif; letter-spacing: .03em; }
  .attachment-file-name { position: absolute; right: 4px; bottom: 3px; left: 4px; overflow: hidden; color: var(--pi-muted); font-size: 10px; line-height: 1.2; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  .attachment-remove { position: absolute; top: 1px; right: 1px; width: 18px; height: 18px; padding: 0; line-height: 16px; border-radius: 50%; border: 1px solid var(--pi-border); background: var(--pi-surface); color: var(--pi-text); font-size: 13px; cursor: pointer; }
  .attachment-delivery select { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; font: var(--pi-control-font-size, 16px) var(--pi-control-font-family, system-ui, sans-serif); }
  .attachment-error { flex-basis: 100%; color: var(--pi-danger); font-size: 12px; }
  button { min-height: 28px; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 3px 6px; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
  @media (pointer: coarse) {
    footer { --composer-control-size: 34px; }
    .editor-resize-handle { top: -8px; height: 16px; }
    .icon-button { width: 34px; height: 34px; }
  }
  @media (forced-colors: active) {
    .editor-resize-handle:focus-visible, button:focus-visible { outline-color: Highlight; }
  }
  /* Dense (a grid tile): one full-width tinted field, no rules. Icon-only meta and actions sit inside it at the right edge, on the input's last line. */
  :host([dense]) footer { gap: 1px; padding: 2px 6px; border-top: 0; }
  :host([dense]) footer.shell-mode { background: transparent; }
  /* One input-row in both layouts keeps the CodeMirror host across a dense toggle; only dense lays it out. */
  :host(:not([dense])) .input-row { display: contents; }
  :host([dense]) .input-row { display: flex; align-items: flex-end; gap: 4px; min-width: 0; padding: 0 2px 0 8px; border-radius: 8px; background: color-mix(in srgb, var(--pi-text) 6%, transparent); }
  :host([dense]) footer.shell-mode .input-row { background: var(--pi-success-bg); }
  /* Zero basis: the input takes what the icons leave, so its text wraps before them. */
  :host([dense]) .editor-wrap { flex: 1 1 0; min-width: min(90px, 30%); }
  :host([dense]) .dense-meta { flex: 0 1 auto; display: flex; align-items: center; gap: 2px; min-width: 0; height: 26px; margin-bottom: 1px; color: var(--pi-muted); font-size: 11px; white-space: nowrap; }
  :host([dense]) .dense-meta working-mode-controls { flex: 0 0 auto; }
  :host([dense]) .dense-meta .usage { flex: 0 0 auto; gap: 6px; padding: 0; }
  :host([dense]) .activity-badge { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; height: 22px; min-height: 0; margin-bottom: 3px; padding: 0 7px 0 5px; border: 0; border-radius: 11px; background: color-mix(in srgb, var(--pi-accent) 14%, transparent); color: var(--pi-accent); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
  :host([dense]) .activity-badge[aria-expanded="true"] { background: color-mix(in srgb, var(--pi-accent) 26%, transparent); }
  :host([dense]) .activity-badge .prompt-action-icon { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  :host([dense]) .composer-actions { padding-bottom: 1px; }
  :host([dense]) .icon-button { width: 26px; height: 26px; min-height: 0; }
  :host([dense]) .actions { flex-wrap: nowrap; gap: 10px; min-width: 0; margin: 0; padding: 0 4px; overflow: hidden; font-size: 11px; }
  :host([dense]) .attachments { position: relative; flex: 0 1 auto; max-width: 40%; margin: 0; align-self: center; gap: 4px; }
  :host([dense]) .attachment-chip { width: auto; height: 24px; display: inline-flex; align-items: center; border: 0; border-radius: 5px; overflow: visible; background: var(--pi-surface-hover); }
  :host([dense]) .attachment-open { min-height: 0; padding: 0; border: 0; background: none; }
  :host([dense]) .attachment-open img, :host([dense]) .attachment-open .attachment-file-preview { display: grid; place-items: center; width: 24px; height: 24px; border: 0; border-radius: 5px; object-fit: cover; font-size: 8px; }
  :host([dense]) .attachment-remove svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  :host([dense]) .attachment-remove { position: static; width: 16px; height: 22px; min-height: 0; border: 0; border-radius: 4px; background: none; color: var(--pi-muted); line-height: 1; }
  :host([dense]) .attachment-menu { position: absolute; z-index: 30; bottom: calc(100% + 8px); left: 0; padding: 6px; border-radius: 8px; background: var(--pi-surface); box-shadow: 0 6px 20px var(--pi-shadow); }
  :host([dense]) .attachment-menu select { border: 0; background: var(--pi-surface-hover); font-size: 13px; }
  :host([dense]) .attachment-error { flex-basis: auto; font-weight: 700; }
  :host([dense]) .mode-hint { bottom: 3px; border: 0; padding: 0 6px; }
  .editor-chat-navigation { position: absolute; right: 0; top: 2px; z-index: 2; box-sizing: border-box; width: 58px; border: 1px solid var(--pi-border-muted); }
  .editor-chat-navigation .chat-jumps button + button { border-inline-start: 1px solid var(--pi-border-muted); }
  :host([dense]) .editor-chat-navigation { display: none; }
  }
`;

export const promptEditorStyles = css`${promptEditorLayoutStyles}${promptEditorIntegrationStyles}`;
