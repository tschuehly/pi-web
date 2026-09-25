import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { writeClipboardText } from "../clipboard";
import type { ToolExecutionPart } from "./shared";
import { renderBuiltinTabIcon } from "./tabIcons";

const MAX_COLLAPSED_DIFF_LINES = 180;

interface ToolTarget {
  label: "Command" | "File" | "Input";
  text: string;
}

export interface ToolRowSummary {
  argument?: string;
  result?: string;
}

export function toolActionLabel(name: string): string {
  switch (name) {
    case "bash": return "Ran bash command";
    case "subagent": return "Dispatched subagent";
    case "worker_dispatch": return "Dispatched worker";
    case "report_status": return "Reported status";
    default: return name;
  }
}

export function toolRowSummary(execution: ToolExecutionPart): ToolRowSummary {
  const argument = toolArgumentSummary(execution);
  if (execution.status === "pending" || execution.status === "running") return argument === "" ? {} : { argument };
  const output = diffFromDetails(execution.details) ?? execution.preview?.diff ?? execution.resultText ?? execution.preview?.error;
  const result = outputSummary(output);
  return {
    ...(argument === "" ? {} : { argument }),
    ...(result === undefined ? {} : { result }),
  };
}

@customElement("tool-execution-view")
export class ToolExecutionView extends LitElement {
  @property({ attribute: false }) execution: ToolExecutionPart | undefined;
  @property({ type: Boolean }) orphan = false;
  @state() private showFullDiff = false;
  @state() private copied = false;

  override render() {
    const execution = this.execution;
    if (execution === undefined) return null;

    const path = pathFromArgs(execution.args);
    const actualDiff = diffFromDetails(execution.details);
    const preview = execution.preview;
    const hasPreviewError = preview?.error !== undefined && preview.error !== "";
    const visibleDiff = actualDiff ?? preview?.diff;
    const diffStats = visibleDiff === undefined ? undefined : countDiffLines(visibleDiff);
    const previewMismatch = actualDiff !== undefined && preview?.diff !== undefined && actualDiff !== preview.diff;
    const errorText = execution.status === "error" ? execution.resultText : undefined;
    const bodyText = this.orphan && execution.status === "error" ? undefined
      : this.orphan || visibleDiff === undefined || (execution.status === "success" && hasPreviewError) ? execution.resultText : undefined;
    const target = toolTarget(execution, path);
    const row = toolRowSummary(execution);
    const diffBody = visibleDiff === undefined ? null : this.renderDiffBody(visibleDiff, actualDiff === undefined ? "Preview diff" : "Applied diff");

    return html`
      <details class=${`tool-card ${execution.status}`} ?open=${hasPreviewError || (this.orphan && visibleDiff !== undefined)}>
        <summary class="tool-row">
          <span class="chevron">${renderBuiltinTabIcon("chevron")}</span>
          <span class="status-icon" aria-hidden="true">${statusIcon(execution.status)}</span>
          <strong>${toolActionLabel(execution.toolName)}</strong>
          ${row.argument === undefined ? null : html`<span class="row-argument">${row.argument}</span>`}
          ${row.result === undefined ? null : html`<span class="row-result">· ${row.result}</span>`}
        </summary>
        <div class="tool-body">
          <div class="tool-meta">
            ${editCountLabel(execution) === undefined ? null : html`<span>${editCountLabel(execution)}</span>`}
            ${diffStats === undefined ? null : html`<span class="diff-stats"><b class="added">+${String(diffStats.added)}</b><span>/</span><b class="removed">-${String(diffStats.removed)}</b></span>`}
            <span class="status-label">${statusLabel(execution.status)}</span>
          </div>
          ${diffBody}
          ${this.renderExpandedArguments(execution.args, target, visibleDiff !== undefined)}
          ${previewMismatch ? html`<p class="notice">Applied diff differs from the preview.</p>` : null}
          ${errorText === undefined || errorText === "" ? null : html`<pre class="error-text">${errorText}</pre>`}
          ${hasPreviewError ? html`<span class="detail-label">Preview error</span><pre class="error-text">${preview.error}</pre>` : null}
          ${this.renderTextBody(bodyText)}
        </div>
      </details>
    `;
  }

