import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { ASK_USER_OTHER_TEXT_MAX_LENGTH } from "../../../shared/apiTypes";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import type { MarkdownWorkspaceContext } from "../formatting/workspaceLinks";
import { openChatFileLink } from "./FormattedText";
import { editHistory, filesHighlighting, livePreview, markdownWithCodeLanguages } from "./workbenchFilesEditor";

// Attributes that load an image; a folded image keeps them as `data-` attributes until opened.
const IMAGE_SOURCES = ["src", "srcset", "preview-url"];

/** Folds each image of sanitized preview HTML behind a closed "Show image" disclosure without a source, as the Chat folds context media. */
function foldImages(markup: string): string {
  const template = document.createElement("template");
  template.innerHTML = markup;
  for (const image of template.content.querySelectorAll("img, pi-web-markdown-image")) {
    for (const name of IMAGE_SOURCES) {
      const source = image.getAttribute(name);
      if (source === null) continue;
      image.setAttribute(`data-${name}`, source);
      image.removeAttribute(name);
    }
    const alt = (image.getAttribute("alt") ?? image.getAttribute("description") ?? "").trim();
    const details = document.createElement("details");
    details.className = "folded-media";
    const summary = document.createElement("summary");
    summary.textContent = alt === "" ? "Show image" : `Show image: ${alt}`;
    image.replaceWith(details);
    details.append(summary, image);
  }
  return template.innerHTML;
}

/** Opens or closes a folded image; its source is set on the first opening. */
function toggleFold(details: HTMLDetailsElement): void {
  details.open = !details.open;
  if (!details.open) return;
  for (const image of details.querySelectorAll("[data-src], [data-srcset], [data-preview-url]")) {
    for (const name of IMAGE_SOURCES) {
      const source = image.getAttribute(`data-${name}`);
      if (source === null) continue;
      image.setAttribute(name, source);
      image.removeAttribute(`data-${name}`);
    }
  }
}

/**
 * A multi-line answer of the ask card in the Files pane's Markdown editor (live preview, highlighting, undo).
 * Light DOM, so the card's shadow root carries its styles and focus moves into it like into a textarea.
 * Dispatches `ask-field-input` after each edit by the user; setting `value` replaces the text without one.
 */
export class AskMarkdownField extends HTMLElement {
  #view: EditorView | undefined;
  #value = "";
  #label = "";
  #invalid = false;
  #describedBy: string | undefined;
  #replacing = false;
  readonly #attributes = new Compartment();
  maxLength = ASK_USER_OTHER_TEXT_MAX_LENGTH;
  /** Shown while empty; read when the field connects. */
  placeholderText = "";
  /** Resolves workspace image paths in the live preview, as the Chat does. */
  workspaceContext: MarkdownWorkspaceContext | undefined;

  get value(): string {
    return this.#view?.state.doc.toString() ?? this.#value;
  }

  set value(text: string) {
    this.#value = text;
    const view = this.#view;
    if (view === undefined || view.state.doc.toString() === text) return;
    this.#replacing = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    } finally {
      this.#replacing = false;
    }
  }

  set label(text: string) { this.#label = text; this.#syncAttributes(); }
  set invalid(invalid: boolean) { this.#invalid = invalid; this.#syncAttributes(); }
  set describedBy(id: string | undefined) { this.#describedBy = id; this.#syncAttributes(); }

  constructor() {
    super();
    // Capture runs before the editor's own handlers, which would move the cursor into the image (showing its source) or take Enter as a newline.
    this.addEventListener("mousedown", (event) => { if (this.#foldSummary(event) !== undefined) event.stopPropagation(); }, true);
    this.addEventListener("click", (event) => { this.#activateFold(event); }, true);
    this.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") this.#activateFold(event); }, true);
  }

  connectedCallback(): void {
    if (this.#view !== undefined) return;
    const root = this.getRootNode();
    this.#view = new EditorView({
      parent: this,
      ...(root instanceof ShadowRoot || root instanceof Document ? { root } : {}),
      state: EditorState.create({
        doc: this.#value,
        // Live preview shows the Markdown marks of the cursor's line; starting after the text keeps a heading on top rendered.
        selection: { anchor: this.#value.length },
        extensions: [
          editHistory(), drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          filesHighlighting, markdownWithCodeLanguages(), EditorView.lineWrapping,
          livePreview((source) => foldImages(toSafeMarkdownHtml(source, this.workspaceContext)), (anchor) => {
            // File links open as in the Chat (Files pane, Finder); other links in a new tab.
            const context = this.workspaceContext;
            if (context === undefined || !openChatFileLink(this, context, anchor)) window.open(anchor.href, "_blank", "noopener");
          }),
          // The textarea's maxlength: an edit that would pass the limit is refused.
          EditorState.transactionFilter.of((tr) => tr.docChanged && tr.newDoc.length > this.maxLength && tr.newDoc.length > tr.startState.doc.length ? [] : tr),
          this.placeholderText === "" ? [] : placeholder(this.placeholderText),
          this.#attributes.of(this.#contentAttributes()),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || this.#replacing) return;
            this.#value = update.state.doc.toString();
            this.dispatchEvent(new Event("ask-field-input", { bubbles: true }));
          }),
        ],
      }),
    });
  }

  disconnectedCallback(): void {
    // A move (removed and re-added in one task) keeps the editor, its cursor and undo history; a removal frees its window and document listeners.
    queueMicrotask(() => {
      if (this.isConnected || this.#view === undefined) return;
      this.#value = this.#view.state.doc.toString();
      this.#view.destroy();
      this.#view = undefined;
    });
  }

  override focus(): void {
    this.#view?.focus();
  }

  /** Focuses the field with the cursor after its text. */
  focusEnd(): void {
    const view = this.#view;
    if (view === undefined) return;
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  }

  #foldSummary(event: Event): HTMLDetailsElement | undefined {
    const summary = event.target instanceof Element ? event.target.closest(".lp-img details.folded-media > summary") : null;
    return summary?.parentElement instanceof HTMLDetailsElement ? summary.parentElement : undefined;
  }

  #activateFold(event: Event): void {
    const details = this.#foldSummary(event);
    if (details === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    toggleFold(details);
  }

  #contentAttributes() {
    return EditorView.contentAttributes.of({
      "aria-label": this.#label,
      "aria-multiline": "true",
      "aria-invalid": String(this.#invalid),
      ...(this.#describedBy === undefined ? {} : { "aria-describedby": this.#describedBy }),
    });
  }

  #syncAttributes(): void {
    this.#view?.dispatch({ effects: this.#attributes.reconfigure(this.#contentAttributes()) });
  }
}

if (customElements.get("ask-markdown-field") === undefined) customElements.define("ask-markdown-field", AskMarkdownField);

declare global {
  interface HTMLElementTagNameMap {
    "ask-markdown-field": AskMarkdownField;
  }
}
