// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Machine, type Project, type SessionInfo, type Workspace } from "../api";
import { initialAppState, type AppState } from "../appState";
import { ACTIVITY_STATUS_KEY, GOAL_STATUS_KEY } from "../extensionStatusSnapshots";
import { DesktopNotificationController } from "../controllers/desktopNotificationController";
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_CSS_PROPERTY, INTERFACE_SCALE_STORAGE_KEY, readStoredInterfaceScale } from "../interfaceScale";
import { machineSessionKey } from "../machineKeys";
import { readStoredPresentationProfile } from "../presentationProfiles";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { readStoredThemePreference } from "../theme";
import type { ChatView } from "./ChatView";
import { DelegateRoster } from "./DelegateRoster";
import type { FormattedText } from "./FormattedText";
import { GoalStatusChip } from "./GoalStatusChip";
import { PromptEditor } from "./PromptEditor";
import { WorkbenchApp, rootProjectOf, rootProjects } from "./WorkbenchApp";
import type { WorkbenchFilesPane } from "./WorkbenchFilesPane";
import { WorkbenchSettingsPanel } from "./WorkbenchSettingsPanel";
import { WorkstreamContextDrawer } from "./WorkstreamContextDrawer";

beforeEach(() => {
  vi.spyOn(api, "machines").mockResolvedValue([machine]);
  vi.spyOn(api, "projects").mockResolvedValue([]);
  vi.spyOn(api, "notificationInbox").mockImplementation((selected) => Promise.resolve({
    daemonInstanceId: "daemon",
    catalogRevision: 0,
    summary: { sessionId: selected.id, cwd: selected.cwd, inboxRevision: 0, retainedCount: 0, discardedCount: 0 },
    notifications: [],
    dismissThrough: { order: 0, overflowWatermark: 0 },
  }));
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/plugins")
    ? pluginLifecycleResponse()
    : new Response(JSON.stringify({ ok: true, value: [] }), { status: 200 }))));
  vi.stubGlobal("WebSocket", SilentWebSocket);
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project tabs", () => {
  it("nests projects that live inside another project's path", () => {
    const embabel: Project = { ...project, id: "embabel", name: "embabel", path: "/ideas/embabel" };
    const me: Project = { ...project, id: "me", name: "me", path: "/ideas/embabel/me" };
    const realm: Project = { ...project, id: "realm", name: "realm", path: "/ideas/embabel/realms/realm-photoquest" };
    const other: Project = { ...project, id: "other", name: "other", path: "/ideas/other" };
    const all = [me, other, embabel, realm];
    expect(rootProjects(all).map((candidate) => candidate.id)).toEqual(["other", "embabel"]);
    expect(rootProjectOf(realm, all).id).toBe("embabel");
    expect(rootProjectOf(other, all).id).toBe("other");
  });
});

describe("Chat in a folder", () => {
  it("shows the associated Workstream through a registered workspace without registering the Chat folder", async () => {
    const current = { ...session("adhoc", "Investigate", "Nested chat"), cwd: "/outside/nested" };
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, ({ operation }) => operation === "watch"
      ? { ok: true, value: { mode: "replay", events: [], nextSequence: 1 } }
      : operation === "list" ? { ok: true, value: [{ id: "learning" }] }
      : { ok: true, value: { id: "learning", title: "Source learning", revision: 1, sessions: [{ id: current.id, status: "active" }], humanTasks: [], links: [], overview: null, closed: false } }, undefined, true);
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    const workspaces = vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: current.cwd });
    vi.spyOn(api, "sessions").mockResolvedValue([current]);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: current.id, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    vi.spyOn(api, "streamSnapshot").mockResolvedValue({ seq: 0, partial: null });
    vi.spyOn(api, "thinkingLevels").mockResolvedValue({ levels: [] });
    window.history.replaceState({}, "", `/?session=${current.id}&view=chat`);
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(drawerTitle(app)).toBe("Source learning"); });
    expect(getState(app).selectedProject).toBeUndefined();
    expect(getState(app).selectedWorkspace?.path).toBe(current.cwd);
    expect(app.shadowRoot?.querySelector(".chat-shell header > span")?.textContent.trim()).toBe("nested");
    expect(workspaces).toHaveBeenCalledWith(project.id, machine.id);
    expect(calls.some(({ operation, input }) => operation === "list" && input["sessionId"] === current.id)).toBe(true);
    const drawer = app.shadowRoot?.querySelector<WorkstreamContextDrawer>("workstream-context-drawer");
    expect(drawer?.serviceContext).toEqual({ machineId: machine.id, projectId: project.id, workspaceId: workspace.id });
    expect(calls.some(({ operation }) => operation === "watch")).toBe(true);
    const reload: unknown = Reflect.get(app, "loadCurrentWorkstream");
    if (typeof reload !== "function") throw new Error("Workstream loader missing");
    await Reflect.apply(reload, app, []);
    expect(workspaces).toHaveBeenCalledOnce();
  });

  it("keeps the Chat title with a tooltip when no registered project can provide Workstream access", async () => {
    const current = { ...session("adhoc", "Investigate", "Nested chat"), cwd: "/outside/nested" };
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: current.cwd });
    vi.spyOn(api, "sessions").mockResolvedValue([current]);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: current.id, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    vi.spyOn(api, "streamSnapshot").mockResolvedValue({ seq: 0, partial: null });
    vi.spyOn(api, "thinkingLevels").mockResolvedValue({ levels: [] });
    window.history.replaceState({}, "", `/?session=${current.id}&view=chat`);
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(drawerTitle(app)).toBe("Nested chat"); expect(Reflect.get(app, "currentWorkstream")).toBeNull(); });
    const drawer = app.shadowRoot?.querySelector<WorkstreamContextDrawer>("workstream-context-drawer");
    await drawer?.updateComplete;
    expect(drawer?.shadowRoot?.querySelector(".tab")?.getAttribute("title")).toContain("registered project");
  });
  it("starts a Chat in a picked folder without a project and reopens it from the session id alone", async () => {
    vi.spyOn(api, "projects").mockResolvedValue([]);
    const started = session("adhoc", "");
    started.cwd = "/anywhere/notes";
    vi.spyOn(api, "startSession").mockResolvedValue(started);
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: "/anywhere/notes" });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "adhoc", persisted: false, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    window.piWebNative = { pickDirectory: () => Promise.resolve("/anywhere/notes"), notify: () => Promise.resolve() };

    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(false); });
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector('button[aria-label="Chat in a folder…"] svg')).not.toBeNull();
    expect(app.shadowRoot?.querySelector('button[aria-label="Add project…"] svg')).not.toBeNull();
    app.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Chat in a folder…"]')?.click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("adhoc"); });
    expect(getState(app).selectedWorkspace?.path).toBe("/anywhere/notes");
    expect(window.location.search).toBe("?session=adhoc&view=chat");

    document.body.replaceChildren();
    const reopened = new WorkbenchApp();
    document.body.append(reopened);
    await vi.waitFor(() => { expect(getState(reopened).selectedSession?.id).toBe("adhoc"); });
    expect(getState(reopened).selectedWorkspace?.path).toBe("/anywhere/notes");
    delete window.piWebNative;
  });
});

