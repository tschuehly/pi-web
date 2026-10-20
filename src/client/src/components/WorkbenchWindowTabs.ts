import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import type { SessionStatus } from "../api";
import { gridPage, gridPageCount, gridPageLead, windowGroups, workstreamKey, workstreamTabTarget, type ChatGroup, type WindowChat, type WindowLayout, type WorkbenchWindow } from "../workbenchWindows";
import { workstreamAccentColor } from "../workstreamColor";
import { renderBuiltinTabIcon } from "./tabIcons";

export type ChatTabStatus = "needs" | "running" | "done" | "idle";

const STATUS_LABELS: Record<ChatTabStatus, string> = { needs: "Needs you", running: "Working", done: "Done while you were away", idle: "Idle" };

/** Needs you › working › done while you were away (`unread`) › idle. */
export function chatTabStatus(status: SessionStatus | undefined, unread: boolean): ChatTabStatus {
  if ((status?.pendingAsks?.length ?? 0) > 0 || status?.pendingAsk !== undefined || (status?.pendingDialogs?.length ?? 0) > 0) return "needs";
  if (status?.isStreaming === true || status?.isCompacting === true || status?.isBashRunning === true) return "running";
  return unread ? "done" : "idle";
}

/** A Chat's status dot, the same in a tab and a grid tile. */
export function renderChatStatusDot(status: ChatTabStatus) {
  return html`<span class="dot" data-status=${status} role="img" title=${STATUS_LABELS[status]} aria-label=${STATUS_LABELS[status]}></span>`;
}

export const chatStatusDotStyles = css`
  /* Status from theme tokens: working = success, needs you = warning with a halo, done = accent, idle = an outline. */
  .dot { flex: 0 0 auto; box-sizing: border-box; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--pi-dim, var(--pi-muted)); }
  .dot[data-status="running"] { border: 0; background: var(--pi-success); animation: pulse 1.2s ease-in-out infinite; }
  .dot[data-status="needs"] { width: 10px; height: 10px; border: 0; background: var(--pi-warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--pi-warning) 35%, transparent); }
  .dot[data-status="done"] { border: 0; background: var(--pi-accent); }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .dot[data-status="running"] { animation: none; } }
`;

/** Chats dragged out of a window's tabs or tiles; only PI WEB pages of the same origin can read the type. */
const CHAT_DRAG_TYPE = "application/x-pi-workbench-chats";

export interface DraggedChats { windowId: string; sessionIds: string[] }

export function startChatDrag(event: DragEvent, dragged: DraggedChats, label: string): void {
  if (event.dataTransfer === null) return;
  event.dataTransfer.setData(CHAT_DRAG_TYPE, JSON.stringify(dragged));
  event.dataTransfer.setData("text/plain", label);
  event.dataTransfer.effectAllowed = "move";
}

export function carriesChats(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(CHAT_DRAG_TYPE) === true;
}

export function droppedChats(event: DragEvent): DraggedChats | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(event.dataTransfer?.getData(CHAT_DRAG_TYPE) ?? ""); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const windowId: unknown = Reflect.get(parsed, "windowId");
  const sessionIds: unknown = Reflect.get(parsed, "sessionIds");
  return typeof windowId === "string" && Array.isArray(sessionIds) && sessionIds.every((id) => typeof id === "string") ? { windowId, sessionIds } : undefined;
}

export interface ScreenFrame { screenX: number; screenY: number; outerWidth: number; outerHeight: number }

/** A drag that ended beyond this window's frame, where no PI WEB window took it, opens a new window. */
export function endedOutside(point: { screenX: number; screenY: number }, frame: ScreenFrame): boolean {
  return point.screenX < frame.screenX || point.screenX > frame.screenX + frame.outerWidth
    || point.screenY < frame.screenY || point.screenY > frame.screenY + frame.outerHeight;
}

export interface ChatTabMenuDetail { sessionIds: string[]; label: string; clientX: number; clientY: number }

export interface ChatTabSelectDetail { sessionId: string }
export interface ChatTabCloseDetail { sessionIds: string[] }
export interface WindowLayoutDetail { layout: WindowLayout }

/** The Workstream identity colour, as the home card's marker uses it. */
const workstreamStyle = (workstreamId: string | undefined) => styleMap(workstreamId === undefined ? {} : { "--ws": workstreamAccentColor(workstreamId) });

