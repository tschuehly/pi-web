// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { api, type FileContentResponse, type FileTreeEntry, type Workspace } from "../api";
import { HttpRequestError } from "../api/http";
import { WorkbenchFilesPane } from "./WorkbenchFilesPane";

const workspace: Workspace = { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true, effectiveConfig: {} };
const file = (path: string, content: string, version?: string): FileContentResponse => ({ path, encoding: "utf8", size: content.length, modifiedAt: "2026-09-22T00:00:00Z", ...(version === undefined ? {} : { version }), content, truncated: false, binary: false, ...(path.endsWith(".md") ? { mediaType: "markdown" as const } : {}) });
const entry = (path: string, type: FileTreeEntry["type"] = "file"): FileTreeEntry => ({ name: path.slice(path.lastIndexOf("/") + 1), path, type });
const listing = (path: string, entries: FileTreeEntry[]) => ({ path, entries, scannedAt: "now", truncated: false });
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "piWebNative"); });

async function mount(target: Workspace = workspace): Promise<WorkbenchFilesPane> {
  if (!vi.isMockFunction(api.workspaceTree)) vi.spyOn(api, "workspaceTree").mockResolvedValue(listing("", []));
  const pane = new WorkbenchFilesPane(); pane.workspace = target; document.body.append(pane); await pane.updateComplete; return pane;
}
const $ = (pane: WorkbenchFilesPane, selector: string) => pane.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
function editor(pane: WorkbenchFilesPane): EditorView {
  const view = EditorView.findFromDOM(pane.shadowRoot?.querySelector<HTMLElement>(".cm-editor") ?? document.body);
  if (view === null) throw new Error("Missing editor");
  return view;
}
const text = (pane: WorkbenchFilesPane) => editor(pane).state.doc.toString();
function edit(pane: WorkbenchFilesPane, content: string): void {
  const view = editor(pane);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
}
function save(pane: WorkbenchFilesPane): KeyboardEvent {
  const key = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, composed: true, cancelable: true });
  editor(pane).contentDOM.dispatchEvent(key);
  return key;
}
const status = (pane: WorkbenchFilesPane) => $(pane, ".state")?.textContent.trim();