describe("Workbench Chat chooser", () => {
  it("does not use the previous Chat's Workstream title for a new Chat", async () => {
    const app = await mountChooser([]);
    setState(app, { ...getState(app), selectedSession: session("first", "", "") });
    Reflect.set(app, "currentWorkstream", { id: "old", title: "Old Workstream", sessions: [] });
    const setApp: unknown = Reflect.get(app, "setApp");
    if (typeof setApp !== "function") throw new Error("State updater unavailable");
    Reflect.apply(setApp, app, [{ selectedSession: session("second", "", "") }]);
    expect(Reflect.get(app, "currentWorkstream")).toBeUndefined();
  });

  it("opens the originating Chat when a background browser notification is clicked", async () => {
    const shown: FakeBrowserNotification[] = [];
    class ClickNotification extends FakeBrowserNotification {
      static override permission: NotificationPermission = "granted";
      constructor() { super(); shown.push(this); }
    }
    vi.stubGlobal("Notification", ClickNotification);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const first = session("first", "First", "First Chat");
    const second = session("second", "Second", "Second Chat");
    const app = await mountChooser([first, second]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "sessions").mockResolvedValue([first, second]);
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "first", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    setState(app, { ...getState(app), selectedSession: first });
    const controller: unknown = Reflect.get(app, "desktopNotifications");
    if (!(controller instanceof DesktopNotificationController)) throw new Error("Notification controller unavailable");
    controller.activate(getState(app));
    controller.sessionError(getState(app), "Needs attention", 1);
    expect(shown).toHaveLength(1);
    setState(app, { ...getState(app), selectedSession: second });
    shown[0]?.onclick?.(new Event("click"));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("first"); });
    expect(window.location.search).toContain("session=first");
  });
  it("routes a background Chat's global attention notification to its Chat", async () => {
    const shown: FakeBrowserNotification[] = [];
    class ClickNotification extends FakeBrowserNotification {
      static override permission: NotificationPermission = "granted";
      constructor() { super(); shown.push(this); }
    }
    vi.stubGlobal("Notification", ClickNotification);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const first = session("first", "First", "First Chat");
    const second = session("second", "Second", "Second Chat");
    const app = await mountChooser([first, second]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "sessions").mockResolvedValue([first, second]);
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "second", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    setState(app, { ...getState(app), selectedSession: first });
    const receive: unknown = Reflect.get(app, "handleRealtimeEvent");
    if (typeof receive !== "function") throw new Error("Global event handler unavailable");
    Reflect.apply(receive, app, [{ type: "session.attention", sessionId: "second", cwd: workspace.path, sessionName: "Second Chat", kind: "ask", id: "ask-1", detail: "Continue?" }]);
    expect(shown).toHaveLength(1);
    shown[0]?.onclick?.(new Event("click"));
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("second"); });
    expect(window.location.search).toContain("session=second");
  });

  it("offers notification permission through an explicit accessible gesture and hides the control after denial", async () => {
    FakeBrowserNotification.permission = "default";
    vi.stubGlobal("Notification", FakeBrowserNotification);
    const app = await mountChooser([]);
    const button = app.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Enable desktop notifications"]');

    expect(button?.title).toBe("Enable desktop notifications");
    button?.click();
    await vi.waitFor(() => { expect(FakeBrowserNotification.requestPermission).toHaveBeenCalledOnce(); });
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector('button[aria-label="Enable desktop notifications"]')).toBeNull();
    expect(app.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("browser's site settings");
  });

  it("keeps denied browser permission guidance visible after reload in the chooser and Chat", async () => {
    FakeBrowserNotification.permission = "denied";
    vi.stubGlobal("Notification", FakeBrowserNotification);
    const app = await mountChooser([]);

    expect(app.shadowRoot?.querySelector('button[aria-label="Enable desktop notifications"]')).toBeNull();
    expect(app.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("browser's site settings");
    setState(app, { ...getState(app), selectedSession: session("denied", "Chat") });
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector('[data-view="chat"] [role="alert"]')?.textContent).toContain("browser's site settings");
  });

  it("shows a native permission failure in the chooser without hiding the retry control", async () => {
    window.piWebNative = {
      pickDirectory: () => Promise.resolve(null),
      requestNotificationPermission: vi.fn(() => Promise.reject(new Error("Notification authorization was denied"))),
      notify: vi.fn(() => Promise.resolve()),
    };
    const app = await mountChooser([]);
    app.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Enable desktop notifications"]')?.click();
    await vi.waitFor(() => {
      expect(app.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("System Settings");
    });
    expect(app.shadowRoot?.querySelector('button[aria-label="Enable desktop notifications"]')).not.toBeNull();
    delete window.piWebNative;
  });

  it("hides Workbench agent sessions until the user asks to see them", async () => {
    const human = session("human", "Plan the release");
    const reviewer = session("reviewer", "ignored", "workbench-reviewer-deadbeef");
    const implementer = session("implementer", "ignored", "workbench-implementer-12345678");
    const app = await mountChooser([human, reviewer, implementer]);

    expect(sessionTitles(app)).toEqual(["Plan the release"]);
    const toggle = app.shadowRoot?.querySelector<HTMLInputElement>('input[aria-label="Show agent sessions"]');
    expect(toggle?.parentElement?.textContent).toContain("Show agent sessions (2)");

    toggle?.click();
    await app.updateComplete;

    expect(sessionTitles(app)).toEqual(["Plan the release", "workbench-reviewer-deadbeef", "workbench-implementer-12345678"]);
  });

  it("reopens the last used workspace so New Chat is the first control", async () => {
    localStorage.setItem("pi-workbench.last-workspace", JSON.stringify({ machineId: "local", projectId: project.id, workspaceId: workspace.id }));
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockResolvedValue([session("human", "Plan the release")]);
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedWorkspace?.id).toBe(workspace.id); });
    await app.updateComplete;

    const tab = app.shadowRoot?.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="true"]');
    expect(tab?.textContent).toBe(project.name);
    const newChat = app.shadowRoot?.querySelector<HTMLButtonElement>(".new-chat button.primary");
    expect(newChat?.textContent).toBe("New Chat");
    expect(newChat?.disabled).toBe(false);
    expect(app.shadowRoot?.querySelector<HTMLSelectElement>('select[aria-label="Workspace"]')?.value).toBe(workspace.id);
    expect(sessionTitles(app)).toEqual(["Plan the release"]);
    localStorage.removeItem("pi-workbench.last-workspace");
  });

  it("reselects the routed Chat when the app reconnects after a Vite reload", async () => {
    const current = session("current", "Keep this Chat open");
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockResolvedValue([current]);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
    const status = vi.spyOn(api, "status").mockResolvedValue({ sessionId: current.id, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    vi.spyOn(api, "streamSnapshot").mockResolvedValue({ seq: 0, partial: null });
    const notifications = vi.spyOn(api, "notificationInbox").mockResolvedValue({ daemonInstanceId: "daemon", catalogRevision: 0, summary: { sessionId: current.id, cwd: current.cwd, inboxRevision: 0, retainedCount: 0, discardedCount: 0 }, notifications: [], dismissThrough: { order: 0, overflowWatermark: 0 } });
    vi.spyOn(api, "thinkingLevels").mockResolvedValue({ levels: [] });
    window.history.replaceState({}, "", `/?project=${project.id}&workspace=${workspace.id}&session=${current.id}&view=chat`);
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(current.id); });
    const statusCalls = status.mock.calls.length;
    const notificationCalls = notifications.mock.calls.length;

    app.remove();
    document.body.append(app);

    expect(getState(app).selectedSession?.id).toBe(current.id);
    expect(app.shadowRoot?.querySelector('[data-view="chooser"]')).toBeNull();
    await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(false); });
    expect(getState(app).selectedSession?.id).toBe(current.id);
    expect(app.shadowRoot?.querySelector('[data-view="chat"]')).not.toBeNull();
    expect(status.mock.calls.length).toBeGreaterThan(statusCalls);
    expect(notifications.mock.calls.length).toBeGreaterThan(notificationCalls);
  });

  it("returns to the chooser if the routed Chat cannot be reselected after reconnect", async () => {
    const current = session("current", "Missing after reload");
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    const workspaces = vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockResolvedValue([current]);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: current.id, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    vi.spyOn(api, "streamSnapshot").mockResolvedValue({ seq: 0, partial: null });
    vi.spyOn(api, "notificationInbox").mockResolvedValue({ daemonInstanceId: "daemon", catalogRevision: 0, summary: { sessionId: current.id, cwd: current.cwd, inboxRevision: 0, retainedCount: 0, discardedCount: 0 }, notifications: [], dismissThrough: { order: 0, overflowWatermark: 0 } });
    vi.spyOn(api, "thinkingLevels").mockResolvedValue({ levels: [] });
    window.history.replaceState({}, "", `/?project=${project.id}&workspace=${workspace.id}&session=${current.id}&view=chat`);
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(current.id); });

    workspaces.mockResolvedValue([]);
    app.remove();
    document.body.append(app);

    await vi.waitFor(() => { expect(getState(app).error).toContain("workspace is no longer available"); });
    expect(getState(app).selectedSession).toBeUndefined();
    expect(app.shadowRoot?.querySelector('[data-view="chooser"]')).not.toBeNull();
  });

  it("keeps a fresh unlisted Chat open across a reload by rebuilding it from status", async () => {
    vi.spyOn(api, "projects").mockResolvedValue([project]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "fresh", persisted: false, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    window.history.replaceState({}, "", `/?project=${project.id}&workspace=${workspace.id}&session=fresh&view=chat`);
    const app = new WorkbenchApp();
    document.body.append(app);
    await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(false); });
    expect(getState(app).error).not.toContain("no longer available");
    expect(getState(app).selectedSession?.id).toBe("fresh");
  });

  it("opens and closes the side Files pane without remounting Chat", async () => {
    const current = session("human", "Edit notes");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), selectedSession: current });
    await app.updateComplete;
    const chat = app.shadowRoot?.querySelector("chat-view");
    const composer = app.shadowRoot?.querySelector("prompt-editor");
    const toggle = app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.title).toBe("Files");
    expect(toggle?.getAttribute("aria-label")).toBe("Files");
    expect(toggle?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(toggle?.textContent.trim()).toBe("");
    toggle?.click();
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector("chat-view")).toBe(chat);
    expect(app.shadowRoot?.querySelector("prompt-editor")).toBe(composer);
    expect(app.shadowRoot?.querySelector("workbench-files-pane")).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const pane = app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    if (pane === undefined || pane === null) throw new Error("Files pane was not mounted");
    const canClose = vi.spyOn(pane, "canClose").mockReturnValue(false);
    toggle?.click();
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector("workbench-files-pane")).toBe(pane);
    window.history.pushState({}, "", "/?session=other&view=chat");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(window.location.search).toContain("session=human");
    expect(app.shadowRoot?.querySelector("chat-view")).toBe(chat);
    canClose.mockReturnValue(true);
    toggle?.click();
    await app.updateComplete;
    expect(app.shadowRoot?.querySelector("chat-view")).toBe(chat);
    expect(app.shadowRoot?.querySelector("workbench-files-pane")).toBeNull();
  });

  it("opens Chat Markdown file links in the Files pane and respects unsaved edits", async () => {
    const current = session("human", "Edit notes");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), selectedSession: current, messages: [{ role: "assistant", parts: [{ type: "text", text: "See [notes](docs/notes.md), [ledger](/repo/.scratch/LEDGER.md), [outside](/elsewhere/x.md) and [site](https://example.com)." }] }] });
    await app.updateComplete;
    const read = vi.spyOn(api, "workspaceFile").mockImplementation((_project, _workspace, path) => Promise.resolve({ path, encoding: "utf8", size: 5, modifiedAt: "now", version: "v1", content: `body of ${path}`, truncated: false, binary: false }));
    const anchors = await chatAnchors(app);
    expect(anchors.map((anchor) => anchor.getAttribute("data-workspace-file"))).toEqual(["docs/notes.md", ".scratch/LEDGER.md", null, null]);
    expect(anchors[3]?.getAttribute("href")).toBe("https://example.com");
    const click = (anchor: HTMLAnchorElement | undefined) => {
      const event = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, button: 0 });
      anchor?.dispatchEvent(event);
      return event;
    };
    expect(click(anchors[0]).defaultPrevented).toBe(true);
    await vi.waitFor(() => { expect(app.shadowRoot?.querySelector("workbench-files-pane")?.shadowRoot?.querySelector("textarea")?.value).toBe("body of docs/notes.md"); });
    expect(read).toHaveBeenCalledWith(project.id, workspace.id, "docs/notes.md", machine.id);
    const pane = app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    if (pane === undefined || pane === null) throw new Error("Files pane was not mounted");
    const canClose = vi.spyOn(pane, "canClose").mockReturnValue(false);
    click(anchors[1]);
    await vi.waitFor(() => { expect(canClose).toHaveBeenCalled(); });
    expect(read).toHaveBeenCalledTimes(1);
    canClose.mockReturnValue(true);
    click(anchors[1]);
    await vi.waitFor(() => { expect(pane.shadowRoot?.querySelector("textarea")?.value).toBe("body of .scratch/LEDGER.md"); });
    expect(anchors[2]?.getAttribute("data-outside-file")).toBe("/elsewhere/x.md");
    expect(click(anchors[2]).defaultPrevented).toBe(true);
    await vi.waitFor(() => { expect(pane.shadowRoot?.querySelector("textarea")?.value).toBe("body of x.md"); });
    expect(read).toHaveBeenLastCalledWith("", "folder:/elsewhere", "x.md", machine.id);
  });

  it("opens a Chat link outside its folder in the registered workspace that contains the file, then returns to the Chat's workspace", async () => {
    const sibling: Project = { id: "sibling", name: "Sibling", path: "/pi-web.installed", createdAt: project.createdAt };
    const siblingWorkspace: Workspace = { id: "sibling-main", projectId: sibling.id, path: sibling.path, label: "main", isMain: true, effectiveConfig: {} };
    vi.spyOn(api, "workspaces").mockImplementation((projectId) => Promise.resolve(projectId === sibling.id ? [siblingWorkspace] : [workspace]));
    const current = session("human", "Edit notes");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), projects: [project, sibling], selectedSession: current, messages: [{ role: "assistant", parts: [{ type: "text", text: "See [generator](../pi-web.installed/src/server/sessions/sessionNameGenerator.ts) and [loose](../loose/notes.md)." }] }] });
    await app.updateComplete;
    const read = vi.spyOn(api, "workspaceFile").mockImplementation((_project, _workspace, path) => Promise.resolve({ path, encoding: "utf8", size: 5, modifiedAt: "now", version: "v1", content: `body of ${path}`, truncated: false, binary: false }));
    const anchors = await chatAnchors(app);
    expect(anchors.map((anchor) => anchor.getAttribute("data-outside-file"))).toEqual(["/pi-web.installed/src/server/sessions/sessionNameGenerator.ts", "/loose/notes.md"]);

    anchors[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, button: 0 }));
    await vi.waitFor(() => { expect(read).toHaveBeenCalledWith(sibling.id, siblingWorkspace.id, "src/server/sessions/sessionNameGenerator.ts", machine.id); });
    const pane = () => app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane");
    await vi.waitFor(() => { expect(pane()?.shadowRoot?.querySelector("textarea")?.value).toBe("body of src/server/sessions/sessionNameGenerator.ts"); });
    expect(pane()?.workspace).toBe(siblingWorkspace);

    anchors[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, button: 0 }));
    await vi.waitFor(() => { expect(read).toHaveBeenLastCalledWith("", "folder:/loose", "notes.md", machine.id); });

    const toggle = app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle");
    toggle?.click(); await app.updateComplete;
    toggle?.click(); await app.updateComplete;
    expect(pane()?.workspace).toBe(workspace);
  });

  it("opens workspace file search with Cmd+P or the button without remounting Chat", async () => {
    const current = session("human", "Edit notes");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), selectedSession: current });
    await app.updateComplete;
    const search = vi.spyOn(api, "searchWorkspaceFiles").mockResolvedValue({ paths: [], cursor: null });
    const chat = app.shadowRoot?.querySelector("chat-view");
    const key = new KeyboardEvent("keydown", { key: "p", metaKey: true, cancelable: true });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    const ctrl = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, cancelable: true });
    window.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(false);
    await vi.waitFor(() => { expect(app.shadowRoot?.querySelector("workbench-files-pane")?.shadowRoot?.querySelector("modal-surface")).not.toBeNull(); });
    await vi.waitFor(() => { expect(search.mock.calls[0]?.slice(0, 5)).toEqual([project.id, workspace.id, "", "", "local"]); });
    expect(search.mock.calls[0]?.[5]?.signal).toBeInstanceOf(AbortSignal);
    expect(app.shadowRoot?.querySelector("chat-view")).toBe(chat);
    const modalKey = new KeyboardEvent("keydown", { key: "p", metaKey: true, cancelable: true, bubbles: true, composed: true });
    app.shadowRoot?.querySelector("workbench-files-pane")?.shadowRoot?.querySelector("modal-surface")?.dispatchEvent(modalKey);
    expect(modalKey.defaultPrevented).toBe(false);
    expect(WorkbenchApp.styles.cssText).toMatch(/header > button\s*\{[^}]*min-height:\s*32px;[^}]*border-color:\s*transparent/);
    expect(app.shadowRoot?.querySelector<HTMLButtonElement>('header button[aria-label="Search files"]')?.classList.contains("header-action")).toBe(true);
    app.shadowRoot?.querySelector("workbench-files-pane")?.shadowRoot?.querySelector<HTMLButtonElement>('.picker-content button[aria-label="Close"]')?.click();
    await app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.updateComplete;
    app.shadowRoot?.querySelector<HTMLButtonElement>('header button[aria-label="Search files"]')?.click();
    await vi.waitFor(() => { expect(search).toHaveBeenCalledTimes(2); });
    app.shadowRoot?.querySelector("workbench-files-pane")?.shadowRoot?.querySelector<HTMLButtonElement>('.picker-content button[aria-label="Close"]')?.click();
    await app.shadowRoot?.querySelector<WorkbenchFilesPane>("workbench-files-pane")?.updateComplete;
  });

  it("bounds Files resizing by available Chat width for pointer and keyboard input", async () => {
    const app = await mountChooser([session("human", "Edit notes")]);
    setState(app, { ...getState(app), selectedSession: session("human", "Edit notes") });
    await app.updateComplete;
    const container = app.shadowRoot?.querySelector<HTMLElement>(".chat-and-files");
    if (!container) throw new Error("Missing Chat container");
    Object.defineProperty(container, "clientWidth", { configurable: true, value: 1000 });
    app.shadowRoot?.querySelector<HTMLButtonElement>(".files-toggle")?.click();
    await app.updateComplete;
    const divider = app.shadowRoot?.querySelector<HTMLElement>(".files-divider");
    if (!divider) throw new Error("Missing Files divider");
    divider.setPointerCapture = vi.fn();
    divider.hasPointerCapture = vi.fn(() => true);
    const releaseCapture = vi.fn();
    divider.releasePointerCapture = releaseCapture;
    const pointer = (type: string, clientX: number, pointerId = 1) => divider.dispatchEvent(new PointerEvent(type, { pointerId, button: 0, clientX, bubbles: true, cancelable: true }));
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.tabIndex).toBe(0);
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("aria-controls")).toBe("workbench-files");
    expect(divider.getAttribute("aria-valuenow")).toBe("400");
    expect(WorkbenchApp.styles.cssText).toContain("calc(100% - 328px)");
    expect(WorkbenchApp.styles.cssText).toContain("@media (max-width: 760px)");
    pointer("pointerdown", 500);
    pointer("pointermove", -500, 2);
    pointer("pointermove", -500);
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuemax")).toBe("672");
    expect(divider.getAttribute("aria-valuenow")).toBe("672");
    expect(container.style.getPropertyValue("--files-width").trim()).toBe("672px");
    pointer("pointermove", 1500);
    pointer("pointercancel", 1500);
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuenow")).toBe("240");
    pointer("pointermove", -500);
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuenow")).toBe("240");
    pointer("pointerdown", 500);
    pointer("pointermove", 476);
    pointer("pointerup", 476);
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuenow")).toBe("264");
    expect(releaseCapture).toHaveBeenCalledTimes(2);
    const key = (name: string, shiftKey = false) => divider.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true }));
    expect(key("ArrowLeft")).toBe(false);
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuenow")).toBe("288");
    key("ArrowRight", true);
    key("End");
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuenow")).toBe("672");
    key("Home");
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuenow")).toBe("240");
    Object.defineProperty(container, "clientWidth", { configurable: true, value: 800 });
    window.dispatchEvent(new Event("resize"));
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuemax")).toBe("472");
    key("End");
    await app.updateComplete;
    expect(divider.getAttribute("aria-valuenow")).toBe("472");
  });

  it("returns from a Chat to the current workspace chooser", async () => {
    const current = session("human", "Plan the release");
    const app = await mountChooser([current]);
    setState(app, { ...getState(app), selectedSession: current });
    window.history.replaceState({}, "", "/?project=project&workspace=workspace&session=human&view=chat");
    await app.updateComplete;

    app.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.click();
    await app.updateComplete;

    expect(app.shadowRoot?.querySelector('[data-view="chooser"]')).not.toBeNull();
    expect(app.shadowRoot?.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="true"]')?.textContent).toBe(project.name);
    expect(app.shadowRoot?.querySelector<HTMLSelectElement>('select[aria-label="Workspace"]')?.value).toBe(workspace.id);
    expect(sessionTitles(app)).toEqual(["Plan the release"]);
    expect(window.location.search).toBe("?project=project&workspace=workspace");
  });

  it("opens a session from the All sessions tab in its registered workspace", async () => {
    const recent = session("recent", "Across projects");
    vi.spyOn(api, "recent").mockResolvedValue([recent]);
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: recent.id, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    const app = await mountChooser([]);
    const allTab = [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>('button[role="tab"]') ?? [])].find((button) => button.textContent === "All sessions");
    if (allTab === undefined) throw new Error("All sessions tab was not rendered");

    allTab.click();
    await app.updateComplete;
    const chooser = app.shadowRoot?.querySelector("all-sessions");
    if (chooser === undefined || chooser === null) throw new Error("All sessions chooser was not rendered");
    chooser.dispatchEvent(new CustomEvent("open-session", { detail: recent, bubbles: true, composed: true }));

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe(recent.id); });
    expect(getState(app).selectedWorkspace?.path).toBe(recent.cwd);
  });

  it("opens a Workstream session from status without loading the workspace session list", async () => {
    const sessions = vi.spyOn(api, "sessions").mockResolvedValue([]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "continued", persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    const app = await mountChooser([]);
    sessions.mockClear();

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("open-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "continued", directories: [] },
    }));

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("continued"); });
    expect(getState(app).selectedWorkspace?.id).toBe(workspace.id);
    expect(sessions).not.toHaveBeenCalled();
  });

  it("opens a rebound Workstream session in its registered sibling worktree", async () => {
    const worktree: Workspace = { ...workspace, id: "persistent-worktree", path: "/ideas/pi-workbench.context-views-20260909", label: "context views" };
    const locate = vi.spyOn(api, "locate").mockResolvedValue({ cwd: worktree.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace, worktree]);
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: "rebound", persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    const app = await mountChooser([]);
    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("open-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "rebound", directories: [worktree.path] },
    }));

    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("rebound"); });
    expect(locate).toHaveBeenCalledWith("rebound", "local");
    expect(getState(app).selectedProject?.id).toBe(project.id);
    expect(getState(app).selectedWorkspace?.id).toBe(worktree.id);
  });

  it("records and confirms a Workstream launch around Chat creation, then orients without preloading a prompt", async () => {
    const started = session("new-session", "");
    const protocol: string[] = [];
    const calls: WorkstreamServiceCall[] = [];
    let inspectCount = 0;
    stubWorkstreamService(calls, (body) => {
      if (body.operation === "inspect") return { ok: true, value: { id: "workstream", revision: inspectCount++ === 0 ? 70 : 71, sessions: [], humanTasks: [] } };
      if (body.operation === "watch") return { ok: true, value: { mode: "replay", events: [], nextSequence: 71 } };
      protocol.push("append");
      return { ok: true, value: { acceptedRevision: typeof body.input["expectedRevision"] === "number" ? body.input["expectedRevision"] + 1 : 0 } };
    }, protocol);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const startSession = vi.spyOn(api, "startSession").mockImplementation(() => { protocol.push("start"); return Promise.resolve(started); });
    const locate = vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const prompt = vi.spyOn(api, "prompt").mockResolvedValue({ accepted: true });
    const command = vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" });
    const app = await mountChooser([]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [] },
    }));

    await vi.waitFor(() => { expect(calls.filter((call) => call.operation === "append")).toHaveLength(2); });
    const [pending, confirmed] = calls.filter((call) => call.operation === "append").map((call) => call.input);
    expect(protocol).toEqual(["inspect", "append", "start", "inspect", "append", "inspect"]);
    expect(pending).toEqual({
      workstreamId: "workstream",
      expectedRevision: 70,
      idempotencyKey: "pi-web:00000000-0000-4000-8000-000000000001:pending",
      records: [{
        type: "session.pending",
        producer: "pi-web",
        sourceSessionId: "previous",
        payload: { associationKey: "pi-web:00000000-0000-4000-8000-000000000001", derivationKind: "checkpoint", machineId: "local", projectId: "project", workspaceId: "workspace" },
      }],
    });
    expect(confirmed).toEqual({
      workstreamId: "workstream",
      expectedRevision: 71,
      idempotencyKey: "pi-web:00000000-0000-4000-8000-000000000001:confirmed",
      records: [{
        type: "session.confirmed",
        producer: "pi-web",
        sourceSessionId: "new-session",
        payload: { sessionId: "new-session", associationKey: "pi-web:00000000-0000-4000-8000-000000000001", machineId: "local", projectId: "project", workspaceId: "workspace" },
      }],
    });
    expect(startSession).toHaveBeenCalledWith(workspace.path, "local", "pi-web:00000000-0000-4000-8000-000000000001");
    expect(prompt).not.toHaveBeenCalled();
    // No linked Chat shows recent user input, so orientation is full.
    await vi.waitFor(() => { expect(command).toHaveBeenCalledWith(expect.objectContaining({ id: "new-session" }), "/skill:orient full", "local"); });
    expect(command).toHaveBeenCalledTimes(1);
    expect(loadDraft(machineSessionKey("local", "new-session"))).toBe("");
    expect(app.shadowRoot?.activeElement?.tagName).toBe("PROMPT-EDITOR");
    expect(locate).toHaveBeenCalledWith("previous", "local");
    expect(getState(app).selectedWorkspace?.id).toBe(workspace.id);
  });

  it.each([{ hoursAgo: 4, depth: "full" }, { hoursAgo: 2, depth: "brief" }])("orients a newly confirmed Workstream Chat $depth after $hoursAgo hours without user input", async ({ hoursAgo, depth }) => {
    const calls: WorkstreamServiceCall[] = [];
    let inspectCount = 0;
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "workstream", revision: inspectCount++ === 0 ? 1 : 2, sessions: [{ id: "previous", status: "active", latestCheckpoint: null }, { id: "new-session", status: "active", latestCheckpoint: null }], humanTasks: [] } }
      : { ok: true, value: { acceptedRevision: 2 } });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "startSession").mockResolvedValue(session("new-session", ""));
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [{ role: "user", timestamp: Date.now() - hoursAgo * 3_600_000 }], start: 0, total: 1 });
    const command = vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" });
    const app = await mountChooser([]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [] },
    }));
    await vi.waitFor(() => { expect(command).toHaveBeenCalledWith(expect.objectContaining({ id: "new-session", cwd: workspace.path }), `/skill:orient ${depth}`, "local"); });
    expect(command).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.operation === "append")).toHaveLength(2);
    expect(getState(app).selectedSession?.id).toBe("new-session");
    expect(loadDraft(machineSessionKey("local", "new-session"))).toBe("");
  });

  it("does not inject delayed orientation after the owner submits the new Chat's first prompt", async () => {
    const calls: WorkstreamServiceCall[] = [];
    let inspectCount = 0;
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "workstream", revision: inspectCount++ === 0 ? 1 : 2, sessions: [{ id: "previous", status: "active", latestCheckpoint: null }, { id: "new-session", status: "active", latestCheckpoint: null }], humanTasks: [] } }
      : { ok: true, value: { acceptedRevision: 2 } });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "startSession").mockResolvedValue(session("new-session", ""));
    let releaseHistory: () => void = () => { /* starts only after prior history is requested */ };
    const messages = vi.spyOn(api, "messages").mockImplementation(async (current) => {
      if (current.id === "previous") {
        await new Promise<void>((resolve) => { releaseHistory = resolve; });
        return { messages: [{ role: "user", timestamp: Date.now() - 4 * 3_600_000 }], start: 0, total: 1 };
      }
      return { messages: [], start: 0, total: 0 };
    });
    vi.spyOn(api, "prompt").mockResolvedValue({ accepted: true });
    const command = vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" });
    const app = await mountChooser([]);
    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [] },
    }));
    await vi.waitFor(() => { expect(messages.mock.calls.some(([current]) => current.id === "previous")).toBe(true); });
    await promptEditor(app).onSend?.("Owner's first prompt");
    releaseHistory();
    await vi.waitFor(() => { expect(Reflect.get(app, "orientationPendingSessionId")).toBeUndefined(); });
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
    expect(command).not.toHaveBeenCalled();
  });

  it("rejects a temporary Workstream directory before recording a pending launch", async () => {
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, () => ({ ok: true, value: { id: "workstream", revision: 1, sessions: [], humanTasks: [] } }));
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const startSession = vi.spyOn(api, "startSession");
    const app = await mountChooser([]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", directories: ["/private/tmp/pi-context-views-20260909"] },
    }));

    await vi.waitFor(() => { expect(getState(app).error).toContain("temporary directory"); });
    expect(startSession).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.operation === "append")).toHaveLength(0);
  });

  it("continues a stale temporary Workstream checkpoint explicitly in the selected workspace", async () => {
    const calls: WorkstreamServiceCall[] = [];
    let inspectCount = 0;
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "workstream", revision: inspectCount++ === 0 ? 1 : 2, sessions: [], humanTasks: [] } }
      : { ok: true, value: { acceptedRevision: 2 } });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const locate = vi.spyOn(api, "locate");
    const start = vi.spyOn(api, "startSession").mockResolvedValue(session("new-session", ""));
    vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" });
    const app = await mountChooser([]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [], useSelectedWorkspace: true },
    }));

    await vi.waitFor(() => { expect(calls.filter((call) => call.operation === "append")).toHaveLength(2); });
    expect(locate).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(workspace.path, "local", expect.stringMatching(/^pi-web:/));
    expect(getState(app).selectedWorkspace?.path).toBe(workspace.path);
  });

  it("starts an empty Workstream in the selected workspace without a previous session", async () => {
    const started = session("first-session", "");
    const calls: WorkstreamServiceCall[] = [];
    let inspectCount = 0;
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "empty-workstream", revision: inspectCount++ === 0 ? 1 : 2, sessions: [], humanTasks: [] } }
      : { ok: true, value: { acceptedRevision: typeof body.input["expectedRevision"] === "number" ? body.input["expectedRevision"] + 1 : 0 } });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000003");
    const locate = vi.spyOn(api, "locate");
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const startSession = vi.spyOn(api, "startSession").mockResolvedValue(started);
    const command = vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" });
    const app = await mountChooser([]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "empty-workstream", directories: [] },
    }));

    await vi.waitFor(() => { expect(calls.filter((call) => call.operation === "append")).toHaveLength(2); });
    await vi.waitFor(() => { expect(command).toHaveBeenCalledWith(expect.objectContaining({ id: "first-session" }), "/skill:orient full", "local"); });
    expect(loadDraft(machineSessionKey("local", "first-session"))).toBe("");
    expect(locate).not.toHaveBeenCalled();
    expect(startSession).toHaveBeenCalledWith(workspace.path, "local", "pi-web:00000000-0000-4000-8000-000000000003");
    expect(calls.find((call) => call.operation === "append")?.input).toMatchObject({
      records: [{ payload: {
        associationKey: "pi-web:00000000-0000-4000-8000-000000000003",
        machineId: "local",
        projectId: project.id,
        workspaceId: workspace.id,
      } }],
    });
    const records: unknown = calls.find((call) => call.operation === "append")?.input["records"];
    if (!Array.isArray(records)) throw new Error("pending records missing");
    expect(records[0]).not.toHaveProperty("sourceSessionId");
    expect(records[0]).not.toHaveProperty("payload.derivationKind");
  });

  it("does not start an empty Workstream when a session appeared after the card loaded", async () => {
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "empty-workstream", revision: 2, sessions: [{ id: "existing", status: "active", latestCheckpoint: null }], humanTasks: [] } }
      : { ok: true, value: { acceptedRevision: 3 } });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const startSession = vi.spyOn(api, "startSession");
    const app = await mountChooser([]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "empty-workstream", directories: [] },
    }));

    await vi.waitFor(() => { expect(getState(app).error).toContain("already has a session"); });
    expect(startSession).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.operation === "append")).toHaveLength(0);
  });

  it("leaves a different selected Chat's draft alone after a successful launch", async () => {
    const started = session("new-session", "");
    const other = session("other-session", "Other");
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "workstream", revision: 4, sessions: [], humanTasks: [] } }
      : { ok: true, value: { acceptedRevision: 5 } });
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    vi.spyOn(api, "startSession").mockResolvedValue(started);
    vi.spyOn(api, "runCommand").mockResolvedValue({ type: "done" });
    let resolveStatus: ((value: Awaited<ReturnType<typeof api.status>>) => void) | undefined;
    vi.spyOn(api, "status").mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const otherDraftKey = machineSessionKey("local", other.id);
    saveDraft(otherDraftKey, "Keep this draft");
    const app = await mountChooser([other]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [] },
    }));
    await vi.waitFor(() => { expect(resolveStatus).toBeTypeOf("function"); });
    setState(app, { ...getState(app), selectedSession: other });
    await app.updateComplete;
    await promptEditor(app).updateComplete;
    resolveStatus?.({ sessionId: started.id, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    await vi.waitFor(() => { expect(calls.filter((call) => call.operation === "append")).toHaveLength(2); });

    expect(getState(app).selectedSession?.id).toBe(other.id);
    await vi.waitFor(() => { expect(promptEditor(app).view?.state.doc.toString()).toBe("Keep this draft"); });
  });

  it("leaves a different selected Chat's draft alone after an ambiguous failed launch", async () => {
    const other = session("other-session", "Other");
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "workstream", revision: 8, sessions: [], humanTasks: [] } }
      : { ok: true, value: { acceptedRevision: 9 } });
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: workspace.path });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    let rejectStart: ((reason: Error) => void) | undefined;
    vi.spyOn(api, "startSession").mockImplementation(() => new Promise((_resolve, reject) => { rejectStart = reject; }));
    const otherDraftKey = machineSessionKey("local", other.id);
    saveDraft(otherDraftKey, "Keep this draft");
    const app = await mountChooser([other]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [] },
    }));
    await vi.waitFor(() => { expect(rejectStart).toBeTypeOf("function"); });
    setState(app, { ...getState(app), selectedSession: other });
    await app.updateComplete;
    await promptEditor(app).updateComplete;
    rejectStart?.(new Error("start uncertain"));
    await vi.waitFor(() => { expect(getState(app).error).toContain("Chat creation failed"); });

    expect(getState(app).error).not.toContain("reconciliation");
    await vi.waitFor(() => { expect(promptEditor(app).view?.state.doc.toString()).toBe("Keep this draft"); });
  });

  it("does not create a Chat when the anchorless pending append fails", async () => {
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, (body) => body.operation === "inspect"
      ? { ok: true, value: { id: "workstream", revision: 12, sessions: [], humanTasks: [] } }
      : { ok: false, error: { message: "store unavailable" } });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002");
    vi.spyOn(api, "locate").mockResolvedValue({ cwd: "/loose/folder" });
    vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
    const startSession = vi.spyOn(api, "startSession");
    const app = await mountChooser([]);

    app.shadowRoot?.querySelector("workstream-chooser")?.dispatchEvent(new CustomEvent("start-workstream-session", {
      detail: { workstreamId: "workstream", sessionId: "previous", directories: [] },
    }));

    await vi.waitFor(() => { expect(getState(app).error).toContain("no Chat was started"); });
    expect(startSession).not.toHaveBeenCalled();
    expect(calls.find((call) => call.operation === "append")?.input).toMatchObject({
      expectedRevision: 12,
      records: [{ sourceSessionId: "previous", payload: { associationKey: "pi-web:00000000-0000-4000-8000-000000000002", derivationKind: "checkpoint" } }],
    });
    const records = calls.find((call) => call.operation === "append")?.input["records"];
    if (!Array.isArray(records) || typeof records[0] !== "object" || records[0] === null) throw new Error("pending record missing");
    const pendingPayload: unknown = Reflect.get(records[0], "payload");
    expect(pendingPayload).not.toHaveProperty("machineId");
    expect(pendingPayload).not.toHaveProperty("projectId");
    expect(pendingPayload).not.toHaveProperty("workspaceId");
  });
});

