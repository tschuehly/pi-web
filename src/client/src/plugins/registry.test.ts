// @vitest-environment happy-dom
import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { DeleteWorkspaceFileResponse, FileContentResponse, FileTreeResponse, MoveWorkspaceFileResponse, SessionInfo, SessionStatus, WriteWorkspaceFileResponse, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { markCachedNewSessionInfo } from "../cachedNewSessions";
import { machineScopedPluginId } from "../../../shared/machinePluginIds";
import { corePlugin } from "./core";
import { PluginRegistry } from "./registry";
import { themePackPlugin } from "./themes";
import type { PluginActivationContext, PluginRuntimeContext, PrimaryViewContext, PrimaryViewSurface, ThemeTokens, WorkspaceFiles, WorkspaceHost, WorkspaceLabelContext, WorkspaceLabelItem, WorkspacePanelContext } from "./types";

function createPrimaryViewContext(machineId = "local"): PrimaryViewContext {
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    connection: { status: "connected" },
    host: { requestRender: vi.fn() },
  };
}

function createContext(statePatch: Partial<AppState> = {}) {
  const calls: string[] = [];
  const context: PluginRuntimeContext = {
    state: { ...initialAppState(), ...statePatch },
    prompt: {
      insertText: vi.fn(),
      getText: vi.fn(() => ""),
      getSelection: vi.fn(() => null),
    },
    piWebUnstable: {
      terminalCommandRuns: {
        runCommand: vi.fn(),
        listCommandRuns: vi.fn(),
        getCommandRun: vi.fn(),
        open: vi.fn((options?: { terminalId?: string | undefined }) => { calls.push(`terminal.open:${options?.terminalId ?? ""}`); }),
      },
      openSettings: vi.fn(() => { calls.push("openSettings"); }),
    },
    openActionPalette: vi.fn(() => { calls.push("openActionPalette"); }),
    focusPrompt: vi.fn(() => { calls.push("focusPrompt"); }),
    addProject: vi.fn(() => { calls.push("addProject"); }),
    addMachine: vi.fn(() => { calls.push("addMachine"); }),
    refreshSelectedMachine: vi.fn(() => { calls.push("refreshSelectedMachine"); }),
    removeSelectedMachine: vi.fn(() => { calls.push("removeSelectedMachine"); }),
    openSelectedMachine: vi.fn(() => { calls.push("openSelectedMachine"); }),
    configureAuth: vi.fn(() => { calls.push("configureAuth"); }),
    logoutAuth: vi.fn(() => { calls.push("logoutAuth"); }),
    openThemePicker: vi.fn(() => { calls.push("openThemePicker"); }),
    openModelPicker: vi.fn(() => { calls.push("openModelPicker"); }),
    openThinkingLevelPicker: vi.fn(() => { calls.push("openThinkingLevelPicker"); }),
    selectMainView: vi.fn((view: AppState["mainView"]) => { calls.push(`selectMainView:${view}`); }),
    selectWorkspaceTool: vi.fn((tool: AppState["workspaceTool"]) => { calls.push(`selectWorkspaceTool:${tool}`); }),
    openTerminal: vi.fn((options?: { terminalId?: string | undefined }) => { calls.push(`openTerminal:${options?.terminalId ?? ""}`); }),
    refreshFiles: vi.fn(() => { calls.push("refreshFiles"); }),
    refreshGit: vi.fn(() => { calls.push("refreshGit"); }),
    refreshAppData: vi.fn(() => { calls.push("refreshAppData"); }),
    reloadPage: vi.fn(() => { calls.push("reloadPage"); }),
    deleteWorkspace: vi.fn(() => { calls.push("deleteWorkspace"); }),
    startSession: vi.fn(() => { calls.push("startSession"); }),
    archiveSession: vi.fn(() => { calls.push("archiveSession"); }),
    reloadSession: vi.fn(() => { calls.push("reloadSession"); }),
    deleteCachedNewSession: vi.fn(() => { calls.push("deleteCachedNewSession"); }),
    stopActiveWork: vi.fn(() => { calls.push("stopActiveWork"); }),
  };
  return { context, calls };
}

