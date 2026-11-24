// The one source-free disclosure of the ask card's media: the context editor, read-only details and sent records.
const IMAGES = "img, pi-web-markdown-image";
// Attributes that load an image; a folded image keeps them as `data-folded-` attributes until opened.
const IMAGE_SOURCES = ["src", "srcset", "preview-url"];
const folded = (name: string) => `data-folded-${name}`;

/**
 * Folds each image and Mermaid code block under `root` behind a closed disclosure; an image loses its source until
 * `revealFoldedMedia`. A diagram renderer later replaces the code block inside its disclosure.
 */
export function foldMedia(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(`${IMAGES}, .code-block-wrapper`).forEach((element) => {
    const image = element.matches(IMAGES);
    const diagram = !image && element.querySelector(":scope > pre > code.language-mermaid") !== null;
    if ((!image && !diagram) || element.parentElement?.closest("details.folded-media")) return;
    if (image) {
      for (const name of IMAGE_SOURCES) {
        // A stashed source comes only from this fold, never from the sanitized Markdown.
        element.removeAttribute(folded(name));
        const source = element.getAttribute(name);
        if (source === null) continue;
        element.setAttribute(folded(name), source);
        element.removeAttribute(name);
      }
    }
    const alt = (element.getAttribute("alt") ?? element.getAttribute("description") ?? "").trim();
    const details = element.ownerDocument.createElement("details");
    details.className = "folded-media";
    const summary = element.ownerDocument.createElement("summary");
    summary.textContent = diagram ? "Show diagram" : alt === "" ? "Show image" : `Show image: ${alt}`;
    element.replaceWith(details);
    details.append(summary, element);
  });
}

/** `foldMedia` over sanitized HTML, so the images mount without a source. */
export function foldMediaMarkup(markup: string): string {
  const template = document.createElement("template");
  template.innerHTML = markup;
  foldMedia(template.content);
  return template.innerHTML;
}

/** Shows what an opened disclosure holds: its images get their sources. */
export function revealFoldedMedia(details: HTMLDetailsElement): void {
  if (!details.open || !details.classList.contains("folded-media")) return;
  for (const image of details.querySelectorAll(IMAGES)) {
    for (const name of IMAGE_SOURCES) {
      const source = image.getAttribute(folded(name));
      if (source === null) continue;
      image.setAttribute(name, source);
      image.removeAttribute(folded(name));
    }
  }
}
