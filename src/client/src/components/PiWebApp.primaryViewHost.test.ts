// @vitest-environment happy-dom
import { html, render as renderTemplate } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Machine, Project, SessionInfo, SessionStatus, Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import type { PluginRuntimeContext, PrimaryViewContext } from "../plugins/types";
import { PluginRegistry } from "../plugins/registry";
import { SessionController } from "../controllers/sessionController";
import { PiWebApp } from "./PiWebApp";
import type { WorkspacePanel } from "./WorkspacePanel";
import { AppPrimaryView } from "./appShell/AppPrimaryView";

const DEDICATED_VIEW = "example:views.work";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }))));
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp primary-view host", () => {
  it("gives a dedicated primary view host-owned chat and workspace surfaces without outer chrome", async () => {
    const app = createDedicatedApp((context) => {
      const pluginView = document.createElement("div");
      pluginView.id = "plugin-view";
      for (const surface of ["chat", "files", "git", "terminal"] as const) {
        const container = document.createElement("div");
        context.surfaceHost?.mount(container, surface);
        pluginView.append(container);
      }
      return html`${pluginView}`;
    });
    appShell(app).isMobileNavigationLayout = true;

    renderTemplate(app.render(), document.body);
    const primaryView = requiredElement(document.body, "app-primary-view", AppPrimaryView);
    await primaryView.updateComplete;

    const shell = requiredElement(document.body, ".shell", HTMLDivElement);
    expect(shell.classList.contains("dedicated-shell")).toBe(true);
    expect(shell.querySelector("app-pi-menu")).not.toBeNull();
    expect(directChild(shell, "aside")).toBeUndefined();
    expect(directChild(shell, "workspace-panel")).toBeUndefined();
    expect(document.querySelector("app-context-bar")).toBeNull();
    expect(document.querySelector("app-mobile-main-tabs")).toBeNull();

    const surface = primaryView.shadowRoot;
    if (surface === null) throw new Error("Primary view shadow root was unavailable");
    expect(surface.querySelector("chat-view")).not.toBeNull();
    expect(surface.querySelector("prompt-editor")).not.toBeNull();
    expect(surface.querySelector("status-bar")).not.toBeNull();
    const workspaceSurfaces = [...surface.querySelectorAll<WorkspacePanel>("workspace-panel")];
    expect(workspaceSurfaces.map((panel) => panel.tool)).toEqual([
      "core:workspace.files",
      "core:workspace.git",
      "core:workspace.terminal",
    ]);
    expect(workspaceSurfaces.every((panel) => panel.hideToolTabs)).toBe(true);
  });

  it("keeps the fixed Pi menu out of the default shell navigation composition", () => {
    const app = createDedicatedApp(() => html`<p>Work</p>`);
    setAppState(app, { ...appState(app), mainView: "chat" });

    const container = document.createElement("div");
    renderTemplate(app.render(), container);

    const shell = requiredElement(container, ".shell", HTMLDivElement);
    expect(shell.classList.contains("dedicated-shell")).toBe(false);
    expect(shell.querySelector("app-pi-menu")).toBeNull();
    expect(directChild(shell, "aside")).toBeDefined();
  });

  it("refreshes mounted surfaces in place instead of disconnecting their host elements", () => {
    const app = createDedicatedApp(() => html`<p>Work</p>`);
    const container = document.createElement("div");
    document.body.append(container);
    const surfaceHost = primaryViewContext(app).surfaceHost;
    if (surfaceHost === undefined) throw new Error("Primary surface host was unavailable");

    surfaceHost.mount(container, "chat");
    const before = requiredElement(container, "prompt-editor", HTMLElement);
    before.dataset["draftMarker"] = "preserved";

    refreshMountedPrimaryViewSurfaces(app);

    const after = requiredElement(container, "prompt-editor", HTMLElement);
    expect(after).toBe(before);
    expect(after.dataset["draftMarker"]).toBe("preserved");
  });

  it("keeps host action access available to a dedicated primary view", () => {
    const app = createDedicatedApp(() => html`<p>Work</p>`);
    const context = primaryViewContext(app);

    const openActions = context.host.openActions;
    expect(openActions).toBeTypeOf("function");
    openActions?.();

    expect(appState(app).actionPaletteOpen).toBe(true);
  });

  it("exposes namespaced preferences and a pure immutable pending-ask snapshot", () => {
    const app = createDedicatedApp(() => html`<p>Work</p>`);
    const state = appState(app);
    const session = requiredSession(state.sessions[0]);
    setAppState(app, { ...state, sessionStatuses: { [session.id]: pendingAskStatus(session.id, "ask-1") } });
    const context = primaryViewContext(app);

    context.preferences?.set("selected-session:work", session.id);
    expect(context.preferences?.get("selected-session:work")).toBe(session.id);
    expect(context.attention?.snapshot().items).toEqual([]);

    observeSessionAttention(app);
    const snapshot = context.attention?.snapshot();
    expect(snapshot?.reconnectComplete).toBe(true);
    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.items[0]).toMatchObject({ sessionId: session.id, askId: "ask-1" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.items)).toBe(true);
    expect(Object.isFrozen(snapshot?.items[0])).toBe(true);
  });

  it("prunes unobservable asks when attention observation moves to another machine", () => {
    const app = createDedicatedApp(() => html`<p>Work</p>`);
    const machineA = testMachine("machine-a");
    const machineB = testMachine("machine-b");
    const sessionA = testSession("session-a");
    const sessionB = testSession("session-b");
    setAppState(app, {
      ...appState(app),
      machines: [machineA, machineB],
      selectedMachine: machineA,
      sessions: [sessionA],
      selectedSession: sessionA,
      sessionStatuses: { [sessionA.id]: pendingAskStatus(sessionA.id, "ask-a") },
    });
    observeSessionAttention(app);
    publishSessionAttention(app);
    const context = primaryViewContext(app);
    const watched: (readonly string[])[] = [];
    const release = context.attention?.watch((snapshot) => { watched.push(snapshot.items.map((item) => item.identity)); });

    setAppState(app, {
      ...appState(app),
      selectedMachine: machineB,
      sessions: [sessionB],
      selectedSession: sessionB,
      sessionStatuses: {},
    });
    observeSessionAttention(app);
    publishSessionAttention(app);

    expect(context.attention?.snapshot().items).toEqual([]);
    expect(watched.at(-1)).toEqual([]);
    release?.();
  });

  it("retains observed asks across workspaces on the same connected machine", () => {
    const app = createDedicatedApp(() => html`<p>Work</p>`);
    const sessionA = testSession("session-a");
    const sessionB = testSession("session-b");
    setAppState(app, {
      ...appState(app),
      sessions: [sessionA],
      selectedSession: sessionA,
      sessionStatuses: { [sessionA.id]: pendingAskStatus(sessionA.id, "ask-a") },
    });
    observeSessionAttention(app);

    setAppState(app, {
      ...appState(app),
      sessions: [sessionB],
      selectedSession: sessionB,
      sessionStatuses: { [sessionB.id]: pendingAskStatus(sessionB.id, "ask-b") },
    });
    observeSessionAttention(app);

    expect(primaryViewContext(app).attention?.snapshot().items.map((item) => item.askId)).toEqual(["ask-a", "ask-b"]);
  });

  it("routes core surface actions through a dedicated primary view", () => {
    const app = createDedicatedApp(() => html`<p>Work</p>`);
    const selected: string[] = [];
    const unregister = primaryViewContext(app).surfaceHost?.registerSelectionHandler?.((surface) => { selected.push(surface); });
    if (unregister === undefined) throw new Error("Primary surface selection registration was unavailable");
    const runtime = pluginRuntimeContext(app);

    runtime.focusPrompt();
    runtime.selectMainView("core:workspace.files");
    runtime.selectMainView("core:workspace.git");
    runtime.selectMainView("core:workspace.terminal");

    expect(selected).toEqual(["chat", "files", "git", "terminal"]);
    expect(appState(app).mainView).toBe(DEDICATED_VIEW);

    unregister();
    runtime.selectMainView("core:workspace.files");
    expect(appState(app).mainView).toBe("core:workspace.files");
  });

  it("selects a plugin session without leaving the dedicated view while open still navigates to Chat", async () => {
    const app = createDedicatedApp(() => html`<p>Work</p>`);
    const controller = appSessionController(app);
    vi.spyOn(controller, "selectSession").mockImplementation((session) => {
      setAppState(app, { ...appState(app), selectedSession: session, mainView: "chat" });
      return Promise.resolve();
    });
    const focusChatComposer = vi.fn(() => {
      setAppState(app, { ...appState(app), mainView: "chat" });
      return Promise.resolve();
    });
    if (!Reflect.set(app, "focusChatComposer", focusChatComposer)) throw new Error("Could not replace chat navigation boundary");
    const sessions = primaryViewContext(app).sessions;
    if (sessions === undefined) throw new Error("Plugin session host was unavailable");

    await sessions.select({ sessionId: "session-1" });

    expect(appState(app).mainView).toBe(DEDICATED_VIEW);
    expect(focusChatComposer).not.toHaveBeenCalled();

    await sessions.open({ sessionId: "session-1" });

    expect(appState(app).mainView).toBe("chat");
    expect(focusChatComposer).toHaveBeenCalledOnce();
  });
});

