import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { VisibleContentController } from "../formatting/deferredContent";
import type { ChatContentRendering } from "../formatting/contentRendering";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { writeClipboardText } from "../clipboard";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import { DEFAULT_CODE_BLOCK_POLICY, type CodeBlockPolicy } from "../formatting/codeBlockPolicy";
import { rememberExternalMarkdownImageDimensions, restoreExternalMarkdownImageDimensions } from "../formatting/externalMarkdownImages";
import { workspaceContextChanged, type MarkdownWorkspaceContext, type OutsideFileOpenRequest, type WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { formattedTextStyles } from "./formattedTextStyles";
import { codeBlockFrameStyles } from "./codeBlockFrameStyles";

const FILE_LINK_SELECTOR = "a[data-workspace-file], a[data-outside-file]";
// ponytail: binary documents the Files pane cannot show; others (text, code, Makefile, .mp4/.mov/.webm video) open in the pane. Extend as needed.
const REVEAL_IN_FINDER = /\.(docx?|docm|xlsx?|xlsm|xlsb|pptx?|pptm|ppsx|key|pages|numbers|odt|ods|odp|odg|rtf|epub|zip|dmg|pkg|mp3|m4a|wav|flac|aac|mkv)$/i;
// Lucide folder-search.
const REVEAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"/><path d="m21 21-1.9-1.9"/><circle cx="17" cy="17" r="3"/></svg>';
// Lucide copy.
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
type CopyKind = "code block" | "quote" | "full path";

@customElement("formatted-text")
export class FormattedText extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
  }

  @property() text = "";
  @property() intentKey: string | undefined;
  @property({ type: Boolean }) imagesEnabled = true;
  @property({ attribute: false }) codeBlocks: CodeBlockPolicy = DEFAULT_CODE_BLOCK_POLICY;
  @property({ attribute: false }) contentRendering: ChatContentRendering | undefined;
  @property() machineId = "local";
  @property({ attribute: false, hasChanged: workspaceContextChanged }) workspaceContext: MarkdownWorkspaceContext | undefined;

  private readonly enhancement = new VisibleContentController(this);
  private phase: "markdown" | "preview" | "done" = "markdown";
  private scheduled = false;
  private markup: string | undefined;
  private content: TemplateResult | undefined;
  private displayedText = "";
  private replacing = false;
  private layoutChanged = false;

  protected override willUpdate(changes: PropertyValues<this>): void {
    const inputs = ["text", "intentKey", "imagesEnabled", "codeBlocks", "contentRendering", "machineId", "workspaceContext"] as const;
    if (!inputs.some((key) => changes.has(key))) return;
    this.enhancement.cancel();
    this.scheduled = false;
    this.phase = "markdown";
    this.markup = undefined;
    // Retain stable source controls and completed previews while prose streams.
    // New identities/replacements must never show the previous content.
    this.replacing = !this.text.startsWith(this.displayedText) || changes.has("intentKey") || changes.has("machineId") || changes.has("workspaceContext");
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.scheduled = false;
  }

  override render() {
    const className = this.codeBlocks.overflow === "scroll" ? "formatted code-blocks-scroll" : "formatted";
    // Source is ordinary escaped Lit text. Neither Markdown nor plugin code is
    // called by this render or by the session-loading flow. Once formatted, keep
    // that view until its update is ready: a raw tail after a Markdown block adds
    // a temporary line on every streaming chunk.
    const showSource = this.replacing || this.content === undefined;
    return html`<div class=${className} dir="auto" @load=${this.onImageLoad} @click=${this.onFormattedClick}><div class="enhanced-content" ?hidden=${this.replacing}>${this.content}</div><span class="pending-source" ?hidden=${!showSource}>${showSource ? this.text : ""}</span></div>`;
  }

  override updated(): void {
    if (this.phase !== "done" && !this.scheduled) {
      this.scheduled = true;
      this.enhancement.request(() => {
        this.scheduled = false;
        if (this.phase === "markdown") this.formatMarkdown();
        else if (this.phase === "preview") this.enhanceMarkdown();
        this.requestUpdate();
      });
    }
    // HTML is memoized independently of geometry; apply hints on every DOM mount,
    // in this update's microtask before paint or the chat's position-restoration frame.
    restoreExternalMarkdownImageDimensions(this.renderRoot);
    this.enhanceQuotes();
    this.enhanceFileLinks();
    if (this.layoutChanged) {
      this.layoutChanged = false;
      this.dispatchEvent(new CustomEvent("content-layout-changed", { bubbles: true, composed: true }));
    }
  }

  private formatMarkdown(): void {
    try {
      this.markup = toSafeMarkdownHtml(this.text, this.workspaceContext, this.intentKey, this.imagesEnabled, this.codeBlocks);
      if (this.codeBlocks.previews && this.contentRendering !== undefined) {
        this.phase = "preview";
        if (this.content === undefined) this.showMarkdown();
      } else {
        this.showMarkdown();
        this.phase = "done";
      }
    } catch (error) {
      console.warn("Chat Markdown formatting failed; source remains available", error);
      this.replacing = true;
      this.phase = "done";
    }
  }

  private showMarkdown(): void {
    this.layoutChanged = true;
    this.content = html`${unsafeHTML(this.markup)}`;
    this.displayedText = this.text;
    this.replacing = false;
  }

  private enhanceMarkdown(): void {
    try {
      this.layoutChanged = true;
      this.content = this.contentRendering?.renderMarkdown({
        text: this.text,
        machineId: this.workspaceContext?.machineId ?? this.machineId,
        toSafeHtml: (text) => text === this.text && this.markup !== undefined ? this.markup
          : toSafeMarkdownHtml(text, this.workspaceContext, this.intentKey, this.imagesEnabled, this.codeBlocks),
      }, this.intentKey, this.codeBlocks);
      this.displayedText = this.text;
      this.replacing = false;
    } catch (error) {
      console.warn("Chat content enhancement failed; Markdown remains available", error);
      this.showMarkdown();
    }
    this.phase = "done";
  }

  private readonly onImageLoad = {
    // Native image loads do not bubble. Capture only inside this formatting root.
    capture: true,
    handleEvent: (event: Event): void => {
      if (event.target instanceof HTMLImageElement) rememberExternalMarkdownImageDimensions(event.target);
    },
  };

  /**
   * Each file link shows its full path as a tooltip and gets a Copy full path button; the href stays the
   * download URL so middle-click and the no-host fallback keep working. In the macOS app, local links also
   * get a button that reveals the file in Finder.
   */
  private enhanceFileLinks(): void {
    const context = this.workspaceContext;
    if (context === undefined) return;
    const reveal = context.machineId === "local" && window.piWebNative?.revealLocalFile !== undefined;
    this.renderRoot.querySelectorAll(FILE_LINK_SELECTOR).forEach((anchor) => {
      const absolute = this.absoluteLinkPath(anchor, context);
      if (absolute === null || anchor.hasAttribute("data-full-path")) return;
      anchor.setAttribute("data-full-path", absolute);
      anchor.setAttribute("title", absolute);
      const copy = this.createIconButton("file-copy-button", "Copy full path", "Copy full path", COPY_ICON);
      anchor.after(copy);
      if (reveal) anchor.after(this.createIconButton("file-reveal-button", "Show in Finder", `Show ${anchor.textContent.trim()} in Finder`, REVEAL_ICON));
    });
  }

  private createIconButton(className: string, title: string, label: string, icon: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.title = title;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon;
    return button;
  }

  /** The absolute local path of a Chat file link: outside links carry it, workspace links are relative to the root. */
  private absoluteLinkPath(anchor: Element, context: MarkdownWorkspaceContext): string | null {
    const path = anchor.getAttribute("data-workspace-file");
    return anchor.getAttribute("data-outside-file") ?? (path === null ? null : `${context.root.replace(/\/+$/, "")}/${path}`);
  }

  private enhanceQuotes(): void {
    this.renderRoot.querySelectorAll("blockquote").forEach((quote) => {
      if (quote.parentElement?.closest("blockquote") || quote.querySelector(":scope > .quote-copy-button")) return;
      quote.classList.add("copyable-quote");
      quote.append(this.createCopyButton("quote"));
    });
  }

  private createCopyButton(kind: "code block" | "quote"): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = kind === "quote" ? "quote-copy-button" : "code-copy-button";
    button.title = `Copy ${kind}`;
    button.setAttribute("aria-label", `Copy ${kind}`);
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⧉";
    button.append(icon);
    return button;
  }

  private readonly onFormattedClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const reveal = event.target.closest(".file-reveal-button");
    const revealed = reveal?.previousElementSibling;
    if (revealed instanceof Element && this.workspaceContext !== undefined) {
      const absolute = this.absoluteLinkPath(revealed, this.workspaceContext);
      if (absolute !== null) void window.piWebNative?.revealLocalFile?.(absolute).catch((error: unknown) => { console.warn("Could not show the file in Finder", error); });
      return;
    }
    const copyPath = event.target.closest(".file-copy-button");
    if (copyPath instanceof HTMLButtonElement) {
      const linked = copyPath.previousElementSibling?.closest(".file-reveal-button")?.previousElementSibling ?? copyPath.previousElementSibling;
      const absolute = linked?.getAttribute("data-full-path");
      if (absolute !== null && absolute !== undefined) void this.copyText(absolute, copyPath, "full path");
      return;
    }
    const anchor = event.target.closest(FILE_LINK_SELECTOR);
    if (anchor instanceof HTMLAnchorElement && this.workspaceContext !== undefined
      && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
      && (!anchor.target || anchor.target === "_self")) {
      const path = anchor.getAttribute("data-workspace-file");
      const outside = anchor.getAttribute("data-outside-file");
      const absolute = this.absoluteLinkPath(anchor, this.workspaceContext);
      const native = this.workspaceContext.machineId === "local" ? window.piWebNative : undefined;
      const context = this.workspaceContext;
      // The macOS app reveals documents the Files pane cannot show (e.g. .docx) in Finder; nothing opens.
      if (absolute !== null && native?.revealLocalFile !== undefined && REVEAL_IN_FINDER.test(absolute)) {
        event.preventDefault();
        void native.revealLocalFile(absolute).catch((error: unknown) => {
          console.warn("Could not show the file in Finder", error);
          this.requestFileOpen(context, path, outside, anchor);
        });
        return;
      }
      // The macOS app opens local HTML pages in the browser (their scripts and assets work there) and folders in Finder.
      const openLocalFile = native?.openLocalFile;
      const html = absolute !== null && /\.html?$/i.test(absolute);
      // ponytail: a last segment without a dot is taken for a folder; the app refuses files like Makefile, which then open in the pane.
      const folder = absolute !== null && !/\.[^/]+\/*$/.test(absolute.slice(absolute.replace(/\/+$/, "").lastIndexOf("/")));
      if (absolute !== null && openLocalFile !== undefined && (html || folder)) {
        event.preventDefault();
        void openLocalFile(absolute).catch((error: unknown) => {
          if (html) { console.warn("Could not open HTML file in the browser", error); return; }
          this.requestFileOpen(context, path, outside, anchor);
        });
        return;
      }
      if (this.requestFileOpen(this.workspaceContext, path, outside, anchor)) event.preventDefault();
      return;
    }
    const button = event.target.closest(".code-copy-button, .quote-copy-button");
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.classList.contains("quote-copy-button")) {
      const quote = button.closest<HTMLElement>("blockquote");
      if (quote === null) return;
      void this.copyText(quote.getAttribute("data-quote-source") ?? quote.innerText, button, "quote");
      return;
    }
    const code = button.closest(".code-block-wrapper")?.querySelector("pre code, .plain-code-block");
    if (!(code instanceof HTMLElement)) return;
    void this.copyText(code.textContent, button, "code block");
  };

  /** Asks the host to open a Chat file link; true when a host handled (cancelled) the request. */
  private requestFileOpen(context: NonNullable<FormattedText["workspaceContext"]>, path: string | null, outside: string | null, anchor: Element): boolean {
    const [start = 0, end = start] = (anchor.getAttribute("data-lines") ?? "").split("-").map(Number);
    const lines = start > 0 ? { lines: { start, end } } : {};
    const request = path !== null
      ? new CustomEvent<WorkspaceFileOpenRequest>("workspace-file-open", { detail: { ...context, path, ...lines }, bubbles: true, composed: true, cancelable: true })
      : outside === null ? undefined
      : new CustomEvent<OutsideFileOpenRequest>("outside-file-open", { detail: { machineId: context.machineId, path: outside, ...lines }, bubbles: true, composed: true, cancelable: true });
    return request !== undefined && !this.dispatchEvent(request);
  }

  private async copyText(text: string, button: HTMLButtonElement, kind: CopyKind): Promise<void> {
    const copied = await writeClipboardText(text);
    this.setCopyButtonState(button, copied ? "copied" : "failed", kind);
    window.setTimeout(() => {
      this.setCopyButtonState(button, "idle", kind);
    }, 1200);
  }

  private setCopyButtonState(button: HTMLButtonElement, state: "idle" | "copied" | "failed", kind: CopyKind): void {
    const icon = button.querySelector("span");
    if (icon !== null) icon.textContent = state === "copied" ? "✓" : "⧉";
    const label = state === "copied" ? `Copied ${kind}` : state === "failed" ? `Failed to copy ${kind}` : `Copy ${kind}`;
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  static override styles = [formattedTextStyles, codeBlockFrameStyles, css`
    .pending-source { white-space: pre-wrap; overflow-wrap: anywhere; }
    .enhanced-content { display: contents; }
    .enhanced-content[hidden] { display: none; }
    .quote-copy-button { position: absolute; top: 6px; right: 6px; z-index: 1; display: inline-grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-muted); padding: 0; font: 14px system-ui, sans-serif; line-height: 1; cursor: pointer; opacity: 0; }
    .quote-copy-button:hover, .quote-copy-button:focus { color: var(--pi-text); border-color: var(--pi-accent); opacity: 1; }
    .copyable-quote { position: relative; padding-right: 40px; }
    .copyable-quote:hover > .quote-copy-button { opacity: 1; }
    @media (hover: none) { .quote-copy-button { opacity: 1; } }
    .file-reveal-button, .file-copy-button { display: inline-grid; place-items: center; width: 18px; height: 18px; margin-left: 2px; border: 0; border-radius: 4px; background: transparent; color: var(--pi-muted); padding: 0; vertical-align: -3px; cursor: pointer; }
    .file-reveal-button:hover, .file-reveal-button:focus-visible, .file-copy-button:hover, .file-copy-button:focus-visible { color: var(--pi-text); background: var(--pi-surface); }
    .file-reveal-button svg, .file-copy-button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  `];
}
