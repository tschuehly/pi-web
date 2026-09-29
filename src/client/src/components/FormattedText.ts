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
      const request = path !== null
        ? new CustomEvent<WorkspaceFileOpenRequest>("workspace-file-open", { detail: { ...this.workspaceContext, path }, bubbles: true, composed: true, cancelable: true })
        : outside === null ? undefined
        : new CustomEvent<OutsideFileOpenRequest>("outside-file-open", { detail: { machineId: this.workspaceContext.machineId, path: outside }, bubbles: true, composed: true, cancelable: true });
      if (request !== undefined && !this.dispatchEvent(request)) event.preventDefault();
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
