// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import { emptyWindow, focusChat, openChat, type WindowChat, type WindowStore, type WorkbenchWindow } from "../workbenchWindows";
import { chatTabStatus, endedOutside, WorkbenchWindowTabs, type ChatTabCloseDetail, type ChatTabSelectDetail } from "./WorkbenchWindowTabs";

afterEach(() => { document.body.replaceChildren(); });

const release = { id: "release", title: "Release" };
const chat = (sessionId: string, workstream?: { id: string; title: string }): WindowChat => ({ sessionId, title: `Chat ${sessionId}`, machineId: "local", workstream });

function workingSet(focused: string): WorkbenchWindow {
  const store = [chat("a1", release), chat("a2", release), chat("x")].reduce<WindowStore>((next, item) => openChat(next, "w", item), { w: emptyWindow("Window 1") });
  const window = focusChat(store, "w", focused)["w"];
  if (window === undefined) throw new Error("missing window");
  return window;
}

async function mount(selected: string | undefined, window = workingSet(selected ?? "a1")): Promise<{ tabs: WorkbenchWindowTabs; root: ShadowRoot; events: string[] }> {
  const tabs = new WorkbenchWindowTabs();
  tabs.workingSet = window;
  tabs.selected = selected;
  tabs.statuses = { a1: "running", a2: "needs" };
  const events: string[] = [];
  tabs.addEventListener("chat-tab-select", (event) => { if (isSelect(event)) events.push(`select ${event.detail.sessionId}`); });
  tabs.addEventListener("chat-tab-close", (event) => { if (isClose(event)) events.push(`close ${event.detail.sessionIds.join(",")}`); });
  tabs.addEventListener("window-home", () => { events.push("home"); });
  document.body.append(tabs);
  await tabs.updateComplete;
  if (tabs.shadowRoot === null) throw new Error("no shadow root");
  return { tabs, root: tabs.shadowRoot, events };
}

const isSelect = (event: Event): event is CustomEvent<ChatTabSelectDetail> => event instanceof CustomEvent && typeof Reflect.get(Object(event.detail), "sessionId") === "string";
const isClose = (event: Event): event is CustomEvent<ChatTabCloseDetail> => event instanceof CustomEvent && Array.isArray(Reflect.get(Object(event.detail), "sessionIds"));
const keydown = (element: Element | null | undefined, key: string) => element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