  private renderExpandedArguments(args: unknown, target: ToolTarget | undefined, hasDiff: boolean) {
    const text = formattedArguments(args) ?? target?.text;
    if (text === undefined || text === "") return null;
    return hasDiff ? html`
      <details class="detail-target">
        <summary class="detail-label">Arguments</summary>
        <pre class="detail-target-value">${text}</pre>
      </details>
    ` : html`
      <div class="detail-target">
        <span class="detail-label">Arguments</span>
        <pre class="detail-target-value">${text}</pre>
      </div>
    `;
  }

  private renderTextBody(text: string | undefined) {
    if (text === undefined || text === "") return null;
    return html`
      <div class="detail-result">
        <span class="detail-label">Result</span>
        <pre>${text}</pre>
      </div>
    `;
  }

  private renderDiffBody(diff: string, label: string) {
    const lines = diff.split("\n");
    const truncated = !this.showFullDiff && lines.length > MAX_COLLAPSED_DIFF_LINES;
    const visibleLines = truncated ? lines.slice(0, MAX_COLLAPSED_DIFF_LINES) : lines;
    return html`
      <div class="diff-details">
        <div class="diff-heading">
          <span>${label}</span>
          <small>${String(lines.length)} ${lines.length === 1 ? "line" : "lines"}</small>
        </div>
        <div class="diff-toolbar">
          <span>${truncated ? `Showing ${String(visibleLines.length)} of ${String(lines.length)} lines` : "Full diff"}</span>
          <button type="button" @click=${() => { void this.copyDiff(diff); }}>${this.copied ? "Copied" : "Copy diff"}</button>
        </div>
        <pre class="diff" aria-label=${label}><code class="diff-content">${visibleLines.map((line) => html`<span class=${diffLineClass(line)}>${line}</span>`)}</code></pre>
        ${truncated ? html`
          <button class="show-more" type="button" @click=${() => { this.showFullDiff = true; }}>
            Show all ${String(lines.length)} diff lines
          </button>
        ` : null}
      </div>
    `;
  }

  private async copyDiff(diff: string): Promise<void> {
    const copied = await writeClipboardText(diff);
    if (!copied) {
      this.copied = false;
      return;
    }
    this.copied = true;
    window.setTimeout(() => { this.copied = false; }, 1200);
  }

  static override styles = css`
    :host { display: block; width: 100%; max-width: 100%; min-width: 0; color: var(--pi-text); }
    .tool-card { display: block; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow: hidden; color: var(--pi-text); }
    .tool-card.running .status-icon, .tool-card.pending .status-icon { color: var(--pi-warning); }
    .tool-card.success .status-icon { color: var(--pi-success); }
    .tool-card.error .status-icon, .tool-card.error .status-label { color: var(--pi-danger); }
    .tool-row { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 5px 0; overflow: hidden; list-style: none; cursor: pointer; }
    .tool-row::-webkit-details-marker { display: none; }
    .chevron { flex: 0 0 auto; display: inline-grid; color: var(--pi-muted); transition: transform .12s ease; }
    .chevron .tab-icon { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .tool-card[open] > .tool-row .chevron { transform: rotate(90deg); }
    .status-icon, strong { flex: 0 0 auto; }
    strong { color: var(--pi-text); }
    .row-argument { min-width: 0; overflow: hidden; color: var(--pi-accent); font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .row-result { min-width: 0; overflow: hidden; color: var(--pi-muted); text-overflow: ellipsis; white-space: nowrap; }
    .tool-body { min-width: 0; display: grid; gap: 8px; padding: 2px 0 8px 21px; overflow-wrap: anywhere; }
    .tool-meta { display: inline-flex; align-items: baseline; gap: 8px; color: var(--pi-muted); font-size: 12px; }
    .diff-stats { display: inline-flex; gap: 3px; }
    .added, .diff .added { color: var(--pi-success); }
    .removed, .diff .removed { color: var(--pi-danger); }
    .status-label { text-transform: uppercase; letter-spacing: .04em; color: var(--pi-muted); }
    .notice { margin: 0; color: var(--pi-warning); }
    .muted { margin: 0; color: var(--pi-muted); }
    .error-text { box-sizing: border-box; max-width: 100%; margin: 0; overflow-x: auto; background: color-mix(in srgb, var(--pi-danger) 7%, transparent); color: var(--pi-danger); padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .detail-target, .detail-result { display: grid; gap: 4px; min-width: 0; }
    .detail-label { color: var(--pi-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    details.detail-target { display: block; }
    details.detail-target > summary { cursor: pointer; }
    .detail-result pre { box-sizing: border-box; max-width: 100%; margin: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; padding: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; direction: ltr; text-align: left; unicode-bidi: isolate; }
    .detail-target-value { box-sizing: border-box; max-width: 100%; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--pi-accent); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; direction: ltr; text-align: left; unicode-bidi: isolate; }
    .diff-details { min-width: 0; max-width: 100%; padding-top: 2px; }
    .diff-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; color: var(--pi-muted); }
    .diff-heading span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .diff-heading small { flex: 0 0 auto; color: var(--pi-dim); }
    .diff-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; margin-top: 8px; color: var(--pi-muted); font-size: 12px; }
    .diff-toolbar span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 3px 7px; font: 12px system-ui, sans-serif; cursor: pointer; }
    button:hover, button:focus { border-color: var(--pi-accent); }
    .diff { box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; margin: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); padding: 8px 0; color: var(--pi-muted); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
    .diff-content { display: block; width: max-content; min-width: 100%; }
    .diff span { display: block; min-height: 1.45em; padding: 0 8px; white-space: pre; }
    .diff .context { color: var(--pi-muted); }
    .diff .hunk { color: var(--pi-accent); }
    .diff .file { color: var(--pi-dim); }
    .diff .meta { color: var(--pi-dim); }
    .diff .added { background: color-mix(in srgb, var(--pi-success) 12%, transparent); }
    .diff .removed { background: color-mix(in srgb, var(--pi-danger) 12%, transparent); }
    .show-more { justify-self: start; }
  `;
}