describe("Workbench Files tree", () => {
  it("lists folders lazily, folders first, and opens a file from the tree", async () => {
    const tree = vi.spyOn(api, "workspaceTree").mockImplementation((_p, _w, path) => Promise.resolve(path === ""
      ? listing("", [entry("z.txt"), entry("docs", "directory"), entry(".git", "directory")]) : listing(path ?? "", [entry("docs/notes.md")])));
    vi.spyOn(api, "workspaceFile").mockResolvedValue(file("docs/notes.md", "# Notes", "v1"));
    const pane = await mount();
    await vi.waitFor(() => { expect([...pane.shadowRoot?.querySelectorAll(".tree .row") ?? []].map((row) => row.textContent.trim())).toEqual(["docs", "z.txt"]); });
    expect(tree).toHaveBeenCalledTimes(1);
    expect($(pane, ".no-file aside")).not.toBeNull();
    $(pane, ".row.dir")?.click();
    await vi.waitFor(() => { expect($(pane, '.row.file[data-path="docs/notes.md"]')).not.toBeNull(); });
    expect(tree.mock.calls[1]?.slice(0, 4)).toEqual(["p", "w", "docs", "local"]);
    $(pane, '.row.file[data-path="docs/notes.md"]')?.click();
    await vi.waitFor(() => { expect(text(pane)).toBe("# Notes"); });
    expect($(pane, ".crumbs .dir")?.textContent).toBe("docs/");
    expect($(pane, ".crumbs .leaf")?.textContent).toBe("notes.md");
    expect($(pane, ".tree-open")).toBeNull();
    await pane.searchFiles(); await pane.updateComplete;
    expect($(pane, ".tree-open")).not.toBeNull();
    expect($(pane, ".row.sel")?.getAttribute("data-path")).toBe("docs/notes.md");
    expect(pane.shadowRoot?.activeElement).toBe($(pane, ".filter input"));
  });

  it("filters through workspace search, shows matches inside their folders, and opens the first on Enter", async () => {
    const search = vi.spyOn(api, "searchWorkspaceFiles").mockResolvedValueOnce({ paths: ["src/b.ts", "a.md", "src/deep/c.ts"], cursor: "g519" }).mockResolvedValueOnce({ paths: ["src/z.ts"], cursor: null });
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValue(file("src/deep/c.ts", "const c = 1;", "v1"));
    const pane = await mount();
    const input = pane.shadowRoot?.querySelector<HTMLInputElement>(".filter input");
    if (!input) throw new Error("Missing filter");
    input.value = "c"; input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => { expect(search.mock.calls[0]?.slice(0, 5)).toEqual(["p", "w", "c", "", "local"]); });
    await vi.waitFor(() => { expect([...pane.shadowRoot?.querySelectorAll(".tree .row") ?? []].map((row) => row.textContent.trim())).toEqual(["src", "deep", "c.ts", "b.ts", "a.md"]); });
    $(pane, ".more")?.click();
    await vi.waitFor(() => { expect(search.mock.calls[1]?.slice(0, 5)).toEqual(["p", "w", "c", "g519", "local"]); });
    await vi.waitFor(() => { expect($(pane, '[data-path="src/z.ts"]')).not.toBeNull(); });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => { expect(read.mock.calls[0]?.[2]).toBe("src/deep/c.ts"); });
  });

  it("aborts stale searches and discards results after a workspace switch", async () => {
    const signals: AbortSignal[] = [];
    let resolve!: (value: { paths: string[]; cursor: string | null }) => void;
    vi.spyOn(api, "searchWorkspaceFiles").mockImplementation((_p, _w, _q, _c, _m, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise((done) => { resolve = done; });
    });
    const pane = await mount();
    const input = pane.shadowRoot?.querySelector<HTMLInputElement>(".filter input");
    if (!input) throw new Error("Missing filter");
    input.value = "old"; input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => { expect(signals).toHaveLength(1); });
    pane.workspace = { ...workspace, id: "other", path: "/other" }; await pane.updateComplete;
    expect(signals[0]?.aborted).toBe(true);
    resolve({ paths: ["old.md"], cursor: null }); await pane.updateComplete;
    expect(pane.shadowRoot?.textContent).not.toContain("old.md");
  });
});