describe("window tabs", () => {
  it("shows Workstreams on top and the selected Workstream's Chats beneath, with status dots", async () => {
    const { root } = await mount("a2");

    expect([...root.querySelectorAll(".workstream-tab")].map((tab) => [tab.querySelector(".title")?.textContent, tab.getAttribute("aria-selected")])).toEqual([["Release", "true"], ["No Workstream", "false"]]);
    expect(root.querySelector(".workstream-tab .count")?.textContent).toBe("2");
    expect([...root.querySelectorAll(".chat-tab")].map((tab) => [tab.querySelector(".title")?.textContent, tab.getAttribute("aria-selected"), tab.querySelector(".dot")?.getAttribute("aria-label")]))
      .toEqual([["Chat a1", "false", "Working"], ["Chat a2", "true", "Needs you"]]);
  });

  it("opens with Enter or Space, reopening a Workstream's last-active Chat", async () => {
    const { root, events } = await mount("x", workingSet("a2"));

    keydown(root.querySelector(".workstream-tab"), "Enter");
    keydown(root.querySelectorAll(".chat-tab")[0], " ");
    keydown(root.querySelector(".chat-tab"), "a");

    expect(events).toEqual(["select a2", "select x"]);
  });

  it("closes from × or a middle click without selecting, and goes home from Add", async () => {
    const { root, events } = await mount("a1");

    root.querySelector<HTMLButtonElement>('button[aria-label="Close Chat a2"]')?.click();
    keydown(root.querySelector('button[aria-label="Close Chat a1"]'), "Enter");
    root.querySelectorAll(".chat-tab")[0]?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
    root.querySelector<HTMLButtonElement>("button.add")?.click();

    expect(events).toEqual(["close a2", "close a1", "home"]);
  });

  it("shows nothing for a window without Chats, and no selected tab while the home shows", async () => {
    expect((await mount(undefined, emptyWindow("Window 1"))).root.querySelector("nav")).toBeNull();
    const { root } = await mount(undefined, workingSet("a1"));
    expect(root.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
    expect(root.querySelector("button.add")?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("moving Chats", () => {
  class FakeTransfer {
    readonly data = new Map<string, string>();
    effectAllowed = "";
    dropEffect = "none";
    get types(): string[] { return [...this.data.keys()]; }
    setData(type: string, value: string): void { this.data.set(type, value); }
    getData(type: string): string { return this.data.get(type) ?? ""; }
  }
  const drag = (type: string, transfer: FakeTransfer, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    return event;
  };
  const details: unknown[] = [];
  const record = (tabs: WorkbenchWindowTabs) => {
    for (const type of ["chat-tab-menu", "chat-tab-drop", "chat-tab-drag-out"]) tabs.addEventListener(type, (event) => { if (event instanceof CustomEvent) details.push([type, event.detail]); });
  };
  afterEach(() => { details.length = 0; });

  it("opens a move menu for a Chat or a whole Workstream", async () => {
    const { tabs, root } = await mount("a1");
    record(tabs);

    root.querySelector(".chat-tab")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
    root.querySelector(".workstream-tab")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 5 }));

    expect(details).toEqual([
      ["chat-tab-menu", { sessionIds: ["a1"], label: "Chat a1", clientX: 40, clientY: 50 }],
      ["chat-tab-menu", { sessionIds: ["a1", "a2"], label: "Release", clientX: 10, clientY: 5 }],
    ]);
  });

  it("hands Chats dropped from another window to the shell, and ignores its own", async () => {
    const source = await mount("a1");
    source.tabs.windowId = "w1";
    const transfer = new FakeTransfer();
    source.root.querySelector(".workstream-tab")?.dispatchEvent(drag("dragstart", transfer));
    expect(transfer.types).toEqual(["application/x-pi-workbench-chats", "text/plain"]);

    const target = await mount("x");
    target.tabs.windowId = "w2";
    record(target.tabs);
    record(source.tabs);
    const over = drag("dragover", transfer);
    target.root.querySelector("nav")?.dispatchEvent(over);
    target.root.querySelector("nav")?.dispatchEvent(drag("drop", transfer));
    source.root.querySelector("nav")?.dispatchEvent(drag("drop", transfer));

    expect(over.defaultPrevented).toBe(true);
    expect(details).toEqual([["chat-tab-drop", { windowId: "w1", sessionIds: ["a1", "a2"] }]]);
  });

  it("opens a new window for a tab dropped outside every window", async () => {
    const { tabs, root } = await mount("a1");
    tabs.windowId = "w1";
    record(tabs);
    const transfer = new FakeTransfer();
    root.querySelector(".chat-tab")?.dispatchEvent(drag("dragend", transfer, { screenX: 5000, screenY: 10 }));
    transfer.dropEffect = "move";
    root.querySelector(".chat-tab")?.dispatchEvent(drag("dragend", transfer, { screenX: 5000, screenY: 10 }));

    expect(details).toEqual([["chat-tab-drag-out", { windowId: "w1", sessionIds: ["a1"] }]]);
    const frame = { screenX: 100, screenY: 50, outerWidth: 800, outerHeight: 600 };
    expect([endedOutside({ screenX: 500, screenY: 300 }, frame), endedOutside({ screenX: 99, screenY: 300 }, frame), endedOutside({ screenX: 500, screenY: 651 }, frame)]).toEqual([false, true, true]);
  });
});

describe("grid bar", () => {
  it("shows the window name and pages of four instead of the tiers, and switches layout", async () => {
    const base = workingSet("x");
    const extra = ["b", "c"].map((id) => chat(id));
    const grid: WorkbenchWindow = { ...base, layout: "grid", chats: [...base.chats, ...extra], focused: "c" };
    const { root, events } = await mount("c", grid);
    const layoutEvents: string[] = [];
    root.host.addEventListener("window-layout", (event) => { if (event instanceof CustomEvent) layoutEvents.push(String(Reflect.get(Object(event.detail), "layout"))); });

    expect(root.querySelector(".workstream-tab")).toBeNull();
    expect(root.querySelector(".tabs.chats")).toBeNull();
    expect(root.querySelector(".window-name")?.textContent).toBe("Window 1");
    expect(root.querySelector(".pager span")?.textContent).toBe("2 / 2");
    root.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]')?.click();
    expect(events).toEqual(["select a1"]);
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')?.disabled).toBe(true);

    const [gridButton, tabsButton] = [...root.querySelectorAll<HTMLButtonElement>(".segmented button")];
    expect(gridButton?.getAttribute("aria-pressed")).toBe("true");
    gridButton?.click();
    tabsButton?.click();
    expect(layoutEvents).toEqual(["tabs"]);
  });
});

describe("chat tab status", () => {
  const status = (patch: Partial<SessionStatus>): SessionStatus => ({ sessionId: "s", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, ...patch });

  it("ranks needs you over working over done over idle", () => {
    const ask = { askId: "q", askedAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z", revision: "r1", turnsSinceUpdate: 0, context: "Why", questions: [] };
    expect(chatTabStatus(status({ isStreaming: true, pendingAsks: [ask] }), true)).toBe("needs");
    expect(chatTabStatus(status({ isStreaming: true }), true)).toBe("running");
    expect(chatTabStatus(status({}), true)).toBe("done");
    expect(chatTabStatus(undefined, false)).toBe("idle");
  });
});
