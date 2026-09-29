// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type FileContentResponse, type Workspace } from "../api";
import { HttpRequestError } from "../api/http";
import { WorkbenchFilesPane } from "./WorkbenchFilesPane";
import type { FormattedText } from "./FormattedText";

const workspace: Workspace = { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true, effectiveConfig: {} };
const file = (path: string, content: string, version?: string): FileContentResponse => ({ path, encoding: "utf8", size: content.length, modifiedAt: "2026-09-22T00:00:00Z", ...(version === undefined ? {} : { version }), content, truncated: false, binary: false, ...(path.endsWith(".md") ? { mediaType: "markdown" as const } : {}) });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(): Promise<WorkbenchFilesPane> {
  const pane = new WorkbenchFilesPane(); pane.workspace = workspace; document.body.append(pane); await pane.updateComplete; return pane;
}
function edit(pane: WorkbenchFilesPane, content: string): void {
  const source = pane.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
  if (!source) throw new Error("Missing text editor");
  source.value = content; source.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Workbench workspace file search", () => {
  it("queries only the selected workspace and continues through untracked non-Markdown results", async () => {
    const search = vi.spyOn(api, "searchWorkspaceFiles").mockResolvedValueOnce({ paths: ["docs/a.txt", "ignored.png"], cursor: "g519" }).mockResolvedValueOnce({ paths: ["new.bin"], cursor: null });
    const pane = await mount();
    expect(search).not.toHaveBeenCalled();
    await pane.searchFiles(); await pane.updateComplete;
    expect(search.mock.calls[0]?.slice(0, 5)).toEqual(["p", "w", "", "", "local"]);
    expect(search.mock.calls[0]?.[5]?.signal).toBeInstanceOf(AbortSignal);
    expect(pane.shadowRoot?.querySelector("nav")).toBeNull();
    expect(pane.shadowRoot?.textContent).toContain("ignored.png");
    const loadMore = pane.shadowRoot?.querySelector<HTMLButtonElement>(".picker-content > button");
    loadMore?.focus(); loadMore?.click();
    await vi.waitFor(() => { expect(search.mock.calls[1]?.slice(0, 5)).toEqual(["p", "w", "", "g519", "local"]); });
    await vi.waitFor(() => { expect(pane.shadowRoot?.textContent).toContain("new.bin"); });
    expect(pane.shadowRoot?.textContent).toContain("All matching files shown");
    await vi.waitFor(() => { expect(pane.shadowRoot?.activeElement).toBe(pane.shadowRoot?.querySelector('input[aria-label="Search files"]')); });
  });

  it("searches a typed query rather than filtering only the first page", async () => {
    const search = vi.spyOn(api, "searchWorkspaceFiles").mockResolvedValueOnce({ paths: ["a.md"], cursor: "n1" })
      .mockResolvedValueOnce({ paths: ["nested/untracked.ts"], cursor: null });
    const pane = await mount(); await pane.searchFiles(); await pane.updateComplete;
    const input = pane.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Search files"]');
    if (!input) throw new Error("Missing file search input");
    input.value = "untracked"; input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => { expect(search.mock.calls[1]?.slice(0, 5)).toEqual(["p", "w", "untracked", "", "local"]); });
    await vi.waitFor(() => { expect(pane.shadowRoot?.textContent).toContain("nested/untracked.ts"); });
    expect(pane.shadowRoot?.textContent).not.toContain("a.md");
  });

  it("opens text and Markdown safely, and keeps dirty edits on cancelled switch or conflict", async () => {
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValueOnce(file("docs/a.txt", "hello", "v1")).mockResolvedValueOnce(file("docs/a.txt", "updated", "v2"))
      .mockResolvedValueOnce(file("docs/notes.md", "# Notes", "v3"));
    const write = vi.spyOn(api, "writeWorkspaceFile").mockRejectedValueOnce(new HttpRequestError("Changed", 409)).mockResolvedValueOnce({ path: "docs/a.txt", size: 7, modifiedAt: "now", created: false });
    const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
    const pane = await mount();
    expect(await pane.openFile("docs/a.txt")).toBe(true);
    expect(pane.shadowRoot?.querySelector("pre")?.textContent).toBe("hello");
    edit(pane, "updated"); await pane.updateComplete;
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(pane.canClose()).toBe(false);
    expect(await pane.openFile("docs/notes.md")).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[3]?.click();
    expect(read).toHaveBeenCalledTimes(1);
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[2]?.click();
    await vi.waitFor(() => { expect(pane.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Conflict"); });
    expect(write).toHaveBeenCalledWith("p", "w", "docs/a.txt", "updated", { expectedVersion: "v1" }, "local");
    confirm.mockReturnValue(true);
    pane.shadowRoot?.querySelector<HTMLButtonElement>(".actions button:last-child")?.click();
    await vi.waitFor(() => { expect(write).toHaveBeenCalledWith("p", "w", "docs/a.txt", "updated", { overwrite: true }, "local"); });
    await vi.waitFor(() => { expect(pane.shadowRoot?.textContent).toContain("Saved"); });
    expect(await pane.openFile("docs/notes.md")).toBe(true);
    expect(pane.shadowRoot?.querySelector<FormattedText>("formatted-text")?.text).toBe("# Notes");
  });

  it("resolves identical Markdown in different nested files relative to each opened file", async () => {
    vi.spyOn(api, "workspaceFile").mockImplementation((_p, _w, path) => Promise.resolve(file(path, "[target](./target.txt)", "v1")));
    const pane = await mount();
    for (const directory of ["docs/one", "docs/two"]) {
      expect(await pane.openFile(`${directory}/notes.md`)).toBe(true);
      await vi.waitFor(() => {
        expect(pane.shadowRoot?.querySelector<FormattedText>("formatted-text")?.shadowRoot?.querySelector("a")?.getAttribute("data-workspace-file")).toBe(`${directory}/target.txt`);
      });
    }
  });

  it("previews images and PDF via workspace URL and offers an honest binary fallback without editing", async () => {
    vi.spyOn(api, "workspaceFile").mockImplementation((_p, _w, path) => Promise.resolve({ ...file(path, "", "v1"), ...(path.endsWith(".png") ? { mediaType: "image" as const } : path.endsWith(".pdf") ? { mediaType: "pdf" as const } : {}), binary: true, size: 42 }));
    const write = vi.spyOn(api, "writeWorkspaceFile");
    const pane = await mount();
    for (const [path, tag] of [["assets/photo.png", "img"], ["docs/guide.pdf", "iframe"], ["data.bin", "p"]] as const) {
      expect(await pane.openFile(path)).toBe(true); await pane.updateComplete;
      expect(pane.shadowRoot?.querySelector(`.preview ${tag}`)).not.toBeNull();
      expect(pane.shadowRoot?.querySelector("textarea")).toBeNull();
      expect(pane.shadowRoot?.textContent).toContain("Download file");
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps a truncated text read view-only without a false dirty state", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValue({ ...file("large.txt", "partial", "v1"), truncated: true, size: 900000 });
    const write = vi.spyOn(api, "writeWorkspaceFile");
    const pane = await mount();
    expect(await pane.openFile("large.txt")).toBe(true); await pane.updateComplete;
    expect(pane.shadowRoot?.querySelector(".preview pre")?.textContent).toBe("partial");
    expect(pane.shadowRoot?.textContent).toContain("too large to edit here");
    expect(pane.shadowRoot?.textContent).toContain("Read-only");
    expect(pane.shadowRoot?.querySelector("textarea")).toBeNull();
    expect(pane.canClose()).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("previews the loaded part of a truncated Markdown file", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValue({ ...file("docs/index.md", "# Index\n\npartial"), truncated: true, size: 12 * 1024 * 1024 });
    const pane = await mount();
    expect(await pane.openFile("docs/index.md")).toBe(true); await pane.updateComplete;
    const view = pane.shadowRoot?.querySelector("formatted-text");
    expect(view ? Reflect.get(view, "text") : undefined).toContain("# Index");
    expect(pane.shadowRoot?.textContent).toContain("first 10.0 MB of 12.0 MB");
    expect(pane.shadowRoot?.textContent).not.toContain("Preview unavailable");
  });

  it("keeps missing-version edits but refuses unsafe save", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValue(file("notes.txt", "initial"));
    const write = vi.spyOn(api, "writeWorkspaceFile");
    const pane = await mount(); await pane.openFile("notes.txt");
    edit(pane, "changed"); await pane.updateComplete;
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[2]?.click(); await pane.updateComplete;
    expect(write).not.toHaveBeenCalled();
    expect(pane.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Cannot save safely");
    expect(pane.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("changed");
  });

  it("resets keyboard selection on reopen, announces the active option and scrolls it into view", async () => {
    const scroll = vi.fn();
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(scroll);
    vi.spyOn(api, "searchWorkspaceFiles").mockResolvedValueOnce({ paths: ["one.md", "two.md"], cursor: null }).mockResolvedValueOnce({ paths: ["only.md"], cursor: null });
    const pane = await mount(); await pane.searchFiles(); await pane.updateComplete;
    const input = pane.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Search files"]');
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await pane.updateComplete;
    expect(input?.getAttribute("aria-activedescendant")).toBe("workspace-file-option-1");
    expect(pane.shadowRoot?.querySelector('[aria-selected="true"]')?.textContent).toBe("two.md");
    expect(scroll).toHaveBeenCalled();
    pane.shadowRoot?.querySelector<HTMLButtonElement>('.picker-content button[aria-label="Close"]')?.click();
    await pane.updateComplete; await pane.searchFiles(); await pane.updateComplete;
    expect(pane.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Search files"]')?.getAttribute("aria-activedescendant")).toBe("workspace-file-option-0");
    expect(pane.shadowRoot?.querySelector('[aria-selected="true"]')?.textContent).toBe("only.md");
  });

  it("aborts stale search requests on query change and picker close", async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(api, "searchWorkspaceFiles").mockImplementation((_p, _w, _q, _c, _m, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise(() => { /* Stay pending until the caller aborts. */ });
    });
    const pane = await mount(); void pane.searchFiles(); await pane.updateComplete;
    const input = pane.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Search files"]');
    if (!input) throw new Error("Missing search input");
    input.value = "next"; input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => { expect(signals).toHaveLength(2); });
    pane.shadowRoot?.querySelector<HTMLButtonElement>('.picker-content button[aria-label="Close"]')?.click();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("discards stale search results after workspace switch and reports search failure", async () => {
    let resolve!: (value: { paths: string[]; cursor: string | null }) => void;
    vi.spyOn(api, "searchWorkspaceFiles").mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockRejectedValueOnce(new Error("unavailable"));
    const pane = await mount(); const search = pane.searchFiles();
    const signal = vi.mocked(api.searchWorkspaceFiles).mock.calls[0]?.[5]?.signal;
    pane.workspace = { ...workspace, id: "other", path: "/other" }; await pane.updateComplete;
    expect(signal?.aborted).toBe(true);
    resolve({ paths: ["old.md"], cursor: null }); await search;
    expect(pane.shadowRoot?.textContent).not.toContain("old.md");
    await pane.searchFiles(); await pane.updateComplete;
    expect(pane.shadowRoot?.textContent).toContain("results may be incomplete");
  });

  it("browses, opens and saves in an ad-hoc Chat folder without a registered project", async () => {
    const folder: Workspace = { id: "folder:/loose/.scratch/notes", projectId: "", path: "/loose/.scratch/notes", label: "notes", isMain: false, effectiveConfig: {} };
    const search = vi.spyOn(api, "searchWorkspaceFiles").mockResolvedValue({ paths: ["a.txt"], cursor: null });
    const read = vi.spyOn(api, "workspaceFile").mockResolvedValue(file("a.txt", "hello", "v1"));
    const write = vi.spyOn(api, "writeWorkspaceFile").mockResolvedValue({ path: "a.txt", size: 7, modifiedAt: "now", created: false });
    const pane = new WorkbenchFilesPane(); pane.workspace = folder; document.body.append(pane); await pane.updateComplete;
    expect(pane.shadowRoot?.textContent).not.toContain("registered workspaces");
    expect(pane.shadowRoot?.querySelector<HTMLButtonElement>(".toolbar button")?.disabled).toBe(false);
    await pane.searchFiles();
    expect(search.mock.calls[0]?.slice(0, 2)).toEqual(["", folder.id]);
    expect(await pane.openFile("a.txt")).toBe(true);
    expect(read.mock.calls[0]?.slice(0, 3)).toEqual(["", folder.id, "a.txt"]);
    read.mockResolvedValue(file("a.txt", "changed", "v2"));
    edit(pane, "changed"); await pane.updateComplete;
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[2]?.click();
    await vi.waitFor(() => { expect(write.mock.calls[0]?.slice(0, 4)).toEqual(["", folder.id, "a.txt", "changed"]); });
  });
});
