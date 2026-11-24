import { marked, type Renderer, type TokenizerExtension } from "marked";
import { DEFAULT_CODE_BLOCK_POLICY, type CodeBlockPolicy } from "./codeBlockPolicy";
import { replaceLocalMarkdownImages } from "./markdownImages";
import { workspaceFilePreviewUrl } from "../api/urls";
import { resolveAppUrl } from "../appUrl";
import { adHocFolderWorkspaceId } from "../../../shared/workspaceFiles";
import { isOwnerRunInfo, ownerRunProposal, ownerRunProposals, sameOwnerRun, type OwnerRunProposal } from "../../../shared/ownerRun";
import { fileLinkLines, inlineCodeFileHref, outsideChatFilePath, workspaceMarkdownFilePath, type MarkdownWorkspaceContext } from "./workspaceLinks";

const nativeCodeRenderer = new marked.Renderer();

function markdownRenderer(codeBlocks: CodeBlockPolicy, runnable?: readonly OwnerRunProposal[]): Renderer {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.blockquote = function ({ text, tokens }) {
    // Marked's text removes only the outer quote markers, retaining Markdown syntax and blank lines.
    return `<blockquote data-quote-source="${escapeHtml(text).replaceAll('"', "&quot;")}">\n${this.parser.parse(tokens)}</blockquote>\n`;
  };
  renderer.code = (token) => {
    if (runnable !== undefined && isOwnerRunInfo(token.lang)) return ownerRunBlock(token.lang ?? "", token.text, runnable);
    const block = codeBlocks.presentation === "code"
      ? nativeCodeRenderer.code(token)
      : `<div class="plain-code-block">${escapeHtml(token.text)}\n</div>\n`;
    // The literal, copy-free baseline has no frame or controls.
    if (codeBlocks.presentation === "plain" && !codeBlocks.copy) return block;
    const language = token.lang?.trim().split(/\s/u)[0] ?? "";
    const label = language === "" ? "" : `<span class="code-block-label">${escapeHtml(language)}</span>`;
    const copy = codeBlocks.copy
      ? '<button type="button" class="code-copy-button code-block-copy ui-button ui-button--icon ui-button--compact" title="Copy code block" aria-label="Copy code block"><span aria-hidden="true">⧉</span></button>'
      : "";
    // Generate the normal-flow header before mounting; never reparent source DOM.
    const header = label === "" && copy === "" ? "" : `<div class="code-block-header" role="group" aria-label="Code block controls">${label}${copy}</div>`;
    return `<div class="code-block-wrapper code-block-frame">${header}${block}</div>\n`;
  };
  return renderer;
}

/**
 * A pi-run block of a committed assistant message: always framed, with a Review button when the message's own top-level
 * parse (the one the server repeats) has the same proposal, else the reason it cannot run.
 */
function ownerRunBlock(info: string, text: string, runnable: readonly OwnerRunProposal[]): string {
  const proposal = ownerRunProposal(info, text);
  const control = "error" in proposal
    ? `<span class="owner-run-invalid">Not runnable: ${escapeHtml(proposal.error)}</span>`
    : runnable.some((candidate) => sameOwnerRun(candidate, proposal))
      ? `<button type="button" class="owner-run-button ui-button ui-button--compact" data-owner-run="${escapeHtml(JSON.stringify(proposal)).replaceAll('"', "&quot;")}">${proposal.mode === "terminal" ? "Review for Terminal…" : "Review command…"}</button>`
      : '<span class="owner-run-invalid">Not runnable: only a closed top-level block runs</span>';
  const label = `<span class="code-block-label">${"mode" in proposal && proposal.mode === "terminal" ? "pi-run terminal" : "pi-run"}</span>`;
  return `<div class="code-block-wrapper code-block-frame owner-run-block"><div class="code-block-header" role="group" aria-label="Proposed command">${label}${control}</div><pre><code>${escapeHtml(text)}\n</code></pre></div>\n`;
}

/**
 * `[label](/abs/path with spaces.mov)`: CommonMark needs `<…>` around a destination
 * containing spaces, but agents write absolute local paths bare. Parsed inline, so
 * code spans and blocks keep their text.
 */
const spacedLocalPathLink: TokenizerExtension = {
  name: "spacedLocalPathLink",
  level: "inline",
  start: (src) => {
    const index = src.indexOf("[");
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const match = /^\[([^[\]\n]+)\]\((\/[^()<>\n]* [^()<>\n]*)\)/u.exec(src);
    if (match === null) return undefined;
    const [raw, text = "", href = ""] = match;
    return { type: "link", raw, href: href.trim(), title: null, text, tokens: this.lexer.inlineTokens(text) };
  },
};
// The module owns Chat Markdown; registering on the shared parser keeps one parse path.
marked.use({ extensions: [spacedLocalPathLink] });

const MAX_MARKDOWN_CACHE_ENTRIES = 300;
const markdownHtmlCache = new Map<string, string>();

