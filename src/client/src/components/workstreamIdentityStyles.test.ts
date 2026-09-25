import { describe, expect, it } from "vitest";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { WORKSTREAM_TINT_PERCENTAGES } from "../workstreamColor";
import { WorkstreamChooser } from "./WorkstreamChooser";
import { WorkstreamContextDrawer } from "./WorkstreamContextDrawer";

type Rgb = [number, number, number];

describe("Workstream identity presentation contracts", () => {
  it("keeps identity-surface text and shape boundaries above WCAG contrast floors for every hue and theme", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "themes", plugin: themePackPlugin });
    const themes = registry.getThemes();
    expect(themes).toHaveLength(5);

    for (const theme of themes) {
      const foreground = hexRgb(theme.tokens["--pi-text"]);
      const surfaces = [
        ["row", "--pi-bg", WORKSTREAM_TINT_PERCENTAGES.row],
        ["row hover", "--pi-surface-hover", WORKSTREAM_TINT_PERCENTAGES.rowHover],
        ["selected row", "--pi-surface", WORKSTREAM_TINT_PERCENTAGES.rowSelected],
        ["selected row hover", "--pi-surface-hover", WORKSTREAM_TINT_PERCENTAGES.rowSelectedHover],
        ["card", "--pi-surface", WORKSTREAM_TINT_PERCENTAGES.card],
        ["drawer", "--pi-surface", WORKSTREAM_TINT_PERCENTAGES.drawer],
        ["drawer active", "--pi-surface-hover", WORKSTREAM_TINT_PERCENTAGES.drawerActive],
        ["identity mark", "--pi-surface", WORKSTREAM_TINT_PERCENTAGES.mark],
      ] as const;
      for (let hue = 0; hue < 360; hue += 1) {
        const identity = hslRgb(hue, theme.colorScheme === "light" ? 70 : 65, theme.colorScheme === "light" ? 40 : 65);
        for (const [name, token, percent] of surfaces) {
          const background = mix(identity, hexRgb(theme.tokens[token]), percent / 100);
          expect(contrast(foreground, background), `${theme.id} ${name} hue ${String(hue)} text`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("declares --pi-text foreground on every recolored label", () => {
    const chooser = styleText(WorkstreamChooser.styles);
    const drawer = styleText(WorkstreamContextDrawer.styles);

    // Recolored label text must declare --pi-text foreground for consistent visibility
    const labels: [string, string][] = [
      [".row small", chooser],
      [".goal small", chooser],
      [".next", chooser],
      [".next small", chooser],
      [".kicker", chooser],
      [".who", chooser],
      [".peek", chooser],
      [".session-meta", chooser],
      [".task small", chooser],
      [".about p", drawer],
    ];

    for (const [selector, source] of labels) {
      const ruleText = rule(source, selector);
      expect(ruleText, `${selector} must declare --pi-text foreground`).toContain("var(--pi-text)");
    }

    // .task p inherits --pi-text via combined selector with .task small
    expect(chooser).toContain(".task p, .task small { color: var(--pi-text);");
  });

  it("preserves selected-hover, forced-color, narrow-title, focus, zoom, and status-indicator contrast", () => {
    const chooser = styleText(WorkstreamChooser.styles);
    const drawer = styleText(WorkstreamContextDrawer.styles);

    expect(rule(chooser, '.row[aria-pressed="true"]:hover')).toContain(`${String(WORKSTREAM_TINT_PERCENTAGES.rowSelectedHover)}%`);
    expect(chooser).toContain(".identity-mark { border-color: ButtonText; background: Canvas; color: CanvasText; }");
    expect(rule(drawer, "summary")).toContain("border-left: 4px solid var(--workstream-color)");
    expect(drawer).toContain("summary { border-color: ButtonText; border-left-color: LinkText; background: Canvas; }");
    expect(drawer).toMatch(/@media \(max-width: 520px\)[^{]*\{[^}]*\.sheet\s*\{\s*padding:\s*12px 16px/u);
    expect(rule(drawer, "summary:focus-visible")).toContain("outline: 2px solid var(--pi-accent)");
    expect(rule(drawer, ".sheet")).toContain("max-height: calc(var(--pi-workbench-viewport-height, 100vh) - 56px)");
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

function hslRgb(hue: number, saturation: number, lightness: number): Rgb {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const [r, g, b]: Rgb = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const m = l - chroma / 2;
  return [r + m, g + m, b + m];
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