interface WorkstreamServiceCall { operation: string; input: Record<string, unknown> }

function pluginLifecycleResponse(): Response {
  return new Response(JSON.stringify({
    lifecycleVersion: 2,
    plugins: [{ id: "pi-workbench", source: "test", scope: "user", machineSpecific: true, enabled: true, discovered: true, conflict: false, server: { state: "active", activeRevision: "revision-1", staleRevision: false, restartRequired: false, disableCommand: "pi-web plugins disable pi-workbench --restart" } }],
    diagnostics: [],
    serverRuntime: { status: "available", terminalMode: "required", restartRequired: false, recovery: { showSafeStart: "pi-web plugins safe-start show", bundledOnly: "pi-web plugins safe-start set bundled-only --restart", noServerPlugins: "pi-web plugins safe-start set none --restart", clearSafeStart: "pi-web plugins safe-start clear --restart" } },
  }), { status: 200 });
}

function stubWorkstreamService(calls: WorkstreamServiceCall[], respond: (body: WorkstreamServiceCall) => unknown, protocol?: string[], handleList = false): void {
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/plugins")) return Promise.resolve(pluginLifecycleResponse());
    if (typeof init?.body !== "string") throw new Error("missing Workstream request body");
    const envelope = JSON.parse(init.body) as { input: Record<string, unknown> }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- decoded test request
    const body = { operation: decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)), input: envelope.input };
    if (body.operation === "list" && !handleList) return Promise.resolve(new Response(JSON.stringify({ ok: true, value: [] }), { status: 200 }));
    calls.push(body);
    if (body.operation === "inspect") protocol?.push("inspect");
    return Promise.resolve(new Response(JSON.stringify(respond(body)), { status: 200 }));
  }));
}