/** `ownerRuns`: pi-run blocks get a run button (committed assistant text only). */
export function toSafeMarkdownHtml(text: string, workspace?: MarkdownWorkspaceContext, imageIntentKey?: string, imagesEnabled = true, codeBlocks: CodeBlockPolicy = DEFAULT_CODE_BLOCK_POLICY, ownerRuns = false): string {
  // Overflow is applied at the component boundary; preview policy does not alter HTML.
  // Only workspace links depend on the effective application base, not route/query changes.
  const key = JSON.stringify([text, imagesEnabled, codeBlocks.presentation, codeBlocks.copy, ownerRuns, workspace === undefined ? null : [
    workspace.machineId, workspace.projectId, workspace.workspaceId, workspace.root, workspace.sourcePath, resolveAppUrl(""), imageIntentKey,
  ]]);
  const cached = markdownHtmlCache.get(key);
  if (cached !== undefined) return cached;
  const html = marked.parse(text, { async: false, breaks: true, gfm: true, renderer: markdownRenderer(codeBlocks, ownerRuns ? ownerRunProposals(text) : undefined) });
  const safeHtml = sanitizeHtml(html, workspace, imageIntentKey, imagesEnabled);
  markdownHtmlCache.set(key, safeHtml);
  if (markdownHtmlCache.size > MAX_MARKDOWN_CACHE_ENTRIES) {
    const oldest = markdownHtmlCache.keys().next().value;
    if (oldest !== undefined) markdownHtmlCache.delete(oldest);
  }
  return safeHtml;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const TABLE_SCROLL_CLASS = "table-scroll";

function sanitizeHtml(html: string, workspace: MarkdownWorkspaceContext | undefined, imageIntentKey: string | undefined, imagesEnabled: boolean): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  if (workspace !== undefined) replaceLocalMarkdownImages(template.content, workspace, imageIntentKey);
  template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => { node.remove(); });
  if (workspace !== undefined) linkInlineCodeFilePaths(template.content, workspace);
  template.content.querySelectorAll("*").forEach((element) => {
    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    if (href !== null && workspace !== undefined) {
      const path = workspaceMarkdownFilePath(href, workspace);
      const outside = path === undefined ? outsideChatFilePath(href, workspace) : undefined;
      const lines = path === undefined && outside === undefined ? undefined : fileLinkLines(href);
      if (lines !== undefined) element.setAttribute("data-lines", `${String(lines.start)}-${String(lines.end)}`);
      if (path !== undefined) {
        element.setAttribute("href", workspaceFilePreviewUrl(workspace.projectId, workspace.workspaceId, path, { machineId: workspace.machineId, download: true }));
        element.setAttribute("data-workspace-file", path);
      } else if (outside !== undefined) {
        // Opened through the file's own folder; the Workbench may pick a registered workspace instead.
        const slash = outside.lastIndexOf("/");
        element.setAttribute("href", workspaceFilePreviewUrl("", adHocFolderWorkspaceId(outside.slice(0, slash) || "/"), outside.slice(slash + 1), { machineId: workspace.machineId, download: true }));
        element.setAttribute("data-outside-file", outside);
      } else if (workspace.sourcePath !== undefined && !/^(?:[#?]|\/\/|[a-z][a-z\d+.-]*:)/i.test(href.trim())) {
        element.removeAttribute("href");
      }
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if ((name === "href" || name === "src") && !isSafeUrl(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.tagName === "A") {
      element.setAttribute("target", element.hasAttribute("data-workspace-file") || element.hasAttribute("data-outside-file") ? "_self" : "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    }
  });
  // Sources are assigned up front; native loading owns visibility and decoding.
  template.content.querySelectorAll("img").forEach((image) => {
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    if (!imagesEnabled) image.removeAttribute("src");
  });
  if (!imagesEnabled) template.content.querySelectorAll("pi-web-markdown-image").forEach((image) => {
    image.setAttribute("loading-disabled", "");
  });
  wrapTablesInScrollRegions(template.content);
  return template.innerHTML;
}

/** Inline code naming one file becomes the link `[`path`](path)` would be; the loop in sanitizeHtml then rewrites it. */
function linkInlineCodeFilePaths(root: DocumentFragment, workspace: MarkdownWorkspaceContext): void {
  root.querySelectorAll("code").forEach((code) => {
    if (code.closest("a, pre") !== null) return;
    const href = inlineCodeFileHref(code.textContent);
    if (href === undefined || (workspaceMarkdownFilePath(href, workspace) === undefined && outsideChatFilePath(href, workspace) === undefined)) return;
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    code.replaceWith(anchor);
    anchor.append(code);
  });
}

// Markdown tables fit the chat column and wrap their cells; the wrapper scrolls only
// what cannot wrap (an over-wide image or many columns on a narrow screen).
function wrapTablesInScrollRegions(root: DocumentFragment): void {
  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains(TABLE_SCROLL_CLASS) === true) return;
    const wrapper = document.createElement("div");
    wrapper.className = TABLE_SCROLL_CLASS;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "Table");
    wrapper.setAttribute("tabindex", "0");
    table.before(wrapper);
    wrapper.append(table);
  });
}

function isSafeUrl(url: string): boolean {
  if (url.startsWith("#") || url.startsWith("/")) return true;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