describe("PluginRegistry", () => {
  it("namespaces contribution ids with the owning plugin id", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    expect(registry.getActions(createContext().context).some((action) => action.id === "core:actions.show")).toBe(true);
    expect(registry.getWorkspacePanels().map((panel) => panel.id)).toEqual(["core:workspace.files", "core:workspace.git", "core:workspace.terminal"]);
  });

  it("provides html and svg helpers to plugin activation and callbacks", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: ({ html, svg }) => ({
          contributions: {
            workspacePanels: [
              {
                id: "workspace.logs",
                title: "Logs",
                icon: svg`<svg viewBox="0 0 24 24"><path d="M4 6h16"></path></svg>`,
                render: () => html`<p>Logs</p>`,
              },
            ],
          },
        }),
      },
    });

    const panel = registry.getWorkspacePanels()[0];

    expect(panel?.icon).toBeDefined();
    expect(panel?.render(createWorkspacePanelContext("local"))).toBeDefined();
  });

  it("passes the plugin-scoped service only to its activation context", async () => {
    const registry = new PluginRegistry();
    const request = vi.fn(() => Promise.resolve({ accepted: true }));
    const activate = vi.fn((context: PluginActivationContext) => {
      expect(context.apiVersion).toBe(1);
      return { contributions: {} };
    });

    registry.register({ id: "example", service: { request }, plugin: { apiVersion: 1, name: "Example", activate } });

    const context = activate.mock.calls[0]?.[0];
    await expect(context?.service?.request("create", { title: "Example" })).resolves.toEqual({ accepted: true });
    expect(request).toHaveBeenCalledWith("create", { title: "Example" });
  });

  it("qualifies and orders navigation entries with their visible primary views", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: () => ({
          contributions: {
            primaryViews: [
              { id: "views.hidden", title: "Hidden", visible: () => false, render: () => html`<p>Hidden</p>` },
              { id: "views.work", title: "Work", layout: "dedicated", render: () => html`<p>Work</p>` },
            ],
            navigationEntries: [
              { id: "nav.hidden", title: "Hidden", primaryView: "views.hidden", order: 1 },
              { id: "nav.work", title: "Work", primaryView: "views.work", order: 2, badge: () => 3 },
            ],
          },
        }),
      },
    });
    const context = createPrimaryViewContext();

    const entries = registry.getNavigationEntries(context);
    const view = registry.getPrimaryView("example:views.work", context);

    expect(entries.map((entry) => [entry.id, entry.primaryView])).toEqual([["example:nav.work", "example:views.work"]]);
    expect(entries[0]?.badge?.(context)).toBe(3);
    expect(view?.layout).toBe("dedicated");
    expect(view?.render(context)).toBeDefined();
  });

  it("preserves the dedicated primary-view surface host public seam", () => {
    const registry = new PluginRegistry();
    const mountSurface = vi.fn<(container: HTMLElement, surface: PrimaryViewSurface) => void>();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: () => ({
          contributions: {
            primaryViews: [{
              id: "views.work",
              title: "Work",
              layout: "dedicated",
              render: (context) => {
                const container = document.createElement("div");
                context.surfaceHost?.mount(container, "chat");
                return html`${container}`;
              },
            }],
          },
        }),
      },
    });
    const context: PrimaryViewContext = {
      ...createPrimaryViewContext(),
      surfaceHost: { mount: mountSurface },
    };

    const view = registry.getPrimaryView("example:views.work", context);

    expect(view?.layout).toBe("dedicated");
    expect(view?.render(context)).toBeDefined();
    expect(mountSurface).toHaveBeenCalledWith(expect.anything(), "chat");
  });

  it("returns an active plugin's ordinary session-start guard reason", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: () => ({ contributions: { sessionStartGuards: [{ id: "workstream-home", disabledReason: () => "Start from a Workstream." }] } }),
      },
    });

    expect(registry.getSessionStartDisabledReason(createPrimaryViewContext())).toBe("Start from a Workstream.");
  });

  it("logs and skips a throwing third-party session-start guard", () => {
    const registry = new PluginRegistry();
    const failure = new Error("guard failed");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registry.register({
      id: "failing",
      plugin: {
        apiVersion: 1,
        name: "Failing",
        activate: () => ({ contributions: { sessionStartGuards: [{ id: "guard", disabledReason: () => { throw failure; } }] } }),
      },
    });

    expect(registry.getSessionStartDisabledReason(createPrimaryViewContext())).toBeUndefined();
    expect(warning).toHaveBeenCalledWith("Failed to evaluate session start guard failing:guard", failure);
    warning.mockRestore();
  });

  it("allows a healthy guard after a throwing guard to contribute its reason", () => {
    const registry = new PluginRegistry();
    const failure = new Error("guard failed");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registry.register({
      id: "failing",
      plugin: {
        apiVersion: 1,
        name: "Failing",
        activate: () => ({ contributions: { sessionStartGuards: [{ id: "guard", disabledReason: () => { throw failure; } }] } }),
      },
    });
    registry.register({
      id: "healthy",
      plugin: {
        apiVersion: 1,
        name: "Healthy",
        activate: () => ({ contributions: { sessionStartGuards: [{ id: "guard", disabledReason: () => "Start from a Workstream." }] } }),
      },
    });

    expect(registry.getSessionStartDisabledReason(createPrimaryViewContext())).toBe("Start from a Workstream.");
    expect(warning).toHaveBeenCalledWith("Failed to evaluate session start guard failing:guard", failure);
    warning.mockRestore();
  });

  it("isolates failing plugin callbacks while preserving core shell actions", () => {
    const registry = new PluginRegistry();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registry.register({ id: "core", plugin: corePlugin });
    registry.register({
      id: "failing",
      plugin: {
        apiVersion: 1,
        name: "Failing",
        activate: () => ({
          contributions: {
            actions: [
              { id: "enablement", title: "Broken enablement", enabled: () => { throw new Error("enablement failed"); }, run: () => undefined },
              { id: "reason", title: "Broken reason", enabled: () => false, disabledReason: () => { throw new Error("reason failed"); }, run: () => undefined },
            ],
            primaryViews: [{ id: "view", title: "Failing view", render: () => html`<p>View</p>` }],
            navigationEntries: [{ id: "navigation", title: "Failing navigation", primaryView: "view", badge: () => { throw new Error("navigation badge failed"); } }],
            workspacePanels: [
              { id: "panel", title: "Failing panel", badge: () => { throw new Error("panel badge failed"); }, render: () => html`<p>Panel</p>` },
              { id: "hidden-panel", title: "Hidden panel", visible: () => { throw new Error("panel visibility failed"); }, render: () => html`<p>Hidden</p>` },
            ],
            workspaceLabels: [
              { id: "hidden-label", visible: () => { throw new Error("label visibility failed"); }, items: () => [{ type: "text", text: "hidden" }] },
              { id: "broken-items", items: () => { throw new Error("label items failed"); } },
              { id: "healthy-label", items: () => [{ type: "text", text: "healthy" }] },
              { id: "render-label", items: () => [{ type: "render", render: () => { throw new Error("label render failed"); } }] },
            ],
          },
        }),
      },
    });

    const { context, calls } = createContext();
    const actions = registry.getActions(context);
    const primaryContext = createPrimaryViewContext();
    const panelContext = createWorkspacePanelContext("local");
    const panels = registry.getWorkspacePanels();

    expect(actions.find((action) => action.id === "failing:enablement")).toMatchObject({ enabled: false, disabledReason: "Unavailable because its plugin could not be evaluated." });
    expect(actions.find((action) => action.id === "failing:reason")).toMatchObject({ enabled: false, disabledReason: "Unavailable because its plugin could not be evaluated." });
    void actions.find((action) => action.id === "core:view.chat")?.run();
    expect(calls).toEqual(["focusPrompt"]);
    expect(registry.getNavigationEntries(primaryContext).find((entry) => entry.id === "failing:navigation")?.badge?.(primaryContext)).toBeUndefined();
    expect(panels.find((panel) => panel.id === "failing:panel")?.badge?.(panelContext)).toBeUndefined();
    expect(panels.find((panel) => panel.id === "failing:hidden-panel")?.visible?.(panelContext)).toBe(false);
    const labelItems = registry.getWorkspaceLabelItems(createWorkspaceLabelContext("local", testWorkspace()));
    expect(labelItems[0]).toEqual({ type: "text", text: "healthy" });
    const renderLabel = labelItems.find((item) => item.type === "render");
    expect(() => renderLabel?.render()).not.toThrow();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("failing:"), expect.any(Error));
  });

  it("exposes the prompt helper to workspace panel callbacks", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: () => ({
          contributions: {
            workspacePanels: [
              {
                id: "workspace.prompt",
                title: "Prompt",
                render: (context) => {
                  context.prompt.insertText("@docs/example.md");
                  return html`<p>Prompt</p>`;
                },
              },
            ],
          },
        }),
      },
    });
    const insertText = vi.fn();
    const context = createWorkspacePanelContext("local", { insertText, getText: vi.fn(() => ""), getSelection: vi.fn(() => null) });

    registry.getWorkspacePanels()[0]?.render(context);

    expect(insertText).toHaveBeenCalledWith("@docs/example.md");
  });

  it("rejects duplicate ids within the same namespace", () => {
    const registry = new PluginRegistry();

    expect(() => {
      registry.register({
        id: "example",
        plugin: {
          apiVersion: 1,
          name: "Example",
          activate: () => ({
            contributions: {
              actions: [
                { id: "duplicate", title: "One", run: () => undefined },
                { id: "duplicate", title: "Two", run: () => undefined },
              ],
            },
          }),
        },
      });
    }).toThrow("Duplicate contribution id: example:duplicate");
  });

  it("evaluates core action enablement against runtime state", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const inactive = registry.getActions(createContext().context);
    const active = registry.getActions(createContext({ selectedWorkspace: testWorkspace() }).context);

    expect(inactive.find((action) => action.id === "core:view.files")?.enabled).toBe(false);
    expect(inactive.find((action) => action.id === "core:view.terminal")?.enabled).toBe(false);
    expect(active.find((action) => action.id === "core:view.files")?.enabled).toBe(true);
    expect(active.find((action) => action.id === "core:view.terminal")?.enabled).toBe(true);
    expect(active.find((action) => action.id === "core:workspace.delete")?.enabled).toBe(false);

    const deletable = registry.getActions(createContext({ selectedWorkspace: testWorkspace({ isMain: false, isGitWorktree: true }) }).context);
    expect(deletable.find((action) => action.id === "core:workspace.delete")?.enabled).toBe(true);
  });

  it("routes workspace delete through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedWorkspace: testWorkspace({ isMain: false, isGitWorktree: true }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:workspace.delete");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["deleteWorkspace"]);
  });

  it("offers archive only for persisted sessions and delete only for transient new sessions", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const persistedActions = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }) }).context);
    expect(persistedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(true);
    expect(persistedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);

    const unknownActions = registry.getActions(createContext({ selectedSession: testSession() }).context);
    expect(unknownActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(unknownActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);

    const transientActions = registry.getActions(createContext({ selectedSession: testSession({ persisted: false }) }).context);
    expect(transientActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(transientActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(true);

    const cachedActions = registry.getActions(createContext({ selectedSession: markCachedNewSessionInfo(testSession()) }).context);
    expect(cachedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(cachedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(true);

    const archivedActions = registry.getActions(createContext({ selectedSession: { ...testSession({ persisted: true }), archived: true, archivedAt: "2026-05-20T00:00:00.000Z" } }).context);
    expect(archivedActions.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(archivedActions.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);
  });

  it("uses selected session status as the freshest archive/delete persistence signal", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const statusPersisted = registry.getActions(createContext({ selectedSession: testSession({ persisted: false }), status: testStatus({ persisted: true }) }).context);
    expect(statusPersisted.find((action) => action.id === "core:session.archive")?.enabled).toBe(true);
    expect(statusPersisted.find((action) => action.id === "core:session.delete")?.enabled).toBe(false);

    const statusTransient = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: false }) }).context);
    expect(statusTransient.find((action) => action.id === "core:session.archive")?.enabled).toBe(false);
    expect(statusTransient.find((action) => action.id === "core:session.delete")?.enabled).toBe(true);
  });

  it("enables session disk reload only for a writable, idle session", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const reloadable = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }) }).context);
    const reloadableAction = reloadable.find((action) => action.id === "core:session.reload");
    expect(reloadableAction?.enabled).toBe(true);
    expect(reloadableAction?.title).toBe("Reload Session from Disk");
    expect(reloadableAction?.description).toContain("Use /reload in the prompt for Pi runtime resources");

    const noRuntime = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }) }).context);
    expect(noRuntime.find((action) => action.id === "core:session.reload")?.enabled).toBe(true);

    const unknown = registry.getActions(createContext({ selectedSession: testSession() }).context);
    expect(unknown.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);

    const transient = registry.getActions(createContext({ selectedSession: testSession({ persisted: false }) }).context);
    expect(transient.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);

    const archived = registry.getActions(createContext({ selectedSession: { ...testSession({ persisted: true }), archived: true, archivedAt: "2026-05-20T00:00:00.000Z" } }).context);
    expect(archived.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);

    const busy = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: true, isStreaming: true }) }).context);
    expect(busy.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);
  });

  it("treats a session that is only starting up as having no work to stop or block", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const startupActivity = { sessionId: "s1", phase: "active" as const, label: "Opening session", detail: "Starting the Pi session", at: "now", startup: true };

    const opening = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: true }), activity: startupActivity }).context);

    // Nothing is being worked on, so there is nothing to stop and no reason to
    // block a reload with "Stop current session activity before reloading".
    expect(opening.find((action) => action.id === "core:session.stop")?.enabled).toBe(false);
    expect(opening.find((action) => action.id === "core:session.reload")?.enabled).toBe(true);

    // Real work is still real work, whatever else the session is doing.
    const working = registry.getActions(createContext({ selectedSession: testSession({ persisted: true }), status: testStatus({ persisted: true, isStreaming: true }), activity: startupActivity }).context);
    expect(working.find((action) => action.id === "core:session.stop")?.enabled).toBe(true);
    expect(working.find((action) => action.id === "core:session.reload")?.enabled).toBe(false);
  });

  it("routes session reload through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedSession: testSession({ persisted: true }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:session.reload");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["reloadSession"]);
  });

  it("routes transient new session delete through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedSession: testSession({ persisted: false }) });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:session.delete");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["deleteCachedNewSession"]);
  });

  it("exposes model and thinking selectors as configurable actions for writable sessions", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });

    const unavailable = registry.getActions(createContext().context);
    expect(unavailable.find((action) => action.id === "core:model.select")?.enabled).toBe(false);
    expect(unavailable.find((action) => action.id === "core:thinking.select")?.enabled).toBe(false);

    const archivedSession = { ...testSession(), archived: true, archivedAt: "2026-05-20T00:00:00.000Z" };
    const archived = registry.getActions(createContext({ selectedSession: archivedSession }).context);
    expect(archived.find((action) => action.id === "core:model.select")?.enabled).toBe(false);
    expect(archived.find((action) => action.id === "core:thinking.select")?.enabled).toBe(false);

    const { context, calls } = createContext({ selectedSession: testSession() });
    const actions = registry.getActions(context);
    const modelAction = actions.find((action) => action.id === "core:model.select");
    const thinkingAction = actions.find((action) => action.id === "core:thinking.select");
    expect(modelAction).toMatchObject({ title: "Select Model", enabled: true });
    expect(modelAction?.shortcut).toBeUndefined();
    expect(thinkingAction).toMatchObject({ title: "Select Thinking Level", enabled: true });
    expect(thinkingAction?.shortcut).toBeUndefined();

    if (modelAction !== undefined) void modelAction.run();
    if (thinkingAction !== undefined) void thinkingAction.run();

    expect(calls).toEqual(["openModelPicker", "openThinkingLevelPicker"]);
  });

  it("routes refresh current to the active core workspace panel", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({
      selectedWorkspace: testWorkspace(),
      workspaceTool: "core:workspace.git",
    });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:workspace.refresh-current");

    if (action !== undefined) void action.run();

    expect(calls).toEqual(["refreshGit"]);
  });

  it("routes app reload and settings actions through the runtime context", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext();
    const actions = registry.getActions(context);

    expect(actions.some((candidate) => candidate.id === "core:app.refresh-data")).toBe(false);
    void actions.find((candidate) => candidate.id === "core:app.reload-page")?.run();
    void actions.find((candidate) => candidate.id === "core:settings.open")?.run();

    expect(calls).toEqual(["reloadPage", "openSettings"]);
  });

  it("exposes terminal navigation as a shortcut-backed action", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const { context, calls } = createContext({ selectedWorkspace: testWorkspace() });
    const action = registry.getActions(context).find((candidate) => candidate.id === "core:view.terminal");

    expect(action?.shortcut).toBe("mod+4");
    if (action !== undefined) void action.run();

    expect(calls).toEqual(["selectMainView:core:workspace.terminal"]);
  });

  it("keeps built-in keyboard shortcuts unique and action-backed", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "core", plugin: corePlugin });
    const shortcuts = registry.getActions(createContext({ selectedWorkspace: testWorkspace() }).context)
      .filter((action) => action.shortcut !== undefined)
      .map((action) => [action.id, action.shortcut]);

    expect(shortcuts).toEqual([
      ["core:actions.show", "mod+k"],
      ["core:prompt.focus", "mod+g c"],
      ["core:settings.open", "mod+,"],
      ["core:view.chat", "mod+1"],
      ["core:view.files", "mod+2"],
      ["core:view.git", "mod+3"],
      ["core:view.terminal", "mod+4"],
      ["core:workspace.refresh-files", "mod+shift+f"],
      ["core:workspace.refresh-git", "mod+shift+g"],
      ["core:workspace.refresh-current", "mod+shift+r"],
      ["core:session.stop", "mod+."],
    ]);
    expect(new Set(shortcuts.map(([, shortcut]) => shortcut)).size).toBe(shortcuts.length);
  });

  it("collects built-in PI WEB themes from an in-app plugin", () => {
    const registry = new PluginRegistry();
    registry.register({ id: "themes", plugin: themePackPlugin });

    expect(registry.getThemes().map((theme) => ({ id: theme.id, colorScheme: theme.colorScheme }))).toEqual([
      { id: "themes:pi-web-dark", colorScheme: "dark" },
      { id: "themes:pi-web-light", colorScheme: "light" },
      { id: "themes:github-light", colorScheme: "light" },
      { id: "themes:github-dark", colorScheme: "dark" },
      { id: "themes:classic", colorScheme: "dark" },
    ]);
    expect(registry.getThemePairs().map((pair) => ({ id: pair.id, light: pair.light, dark: pair.dark }))).toEqual([
      { id: "themes:pi-web", light: "themes:pi-web-light", dark: "themes:pi-web-dark" },
      { id: "themes:github", light: "themes:github-light", dark: "themes:github-dark" },
    ]);

    const githubLight = registry.getThemes().find((theme) => theme.id === "themes:github-light");
    const githubDark = registry.getThemes().find((theme) => theme.id === "themes:github-dark");
    expect(githubLight?.tokens).toMatchObject({
      "--pi-bg": "#f6f8fa",
      "--pi-surface": "#ffffff",
      "--pi-text": "#1f2328",
      "--pi-accent": "#0969da",
    });
    expect(githubDark?.tokens).toMatchObject({
      "--pi-bg": "#0d1117",
      "--pi-surface": "#151b23",
      "--pi-text": "#f0f6fc",
      "--pi-accent": "#4493f8",
    });
  });

  it("collects theme contributions in contribution order", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: () => ({
          contributions: {
            themes: [
              { id: "last", name: "Last", order: 20, colorScheme: "dark", tokens: testThemeTokens() },
              { id: "first", name: "First", order: 10, colorScheme: "light", tokens: testThemeTokens() },
            ],
            themePairs: [
              { id: "pair", name: "Pair", light: "first", dark: "last" },
            ],
          },
        }),
      },
    });

    expect(registry.getThemes().map((theme) => ({ id: theme.id, pluginId: theme.pluginId, localId: theme.localId, name: theme.name }))).toEqual([
      { id: "example:first", pluginId: "example", localId: "first", name: "First" },
      { id: "example:last", pluginId: "example", localId: "last", name: "Last" },
    ]);
    expect(registry.getThemePairs().map((pair) => ({ id: pair.id, pluginId: pair.pluginId, localId: pair.localId, light: pair.light, dark: pair.dark }))).toEqual([
      { id: "example:pair", pluginId: "example", localId: "pair", light: "example:first", dark: "example:last" },
    ]);
  });

  it("collects workspace label items in contribution order", () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: () => ({
          contributions: {
            workspaceLabels: [
              { id: "last", order: 20, items: () => [{ type: "text", text: "last" }] },
              { id: "hidden", order: 5, visible: () => false, items: () => [{ type: "text", text: "hidden" }] },
              { id: "first", order: 10, items: () => [{ type: "link", text: "web", href: "http://localhost:5173" }] },
            ],
          },
        }),
      },
    });

    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("local", workspace))).toEqual([
      { type: "link", text: "web", href: "http://localhost:5173" },
      { type: "text", text: "last" },
    ]);
  });

  it("passes workspace label file and host helpers to callbacks", () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    const readFile = vi.fn<WorkspaceFiles["readFile"]>(() => Promise.resolve(testFileContent("docker/development.be-go.local.env")));
    const requestRender = vi.fn<WorkspaceHost["requestRender"]>();
    const visible = vi.fn<(context: WorkspaceLabelContext) => boolean>(() => true);
    const items = vi.fn<(context: WorkspaceLabelContext) => WorkspaceLabelItem[]>((context) => {
      void context.files.readFile("docker/development.be-go.local.env");
      context.host.requestRender();
      return [{ type: "text", text: context.machine.id }];
    });
    const context = createWorkspaceLabelContext("remote-1", workspace, { files: { readFile, listFiles: vi.fn<WorkspaceFiles["listFiles"]>(() => Promise.resolve(testFileTreeResponse())), writeFile: vi.fn<WorkspaceFiles["writeFile"]>(() => Promise.resolve(testWriteFileResponse())), deleteFile: vi.fn<WorkspaceFiles["deleteFile"]>(() => Promise.resolve(testDeleteFileResponse())), moveFile: vi.fn<WorkspaceFiles["moveFile"]>(() => Promise.resolve(testMoveFileResponse())) }, host: { requestRender } });

    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: () => ({
          contributions: {
            workspaceLabels: [{ id: "env", visible, items }],
          },
        }),
      },
    });

    expect(registry.getWorkspaceLabelItems(context)).toEqual([{ type: "text", text: "remote-1" }]);
    expect(visible).toHaveBeenCalledWith(context);
    expect(items).toHaveBeenCalledWith(context);
    expect(readFile).toHaveBeenCalledWith("docker/development.be-go.local.env");
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("only exposes machine-scoped plugin contributions for their machine", () => {
    const registry = new PluginRegistry();
    const pluginId = machineScopedPluginId("remote-1", "project-tools");
    const workspace = testWorkspace();
    registry.register({
      id: pluginId,
      machineId: "remote-1",
      sourcePluginId: "project-tools",
      plugin: {
        apiVersion: 1,
        name: "Project Tools",
        activate: () => ({
          contributions: {
            actions: [{ id: "do-thing", title: "Do Thing", run: () => undefined }],
            workspacePanels: [{ id: "workspace.tools", title: "Tools", render: () => html`<p>Tools</p>` }],
            workspaceLabels: [{ id: "badge", items: () => [{ type: "text", text: "remote" }] }],
            themes: [{ id: "remote-theme", name: "Remote Theme", colorScheme: "dark", tokens: testThemeTokens() }],
          },
        }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).not.toContain(`${pluginId}:do-thing`);
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toContain(`${pluginId}:do-thing`);

    const panel = registry.getWorkspacePanels().find((candidate) => candidate.id === `${pluginId}:workspace.tools`);
    expect(panel?.visible?.(createWorkspacePanelContext("local"))).toBe(false);
    expect(panel?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(true);

    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("local", workspace))).toEqual([]);
    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("remote-1", workspace))).toEqual([{ type: "text", text: "remote" }]);
    expect(registry.getThemes()).toEqual([]);
  });

  it("prefers gateway plugins over remote plugins with the same source id", () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "shared-tools");
    const workspace = testWorkspace();
    registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "shared-tools",
      plugin: {
        apiVersion: 1,
        name: "Remote Shared Tools",
        activate: () => ({
          contributions: {
            actions: [{ id: "remote-action", title: "Remote Action", run: () => undefined }],
            workspacePanels: [{ id: "workspace.remote", title: "Remote", render: () => html`<p>Remote</p>` }],
            workspaceLabels: [{ id: "remote-label", items: () => [{ type: "text", text: "remote" }] }],
          },
        }),
      },
    });

    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toContain(`${remotePluginId}:remote-action`);

    registry.register({
      id: "shared-tools",
      plugin: {
        apiVersion: 1,
        name: "Gateway Shared Tools",
        activate: () => ({
          contributions: {
            actions: [{ id: "gateway-action", title: "Gateway Action", run: () => undefined }],
            workspacePanels: [{ id: "workspace.gateway", title: "Gateway", render: () => html`<p>Gateway</p>` }],
            workspaceLabels: [{ id: "gateway-label", items: () => [{ type: "text", text: "gateway" }] }],
          },
        }),
      },
    });

    const remoteActions = registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id);
    expect(remoteActions).toContain("shared-tools:gateway-action");
    expect(remoteActions).not.toContain(`${remotePluginId}:remote-action`);

    const panels = registry.getWorkspacePanels();
    expect(panels.find((panel) => panel.id === `${remotePluginId}:workspace.remote`)?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(false);
    expect(panels.find((panel) => panel.id === "shared-tools:workspace.gateway")?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(true);
    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("remote-1", workspace))).toEqual([{ type: "text", text: "gateway" }]);
    expect(registry.shouldLoadRemotePlugin("shared-tools")).toBe(false);
    expect(registry.shouldLoadRemotePlugin("shared-tools", true)).toBe(true);
  });

  it("uses machine-specific remote duplicates instead of the gateway plugin for that machine", () => {
    const registry = new PluginRegistry();
    const workspace = testWorkspace();
    const remotePluginId = machineScopedPluginId("remote-1", "updates");
    registry.register({
      id: "updates",
      machineSpecific: true,
      plugin: {
        apiVersion: 1,
        name: "Gateway Updates",
        activate: () => ({
          contributions: {
            actions: [{ id: "open", title: "Open Gateway Updates", run: () => undefined }],
            workspacePanels: [{ id: "workspace.updates", title: "Gateway Updates", render: () => html`<p>Gateway</p>` }],
            workspaceLabels: [{ id: "label", items: () => [{ type: "text", text: "gateway" }] }],
          },
        }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).toContain("updates:open");
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).not.toContain("updates:open");
    expect(registry.shouldLoadRemotePlugin("updates")).toBe(true);

    registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "updates",
      plugin: {
        apiVersion: 1,
        name: "Remote Updates",
        activate: () => ({
          contributions: {
            actions: [{ id: "open", title: "Open Remote Updates", run: () => undefined }],
            workspacePanels: [{ id: "workspace.updates", title: "Remote Updates", render: () => html`<p>Remote</p>` }],
            workspaceLabels: [{ id: "label", items: () => [{ type: "text", text: "remote" }] }],
          },
        }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).toContain("updates:open");
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toEqual([`${remotePluginId}:open`]);

    const panels = registry.getWorkspacePanels();
    expect(panels.find((panel) => panel.id === "updates:workspace.updates")?.visible?.(createWorkspacePanelContext("local"))).toBe(true);
    expect(panels.find((panel) => panel.id === "updates:workspace.updates")?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(false);
    expect(panels.find((panel) => panel.id === `${remotePluginId}:workspace.updates`)?.visible?.(createWorkspacePanelContext("remote-1"))).toBe(true);

    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("local", workspace))).toEqual([{ type: "text", text: "gateway" }]);
    expect(registry.getWorkspaceLabelItems(createWorkspaceLabelContext("remote-1", workspace))).toEqual([{ type: "text", text: "remote" }]);
  });

  it("allows a machine-specific remote duplicate to override a portable gateway plugin for that machine", () => {
    const registry = new PluginRegistry();
    const remotePluginId = machineScopedPluginId("remote-1", "status-tools");
    registry.register({
      id: "status-tools",
      plugin: {
        apiVersion: 1,
        name: "Gateway Status Tools",
        activate: () => ({ contributions: { actions: [{ id: "open", title: "Open Gateway Status", run: () => undefined }] } }),
      },
    });

    expect(registry.shouldLoadRemotePlugin("status-tools")).toBe(false);
    expect(registry.shouldLoadRemotePlugin("status-tools", true)).toBe(true);
    registry.register({
      id: remotePluginId,
      machineId: "remote-1",
      sourcePluginId: "status-tools",
      machineSpecific: true,
      plugin: {
        apiVersion: 1,
        name: "Remote Status Tools",
        activate: () => ({ contributions: { actions: [{ id: "open", title: "Open Remote Status", run: () => undefined }] } }),
      },
    });

    expect(registry.getActions(createContext().context).map((action) => action.id)).toEqual(["status-tools:open"]);
    expect(registry.getActions(createContext({ selectedMachine: testMachine("remote-1") }).context).map((action) => action.id)).toEqual([`${remotePluginId}:open`]);
  });

  it("does not activate remote duplicates when the gateway plugin is already registered", () => {
    const registry = new PluginRegistry();
    const remoteActivate = vi.fn(() => ({ contributions: { actions: [{ id: "remote-action", title: "Remote Action", run: () => undefined }] } }));
    registry.register({ id: "shared-tools", plugin: { apiVersion: 1, name: "Gateway Shared Tools", activate: () => ({ contributions: {} }) } });

    registry.register({
      id: machineScopedPluginId("remote-1", "shared-tools"),
      machineId: "remote-1",
      sourcePluginId: "shared-tools",
      plugin: { apiVersion: 1, name: "Remote Shared Tools", activate: remoteActivate },
    });

    expect(remoteActivate).not.toHaveBeenCalled();
  });
});