describe("Workbench Files editor", () => {
  it("edits text, keeps dirty edits on a cancelled switch, and saves with ⌘S against the loaded version", async () => {
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValueOnce(file("docs/a.txt", "hello", "v1")).mockResolvedValueOnce(file("docs/a.txt", "updated", "v2"));
    const write = vi.spyOn(api, "writeWorkspaceFile").mockResolvedValue({ path: "docs/a.txt", size: 7, modifiedAt: "now", created: false });
    const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
    const pane = await mount();
    expect(await pane.openFile("docs/a.txt")).toBe(true);
    expect(text(pane)).toBe("hello");
    expect(status(pane)).toBe("Saved");
    edit(pane, "updated"); await pane.updateComplete;
    expect(status(pane)).toBe("Unsaved · ⌘S");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(pane.canClose()).toBe(false);
    expect(await pane.openFile("docs/notes.md")).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(save(pane).defaultPrevented).toBe(true);
    await vi.waitFor(() => { expect(status(pane)).toBe("Saved"); });
    expect(write).toHaveBeenCalledWith("p", "w", "docs/a.txt", "updated", { expectedVersion: "v1" }, "local");
    expect(pane.canClose()).toBe(true);
  });

  it("starts Markdown in Live, toggles Raw, and remembers the mode", async () => {
    vi.spyOn(api, "workspaceFile").mockImplementation((_p, _w, path) => Promise.resolve(file(path, "# Title\n\n- [ ] task\n", "v1")));
    const pane = await mount();
    await pane.openFile("a.md"); await pane.updateComplete;
    expect($(pane, '.seg [aria-pressed="true"]')?.textContent).toBe("Live");
    expect($(pane, ".cm-content.lp-on")).not.toBeNull();
    expect($(pane, ".lp-check")).not.toBeNull();
    [...pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".seg button") ?? []].find((button) => button.textContent === "Raw")?.click();
    await pane.updateComplete;
    expect($(pane, ".cm-content.lp-on")).toBeNull();
    // happy-dom's ShadowRoot.activeElement throws while focus sits in another shadow root.
    pane.remove();
    const second = await mount();
    await second.openFile("b.md"); await second.updateComplete;
    expect($(second, '.seg [aria-pressed="true"]')?.textContent).toBe("Raw");
    await second.openFile("c.ts"); await second.updateComplete;
    expect($(second, ".seg")).toBeNull();
    expect(editor(second).lineWrapping).toBe(false);
  });

  it("does not carry undo history across files", async () => {
    vi.spyOn(api, "workspaceFile").mockImplementation((_p, _w, path) => Promise.resolve(file(path, `body of ${path}`, "v1")));
    vi.stubGlobal("confirm", () => true);
    const pane = await mount();
    await pane.openFile("a.txt"); edit(pane, "changed");
    await pane.openFile("b.txt");
    const undo = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    editor(pane).contentDOM.dispatchEvent(undo);
    expect(text(pane)).toBe("body of b.txt");
  });

  it("applies agent edits from disk inline, and Reject restores the old text", async () => {
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValueOnce(file("a.md", "The launch is on Friday.\n", "v1"));
    const pane = await mount();
    await pane.openFile("a.md");
    read.mockResolvedValueOnce(file("a.md", "The launch is on Monday.\n", "v2"));
    await pane.syncWithDisk(); await pane.updateComplete;
    expect(text(pane)).toBe("The launch is on Monday.\n");
    expect($(pane, ".hunk-del")?.textContent).toBe("Friday");
    expect($(pane, ".hunk-ins")?.textContent).toBe("Monday");
    expect($(pane, ".strip")?.textContent).toContain("1 agent change");
    expect(status(pane)).toBe("Agent edit applied");
    $(pane, ".hunk-inline-btns .reject")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await pane.updateComplete;
    expect(text(pane)).toBe("The launch is on Friday.\n");
    expect($(pane, ".strip")).toBeNull();
  });

  it("on a save conflict re-reads the file and shows the agent's changes for review", async () => {
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValueOnce(file("a.txt", "one\ntwo\nthree\n", "v1")).mockResolvedValueOnce(file("a.txt", "one\ntwo\nTHREE by agent and more\n", "v2"));
    const write = vi.spyOn(api, "writeWorkspaceFile").mockRejectedValueOnce(new HttpRequestError("Changed", 409)).mockResolvedValueOnce({ path: "a.txt", size: 1, modifiedAt: "now", created: false });
    const pane = await mount();
    await pane.openFile("a.txt");
    edit(pane, "ONE\ntwo\nthree\n");
    save(pane);
    await vi.waitFor(() => { expect(status(pane)).toBe("Agent changed the file first · review, then ⌘S"); });
    expect(text(pane)).toBe("ONE\ntwo\nTHREE by agent and more\n");
    expect($(pane, ".hunk-box")?.textContent).toContain("Agent");
    read.mockResolvedValueOnce(file("a.txt", "ONE\ntwo\nTHREE by agent and more\n", "v3"));
    save(pane);
    await vi.waitFor(() => { expect(write).toHaveBeenLastCalledWith("p", "w", "a.txt", "ONE\ntwo\nTHREE by agent and more\n", { expectedVersion: "v2" }, "local"); });
    await vi.waitFor(() => { expect($(pane, ".strip")).toBeNull(); });
  });

  it("keeps the text of a file deleted on disk and recreates it on save", async () => {
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValueOnce(file("a.txt", "keep me", "v1")).mockRejectedValueOnce(new HttpRequestError("Path does not exist", 400));
    const write = vi.spyOn(api, "writeWorkspaceFile").mockResolvedValue({ path: "a.txt", size: 7, modifiedAt: "now", created: true });
    const pane = await mount();
    await pane.openFile("a.txt");
    await pane.syncWithDisk(); await pane.updateComplete;
    expect(status(pane)).toBe("Deleted on disk");
    expect(text(pane)).toBe("keep me");
    read.mockResolvedValueOnce(file("a.txt", "keep me", "v2"));
    save(pane);
    await vi.waitFor(() => { expect(write).toHaveBeenCalledWith("p", "w", "a.txt", "keep me", { overwrite: false }, "local"); });
    await vi.waitFor(() => { expect(status(pane)).toBe("Saved"); });
  });

  it("keeps missing-version edits but refuses unsafe save", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValue(file("notes.txt", "initial"));
    const write = vi.spyOn(api, "writeWorkspaceFile");
    const pane = await mount(); await pane.openFile("notes.txt");
    edit(pane, "changed"); save(pane); await pane.updateComplete;
    expect(write).not.toHaveBeenCalled();
    expect($(pane, '[role="alert"]')?.textContent).toContain("Cannot save safely");
    expect(text(pane)).toBe("changed");
  });

  it("highlights a linked line range until the user edits", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValue(file("a.ts", "1\n2\n3\n4\n5\n", "v1"));
    const pane = await mount();
    await pane.openFile("a.ts", false, { start: 2, end: 4 });
    expect([...pane.shadowRoot?.querySelectorAll(".cm-range") ?? []].map((line) => line.textContent)).toEqual(["2", "3", "4"]);
    await pane.openFile("a.ts", false, { start: 5, end: 5 });
    expect(pane.shadowRoot?.querySelectorAll(".cm-range")).toHaveLength(1);
    edit(pane, "x");
    expect(pane.shadowRoot?.querySelectorAll(".cm-range")).toHaveLength(0);
  });

  it("opens full size and returns with Escape", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValue(file("a.md", "# A", "v1"));
    const pane = await mount(); await pane.openFile("a.md"); await pane.updateComplete;
    $(pane, 'button[aria-label="Open full size"]')?.click(); await pane.updateComplete;
    expect($(pane, ".pane.full")).not.toBeNull();
    expect($(pane, ".backdrop")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await pane.updateComplete;
    expect($(pane, ".pane.full")).toBeNull();
  });
});