function createDedicatedApp(render: (context: PrimaryViewContext) => ReturnType<typeof html>): PiWebApp {
  const app = new PiWebApp();
  appRegistry(app).register({
    id: "example",
    plugin: {
      apiVersion: 1,
      name: "Example",
      activate: () => ({
        contributions: {
          primaryViews: [{ id: "views.work", title: "Work", layout: "dedicated", render }],
        },
      }),
    },
  });
  const project = testProject();
  const workspace = testWorkspace();
  const session = testSession();
  setAppState(app, {
    ...initialAppState(),
    projects: [project],
    selectedProject: project,
    workspaces: [workspace],
    selectedWorkspace: workspace,
    sessions: [session],
    selectedSession: session,
    mainView: DEDICATED_VIEW,
  });
  return app;
}

function observeSessionAttention(app: PiWebApp): void {
  invokeAppMethod(app, "observeSessionAttention");
}

function publishSessionAttention(app: PiWebApp): void {
  invokeAppMethod(app, "publishSessionAttentionSnapshot");
}

function invokeAppMethod(app: PiWebApp, name: string): void {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`PiWebApp.${name} was unavailable`);
  Reflect.apply(method, app, []);
}

function refreshMountedPrimaryViewSurfaces(app: PiWebApp): void {
  const method: unknown = Reflect.get(app, "refreshPrimaryViewSurfaceMounts");
  if (typeof method !== "function") throw new Error("Primary surface refresh boundary was unavailable");
  Reflect.apply(method, app, []);
}

