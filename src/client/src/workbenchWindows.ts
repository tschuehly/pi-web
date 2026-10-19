/**
 * Per-window working sets of the Workbench shell. Every native window (or browser tab) owns one set of open Chats,
 * keyed by its `?win=<id>` URL parameter; all windows share one store in localStorage. A Chat is open in at most one
 * window. These functions are pure: each returns a new store and leaves its input untouched.
 */

export interface WindowWorkstream {
  id: string;
  title: string;
}

export interface WindowChat {
  sessionId: string;
  startupToken?: string | undefined;
  title: string;
  machineId: string;
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  workstream?: WindowWorkstream | undefined;
}

export type WindowLayout = "tabs" | "grid";

export interface WorkbenchWindow {
  name: string;
  chats: WindowChat[];
  /** The Chat this window shows, or last showed before going home. */
  focused?: string | undefined;
  layout: WindowLayout;
  /** Grid only: the focused Chat fills the window. */
  maximized: boolean;
  /** Workstream key (see {@link workstreamKey}) → its last-active Chat, so selecting a Workstream reopens it. */
  lastActive: Record<string, string>;
}

export type WindowStore = Record<string, WorkbenchWindow>;

/** A grid cell as `row-start / column-start / row-end / column-end`. */
export interface GridTile {
  chat: WindowChat;
  area: string;
}

export interface ChatGroup {
  key: string;
  workstream: WindowWorkstream | undefined;
  chats: WindowChat[];
}

export const GRID_PAGE_SIZE = 4;

/** The group of Chats without a Workstream. */
export const NO_WORKSTREAM_KEY = "";

export const workstreamKey = (chat: WindowChat): string => chat.workstream?.id ?? NO_WORKSTREAM_KEY;

export function emptyWindow(name: string, layout: WindowLayout = "tabs"): WorkbenchWindow {
  return { name, chats: [], layout, maximized: false, lastActive: {} };
}

export function nextWindowName(store: WindowStore): string {
  const used = new Set(Object.values(store).map((window) => window.name));
  let index = 1;
  while (used.has(`Window ${String(index)}`)) index += 1;
  return `Window ${String(index)}`;
}

export function ensureWindow(store: WindowStore, windowId: string): WindowStore {
  return store[windowId] === undefined ? { ...store, [windowId]: emptyWindow(nextWindowName(store)) } : store;
}

/** Chats grouped by Workstream in first-seen order; the group without a Workstream comes last. */
export function windowGroups(window: WorkbenchWindow): ChatGroup[] {
  const groups = new Map<string, ChatGroup>();
  for (const chat of window.chats) {
    const key = workstreamKey(chat);
    const group = groups.get(key) ?? { key, workstream: chat.workstream, chats: [] };
    group.chats.push(chat);
    groups.set(key, group);
  }
  const loose = groups.get(NO_WORKSTREAM_KEY);
  groups.delete(NO_WORKSTREAM_KEY);
  return loose === undefined ? [...groups.values()] : [...groups.values(), loose];
}

/** Tab order: Chats of the first Workstream, then the next, then Chats without one. */
export function orderedChats(window: WorkbenchWindow): WindowChat[] {
  return windowGroups(window).flatMap((group) => group.chats);
}

/** The Chat a Workstream tab opens: its last-active Chat while still open here, else its first. */
export function workstreamTabTarget(window: WorkbenchWindow, key: string): string | undefined {
  const group = windowGroups(window).find((candidate) => candidate.key === key);
  const recent = window.lastActive[key];
  return group?.chats.some((chat) => chat.sessionId === recent) === true ? recent : group?.chats[0]?.sessionId;
}

/** Shows `chat` in `windowId`, adding it when new and taking it out of every other window. */
export function openChat(store: WindowStore, windowId: string, chat: WindowChat): WindowStore {
  const next = withoutChats(ensureWindow(store, windowId), [chat.sessionId], windowId);
  const window = cloneWindow(next[windowId] ?? emptyWindow(nextWindowName(next)));
  const index = window.chats.findIndex((candidate) => candidate.sessionId === chat.sessionId);
  if (index === -1) window.chats.push(chat);
  else window.chats[index] = { ...chat, workstream: chat.workstream ?? window.chats[index]?.workstream };
  return { ...next, [windowId]: focus(window, chat.sessionId) };
}