describe("Workbench interface scale shortcuts", () => {
  it("sizes the fixed Workbench host against inherited compensated viewport dimensions", () => {
    expect(WorkbenchApp.styles.cssText).toMatch(/:host\s*\{[^}]*--pi-workbench-viewport-height:\s*calc\(100dvh\s*\/\s*var\(--pi-interface-scale,\s*1\)\)/);
    expect(WorkbenchApp.styles.cssText).toMatch(/:host\s*\{[^}]*--pi-workbench-viewport-width:\s*calc\(100dvw\s*\/\s*var\(--pi-interface-scale,\s*1\)\)/);
    expect(WorkbenchApp.styles.cssText).toMatch(/:host\s*\{[^}]*height:\s*var\(--pi-workbench-viewport-height\)/);
  });

  it("steps the stored scale up, down, and back to the default on Cmd/Ctrl +/-/0", async () => {
    const app = await mountChooser([]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", metaKey: true, cancelable: true }));
    expect(readStoredInterfaceScale()).toBe(1.1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", ctrlKey: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", ctrlKey: true, cancelable: true }));
    expect(readStoredInterfaceScale()).toBe(0.9);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", metaKey: true, cancelable: true }));
    expect(readStoredInterfaceScale()).toBe(DEFAULT_INTERFACE_SCALE);
    expect(document.documentElement.style.getPropertyValue(INTERFACE_SCALE_CSS_PROPERTY)).toBe("1");
    app.remove();
  });

  it("leaves the stored scale untouched when + or - is typed without a modifier", async () => {
    const app = await mountChooser([]);
    localStorage.removeItem(INTERFACE_SCALE_STORAGE_KEY);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", cancelable: true }));

    expect(localStorage.getItem(INTERFACE_SCALE_STORAGE_KEY)).toBeNull();
    app.remove();
  });
});