function toolTarget(execution: ToolExecutionPart, path: string | undefined): ToolTarget | undefined {
  if (path !== undefined && path !== "") return { label: "File", text: path };
  const command = getString(execution.args, "command");
  if (command !== undefined && command !== "") return { label: "Command", text: command };
  if (execution.summary !== "") return { label: "Input", text: execution.summary };
  return undefined;
}

function pathFromArgs(args: unknown): string | undefined {
  return getString(args, "path") ?? getString(args, "file_path");
}

function toolArgumentSummary(execution: ToolExecutionPart): string {
  const path = pathFromArgs(execution.args);
  if ((execution.toolName === "read" || execution.toolName === "edit" || execution.toolName === "write") && path !== undefined) {
    return path.replace(/\\/g, "/").split("/").filter((segment) => segment !== "").slice(-2).join("/");
  }
  const command = getString(execution.args, "command");
  if (execution.toolName === "bash" && command !== undefined) return truncate(command.replace(/\s+/g, " ").trim(), 70);
  return truncate(execution.summary.replace(/\s+/g, " ").trim(), 70);
}

function outputSummary(output: string | undefined): string | undefined {
  const text = output?.trim();
  if (text === undefined || text === "") return undefined;
  const lines = text.split("\n");
  return lines.length > 1 ? `${String(lines.length)} lines` : truncate(lines[0] ?? "", 60);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formattedArguments(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, undefined, 2);
  } catch {
    return undefined;
  }
}

function editCountLabel(execution: ToolExecutionPart): string | undefined {
  if (execution.toolName !== "edit") return undefined;
  const edits = getProperty(execution.args, "edits");
  if (Array.isArray(edits)) return `${String(edits.length)} edit${edits.length === 1 ? "" : "s"}`;
  if (typeof getProperty(execution.args, "oldText") === "string" && typeof getProperty(execution.args, "newText") === "string") return "1 edit";
  return undefined;
}

function diffFromDetails(details: unknown): string | undefined {
  return getString(details, "diff");
}

function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (isAddedDiffLine(line)) added++;
    else if (isRemovedDiffLine(line)) removed++;
  }
  return { added, removed };
}

function diffLineClass(line: string): string {
  if (isAddedDiffLine(line)) return "added";
  if (isRemovedDiffLine(line)) return "removed";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "file";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "context";
}

function isAddedDiffLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

function isRemovedDiffLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

function statusIcon(status: ToolExecutionPart["status"]): string {
  if (status === "success") return "✓";
  if (status === "error") return "✖";
  if (status === "running") return "●";
  return "○";
}

function statusLabel(status: ToolExecutionPart["status"]): string {
  if (status === "success") return "done";
  if (status === "error") return "failed";
  if (status === "running") return "running";
  return "pending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}
