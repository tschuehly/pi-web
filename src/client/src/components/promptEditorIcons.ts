import { svg, type TemplateResult } from "lit";

// Hand-rolled inline icons matching the project's stroke style
// (viewBox 0 0 24 24, fill none, stroke currentColor, round caps/joins).
// See tabIcons.ts for the established convention.

export function renderPhotosIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.5"></rect>
      <circle cx="9" cy="9" r="1.6"></circle>
      <path d="m20.5 15.5-4.5-4.5L5.5 20.5"></path>
    </svg>
  `;
}

export function renderCameraIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2h3.4l2-3h5.2l2 3H20a2 2 0 0 1 2 2Z"></path>
      <circle cx="12" cy="13.5" r="3.6"></circle>
    </svg>
  `;
}

export function renderAttachIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 11.5 12.5 19a4 4 0 0 1-5.66-5.66l7.07-7.07a2.5 2.5 0 0 1 3.54 3.54l-7.07 7.07a1 1 0 0 1-1.42-1.42l6.37-6.36"></path>
    </svg>
  `;
}

export function renderSendIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21 3 13.5 21l-2-8.5L3 10.5Z"></path>
      <path d="M21 3 11.5 12.5"></path>
    </svg>
  `;
}

export function renderQueueIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h11"></path>
      <path d="M4 12h7"></path>
      <path d="M4 17h7"></path>
      <path d="m15 14 5 3-5 3z"></path>
    </svg>
  `;
}

export function renderSteerIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 6h3c4 0 5 6 9 6h4"></path>
      <path d="M4 18h3c4 0 5-6 9-6"></path>
      <path d="m17 9 3 3-3 3"></path>
    </svg>
  `;
}

export function renderStopIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon prompt-action-icon-filled" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2"></rect>
    </svg>
  `;
}

/** Context-window fill as a ring: a full track plus an arc for the used share (undefined = empty). */
export function renderContextRing(percent: number | undefined): TemplateResult {
  const used = percent === undefined || !Number.isFinite(percent) ? 0 : Math.min(100, Math.max(0, percent));
  return svg`
    <svg class="context-ring" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle class="context-ring-track" cx="8" cy="8" r="6"></circle>
      <circle class="context-ring-used" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray=${`${String(used)} 100`} transform="rotate(-90 8 8)"></circle>
    </svg>
  `;
}

export function renderRemoveIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M18 6 6 18"></path>
      <path d="m6 6 12 12"></path>
    </svg>
  `;
}

/** Lucide "activity" (https://lucide.dev, ISC): the Activity roster. */
export function renderActivityIcon(): TemplateResult {
  return svg`
    <svg class="prompt-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"></path>
    </svg>
  `;
}