describe("Workbench settings panel", () => {
  it("opens on click, closes on Escape, and returns focus to the opener", async () => {
    const app = await mountChooser([]);
    const panel = settingsPanel(app);

    expect(panel.shadowRoot?.querySelector(".popover")).toBeNull();
    trigger(panel).click();
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector(".popover")).not.toBeNull();

    panel.shadowRoot?.querySelector<HTMLElement>(".popover")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector(".popover")).toBeNull();
    expect(panel.shadowRoot?.activeElement).toBe(trigger(panel));
    app.remove();
  });

  it("changes and persists the interface scale immediately", async () => {
    const app = await mountChooser([]);
    const panel = settingsPanel(app);
    trigger(panel).click();
    await panel.updateComplete;

    const select = scaleSelect(panel);
    select.value = "1.25";
    select.dispatchEvent(new Event("change"));
    await panel.updateComplete;

    expect(readStoredInterfaceScale()).toBe(1.25);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.25");
    expect(document.documentElement.style.getPropertyValue(INTERFACE_SCALE_CSS_PROPERTY)).toBe("1.25");
    app.remove();
  });

  it("changes and persists the theme preference immediately", async () => {
    const app = await mountChooser([]);
    const panel = settingsPanel(app);
    trigger(panel).click();
    await panel.updateComplete;

    const light = panel.shadowRoot?.querySelector<HTMLInputElement>('input[type="radio"][name="theme-scheme"]');
    if (light === null || light === undefined) throw new Error("Light theme radio was not rendered");
    light.click();
    await panel.updateComplete;

    const stored = readStoredThemePreference();
    expect(stored?.auto).toBe(false);
    expect(document.documentElement.dataset["piWebTheme"]).toBe(stored?.themeId);
    app.remove();
  });

  it("changes and persists the presentation profile immediately", async () => {
    const app = await mountChooser([]);
    const panel = settingsPanel(app);
    trigger(panel).click();
    await panel.updateComplete;

    const select = panel.shadowRoot?.querySelector<HTMLSelectElement>("#workbench-settings-profile");
    if (select === null || select === undefined) throw new Error("Presentation profile select was not rendered");
    select.value = "compact";
    select.dispatchEvent(new Event("change"));
    await panel.updateComplete;

    expect(readStoredPresentationProfile()?.base).toBe("compact");
    expect(document.documentElement.style.getPropertyValue("--pi-control-min-size")).toBe("26px");
    app.remove();
  });
});

