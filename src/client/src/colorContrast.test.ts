import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PluginRegistry } from "./plugins/registry";
import { themePackPlugin } from "./plugins/themes";
import type { ThemeToken } from "./plugins/types";
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
  it("registers every expected theme with readable text and boundaries", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "themes", plugin: themePackPlugin });
    const themes = registry.getThemes();
    expect(themes.map((theme) => theme.id).sort()).toEqual([
      "themes:classic",
      "themes:github-dark",
      "themes:github-light",
      "themes:pi-web-dark",
      "themes:pi-web-light",
    ]);
    for (const theme of themes) {
      expect(contrastRatio(theme.tokens["--pi-text"], theme.tokens["--pi-bg"]), theme.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.tokens["--pi-dim"], theme.tokens["--pi-bg"]), theme.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.tokens["--pi-border"], theme.tokens["--pi-surface"]), theme.id).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("inline theme fallback", () => {
  it("matches the default GitHub Dark theme and meets the contrast floors", async () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const declarations = /:root\s*\{([\s\S]*?)\}/u.exec(html)?.[1];
    if (declarations === undefined) throw new Error("Missing :root block in src/client/index.html");

    const registry = new PluginRegistry();
    await registry.register({ id: "themes", plugin: themePackPlugin });
    const githubDark = registry.getThemes().find((theme) => theme.id === "themes:github-dark");
    if (githubDark === undefined) throw new Error("Missing Workbench default theme themes:github-dark");

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