function testWorkspace(patch: Partial<Workspace> = {}): Workspace {
  return { id: "w1", projectId: "p1", path: "/tmp/project", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false, effectiveConfig: {}, ...patch };
}

function createWorkspaceLabelContext(machineId: string, workspace = testWorkspace(), helpers: Partial<Pick<WorkspaceLabelContext, "files" | "host">> = {}): WorkspaceLabelContext {
  const files: WorkspaceFiles = helpers.files ?? { readFile: vi.fn<WorkspaceFiles["readFile"]>(() => Promise.resolve(testFileContent())), listFiles: vi.fn<WorkspaceFiles["listFiles"]>(() => Promise.resolve(testFileTreeResponse())), writeFile: vi.fn<WorkspaceFiles["writeFile"]>(() => Promise.resolve(testWriteFileResponse())), deleteFile: vi.fn<WorkspaceFiles["deleteFile"]>(() => Promise.resolve(testDeleteFileResponse())), moveFile: vi.fn<WorkspaceFiles["moveFile"]>(() => Promise.resolve(testMoveFileResponse())) };
  const host: WorkspaceHost = helpers.host ?? { requestRender: vi.fn<WorkspaceHost["requestRender"]>() };
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { ...initialAppState(), selectedMachine: testMachine(machineId) },
    files,
    host,
  };
}