describe("Workbench Chat controls", () => {
  it("backs off unchanged Workstream watches without repeated lifecycle lookups", async () => {
    const current = session("backoff", "Chat", "Chat title");
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, ({ operation }) => operation === "watch"
      ? { ok: true, value: { mode: "replay", events: [], nextSequence: 20 } }
      : { ok: true, value: [] }, undefined, true);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: current.id, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    vi.spyOn(api, "streamSnapshot").mockResolvedValue({ seq: 0, partial: null });
    vi.spyOn(api, "thinkingLevels").mockResolvedValue({ levels: [] });
    const app = await mountChooser([current]);
    app.shadowRoot?.querySelector<HTMLButtonElement>(".session")?.click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("backoff"); expect(Reflect.get(app, "currentWorkstream")).toBeNull(); });
    await vi.waitFor(() => { expect(Reflect.get(app, "workstreamWatchTimer")).toBeDefined(); });
    const fetcher = vi.mocked(fetch);
    const lifecycleCalls = () => fetcher.mock.calls.filter(([url]) => typeof url === "string" && url.endsWith("/plugins")).length;
    const before = lifecycleCalls();
    const timer: unknown = Reflect.get(app, "workstreamWatchTimer");
    if (typeof timer === "number") window.clearTimeout(timer);
    vi.useFakeTimers();
    try {
      const schedule: unknown = Reflect.get(app, "scheduleWorkstreamWatch");
      if (typeof schedule !== "function") throw new Error("Watch scheduler missing");
      Reflect.apply(schedule, app, [{ machineId: "local", projectId: "project", workspaceId: "workspace" }, current.id]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls.filter((call) => call.operation === "watch")).toHaveLength(2);
      expect(Reflect.get(app, "workstreamWatchDelay")).toBe(4_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls.filter((call) => call.operation === "watch")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls.filter((call) => call.operation === "watch")).toHaveLength(3);
      expect(lifecycleCalls()).toBe(before);
    } finally { app.remove(); vi.useRealTimers(); }
  });

  it("refreshes the open header when an external Workstream association appears, changes title, or disappears", async () => {
    const current = session("current", "Initial prompt", "Named chat");
    let revision = 0;
    let associated = false;
    let title = "External Workstream";
    const calls: WorkstreamServiceCall[] = [];
    stubWorkstreamService(calls, ({ operation }) => {
      if (operation === "list") return { ok: true, value: associated ? [{ id: "external" }] : [] };
      if (operation === "watch") return { ok: true, value: { mode: "replay", events: [], nextSequence: revision } };
      return { ok: true, value: { id: "external", title, revision, sessions: [], humanTasks: [], links: [], overview: null, closed: false } };
    }, undefined, true);
    vi.spyOn(api, "messages").mockResolvedValue({ messages: [], start: 0, total: 0 });
    vi.spyOn(api, "status").mockResolvedValue({ sessionId: current.id, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
    vi.spyOn(api, "streamSnapshot").mockResolvedValue({ seq: 0, partial: null });
    vi.spyOn(api, "thinkingLevels").mockResolvedValue({ levels: [] });
    const app = await mountChooser([current]);
    app.shadowRoot?.querySelector<HTMLButtonElement>(".session")?.click();
    await vi.waitFor(() => { expect(getState(app).selectedSession?.id).toBe("current"); expect(Reflect.get(app, "currentWorkstream")).toBeNull(); });
    await vi.waitFor(() => { expect(Reflect.get(app, "workstreamWatchTimer")).toBeDefined(); });
    await app.updateComplete;
    expect(drawerTitle(app)).toBe("Named chat");

    associated = true;
    revision = 1;
    await vi.waitFor(() => { expect(drawerTitle(app)).toBe("External Workstream"); }, { timeout: 3_000 });

    title = "Renamed elsewhere";
    revision = 2;
    await vi.waitFor(() => { expect(drawerTitle(app)).toBe("Renamed elsewhere"); }, { timeout: 3_000 });

    associated = false;
    revision = 3;
    await vi.waitFor(() => { expect(drawerTitle(app)).toBe("Named chat"); }, { timeout: 3_000 });
    const watchCalls = calls.filter((call) => call.operation === "watch");
    expect(watchCalls.length).toBeGreaterThanOrEqual(4);
    expect(watchCalls[0]?.input).toEqual({ afterSequence: Number.MAX_SAFE_INTEGER });
    expect(getState(app).selectedSession?.id).toBe("current");
  }, 10_000);

  it("keeps identity in the header and mounts status controls beside the composer", async () => {
    const current = session("current", "Build the UI");
    const app = await mountChooser([current]);
    setState(app, {
      ...getState(app),
      selectedSession: current,
      status: {
        sessionId: current.id, isStreaming: false, isCompacting: false, isBashRunning: false,
        pendingMessageCount: 0, queuedMessages: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
        extensionStatuses: {
          [ACTIVITY_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, items: [{ id: "worker-1", kind: "worker", activity: "running" }] }),
          [GOAL_STATUS_KEY]: JSON.stringify({ schemaVersion: 1, goalId: "goal-1234567890", state: "active", objective: "Build the UI" }),
        },
      },
    });
    await app.updateComplete;

    const shell = app.shadowRoot?.querySelector(".chat-shell");
    if (shell === null || shell === undefined) throw new Error("Chat shell was not rendered");
    const drawer = shell.querySelector("header > workstream-context-drawer");
    if (!(drawer instanceof WorkstreamContextDrawer)) throw new Error("Workstream context drawer was not rendered");
    expect(drawer.fallbackTitle).toBe("Build the UI");
    expect(shell.querySelector("header > goal-status-chip")).toBeNull();
    expect(shell.querySelector("header > strong")).toBeNull();
    const roster = shell.querySelector("delegate-roster");
    if (!(roster instanceof DelegateRoster)) throw new Error("Delegate roster was not rendered");
    expect(roster.collapsed).toBe(false);
    await roster.updateComplete;
    const rosterToggle = roster.shadowRoot?.querySelector<HTMLButtonElement>(".section-toggle");
    if (rosterToggle === null || rosterToggle === undefined) throw new Error("Delegate roster toggle was not rendered");
    rosterToggle.click();
    await app.updateComplete;
    const collapsedRoster = app.shadowRoot?.querySelector("delegate-roster");
    if (!(collapsedRoster instanceof DelegateRoster)) throw new Error("Delegate roster was not rendered after collapse");
    const goal = shell.querySelector("delegate-roster + goal-status-chip");
    if (!(goal instanceof GoalStatusChip)) throw new Error("Goal status chip was not rendered beside the composer");
    expect(goal.status).toBe(getState(app).status);
    await goal.updateComplete;
    expect(goal.shadowRoot?.querySelector("summary")?.textContent).toContain("Build the UI");
    expect(goal.nextElementSibling?.tagName).toBe("PROMPT-EDITOR");
    expect(collapsedRoster.collapsed).toBe(true);
    expect(shell.querySelector("status-bar")).toBeNull();
    expect(shell.querySelector("working-mode-controls")).toBeNull();
    const promptEditor = shell.querySelector<PromptEditor>("prompt-editor");
    if (promptEditor === null) throw new Error("Prompt editor was not rendered");
    await promptEditor.updateComplete;
    expect(promptEditor.showUsage).toBe(true);
    const controls = promptEditor.shadowRoot?.querySelector("working-mode-controls");
    expect(controls).not.toBeNull();
    expect(controls?.nextElementSibling?.classList.contains("composer-actions")).toBe(true);
    expect(controls?.nextElementSibling?.querySelector(".send-button")).not.toBeNull();
  });
});

