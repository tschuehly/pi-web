import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { writeClipboardText } from "../clipboard";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import type { MarkdownWorkspaceContext, OutsideFileOpenRequest, WorkspaceFileOpenRequest } from "../formatting/workspaceLinks";
import { formattedTextStyles } from "./shared";

@customElement("formatted-text")
export class FormattedText extends LitElement {
  @property() text = "";
  @property({ attribute: false }) workspaceContext: MarkdownWorkspaceContext | undefined;

  override render() {
    return html`<div class="formatted" dir="auto" @click=${this.onFormattedClick}>${unsafeHTML(toSafeMarkdownHtml(this.text, this.workspaceContext))}</div>`;
  }

  override updated(): void {
    this.enhanceCodeBlocks();
    this.enhanceQuotes();
  }

  private enhanceCodeBlocks(): void {
    this.renderRoot.querySelectorAll("pre").forEach((element) => {
      if (!(element instanceof HTMLPreElement) || element.parentElement?.classList.contains("code-block-wrapper") === true) return;
      const code = element.querySelector("code");
      if (!(code instanceof HTMLElement)) return;
      const wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";
      const button = this.createCopyButton("code block");
      element.before(wrapper);
      wrapper.append(element, button);
    });
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
    const anchor = event.target.closest("a[data-workspace-file], a[data-outside-file]");
    if (anchor instanceof HTMLAnchorElement && this.workspaceContext !== undefined
      && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
      && (!anchor.target || anchor.target === "_self")) {
      const path = anchor.getAttribute("data-workspace-file");
      const outside = anchor.getAttribute("data-outside-file");
      // The macOS app opens local HTML pages in the browser (their scripts and assets work there) and folders in Finder.
      const absolute = outside ?? (path === null ? null : `${this.workspaceContext.root.replace(/\/+$/, "")}/${path}`);
      const openLocalFile = this.workspaceContext.machineId === "local" ? window.piWebNative?.openLocalFile : undefined;
      const html = absolute !== null && /\.html?$/i.test(absolute);
      // ponytail: a last segment without a dot is taken for a folder; the app refuses files like Makefile, which then open in the pane.
      const folder = absolute !== null && !/\.[^/]+\/*$/.test(absolute.slice(absolute.replace(/\/+$/, "").lastIndexOf("/")));
      if (absolute !== null && openLocalFile !== undefined && (html || folder)) {
        event.preventDefault();
        const context = this.workspaceContext;
        void openLocalFile(absolute).catch((error: unknown) => {
          if (html) { console.warn("Could not open HTML file in the browser", error); return; }
          this.requestFileOpen(context, path, outside);
        });
        return;
      }
      if (this.requestFileOpen(this.workspaceContext, path, outside)) event.preventDefault();
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
    const code = button.closest(".code-block-wrapper")?.querySelector("pre code");
    if (!(code instanceof HTMLElement)) return;
    void this.copyText(code.textContent, button, "code block");
  };

  /** Asks the host to open a Chat file link; true when a host handled (cancelled) the request. */
  private requestFileOpen(context: NonNullable<FormattedText["workspaceContext"]>, path: string | null, outside: string | null): boolean {
    const request = path !== null
      ? new CustomEvent<WorkspaceFileOpenRequest>("workspace-file-open", { detail: { ...context, path }, bubbles: true, composed: true, cancelable: true })
      : outside === null ? undefined
      : new CustomEvent<OutsideFileOpenRequest>("outside-file-open", { detail: { machineId: context.machineId, path: outside }, bubbles: true, composed: true, cancelable: true });
    return request !== undefined && !this.dispatchEvent(request);
  }

  private async copyText(text: string, button: HTMLButtonElement, kind: "code block" | "quote"): Promise<void> {
    const copied = await writeClipboardText(text);
    this.setCopyButtonState(button, copied ? "copied" : "failed", kind);
    window.setTimeout(() => {
      this.setCopyButtonState(button, "idle", kind);
    }, 1200);
  }

  private setCopyButtonState(button: HTMLButtonElement, state: "idle" | "copied" | "failed", kind: "code block" | "quote"): void {
    const icon = button.querySelector("span");
    if (icon !== null) icon.textContent = state === "copied" ? "✓" : "⧉";
    const label = state === "copied" ? `Copied ${kind}` : state === "failed" ? `Failed to copy ${kind}` : `Copy ${kind}`;
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  static override styles = formattedTextStyles;
}