export function focusChat(store: WindowStore, windowId: string, sessionId: string): WindowStore {
  const window = store[windowId];
  if (window?.chats.some((chat) => chat.sessionId === sessionId) !== true) return store;
  if (window.focused === sessionId && window.lastActive[lastActiveKey(window, sessionId)] === sessionId) return store;
  return { ...store, [windowId]: focus(cloneWindow(window), sessionId) };
}

/** Title or Workstream of an open Chat; the same store when nothing changes. */
export function updateChat(store: WindowStore, windowId: string, sessionId: string, patch: Partial<Pick<WindowChat, "title" | "workstream">>): WindowStore {
  const window = store[windowId];
  const index = window?.chats.findIndex((chat) => chat.sessionId === sessionId) ?? -1;
  const current = window?.chats[index];
  if (window === undefined || current === undefined) return store;
  const updated: WindowChat = { ...current, ...patch };
  if (updated.title === current.title && updated.workstream?.id === current.workstream?.id && updated.workstream?.title === current.workstream?.title) return store;
  const next = cloneWindow(window);
  next.chats[index] = updated;
  return { ...store, [windowId]: window.focused === sessionId ? focus(next, sessionId) : next };
}

/** Closes Chats; focus moves to the next open Chat in tab order, else the previous one. */
export function closeChats(store: WindowStore, windowId: string, sessionIds: readonly string[]): WindowStore {
  const window = store[windowId];
  if (window === undefined) return store;
  const closing = new Set(sessionIds);
  const order = orderedChats(window).map((chat) => chat.sessionId);
  const next = cloneWindow(window);
  next.chats = next.chats.filter((chat) => !closing.has(chat.sessionId));
  if (window.focused === undefined || !closing.has(window.focused)) return { ...store, [windowId]: next };
  const index = order.indexOf(window.focused);
  const successor = order.slice(index + 1).find((id) => !closing.has(id)) ?? order.slice(0, index).reverse().find((id) => !closing.has(id));
  next.focused = undefined;
  if (next.chats.length === 0) next.maximized = false;
  return { ...store, [windowId]: successor === undefined ? next : focus(next, successor) };
}

/** Moves Chats to `targetId`, creating that window when missing; the first moved Chat becomes its focus. */
export function moveChats(store: WindowStore, sourceId: string, targetId: string, sessionIds: readonly string[]): WindowStore {
  const source = store[sourceId];
  if (source === undefined || sourceId === targetId) return store;
  const moving = source.chats.filter((chat) => sessionIds.includes(chat.sessionId));
  const first = moving[0];
  if (first === undefined) return store;
  const closed = closeChats(store, sourceId, sessionIds);
  const target = cloneWindow(closed[targetId] ?? emptyWindow(nextWindowName(closed), source.layout));
  target.chats.push(...moving.filter((chat) => !target.chats.some((candidate) => candidate.sessionId === chat.sessionId)));
  return { ...closed, [targetId]: focus(target, first.sessionId) };
}

export function toggleLayout(store: WindowStore, windowId: string): WindowStore {
  const window = store[windowId];
  return window === undefined ? store : { ...store, [windowId]: { ...cloneWindow(window), layout: window.layout === "grid" ? "tabs" : "grid", maximized: false } };
}

export function toggleMaximized(store: WindowStore, windowId: string): WindowStore {
  const window = store[windowId];
  return window?.layout !== "grid" || window.focused === undefined ? store : { ...store, [windowId]: { ...cloneWindow(window), maximized: !window.maximized } };
}

/** The grid page holding the focused Chat. */
export function gridPage(window: WorkbenchWindow): number {
  return Math.max(0, Math.floor(orderedChats(window).findIndex((chat) => chat.sessionId === window.focused) / GRID_PAGE_SIZE));
}

export function gridPageCount(window: WorkbenchWindow): number {
  return Math.ceil(window.chats.length / GRID_PAGE_SIZE);
}

