import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { ASK_USER_OTHER_TEXT_MAX_LENGTH } from "../../../shared/apiTypes";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import { editHistory, filesHighlighting, livePreview, markdownWithCodeLanguages } from "./workbenchFilesEditor";

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

  connectedCallback(): void {
    if (this.#view !== undefined) return;
    const root = this.getRootNode();
    this.#view = new EditorView({
      parent: this,
      ...(root instanceof ShadowRoot || root instanceof Document ? { root } : {}),
      state: EditorState.create({
        doc: this.#value,
        extensions: [
          editHistory(), drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          filesHighlighting, markdownWithCodeLanguages(), EditorView.lineWrapping,
          livePreview((source) => toSafeMarkdownHtml(source), (anchor) => { window.open(anchor.href, "_blank", "noopener"); }),
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
