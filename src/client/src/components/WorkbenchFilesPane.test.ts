// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type FileContentResponse, type Workspace } from "../api";
import { HttpRequestError } from "../api/http";
import { WorkbenchFilesPane } from "./WorkbenchFilesPane";
import type { FormattedText } from "./FormattedText";

const workspace: Workspace = { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true, effectiveConfig: {} };
const file = (content: string, version: string): FileContentResponse => ({ path: "docs/notes.md", encoding: "utf8", size: content.length, modifiedAt: "2026-09-22T00:00:00Z", version, content, truncated: false, binary: false, mediaType: "markdown" });

beforeEach(() => {
  vi.spyOn(api, "workspaceTree").mockImplementation((_project, _workspace, path) => Promise.resolve({ path: path ?? "", entries: path === "docs" ? [{ name: "notes.md", path: "docs/notes.md", type: "file" }, { name: "another.md", path: "docs/another.md", type: "file" }, { name: "hidden.txt", path: "docs/hidden.txt", type: "file" }] : [{ name: "docs", path: "docs", type: "directory" }], scannedAt: "2026-09-22", truncated: false }));
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(): Promise<WorkbenchFilesPane> {
  const pane = new WorkbenchFilesPane();
  pane.workspace = workspace;
  document.body.append(pane);
  await pane.updateComplete;
  await vi.waitFor(() => { expect(pane.shadowRoot?.querySelector<HTMLButtonElement>(".file-row")).not.toBeNull(); });
  return pane;
}

async function open(pane: WorkbenchFilesPane): Promise<void> {
  pane.shadowRoot?.querySelector<HTMLButtonElement>(".file-row")?.click();
  await vi.waitFor(() => { expect(pane.shadowRoot?.querySelectorAll(".file-row")).toHaveLength(3); });
  pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".file-row")[1]?.click();
  await vi.waitFor(() => { expect(pane.shadowRoot?.querySelector<FormattedText>("formatted-text")?.text).toBe("# Initial"); });
}

function edit(pane: WorkbenchFilesPane, content: string): void {
  const source = pane.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
  if (!source) throw new Error("Missing Markdown editor");
  source.value = content;
  source.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Workbench Files", () => {
  it("refreshes the file list from a labelled icon button", async () => {
    const pane = await mount();
    const refresh = pane.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Refresh list"]');
    expect(refresh?.title).toBe("Refresh list");
    expect(refresh?.type).toBe("button");
    expect(refresh?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(refresh?.textContent).toBe("");
    vi.mocked(api.workspaceTree).mockClear();
    refresh?.click();
    await vi.waitFor(() => { expect(api.workspaceTree).toHaveBeenCalledWith("p", "w", "", "local"); });
  });

  it("lists only Markdown files, opens on filename click, previews, edits and saves with the loaded version", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValueOnce(file("# Initial", "v1")).mockResolvedValueOnce(file("# Edited", "v2"));
    const write = vi.spyOn(api, "writeWorkspaceFile").mockResolvedValue({ path: "docs/notes.md", size: 8, modifiedAt: "2026-09-22", created: false });
    vi.stubGlobal("confirm", vi.fn(() => false));
    const pane = await mount();
    await open(pane);
    expect(pane.shadowRoot?.textContent).not.toContain("hidden.txt");
    expect(api.workspaceTree).toHaveBeenCalledWith("p", "w", "", "local");
    expect(api.workspaceTree).toHaveBeenCalledWith("p", "w", "docs", "local");
    expect(pane.shadowRoot?.querySelector("formatted-text")?.shadowRoot?.querySelector("h1")?.textContent).toBe("Initial");
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[1]?.click();
    await pane.updateComplete;
    edit(pane, "# Edited");
    await pane.updateComplete;
    expect(pane.canClose()).toBe(false);
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[2]?.click();
    await vi.waitFor(() => { expect(write).toHaveBeenCalledWith("p", "w", "docs/notes.md", "# Edited", { expectedVersion: "v1" }, "local"); });
    await vi.waitFor(() => { expect(pane.shadowRoot?.querySelector(".toolbar span")?.textContent).toBe("Saved"); });
    expect(pane.canClose()).toBe(true);
  });

  it("keeps dirty work on cancelled switch/reload and failed save; offers explicit overwrite only for conflicts", async () => {
    vi.spyOn(api, "workspaceFile").mockResolvedValueOnce(file("# Initial", "v1")).mockResolvedValueOnce(file("# My changes", "v2"));
    const write = vi.spyOn(api, "writeWorkspaceFile").mockRejectedValueOnce(new HttpRequestError("File changed", 409))
      .mockResolvedValueOnce({ path: "docs/notes.md", size: 12, modifiedAt: "2026-09-22", created: false });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const pane = await mount();
    await open(pane);
    edit(pane, "# My changes");
    await pane.updateComplete;
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".file-row")[2]?.click();
    await pane.updateComplete;
    expect(pane.shadowRoot?.querySelector(".surface .toolbar strong")?.textContent).toBe("docs/notes.md");
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[3]?.click();
    await pane.updateComplete;
    expect(api.workspaceFile).toHaveBeenCalledTimes(1);
    expect(pane.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("# My changes");
    expect(confirm).toHaveBeenCalled();
    expect(pane.canClose()).toBe(false);
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[2]?.click();
    await vi.waitFor(() => { expect(pane.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Conflict"); });
    expect(pane.shadowRoot?.querySelector<HTMLButtonElement>(".actions button:last-child")?.textContent).toContain("Replace current file");
    expect(write).toHaveBeenCalledWith("p", "w", "docs/notes.md", "# My changes", { expectedVersion: "v1" }, "local");
    expect(pane.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("# My changes");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    confirm.mockReturnValue(true);
    pane.shadowRoot?.querySelector<HTMLButtonElement>(".actions button:last-child")?.click();
    await vi.waitFor(() => { expect(write).toHaveBeenCalledWith("p", "w", "docs/notes.md", "# My changes", { overwrite: true }, "local"); });
    await vi.waitFor(() => { expect(pane.shadowRoot?.querySelector(".toolbar span")?.textContent).toBe("Saved"); });
  });

  it("refuses an unsafe save when the loaded host did not supply a version", async () => {
    const unversioned = file("# Initial", "v1");
    delete unversioned.version;
    vi.spyOn(api, "workspaceFile").mockResolvedValue(unversioned);
    const write = vi.spyOn(api, "writeWorkspaceFile");
    const pane = await mount();
    await open(pane);
    edit(pane, "# Changed");
    await pane.updateComplete;
    pane.shadowRoot?.querySelectorAll<HTMLButtonElement>(".actions button")[2]?.click();
    await pane.updateComplete;
    expect(write).not.toHaveBeenCalled();
    expect(pane.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Cannot save safely");
  });
});
