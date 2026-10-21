import { describe, expect, it } from "vitest";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { WORKSTREAM_PALETTE, WORKSTREAM_TINT_PERCENTAGES } from "../workstreamColor";
import { WorkstreamChooser } from "./WorkstreamChooser";
import { WorkbenchWindowTabs } from "./WorkbenchWindowTabs";

type Rgb = [number, number, number];

describe("Workstream identity presentation contracts", () => {
  it("keeps identity-surface text and shape boundaries above WCAG contrast floors for every palette colour and theme", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "themes", plugin: themePackPlugin });
    const themes = registry.getThemes();
    expect(themes).toHaveLength(5);

    for (const theme of themes) {
      const foreground = hexRgb(theme.tokens["--pi-text"]);
      const surfaces = [
        ["tab", "--pi-surface", WORKSTREAM_TINT_PERCENTAGES.tab],
        ["hovered tab", "--pi-surface-hover", WORKSTREAM_TINT_PERCENTAGES.tab],
        ["selected tab", "--pi-surface-hover", WORKSTREAM_TINT_PERCENTAGES.tabSelected],
        ["identity mark", "--pi-surface", WORKSTREAM_TINT_PERCENTAGES.mark],
      ] as const;
      for (const [light, dark] of WORKSTREAM_PALETTE) {
        const identity = hexRgb(theme.colorScheme === "light" ? light : dark);
        for (const [name, token, percent] of surfaces) {
          const background = mix(identity, hexRgb(theme.tokens[token]), percent / 100);
          expect(contrast(foreground, background), `${theme.id} ${name} ${light}/${dark} text`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("tints Workstream tabs with --pi-text on the contrast-checked tab surfaces", () => {
    const tabs = styleText(WorkbenchWindowTabs.styles);
    const resting = rule(tabs, ".tinted");
    // The tab row paints --pi-surface, so these are exactly the tab surfaces the palette sweep above holds at AA.
    expect(resting).toContain(`background: color-mix(in srgb, var(--ws) ${String(WORKSTREAM_TINT_PERCENTAGES.tab)}%, var(--pi-surface))`);
    expect(resting).toContain("color: var(--pi-text)");
    expect(rule(tabs, ".tinted:hover")).toContain(`background: color-mix(in srgb, var(--ws) ${String(WORKSTREAM_TINT_PERCENTAGES.tab)}%, var(--pi-surface-hover))`);
    expect(rule(tabs, '.tinted[aria-selected="true"]')).toContain(`background: color-mix(in srgb, var(--ws) ${String(WORKSTREAM_TINT_PERCENTAGES.tabSelected)}%, var(--pi-surface-hover))`);
  });

  it("declares --pi-text foreground on every recolored label", () => {
    const chooser = styleText(WorkstreamChooser.styles);

    // Recolored label text must declare --pi-text foreground for consistent visibility
    const labels: [string, string][] = [
      [".age", chooser],
      [".next", chooser],
      ["h4", chooser],
      [".done", chooser],
      [".kind", chooser],
      [".session-meta", chooser],
      ["summary", chooser],
      [".date", chooser],
      [".workstream .missing", chooser],
    ];

    for (const [selector, source] of labels) {
      const ruleText = rule(source, selector);
      expect(ruleText, `${selector} must declare --pi-text foreground`).toContain("var(--pi-text)");
    }
  });

  it("preserves the chooser's forced-color and status-indicator contrast", () => {
    const chooser = styleText(WorkstreamChooser.styles);

    expect(rule(chooser, ".workstream")).toContain("border-left: 3px solid var(--workstream-color");
    expect(chooser).toContain(".identity-mark { border-color: ButtonText; background: Canvas; color: CanvasText; }");
    // Status indicator must declare --pi-text outline for visibility across all surfaces
    expect(chooser).toContain(".row .activity-indicator, .session-row .activity-indicator { box-shadow: 0 0 0 1px var(--pi-text);");
  });
});

function hexRgb(value: string): Rgb {
  const hex = value.slice(1, 7);
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

function mix(foreground: Rgb, background: Rgb, amount: number): Rgb {
  return [
    foreground[0] * amount + background[0] * (1 - amount),
    foreground[1] * amount + background[1] * (1 - amount),
    foreground[2] * amount + background[2] * (1 - amount),
  ];
}

function contrast(a: Rgb, b: Rgb): number {
  const luminance = ([r, g, blue]: Rgb): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(blue);
  const [first, second] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return ((first ?? 0) + 0.05) / ((second ?? 0) + 0.05);
}

function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function rule(styles: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(styles)?.[1] ?? "";
}

function styleText(styles: unknown): string {
  if (Array.isArray(styles)) return styles.map(styleText).join("\n");
  if (typeof styles === "object" && styles !== null && "cssText" in styles && typeof styles.cssText === "string") return styles.cssText;
  return "";
}
