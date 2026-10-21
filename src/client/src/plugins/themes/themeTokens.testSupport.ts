import { readFileSync } from "node:fs";

/** A bundled CSS theme's literal `:root` palette tokens, read from its stylesheet file. */
export function bundledThemeTokens(themeId: string): Record<string, string> {
  const localId = themeId.replace(/^themes:/u, "");
  const css = readFileSync(new URL(`./${localId}.css`, import.meta.url), "utf8");
  const root = /:root\s*\{([\s\S]*?)\}/u.exec(css)?.[1] ?? "";
  return Object.fromEntries(Array.from(root.matchAll(/(--pi-[\w-]+):\s*([^;]+);/gu), (match) => [match[1] ?? "", (match[2] ?? "").trim()]));
}

export function bundledThemeToken(themeId: string, token: string): string {
  const value = bundledThemeTokens(themeId)[token];
  if (value === undefined) throw new Error(`Theme ${themeId} has no ${token}`);
  return value;
}

/** The bundled theme pack's themes, read from its source (registration needs an HTTP stylesheet origin). */
export function bundledThemes(): { id: string; colorScheme: "light" | "dark" }[] {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  return Array.from(source.matchAll(/id: "([\w-]+)",\s*name:[\s\S]*?colorScheme: "(light|dark)"/gu), (match) => ({ id: `themes:${match[1] ?? ""}`, colorScheme: match[2] === "light" ? "light" : "dark" }));
}