const onActivationKey = (activate: () => void) => (event: KeyboardEvent) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
};

/**
 * Quiet text tabs: the selected Workstream's Chats beside the `tools` slot (the Chat's toolbar) and the window actions,
 * with a row of Workstream tabs above once two or more share the window. Selecting a Workstream reopens its last-active Chat.
 */
@customElement("workbench-window-tabs")
export class WorkbenchWindowTabs extends LitElement {
  @property({ attribute: false }) workingSet: WorkbenchWindow | undefined;
  /** The Chat on screen; undefined while the home shows. */
  @property({ attribute: false }) selected: string | undefined;
  @property({ attribute: false }) statuses: Record<string, ChatTabStatus> = {};
  /** Each Chat's open `ask_user` questions, shown in place of its dot. */
  @property({ attribute: false }) questionCounts: Record<string, number> = {};
  /** This window's id, carried by a drag so the receiving window knows where the Chats come from. */
  @property({ attribute: false }) windowId = "";

  private emit(type: string, detail: ChatTabSelectDetail | ChatTabCloseDetail | ChatTabMenuDetail | DraggedChats | WindowLayoutDetail | undefined): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private select(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.emit("chat-tab-select", { sessionId });
  }

  private close(sessionIds: string[]): void {
    this.emit("chat-tab-close", { sessionIds });
  }

  /** Right-click, drag and drop, shared by Workstream and Chat tabs. */
  private moveHandlers(sessionIds: string[], label: string) {
    return {
      contextmenu: (event: MouseEvent) => {
        event.preventDefault();
        this.emit("chat-tab-menu", { sessionIds, label, clientX: event.clientX, clientY: event.clientY });
      },
      dragstart: (event: DragEvent) => { startChatDrag(event, { windowId: this.windowId, sessionIds }, label); },
      dragend: (event: DragEvent) => {
        if (event.dataTransfer?.dropEffect === "none" && endedOutside(event, window)) this.emit("chat-tab-drag-out", { windowId: this.windowId, sessionIds });
      },
    };
  }

  private readonly onDragOver = (event: DragEvent): void => {
    if (carriesChats(event)) event.preventDefault();
  };

  private readonly onDrop = (event: DragEvent): void => {
    const dropped = droppedChats(event);
    if (dropped === undefined) return;
    event.preventDefault();
    if (dropped.windowId !== this.windowId) this.emit("chat-tab-drop", dropped);
  };

