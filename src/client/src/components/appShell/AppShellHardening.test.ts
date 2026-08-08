import { describe, expect, it } from "vitest";
import { appStyles } from "../shared";
import { AppContextBar } from "./AppContextBar";
import { AppMobileMainTabs } from "./AppMobileMainTabs";
import { AppPanelEdgeControl } from "./AppPanelEdgeControl";

describe("generic app shell interaction hardening", () => {
  it("reserves coarse-pointer panel-edge hit areas instead of overlaying adjacent controls", () => {
    const edgeCss = AppPanelEdgeControl.styles.cssText;
    const shellCss = appStyles.cssText;

    expect(edgeCss).toMatch(/@media \(pointer: coarse\)[\s\S]*\.edge-button \{[^}]*width: max\(44px, var\(--pi-control-min-size\)\);[^}]*min-height: max\(44px, var\(--pi-control-min-size\)\)/);
    expect(edgeCss).toMatch(/@media \(pointer: coarse\)[\s\S]*\.resize-handle \{ inset: 0; \}/);
    expect(shellCss).toContain("--panel-edge-control-width: 1px");
    expect(shellCss).toContain("grid-template-columns: var(--navigation-panel-width) var(--panel-edge-control-width) minmax(320px, 1fr) var(--panel-edge-control-width) var(--workspace-panel-width)");
    expect(shellCss).toMatch(/@media \(pointer: coarse\)[\s\S]*--panel-edge-control-width: max\(44px, var\(--pi-control-min-size, 44px\)\)/);
  });

  it("removes app-shell transitions when reduced motion is requested", () => {
    expect(AppPanelEdgeControl.styles.cssText).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.resize-handle::after \{ transition: none; \}/);
    expect(AppContextBar.styles.cssText).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.context-bar::before, \.context-bar::after \{ transition: none; \}/);
    expect(AppMobileMainTabs.styles.cssText).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mobile-tabs-frame::before, \.mobile-tabs-frame::after \{ transition: none; \}/);
  });
});
