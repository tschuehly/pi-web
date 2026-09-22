// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { WorkstreamChooser } from "./WorkstreamChooser";
import { WorkstreamContextDrawer } from "./WorkstreamContextDrawer";

describe("Workstream identity presentation contracts", () => {
  it("tints chooser rows and cards while retaining structural selection cues", () => {
    const styles = styleText(WorkstreamChooser.styles);
    expect(rule(styles, ".row")).toContain("background: color-mix(in srgb, var(--workstream-color) 12%, var(--pi-bg))");
    expect(rule(styles, ".row:hover")).toContain("background: color-mix(in srgb, var(--workstream-color) 18%, var(--pi-surface-hover))");
    const selected = rule(styles, '.row[aria-pressed="true"]');
    expect(selected).toContain("background: color-mix(in srgb, var(--workstream-color) 22%, var(--pi-surface))");
    expect(selected).toContain("border-color: var(--pi-accent)");
    expect(selected).toContain("border-left-color: var(--workstream-color, var(--pi-accent))");
    expect(rule(styles, ".card")).toContain("background: color-mix(in srgb, var(--workstream-color) 9%, var(--pi-surface))");
  });

  it("keeps chooser identity and selection visible in forced colors", () => {
    const styles = styleText(WorkstreamChooser.styles);
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain(".row { border-left-color: LinkText; }");
    expect(styles).toContain('.row[aria-pressed="true"] { border-color: Highlight; border-left-color: LinkText; }');
    expect(styles).toContain(".card { border-left-color: LinkText; }");
  });

  it("renders the drawer summary as an identity chip with open and focus cues", () => {
    const styles = styleText(WorkstreamContextDrawer.styles);
    const summary = rule(styles, "summary");
    expect(summary).toContain("border: 1px solid var(--pi-border)");
    expect(summary).toContain("border-radius: 8px");
    expect(summary).toContain("background: color-mix(in srgb, var(--workstream-color) 12%, var(--pi-surface))");
    expect(rule(styles, "summary:hover")).toContain("background: color-mix(in srgb, var(--workstream-color) 18%, var(--pi-surface-hover))");
    expect(rule(styles, "details[open] summary")).toContain("background: color-mix(in srgb, var(--workstream-color) 18%, var(--pi-surface-hover))");
    expect(rule(styles, "summary:focus-visible")).toContain("outline: 2px solid var(--pi-accent)");
    expect(rule(styles, "details")).toContain("border-left: 3px solid var(--workstream-color, transparent)");
  });

  it("retains forced-color and zoom-compensated drawer behavior", () => {
    const styles = styleText(WorkstreamContextDrawer.styles);
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("details { border-left-color: LinkText; }");
    expect(styles).toContain("details[open] summary { border-color: Highlight; }");
    expect(rule(styles, ".sheet")).toContain("max-height: calc(var(--pi-workbench-viewport-height, 100vh) - 56px)");
  });
});

function rule(styles: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(styles)?.[1] ?? "";
}

function styleText(styles: unknown): string {
  if (Array.isArray(styles)) return styles.map(styleText).join("\n");
  if (typeof styles === "object" && styles !== null && "cssText" in styles && typeof styles.cssText === "string") return styles.cssText;
  return "";
}
