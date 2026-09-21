import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PluginRegistry } from "./plugins/registry";
import { themePackPlugin } from "./plugins/themes";
import type { ThemeToken } from "./plugins/types";
import { DEFAULT_THEME_ID } from "./theme";
import { contrastRatio } from "./colorContrast";

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("is 1:1 for identical colors", () => {
    expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#101527", "#f7f4ff")).toBeCloseTo(contrastRatio("#f7f4ff", "#101527"), 10);
  });

  it("drops alpha from 8-digit hex", () => {
    expect(contrastRatio("#3d444d80", "#151b23")).toBeCloseTo(contrastRatio("#3d444d", "#151b23"), 10);
  });
});

describe("shipped theme contrast (WCAG UI boundary guard)", () => {
  const registry = new PluginRegistry();
  registry.register({ id: "themes", plugin: themePackPlugin });
  const themes = registry.getThemes();

  it("registers every expected theme", () => {
    expect(themes.map((theme) => theme.id).sort()).toEqual([
      "themes:classic",
      "themes:github-dark",
      "themes:github-light",
      "themes:pi-web-dark",
      "themes:pi-web-light",
    ]);
  });

  it.each(themes.map((theme) => [theme.id, theme] as const))("%s meets text/bg >= 4.5:1, dim/bg >= 4.5:1, border/surface >= 3:1", (_id, theme) => {
    const bg = theme.tokens["--pi-bg"];
    const surface = theme.tokens["--pi-surface"];
    const border = theme.tokens["--pi-border"];
    const text = theme.tokens["--pi-text"];
    const dim = theme.tokens["--pi-dim"];
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dim, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(border, surface)).toBeGreaterThanOrEqual(3);
  });
});

describe("inline theme fallback", () => {
  it("matches the default GitHub Dark theme and meets the contrast floors", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const declarations = /:root\s*\{([\s\S]*?)\}/u.exec(html)?.[1];
    if (declarations === undefined) throw new Error("Missing :root block in src/client/index.html");

    const registry = new PluginRegistry();
    registry.register({ id: "themes", plugin: themePackPlugin });
    const githubDark = registry.getThemes().find((theme) => theme.id === DEFAULT_THEME_ID);
    if (githubDark === undefined) throw new Error(`Missing default theme ${DEFAULT_THEME_ID}`);

    const fallbackTokens: Record<string, string> = {};
    for (const match of declarations.matchAll(/(--pi-[\w-]+):\s*([^;]+);/gu)) {
      const token = match[1];
      const value = match[2];
      if (token !== undefined && value !== undefined && Object.hasOwn(githubDark.tokens, token)) fallbackTokens[token] = value.trim();
    }
    expect(fallbackTokens).toEqual(githubDark.tokens);

    const fallback = (token: ThemeToken): string => {
      const value = fallbackTokens[token];
      if (value === undefined) throw new Error(`Missing fallback token ${token}`);
      return value;
    };
    expect(contrastRatio(fallback("--pi-text"), fallback("--pi-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fallback("--pi-dim"), fallback("--pi-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fallback("--pi-border"), fallback("--pi-surface"))).toBeGreaterThanOrEqual(3);
  });
});
