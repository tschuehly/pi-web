/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unnecessary-condition -- throwaway prototype */
// THROWAWAY layout prototype (`?layout=proto`), never merged. Each Chat is the real Workbench shell in an
// `?embed=1` frame, so transcript, composer and Files pane are the real ones; this file only arranges them.
import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { api } from "../api";
import { PluginRegistry } from "../plugins/registry";
import { themePackPlugin } from "../plugins/themes";
import { applyPresentationProfile, builtInPresentationProfile, readStoredPresentationProfile } from "../presentationProfiles";
import { sessionTitle } from "../sessionLabels";
import { applyPiWebTheme, readStoredThemePreference, resolveThemePreference } from "../theme";

/** One tab or tile. `id` is stable for the frame's lifetime; `group` undefined = not known yet, null = no Workstream. */
interface Entry { id: string; src: string; sessionId?: string | undefined; title: string; group?: string | null | undefined }
interface Win { name: string; entries: Entry[]; focused?: string | undefined; layout: "grid" | "tabs"; maximized?: string | undefined }
type Store = Record<string, Win>;
interface Live { streaming: boolean; needsOwner: boolean; unread: boolean }
interface ChatReport { type: "pi-proto-chat"; search: string; sessionId?: string; title: string; workstream?: string | null; streaming: boolean; needsOwner: boolean }

const STORE_KEY = "pi-workbench.layout-proto.v1";
const readStore = (): Store => { try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Store; } catch { return {}; } };
const uid = (): string => crypto.randomUUID().slice(0, 8);
const frameSrc = (search: string): string => {
  const params = new URLSearchParams(search);
  params.delete("layout"); params.delete("win"); params.set("embed", "1");
  return `/?${params.toString()}`;
};
const OTHER = "Other";
const SWIPE_END_MS = 150, SWIPE_COMMIT = 0.3, FLICK_PX_PER_MS = 0.8;

/** Whether a wheel starting at this event scrolls something horizontally (code block, table) instead of swiping. */
function canScrollX(event: WheelEvent): boolean {
  for (const node of event.composedPath()) {
    // Frame nodes come from another realm, so `instanceof` against this window's classes fails.
    if ((node as Partial<Node>).nodeType !== 1) continue;
    const element = node as HTMLElement;
    const view = element.ownerDocument.defaultView;
    if (view === null) continue;
    const overflow = view.getComputedStyle(element).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && element.scrollWidth > element.clientWidth + 1
      && (event.deltaX > 0 ? element.scrollLeft + element.clientWidth < element.scrollWidth - 1 : element.scrollLeft > 0)) return true;
  }
  return false;
}

@customElement("workbench-layout-proto")
export class WorkbenchLayoutProto extends LitElement {
  @state() private store: Store = readStore();
  @state() private winId = "";
  @state() private menu: { x: number; y: number; entryId: string } | undefined;
  @state() private live = new Map<string, Live>();
  @state() private alive = new Map<string, number>();
  private readonly channel = new BroadcastChannel("pi-workbench.layout-proto");
  private pingTimer: number | undefined;
  private swipe: { ids: string[]; k: number; acc: number; ignore: boolean; hist: { t: number; dx: number }[]; timer: number } | undefined;
  private readonly plugins = new PluginRegistry();

  private get win(): Win { return this.store[this.winId] ?? { name: "Window", entries: [], layout: "grid" }; }

