import { html, svg, type TemplateResult } from "lit";

export function renderNavigationMenuIcon(): TemplateResult {
  return svg`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>`;
}

export type AppTabBuiltinIcon = "navigation" | "bell" | "chat" | "chat-plus" | "chevron" | "chevron-left" | "files" | "folder-plus" | "git" | "maximize" | "menu" | "minimize" | "panels-top-left" | "plus" | "settings" | "terminal" | "x";
export type AppTabIcon = AppTabBuiltinIcon | TemplateResult;

export function renderAppTabIcon(icon: AppTabIcon): TemplateResult {
  if (typeof icon !== "string") return html`<span class="tab-custom-icon" aria-hidden="true">${icon}</span>`;
  return renderBuiltinTabIcon(icon);
}

/** The transcript's one disclosure marker: a summary's first child; uiTranscriptStyles turns it when open. */
export function renderDisclosureChevron(): TemplateResult {
  return html`<span class="chevron">${renderBuiltinTabIcon("chevron")}</span>`;
}

export function renderBuiltinTabIcon(icon: AppTabBuiltinIcon): TemplateResult {
  switch (icon) {
    case "bell":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path>
          <path d="M10 21h4"></path>
        </svg>
      `;
    case "navigation":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="6" cy="7" r="1.5"></circle>
          <path d="M10 7h8"></path>
          <circle cx="6" cy="12" r="1.5"></circle>
          <path d="M10 12h8"></path>
          <circle cx="6" cy="17" r="1.5"></circle>
          <path d="M10 17h8"></path>
        </svg>
      `;
    case "chat":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M7 5h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-6l-5 4v-4H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z"></path>
          <path d="M8 9h8"></path>
          <path d="M8 13h5"></path>
        </svg>
      `;
    case "chat-plus":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 7v6"></path>
          <path d="M9 10h6"></path>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      `;
    case "chevron":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M9 18l6-6-6-6"></path>
        </svg>
      `;
    case "chevron-left":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m15 18-6-6 6-6"></path>
        </svg>
      `;
    case "files":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
        </svg>
      `;
    case "folder-plus":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 10v6"></path>
          <path d="M9 13h6"></path>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>
        </svg>
      `;
    case "git":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="6" cy="6" r="2"></circle>
          <circle cx="18" cy="6" r="2"></circle>
          <circle cx="12" cy="18" r="2"></circle>
          <path d="M8 6h6"></path>
          <path d="M6 8v2a6 6 0 0 0 6 6"></path>
          <path d="M18 8v2a6 6 0 0 1-6 6"></path>
        </svg>
      `;
    case "maximize":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M15 3h6v6"></path>
          <path d="m21 3-7 7"></path>
          <path d="m3 21 7-7"></path>
          <path d="M9 21H3v-6"></path>
        </svg>
      `;
    case "menu":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 12h16"></path>
          <path d="M4 6h16"></path>
          <path d="M4 18h16"></path>
        </svg>
      `;
    case "settings":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      `;
    case "minimize":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m14 10 7-7"></path>
          <path d="M20 10h-6V4"></path>
          <path d="m3 21 7-7"></path>
          <path d="M4 14h6v6"></path>
        </svg>
      `;
    case "panels-top-left":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect width="18" height="18" x="3" y="3" rx="2"></rect>
          <path d="M3 9h18"></path>
          <path d="M9 21V9"></path>
        </svg>
      `;
    case "plus":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 12h14"></path>
          <path d="M12 5v14"></path>
        </svg>
      `;
    case "x":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M18 6 6 18"></path>
          <path d="m6 6 12 12"></path>
        </svg>
      `;
    case "terminal":
      return svg`
        <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <rect x="3" y="5" width="18" height="14" rx="2"></rect>
          <path d="m7 10 3 3-3 3"></path>
          <path d="M12 16h5"></path>
        </svg>
      `;
  }
}