function createWorkspacePanelContext(machineId: string, prompt: WorkspacePanelContext["prompt"] = { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) }): WorkspacePanelContext {
  const workspace = testWorkspace();
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { ...initialAppState(), selectedMachine: testMachine(machineId) },
    files: { readFile: vi.fn(), listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    prompt,
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

function testFileContent(path = "README.md"): FileContentResponse {
  return {
    path,
    encoding: "utf8",
    size: 0,
    modifiedAt: "2026-05-20T00:00:00.000Z",
    content: "",
    truncated: false,
    binary: false,
  };
}

function testStatus(patch: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "s1",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...patch,
  };
}

function testFileTreeResponse(path = ".pi-web/relays"): FileTreeResponse {
  return {
    path,
    entries: [],
    scannedAt: "2026-05-20T00:00:00.000Z",
    truncated: false,
  };
}

function testWriteFileResponse(path = "README.md"): WriteWorkspaceFileResponse {
  return {
    path,
    size: 0,
    modifiedAt: "2026-05-20T00:00:00.000Z",
    created: true,
  };
}

function testDeleteFileResponse(path = "README.md"): DeleteWorkspaceFileResponse {
  return {
    path,
    existed: true,
  };
}

function testMoveFileResponse(fromPath = "old.txt", toPath = "new.txt"): MoveWorkspaceFileResponse {
  return {
    fromPath,
    toPath,
    size: 0,
    modifiedAt: "2026-05-20T00:00:00.000Z",
  };
}

function testMachine(id: string) {
  return { id, name: id, kind: id === "local" ? "local" as const : "remote" as const, createdAt: "2026-05-20T00:00:00.000Z", updatedAt: "2026-05-20T00:00:00.000Z" };
}

function testSession(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    path: "/tmp/s1.jsonl",
    cwd: "/tmp/project",
    created: "2026-05-20T00:00:00.000Z",
    modified: "2026-05-20T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "Hello",
    ...patch,
  };
}

