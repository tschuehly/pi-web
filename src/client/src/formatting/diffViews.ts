import { css } from "lit";
import { diffArrays, diffLines, diffWordsWithSpace, type Change } from "diff";

/** A line of a unified diff, coloured like the edit tool's diff. */
export function diffLineClass(line: string): string {
  if (isAddedDiffLine(line)) return "added";
  if (isRemovedDiffLine(line)) return "removed";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "context";
}

export function isAddedDiffLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

export function isRemovedDiffLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

/** Line colours shared by the edit tool's diff and ```diff fences. */
export const diffLineStyles = css`
  .diff span { display: block; min-height: 1.45em; padding: 0 8px; white-space: pre; }
  .diff .context { color: var(--pi-muted); }
  .diff .hunk { color: var(--pi-accent); }
  .diff .file { color: var(--pi-dim); }
  .diff .meta { color: var(--pi-dim); }
  .diff .added { color: color-mix(in srgb, var(--pi-success) 65%, var(--pi-text) 35%); background: color-mix(in srgb, var(--pi-success) 12%, transparent); }
  .diff .removed { color: color-mix(in srgb, var(--pi-danger) 65%, var(--pi-text) 35%); background: color-mix(in srgb, var(--pi-danger) 12%, transparent); }
`;

// A changed line counts as rewritten when more than this share of its words changed; mostly rewritten lines show side by side.
const REWRITTEN_LINE_SHARE = 0.5;

/** ```worddiff source: old text, a line holding only `>>>`, new text; undefined when malformed. */
export function parseWordDiff(source: string): { before: string; after: string } | undefined {
  const lines = source.replace(/\n$/u, "").split("\n");
  const separator = lines.findIndex((line) => line.trim() === ">>>");
  if (separator < 0) return undefined;
  return { before: lines.slice(0, separator).join("\n"), after: lines.slice(separator + 1).join("\n") };
}

const words = (line: string): string[] => line.split(/\s+/u).filter((word) => word !== "");

/** Inline for word edits; side by side when the text spans several lines and most changed lines are rewritten. */
export function wordDiffLayout(before: string, after: string): "inline" | "split" {
  if (!before.includes("\n") && !after.includes("\n")) return "inline";
  let changed = 0;
  let rewritten = 0;
  const changes = diffLines(before, after);
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (change === undefined || (!change.added && !change.removed)) continue;
    const next = changes[index + 1];
    const removed = change.removed ? lineList(change.value) : [];
    const added = change.removed && next?.added === true ? lineList(next.value) : change.added ? lineList(change.value) : [];
    if (change.removed && next?.added === true) index += 1;
    for (let line = 0; line < Math.max(removed.length, added.length); line += 1) {
      const old = words(removed[line] ?? "");
      const fresh = words(added[line] ?? "");
      const kept = diffArrays(old, fresh).filter((part) => !part.added && !part.removed).reduce((sum, part) => sum + part.count, 0);
      changed += 1;
      if (1 - kept / Math.max(old.length, fresh.length, 1) > REWRITTEN_LINE_SHARE) rewritten += 1;
    }
  }
  return rewritten * 2 > changed ? "split" : "inline";
}

function lineList(value: string): string[] {
  return value.replace(/\n$/u, "").split("\n");
}

/** The word-diff view for a parsed ```worddiff fence, built from text nodes only. */
export function renderWordDiff(before: string, after: string): HTMLElement {
  const changes = diffWordsWithSpace(before, after);
  const layout = wordDiffLayout(before, after);
  const view = document.createElement("div");
  view.className = `worddiff ${layout}`;
  if (layout === "inline") {
    view.append(side(changes, "both"));
    return view;
  }
  const columns = document.createElement("div");
  columns.className = "worddiff-columns";
  columns.append(side(changes, "old"), side(changes, "new"));
  view.append(columns);
  return view;
}

function side(changes: Change[], show: "old" | "new" | "both"): HTMLElement {
  const text = document.createElement("div");
  text.className = `worddiff-text${show === "both" ? "" : ` worddiff-${show}`}`;
  if (show !== "both") text.setAttribute("aria-label", show === "old" ? "Before" : "After");
  for (const change of changes) {
    if ((change.added && show === "old") || (change.removed && show === "new")) continue;
    const part = document.createElement(change.added ? "ins" : change.removed ? "del" : "span");
    part.textContent = change.value;
    text.append(part);
  }
  return text;
}

/** Colours ```diff fences and replaces well-formed ```worddiff fences; malformed ones stay code blocks. */
export function enhanceDiffBlocks(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("pre > code.language-diff:not([data-diff-view]), pre > code.language-worddiff:not([data-diff-view])").forEach((code) => {
    code.setAttribute("data-diff-view", "");
    const source = code.textContent;
    if (code.classList.contains("language-diff")) {
      code.parentElement?.classList.add("diff");
      code.replaceChildren(...source.replace(/\n$/u, "").split("\n").map((line) => {
        const span = document.createElement("span");
        span.className = diffLineClass(line);
        // The newline keeps Copy and selection line-based; a block's trailing newline adds no line.
        span.textContent = `${line}\n`;
        return span;
      }));
      return;
    }
    const parsed = parseWordDiff(source);
    if (parsed === undefined) return;
    // Copy reads a source block; the word diff has none.
    code.closest(".code-block-wrapper")?.querySelector(".code-copy-button")?.remove();
    code.parentElement?.replaceWith(renderWordDiff(parsed.before, parsed.after));
  });
}

export const wordDiffStyles = css`
  .worddiff { container-type: inline-size; margin: 0; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .worddiff ins { color: color-mix(in srgb, var(--pi-success) 65%, var(--pi-text) 35%); background: color-mix(in srgb, var(--pi-success) 16%, transparent); text-decoration: none; }
  .worddiff del { color: color-mix(in srgb, var(--pi-danger) 65%, var(--pi-text) 35%); background: color-mix(in srgb, var(--pi-danger) 16%, transparent); text-decoration: line-through; }
  .worddiff-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .worddiff-old { border-inline-end: 1px solid var(--pi-border); padding-inline-end: 12px; }
  @container (max-width: 580px) {
    .worddiff-columns { grid-template-columns: 1fr; gap: 8px; }
    .worddiff-old { border-inline-end: 0; border-block-end: 1px solid var(--pi-border); padding: 0 0 8px; }
  }
`;
