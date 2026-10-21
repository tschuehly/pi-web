import { describe, expect, it } from "vitest";
import { clampGridRatio, closeChats, emptyWindow, focusChat, moveChats, gridPage, gridRatio, gridRatioFromDrag, gridRatioFromKeyboard, resizeGrid, gridPageCount, gridPageLead, gridTiles, openChat, orderedChats, parseWindowStore, toggleLayout, toggleMaximized, updateChat, windowGroups, workstreamTabTarget, type WindowChat, type WindowStore } from "./workbenchWindows";

const release = { id: "ws-release", title: "Release" };
const docs = { id: "ws-docs", title: "Docs" };
const chat = (sessionId: string, workstream?: { id: string; title: string }): WindowChat => ({ sessionId, title: `Chat ${sessionId}`, machineId: "local", workstream });
const ids = (chats: readonly WindowChat[]) => chats.map((candidate) => candidate.sessionId);

function windowWith(...chats: WindowChat[]): WindowStore {
  return chats.reduce<WindowStore>((store, next) => openChat(store, "w1", next), { w1: emptyWindow("Window 1") });
}

describe("window groups", () => {
  it("groups Chats by Workstream in first-seen order with Chats without one last", () => {
    const store = windowWith(chat("loose"), chat("a1", release), chat("b1", docs), chat("a2", release));
    const window = store["w1"];
    if (window === undefined) throw new Error("missing window");

    expect(windowGroups(window).map((group) => [group.workstream?.title, ids(group.chats)])).toEqual([
      ["Release", ["a1", "a2"]],
      ["Docs", ["b1"]],
      [undefined, ["loose"]],
    ]);
    expect(ids(orderedChats(window))).toEqual(["a1", "a2", "b1", "loose"]);
  });
});

describe("last-active Chat per Workstream", () => {
  it("reopens the Chat last shown in a Workstream, else its first", () => {
    let store = windowWith(chat("a1", release), chat("a2", release), chat("b1", docs));
    store = focusChat(store, "w1", "a2");
    store = focusChat(store, "w1", "b1");
    const window = store["w1"];
    if (window === undefined) throw new Error("missing window");

    expect(workstreamTabTarget(window, release.id)).toBe("a2");
    expect(workstreamTabTarget(window, docs.id)).toBe("b1");
    const closed = closeChats(store, "w1", ["a2"])["w1"];
    if (closed === undefined) throw new Error("missing window");
    expect(workstreamTabTarget(closed, release.id)).toBe("a1");
  });

  it("files the focused Chat under its Workstream once the Workstream is known", () => {
    let store = windowWith(chat("a1", release), chat("x"));
    store = updateChat(store, "w1", "x", { workstream: release });
    store = focusChat(store, "w1", "a1");

    expect(store["w1"] === undefined ? undefined : workstreamTabTarget(store["w1"], release.id)).toBe("a1");
    store = focusChat(store, "w1", "x");
    expect(store["w1"] === undefined ? undefined : workstreamTabTarget(store["w1"], release.id)).toBe("x");
  });
});

describe("opening and closing Chats", () => {
  it("keeps a Chat in one window: opening it here takes it out of the other", () => {
    const store = openChat({ w1: emptyWindow("Window 1"), w2: { ...emptyWindow("Window 2"), chats: [chat("a"), chat("b")], focused: "a" } }, "w1", chat("a"));

    expect(ids(store["w1"]?.chats ?? [])).toEqual(["a"]);
    expect(store["w1"]?.focused).toBe("a");
    expect(ids(store["w2"]?.chats ?? [])).toEqual(["b"]);
    expect(store["w2"]?.focused).toBe("b");
  });

  it("keeps a known Workstream when a Chat is opened again", () => {
    const store = openChat(windowWith(chat("a", release)), "w1", { ...chat("a"), title: "Renamed" });

    expect(store["w1"]?.chats).toEqual([{ ...chat("a", release), title: "Renamed" }]);
  });

  it("moves focus to the next tab when the focused one closes, else the previous, else none", () => {
    const store = focusChat(windowWith(chat("a"), chat("b"), chat("c")), "w1", "b");

    expect(closeChats(store, "w1", ["b"])["w1"]?.focused).toBe("c");
    expect(closeChats(store, "w1", ["b", "c"])["w1"]?.focused).toBe("a");
    expect(closeChats(store, "w1", ["a", "b", "c"])["w1"]?.focused).toBeUndefined();
    expect(closeChats(store, "w1", ["a"])["w1"]?.focused).toBe("b");
  });

  it("returns the same store when an update changes nothing", () => {
    const store = windowWith(chat("a", release));

    expect(updateChat(store, "w1", "a", { title: "Chat a", workstream: { ...release } })).toBe(store);
    expect(updateChat(store, "w1", "missing", { title: "x" })).toBe(store);
    expect(focusChat(store, "w1", "a")).toBe(store);
  });
});

