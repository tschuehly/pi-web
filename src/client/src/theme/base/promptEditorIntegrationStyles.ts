import { css } from "lit";

/**
 * CodeMirror injects unlayered defaults into its shadow root. These narrowly
 * scoped integration rules must compete in that same cascade, not below it.
 * Appearance still comes from theme properties; surrounding layout stays layered.
 */
export const promptEditorIntegrationStyles = css`
  footer:has(.cm-editor.cm-focused) { border-top-color: var(--pi-accent); }
  textarea { box-sizing: border-box; width: 100%; min-height: 44px; max-height: min(220px, var(--prompt-editor-maximum-height, 220px)); overflow: hidden; border: 0; border-radius: 0; background: transparent; color: var(--pi-text); font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif); }
  .markdown-editor .cm-editor { box-sizing: border-box; width: 100%; min-height: 44px; max-height: min(220px, var(--prompt-editor-maximum-height, 220px)); overflow: hidden; border: 0; border-radius: 0; background: transparent; color: var(--pi-text); font: var(--pi-control-font-size, 16px)/1.4 var(--pi-control-font-family, system-ui, sans-serif); }
  .markdown-editor .cm-scroller { max-height: min(220px, var(--prompt-editor-maximum-height, 220px)); overflow-y: auto; font-family: var(--pi-control-font-family, system-ui, sans-serif); line-height: 1.4; }
  .markdown-editor-manual-height .cm-editor { height: var(--prompt-editor-manual-height); max-height: var(--prompt-editor-maximum-height); }
  .markdown-editor-manual-height .cm-scroller { height: 100%; max-height: none; }
  .markdown-editor .cm-content { min-height: 32px; padding: 6px 0; caret-color: var(--pi-text); text-align: start; unicode-bidi: plaintext; }
  .markdown-editor .cm-line { padding: 0; unicode-bidi: plaintext; }
  .markdown-editor .cm-placeholder { color: var(--pi-dim); }
  .markdown-editor .cm-argument-hint { color: var(--pi-dim); pointer-events: none; }
  .markdown-editor .cm-reply-quote { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; border-left: 2px solid var(--pi-accent); padding-left: 4px; color: var(--pi-muted); cursor: pointer; }
  .markdown-editor .cm-reply-quote-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .markdown-editor .cm-reply-quote-open { vertical-align: middle; margin-right: 2px; }
  .markdown-editor .cm-reply-quote:hover { color: var(--pi-text); }
  .markdown-editor .cm-reply-quote .tab-icon { flex: none; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: transform .12s ease; }
  .markdown-editor .cm-reply-quote-open .tab-icon { transform: rotate(90deg); }
  .markdown-editor .cm-focused { outline: none; }
  /* drawSelection() renders the caret and selection itself, and CodeMirror's
     base colors for them assume a light editor (black caret, pale selection).
     Re-theme them so they stay readable in every pi-web theme. The focused
     selection rule must outspecify CodeMirror's base rule for the focused
     selection background. */
  .markdown-editor .cm-cursor { border-left-color: var(--pi-text); }
  .markdown-editor .cm-editor .cm-selectionBackground { background: color-mix(in srgb, var(--pi-text) 18%, transparent); }
  .markdown-editor .cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: color-mix(in srgb, var(--pi-accent) 32%, transparent); }
  button:disabled, textarea:disabled, .markdown-editor-disabled .cm-editor { opacity: .5; cursor: not-allowed; }
  :host([dense]) .input-row:has(.cm-editor.cm-focused) { background: color-mix(in srgb, var(--pi-text) 9%, transparent); }
  :host([dense]) .markdown-editor .cm-editor { min-height: 0; font-size: 14px; }
  :host([dense]) .markdown-editor .cm-content { min-height: 0; padding: 4px 0; }
  /* CodeMirror measures this element for the empty-document caret. Keep the
     layout box here, not on its pseudo-element, so the caret has a height. */
  .markdown-editor .prompt-placeholder { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .markdown-editor .prompt-placeholder::before { content: attr(data-placeholder); }
  .editor-wrap:has(.editor-chat-navigation) .cm-content { padding-right: 66px; }
`;