  /** A crowded row scrolls: the Chat on screen stays in view as the selection or the row's room changes. */
  private readonly keepSelectedInView = (): void => {
    const strip = this.renderRoot.querySelector<HTMLElement>(".tabs.chats");
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]') ?? null;
    if (strip === null || tab === null) return;
    // Only the strip scrolls, never the page around it.
    const room = strip.getBoundingClientRect();
    const bounds = tab.getBoundingClientRect();
    if (bounds.left < room.left) strip.scrollLeft -= room.left - bounds.left;
    else if (bounds.right > room.right) strip.scrollLeft += Math.min(bounds.right - room.right, bounds.left - room.left);
  };
  private readonly stripResizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(this.keepSelectedInView);
  private observedStrip: Element | null = null;

  protected override updated(changed: PropertyValues<this>): void {
    const strip = this.renderRoot.querySelector(".tabs.chats");
    if (strip !== this.observedStrip) {
      this.stripResizes?.disconnect();
      if (strip !== null) this.stripResizes?.observe(strip);
      this.observedStrip = strip;
    }
    if (changed.has("selected")) this.keepSelectedInView();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stripResizes?.disconnect();
    this.observedStrip = null;
  }

  private status(chat: WindowChat): ChatTabStatus {
    return this.statuses[chat.sessionId] ?? "idle";
  }

  override render() {
    const window = this.workingSet;
    if (window === undefined || window.chats.length === 0) return nothing;
    const groups = windowGroups(window);
    const current = window.chats.find((chat) => chat.sessionId === (this.selected ?? window.focused));
    const activeKey = current === undefined ? groups[0]?.key : workstreamKey(current);
    const activeGroup = groups.find((group) => group.key === activeKey) ?? groups[0];
    const tabs = window.layout === "tabs";
    return html`
      <nav aria-label=${window.name} @dragover=${this.onDragOver} @drop=${this.onDrop}>
        ${!tabs || groups.length < 2 ? nothing : html`
          <div class="tabs workstreams" role="tablist" aria-label=${`${window.name} Workstreams`}>
            ${groups.map((group) => this.renderWorkstreamTab(window, group, this.selected !== undefined && group === activeGroup))}
          </div>`}
        <div class="bar">
          ${!tabs ? this.renderGridLead(window) : html`
            <div class="tabs chats" role="tablist" aria-label=${`${activeGroup?.workstream?.title ?? "No Workstream"} Chats`}>
              ${activeGroup?.chats.map((chat) => this.renderChatTab(chat))}
            </div>`}
          <slot name="tools"></slot>
          <div class="actions">
            <button class="add" title="Open or start a Chat (⌘T)" aria-pressed=${this.selected === undefined} @click=${() => { this.emit("window-home", undefined); }}>${renderBuiltinTabIcon("plus")}Add</button>
            <div class="segmented" role="group" aria-label="Layout" title="Toggle layout (⌃G)">
              ${(["grid", "tabs"] as const).map((layout) => html`<button aria-pressed=${String(window.layout === layout)} @click=${() => { if (window.layout !== layout) this.emit("window-layout", { layout }); }}>${layout === "grid" ? "Grid" : "Tabs"}</button>`)}
            </div>
          </div>
        </div>
      </nav>
    `;
  }

  /** Grid: the window's name, and pages of four tiles once there are more. */
  private renderGridLead(window: WorkbenchWindow) {
    const pages = gridPageCount(window);
    const page = gridPage(window);
    const turn = (to: number) => { this.select(gridPageLead(window, to)); };
    return html`
      <div class="lead">
        <span class="window-name">${window.name}</span>
        ${pages < 2 || window.maximized ? nothing : html`
          <span class="pager" role="group" aria-label="Grid pages">
            <button aria-label="Previous page" ?disabled=${page === 0} @click=${() => { turn(page - 1); }}>${renderBuiltinTabIcon("chevron-left")}</button>
            <span>${String(page + 1)} / ${String(pages)}</span>
            <button aria-label="Next page" ?disabled=${page >= pages - 1} @click=${() => { turn(page + 1); }}>${renderBuiltinTabIcon("chevron")}</button>
          </span>`}
      </div>`;
  }

  private renderWorkstreamTab(window: WorkbenchWindow, group: ChatGroup, selected: boolean) {
    const label = group.workstream?.title ?? "No Workstream";
    const open = () => { this.select(workstreamTabTarget(window, group.key)); };
    const move = this.moveHandlers(group.chats.map((chat) => chat.sessionId), label);
    return html`
      <div role="tab" tabindex="0" class="workstream-tab" style=${workstreamStyle(group.workstream?.id)} aria-selected=${String(selected)} title=${`Workstream: ${label}`} draggable="true"
        @click=${open} @keydown=${onActivationKey(open)} @contextmenu=${move.contextmenu} @dragstart=${move.dragstart} @dragend=${move.dragend}>
        <span class="title">${label}</span>
        ${group.chats.length > 1 ? html`<span class="count" aria-label=${`${String(group.chats.length)} Chats`}>${String(group.chats.length)}</span>` : nothing}
      </div>`;
  }

  private renderChatTab(chat: WindowChat) {
    const status = this.status(chat);
    const open = () => { this.select(chat.sessionId); };
    const move = this.moveHandlers([chat.sessionId], chat.title);
    const questions = this.questionCounts[chat.sessionId] ?? 0;
    return html`
      <div role="tab" tabindex="0" class="chat-tab" data-session=${chat.sessionId} data-status=${status} aria-selected=${String(chat.sessionId === this.selected)} title=${chat.title} draggable="true"
        @click=${open} @keydown=${onActivationKey(open)} @contextmenu=${move.contextmenu} @dragstart=${move.dragstart} @dragend=${move.dragend}
        @auxclick=${(event: MouseEvent) => { if (event.button === 1) this.close([chat.sessionId]); }}>
        ${questions === 0 ? renderChatStatusDot(status) : html`<span class="questions" role="img" aria-label=${`${String(questions)} open ${questions === 1 ? "question" : "questions"}`}>${String(questions)}</span>`}
        <span class="title">${chat.title}</span>
        <button class="close" title="Close" aria-label=${`Close ${chat.title}`} @click=${(event: Event) => { event.stopPropagation(); this.close([chat.sessionId]); }} @keydown=${(event: KeyboardEvent) => { event.stopPropagation(); }}>${renderBuiltinTabIcon("x")}</button>
      </div>`;
  }

  static override styles = [chatStatusDotStyles, css`
    /* Positioned above the stage, so the slotted Chat tools' drawer and popovers open over the Chat. */
    :host { position: relative; z-index: 6; display: block; flex: 0 0 auto; min-width: 0; background: var(--pi-surface); color: var(--pi-text); font: 13px system-ui, sans-serif; user-select: none; }
    button { font: inherit; color: inherit; cursor: pointer; }
    svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .bar { display: flex; align-items: center; gap: 12px; min-width: 0; height: 36px; box-sizing: border-box; padding: 0 8px 0 2px; }
    /*
     * Two rows, one language: quiet text tabs on the surface, the selected one in --pi-text with a 2px underline,
     * the Workstream colour (--ws) on top and neutral beneath so the two never compete. A tab sizes to its label
     * between 120px and 200px, ellipsizing the rest (the full title is its tooltip); a crowded row shrinks its tabs
     * to 120px, then scrolls while the tools beside it stay put. Selection changes only colour, at once: no fade, no
     * width change.
     */
    .tabs { flex: 1 1 auto; min-width: 0; align-self: stretch; display: flex; overflow-x: auto; scrollbar-width: none; }
    .workstream-tab, .chat-tab { position: relative; flex: 0 1 auto; min-width: 120px; max-width: 200px; overflow: hidden; display: flex; align-items: center; gap: 6px; box-sizing: border-box; color: var(--pi-muted); white-space: nowrap; cursor: pointer; }
    .workstream-tab::after, .chat-tab::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--ws, var(--pi-accent)); opacity: 0; }
    .workstream-tab:hover, .chat-tab:hover, [aria-selected="true"] { color: var(--pi-text); }
    .workstream-tab:hover::after { opacity: .35; }
    [aria-selected="true"]::after { opacity: 1; }
    .workstream-tab:focus-visible, .chat-tab:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: -4px; border-radius: 6px; }
    .tabs.workstreams { height: 34px; padding: 0 8px 0 2px; }
    .workstream-tab { padding: 0 10px; font-weight: 500; }
    .count { flex: 0 0 auto; color: var(--pi-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .tabs.chats { min-width: 120px; font-size: 12px; }
    .chat-tab { padding: 0 4px 0 10px; }
    .chat-tab::after { right: 4px; background: var(--pi-text); }
    .chat-tab:not([aria-selected="true"]):hover::after { opacity: .25; }
    .chat-tab[data-status="needs"] { color: var(--pi-text); }
    .questions { flex: 0 0 auto; min-width: 16px; height: 16px; box-sizing: border-box; padding: 0 4px; border-radius: 8px; background: var(--pi-warning); color: var(--pi-bg); font: 700 10px/16px system-ui, sans-serif; text-align: center; font-variant-numeric: tabular-nums; }
    .title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .close { flex: 0 0 auto; display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--pi-muted); }
    .close:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
    .add { display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px 0 8px; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); white-space: nowrap; }
    .add:hover, .add[aria-pressed="true"] { background: var(--pi-surface-hover); color: var(--pi-text); }
    .add:focus-visible, .segmented button:focus-visible, .pager button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .segmented { display: flex; gap: 2px; }
    .segmented button { height: 26px; padding: 0 8px; border: 0; border-radius: 6px; background: none; color: var(--pi-muted); }
    .segmented button:hover { color: var(--pi-text); }
    .segmented button[aria-pressed="true"] { background: var(--pi-surface-hover); color: var(--pi-text); }
    .lead { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 12px; padding-left: 10px; }
    .window-name { color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
    .pager { display: flex; align-items: center; gap: 4px; color: var(--pi-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .pager button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: none; }
    .pager button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    .pager button:disabled { opacity: .35; cursor: default; }
    .pager svg { width: 14px; height: 14px; }
  `];
}