/** The first Chat of grid page `page`, to focus when paging. */
export function gridPageLead(window: WorkbenchWindow, page: number): string | undefined {
  return orderedChats(window)[page * GRID_PAGE_SIZE]?.sessionId;
}

/** The focused Chat's grid page: one Chat fills it, two sit side by side, three are two over one, four are 2×2. */
export function gridTiles(window: WorkbenchWindow): GridTile[] {
  const page = gridPage(window);
  const chats = orderedChats(window).slice(page * GRID_PAGE_SIZE, (page + 1) * GRID_PAGE_SIZE);
  return chats.map((chat, index) => {
    const row = index < 2 ? 1 : 2;
    const column = (index % 2) + 1;
    const area = chats.length === 1 ? "1 / 1 / 3 / 3"
      : chats.length === 2 ? `1 / ${String(column)} / 3 / ${String(column + 1)}`
      : chats.length === 3 && index === 2 ? "2 / 1 / 3 / 3"
      : `${String(row)} / ${String(column)} / ${String(row + 1)} / ${String(column + 1)}`;
    return { chat, area };
  });
}

/** The stored windows, dropping anything that does not have the window shape. */
export function parseWindowStore(raw: string | null): WindowStore {
  let parsed: unknown;
  try { parsed = raw === null ? {} : JSON.parse(raw); } catch { return {}; }
  if (!isRecord(parsed)) return {};
  const store: WindowStore = {};
  for (const [id, value] of Object.entries(parsed)) {
    const window = parseWindow(value);
    if (window !== undefined) store[id] = window;
  }
  return store;
}

function parseWindow(value: unknown): WorkbenchWindow | undefined {
  if (!isRecord(value) || typeof value["name"] !== "string" || !Array.isArray(value["chats"])) return undefined;
  const chats = value["chats"].flatMap((chat) => { const parsed = parseChat(chat); return parsed === undefined ? [] : [parsed]; });
  const lastActive: Record<string, string> = {};
  const recent = value["lastActive"];
  if (isRecord(recent)) for (const [key, id] of Object.entries(recent)) if (typeof id === "string") lastActive[key] = id;
  const focused = value["focused"];
  return {
    name: value["name"],
    chats,
    focused: typeof focused === "string" && chats.some((chat) => chat.sessionId === focused) ? focused : undefined,
    layout: value["layout"] === "grid" ? "grid" : "tabs",
    maximized: value["maximized"] === true,
    lastActive,
  };
}

function parseChat(value: unknown): WindowChat | undefined {
  if (!isRecord(value) || typeof value["sessionId"] !== "string" || typeof value["title"] !== "string" || typeof value["machineId"] !== "string") return undefined;
  const workstream = value["workstream"];
  return {
    sessionId: value["sessionId"],
    startupToken: optionalString(value["startupToken"]),
    title: value["title"],
    machineId: value["machineId"],
    projectId: optionalString(value["projectId"]),
    workspaceId: optionalString(value["workspaceId"]),
    workstream: isRecord(workstream) && typeof workstream["id"] === "string" && typeof workstream["title"] === "string" ? { id: workstream["id"], title: workstream["title"] } : undefined,
  };
}

function withoutChats(store: WindowStore, sessionIds: readonly string[], keepWindowId: string): WindowStore {
  let next = store;
  for (const [id, window] of Object.entries(store)) {
    if (id !== keepWindowId && window.chats.some((chat) => sessionIds.includes(chat.sessionId))) next = closeChats(next, id, sessionIds);
  }
  return next;
}

function focus(window: WorkbenchWindow, sessionId: string): WorkbenchWindow {
  return { ...window, focused: sessionId, lastActive: { ...window.lastActive, [lastActiveKey(window, sessionId)]: sessionId } };
}

function lastActiveKey(window: WorkbenchWindow, sessionId: string): string {
  const chat = window.chats.find((candidate) => candidate.sessionId === sessionId);
  return chat === undefined ? NO_WORKSTREAM_KEY : workstreamKey(chat);
}

function cloneWindow(window: WorkbenchWindow): WorkbenchWindow {
  return { ...window, chats: [...window.chats], lastActive: { ...window.lastActive } };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
