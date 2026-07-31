# PI WEB product shaping

This document tracks the product changes we want to shape before committing to implementation. It is a working document for maintainers, not a promise of released functionality.

## How to use this document

Each idea moves through these stages:

- **Raw** — worth remembering, but not yet shaped.
- **Shaping** — the problem, boundaries, and success criteria are being clarified.
- **Ready** — scoped well enough to implement.
- **Building** — implementation is in progress.
- **Shipped** — available to users; link to the relevant release or documentation.
- **Parked** — intentionally not being pursued now.

For each idea, record the user problem and desired outcome before proposing implementation details. Keep unknowns explicit. Move durable user guidance into the canonical user documentation when an idea ships.

## Product principles

- Keep the active conversation at the center of the experience.
- Make common actions fast without hiding less common capabilities.
- Use screen space deliberately across desktop, tablet, and mobile.
- Preserve readability, accessibility, and comfortable touch targets.
- Prefer a small number of coherent display choices over many independent visual settings.

## Shaping

### Compact UI mode

**Status:** Building

**Problem**

The default interface uses enough spacing and chrome that users working on smaller laptop screens, tiled windows, or information-dense sessions see less of the conversation and navigation context than they need. There is no intentional way to trade some visual breathing room for more usable content.

**Desired outcome**

Users can choose a compact presentation that shows more useful information without making the interface feel cramped or reducing its functionality. The choice persists between visits and applies consistently across the application.

**Initial scope**

- Add a user-facing density choice with at least **Comfortable** and **Compact** modes.
- Reduce non-essential whitespace in navigation, workspace headers, toolbars, messages, and the prompt area.
- Keep typography readable; compact mode should primarily tighten spacing and chrome rather than shrink body text.
- Keep controls keyboard accessible and preserve appropriate touch targets on touch-oriented layouts.
- Apply the selected density to core UI and provide a shared styling contract that plugins can adopt.
- Persist the preference locally so it does not require server or project configuration.

**Non-goals for the first version**

- Overrides for undocumented component geometry or arbitrary CSS.
- Independent density settings for every panel.
- Fitting more content by truncating essential labels or hiding existing actions.
- Replacing responsive mobile behavior with desktop compact mode.

**Success criteria**

- A user can switch density from settings without reloading the page.
- The selected density survives a browser restart.
- Compact mode visibly increases conversation and navigation density at common laptop viewport sizes.
- Core workflows and actions remain available in both modes.
- Keyboard focus, scroll behavior, overlays, and responsive layouts continue to work.
- Compact mode introduces no body-text readability regression and no clipped controls at supported viewport sizes.

**Resolved first-slice decisions**

- Compact remains selectable at every viewport. Coarse-pointer environments override control and row dimensions with touch-safe values while retaining compact non-interactive spacing.
- The preference is browser-local. It is not machine or project configuration.
- The first public semantic tokens cover controls, list rows, panels, toolbars, messages, and content width. Component-specific geometry remains private.
- Representative one-line navigation rows must fit at least 25% more rows in the same desktop viewport. Conversation body text stays the same size.

**Protected shell and compatibility contract**

- Authentication, connectivity, settings, recovery, action-palette access, and responsive navigation remain host-owned and reachable in every density.
- Density changes semantic variables at the document root. Plugins may consume the documented variables through inheritance but cannot inject global CSS or target PI WEB internals.
- Existing `apiVersion: 1` actions, workspace panels, workspace labels, themes, runtime contexts, and deprecated runtime compatibility helpers continue unchanged. Density is additive and requires no plugin migration.

**Component and inheritance inventory**

| Surface | Existing dimensions | First-slice migration | Inheritance notes |
| --- | --- | --- | --- |
| Shell and responsive navigation | Header, context bar, mobile tabs, panel edges | Header/control/panel roles | Root variables inherit into the shell shadow root. Mobile topology remains unchanged. |
| Project, workspace, and session lists | Section padding, row padding, action menu targets | Panel, list-row, control, toolbar roles | Shared list styles cover each list shadow root. Coarse pointers restore touch-safe rows. |
| Conversation and notices | Chat inset, message padding/gaps, sticky headers, notice controls | Panel, message, toolbar, control roles | Body typography and formatted-content rhythm are intentionally unchanged. |
| Prompt | Footer padding, action gaps, icon targets, editor inset | Panel, toolbar, control roles | CodeMirror content sizing remains explicit; action targets stay bounded. |
| Workspace tools and plugin panels | Tab strip, toolbar, list rows, viewer inset | Panel, toolbar, control, list-row roles | Variables inherit into plugin custom elements; host classes remain compatibility conveniences, not styling API. |
| Settings and dialogs | Dialog inset, navigation rows, close target, content inset | Panel, toolbar, control roles | Appearance is browser-local and applies without reload. Other settings ownership is unchanged. |
| Terminals, code/diff viewers, image previews | Content-specific cell, line, and preview dimensions | No first-slice migration | Readability and artifact geometry need separate evidence before tokenization. |

Remaining hard-coded dimensions are deliberate component geometry or candidates for later migrations; they do not become public merely because they use CSS.

### Agent-authorable presentation profiles

**Status:** Building

**Problem**

Built-in density choices cannot express every user's preferred balance of spacing, control size, and content width. Agents can edit user configuration efficiently, but unrestricted CSS or silent activation would expose internals and let generated values break shell recovery or accessibility.

**Desired outcome**

A user can ask an agent to author every published semantic presentation-token override in a named global profile, inspect its source and validation state, preview it, explicitly apply it in one browser, and always recover to a built-in profile.

**Boundaries**

- Definitions live only in gateway-global PI WEB config; active selection remains browser-local.
- Profiles extend Comfortable or Compact and accept only versioned, allowlisted, bounded semantic tokens.
- Unknown tokens and invalid profiles are isolated by profile id rather than preventing valid profiles or Settings from loading.
- Agents may edit definitions but cannot activate them. Changes to an active profile remain pending while its last valid resolution stays active.
- Coarse-pointer safety floors, body text, focus behavior, responsive topology, protected controls, themes, selectors, markup, and executable CSS values are not customizable through profiles.

**Success criteria**

- Preview, Apply, Cancel, reload, browser restart, changed-revision handling, missing-profile recovery, and built-in reset are deterministic.
- The UI shows the global config path, modification time, profile origin, base, revision, and per-profile validation errors.
- Every published presentation token has a tested validator and can be overridden within its documented bounds.
- Existing plugins inherit resolved tokens unchanged and current `apiVersion: 1` contracts require no migration.

## Raw ideas

Add new ideas here as short problem statements. Promote them to **Shaping** when we are ready to define boundaries and success criteria.
