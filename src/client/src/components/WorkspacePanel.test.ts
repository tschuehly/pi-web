// @vitest-environment happy-dom
import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { initialAppState } from "../appState";
import type { QualifiedWorkspacePanelContribution, WorkspacePanelContext } from "../plugins/types";
import { WorkspacePanel } from "./WorkspacePanel";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("WorkspacePanel plugin failure isolation", () => {
  it("renders a truthful fallback and keeps another workspace tool selectable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onSelectTool = vi.fn();
    const panel = new WorkspacePanel();
    panel.workspace = workspace();
    panel.panelContext = panelContext();
    panel.tool = "example:broken";
    panel.onSelectTool = onSelectTool;
    panel.panels = [
      contribution("broken", {
        badge: () => { throw new Error("badge failed"); },
        render: () => { throw new Error("render failed"); },
      }),
      contribution("healthy", { render: () => html`<p>Healthy tool</p>` }),
    ];
    document.body.append(panel);

    await panel.updateComplete;

    expect(panel.shadowRoot?.textContent).toContain("Workspace tool unavailable");
    expect(panel.shadowRoot?.textContent).toContain("Broken could not be displayed because its plugin encountered an error.");
    const healthyTab = [...(panel.shadowRoot?.querySelectorAll("button") ?? [])].find((button) => button.textContent.includes("Healthy"));
    expect(healthyTab).toBeDefined();
    healthyTab?.click();
    expect(onSelectTool).toHaveBeenCalledWith("example:healthy");
    expect(warning).toHaveBeenCalledWith("Failed to evaluate workspace panel badge example:broken", expect.any(Error));
    expect(warning).toHaveBeenCalledWith("Failed to render workspace panel example:broken", expect.any(Error));
  });
});

function contribution(localId: string, callbacks: Pick<QualifiedWorkspacePanelContribution, "render"> & Partial<Pick<QualifiedWorkspacePanelContribution, "badge">>): QualifiedWorkspacePanelContribution {
  return {
    id: `example:${localId}`,
    pluginId: "example",
    localId,
    title: localId === "broken" ? "Broken" : "Healthy",
    ...callbacks,
  };
}

function workspace(): Workspace {
  return { id: "workspace-1", projectId: "project-1", path: "/tmp/project", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false, effectiveConfig: {} };
}

function panelContext(): WorkspacePanelContext {
  const selectedWorkspace = workspace();
  return {
    machine: { id: "local", name: "local", kind: "local" },
    workspace: selectedWorkspace,
    state: { ...initialAppState(), selectedWorkspace },
    files: { readFile: vi.fn(), listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    host: { requestRender: vi.fn() },
    fileTree: [],
    expandedDirs: {},
    selectedFilePath: undefined,
    selectedFileContent: undefined,
    fileTreeStale: false,
    gitStatus: undefined,
    selectedDiffPath: undefined,
    selectedDiff: undefined,
    selectedStagedDiff: undefined,
    gitStale: false,
    activeTerminalCount: 0,
    selectedTerminalId: undefined,
    terminalAutoStart: false,
    workspaceUploadDefaultFolder: ".pi-web/uploads",
    onRefreshFiles: vi.fn(),
    onExpandDir: vi.fn(),
    onSelectFile: vi.fn(),
    onStartWorkspaceUpload: vi.fn(),
    onCancelWorkspaceUpload: vi.fn(),
    onClearWorkspaceUpload: vi.fn(),
    onRefreshGit: vi.fn(),
    onSelectDiff: vi.fn(),
    onSelectTerminal: vi.fn(),
  };
}