describe("moving Chats between windows", () => {
  it("moves Chats with their Workstream into another window, which then shows the first", () => {
    const store = focusChat({ ...windowWith(chat("a1", release), chat("a2", release), chat("b")), w2: { ...emptyWindow("Window 2"), chats: [chat("z")], focused: "z" } }, "w1", "a2");
    const moved = moveChats(store, "w1", "w2", ["a1", "a2"]);

    expect(ids(moved["w1"]?.chats ?? [])).toEqual(["b"]);
    expect(moved["w1"]?.focused).toBe("b");
    expect(moved["w2"]?.chats).toEqual([chat("z"), chat("a1", release), chat("a2", release)]);
    expect(moved["w2"]?.focused).toBe("a1");
    expect(moved["w2"] === undefined ? undefined : workstreamTabTarget(moved["w2"], release.id)).toBe("a1");
  });

  it("creates a missing target window with the next free name and the source's layout", () => {
    const moved = moveChats(toggleLayout(windowWith(chat("a"), chat("b")), "w1"), "w1", "new", ["b"]);

    expect(moved["new"]).toMatchObject({ name: "Window 2", layout: "grid", focused: "b" });
    expect(ids(moved["new"]?.chats ?? [])).toEqual(["b"]);
  });

  it("leaves the store alone for a move to the same window or of Chats it does not hold", () => {
    const store = windowWith(chat("a"));

    expect(moveChats(store, "w1", "w1", ["a"])).toBe(store);
    expect(moveChats(store, "w1", "w2", ["missing"])).toBe(store);
    expect(moveChats(store, "nowhere", "w2", ["a"])).toBe(store);
  });
});

describe("grid", () => {
  const areas = (store: WindowStore) => store["w1"] === undefined ? [] : gridTiles(store["w1"]).map((tile) => [tile.chat.sessionId, tile.area]);

  it("lays out one to four tiles: full, side by side, two over one, 2×2", () => {
    expect(areas(windowWith(chat("a")))).toEqual([["a", "1 / 1 / 3 / 3"]]);
    expect(areas(windowWith(chat("a"), chat("b")))).toEqual([["a", "1 / 1 / 3 / 2"], ["b", "1 / 2 / 3 / 3"]]);
    expect(areas(windowWith(chat("a"), chat("b"), chat("c")))).toEqual([["a", "1 / 1 / 2 / 2"], ["b", "1 / 2 / 2 / 3"], ["c", "2 / 1 / 3 / 3"]]);
    expect(areas(windowWith(chat("a"), chat("b"), chat("c"), chat("d")))).toEqual([["a", "1 / 1 / 2 / 2"], ["b", "1 / 2 / 2 / 3"], ["c", "2 / 1 / 3 / 2"], ["d", "2 / 2 / 3 / 3"]]);
  });

  it("pages by four, showing the focused Chat's page", () => {
    const store = windowWith(chat("a"), chat("b"), chat("c"), chat("d"), chat("e"));
    const window = store["w1"];
    if (window === undefined) throw new Error("missing window");

    expect([gridPage(window), gridPageCount(window), gridPageLead(window, 0)]).toEqual([1, 2, "a"]);
    expect(areas(store)).toEqual([["e", "1 / 1 / 3 / 3"]]);
    expect(areas(focusChat(store, "w1", "b")).map(([id]) => id)).toEqual(["a", "b", "c", "d"]);
  });

  it("switches layouts, leaving full size behind, and toggles full size only in a grid", () => {
    const tabs = windowWith(chat("a"), chat("b"));

    expect(toggleMaximized(tabs, "w1")).toBe(tabs);
    const grid = toggleLayout(tabs, "w1");
    expect(grid["w1"]?.layout).toBe("grid");
    const maximized = toggleMaximized(grid, "w1");
    expect(maximized["w1"]?.maximized).toBe(true);
    expect(toggleLayout(maximized, "w1")["w1"]).toMatchObject({ layout: "tabs", maximized: false });
    expect(toggleMaximized(maximized, "w1")["w1"]?.maximized).toBe(false);
  });
});