function primaryViewContext(app: PiWebApp): PrimaryViewContext {
  const method: unknown = Reflect.get(app, "createPrimaryViewContext");
  if (typeof method !== "function") throw new Error("Primary view context factory was unavailable");
  const context: unknown = Reflect.apply(method, app, []);
  if (!isPrimaryViewContext(context)) throw new Error("Primary view context was invalid");
  return context;
}

function isPrimaryViewContext(value: unknown): value is PrimaryViewContext {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "host") === "object";
}

function pluginRuntimeContext(app: PiWebApp): PluginRuntimeContext {
  const method: unknown = Reflect.get(app, "createPluginRuntimeContext");
  if (typeof method !== "function") throw new Error("Plugin runtime context factory was unavailable");
  const context: unknown = Reflect.apply(method, app, []);
  if (!isPluginRuntimeContext(context)) throw new Error("Plugin runtime context was invalid");
  return context;
}

function isPluginRuntimeContext(value: unknown): value is PluginRuntimeContext {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "focusPrompt") === "function"
    && typeof Reflect.get(value, "selectMainView") === "function";
}

function appRegistry(app: PiWebApp): PluginRegistry {
  const registry: unknown = Reflect.get(app, "plugins");
  if (!(registry instanceof PluginRegistry)) throw new Error("Plugin registry was unavailable");
  return registry;
}

function appSessionController(app: PiWebApp): SessionController {
  const controller: unknown = Reflect.get(app, "sessions");
  if (!(controller instanceof SessionController)) throw new Error("Session controller was unavailable");
  return controller;
}

function appShell(app: PiWebApp): { isMobileNavigationLayout: boolean } {
  const shell: unknown = Reflect.get(app, "appShell");
  if (!isAppShell(shell)) throw new Error("App shell controller was unavailable");
  return shell;
}

function isAppShell(value: unknown): value is { isMobileNavigationLayout: boolean } {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "isMobileNavigationLayout") === "boolean";
}

function appState(app: PiWebApp): AppState {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("App state was unavailable");
  return state;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "sessions"));
}

function setAppState(app: PiWebApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function requiredElement<T extends Element>(root: ParentNode, selector: string, constructor: abstract new (...args: never[]) => T): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Expected ${selector}`);
  return element;
}

function directChild(root: Element, tagName: string): Element | undefined {
  return [...root.children].find((element) => element.localName === tagName);
}

function testProject(): Project {
  return { id: "project-1", name: "Project", path: "/repo", createdAt: "2026-01-01T00:00:00.000Z" };
}

function testWorkspace(): Workspace {
  return { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
}

function testMachine(id: string): Machine {
  return {
    id,
    name: id,
    kind: "remote",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function pendingAskStatus(sessionId: string, askId: string): SessionStatus {
  return {
    sessionId,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    pendingAsk: { askId, askedAt: "2026-01-01T00:00:00.000Z", questions: [{ id: "q1", question: "Proceed?", options: [{ value: "yes", label: "Yes" }] }] },
  };
}

function requiredSession(session: SessionInfo | undefined): SessionInfo {
  if (session === undefined) throw new Error("Expected session");
  return session;
}

function testSession(id = "session-1"): SessionInfo {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    cwd: "/repo",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "Hello",
  };
}
