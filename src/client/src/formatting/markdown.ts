import { marked } from "marked";
import { replaceLocalMarkdownImages } from "./markdownImages";
import { workspaceFilePreviewUrl } from "../api/urls";
import { resolveAppUrl } from "../appUrl";
import { adHocFolderWorkspaceId } from "../../../shared/workspaceFiles";
import { outsideChatFilePath, workspaceMarkdownFilePath, type MarkdownWorkspaceContext } from "./workspaceLinks";

const renderer = new marked.Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.blockquote = function ({ text, tokens }) {
  // Marked's text removes only the outer quote markers, retaining Markdown syntax and blank lines.
  return `<blockquote data-quote-source="${escapeHtml(text).replaceAll('"', "&quot;")}">\n${this.parser.parse(tokens)}</blockquote>\n`;
};

const MAX_MARKDOWN_CACHE_ENTRIES = 300;
const markdownHtmlCache = new Map<string, string>();

export function toSafeMarkdownHtml(text: string, workspace?: MarkdownWorkspaceContext, imageIntentKey?: string): string {
  // Only workspace links depend on the effective application base, not route/query changes.
  const key = JSON.stringify([text, workspace === undefined ? null : [
    workspace.machineId, workspace.projectId, workspace.workspaceId, workspace.root, workspace.sourcePath, resolveAppUrl(""), imageIntentKey,
  ]]);
  const cached = markdownHtmlCache.get(key);
  if (cached !== undefined) return cached;
  const html = marked.parse(text, { async: false, breaks: true, gfm: true, renderer });
  const safeHtml = sanitizeHtml(html, workspace, imageIntentKey);
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

function sanitizeHtml(html: string, workspace?: MarkdownWorkspaceContext, imageIntentKey?: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  if (workspace !== undefined) replaceLocalMarkdownImages(template.content, workspace, imageIntentKey);
  template.content.querySelectorAll("script, style, iframe, object, embed").forEach((node) => { node.remove(); });
  template.content.querySelectorAll("*").forEach((element) => {
    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    if (href !== null && workspace !== undefined) {
      const path = workspaceMarkdownFilePath(href, workspace);
      const outside = path === undefined ? outsideChatFilePath(href, workspace) : undefined;
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
  wrapTablesInScrollRegions(template.content);
  return template.innerHTML;
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