describe("resizable grid", () => {
  const four = () => windowWith(chat("a"), chat("b"), chat("c"), chat("d"));
  const ratios = (store: WindowStore) => { const window = store["w1"]; return window === undefined ? [] : [gridRatio(window, "columns"), gridRatio(window, "rows")]; };

  it("splits evenly until a divider is dragged, then keeps its share on every page and focus; double-click evens it again", () => {
    const store = resizeGrid(resizeGrid(windowWith(chat("a"), chat("b"), chat("c"), chat("d"), chat("e")), "w1", "columns", 0.33333), "w1", "rows", 0.7);

    expect(ratios(windowWith(chat("a"), chat("b")))).toEqual([0.5, 0.5]);
    expect(ratios(store)).toEqual([0.3333, 0.7]);
    expect(ratios(focusChat(store, "w1", "a"))).toEqual([0.3333, 0.7]);
    expect(resizeGrid(store, "w1", "rows", 0.7)).toBe(store);
    expect(ratios(resizeGrid(store, "w1", "columns", undefined))).toEqual([0.5, 0.7]);
    expect(resizeGrid(resizeGrid(store, "w1", "columns", undefined), "w1", "rows", undefined)["w1"]).not.toHaveProperty("gridSplit");
  });

  it("keeps a share while its divider still exists and evens it once fewer Chats remove it", () => {
    const store = resizeGrid(resizeGrid(four(), "w1", "columns", 0.3), "w1", "rows", 0.6);

    expect(ratios(closeChats(store, "w1", ["d"]))).toEqual([0.3, 0.6]);
    expect(ratios(closeChats(store, "w1", ["c", "d"]))).toEqual([0.3, 0.5]);
    expect(ratios(openChat(closeChats(store, "w1", ["c", "d"]), "w1", chat("c")))).toEqual([0.3, 0.5]);
    expect(closeChats(store, "w1", ["b", "c", "d"])["w1"]).not.toHaveProperty("gridSplit");
    expect(ratios(moveChats(store, "w1", "w2", ["c", "d"]))).toEqual([0.3, 0.5]);
  });

  it("drags by the pointer's share of the Grid, never leaving a tile below its minimum", () => {
    expect(gridRatioFromDrag(0.5, 400, 500, 1000, 320)).toBeCloseTo(0.6);
    expect(gridRatioFromDrag(0.5, 400, 0, 1000, 320)).toBeCloseTo(0.32);
    expect(gridRatioFromDrag(0.5, 400, 2000, 1000, 320)).toBeCloseTo(0.68);
    expect(clampGridRatio(0.9, 500, 320)).toBeCloseTo(0.5);
    expect(clampGridRatio(0.9, 0, 320)).toBeCloseTo(0.9);
  });

  it("steps with the arrows along its axis, further with Shift, and jumps to the bounds with Home and End", () => {
    expect(gridRatioFromKeyboard(0.5, "columns", "ArrowRight", false, 1000, 320)).toBeCloseTo(0.52);
    expect(gridRatioFromKeyboard(0.5, "columns", "ArrowLeft", true, 1000, 320)).toBeCloseTo(0.4);
    expect(gridRatioFromKeyboard(0.5, "columns", "ArrowUp", false, 1000, 320)).toBeUndefined();
    expect(gridRatioFromKeyboard(0.5, "rows", "ArrowUp", false, 1000, 220)).toBeCloseTo(0.48);
    expect(gridRatioFromKeyboard(0.5, "rows", "ArrowDown", true, 1000, 220)).toBeCloseTo(0.6);
    expect(gridRatioFromKeyboard(0.3, "rows", "ArrowUp", true, 1000, 220)).toBeCloseTo(0.22);
    expect(gridRatioFromKeyboard(0.5, "columns", "Home", false, 1000, 320)).toBeCloseTo(0.32);
    expect(gridRatioFromKeyboard(0.5, "columns", "End", false, 1000, 320)).toBeCloseTo(0.68);
    expect(gridRatioFromKeyboard(0.5, "columns", "Enter", false, 1000, 320)).toBeUndefined();
  });

  it("survives a reload and drops shares that are no fraction", () => {
    const store = resizeGrid(resizeGrid(four(), "w1", "columns", 0.25), "w1", "rows", 0.75);

    expect(parseWindowStore(JSON.stringify(store))).toEqual(store);
    for (const gridSplit of [{ columns: 2, rows: "0.4" }, "wide"]) {
      expect(parseWindowStore(JSON.stringify({ w1: { ...store["w1"], gridSplit } }))["w1"]).not.toHaveProperty("gridSplit");
    }
  });
});

describe("stored windows", () => {
  it("reads back what it stores and drops malformed entries", () => {
    const store = windowWith(chat("a", release), { ...chat("b"), projectId: "p", workspaceId: "w" });

    expect(parseWindowStore(JSON.stringify(store))).toEqual(store);
    expect(parseWindowStore("not json")).toEqual({});
    expect(parseWindowStore(JSON.stringify({ bad: { name: 3 }, ok: { name: "W", chats: [{ sessionId: "s" }, chat("c")], focused: "gone", layout: "sideways" } }))).toEqual({
      ok: { name: "W", chats: [chat("c")], focused: undefined, layout: "tabs", maximized: false, lastActive: {} },
    });
  });
});