describe("Workbench Files read-only files", () => {
  it("previews images and PDF, and offers Download for binary files without editing", async () => {
    vi.spyOn(api, "workspaceFile").mockImplementation((_p, _w, path) => Promise.resolve({ ...file(path, "", "v1"), ...(path.endsWith(".png") ? { mediaType: "image" as const } : path.endsWith(".pdf") ? { mediaType: "pdf" as const } : {}), binary: true, size: 42 }));
    const write = vi.spyOn(api, "writeWorkspaceFile");
    const pane = await mount();
    for (const [path, tag] of [["assets/photo.png", "img"], ["docs/guide.pdf", "iframe"], ["data.bin", "p"]] as const) {
      expect(await pane.openFile(path)).toBe(true); await pane.updateComplete;
      expect($(pane, `.preview ${tag}`)).not.toBeNull();
      expect($(pane, ".editor")?.hidden).toBe(true);
      expect(pane.shadowRoot?.textContent).toContain("Download file");
      expect(status(pane)).toBe("Read-only");
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("offers Show in Finder in the macOS app", async () => {
    const reveal = vi.fn(() => Promise.resolve(true));
    Object.assign(window, { piWebNative: { pickDirectory: () => Promise.resolve(null), revealLocalFile: reveal } });
    vi.spyOn(api, "workspaceFile").mockResolvedValue({ ...file("data.bin", "", "v1"), binary: true });
    const pane = await mount(); await pane.openFile("data.bin"); await pane.updateComplete;
    expect(pane.shadowRoot?.textContent).not.toContain("Download file");
    [...pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".note button") ?? []].find((button) => button.textContent === "Show in Finder")?.click();
    expect(reveal).toHaveBeenCalledWith("/repo/data.bin");
  });

  it("pinch-zooms an image from fit-to-pane up to 8x and resets on the next file", async () => {
    vi.spyOn(api, "workspaceFile").mockImplementation((_p, _w, path) => Promise.resolve({ ...file(path, "", "v1"), mediaType: "image" as const, binary: true, size: 42 }));
    const pane = await mount();
    await pane.openFile("a.png"); await pane.updateComplete;
    const image = pane.shadowRoot?.querySelector<HTMLImageElement>(".preview img");
    if (!image) throw new Error("Missing image");
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 100 }));
    const gesture = (type: string, scale: number) => { const event = new Event(type, { cancelable: true }); Object.assign(event, { scale, clientX: 0, clientY: 0 }); image.dispatchEvent(event); return event; };
    expect(gesture("gesturestart", 1).defaultPrevented).toBe(true);
    gesture("gesturechange", 2);
    expect(image.style.width).toBe("400px");
    expect(image.style.maxWidth).toBe("none");
    gesture("gesturechange", 20);
    expect(image.style.width).toBe("1600px");
    gesture("gestureend", 20);
    // happy-dom's WheelEvent drops ctrlKey, which browsers set for a pinch.
    const pinchWheel = (deltaY: number) => { const event = new WheelEvent("wheel", { deltaY, cancelable: true }); Object.defineProperty(event, "ctrlKey", { value: true }); image.dispatchEvent(event); return event; };
    expect(pinchWheel(1000).defaultPrevented).toBe(true);
    expect(image.style.width).toBe("");
    pinchWheel(-100 * Math.log(2));
    expect(image.style.width).toBe("400px");
    const scroll = new WheelEvent("wheel", { deltaY: 50, cancelable: true });
    image.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
    await pane.openFile("b.png"); await pane.updateComplete;
    expect(pane.shadowRoot?.querySelector<HTMLImageElement>(".preview img")?.style.width).toBe("");
  });

  it("shows the loaded part of a truncated file read-only without a false dirty state", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValue({ ...file("docs/index.md", "# Index\n\npartial", "v1"), truncated: true, size: 12 * 1024 * 1024 });
    const write = vi.spyOn(api, "writeWorkspaceFile");
    const pane = await mount();
    expect(await pane.openFile("docs/index.md")).toBe(true); await pane.updateComplete;
    expect(text(pane)).toContain("# Index");
    expect(editor(pane).state.readOnly).toBe(true);
    expect(pane.shadowRoot?.textContent).toContain("first 10.0 MB of 12.0 MB");
    expect(status(pane)).toBe("Read-only");
    expect(pane.canClose()).toBe(true);
    save(pane);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("Workbench Files in an ad-hoc Chat folder", () => {
  it("browses, opens and saves without a registered project", async () => {
    const folder: Workspace = { id: "folder:/loose/.scratch/notes", projectId: "", path: "/loose/.scratch/notes", label: "notes", isMain: false, effectiveConfig: {} };
    const tree = vi.spyOn(api, "workspaceTree").mockResolvedValue(listing("", [entry("a.txt")]));
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValue(file("a.txt", "hello", "v1"));
    const write = vi.spyOn(api, "writeWorkspaceFile").mockResolvedValue({ path: "a.txt", size: 7, modifiedAt: "now", created: false });
    const pane = await mount(folder);
    await vi.waitFor(() => { expect(tree.mock.calls[0]?.slice(0, 2)).toEqual(["", folder.id]); });
    expect(await pane.openFile("a.txt")).toBe(true);
    expect(read.mock.calls[0]?.slice(0, 3)).toEqual(["", folder.id, "a.txt"]);
    read.mockResolvedValue(file("a.txt", "changed", "v2"));
    edit(pane, "changed"); save(pane);
    await vi.waitFor(() => { expect(write.mock.calls[0]?.slice(0, 4)).toEqual(["", folder.id, "a.txt", "changed"]); });
  });
});