async function mountChooser(sessions: SessionInfo[]): Promise<WorkbenchApp> {
  const app = new WorkbenchApp();
  document.body.append(app);
  await vi.waitFor(() => { expect(Reflect.get(app, "loading")).toBe(false); });
  setState(app, {
    ...initialAppState(),
    machines: [machine],
    selectedMachine: machine,
    projects: [project],
    selectedProject: project,
    workspaces: [workspace],
    selectedWorkspace: workspace,
    sessions,
  });
  await app.updateComplete;
  return app;
}

async function chatAnchors(app: WorkbenchApp): Promise<HTMLAnchorElement[]> {
  const chat = app.shadowRoot?.querySelector<ChatView>("chat-view");
  if (chat === null || chat === undefined) throw new Error("Chat was not rendered");
  await chat.updateComplete;
  const texts = [...chat.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
  await Promise.all(texts.map((text) => text.updateComplete));
  return texts.flatMap((text) => [...text.renderRoot.querySelectorAll("a")]);
}

function setState(app: WorkbenchApp, state: AppState): void {
  if (!Reflect.set(app, "app", state)) throw new Error("Could not set WorkbenchApp state");
}

function drawerTitle(app: WorkbenchApp): string | null | undefined {
  return app.shadowRoot?.querySelector<WorkstreamContextDrawer>("workstream-context-drawer")?.shadowRoot?.querySelector("summary strong, .fallback-title")?.textContent;
}

function promptEditor(app: WorkbenchApp): PromptEditor {
  const editor = app.shadowRoot?.querySelector("prompt-editor");
  if (!(editor instanceof PromptEditor)) throw new Error("Prompt editor was not rendered");
  return editor;
}

function getState(app: WorkbenchApp): AppState {
  const state: unknown = Reflect.get(app, "app");
  if (!isAppState(state)) throw new Error("WorkbenchApp state was unavailable");
  return state;
}

function isAppState(value: unknown): value is AppState {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "sessions"));
}