function testThemeTokens(): ThemeTokens {
  return {
    "--pi-bg": "#000000",
    "--pi-surface": "#000000",
    "--pi-surface-hover": "#000000",
    "--pi-terminal-bg": "#000000",
    "--pi-terminal-text": "#000000",
    "--pi-border": "#000000",
    "--pi-border-muted": "#000000",
    "--pi-text": "#000000",
    "--pi-text-secondary": "#000000",
    "--pi-text-bright": "#000000",
    "--pi-muted": "#000000",
    "--pi-dim": "#000000",
    "--pi-accent": "#000000",
    "--pi-accent-border": "#000000",
    "--pi-selection-bg": "#000000",
    "--pi-success": "#000000",
    "--pi-success-border": "#000000",
    "--pi-success-bg": "#000000",
    "--pi-success-surface": "#000000",
    "--pi-success-ring": "#000000",
    "--pi-warning": "#000000",
    "--pi-warning-border": "#000000",
    "--pi-warning-surface": "#000000",
    "--pi-danger": "#000000",
    "--pi-purple": "#000000",
    "--pi-purple-border": "#000000",
    "--pi-purple-surface": "#000000",
    "--pi-overlay": "#000000",
    "--pi-shadow-soft": "#000000",
    "--pi-shadow": "#000000",
    "--pi-shadow-strong": "#000000",
    "--pi-bg-overlay-soft": "#000000",
    "--pi-bg-overlay": "#000000",
    "--pi-success-bg-overlay": "#000000",
    "--pi-terminal-selection": "#000000",
  };
}