  override connectedCallback(): void {
    super.connectedCallback();
    applyPresentationProfile(readStoredPresentationProfile() ?? builtInPresentationProfile("comfortable"));
    void this.plugins.register({ id: "themes", plugin: themePackPlugin }).then(() => {
      const theme = resolveThemePreference({ themes: this.plugins.getThemes(), themePairs: this.plugins.getThemePairs(), preference: readStoredThemePreference() ?? { themeId: "themes:github-dark", auto: true }, prefersLight: matchMedia("(prefers-color-scheme: light)").matches }).activeTheme;
      if (theme !== undefined) applyPiWebTheme(theme);
    });
    window.addEventListener("storage", this.onStorage);
    window.addEventListener("message", this.onMessage);
    window.addEventListener("keydown", this.onKey, { capture: true });
    window.addEventListener("wheel", this.onWheel, { passive: false, capture: true });
    window.addEventListener("pointerdown", this.closeMenu);
    window.addEventListener("pagehide", this.onPageHide);
    this.channel.onmessage = (event: MessageEvent<{ type: string; win: string }>) => {
      if (event.data.type === "bye") this.alive.delete(event.data.win);
      else this.alive.set(event.data.win, Date.now());
      if (event.data.type === "hello") this.channel.postMessage({ type: "ping", win: this.winId });
      this.alive = new Map(this.alive);
    };
    void this.boot();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("storage", this.onStorage);
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("keydown", this.onKey, { capture: true });
    window.removeEventListener("wheel", this.onWheel, { capture: true });
    window.removeEventListener("pointerdown", this.closeMenu);
    window.removeEventListener("pagehide", this.onPageHide);
    window.clearInterval(this.pingTimer);
    this.channel.close();
    super.disconnectedCallback();
  }