function sessionTitles(app: WorkbenchApp): string[] {
  return [...(app.shadowRoot?.querySelectorAll(".session strong") ?? [])].map((title) => title.textContent);
}

function settingsPanel(app: WorkbenchApp): WorkbenchSettingsPanel {
  const panel = app.shadowRoot?.querySelector("workbench-settings-panel");
  if (!(panel instanceof WorkbenchSettingsPanel)) throw new Error("Workbench settings panel was not rendered");
  return panel;
}

function trigger(panel: WorkbenchSettingsPanel): HTMLButtonElement {
  const button = panel.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Workbench settings"]');
  if (button === null || button === undefined) throw new Error("Settings trigger button was not rendered");
  return button;
}

function scaleSelect(panel: WorkbenchSettingsPanel): HTMLSelectElement {
  const select = panel.shadowRoot?.querySelector<HTMLSelectElement>("#workbench-settings-scale");
  if (select === null || select === undefined) throw new Error("Interface scale select was not rendered");
  return select;
}

function session(id: string, firstMessage: string, name?: string): SessionInfo {
  return { id, cwd: workspace.path, path: `/sessions/${id}.jsonl`, ...(name === undefined ? {} : { name }), created: "2026-08-31T00:00:00.000Z", modified: "2026-08-31T00:00:00.000Z", messageCount: 1, firstMessage };
}

const machine: Machine = { id: "local", name: "Local", kind: "local", createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" };
const project: Project = { id: "project", name: "Project", path: "/repo", createdAt: "2026-08-31T00:00:00.000Z" };
const workspace: Workspace = { id: "workspace", projectId: project.id, path: "/repo", label: "main", isMain: true, effectiveConfig: {} };

class FakeBrowserNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn((): Promise<NotificationPermission> => {
    FakeBrowserNotification.permission = "denied";
    return Promise.resolve("denied");
  });

  onclick: ((event: Event) => void) | null = null;
  close = vi.fn();
}

class SilentWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = SilentWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close(): void { this.readyState = 3; }
}