  /** Pick this window's working set: the URL's, else a stored one no live window holds, else a new one. */
  private async boot(): Promise<void> {
    const url = new URL(location.href);
    let id = url.searchParams.get("win") ?? undefined;
    if (id === undefined) {
      this.channel.postMessage({ type: "hello", win: "" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      id = Object.keys(this.store).find((candidate) => !this.alive.has(candidate)) ?? uid();
      url.searchParams.set("win", id);
      history.replaceState(null, "", url);
    }
    this.winId = id;
    this.channel.postMessage({ type: "ping", win: id });
    this.pingTimer = window.setInterval(() => { this.channel.postMessage({ type: "ping", win: id }); }, 3_000);
    if (this.store[id] === undefined) {
      const first = Object.keys(this.store).length === 0;
      this.mutate((store) => { store[id] = { name: this.nextWindowName(store), entries: [], layout: "grid" }; });
      if (first) await this.seed();
    }
  }

  private nextWindowName(store: Store): string {
    const used = new Set(Object.values(store).map((win) => win.name));
    let n = 1;
    while (used.has(`Window ${String(n)}`)) n += 1;
    return `Window ${String(n)}`;
  }

  /** First run: open the six most recent Chats so the prototype starts with real work. */
  private async seed(): Promise<void> {
    const rows = await api.recent(6).catch(() => []);
    this.mutate((store) => {
      const win = store[this.winId];
      if (win === undefined) return;
      win.entries = rows.map((row) => ({ id: uid(), src: frameSrc(`?session=${row.id}`), sessionId: row.id, title: sessionTitle(row) }));
      win.focused = win.entries[0]?.id;
    });
  }

  /** Read-modify-write the shared store; other windows see it through the `storage` event. */
  private mutate(change: (store: Store) => void): void {
    const store = readStore();
    change(store);
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    this.store = store;
  }

  private mutateWin(change: (win: Win) => void): void {
    this.mutate((store) => { const win = store[this.winId]; if (win !== undefined) change(win); });
  }

  private readonly onStorage = (event: StorageEvent): void => { if (event.key === STORE_KEY) this.store = readStore(); };
  private readonly onPageHide = (): void => { this.channel.postMessage({ type: "bye", win: this.winId }); };
  private readonly closeMenu = (event: Event): void => {
    if (this.menu !== undefined && !event.composedPath().some((node) => node instanceof HTMLElement && node.classList.contains("menu"))) this.menu = undefined;
  };

  /** Grouped by Workstream title in first-seen order, Chats without one last under "Other". */
  private groups(): { title: string; entries: Entry[] }[] {
    const groups = new Map<string, Entry[]>();
    for (const entry of this.win.entries) {
      const title = entry.group ?? OTHER;
      groups.set(title, [...groups.get(title) ?? [], entry]);
    }
    const other = groups.get(OTHER);
    groups.delete(OTHER);
    if (other !== undefined) groups.set(OTHER, other);
    return [...groups].map(([title, entries]) => ({ title, entries }));
  }

  private ordered(): Entry[] { return this.groups().flatMap((group) => group.entries); }

  private frame(id: string): HTMLIFrameElement | null { return this.renderRoot.querySelector<HTMLIFrameElement>(`.tile[data-id="${id}"] iframe`); }
  private tile(id: string): HTMLElement | null { return this.renderRoot.querySelector<HTMLElement>(`.tile[data-id="${id}"]`); }

  // ---------- focus, never stolen: only owner actions call these ----------
  private setFocused(id: string): void {
    if (this.live.get(id)?.unread === true) this.patchLive(id, { unread: false });
    if (this.win.focused === id) return;
    this.mutateWin((win) => { win.focused = id; if (win.maximized !== undefined) win.maximized = id; });
  }

  /** Focus a Chat and put the caret in its composer. */
  private activate(id: string): void {
    this.setFocused(id);
    void this.updateComplete.then(() => {
      const frame = this.frame(id);
      frame?.contentWindow?.focus();
      const shell = frame?.contentDocument?.querySelector("pi-workbench-app");
      const editor = shell?.shadowRoot?.querySelector("prompt-editor") as (Element & { focusInput?: () => void }) | null | undefined;
      editor?.focusInput?.();
    });
  }

  private toggleLayout(): void {
    this.mutateWin((win) => { win.layout = win.layout === "grid" ? "tabs" : "grid"; win.maximized = undefined; });
  }

  private toggleMaximized(id: string): void {
    this.mutateWin((win) => { win.focused = id; win.maximized = win.maximized === id ? undefined : id; });
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (!event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.toLowerCase() === "g") { event.preventDefault(); event.stopPropagation(); this.toggleLayout(); }
    else if (event.key === "Enter" && this.win.layout === "grid" && this.win.focused !== undefined) { event.preventDefault(); event.stopPropagation(); this.toggleMaximized(this.win.focused); }
  };

  /** Wire a frame's window so keys, swipes and clicks inside the Chat reach this host. */
  private wireFrame(id: string, frame: HTMLIFrameElement): void {
    const view = frame.contentWindow;
    if (view === null) return;
    view.addEventListener("keydown", this.onKey, { capture: true });
    view.addEventListener("wheel", this.onWheel, { passive: false, capture: true });
    view.addEventListener("pointerdown", () => { this.setFocused(id); this.menu = undefined; }, { capture: true });
    view.addEventListener("focusin", () => { this.setFocused(id); });
  }

  private readonly onMessage = (event: MessageEvent<ChatReport | { type: "pi-proto-open"; machineId: string; sessionId: string }>): void => {
    if (event.origin !== location.origin) return;
    const entry = this.win.entries.find((candidate) => this.frame(candidate.id)?.contentWindow === event.source);
    if (event.data.type === "pi-proto-open") { this.openFromNotification(event.data.sessionId); return; }
    if (event.data.type !== "pi-proto-chat" || entry === undefined) return;
    const report = event.data;
    const before = this.live.get(entry.id);
    this.patchLive(entry.id, { streaming: report.streaming, needsOwner: report.needsOwner, unread: (before?.unread ?? false) || (before?.streaming === true && !report.streaming && this.win.focused !== entry.id) });
    const src = frameSrc(report.search);
    const group = report.workstream === undefined ? entry.group : report.workstream;
    if (src === entry.src && report.sessionId === entry.sessionId && report.title === entry.title && group === entry.group) return;
    // A Chat lives in one window at a time: opening it here closes it everywhere else.
    this.mutate((store) => {
      for (const [winId, win] of Object.entries(store)) {
        if (winId !== this.winId && report.sessionId !== undefined) win.entries = win.entries.filter((candidate) => candidate.sessionId !== report.sessionId);
        for (const candidate of win.entries) {
          if (candidate.id !== entry.id) continue;
          Object.assign(candidate, { src, sessionId: report.sessionId, title: report.title, group });
        }
        if (winId === this.winId && report.sessionId !== undefined) win.entries = win.entries.filter((candidate) => candidate.id === entry.id || candidate.sessionId !== report.sessionId);
      }
    });
  };

  private patchLive(id: string, patch: Partial<Live>): void {
    const next = new Map(this.live);
    next.set(id, { streaming: false, needsOwner: false, unread: false, ...this.live.get(id), ...patch });
    this.live = next;
  }

  /** A notification click opens its Chat here: its tab if this window has one, else a new tab. */
  private openFromNotification(sessionId: string): void {
    window.focus();
    const existing = this.win.entries.find((entry) => entry.sessionId === sessionId);
    if (existing !== undefined) { this.activate(existing.id); return; }
    const entry: Entry = { id: uid(), src: frameSrc(`?session=${sessionId}`), sessionId, title: "Opening…" };
    this.mutateWin((win) => { win.entries.push(entry); win.focused = entry.id; });
  }

  private newTab(): void {
    const entry: Entry = { id: uid(), src: frameSrc(""), title: "New tab" };
    this.mutateWin((win) => { win.entries.push(entry); win.focused = entry.id; });
  }

  private closeTab(id: string): void {
    this.mutateWin((win) => {
      const order = this.ordered().map((entry) => entry.id);
      const index = order.indexOf(id);
      win.entries = win.entries.filter((entry) => entry.id !== id);
      if (win.focused === id) win.focused = order[index + 1] ?? order[index - 1];
      if (win.maximized === id) win.maximized = undefined;
    });
  }

  /** Move a Chat to `targetWin` (created when missing); its frame reloads there. */
  private moveTo(entryId: string, targetWin: string, fromWin = this.winId): void {
    this.mutate((store) => {
      const source = store[fromWin];
      const entry = source?.entries.find((candidate) => candidate.id === entryId);
      if (source === undefined || entry === undefined) return;
      source.entries = source.entries.filter((candidate) => candidate.id !== entryId);
      if (source.focused === entryId) source.focused = source.entries[0]?.id;
      if (source.maximized === entryId) source.maximized = undefined;
      const target = store[targetWin] ?? (store[targetWin] = { name: this.nextWindowName(store), entries: [], layout: source.layout });
      const moved = { ...entry, id: uid() };
      target.entries.push(moved);
      target.focused = moved.id;
    });
    this.menu = undefined;
  }

  private moveToNewWindow(entryId: string): void {
    const target = uid();
    this.moveTo(entryId, target);
    window.open(`/?layout=proto&win=${target}`, "_blank");
  }

  // ---------- trackpad swipe: tabs mode and a maximized tile ----------
  private swipeIds(): string[] | undefined {
    return this.win.layout === "tabs" || this.win.maximized !== undefined ? this.ordered().map((entry) => entry.id) : undefined;
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey) return; // pinch zoom
    if (this.swipe === undefined) {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const ids = this.swipeIds();
      if (ids === undefined || this.win.focused === undefined) return;
      this.swipe = { ids, k: ids.indexOf(this.win.focused), acc: 0, hist: [], ignore: canScrollX(event), timer: 0 };
    }
    const swipe = this.swipe;
    window.clearTimeout(swipe.timer);
    swipe.timer = window.setTimeout(() => { this.endSwipe(); }, SWIPE_END_MS);
    if (swipe.ignore) return;
    event.preventDefault();
    swipe.acc += event.deltaX;
    swipe.hist.push({ t: performance.now(), dx: event.deltaX });
    this.paintSwipe();
  };

  /** Current Chat follows the fingers; the neighbour slides in beside it. */
  private paintSwipe(): void {
    const swipe = this.swipe;
    if (swipe === undefined) return;
    const current = this.tile(swipe.ids[swipe.k] ?? "");
    if (current === null) return;
    const width = current.offsetWidth;
    const dir = Math.sign(swipe.acc);
    const neighbourId = swipe.ids[swipe.k + dir];
    const x = -swipe.acc * (neighbourId === undefined ? 0.25 : 1); // rubber band at the ends
    for (const id of swipe.ids) {
      const tile = this.tile(id);
      if (tile === null || tile === current) continue;
      const isNeighbour = id === neighbourId;
      tile.style.transition = "none";
      tile.style.visibility = isNeighbour ? "visible" : "";
      tile.style.transform = isNeighbour ? `translateX(${String(dir * width + x)}px)` : "";
    }
    current.style.transition = "none";
    current.style.transform = `translateX(${String(x)}px)`;
  }

  private endSwipe(): void {
    const swipe = this.swipe;
    this.swipe = undefined;
    if (swipe === undefined || swipe.ignore || swipe.hist.length === 0) return;
    const current = this.tile(swipe.ids[swipe.k] ?? "");
    const width = current?.offsetWidth ?? innerWidth;
    const last = swipe.hist[swipe.hist.length - 1]?.t ?? 0;
    const recent = swipe.hist.filter((sample) => last - sample.t <= 100);
    const velocity = recent.reduce((sum, sample) => sum + sample.dx, 0) / Math.max(16, last - (recent[0]?.t ?? last));
    const dir = Math.sign(swipe.acc);
    const target = swipe.ids[swipe.k + dir];
    const flick = Math.abs(velocity) > FLICK_PX_PER_MS && Math.sign(velocity) === dir && Math.abs(swipe.acc) > 20;
    const commit = dir !== 0 && target !== undefined && (Math.abs(swipe.acc) > SWIPE_COMMIT * width || flick);
    const neighbour = target === undefined ? null : this.tile(target);
    const ease = "transform .22s cubic-bezier(.2,.8,.2,1)";
    if (current !== null) { current.style.transition = ease; current.style.transform = commit ? `translateX(${String(-dir * width)}px)` : ""; }
    if (neighbour !== null) { neighbour.style.transition = ease; neighbour.style.transform = commit ? "translateX(0)" : `translateX(${String(dir * width)}px)`; }
    window.setTimeout(() => {
      for (const id of swipe.ids) {
        const tile = this.tile(id);
        if (tile !== null) { tile.style.transition = ""; tile.style.transform = ""; tile.style.visibility = ""; }
      }
      if (commit) this.activate(target);
    }, 230);
  }

  // ---------- drag a tab to another window, or out of this one ----------
  private dragStart(event: DragEvent, entry: Entry): void {
    event.dataTransfer?.setData("application/x-pi-proto-tab", JSON.stringify({ win: this.winId, id: entry.id }));
    event.dataTransfer?.setData("text/plain", entry.title);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
  }

  private dragEnd(event: DragEvent, entry: Entry): void {
    const outside = event.screenX < window.screenX || event.screenX > window.screenX + window.outerWidth
      || event.screenY < window.screenY || event.screenY > window.screenY + window.outerHeight;
    if (event.dataTransfer?.dropEffect === "none" && outside && this.win.entries.some((candidate) => candidate.id === entry.id)) this.moveToNewWindow(entry.id);
  }

  private drop(event: DragEvent): void {
    const raw = event.dataTransfer?.getData("application/x-pi-proto-tab");
    if (raw === undefined || raw === "") return;
    event.preventDefault();
    const { win, id } = JSON.parse(raw) as { win: string; id: string };
    if (win !== this.winId) this.moveTo(id, this.winId, win);
  }

  // ---------- rendering ----------
  private statusOf(entry: Entry): "running" | "needs" | "idle" {
    const live = this.live.get(entry.id);
    if (live?.needsOwner === true || live?.unread === true) return "needs";
    return live?.streaming === true ? "running" : "idle";
  }

  private badge(entry: Entry) {
    const live = this.live.get(entry.id);
    if (live?.needsOwner === true) return html`<span class="badge" title="Waiting for your answer">?</span>`;
    if (live?.unread === true) return html`<span class="badge" title="Finished while you were away">1</span>`;
    return nothing;
  }

  /** Grid cells for the visible page: 1 fills, 2 side by side, 3 = two over one, 4 = 2×2. */
  private placement(entry: Entry, ordered: Entry[]): { visible: boolean; area?: string } {
    const win = this.win;
    const focused = win.focused ?? ordered[0]?.id;
    if (win.layout === "tabs" || win.maximized !== undefined) return { visible: entry.id === (win.maximized ?? focused) };
    const page = Math.max(0, Math.floor(ordered.findIndex((candidate) => candidate.id === focused) / 4));
    const index = ordered.indexOf(entry) - page * 4;
    const count = Math.min(4, ordered.length - page * 4);
    if (index < 0 || index >= 4) return { visible: false };
    const row = index < 2 ? 1 : 2;
    const column = index % 2 + 1;
    const area = count === 1 ? "1 / 1 / 3 / 3"
      : count === 2 ? `1 / ${String(column)} / 3 / ${String(column + 1)}`
      : count === 3 && index === 2 ? "2 / 1 / 3 / 3"
      : `${String(row)} / ${String(column)} / ${String(row + 1)} / ${String(column + 1)}`;
    return { visible: true, area };
  }

  override render() {
    const win = this.win;
    const ordered = this.ordered();
    const pageIds = new Set(ordered.filter((entry) => this.placement(entry, ordered).visible).map((entry) => entry.id));
    const focused = this.win.entries.find((entry) => entry.id === win.focused);
    document.title = `${win.name}${focused === undefined ? "" : ` · ${focused.title}`}`;
    return html`
      <nav class="strip" role="tablist" aria-label=${`${win.name} Chats`} @dragover=${(event: DragEvent) => { if (event.dataTransfer?.types.includes("application/x-pi-proto-tab") === true) event.preventDefault(); }} @drop=${(event: DragEvent) => { this.drop(event); }}>
        <div class="tabs">
          ${this.groups().map((group) => html`
            <div class="group" role="group" aria-label=${group.title}>
              <span class="group-chip" title=${group.title}>${group.title}</span>
              ${group.entries.map((entry) => html`
                <button role="tab" class="tab" draggable="true" data-id=${entry.id} aria-selected=${entry.id === win.focused} data-onscreen=${pageIds.has(entry.id)} title=${entry.title}
                  @click=${() => { this.activate(entry.id); }}
                  @auxclick=${(event: MouseEvent) => { if (event.button === 1) this.closeTab(entry.id); }}
                  @contextmenu=${(event: MouseEvent) => { event.preventDefault(); this.menu = { x: event.clientX, y: event.clientY, entryId: entry.id }; }}
                  @dragstart=${(event: DragEvent) => { this.dragStart(event, entry); }}
                  @dragend=${(event: DragEvent) => { this.dragEnd(event, entry); }}>
                  <span class="dot" data-status=${this.statusOf(entry)}></span>
                  <span class="tab-title">${entry.title}</span>
                  ${this.badge(entry)}
                </button>`)}
            </div>`)}
          <button class="new-tab" title="New tab" aria-label="New tab" @click=${() => { this.newTab(); }}>+</button>
        </div>
        <div class="strip-actions">
          <div class="segmented" role="group" aria-label="Layout (⌃G)" title="Toggle layout (⌃G)">
            <button aria-pressed=${win.layout === "grid"} @click=${() => { if (win.layout !== "grid") this.toggleLayout(); }}>Grid</button>
            <button aria-pressed=${win.layout === "tabs"} @click=${() => { if (win.layout !== "tabs") this.toggleLayout(); }}>Tabs</button>
          </div>
          <span class="win-name" title="This window's working set">${win.name}</span>
        </div>
      </nav>
      <div class="stage" data-layout=${win.layout} data-maximized=${win.maximized !== undefined}>
        ${win.entries.length === 0 ? html`<div class="empty"><p>No Chats in ${win.name}.</p><button @click=${() => { this.newTab(); }}>Open a Chat</button></div>` : nothing}
        ${repeat(win.entries, (entry) => entry.id, (entry) => {
          const place = this.placement(entry, ordered);
          return html`
            <section class="tile" data-id=${entry.id} data-visible=${place.visible} data-focused=${entry.id === win.focused} style=${styleMap(place.area === undefined ? {} : { gridArea: place.area })}>
              <div class="tile-bar" @dblclick=${() => { this.toggleMaximized(entry.id); }} @click=${() => { this.activate(entry.id); }} @contextmenu=${(event: MouseEvent) => { event.preventDefault(); this.menu = { x: event.clientX, y: event.clientY, entryId: entry.id }; }}>
                <span class="dot" data-status=${this.statusOf(entry)}></span>
                <span class="group-chip small">${entry.group ?? OTHER}</span>
                <span class="tab-title">${entry.title}</span>
                ${this.badge(entry)}
                <button class="tile-max" title=${win.maximized === entry.id ? "Restore grid (⌃↩)" : "Full size (⌃↩)"} aria-label=${win.maximized === entry.id ? "Restore grid" : "Full size"} @click=${(event: Event) => { event.stopPropagation(); this.toggleMaximized(entry.id); }}>${win.maximized === entry.id ? "⤡" : "⤢"}</button>
              </div>
              <iframe title=${entry.title} src=${entry.src} @load=${(event: Event) => { this.wireFrame(entry.id, event.target as HTMLIFrameElement); }}></iframe>
            </section>`;
        })}
      </div>
      ${this.renderMenu()}
    `;
  }

  private renderMenu() {
    const menu = this.menu;
    if (menu === undefined) return nothing;
    const others = Object.entries(this.store).filter(([id]) => id !== this.winId);
    return html`
      <div class="menu" role="menu" style=${styleMap({ left: `${String(Math.min(menu.x, innerWidth - 240))}px`, top: `${String(menu.y)}px` })}>
        <button role="menuitem" @click=${() => { this.moveToNewWindow(menu.entryId); }}>Move to new window</button>
        <div class="menu-label">Move to window ▸</div>
        ${others.length === 0 ? html`<div class="menu-empty">No other windows</div>` : others.map(([id, other]) => html`
          <button role="menuitem" class="sub" @click=${() => { this.moveTo(menu.entryId, id); }}>${other.name}${this.alive.has(id) ? "" : " (closed)"} · ${String(other.entries.length)}</button>`)}
        <hr>
        <button role="menuitem" @click=${() => { this.toggleMaximized(menu.entryId); this.menu = undefined; }}>${this.win.maximized === menu.entryId ? "Restore grid" : "Full size"}</button>
        <button role="menuitem" @click=${() => { this.closeTab(menu.entryId); this.menu = undefined; }}>Close</button>
      </div>`;
  }

  static override styles = css`
    :host { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--pi-bg); color: var(--pi-text); font: 13px system-ui, sans-serif; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .strip { flex: 0 0 auto; display: flex; align-items: stretch; gap: 8px; min-width: 0; padding: 0 8px; border-bottom: 1px solid var(--pi-border); background: var(--pi-surface); }
    .tabs { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 10px; overflow-x: auto; scrollbar-width: none; }
    .group { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; padding: 3px 4px 3px 0; }
    .group + .group { padding-left: 10px; border-left: 1px solid var(--pi-border-muted); }
    .group-chip { flex: 0 1 auto; max-width: 220px; overflow: hidden; padding: 1px 7px; border: 1px solid var(--pi-border); border-radius: 999px; color: var(--pi-muted); font-size: 11px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
    .group-chip.small { max-width: 160px; font-size: 10.5px; padding: 0 6px; }
    .tab { flex: 0 0 auto; max-width: 220px; display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border: 1px solid transparent; border-radius: 7px; background: none; color: var(--pi-muted); }
    .tab:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .tab[data-onscreen="true"] { color: var(--pi-text); }
    .tab[aria-selected="true"] { border-color: var(--pi-border); background: var(--pi-bg); color: var(--pi-text); font-weight: 600; box-shadow: inset 0 -2px 0 var(--pi-accent); }
    .tab-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--pi-border); }
    .dot[data-status="running"] { background: var(--pi-accent); animation: pulse 1.2s ease-in-out infinite; }
    .dot[data-status="needs"] { background: var(--pi-warning, #d29922); }
    @keyframes pulse { 50% { opacity: .35; } }
    .badge { flex: 0 0 auto; min-width: 16px; height: 16px; box-sizing: border-box; padding: 0 4px; border-radius: 8px; background: var(--pi-warning, #d29922); color: var(--pi-bg); font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; }
    .new-tab { flex: 0 0 auto; width: 28px; height: 28px; border: 1px solid transparent; border-radius: 7px; background: none; color: var(--pi-muted); font-size: 16px; line-height: 1; }
    .new-tab:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    .strip-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; }
    .segmented { display: flex; border: 1px solid var(--pi-border); border-radius: 7px; overflow: hidden; }
    .segmented button { height: 26px; padding: 0 10px; border: 0; background: none; color: var(--pi-muted); }
    .segmented button + button { border-left: 1px solid var(--pi-border); }
    .segmented button[aria-pressed="true"] { background: var(--pi-selection-bg, var(--pi-surface-hover)); color: var(--pi-text); font-weight: 600; }
    .win-name { color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
    .stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; display: grid; grid-template: 1fr 1fr / 1fr 1fr; gap: 1px; background: var(--pi-border); }
    .stage[data-layout="tabs"], .stage[data-maximized="true"] { display: block; background: var(--pi-bg); }
    .tile { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--pi-bg); }
    .tile[data-visible="false"], .stage[data-layout="tabs"] .tile, .stage[data-maximized="true"] .tile { position: absolute; inset: 0; }
    .tile[data-visible="false"] { visibility: hidden; pointer-events: none; }
    .tile-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; min-width: 0; height: 24px; padding: 0 4px 0 8px; background: var(--pi-surface); border-bottom: 1px solid var(--pi-border-muted); color: var(--pi-muted); font-size: 12px; cursor: default; user-select: none; }
    .tile[data-focused="true"] .tile-bar { color: var(--pi-text); box-shadow: inset 0 2px 0 var(--pi-accent); }
    .stage[data-layout="tabs"] .tile-bar { display: none; }
    .tile-max { margin-left: auto; width: 22px; height: 20px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--pi-muted); font-size: 13px; }
    .tile-max:hover { background: var(--pi-surface-hover); color: var(--pi-text); }
    iframe { flex: 1 1 auto; min-height: 0; width: 100%; border: 0; display: block; background: var(--pi-bg); }
    .empty { grid-area: 1 / 1 / 3 / 3; display: grid; place-content: center; gap: 10px; background: var(--pi-bg); color: var(--pi-muted); }
    .empty button { padding: 6px 12px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); }
    .menu { position: fixed; z-index: 20; min-width: 220px; display: grid; padding: 4px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 10px 30px var(--pi-shadow); }
    .menu button { padding: 6px 10px; border: 0; border-radius: 5px; background: none; text-align: left; }
    .menu button:hover { background: var(--pi-surface-hover); }
    .menu .sub { padding-left: 22px; }
    .menu-label, .menu-empty { padding: 6px 10px 2px; color: var(--pi-muted); font-size: 12px; }
    .menu-empty { padding-left: 22px; font-style: italic; }
    .menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--pi-border-muted); }
  `;
}
